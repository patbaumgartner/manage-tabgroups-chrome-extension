/**
 * Thin, defensive wrappers around `chrome.tabs`, `chrome.tabGroups` and
 * `chrome.windows`.
 *
 * Two invariants are enforced here:
 *
 * 1. **Save before close.** Only tabs that were successfully written into a
 *    session are ever closed, so a tab the extension cannot represent (a
 *    `chrome://` page, for example) survives the operation.
 * 2. **Never close a window by accident.** If closing a group would empty a
 *    window, a fresh new-tab page is opened in it first.
 */

import { normalizeColor, normalizeUrl } from './model.js';

/**
 * @typedef {import('./model.js').Session} Session
 * @typedef {import('./model.js').RawGroupLike} RawGroupLike
 * @typedef {import('./model.js').RawTabLike} RawTabLike
 */

/** `chrome.tabGroups.TAB_GROUP_ID_NONE` without depending on the API being present. */
const TAB_GROUP_ID_NONE = -1;

/**
 * @returns {boolean} Whether this browser exposes the tab groups API.
 */
export function isTabGroupsSupported() {
  return (
    typeof chrome !== 'undefined' &&
    typeof chrome.tabGroups?.query === 'function' &&
    typeof chrome.tabs?.group === 'function'
  );
}

/**
 * @param {unknown} error
 * @returns {string}
 */
export function describeError(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return typeof error === 'string' && error.length > 0 ? error : 'Unknown error';
}

/**
 * Resolve a normal browser window to act on, creating one only as a last resort.
 *
 * @param {number} [preferredWindowId]
 * @returns {Promise<number>}
 */
export async function resolveWindowId(preferredWindowId) {
  if (typeof preferredWindowId === 'number' && preferredWindowId >= 0) {
    try {
      const window = await chrome.windows.get(preferredWindowId);
      if (window.type === 'normal' && typeof window.id === 'number') {
        return window.id;
      }
    } catch {
      // Fall through to the focused window.
    }
  }
  try {
    const focused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (typeof focused.id === 'number') {
      return focused.id;
    }
  } catch {
    // Fall through to creating a window.
  }
  const created = await chrome.windows.create({ focused: true });
  if (!created || typeof created.id !== 'number') {
    throw new Error('No browser window is available.');
  }
  return created.id;
}

/**
 * Read the live groups and their tabs.
 *
 * @param {object} [options]
 * @param {'window' | 'all'} [options.scope]
 * @param {number} [options.windowId] Window to use when `scope` is `'window'`.
 * @returns {Promise<{ groups: RawGroupLike[], tabs: RawTabLike[], windowId: number | null }>}
 */
export async function collectLiveGroups(options = {}) {
  const scope = options.scope === 'all' ? 'all' : 'window';
  const windowId = scope === 'window' ? await resolveWindowId(options.windowId) : null;

  const groupQuery = windowId === null ? {} : { windowId };
  const groups = await chrome.tabGroups.query(groupQuery);
  const tabs = await chrome.tabs.query(windowId === null ? {} : { windowId });

  return { groups, tabs, windowId };
}

/**
 * Counts for the popup header.
 *
 * @param {object} [options]
 * @param {'window' | 'all'} [options.scope]
 * @param {number} [options.windowId]
 * @returns {Promise<{ groupCount: number, tabCount: number }>}
 */
export async function summarizeLiveGroups(options = {}) {
  const { groups, tabs } = await collectLiveGroups(options);
  const groupIds = new Set(groups.map((group) => group.id));
  let tabCount = 0;
  for (const tab of tabs) {
    if (typeof tab.groupId === 'number' && tab.groupId !== TAB_GROUP_ID_NONE) {
      if (groupIds.has(tab.groupId)) {
        tabCount += 1;
      }
    }
  }
  return { groupCount: groups.length, tabCount };
}

/**
 * Make sure removing `tabIds` cannot close a window.
 *
 * @param {readonly number[]} tabIds
 * @param {readonly RawTabLike[]} allTabs
 * @returns {Promise<number>} How many placeholder tabs were opened.
 */
async function keepWindowsAlive(tabIds, allTabs) {
  const closing = new Set(tabIds);

  /** @type {Map<number, { total: number, closing: number }>} */
  const perWindow = new Map();
  for (const tab of allTabs) {
    if (typeof tab.windowId !== 'number') {
      continue;
    }
    const entry = perWindow.get(tab.windowId) ?? { total: 0, closing: 0 };
    entry.total += 1;
    if (typeof tab.id === 'number' && closing.has(tab.id)) {
      entry.closing += 1;
    }
    perWindow.set(tab.windowId, entry);
  }

  let created = 0;
  for (const [windowId, entry] of perWindow) {
    if (entry.closing > 0 && entry.closing >= entry.total) {
      await chrome.tabs.create({ windowId, active: true });
      created += 1;
    }
  }
  return created;
}

