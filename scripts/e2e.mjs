#!/usr/bin/env node
/**
 * End-to-end check against a real Chromium browser.
 *
 * Loads the unpacked extension, builds two real tab groups, then drives the
 * actual popup UI to close and restore them. Everything is asserted against
 * live `chrome.tabGroups` state, so this proves the extension works rather than
 * proving the unit tests agree with themselves.
 *
 * Chrome 137 disabled the `--load-extension` command line switch, so the
 * extension is installed through the DevTools `Extensions.loadUnpacked` command
 * over a debugging pipe. Browsers that still honour `--load-extension` are
 * covered by the fallback in `installExtension`.
 *
 * Skips itself with exit code 0 when no Chromium binary is available.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = join(ROOT, 'extension');
const HEADLESS = process.env.E2E_HEADED !== '1';
const COMMAND_TIMEOUT_MS = 30_000;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].flatMap((value) => (typeof value === 'string' && value.length > 0 ? [value] : []));

/**
 * Chrome derives the id of an unpacked extension from the SHA-256 of its
 * absolute path: the first 16 bytes, with every nibble mapped onto `a`-`p`.
 *
 * @param {string} absolutePath
 * @returns {string}
 */
function unpackedExtensionId(absolutePath) {
  const hash = createHash('sha256').update(absolutePath, 'utf8').digest('hex').slice(0, 32);
  return [...hash].map((nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16))).join('');
}

/**
 * @param {string} command
 * @returns {boolean}
 */
function isRunnable(command) {
  if (command.includes('/')) {
    return existsSync(command);
  }
  return (process.env.PATH ?? '')
    .split(':')
    .some((dir) => dir.length > 0 && existsSync(join(dir, command)));
}

/** Chrome DevTools Protocol client speaking the NUL-delimited pipe transport. */
class DevToolsPipe {
  /**
   * @param {import('node:stream').Writable} outgoing
   * @param {import('node:stream').Readable} incoming
   */
  constructor(outgoing, incoming) {
    this.outgoing = outgoing;
    this.nextId = 1;
    /** @type {Map<number, { resolve: (value: any) => void, reject: (reason: Error) => void }>} */
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    incoming.on('data', (chunk) => {
      this.consume(chunk);
    });
    incoming.on('close', () => {
      this.failAll(new Error('The browser closed the DevTools pipe.'));
    });
  }

  /**
   * Reject every in-flight command. Without this a browser that dies mid-command
   * leaves a promise nobody ever settles, and the CI job hangs until the
   * platform timeout instead of failing.
   *
   * @param {Error} reason
   * @returns {void}
   */
  failAll(reason) {
    for (const waiter of this.pending.values()) {
      waiter.reject(reason);
    }
    this.pending.clear();
  }

  /**
   * @param {Buffer} chunk
   * @returns {void}
   */
  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let boundary = this.buffer.indexOf(0);
    while (boundary !== -1) {
      const raw = this.buffer.subarray(0, boundary).toString('utf8');
      this.buffer = this.buffer.subarray(boundary + 1);
      boundary = this.buffer.indexOf(0);
      /** @type {{ id?: number, result?: unknown, error?: { message?: string } }} */
      const message = JSON.parse(raw);
      const waiter = message.id === undefined ? undefined : this.pending.get(message.id);
      if (waiter === undefined || message.id === undefined) {
        continue;
      }
      this.pending.delete(message.id);
      if (message.error) {
        waiter.reject(new Error(message.error.message ?? 'DevTools error'));
      } else {
        waiter.resolve(message.result);
      }
    }
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {string} [sessionId]
   * @returns {Promise<any>}
   */
  send(method, params = {}, sessionId) {
    const id = this.nextId;
    this.nextId += 1;
    const frame =
      sessionId === undefined ? { id, method, params } : { id, method, params, sessionId };
    this.outgoing.write(`${JSON.stringify(frame)}\0`);
    return new Promise((resolvePending, rejectPending) => {
      const timer = globalThis.setTimeout(() => {
        this.pending.delete(id);
        rejectPending(new Error(`${method} did not answer within ${COMMAND_TIMEOUT_MS} ms`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => {
          globalThis.clearTimeout(timer);
          resolvePending(value);
        },
        reject: (reason) => {
          globalThis.clearTimeout(timer);
          rejectPending(reason);
        },
      });
    });
  }

  /**
   * @param {string} targetId
   * @returns {Promise<string>}
   */
  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return sessionId;
  }

  /**
   * @param {string} sessionId
   * @param {string} expression
   * @returns {Promise<unknown>}
   */
  async evaluate(sessionId, expression) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      sessionId,
    );
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(`Evaluation failed: ${details.exception?.description ?? details.text}`);
    }
    return result.result?.value;
  }
}

