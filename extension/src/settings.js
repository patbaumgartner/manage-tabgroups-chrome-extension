/**
 * Pure settings normalization.
 *
 * Settings are read back from `chrome.storage.local`, which is writable by
 * anything running in the extension's own profile directory, so they are
 * validated on every read instead of being trusted.
 */

import { AUTO_BACKUP_INTERVAL_BOUNDS, DEFAULT_SETTINGS } from './constants.js';

/**
 * @typedef {object} Settings
 * @property {'window' | 'all'} scope
 * @property {boolean} autoBackup
 * @property {number} autoBackupIntervalMinutes
 * @property {boolean} closePopupAfterAction
 */

/**
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function toBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * @param {unknown} value
 * @returns {Settings} A complete, in-range settings object.
 */
export function normalizeSettings(value) {
  const source = typeof value === 'object' && value !== null ? value : {};
  const record = /** @type {Record<string, unknown>} */ (source);

  const interval = Number(record.autoBackupIntervalMinutes);
  const clampedInterval = Number.isFinite(interval)
    ? Math.min(
        AUTO_BACKUP_INTERVAL_BOUNDS.MAX,
        Math.max(AUTO_BACKUP_INTERVAL_BOUNDS.MIN, Math.round(interval)),
      )
    : DEFAULT_SETTINGS.autoBackupIntervalMinutes;

  return {
    scope:
      record.scope === 'all' || record.scope === 'window' ? record.scope : DEFAULT_SETTINGS.scope,
    autoBackup: toBoolean(record.autoBackup, DEFAULT_SETTINGS.autoBackup),
    autoBackupIntervalMinutes: clampedInterval,
    closePopupAfterAction: toBoolean(
      record.closePopupAfterAction,
      DEFAULT_SETTINGS.closePopupAfterAction,
    ),
  };
}
