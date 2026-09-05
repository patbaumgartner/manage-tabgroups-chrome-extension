/**
 * Pure presentation helpers.
 *
 * Kept free of DOM and `chrome.*` access so they can be unit tested directly.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * @param {number} count
 * @param {string} singular
 * @param {string} plural
 * @returns {string}
 */
export function pluralize(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * @param {number} groupCount
 * @param {number} tabCount
 * @returns {string} e.g. `"3 groups · 24 tabs"`.
 */
export function formatCounts(groupCount, tabCount) {
  return `${pluralize(groupCount, 'group', 'groups')} · ${pluralize(tabCount, 'tab', 'tabs')}`;
}

/**
 * @param {number} timestamp Unix epoch milliseconds.
 * @param {number} [now]
 * @returns {string} A short, human readable age.
 */
export function formatRelativeTime(timestamp, now = Date.now()) {
  const delta = now - timestamp;
  if (!Number.isFinite(delta) || delta < MINUTE) {
    return 'just now';
  }
  if (delta < HOUR) {
    return `${pluralize(Math.floor(delta / MINUTE), 'minute', 'minutes')} ago`;
  }
  if (delta < DAY) {
    return `${pluralize(Math.floor(delta / HOUR), 'hour', 'hours')} ago`;
  }
  if (delta < 7 * DAY) {
    return `${pluralize(Math.floor(delta / DAY), 'day', 'days')} ago`;
  }
  return new Date(timestamp).toLocaleDateString();
}

/**
 * @param {string} source
 * @returns {string}
 */
export function formatSource(source) {
  switch (source) {
    case 'auto':
      return 'Auto backup';
    case 'import':
      return 'Imported';
    default:
      return 'Saved';
  }
}

/**
 * Build the sentence shown after a close operation.
 *
 * @param {{ groupCount: number, tabCount: number }} saved
 * @param {number} skippedTabs
 * @param {number} [changedTabs]
 * @returns {string}
 */
export function formatCloseResult(saved, skippedTabs, changedTabs = 0) {
  const parts = [`Saved and closed ${formatCounts(saved.groupCount, saved.tabCount)}.`];
  if (skippedTabs > 0) {
    parts.push(`${pluralize(skippedTabs, 'tab', 'tabs')} left open (unsupported address).`);
  }
  if (changedTabs > 0) {
    parts.push(`${pluralize(changedTabs, 'tab', 'tabs')} left open (changed while saving).`);
  }
  return parts.join(' ');
}

/**
 * Build the sentence shown after an import.
 *
 * @param {{ imported: number, rejected: number, evicted: number }} result
 * @returns {string}
 */
export function formatImportResult(result) {
  const parts = [`Imported ${pluralize(result.imported, 'session', 'sessions')}.`];
  if (result.rejected > 0) {
    parts.push(`${pluralize(result.rejected, 'entry', 'entries')} skipped as unusable.`);
  }
  if (result.evicted > 0) {
    parts.push(
      `${pluralize(result.evicted, 'older session', 'older sessions')} dropped to stay within the limit.`,
    );
  }
  return parts.join(' ');
}

/**
 * Build the sentence shown after a restore operation.
 *
 * @param {{ restoredGroups: number, restoredTabs: number, failures: readonly string[] }} result
 * @returns {string}
 */
export function formatRestoreResult(result) {
  const base = `Restored ${formatCounts(result.restoredGroups, result.restoredTabs)}.`;
  if (result.failures.length === 0) {
    return base;
  }
  return `${base} ${pluralize(result.failures.length, 'item', 'items')} could not be restored.`;
}

/**
 * A timestamp suitable for a downloaded file name: `2026-09-05_14-32-07`.
 *
 * @param {number} timestamp
 * @returns {string}
 */
export function formatFileTimestamp(timestamp) {
  const date = new Date(timestamp);
  const pad = (/** @type {number} */ value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}
