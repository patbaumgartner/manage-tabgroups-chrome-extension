#!/usr/bin/env node
/**
 * Static checks on the extension bundle.
 *
 * These assertions encode the security promises made in the README, so a change
 * that quietly adds a host permission, a content script, remote code or a
 * network call fails the build instead of shipping.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repository root. */
const REPO_ROOT = resolve(HERE, '..');

/** The only permissions this extension is allowed to request. */
export const ALLOWED_PERMISSIONS = ['tabs', 'tabGroups', 'storage', 'alarms'];

/** Manifest keys that would widen the attack surface and must stay absent. */
export const FORBIDDEN_MANIFEST_KEYS = [
  'host_permissions',
  'optional_host_permissions',
  'optional_permissions',
  'content_scripts',
  'web_accessible_resources',
  'externally_connectable',
  'declarative_net_request',
  'devtools_page',
  'chrome_url_overrides',
  'sandbox',
  'key',
  'update_url',
];

/** Constructs that must not appear in shipped JavaScript. */
const FORBIDDEN_CODE_PATTERNS = [
  { pattern: /\.innerHTML\s*=/, reason: 'an innerHTML assignment' },
  { pattern: /\.outerHTML\s*=/, reason: 'an outerHTML assignment' },
  { pattern: /insertAdjacentHTML\s*\(/, reason: 'insertAdjacentHTML' },
  { pattern: /document\.write\s*\(/, reason: 'document.write' },
  { pattern: /\beval\s*\(/, reason: 'eval()' },
  { pattern: /new\s+Function\s*\(/, reason: 'new Function()' },
  { pattern: /\bfetch\s*\(/, reason: 'a network request' },
  { pattern: /\bXMLHttpRequest\b/, reason: 'a network request' },
  { pattern: /new\s+WebSocket\s*\(/, reason: 'a network request' },
  { pattern: /sendBeacon\s*\(/, reason: 'a network request' },
  { pattern: /importScripts\s*\(/, reason: 'remote script loading' },
  { pattern: /chrome\.storage\.sync\b/, reason: 'off-device storage' },
];

/** A remote URL in any shipped asset would be a request the browser makes for us. */
const REMOTE_URL_PATTERN = /\b(?:https?:)?\/\/[a-z0-9-]+\.[a-z]/i;

/**
 * @param {string} directory
 * @returns {string[]} Absolute paths of every file below `directory`, sorted.
 */
export function listFiles(directory) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files.sort();
}

/**
 * @param {Record<string, unknown>} manifest
 * @returns {string[]} Every extension-relative path the manifest points at.
 */
function referencedPaths(manifest) {
  /** @type {string[]} */
  const paths = [];
  const background = /** @type {{ service_worker?: string } | undefined} */ (manifest.background);
  if (background?.service_worker !== undefined) {
    paths.push(background.service_worker);
  }
  const action =
    /** @type {{ default_popup?: string, default_icon?: Record<string, string> } | undefined} */ (
      manifest.action
    );
  if (action?.default_popup !== undefined) {
    paths.push(action.default_popup);
  }
  paths.push(...Object.values(action?.default_icon ?? {}));
  paths.push(...Object.values(/** @type {Record<string, string>} */ (manifest.icons ?? {})));
  const optionsUi = /** @type {{ page?: string } | undefined} */ (manifest.options_ui);
  if (optionsUi?.page !== undefined) {
    paths.push(optionsUi.page);
  }
  return paths;
}

/**
 * @param {Record<string, unknown>} manifest
 * @param {string[]} errors
 * @param {string[]} warnings
 * @returns {void}
 */
function checkManifestShape(manifest, errors, warnings) {
  if (manifest.manifest_version !== 3) {
    errors.push('manifest_version must be 3');
  }
  for (const key of FORBIDDEN_MANIFEST_KEYS) {
    if (key in manifest) {
      errors.push(`manifest must not declare "${key}"`);
    }
  }

  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  for (const permission of permissions) {
    if (!ALLOWED_PERMISSIONS.includes(String(permission))) {
      errors.push(`unexpected permission "${String(permission)}"`);
    }
  }
  for (const permission of ALLOWED_PERMISSIONS) {
    if (!permissions.includes(permission)) {
      warnings.push(`documented permission "${permission}" is not declared`);
    }
  }

  const csp = /** @type {{ extension_pages?: string } | undefined} */ (
    manifest.content_security_policy
  );
  const policy = csp?.extension_pages ?? '';
  if (!/script-src\s+'self'/.test(policy)) {
    errors.push("content_security_policy.extension_pages must pin script-src to 'self'");
  }
  if (!/connect-src\s+'none'/.test(policy)) {
    warnings.push('content_security_policy.extension_pages does not block connect-src');
  }
}

/**
 * @param {string} source
 * @param {string} label
 * @param {string[]} errors
 * @returns {void}
 */
function checkScript(source, label, errors) {
  for (const { pattern, reason } of FORBIDDEN_CODE_PATTERNS) {
    if (pattern.test(source)) {
      errors.push(`${label} contains ${reason}`);
    }
  }
}

/**
 * @param {string} html
 * @param {string} label
 * @param {string[]} errors
 * @returns {void}
 */
function checkMarkup(html, label, errors) {
  if (/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html)) {
    errors.push(`${label} contains an inline script`);
  }
  if (/\son(?:click|load|error|change|input|submit|focus|blur)\s*=/i.test(html)) {
    errors.push(`${label} contains an inline event handler`);
  }
  // An `href` on an anchor is a navigation the user chooses; `src`, `srcset` and
  // a stylesheet `link` are resources the browser fetches on the page's behalf,
  // which would defeat the no-network guarantee.
  for (const match of html.matchAll(/\s(?:src|srcset)\s*=\s*["']([^"']*)["']/gi)) {
    if (REMOTE_URL_PATTERN.test(match[1] ?? '')) {
      errors.push(`${label} loads a remote resource: ${match[1]}`);
    }
  }
  for (const match of html.matchAll(/<link\b[^>]*\shref\s*=\s*["']([^"']*)["']/gi)) {
    if (REMOTE_URL_PATTERN.test(match[1] ?? '')) {
      errors.push(`${label} links a remote resource: ${match[1]}`);
    }
  }
}

/**
 * @param {string} css
 * @param {string} label
 * @param {string[]} errors
 * @returns {void}
 */
function checkStylesheet(css, label, errors) {
  for (const match of css.matchAll(/url\(\s*["']?([^"')]*)["']?\s*\)/gi)) {
    if (REMOTE_URL_PATTERN.test(match[1] ?? '')) {
      errors.push(`${label} loads a remote resource: ${match[1]}`);
    }
  }
  for (const match of css.matchAll(/@import\s+["']([^"']*)["']/gi)) {
    if (REMOTE_URL_PATTERN.test(match[1] ?? '')) {
      errors.push(`${label} imports a remote stylesheet: ${match[1]}`);
    }
  }
}

/**
 * @param {string} extensionDir
 * @param {string} root
 * @param {string[]} errors
 * @returns {void}
 */
function checkSourceFiles(extensionDir, root, errors) {
  for (const file of listFiles(extensionDir)) {
    const label = relative(root, file);
    if (file.endsWith('.js')) {
      checkScript(readFileSync(file, 'utf8'), label, errors);
    } else if (file.endsWith('.html')) {
      checkMarkup(readFileSync(file, 'utf8'), label, errors);
    } else if (file.endsWith('.css')) {
      checkStylesheet(readFileSync(file, 'utf8'), label, errors);
    }
  }
}

/**
 * Validate the extension directory of a checkout.
 *
 * @param {string} [root]
 * @returns {{ errors: string[], warnings: string[], manifest: Record<string, unknown> }}
 */
export function validateExtension(root = REPO_ROOT) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  const extensionDir = join(root, 'extension');
  const manifestPath = join(extensionDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { errors: [`missing ${relative(root, manifestPath)}`], warnings, manifest: {} };
  }

  /** @type {Record<string, unknown>} */
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { errors: [`manifest.json is not valid JSON: ${reason}`], warnings, manifest: {} };
  }

  checkManifestShape(manifest, errors, warnings);

  for (const path of referencedPaths(manifest)) {
    if (!existsSync(join(extensionDir, path))) {
      errors.push(`manifest references a missing file: ${path}`);
    }
  }

  const packagePath = join(root, 'package.json');
  if (existsSync(packagePath)) {
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
    if (pkg.version !== manifest.version) {
      errors.push(
        `manifest version ${String(manifest.version)} does not match package.json ${pkg.version}`,
      );
    }
  }

  checkSourceFiles(extensionDir, root, errors);

  return { errors, warnings, manifest };
}

/**
 * @returns {number} Process exit code.
 */
function main() {
  const { errors, warnings } = validateExtension();
  for (const warning of warnings) {
    console.warn(`warning: ${warning}`);
  }
  for (const error of errors) {
    console.error(`error: ${error}`);
  }
  if (errors.length > 0) {
    console.error(`${errors.length} problem(s) found in the extension bundle.`);
    return 1;
  }
  console.info('Extension bundle looks good.');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