/**
 * @template T
 * @param {string} label
 * @param {() => Promise<T | undefined | null | false>} probe
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
async function waitFor(label, probe, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined && value !== null && value !== false) {
        return value;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? ` (${lastError})` : ''}`);
}

let checks = 0;

/**
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string} label
 * @returns {void}
 */
function expect(actual, expected, label) {
  const seenActual = JSON.stringify(actual);
  const seenExpected = JSON.stringify(expected);
  if (seenActual !== seenExpected) {
    throw new Error(`${label}\n  expected: ${seenExpected}\n  actual:   ${seenActual}`);
  }
  checks += 1;
  console.info(`  ok  ${label}`);
}

/**
 * @param {DevToolsPipe} cdp
 * @param {string} expectedId
 * @returns {Promise<string>}
 */
async function installExtension(cdp, expectedId) {
  try {
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: EXTENSION_DIR });
    return id;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.info(`  Extensions.loadUnpacked unavailable (${reason}); relying on --load-extension`);
    return expectedId;
  }
}

const chromeBinary = CHROME_CANDIDATES.find((candidate) => isRunnable(candidate));
if (chromeBinary === undefined) {
  console.warn('No Chromium binary found (set CHROME_PATH) - skipping the end-to-end run.');
  process.exit(0);
}

const profileDir = mkdtempSync(join(tmpdir(), 'manage-tabgroups-e2e-'));
const expectedExtensionId = unpackedExtensionId(EXTENSION_DIR);

