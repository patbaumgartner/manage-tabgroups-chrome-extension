/**
 * Service worker.
 *
 * All state changes happen here so that an action survives the popup closing.
 * The worker holds no long-lived state: it re-reads storage on every message and
 * is safe to terminate at any time.
 */

import {
  closeAllGroups,
  exportSessions,
  getState,
  importSessions,
  removeAllSessions,
  removeSession,
  restoreStoredSession,
  runAutoBackup,
  saveGroups,
  updateSettings,
} from './src/actions.js';
import { ALARM_AUTO_BACKUP, COMMANDS, MESSAGE_TYPES } from './src/constants.js';
import { readSettings } from './src/storage.js';
import { describeError } from './src/tabgroups.js';

/** Valid message types, as a set for cheap membership checks. */
const KNOWN_MESSAGE_TYPES = new Set(/** @type {string[]} */ (Object.values(MESSAGE_TYPES)));

/**
 * @param {string} text
 * @param {string} color
 * @returns {Promise<void>}
 */
async function flashBadge(text, color) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
  } catch {
    // The badge is cosmetic; never let it break an action.
  }
}

/**
 * @returns {Promise<void>}
 */
async function clearBadge() {
  try {
    await chrome.action.setBadgeText({ text: '' });
  } catch {
    // Ignore.
  }
}

/**
 * Align the auto-backup alarm with the stored settings.
 *
 * @returns {Promise<void>}
 */
async function syncAutoBackupAlarm() {
  const settings = await readSettings();
  await chrome.alarms.clear(ALARM_AUTO_BACKUP);
  if (!settings.autoBackup) {
    return;
  }
  await chrome.alarms.create(ALARM_AUTO_BACKUP, {
    delayInMinutes: settings.autoBackupIntervalMinutes,
    periodInMinutes: settings.autoBackupIntervalMinutes,
  });
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function readWindowId(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * @param {unknown} value
 * @returns {'window' | 'all' | undefined}
 */
function readScope(value) {
  if (value === 'window' || value === 'all') {
    return value;
  }
  return undefined;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function readId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : undefined;
}

/**
 * Dispatch one validated message.
 *
 * @param {Record<string, unknown>} message
 * @returns {Promise<unknown>}
 */
async function dispatch(message) {
  const windowId = readWindowId(message.windowId);
  const settings = await readSettings();
  const scope = readScope(message.scope) ?? settings.scope;

  switch (message.type) {
    case MESSAGE_TYPES.GET_STATE: {
      await clearBadge();
      return getState({ windowId });
    }
    case MESSAGE_TYPES.SAVE_GROUPS:
      return saveGroups({ scope, windowId });
    case MESSAGE_TYPES.CLOSE_ALL_GROUPS:
      return closeAllGroups({ scope, windowId });
    case MESSAGE_TYPES.RESTORE_SESSION:
      return restoreStoredSession({ sessionId: readId(message.sessionId), windowId });
    case MESSAGE_TYPES.DELETE_SESSION: {
      const id = readId(message.sessionId);
      if (id === undefined) {
        throw new Error('Missing session id.');
      }
      return { sessions: await removeSession(id) };
    }
    case MESSAGE_TYPES.CLEAR_SESSIONS:
      return { sessions: await removeAllSessions() };
    case MESSAGE_TYPES.UPDATE_SETTINGS: {
      const patch = message.settings;
      if (typeof patch !== 'object' || patch === null) {
        throw new Error('Missing settings payload.');
      }
      const next = await updateSettings(/** @type {Record<string, unknown>} */ (patch));
      await syncAutoBackupAlarm();
      return { settings: next };
    }
    case MESSAGE_TYPES.EXPORT_SESSIONS:
      return exportSessions(chrome.runtime.getManifest().version);
    case MESSAGE_TYPES.IMPORT_SESSIONS:
      return importSessions(message.text);
    default:
      throw new Error('Unsupported request.');
  }
}

/**
 * @param {unknown} message
 * @param {chrome.runtime.MessageSender} sender
 * @returns {Promise<{ ok: true, data: unknown } | { ok: false, error: string }>}
 */
async function handleMessage(message, sender) {
  // Only this extension's own pages may drive the worker. There is no
  // `externally_connectable` entry and no content script, so anything else is
  // unexpected and gets dropped.
  if (sender.id !== chrome.runtime.id) {
    return { ok: false, error: 'Unsupported request.' };
  }
  if (typeof message !== 'object' || message === null) {
    return { ok: false, error: 'Unsupported request.' };
  }
  const record = /** @type {Record<string, unknown>} */ (message);
  if (typeof record.type !== 'string' || !KNOWN_MESSAGE_TYPES.has(record.type)) {
    return { ok: false, error: 'Unsupported request.' };
  }

  try {
    return { ok: true, data: await dispatch(record) };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse, (error) => {
    sendResponse({ ok: false, error: describeError(error) });
  });
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  void syncAutoBackupAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  void syncAutoBackupAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_AUTO_BACKUP) {
    return;
  }
  void runAutoBackup().catch((error) => {
    console.warn('[manage-tabgroups] auto backup failed:', describeError(error));
  });
});

chrome.commands.onCommand.addListener((command) => {
  void (async () => {
    try {
      if (command === COMMANDS.CLOSE_ALL_GROUPS) {
        const result = await closeAllGroups();
        await flashBadge(String(result.saved.groupCount), '#1a73e8');
      } else if (command === COMMANDS.RESTORE_LATEST) {
        const result = await restoreStoredSession();
        await flashBadge(String(result.restoredGroups), '#188038');
      }
    } catch (error) {
      await flashBadge('!', '#c5221f');
      console.warn(`[manage-tabgroups] command "${command}" failed:`, describeError(error));
    }
  })();
});
