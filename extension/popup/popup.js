/** Popup controller. */

import { MESSAGE_TYPES } from '../src/constants.js';
import { armConfirmButton, clearChildren, el, requireElement } from '../src/dom.js';
import {
  formatCloseResult,
  formatCounts,
  formatRelativeTime,
  formatRestoreResult,
  formatSource,
} from '../src/format.js';
import { currentWindowId, request } from '../src/messaging.js';

/**
 * @typedef {import('../src/actions.js').SessionSummary} SessionSummary
 * @typedef {import('../src/settings.js').Settings} Settings
 * @typedef {{ supported: boolean, settings: Settings,
 *   live: { groupCount: number, tabCount: number }, sessions: SessionSummary[] }} PopupState
 */

const dom = {
  unsupported: requireElement('#unsupported', HTMLParagraphElement),
  scopeWindow: requireElement('#scope-window', HTMLButtonElement),
  scopeAll: requireElement('#scope-all', HTMLButtonElement),
  liveSummary: requireElement('#live-summary', HTMLParagraphElement),
  closeAll: requireElement('#close-all', HTMLButtonElement),
  restoreLatest: requireElement('#restore-latest', HTMLButtonElement),
  saveOnly: requireElement('#save-only', HTMLButtonElement),
  status: requireElement('#status', HTMLParagraphElement),
  sessionList: requireElement('#session-list', HTMLUListElement),
  sessionsEmpty: requireElement('#sessions-empty', HTMLParagraphElement),
  openOptions: requireElement('#open-options', HTMLButtonElement),
  openOptionsFooter: requireElement('#open-options-footer', HTMLButtonElement),
};

/** @type {number | undefined} */
let windowId;
/** @type {PopupState | null} */
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
 * @param {boolean} value
 * @returns {void}
 */
function setBusy(value) {
  busy = value;
  const disabled = value || state?.supported === false;
  for (const button of [dom.closeAll, dom.restoreLatest, dom.saveOnly]) {
    button.disabled = disabled;
  }
  dom.scopeWindow.disabled = disabled;
  dom.scopeAll.disabled = disabled;
}

/**
 * @param {SessionSummary} session
 * @param {number} now
 * @returns {HTMLLIElement}
 */
function renderSession(session, now) {
  const age = formatRelativeTime(session.createdAt, now);
  const counts = formatCounts(session.groupCount, session.tabCount);

  const swatches = el('span', { className: 'session__swatches' });
  for (const group of session.groups.slice(0, 8)) {
    swatches.append(
      el('span', {
        className: 'swatch',
        attrs: { 'data-color': group.color, title: group.title || 'Untitled group' },
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
      () => request(MESSAGE_TYPES.RESTORE_SESSION, { sessionId: session.id, windowId }),
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
    armConfirmButton(remove, 'Sure?', () => {
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
          el('div', {
            className: 'session__detail',
            children: [el('span', { text: counts }), swatches],
          }),
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
  const isWindowScope = state.settings.scope === 'window';
  dom.scopeWindow.setAttribute('aria-pressed', String(isWindowScope));
  dom.scopeAll.setAttribute('aria-pressed', String(!isWindowScope));

  dom.liveSummary.textContent = state.supported
    ? `${formatCounts(state.live.groupCount, state.live.tabCount)} in ${
        isWindowScope ? 'this window' : 'all windows'
      }`
    : 'Tab groups are not available in this browser.';

  const now = Date.now();
  clearChildren(dom.sessionList);
  for (const session of state.sessions) {
    dom.sessionList.append(renderSession(session, now));
  }
  dom.sessionsEmpty.hidden = state.sessions.length > 0;
  dom.restoreLatest.disabled = busy || state.sessions.length === 0 || !state.supported;
  dom.closeAll.disabled = busy || !state.supported || state.live.groupCount === 0;
  dom.saveOnly.disabled = dom.closeAll.disabled;
}

/**
 * @returns {Promise<void>}
 */
async function refresh() {
  state = /** @type {PopupState} */ (await request(MESSAGE_TYPES.GET_STATE, { windowId }));
  render();
}

/**
 * Run one action with consistent busy handling, messaging and refresh.
 *
 * @param {() => Promise<unknown>} action
 * @param {(result: unknown) => string} describe
 * @returns {Promise<void>}
 */
async function runAction(action, describe) {
  if (busy) {
    return;
  }
  setBusy(true);
  setStatus('Working…');
  try {
    const result = await action();
    await refresh();
    setStatus(describe(result), 'success');
    if (state?.settings.closePopupAfterAction === true) {
      globalThis.close();
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Something went wrong.', 'error');
    try {
      await refresh();
    } catch {
      // Keep the original error visible.
    }
  } finally {
    setBusy(false);
    render();
  }
}

/**
 * @param {'window' | 'all'} scope
 * @returns {Promise<void>}
 */
async function setScope(scope) {
  if (busy || state?.settings.scope === scope) {
    return;
  }
  setBusy(true);
  try {
    await request(MESSAGE_TYPES.UPDATE_SETTINGS, { settings: { scope } });
    await refresh();
    setStatus('');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Could not change the scope.', 'error');
  } finally {
    setBusy(false);
    render();
  }
}

dom.scopeWindow.addEventListener('click', () => {
  void setScope('window');
});
dom.scopeAll.addEventListener('click', () => {
  void setScope('all');
});

dom.closeAll.addEventListener('click', () => {
  void runAction(
    () => request(MESSAGE_TYPES.CLOSE_ALL_GROUPS, { windowId }),
    (result) => {
      const typed = /** @type {{ saved: SessionSummary, skippedTabs: number,
        changedTabs: number, closedTabs: number }} */ (result);
      return formatCloseResult(typed.saved, typed.skippedTabs, typed.changedTabs, typed.closedTabs);
    },
  );
});

dom.saveOnly.addEventListener('click', () => {
  void runAction(
    () => request(MESSAGE_TYPES.SAVE_GROUPS, { windowId }),
    (result) => {
      const typed = /** @type {{ saved: SessionSummary }} */ (result);
      return `Saved ${formatCounts(typed.saved.groupCount, typed.saved.tabCount)}.`;
    },
  );
});

dom.restoreLatest.addEventListener('click', () => {
  void runAction(
    () => request(MESSAGE_TYPES.RESTORE_SESSION, { windowId }),
    (result) =>
      formatRestoreResult(
        /** @type {{ restoredGroups: number, restoredTabs: number, failures: string[] }} */ (
          result
        ),
      ),
  );
});

for (const button of [dom.openOptions, dom.openOptionsFooter]) {
  button.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
}

void (async () => {
  windowId = await currentWindowId();
  try {
    await refresh();
    setStatus('');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Could not load the extension.', 'error');
  }
})();
