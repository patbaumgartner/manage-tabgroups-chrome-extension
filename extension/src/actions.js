/**
 * Application actions.
 *
 * Every mutation the UI can trigger lives here and runs inside the service
 * worker, so an action started from the popup completes even if the popup is
 * dismissed half a second later.
 */

import { LIMITS } from './constants.js';
import {
  buildSession,
  estimateSessionBytes,
  parseExport,
  serializeExport,
  sessionSignature,
  sessionStats,
} from './model.js';
import {
  addSession,
  addSessions,
  clearSessions,
  deleteSession,
  findSession,
  readSessions,
  readSettings,
  writeSettings,
} from './storage.js';
import {
  closeSavedTabs,
  collectLiveGroups,
  isTabGroupsSupported,
  restoreSession,
  summarizeLiveGroups,
} from './tabgroups.js';

/**
 * @typedef {import('./model.js').Session} Session
 * @typedef {import('./model.js').SavedTab} SavedTab
 * @typedef {import('./settings.js').Settings} Settings
 */

/**
 * @typedef {object} SessionSummary
 * @property {string} id
 * @property {number} createdAt
 * @property {'manual' | 'auto' | 'import'} source
 * @property {number} groupCount
 * @property {number} tabCount
 * @property {{ title: string, color: string, tabCount: number }[]} groups
 */

/**
 * @param {Session} session
 * @returns {SessionSummary}
 */
export function summarizeSession(session) {
  const stats = sessionStats(session);
  return {
    id: session.id,
    createdAt: session.createdAt,
    source: session.source,
    groupCount: stats.groupCount,
    tabCount: stats.tabCount,
    groups: session.groups.map((group) => ({
      title: group.title,
      color: group.color,
      tabCount: group.tabs.length,
    })),
  };
}

/**
 * Capture the current tab groups into a stored session.
 *
 * The session is only considered captured once it is verifiably present in
 * storage: a quota fallback or the retention limit can drop an entry, and
 * closing tabs for a session that was not kept would lose them for good.
 *
 * @param {object} [options]
 * @param {'window' | 'all'} [options.scope]
 * @param {number} [options.windowId]
 * @param {'manual' | 'auto'} [options.source]
 * @returns {Promise<{ session: Session, savedTabs: SavedTab[], skippedTabs: number }>}
 * @throws {Error} When there is nothing to save or the session was not stored.
 */
export async function captureSession(options = {}) {
  const { groups, tabs } = await collectLiveGroups({
    scope: options.scope,
    windowId: options.windowId,
  });
  const built = buildSession({
    groups,
    tabs,
    source: options.source ?? 'manual',
  });

  if (built.session.groups.length === 0) {
    throw new Error(
      options.scope === 'all'
        ? 'No tab groups are open in any window.'
        : 'No tab groups are open in this window.',
    );
  }

  const bytes = estimateSessionBytes(built.session);
  if (bytes > LIMITS.MAX_SESSION_BYTES) {
    throw new Error(
      `These groups are too large to store (${Math.round(bytes / 1024)} KB).` +
        ' Close some tabs and try again.',
    );
  }

  const stored = await addSession(built.session);
  if (!stored.some((session) => session.id === built.session.id)) {
    throw new Error(
      'The browser did not keep this session, so nothing was closed.' +
        ' Delete some saved sessions and try again.',
    );
  }
  return built;
}

/**
 * Save the current tab groups without touching them.
 *
 * @param {{ scope?: 'window' | 'all', windowId?: number }} [options]
 * @returns {Promise<{ saved: SessionSummary, skippedTabs: number }>}
 */
export async function saveGroups(options = {}) {
  const built = await captureSession({ ...options, source: 'manual' });
  return { saved: summarizeSession(built.session), skippedTabs: built.skippedTabs };
}

/**
 * Save the current tab groups and then close exactly the tabs that were saved.
 *
 * @param {{ scope?: 'window' | 'all', windowId?: number }} [options]
 * @returns {Promise<{ saved: SessionSummary, closedTabs: number, skippedTabs: number,
 *   changedTabs: number, placeholdersOpened: number }>}
 */
export async function closeAllGroups(options = {}) {
  const built = await captureSession({ ...options, source: 'manual' });
  const { closed, changed, placeholdersOpened } = await closeSavedTabs(built.savedTabs);
  return {
    saved: summarizeSession(built.session),
    closedTabs: closed,
    skippedTabs: built.skippedTabs,
    changedTabs: changed,
    placeholdersOpened,
  };
}

