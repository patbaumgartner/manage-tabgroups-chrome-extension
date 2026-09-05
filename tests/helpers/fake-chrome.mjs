/**
 * A small in-memory stand-in for the parts of the `chrome.*` API this extension
 * uses.
 *
 * It mirrors the behaviour that matters for the tests, including the one that is
 * easy to forget: Chrome closes a window once its last tab is removed.
 */

/**
 * @typedef {object} FakeTab
 * @property {number} id
 * @property {number} windowId
 * @property {number} groupId
 * @property {number} index
 * @property {string} url
 * @property {string} title
 * @property {boolean} active
 */

/**
 * @typedef {object} FakeGroup
 * @property {number} id
 * @property {number} windowId
 * @property {string} title
 * @property {string} color
 * @property {boolean} collapsed
 */

/**
 * @typedef {object} FakeWindow
 * @property {number} id
 * @property {string} type
 */

/**
 * @typedef {object} GroupSpec
 * @property {string} [title]
 * @property {string} [color]
 * @property {boolean} [collapsed]
 * @property {{ url: string, title?: string }[]} tabs
 */

/**
 * @typedef {object} WindowSpec
 * @property {string} [type]
 * @property {GroupSpec[]} [groups]
 * @property {{ url: string, title?: string }[]} [looseTabs]
 */

/**
 * @typedef {object} FakeSpec
 * @property {WindowSpec[]} [windows]
 * @property {number} [quotaBytes]
 * @property {string} [manifestVersion]
 */

const TAB_GROUP_ID_NONE = -1;

/**
 * @param {readonly WindowSpec[]} windowSpecs
 * @returns {{ windows: FakeWindow[], tabs: FakeTab[], groups: FakeGroup[],
 *   nextWindowId: number, nextTabId: number, nextGroupId: number }}
 */
function seedState(windowSpecs) {
  /** @type {FakeWindow[]} */
  const windows = [];
  /** @type {FakeTab[]} */
  const tabs = [];
  /** @type {FakeGroup[]} */
  const groups = [];
  const state = { windows, tabs, groups, nextWindowId: 1, nextTabId: 1, nextGroupId: 100 };

  for (const windowSpec of windowSpecs) {
    const windowId = state.nextWindowId;
    state.nextWindowId += 1;
    windows.push({ id: windowId, type: windowSpec.type ?? 'normal' });

    /**
     * @param {{ url: string, title?: string }} tabSpec
     * @param {number} groupId
     * @returns {void}
     */
    const addTab = (tabSpec, groupId) => {
      tabs.push({
        id: state.nextTabId,
        windowId,
        groupId,
        index: tabs.filter((tab) => tab.windowId === windowId).length,
        url: tabSpec.url,
        title: tabSpec.title ?? tabSpec.url,
        active: false,
      });
      state.nextTabId += 1;
    };

    for (const groupSpec of windowSpec.groups ?? []) {
      const groupId = state.nextGroupId;
      state.nextGroupId += 1;
      groups.push({
        id: groupId,
        windowId,
        title: groupSpec.title ?? '',
        color: groupSpec.color ?? 'grey',
        collapsed: groupSpec.collapsed ?? false,
      });
      for (const tabSpec of groupSpec.tabs) {
        addTab(tabSpec, groupId);
      }
    }
    for (const tabSpec of windowSpec.looseTabs ?? []) {
      addTab(tabSpec, TAB_GROUP_ID_NONE);
    }
  }

  return state;
}

/**
 * @param {FakeSpec} [spec]
 */
