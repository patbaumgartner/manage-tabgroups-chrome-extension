import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHARED_CSS = readFileSync(join(ROOT, 'extension/styles/shared.css'), 'utf8');

/**
 * @param {string} hex
 * @returns {number} Relative luminance, per WCAG 2.2.
 */
function luminance(hex) {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function contrast(a, b) {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/**
 * @param {'light' | 'dark'} scheme
 * @returns {Record<string, string>}
 */
function palette(scheme) {
  const block =
    scheme === 'light'
      ? (SHARED_CSS.split(':root {')[1] ?? '').split('}')[0]
      : (SHARED_CSS.split('prefers-color-scheme: dark')[1] ?? '').split('}')[0];
  /** @type {Record<string, string>} */
  const found = {};
  for (const match of (block ?? '').matchAll(/(--tgk-[\w-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    found[match[1] ?? ''] = match[2] ?? '';
  }
  return scheme === 'light' ? found : { ...palette('light'), ...found };
}

describe('colour contrast', () => {
  for (const scheme of /** @type {const} */ (['light', 'dark'])) {
    describe(scheme, () => {
      const colours = palette(scheme);

      it('meets AA 1.4.3 for every text pairing', () => {
        /** @type {[string, string, string][]} */
        const pairs = [
          ['--tgk-text', '--tgk-bg', 'body text'],
          ['--tgk-text', '--tgk-bg-subtle', 'text on panels'],
          ['--tgk-text-muted', '--tgk-bg', 'muted text'],
          ['--tgk-text-muted', '--tgk-bg-subtle', 'muted text on panels'],
          ['--tgk-accent-text', '--tgk-accent', 'primary button label'],
          ['--tgk-success', '--tgk-bg', 'success label'],
          ['--tgk-danger', '--tgk-bg', 'danger label'],
          ['--tgk-accent', '--tgk-bg', 'link text'],
        ];
        for (const [fg, bg, label] of pairs) {
          const value = contrast(colours[fg] ?? '#000000', colours[bg] ?? '#ffffff');
          assert.ok(value >= 4.5, `${scheme} ${label}: ${value.toFixed(2)}:1 is below 4.5:1`);
        }
      });

      it('meets AA 1.4.11 for the boundary of an interactive control', () => {
        // Controls sit on the subtle panel as well as the page, so the boundary
        // has to clear 3:1 against both. --tgk-border is a decorative divider
        // and is deliberately lighter; it must not be used on a control.
        for (const background of ['--tgk-bg', '--tgk-bg-subtle']) {
          const value = contrast(
            colours['--tgk-border-control'] ?? '#000000',
            colours[background] ?? '#ffffff',
          );
          assert.ok(
            value >= 3,
            `${scheme} control border on ${background}: ${value.toFixed(2)}:1 is below 3:1`,
          );
        }
      });
    });
  }

  it('uses the control token for every interactive control', () => {
    /** @type {[string, string][]} */
    const controls = [
      ['extension/styles/shared.css', '.button {'],
      ['extension/popup/popup.css', '.segmented {'],
      ['extension/options/options.css', 'input[type="number"] {'],
    ];
    for (const [file, selector] of controls) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      const block = text.slice(text.indexOf(selector));
      const rule = block.slice(0, block.indexOf('}'));
      assert.match(
        rule,
        /--tgk-border-control/,
        `${selector} in ${file} must use the accessible control border`,
      );
    }
  });
});
