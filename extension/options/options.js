/** Options page controller. */

import { AUTO_BACKUP_INTERVAL_BOUNDS, LIMITS, MESSAGE_TYPES } from '../src/constants.js';
import { armConfirmButton, clearChildren, el, requireElement } from '../src/dom.js';
import {
  formatCounts,
  formatFileTimestamp,
  formatImportResult,
  formatRelativeTime,
  formatRestoreResult,
  formatSource,
  pluralize,
} from '../src/format.js';
import { request } from '../src/messaging.js';

/**
 * @typedef {import('../src/actions.js').SessionSummary} SessionSummary
 * @typedef {import('../src/settings.js').Settings} Settings
 * @typedef {{ supported: boolean, settings: Settings,
 *   live: { groupCount: number, tabCount: number }, sessions: SessionSummary[] }} OptionsState
 */

const dom = {
  version: requireElement('#app-version', HTMLSpanElement),
  unsupported: requireElement('#unsupported', HTMLParagraphElement),
  status: requireElement('#status', HTMLParagraphElement),
  scopeWindow: requireElement('#scope-window', HTMLInputElement),
  scopeAll: requireElement('#scope-all', HTMLInputElement),
  autoBackup: requireElement('#auto-backup', HTMLInputElement),
  autoBackupInterval: requireElement('#auto-backup-interval', HTMLInputElement),
  closePopup: requireElement('#close-popup', HTMLInputElement),
  sessionsCount: requireElement('#sessions-count', HTMLSpanElement),
  sessionsEmpty: requireElement('#sessions-empty', HTMLParagraphElement),
  sessionList: requireElement('#session-list', HTMLUListElement),
  exportButton: requireElement('#export', HTMLButtonElement),
  importFile: requireElement('#import-file', HTMLInputElement),
  clearAll: requireElement('#clear-all', HTMLButtonElement),
};

/** @type {OptionsState | null} */
let state = null;
let busy = false;

/**
 * @param {string} message
 * @param {'info' | 'success' | 'error'} [tone]
 * @returns {void}
 */
function setStatus(message, tone = 'info') {
  dom.status.textContent = message;
  dom.status.classList.toggle('status--error', tone === 'error');
  dom.status.classList.toggle('status--success', tone === 'success');
}

/**
 * @param {SessionSummary} session
 * @param {number} now
 * @returns {HTMLLIElement}
 */
function renderSession(session, now) {
  const age = formatRelativeTime(session.createdAt, now);
  const counts = formatCounts(session.groupCount, session.tabCount);

  const groups = el('ul', { className: 'session__groups' });
  for (const group of session.groups) {
    groups.append(
      el('li', {
        className: 'session__group',
        children: [
          el('span', { className: 'swatch', attrs: { 'data-color': group.color } }),
          el('span', { text: group.title || 'Untitled group' }),
          el('span', { text: `· ${group.tabCount}` }),
        ],
      }),
    );
  }

  const restore = el('button', {
    className: 'button button--small button--success',
    text: 'Restore',
    attrs: { type: 'button', 'aria-label': `Restore session from ${age} (${counts})` },
  });
  restore.addEventListener('click', () => {
    void runAction(
      () => request(MESSAGE_TYPES.RESTORE_SESSION, { sessionId: session.id }),
      (result) =>
        formatRestoreResult(
          /** @type {{ restoredGroups: number, restoredTabs: number, failures: string[] }} */ (
            result
          ),
        ),
    );
  });

  const remove = el('button', {
    className: 'button button--small button--danger',
    text: 'Delete',
    attrs: { type: 'button', 'aria-label': `Delete session from ${age} (${counts})` },
  });
  remove.addEventListener('click', () => {
    armConfirmButton(remove, 'Confirm delete', () => {
      void runAction(
        () => request(MESSAGE_TYPES.DELETE_SESSION, { sessionId: session.id }),
        () => 'Session deleted.',
      );
    });
  });

  return el('li', {
    className: 'session',
    children: [
      el('div', {
        className: 'session__body',
        children: [
          el('div', {
            className: 'session__meta',
            children: [
              el('span', { text: age }),
              el('span', { className: 'session__badge', text: formatSource(session.source) }),
            ],
          }),
          el('div', { className: 'session__detail', text: counts }),
          groups,
        ],
      }),
      el('div', { className: 'session__actions', children: [restore, remove] }),
    ],
  });
}

/**
 * @returns {void}
 */