/**
 * Restore a stored session, or the most recent one when no id is given.
 *
 * @param {{ sessionId?: string, windowId?: number }} [options]
 * @returns {Promise<{ restoredGroups: number, restoredTabs: number, failures: string[],
 *   session: SessionSummary }>}
 */
export async function restoreStoredSession(options = {}) {
  const sessions = await readSessions();
  const session =
    typeof options.sessionId === 'string'
      ? await findSession(options.sessionId)
      : (sessions[0] ?? null);

  if (session === null) {
    throw new Error(
      typeof options.sessionId === 'string'
        ? 'That saved session no longer exists.'
        : 'There is nothing saved to restore yet.',
    );
  }

  const result = await restoreSession(session, { windowId: options.windowId });
  return { ...result, session: summarizeSession(session) };
}

/**
 * Periodic safety net: snapshot every window unless nothing changed.
 *
 * @returns {Promise<{ stored: boolean, reason: string }>}
 */
export async function runAutoBackup() {
  const settings = await readSettings();
  if (!settings.autoBackup) {
    return { stored: false, reason: 'auto backup disabled' };
  }
  if (!isTabGroupsSupported()) {
    return { stored: false, reason: 'tab groups unsupported' };
  }

  const { groups, tabs } = await collectLiveGroups({ scope: 'all' });
  const built = buildSession({ groups, tabs, source: 'auto' });
  if (built.session.groups.length === 0) {
    return { stored: false, reason: 'no tab groups open' };
  }
  if (estimateSessionBytes(built.session) > LIMITS.MAX_SESSION_BYTES) {
    return { stored: false, reason: 'snapshot too large' };
  }

  const existing = await readSessions();
  const latestAuto = existing.find((session) => session.source === 'auto');
  if (latestAuto && sessionSignature(latestAuto) === sessionSignature(built.session)) {
    return { stored: false, reason: 'unchanged since last backup' };
  }

  const stored = await addSession(built.session);
  if (!stored.some((session) => session.id === built.session.id)) {
    return { stored: false, reason: 'storage is full' };
  }
  return { stored: true, reason: 'stored' };
}

/**
 * Everything the popup and the options page need to render.
 *
 * @param {{ windowId?: number }} [options]
 * @returns {Promise<{ supported: boolean, settings: Settings,
 *   live: { groupCount: number, tabCount: number }, sessions: SessionSummary[] }>}
 */
export async function getState(options = {}) {
  const settings = await readSettings();
  const supported = isTabGroupsSupported();
  const sessions = await readSessions();
  const live = supported
    ? await summarizeLiveGroups({ scope: settings.scope, windowId: options.windowId })
    : { groupCount: 0, tabCount: 0 };

  return { supported, settings, live, sessions: sessions.map(summarizeSession) };
}

/**
 * @param {Partial<Settings>} patch
 * @returns {Promise<Settings>}
 */
export async function updateSettings(patch) {
  return writeSettings(patch);
}

/**
 * @param {string} id
 * @returns {Promise<SessionSummary[]>}
 */
export async function removeSession(id) {
  const sessions = await deleteSession(id);
  return sessions.map(summarizeSession);
}

/**
 * @returns {Promise<SessionSummary[]>}
 */
export async function removeAllSessions() {
  const sessions = await clearSessions();
  return sessions.map(summarizeSession);
}

/**
 * @param {string} [version]
 * @returns {Promise<{ text: string, sessionCount: number }>}
 */
export async function exportSessions(version) {
  const sessions = await readSessions();
  return {
    text: serializeExport(sessions, { version }),
    sessionCount: sessions.length,
  };
}

/**
 * Import previously exported sessions.
 *
 * The counts describe what actually survived: retention limits mean a large
 * import can be pruned immediately, and reporting the parsed count instead
 * would promise backups the user does not have.
 *
 * @param {unknown} text Raw contents of a previously exported file.
 * @returns {Promise<{ imported: number, rejected: number, evicted: number,
 *   sessions: SessionSummary[] }>}
 */
export async function importSessions(text) {
  const parsed = parseExport(text);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }

  const before = await readSessions();
  const stored = await addSessions(parsed.sessions);
  const storedIds = new Set(stored.map((session) => session.id));
  const incomingIds = new Set(parsed.sessions.map((session) => session.id));

  const imported = parsed.sessions.filter((session) => storedIds.has(session.id)).length;
  const evicted = before.filter(
    (session) => !storedIds.has(session.id) && !incomingIds.has(session.id),
  ).length;

  return {
    imported,
    rejected: parsed.rejected + (parsed.sessions.length - imported),
    evicted,
    sessions: stored.map(summarizeSession),
  };
}