export function createFakeChrome(spec = {}) {
  const state = seedState(spec.windows ?? []);
  const { windows, tabs, groups } = state;

  /** @type {Record<string, unknown>} */
  let storage = {};
  /** @type {Map<string, { periodInMinutes?: number, delayInMinutes?: number }>} */
  const alarms = new Map();
  const badge = { text: '', color: '' };

  /**
   * @param {number} windowId
   * @returns {FakeTab[]}
   */
  const windowTabs = (windowId) =>
    tabs.filter((tab) => tab.windowId === windowId).sort((a, b) => a.index - b.index);

  /** @returns {void} */
  const dropEmptyWindowsAndGroups = () => {
    for (const window of [...windows]) {
      const remaining = windowTabs(window.id);
      if (remaining.length === 0) {
        windows.splice(windows.indexOf(window), 1);
        continue;
      }
      remaining.forEach((tab, index) => {
        tab.index = index;
      });
    }
    for (const group of [...groups]) {
      const orphaned =
        !tabs.some((tab) => tab.groupId === group.id) ||
        !windows.some((window) => window.id === group.windowId);
      if (orphaned) {
        groups.splice(groups.indexOf(group), 1);
      }
    }
  };

  const api = {
    runtime: {
      id: 'fake-extension-id',
      /** @returns {{ version: string }} */
      getManifest: () => ({ version: spec.manifestVersion ?? '1.0.0' }),
      /**
       * @param {string} path
       * @returns {string}
       */
      getURL: (path) => `chrome-extension://fake-extension-id/${path}`,
    },

    storage: {
      local: {
        /**
         * @param {string | string[] | null} [keys]
         * @returns {Promise<Record<string, unknown>>}
         */
        get(keys) {
          if (keys === undefined || keys === null) {
            return Promise.resolve(structuredClone(storage));
          }
          /** @type {Record<string, unknown>} */
          const result = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            if (key in storage) {
              result[key] = structuredClone(storage[key]);
            }
          }
          return Promise.resolve(result);
        },
        /**
         * @param {Record<string, unknown>} items
         * @returns {Promise<void>}
         */
        set(items) {
          const next = { ...storage, ...structuredClone(items) };
          const size = new TextEncoder().encode(JSON.stringify(next)).length;
          if (spec.quotaBytes !== undefined && size > spec.quotaBytes) {
            return Promise.reject(new Error('QUOTA_BYTES quota exceeded'));
          }
          storage = next;
          return Promise.resolve();
        },
        /** @returns {Promise<void>} */
        clear() {
          storage = {};
          return Promise.resolve();
        },
      },
    },

    tabs: {
      /**
       * @param {{ windowId?: number }} [query]
       * @returns {Promise<FakeTab[]>}
       */
      query(query = {}) {
        const matching =
          query.windowId === undefined
            ? [...tabs]
            : tabs.filter((tab) => tab.windowId === query.windowId);
        return Promise.resolve(structuredClone(matching.sort((a, b) => a.index - b.index)));
      },
      /**
       * @param {{ windowId?: number, url?: string, active?: boolean }} props
       * @returns {Promise<FakeTab>}
       */
      create(props) {
        const windowId = props.windowId ?? windows[0]?.id;
        if (windowId === undefined || !windows.some((window) => window.id === windowId)) {
          return Promise.reject(new Error('No window with that id.'));
        }
        if (props.url !== undefined && !/^https?:\/\//.test(props.url)) {
          return Promise.reject(new Error(`Cannot create a tab for URL: ${props.url}`));
        }
        /** @type {FakeTab} */
        const tab = {
          id: state.nextTabId,
          windowId,
          groupId: TAB_GROUP_ID_NONE,
          index: windowTabs(windowId).length,
          url: props.url ?? 'chrome://newtab/',
          title: props.url ?? 'New Tab',
          active: props.active ?? true,
        };
        state.nextTabId += 1;
        tabs.push(tab);
        return Promise.resolve(structuredClone(tab));
      },
      /**
       * @param {number | number[]} tabIds
       * @returns {Promise<void>}
       */
      remove(tabIds) {
        for (const id of new Set(Array.isArray(tabIds) ? tabIds : [tabIds])) {
          const index = tabs.findIndex((tab) => tab.id === id);
          if (index === -1) {
            return Promise.reject(new Error(`No tab with id: ${id}`));
          }
          tabs.splice(index, 1);
        }
        dropEmptyWindowsAndGroups();
        return Promise.resolve();
      },
      /**
       * @param {{ tabIds: number | number[], createProperties?: { windowId?: number } }} options
       * @returns {Promise<number>}
       */
      group(options) {
        const ids = Array.isArray(options.tabIds) ? options.tabIds : [options.tabIds];
        const members = tabs.filter((tab) => ids.includes(tab.id));
        const windowId = options.createProperties?.windowId ?? members[0]?.windowId;
        if (members.length === 0 || windowId === undefined) {
          return Promise.reject(new Error('No tabs to group.'));
        }
        const groupId = state.nextGroupId;
        state.nextGroupId += 1;
        groups.push({ id: groupId, windowId, title: '', color: 'grey', collapsed: false });
        for (const tab of members) {
          tab.groupId = groupId;
        }
        return Promise.resolve(groupId);
      },
    },

    tabGroups: {
      TAB_GROUP_ID_NONE,
      /**
       * @param {{ windowId?: number }} [query]
       * @returns {Promise<FakeGroup[]>}
       */
      query(query = {}) {
        const matching =
          query.windowId === undefined
            ? [...groups]
            : groups.filter((group) => group.windowId === query.windowId);
        return Promise.resolve(structuredClone(matching));
      },
      /**
       * @param {number} groupId
       * @param {{ title?: string, color?: string, collapsed?: boolean }} props
       * @returns {Promise<FakeGroup>}
       */
      update(groupId, props) {
        const group = groups.find((entry) => entry.id === groupId);
        if (!group) {
          return Promise.reject(new Error(`No group with id: ${groupId}`));
        }
        group.title = props.title ?? group.title;
        group.color = props.color ?? group.color;
        group.collapsed = props.collapsed ?? group.collapsed;
        return Promise.resolve(structuredClone(group));
      },
    },

    windows: {
      /**
       * @param {number} windowId
       * @returns {Promise<FakeWindow>}
       */
      get(windowId) {
        const window = windows.find((entry) => entry.id === windowId);
        return window
          ? Promise.resolve({ ...window })
          : Promise.reject(new Error(`No window with id: ${windowId}`));
      },
      /** @returns {Promise<FakeWindow>} */
      getLastFocused() {
        const window = windows.find((entry) => entry.type === 'normal');
        return window
          ? Promise.resolve({ ...window })
          : Promise.reject(new Error('No normal window.'));
      },
      /** @returns {Promise<FakeWindow>} */
      getCurrent() {
        return api.windows.getLastFocused();
      },
      /** @returns {Promise<FakeWindow>} */
      create() {
        const windowId = state.nextWindowId;
        state.nextWindowId += 1;
        windows.push({ id: windowId, type: 'normal' });
        tabs.push({
          id: state.nextTabId,
          windowId,
          groupId: TAB_GROUP_ID_NONE,
          index: 0,
          url: 'chrome://newtab/',
          title: 'New Tab',
          active: true,
        });
        state.nextTabId += 1;
        return Promise.resolve({ id: windowId, type: 'normal' });
      },
    },

    alarms: {
      /**
       * @param {string} name
       * @param {{ periodInMinutes?: number, delayInMinutes?: number }} info
       * @returns {Promise<void>}
       */
      create(name, info) {
        alarms.set(name, info);
        return Promise.resolve();
      },
      /**
       * @param {string} name
       * @returns {Promise<boolean>}
       */
      clear(name) {
        return Promise.resolve(alarms.delete(name));
      },
      onAlarm: { addListener: () => {} },
    },

    action: {
      /**
       * @param {{ text: string }} details
       * @returns {Promise<void>}
       */
      setBadgeText(details) {
        badge.text = details.text;
        return Promise.resolve();
      },
      /**
       * @param {{ color: string }} details
       * @returns {Promise<void>}
       */
      setBadgeBackgroundColor(details) {
        badge.color = details.color;
        return Promise.resolve();
      },
    },

    _state: {
      get windows() {
        return structuredClone(windows);
      },
      get tabs() {
        return structuredClone(tabs);
      },
      get groups() {
        return structuredClone(groups);
      },
      get storage() {
        return structuredClone(storage);
      },
      get alarms() {
        return new Map(alarms);
      },
      get badge() {
        return { ...badge };
      },
      /**
       * @param {Record<string, unknown>} value
       * @returns {void}
       */
      seedStorage(value) {
        storage = structuredClone(value);
      },
    },
  };

  return api;
}

/**
 * Install a fake chrome API on `globalThis` and return it.
 *
 * @param {FakeSpec} [spec]
 * @returns {ReturnType<typeof createFakeChrome>}
 */
export function installFakeChrome(spec = {}) {
  const fake = createFakeChrome(spec);
  // @ts-expect-error - the fake intentionally implements only what is used.
  globalThis.chrome = fake;
  return fake;
}

/**
 * @returns {void}
 */
export function uninstallFakeChrome() {
  // @ts-expect-error - removing the test double again.
  globalThis.chrome = undefined;
}