function render() {
  if (state === null) {
    return;
  }
  dom.unsupported.hidden = state.supported;
  dom.scopeWindow.checked = state.settings.scope === 'window';
  dom.scopeAll.checked = state.settings.scope === 'all';
  dom.autoBackup.checked = state.settings.autoBackup;
  dom.autoBackupInterval.value = String(state.settings.autoBackupIntervalMinutes);
  dom.autoBackupInterval.disabled = !state.settings.autoBackup;
  dom.closePopup.checked = state.settings.closePopupAfterAction;

  const now = Date.now();
  clearChildren(dom.sessionList);
  for (const session of state.sessions) {
    dom.sessionList.append(renderSession(session, now));
  }
  dom.sessionsEmpty.hidden = state.sessions.length > 0;
  dom.sessionsCount.textContent =
    state.sessions.length > 0 ? pluralize(state.sessions.length, 'session', 'sessions') : '';
  dom.clearAll.disabled = busy || state.sessions.length === 0;
  dom.exportButton.disabled = busy || state.sessions.length === 0;
}

/**
 * @returns {Promise<void>}
 */
async function refresh() {
  state = /** @type {OptionsState} */ (await request(MESSAGE_TYPES.GET_STATE));
  render();
}

/**
 * @param {() => Promise<unknown>} action
 * @param {(result: unknown) => string} describe
 * @returns {Promise<void>}
 */
async function runAction(action, describe) {
  if (busy) {
    return;
  }
  busy = true;
  setStatus('Working…');
  try {
    const result = await action();
    await refresh();
    setStatus(describe(result), 'success');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Something went wrong.', 'error');
  } finally {
    busy = false;
    render();
  }
}

/**
 * @param {Partial<Settings>} patch
 * @returns {Promise<void>}
 */
async function saveSettings(patch) {
  try {
    await request(MESSAGE_TYPES.UPDATE_SETTINGS, { settings: patch });
    await refresh();
    setStatus('Settings saved.', 'success');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Could not save settings.', 'error');
  }
}

dom.scopeWindow.addEventListener('change', () => {
  if (dom.scopeWindow.checked) {
    void saveSettings({ scope: 'window' });
  }
});

dom.scopeAll.addEventListener('change', () => {
  if (dom.scopeAll.checked) {
    void saveSettings({ scope: 'all' });
  }
});

dom.autoBackup.addEventListener('change', () => {
  void saveSettings({ autoBackup: dom.autoBackup.checked });
});

dom.closePopup.addEventListener('change', () => {
  void saveSettings({ closePopupAfterAction: dom.closePopup.checked });
});

dom.autoBackupInterval.addEventListener('change', () => {
  const parsed = Number.parseInt(dom.autoBackupInterval.value, 10);
  if (!Number.isFinite(parsed)) {
    render();
    return;
  }
  const clamped = Math.min(
    AUTO_BACKUP_INTERVAL_BOUNDS.MAX,
    Math.max(AUTO_BACKUP_INTERVAL_BOUNDS.MIN, parsed),
  );
  void saveSettings({ autoBackupIntervalMinutes: clamped });
});

dom.exportButton.addEventListener('click', () => {
  void (async () => {
    try {
      const result = /** @type {{ text: string, sessionCount: number }} */ (
        await request(MESSAGE_TYPES.EXPORT_SESSIONS)
      );
      const blob = new Blob([result.text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = el('a', {
        attrs: {
          href: url,
          download: `manage-tabgroups-${formatFileTimestamp(Date.now())}.json`,
        },
      });
      document.body.append(link);
      link.click();
      link.remove();
      globalThis.setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 30_000);
      setStatus(`Exported ${pluralize(result.sessionCount, 'session', 'sessions')}.`, 'success');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Export failed.', 'error');
    }
  })();
});

dom.importFile.addEventListener('change', () => {
  const file = dom.importFile.files?.[0];
  dom.importFile.value = '';
  if (!file) {
    return;
  }
  if (file.size > LIMITS.MAX_IMPORT_BYTES) {
    setStatus('That file is larger than the 8 MB import limit.', 'error');
    return;
  }
  void runAction(
    async () => request(MESSAGE_TYPES.IMPORT_SESSIONS, { text: await file.text() }),
    (result) =>
      formatImportResult(
        /** @type {{ imported: number, rejected: number, evicted: number }} */ (result),
      ),
  );
});

dom.clearAll.addEventListener('click', () => {
  armConfirmButton(dom.clearAll, 'Confirm: delete everything', () => {
    void runAction(
      () => request(MESSAGE_TYPES.CLEAR_SESSIONS),
      () => 'All saved sessions deleted.',
    );
  });
});

void (async () => {
  dom.version.textContent = chrome.runtime.getManifest().version;
  try {
    await refresh();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Could not load settings.', 'error');
  }
})();