const args = [
  `--user-data-dir=${profileDir}`,
  '--remote-debugging-pipe',
  '--enable-unsafe-extension-debugging',
  `--load-extension=${EXTENSION_DIR}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--disable-search-engine-choice-screen',
  '--no-sandbox',
  'about:blank',
];
if (HEADLESS) {
  args.unshift('--headless=new');
}

console.info(`Launching ${chromeBinary}${HEADLESS ? ' (headless)' : ''}`);

const browser = spawn(chromeBinary, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
/** @type {string[]} */
const browserLog = [];
browser.stdout?.on('data', (chunk) => browserLog.push(String(chunk)));
browser.stderr?.on('data', (chunk) => browserLog.push(String(chunk)));

/** @type {unknown} */
let failure;

try {
  const outgoing = /** @type {import('node:stream').Writable} */ (browser.stdio[3]);
  const incoming = /** @type {import('node:stream').Readable} */ (browser.stdio[4]);
  if (!outgoing || !incoming) {
    throw new Error('The browser did not expose a DevTools pipe.');
  }
  const cdp = new DevToolsPipe(outgoing, incoming);
  browser.on('exit', (code) => {
    cdp.failAll(new Error(`The browser exited with code ${String(code)}.`));
  });

  const version = await waitFor('the DevTools pipe', () => cdp.send('Browser.getVersion'));
  console.info(`Browser: ${version.product}`);

  const extensionId = await installExtension(cdp, expectedExtensionId);
  console.info(`Extension id: ${extensionId}`);
  await cdp.send('Target.setDiscoverTargets', { discover: true });

  const workerTarget = await waitFor('the extension service worker', async () => {
    const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{}] });
    return targetInfos.find(
      (/** @type {{ type: string, url: string }} */ target) =>
        target.type === 'service_worker' && target.url.includes(extensionId),
    );
  });
  const worker = await cdp.attach(workerTarget.targetId);

  /**
   * @param {string} expression
   * @returns {Promise<unknown>}
   */
  const inWorker = (expression) => cdp.evaluate(worker, expression);

  console.info('\n1. The service worker starts cleanly');
  expect(
    await inWorker('chrome.runtime.getManifest().name'),
    'Manage Tab Groups',
    'the manifest loads, so its strict CSP is accepted',
  );
  expect(
    await inWorker('typeof chrome.tabGroups.query'),
    'function',
    'the tab groups API is available',
  );
  expect(
    await inWorker('chrome.runtime.getManifest().permissions'),
    ['tabs', 'tabGroups', 'storage', 'alarms'],
    'only the four documented permissions are granted',
  );

  console.info('\n2. Two real tab groups are created');
  await inWorker(
    `(async () => {
      const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      const make = async (urls, title, color) => {
        const ids = [];
        for (const url of urls) {
          const tab = await chrome.tabs.create({ windowId: win.id, url, active: false });
          ids.push(tab.id);
        }
        const groupId = await chrome.tabs.group({
          tabIds: ids,
          createProperties: { windowId: win.id },
        });
        await chrome.tabGroups.update(groupId, { title, color });
      };
      await make(['https://example.com/one', 'https://example.org/two'], 'Work', 'blue');
      await make(['https://example.net/three'], 'Reading', 'green');
      return true;
    })()`,
  );
  expect(
    await inWorker('chrome.tabGroups.query({}).then((g) => g.map((x) => [x.title, x.color]))'),
    [
      ['Work', 'blue'],
      ['Reading', 'green'],
    ],
    'two groups exist before the test',
  );

  console.info('\n3. The popup renders the live state');
  const { targetId: popupTargetId } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/popup/popup.html`,
  });
  const popup = await cdp.attach(popupTargetId);

  /**
   * @param {string} expression
   * @returns {Promise<unknown>}
   */
  const inPopup = (expression) => cdp.evaluate(popup, expression);

  const summary = await waitFor('the popup summary', async () => {
    const text = await inPopup("document.querySelector('#live-summary').textContent");
    return typeof text === 'string' && text.includes('group') && !text.includes('Checking')
      ? text
      : undefined;
  });
  expect(summary, '2 groups · 3 tabs in this window', 'the popup counts the open groups');
  expect(
    await inPopup("document.querySelector('#unsupported').hidden"),
    true,
    'no unsupported-browser banner is shown',
  );

  console.info('\n4. "Save & close all tab groups" saves before it closes');
  await inPopup("document.querySelector('#close-all').click()");
  const closeStatus = await waitFor('the popup status message', async () => {
    const text = await inPopup("document.querySelector('#status').textContent");
    return typeof text === 'string' && text.length > 0 && text !== 'Working…' ? text : undefined;
  });
  expect(closeStatus, 'Saved and closed 2 groups · 3 tabs.', 'the popup reports what it closed');
  expect(
    await inWorker('chrome.tabGroups.query({}).then((g) => g.length)'),
    0,
    'every tab group is gone from the browser',
  );
  expect(
    await inWorker(
      `chrome.storage.local.get('sessions').then((s) => s.sessions.map((x) => [
        x.source, x.groups.map((g) => [g.title, g.color, g.tabs.map((t) => t.url)])
      ]))`,
    ),
    [
      [
        'manual',
        [
          ['Work', 'blue', ['https://example.com/one', 'https://example.org/two']],
          ['Reading', 'green', ['https://example.net/three']],
        ],
      ],
    ],
    'the session was stored locally with titles, colours and URLs',
  );
  expect(
    await inWorker('chrome.tabs.query({}).then((t) => t.length > 0)'),
    true,
    'the window survived losing all of its grouped tabs',
  );

  console.info('\n5. "Restore latest" brings everything back');
  await inPopup("document.querySelector('#restore-latest').click()");
  const restoreStatus = await waitFor('the restore status message', async () => {
    const text = await inPopup("document.querySelector('#status').textContent");
    return typeof text === 'string' && text.startsWith('Restored') ? text : undefined;
  });
  expect(restoreStatus, 'Restored 2 groups · 3 tabs.', 'the popup reports what it restored');
  expect(
    await inWorker(
      'chrome.tabGroups.query({}).then((g) => g.map((x) => [x.title, x.color, x.collapsed]))',
    ),
    [
      ['Work', 'blue', false],
      ['Reading', 'green', false],
    ],
    'the groups are back with their names and colours',
  );
  expect(
    await inWorker(
      `chrome.tabs.query({}).then((t) => t.filter((x) => x.groupId !== -1)
        .sort((a, b) => a.index - b.index).map((x) => x.url))`,
    ),
    ['https://example.com/one', 'https://example.org/two', 'https://example.net/three'],
    'the tabs are back in their original order',
  );

  console.info('\n6. A tampered session cannot restore a dangerous URL');
  await inWorker(
    `chrome.tabs.query({}).then((t) =>
      chrome.tabs.remove(t.filter((x) => x.groupId !== -1).map((x) => x.id)))`,
  );
  await inWorker(
    `chrome.storage.local.set({ sessions: [{
      id: 'tampered', createdAt: Date.now(), source: 'manual',
      groups: [{ title: 'Evil', color: 'red', collapsed: false, tabs: [
        { url: 'javascript:globalThis.__pwned = 1', title: 'x' },
        { url: 'https://example.com/safe', title: 'safe' }
      ] }]
    }] })`,
  );
  const tampered = /** @type {{ ok: boolean, data: { restoredTabs: number } }} */ (
    await inPopup("chrome.runtime.sendMessage({ type: 'restore-session' })")
  );
  expect(tampered.data.restoredTabs, 1, 'only the safe tab of a tampered session is restored');
  expect(
    await inWorker(
      "chrome.tabs.query({}).then((t) => t.some((x) => x.url.startsWith('javascript:')))",
    ),
    false,
    'no javascript: URL was ever opened',
  );

  console.info('\n7. The worker refuses anything it does not recognise');
  expect(
    await inPopup("chrome.runtime.sendMessage({ type: 'wipe-everything' })"),
    { ok: false, error: 'Unsupported request.' },
    'an unknown message type is refused',
  );
  expect(
    await inPopup("chrome.runtime.sendMessage('just a string')"),
    { ok: false, error: 'Unsupported request.' },
    'a non-object message is refused',
  );

  console.info('\n8. The options page works under the strict CSP');
  const { targetId: optionsTargetId } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/options/options.html`,
  });
  const options = await cdp.attach(optionsTargetId);
  const optionsVersion = await waitFor('the options page', async () => {
    const value = await cdp.evaluate(options, "document.querySelector('#app-version').textContent");
    return typeof value === 'string' && value !== '—' ? value : undefined;
  });
  expect(optionsVersion, '1.0.0', 'the options page reports the extension version');
  expect(
    await cdp.evaluate(options, "document.querySelectorAll('.session').length"),
    1,
    'the options page lists the stored session',
  );
  const exported = /** @type {{ ok: boolean, data: { text: string } }} */ (
    await cdp.evaluate(options, "chrome.runtime.sendMessage({ type: 'export-sessions' })")
  );
  expect(
    JSON.parse(exported.data.text).format,
    'manage-tabgroups.sessions',
    'export produces a file in the documented format',
  );

  console.info('\n9. Installation scheduled the automatic backup');
  expect(
    await inWorker(`chrome.alarms.getAll().then((a) => a.map((x) => x.name))`),
    ['manage-tabgroups:auto-backup'],
    'the backup alarm is registered under the name the code listens for',
  );
  expect(
    await inWorker(
      `chrome.alarms.get('manage-tabgroups:auto-backup').then((a) => a.periodInMinutes)`,
    ),
    5,
    'the alarm uses the default interval',
  );

  console.info('\n10. Batch removal behaves the way closeSavedTabs assumes');
  expect(
    await inWorker(
      `(async () => {
        const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
        const keep = await chrome.tabs.create({ windowId: win.id, url: 'https://example.com/keep', active: false });
        const doomed = await chrome.tabs.create({ windowId: win.id, url: 'https://example.com/gone', active: false });
        await chrome.tabs.remove(doomed.id);
        let rejected = false;
        try {
          await chrome.tabs.remove([keep.id, doomed.id]);
        } catch {
          rejected = true;
        }
        const survived = (await chrome.tabs.query({})).some((t) => t.id === keep.id);
        return { rejected, survived };
      })()`,
    ),
    { rejected: true, survived: false },
    'a stale id makes the batch reject after the other tabs are already gone',
  );

  console.info('\n11. No policy violations were logged by the browser');
  const violations = browserLog
    .join('')
    .split('\n')
    .filter((line) => /Refused to|Content Security Policy|Failed to load extension/i.test(line));
  expect(violations, [], 'no CSP or extension-load errors appeared');

  console.info(`\nAll ${checks} end-to-end checks passed.`);
} catch (error) {
  failure = error;
} finally {
  browser.kill('SIGTERM');
  await delay(500);
  browser.kill('SIGKILL');
  rmSync(profileDir, { recursive: true, force: true });
}

if (failure) {
  console.error(`\nEnd-to-end run failed after ${checks} checks:`);
  console.error(failure instanceof Error ? failure.message : String(failure));
  const tail = browserLog.join('').trim().split('\n').slice(-15).join('\n');
  if (tail.length > 0) {
    console.error(`\nBrowser output (tail):\n${tail}`);
  }
  process.exit(1);
}