/**
 * Close exactly the tabs that were saved, and only while they still hold the
 * URL that was stored for them.
 *
 * Persisting a session is asynchronous, so a tab can navigate between the
 * snapshot and the close. Re-reading the live URL first means the extension
 * never closes a page it has not actually saved.
 *
 * @param {readonly import('./model.js').SavedTab[]} savedTabs
 * @returns {Promise<{ closed: number, changed: number, placeholdersOpened: number }>}
 */
export async function closeSavedTabs(savedTabs) {
  if (savedTabs.length === 0) {
    return { closed: 0, changed: 0, placeholdersOpened: 0 };
  }

  const allTabs = await chrome.tabs.query({});
  /** @type {Map<number, RawTabLike>} */
  const live = new Map();
  for (const tab of allTabs) {
    if (typeof tab.id === 'number') {
      live.set(tab.id, tab);
    }
  }

  /** @type {number[]} */
  const closable = [];
  let changed = 0;
  for (const saved of savedTabs) {
    const tab = live.get(saved.id);
    if (tab === undefined) {
      continue;
    }
    if (normalizeUrl(tab.url) !== saved.url) {
      changed += 1;
      continue;
    }
    closable.push(saved.id);
  }

  if (closable.length === 0) {
    return { closed: 0, changed, placeholdersOpened: 0 };
  }

  const placeholdersOpened = await keepWindowsAlive(closable, allTabs);
  try {
    await chrome.tabs.remove(closable);
    return { closed: closable.length, changed, placeholdersOpened };
  } catch {
    // Verified on Chrome 152: when a batch contains a tab that has already gone,
    // the call removes the others and *then* rejects. Reporting the error as a
    // total failure would be wrong, so the real outcome is counted instead.
    const remaining = new Set(
      (await chrome.tabs.query({})).map((tab) => tab.id).filter((id) => typeof id === 'number'),
    );
    const closed = closable.filter((id) => !remaining.has(id)).length;
    return { closed, changed, placeholdersOpened };
  }
}

/**
 * Create the tabs of one stored group and group them together.
 *
 * @param {import('./model.js').StoredGroup} group
 * @param {number} windowId
 * @returns {Promise<{ tabCount: number, grouped: boolean, failures: string[] }>}
 */
async function restoreGroup(group, windowId) {
  /** @type {number[]} */
  const createdTabIds = [];
  /** @type {string[]} */
  const failures = [];

  for (const tab of group.tabs) {
    // Defence in depth: re-validate immediately before the value becomes navigation.
    const url = normalizeUrl(tab.url);
    if (url === null) {
      failures.push(`Skipped an unsupported URL in "${group.title || 'Untitled group'}".`);
      continue;
    }
    try {
      const created = await chrome.tabs.create({ windowId, url, active: false });
      if (typeof created.id === 'number') {
        createdTabIds.push(created.id);
      }
    } catch (error) {
      failures.push(`Could not open ${url}: ${describeError(error)}`);
    }
  }

  if (createdTabIds.length === 0) {
    return { tabCount: 0, grouped: false, failures };
  }

  try {
    const groupId = /** @type {number} */ (
      await chrome.tabs.group({
        tabIds: /** @type {[number, ...number[]]} */ (createdTabIds),
        createProperties: { windowId },
      })
    );
    await chrome.tabGroups.update(groupId, {
      title: group.title,
      color: /** @type {chrome.tabGroups.Color} */ (normalizeColor(group.color)),
      collapsed: group.collapsed,
    });
    return { tabCount: createdTabIds.length, grouped: true, failures };
  } catch (error) {
    failures.push(`Restored tabs but could not recreate the group: ${describeError(error)}`);
    return { tabCount: createdTabIds.length, grouped: false, failures };
  }
}

/**
 * Restore every group of a session into one window.
 *
 * @param {Session} session
 * @param {{ windowId?: number }} [options]
 * @returns {Promise<{ restoredGroups: number, restoredTabs: number, failures: string[] }>}
 */
export async function restoreSession(session, options = {}) {
  const windowId = await resolveWindowId(options.windowId);
  let restoredGroups = 0;
  let restoredTabs = 0;
  /** @type {string[]} */
  const failures = [];

  for (const group of session.groups) {
    const result = await restoreGroup(group, windowId);
    restoredTabs += result.tabCount;
    if (result.grouped) {
      restoredGroups += 1;
    }
    failures.push(...result.failures);
  }

  return { restoredGroups, restoredTabs, failures };
}
