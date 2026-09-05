import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { COMMANDS } from '../extension/src/constants.js';
import { buildArchive, collectEntries } from '../scripts/build.mjs';
import { crc32, createZip } from '../scripts/lib/zip.mjs';
import {
  ALLOWED_PERMISSIONS,
  FORBIDDEN_MANIFEST_KEYS,
  validateExtension,
} from '../scripts/validate-manifest.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('extension bundle', () => {
  const { errors, warnings, manifest } = validateExtension(ROOT);

  it('passes every static check', () => {
    assert.deepEqual(errors, []);
  });

  it('raises no warnings', () => {
    assert.deepEqual(warnings, []);
  });

  it('requests only the documented permissions', () => {
    assert.deepEqual(
      [.../** @type {string[]} */ (manifest.permissions)].sort(),
      [...ALLOWED_PERMISSIONS].sort(),
    );
  });

  it('declares none of the wide-reaching manifest keys', () => {
    for (const key of FORBIDDEN_MANIFEST_KEYS) {
      assert.equal(key in manifest, false, `manifest must not declare ${key}`);
    }
  });

  it('runs its service worker as an ES module', () => {
    assert.deepEqual(manifest.background, {
      service_worker: 'background.js',
      type: 'module',
    });
  });

  it('blocks every request source in its content security policy', () => {
    const policy = /** @type {{ extension_pages: string }} */ (manifest.content_security_policy)
      .extension_pages;
    for (const directive of [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self'",
      "connect-src 'none'",
      "object-src 'none'",
    ]) {
      assert.ok(policy.includes(directive), `policy must contain "${directive}"`);
    }
  });

  it('states a minimum browser version that covers the APIs it uses', () => {
    // chrome.alarms.create() only returns a promise from Chrome 111, and the
    // documented storage budget assumes the 10 MB quota introduced in Chrome 114.
    assert.ok(Number(manifest.minimum_chrome_version) >= 114);
  });

  it('keeps the manifest commands and the code constants in step', () => {
    const declared = Object.keys(
      /** @type {Record<string, unknown>} */ (manifest.commands ?? {}),
    ).sort();
    assert.deepEqual(declared, [...Object.values(COMMANDS)].sort());
  });

  it('documents the same permission list in the README', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    for (const permission of ALLOWED_PERMISSIONS) {
      assert.ok(readme.includes(`\`${permission}\``), `README must explain "${permission}"`);
    }
  });
});

describe('validateExtension', () => {
  it('reports a missing extension directory instead of throwing', () => {
    const result = validateExtension(join(ROOT, 'does-not-exist'));
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0] ?? '', /missing/);
  });

  it('catches every unsafe pattern in a deliberately bad bundle', () => {
    const { errors } = validateExtension(join(ROOT, 'tests/fixtures/insecure-extension'));
    const joined = errors.join('\n');

    assert.match(joined, /must not declare "host_permissions"/);
    assert.match(joined, /unexpected permission "cookies"/);
    assert.match(joined, /page\.js contains a network request/);
    assert.match(joined, /page\.html contains an inline script/);
    assert.match(joined, /page\.html contains an inline event handler/);
    assert.match(joined, /page\.html loads a remote resource: https:\/\/tracker\.example/);
    assert.match(joined, /page\.html links a remote resource: https:\/\/cdn\.example/);
    assert.match(joined, /page\.css loads a remote resource: https:\/\/tracker\.example/);
    assert.match(joined, /page\.css imports a remote stylesheet: https:\/\/cdn\.example/);
  });

  it('does not mistake an ordinary link for a fetched resource', () => {
    const { errors } = validateExtension(join(ROOT, 'tests/fixtures/insecure-extension'));
    assert.ok(
      !errors.some((error) => error.includes('https://example.com/docs')),
      'an anchor href is a navigation the user chooses, not a request',
    );
  });
});

describe('release archive', () => {
  it('ships the licence alongside the extension', () => {
    const names = collectEntries(ROOT).map((entry) => entry.name);
    assert.ok(names.includes('LICENSE'), 'the MIT notice must travel with the archive');
    assert.ok(names.includes('manifest.json'));
    assert.ok(names.includes('background.js'));
  });

  it('places the manifest at the archive root so it loads unpacked', () => {
    const names = collectEntries(ROOT).map((entry) => entry.name);
    assert.ok(!names.some((name) => name.startsWith('extension/')));
  });

  it('names the archive after the package version and is reproducible', () => {
    const first = buildArchive(ROOT);
    const second = buildArchive(ROOT);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.equal(first.name, `manage-tabgroups-${pkg.version}.zip`);
    assert.equal(first.digest, second.digest);
  });
});

describe('zip writer', () => {
  it('matches the reference CRC-32 of the standard test vector', () => {
    assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcb_f4_39_26);
    assert.equal(crc32(new Uint8Array(0)), 0);
  });

  it('produces an archive the system unzip can read', () => {
    const archive = createZip([
      { name: 'b.txt', data: new TextEncoder().encode('second') },
      { name: 'nested/a.txt', data: new TextEncoder().encode('first') },
    ]);
    const listing = execFileSync('python3', ['-c', READ_ZIP_SCRIPT], {
      input: archive,
      encoding: 'utf8',
    });
    assert.equal(listing, 'b.txt:second\nnested/a.txt:first\n');
  });

  it('is byte-for-byte reproducible', () => {
    const build = () =>
      createZip([{ name: 'a.txt', data: new TextEncoder().encode('stable content') }]);
    assert.deepEqual(build(), build());
  });
});

const READ_ZIP_SCRIPT = `
import io, sys, zipfile
data = sys.stdin.buffer.read()
with zipfile.ZipFile(io.BytesIO(data)) as archive:
    assert archive.testzip() is None
    for name in sorted(archive.namelist()):
        print(name + ":" + archive.read(name).decode())
`;
