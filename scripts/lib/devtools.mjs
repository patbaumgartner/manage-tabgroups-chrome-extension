/**
 * Shared Chrome DevTools Protocol harness.
 *
 * Used by the end-to-end run and by the screenshot generator, so both drive a
 * real browser through exactly the same code path.
 *
 * Chrome 137 disabled the `--load-extension` command line switch, so the
 * extension is installed through the DevTools `Extensions.loadUnpacked` command
 * over a debugging pipe. Browsers that still honour `--load-extension` are
 * covered by the fallback in `installExtension`.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

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

/**
 * @returns {string | undefined} The first usable Chromium binary, if any.
 */
export function findChrome() {
  return CHROME_CANDIDATES.find((candidate) => isRunnable(candidate));
}

/**
 * @template T
 * @param {string} label
 * @param {() => Promise<T | undefined | null | false>} probe
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
export async function waitFor(label, probe, timeoutMs = 20_000) {
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
   * leaves a promise nobody ever settles, and the caller hangs until the CI
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
 * @param {DevToolsPipe} cdp
 * @param {string} extensionDir
 * @param {string} expectedId
 * @returns {Promise<string>}
 */
async function installExtension(cdp, extensionDir, expectedId) {
  try {
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: extensionDir });
    return id;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.info(`  Extensions.loadUnpacked unavailable (${reason}); relying on --load-extension`);
    return expectedId;
  }
}

/**
 * @typedef {object} BrowserSession
 * @property {DevToolsPipe} cdp
 * @property {string} extensionId
 * @property {string} worker Session id of the extension service worker.
 * @property {(expression: string) => Promise<unknown>} inWorker
 * @property {string} product Browser version string.
 * @property {() => string[]} browserLog
 * @property {() => Promise<void>} close
 */

/**
 * Start a browser with the extension installed and its service worker ready.
 *
 * @param {object} options
 * @param {string} options.extensionDir
 * @param {boolean} [options.headless]
 * @param {number} [options.deviceScaleFactor]
 * @returns {Promise<BrowserSession>}
 */
export async function launchWithExtension(options) {
  const chromeBinary = findChrome();
  if (chromeBinary === undefined) {
    throw new Error('No Chromium binary found (set CHROME_PATH).');
  }

  const profileDir = mkdtempSync(join(tmpdir(), 'manage-tabgroups-'));
  const args = [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--load-extension=${options.extensionDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-search-engine-choice-screen',
    '--no-sandbox',
    'about:blank',
  ];
  if (options.headless !== false) {
    args.unshift('--headless=new');
  }
  if (options.deviceScaleFactor !== undefined) {
    args.push(`--force-device-scale-factor=${options.deviceScaleFactor}`);
  }

  const browser = spawn(chromeBinary, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
  /** @type {string[]} */
  const log = [];
  browser.stdout?.on('data', (chunk) => log.push(String(chunk)));
  browser.stderr?.on('data', (chunk) => log.push(String(chunk)));

  const outgoing = /** @type {import('node:stream').Writable} */ (browser.stdio[3]);
  const incoming = /** @type {import('node:stream').Readable} */ (browser.stdio[4]);
  if (!outgoing || !incoming) {
    browser.kill('SIGKILL');
    rmSync(profileDir, { recursive: true, force: true });
    throw new Error('The browser did not expose a DevTools pipe.');
  }

  const cdp = new DevToolsPipe(outgoing, incoming);
  browser.on('exit', (code) => {
    cdp.failAll(new Error(`The browser exited with code ${String(code)}.`));
  });

  const version = await waitFor('the DevTools pipe', () => cdp.send('Browser.getVersion'));
  const expectedId = unpackedExtensionId(options.extensionDir);
  const extensionId = await installExtension(cdp, options.extensionDir, expectedId);
  await cdp.send('Target.setDiscoverTargets', { discover: true });

  const workerTarget = await waitFor('the extension service worker', async () => {
    const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{}] });
    return targetInfos.find(
      (/** @type {{ type: string, url: string }} */ target) =>
        target.type === 'service_worker' && target.url.includes(extensionId),
    );
  });
  const worker = await cdp.attach(workerTarget.targetId);
  await cdp.send('Runtime.enable', {}, worker);

  /**
   * @param {string} expression
   * @returns {Promise<unknown>}
   */
  const inWorker = (expression) => cdp.evaluate(worker, expression);

  // Attaching to the worker target only means it exists. Its JavaScript context
  // is created a moment later, and evaluating before that fails with
  // "chrome is not defined" - reliably on a fast CI runner, rarely elsewhere.
  await waitFor('the service worker context', async () => {
    return (await inWorker('typeof chrome')) === 'object';
  });

  return {
    cdp,
    extensionId,
    worker,
    inWorker,
    product: version.product,
    browserLog: () => log,
    close: async () => {
      browser.kill('SIGTERM');
      await delay(500);
      browser.kill('SIGKILL');
      rmSync(profileDir, { recursive: true, force: true });
    },
  };
}
