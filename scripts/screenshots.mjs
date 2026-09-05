#!/usr/bin/env node
/**
 * Regenerate the documentation screenshots.
 *
 * Drives the same real browser harness as the end-to-end run, so the images in
 * the README are always of the actual UI rather than a mock-up. The demo data
 * is synthetic on purpose: nothing here comes from a real browsing session.
 *
 * Usage: npm run screenshots
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { findChrome, launchWithExtension, waitFor } from './lib/devtools.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = join(ROOT, 'extension');
const OUTPUT_DIR = join(ROOT, 'docs/screenshots');

/** Entirely invented browsing data. */
const DEMO_GROUPS = [
  { title: 'Work', color: 'blue', urls: ['one', 'two', 'three'] },
  { title: 'Reading list', color: 'green', urls: ['four', 'five'] },
  { title: 'Recipes', color: 'orange', urls: ['six'] },
];

const DEMO_SESSIONS = [
  { id: 'demo-1', ageMinutes: 3, source: 'manual', groups: DEMO_GROUPS },
  {
    id: 'demo-2',
    ageMinutes: 95,
    source: 'auto',
    groups: [
      { title: 'Research', color: 'purple', urls: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
      { title: 'Docs', color: 'cyan', urls: ['h', 'i', 'j', 'k'] },
    ],
  },
  {
    id: 'demo-3',
    ageMinutes: 3000,
    source: 'import',
    groups: [
      { title: 'Old project', color: 'red', urls: Array.from({ length: 12 }, (_, i) => `p${i}`) },
    ],
  },
];

/** @type {{ name: string, path: string, width: number, height: number, scheme: string }[]} */
const SHOTS = [
  { name: 'popup-light', path: 'popup/popup.html', width: 340, height: 470, scheme: 'light' },
  { name: 'popup-dark', path: 'popup/popup.html', width: 340, height: 470, scheme: 'dark' },
  {
    name: 'options-light',
    path: 'options/options.html',
    width: 860,
    height: 1080,
    scheme: 'light',
  },
];

if (findChrome() === undefined) {
  console.warn('No Chromium binary found (set CHROME_PATH) - cannot regenerate screenshots.');
  process.exit(1);
}

const session = await launchWithExtension({
  extensionDir: EXTENSION_DIR,
  headless: true,
  deviceScaleFactor: 2,
});
const { cdp, extensionId, inWorker } = session;
console.info(`Browser: ${session.product}`);

/**
 * Ages are written relative to the browser's own clock immediately before each
 * capture, with a cushion past the whole-minute boundary. Otherwise the run can
 * straddle a minute and "3 minutes ago" becomes "4 minutes ago" halfway through,
 * which would churn the committed images on every regeneration.
 */
const AGE_CUSHION_MS = 20_000;

/**
 * @returns {Promise<void>}
 */
async function seedSessions() {
  await inWorker(
    `chrome.storage.local.set({ sessions: ${JSON.stringify(DEMO_SESSIONS)}.map((entry) => ({
      id: entry.id,
      createdAt: Date.now() - entry.ageMinutes * 60000 - ${AGE_CUSHION_MS},
      source: entry.source,
      groups: entry.groups.map((group) => ({
        title: group.title,
        color: group.color,
        collapsed: false,
        tabs: group.urls.map((slug) => ({
          url: 'https://example.com/' + slug,
          title: group.title + ' - ' + slug,
        })),
      })),
    })) })`,
  );
}

try {
  await inWorker(
    `(async () => {
      const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      for (const group of ${JSON.stringify(DEMO_GROUPS)}) {
        const ids = [];
        for (const slug of group.urls) {
          const tab = await chrome.tabs.create({
            windowId: win.id,
            url: 'https://example.com/' + slug,
            active: false,
          });
          ids.push(tab.id);
        }
        const groupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: win.id } });
        await chrome.tabGroups.update(groupId, { title: group.title, color: group.color });
      }
      return true;
    })()`,
  );

  mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const shot of SHOTS) {
    await seedSessions();
    const { targetId } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${extensionId}/${shot.path}`,
    });
    const page = await cdp.attach(targetId);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: shot.width, height: shot.height, deviceScaleFactor: 2, mobile: false },
      page,
    );
    await cdp.send(
      'Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-color-scheme', value: shot.scheme }] },
      page,
    );

    await waitFor(`${shot.name} to render`, async () => {
      const marker = shot.path.includes('popup') ? '#live-summary' : '#app-version';
      const text = await cdp.evaluate(page, `document.querySelector('${marker}').textContent`);
      return (
        typeof text === 'string' && text.length > 0 && !text.includes('Checking') && text !== '—'
      );
    });
    await delay(400);

    const { data } = await cdp.send(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: true },
      page,
    );
    const file = join(OUTPUT_DIR, `${shot.name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.info(`  wrote ${relative(ROOT, file)}`);
    await cdp.send('Target.closeTarget', { targetId });
  }

  console.info(`\n${SHOTS.length} screenshots written to ${relative(ROOT, OUTPUT_DIR)}.`);
  console.info('Commit them exactly as produced; post-processing would mean that');
  console.info('regenerating no longer reproduces the files in the repository.');
} finally {
  await session.close();
}
