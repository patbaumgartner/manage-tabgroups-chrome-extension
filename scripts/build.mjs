#!/usr/bin/env node
/**
 * Package the extension into a reproducible ZIP for a GitHub release.
 *
 * The archive contains the `extension/` directory plus the licence, so
 * unzipping it and pointing "Load unpacked" at the result behaves identically to
 * loading the folder straight from a checkout.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createZip } from './lib/zip.mjs';
import { listFiles, validateExtension } from './validate-manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, '..');

/**
 * Everything that goes into the release archive.
 *
 * The MIT licence requires its notice to travel with every copy, and this
 * archive is the primary way people receive the software.
 *
 * @param {string} [root]
 * @returns {import('./lib/zip.mjs').ZipEntry[]}
 */
export function collectEntries(root = DEFAULT_ROOT) {
  const extensionDir = join(root, 'extension');
  const entries = listFiles(extensionDir).map((file) => ({
    name: relative(extensionDir, file).split(sep).join('/'),
    data: readFileSync(file),
  }));
  entries.push({ name: 'LICENSE', data: readFileSync(join(root, 'LICENSE')) });
  return entries;
}

/**
 * @param {string} [root]
 * @returns {{ archive: Buffer, name: string, digest: string, fileCount: number }}
 */
export function buildArchive(root = DEFAULT_ROOT) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const entries = collectEntries(root);
  if (entries.length <= 1) {
    throw new Error('the extension directory is empty');
  }
  const archive = createZip(entries);
  return {
    archive,
    name: `manage-tabgroups-${pkg.version}.zip`,
    digest: createHash('sha256').update(archive).digest('hex'),
    fileCount: entries.length,
  };
}

/**
 * @returns {number} Process exit code.
 */
function main() {
  const { errors, warnings } = validateExtension(DEFAULT_ROOT);
  for (const warning of warnings) {
    console.warn(`warning: ${warning}`);
  }
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`error: ${error}`);
    }
    console.error('Refusing to build an extension bundle that fails validation.');
    return 1;
  }

  const { archive, name, digest, fileCount } = buildArchive(DEFAULT_ROOT);
  const distDir = join(DEFAULT_ROOT, 'dist');
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, name), archive);
  writeFileSync(join(distDir, `${name}.sha256`), `${digest}  ${name}\n`);

  console.info(`Packaged ${fileCount} files into dist/${name}`);
  console.info(`Size    : ${(archive.length / 1024).toFixed(1)} KB`);
  console.info(`SHA-256 : ${digest}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
