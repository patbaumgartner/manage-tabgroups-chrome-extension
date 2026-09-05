import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  closeSavedTabs,
  collectLiveGroups,
  describeError,
  isTabGroupsSupported,
  resolveWindowId,
  restoreSession,
  summarizeLiveGroups,
} from '../extension/src/tabgroups.js';
import { installFakeChrome, uninstallFakeChrome } from './helpers/fake-chrome.mjs';

/**
 * @param {Partial<import('../extension/src/model.js').Session>} [overrides]
 * @returns {import('../extension/src/model.js').Session}
 */
function makeSession(overrides = {}) {
  return {
    id: 's1',
    createdAt: 1_700_000_000_000,
    source: 'manual',
    groups: [
      {
        title: 'Work',
        color: 'blue',
        collapsed: true,
        tabs: [
          { url: 'https://a.example/', title: 'A' },
          { url: 'https://b.example/', title: 'B' },
        ],
      },
    ],
    ...overrides,
  };
}

describe('capability detection', () => {
  afterEach(uninstallFakeChrome);

  it('detects a browser with tab groups', () => {
    installFakeChrome();
    assert.equal(isTabGroupsSupported(), true);
  });

  it('detects a browser without tab groups', () => {
    const fake = installFakeChrome();
    // @ts-expect-error - simulating a Chromium fork that lacks the API
    fake.tabGroups = undefined;
    assert.equal(isTabGroupsSupported(), false);
  });
});

describe('describeError', () => {
  it('prefers a real message and never returns an empty string', () => {
    assert.equal(describeError(new Error('boom')), 'boom');
    assert.equal(describeError('plain'), 'plain');
    assert.equal(describeError(new Error('')), 'Unknown error');
    assert.equal(describeError(undefined), 'Unknown error');
    assert.equal(describeError({}), 'Unknown error');
  });
});

describe('resolveWindowId', () => {
  afterEach(uninstallFakeChrome);

  it('uses the requested window when it exists', async () => {
    installFakeChrome({ windows: [{ looseTabs: [{ url: 'https://a/' }] }] });
    assert.equal(await resolveWindowId(1), 1);
  });

  it('falls back to the focused window for an unknown id', async () => {
    installFakeChrome({ windows: [{ looseTabs: [{ url: 'https://a/' }] }] });
    assert.equal(await resolveWindowId(9999), 1);
  });

  it('never targets a popup window', async () => {
    installFakeChrome({
      windows: [
        { type: 'popup', looseTabs: [{ url: 'https://p/' }] },
        { looseTabs: [{ url: 'https://a/' }] },
      ],
    });
    assert.equal(await resolveWindowId(1), 2);
  });

  it('creates a window when none is open', async () => {
    const fake = installFakeChrome();
    const windowId = await resolveWindowId();
    assert.equal(typeof windowId, 'number');
    assert.equal(fake._state.windows.length, 1);
  });
});

describe('collectLiveGroups', () => {
  afterEach(uninstallFakeChrome);

  it('limits the collection to one window by default', async () => {
    installFakeChrome({
      windows: [
        { groups: [{ title: 'W1', tabs: [{ url: 'https://a/' }] }] },
        { groups: [{ title: 'W2', tabs: [{ url: 'https://b/' }] }] },
      ],
    });
    const scoped = await collectLiveGroups({ windowId: 1 });
    assert.deepEqual(
      scoped.groups.map((group) => group.title),
      ['W1'],
    );

    const all = await collectLiveGroups({ scope: 'all' });
    assert.deepEqual(
      all.groups.map((group) => group.title),
      ['W1', 'W2'],
    );
    assert.equal(all.windowId, null);
  });

  it('counts only tabs that belong to a group', async () => {
    installFakeChrome({
      windows: [
        {
          groups: [{ title: 'W1', tabs: [{ url: 'https://a/' }, { url: 'https://b/' }] }],
          looseTabs: [{ url: 'https://loose/' }],
        },
      ],
    });
    assert.deepEqual(await summarizeLiveGroups({ windowId: 1 }), { groupCount: 1, tabCount: 2 });
  });
});

describe('closeSavedTabs', () => {
  afterEach(uninstallFakeChrome);

  /**
   * @param {ReturnType<typeof installFakeChrome>} fake
   * @param {(tab: { groupId: number }) => boolean} [filter]
   * @returns {import('../extension/src/model.js').SavedTab[]}
   */
  const saved = (fake, filter = () => true) =>
    fake._state.tabs.filter(filter).map((tab) => ({ id: tab.id, url: tab.url }));

  it('does nothing for an empty list', async () => {
    const fake = installFakeChrome({ windows: [{ looseTabs: [{ url: 'https://a/' }] }] });
    assert.deepEqual(await closeSavedTabs([]), {
      closed: 0,
      changed: 0,
      placeholdersOpened: 0,
    });
    assert.equal(fake._state.tabs.length, 1);
  });

  it('keeps a window alive when every one of its tabs is being closed', async () => {
    const fake = installFakeChrome({
      windows: [
        {
          groups: [{ title: 'Only', tabs: [{ url: 'https://a/' }, { url: 'https://b/' }] }],
        },
      ],
    });
    const result = await closeSavedTabs(saved(fake));

    assert.equal(result.closed, 2);
    assert.equal(result.placeholdersOpened, 1);
    assert.equal(fake._state.windows.length, 1, 'the window must survive');
    assert.equal(fake._state.tabs.length, 1, 'a placeholder new tab remains');
  });

  it('opens no placeholder when other tabs remain', async () => {
    const fake = installFakeChrome({
      windows: [
        {
          groups: [{ title: 'Only', tabs: [{ url: 'https://a/' }] }],
          looseTabs: [{ url: 'https://keep/' }],
        },
      ],
    });
    const result = await closeSavedTabs(saved(fake, (tab) => tab.groupId !== -1));

    assert.equal(result.placeholdersOpened, 0);
    assert.deepEqual(
      fake._state.tabs.map((tab) => tab.url),
      ['https://keep/'],
    );
  });

  it('protects several windows at once', async () => {
    const fake = installFakeChrome({
      windows: [
        { groups: [{ title: 'A', tabs: [{ url: 'https://a/' }] }] },
        { groups: [{ title: 'B', tabs: [{ url: 'https://b/' }] }] },
      ],
    });
    const result = await closeSavedTabs(saved(fake));
    assert.equal(result.placeholdersOpened, 2);
    assert.equal(fake._state.windows.length, 2);
  });

  it('leaves a tab open when it navigated after being saved', async () => {
    const fake = installFakeChrome({
      windows: [
        {
          groups: [{ title: 'Work', tabs: [{ url: 'https://a/' }, { url: 'https://b/' }] }],
          looseTabs: [{ url: 'https://keep/' }],
        },
      ],
    });
    const savedTabs = saved(fake, (tab) => tab.groupId !== -1);
    const navigated = savedTabs[1];
    assert.ok(navigated);
    fake.tabs.query = () =>
      Promise.resolve(
        fake._state.tabs.map((tab) =>
          tab.id === navigated.id ? { ...tab, url: 'https://somewhere-else/' } : tab,
        ),
      );

    const result = await closeSavedTabs(savedTabs);

    assert.equal(result.closed, 1);
    assert.equal(result.changed, 1);
    assert.ok(
      fake._state.tabs.some((tab) => tab.id === navigated.id),
      'the navigated tab must survive because its new address was never saved',
    );
  });

  it('ignores a saved tab that has already been closed', async () => {
    const fake = installFakeChrome({
      windows: [
        {
          groups: [{ title: 'Work', tabs: [{ url: 'https://a/' }] }],
          looseTabs: [{ url: 'https://keep/' }],
        },
      ],
    });
    const savedTabs = [
      ...saved(fake, (tab) => tab.groupId !== -1),
      { id: 4242, url: 'https://x/' },
    ];
    const result = await closeSavedTabs(savedTabs);

    assert.equal(result.closed, 1);
    assert.deepEqual(
      fake._state.tabs.map((tab) => tab.url),
      ['https://keep/'],
    );
  });
});

describe('restoreSession', () => {
  afterEach(uninstallFakeChrome);

  it('recreates the tabs, the group name, colour and collapsed state', async () => {
    const fake = installFakeChrome({ windows: [{ looseTabs: [{ url: 'https://home/' }] }] });
    const result = await restoreSession(makeSession(), { windowId: 1 });

    assert.deepEqual(result, { restoredGroups: 1, restoredTabs: 2, failures: [] });
    const group = fake._state.groups[0];
    assert.equal(group?.title, 'Work');
    assert.equal(group?.color, 'blue');
    assert.equal(group?.collapsed, true);
    const restored = fake._state.tabs.filter((tab) => tab.groupId === group?.id);
    assert.deepEqual(
      restored.map((tab) => tab.url),
      ['https://a.example/', 'https://b.example/'],
    );
  });

  it('refuses to open a URL that was tampered with after validation', async () => {
    const fake = installFakeChrome({ windows: [{ looseTabs: [{ url: 'https://home/' }] }] });
    const session = makeSession({
      groups: [
        {
          title: 'Mixed',
          color: 'red',
          collapsed: false,
          tabs: [
            { url: 'javascript:alert(1)', title: 'evil' },
            { url: 'https://good.example/', title: 'good' },
          ],
        },
      ],
    });

    const result = await restoreSession(session, { windowId: 1 });
    assert.equal(result.restoredTabs, 1);
    assert.equal(result.failures.length, 1);
    assert.ok(!fake._state.tabs.some((tab) => tab.url.startsWith('javascript:')));
  });

  it('normalises an unknown colour rather than failing the restore', async () => {
    const fake = installFakeChrome({ windows: [{ looseTabs: [{ url: 'https://home/' }] }] });
    const session = makeSession({
      groups: [
        {
          title: 'Odd',
          color: 'ultraviolet',
          collapsed: false,
          tabs: [{ url: 'https://a.example/', title: 'A' }],
        },
      ],
    });
    const result = await restoreSession(session, { windowId: 1 });
    assert.equal(result.restoredGroups, 1);
    assert.equal(fake._state.groups[0]?.color, 'grey');
  });

  it('reports a tab that the browser refuses to open and keeps going', async () => {
    const fake = installFakeChrome({ windows: [{ looseTabs: [{ url: 'https://home/' }] }] });
    const create = fake.tabs.create.bind(fake.tabs);
    let calls = 0;
    fake.tabs.create = (props) => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('tab limit reached')) : create(props);
    };

    const result = await restoreSession(makeSession(), { windowId: 1 });
    assert.equal(result.restoredTabs, 1);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0] ?? '', /tab limit reached/);
  });

  it('keeps restored tabs even if the group cannot be recreated', async () => {
    const fake = installFakeChrome({ windows: [{ looseTabs: [{ url: 'https://home/' }] }] });
    fake.tabs.group = () => Promise.reject(new Error('grouping unavailable'));

    const result = await restoreSession(makeSession(), { windowId: 1 });
    assert.equal(result.restoredGroups, 0);
    assert.equal(result.restoredTabs, 2);
    assert.match(result.failures[0] ?? '', /could not recreate the group/);
    assert.equal(fake._state.tabs.length, 3);
  });
});

describe('closeSavedTabs when the browser rejects the batch', () => {
  afterEach(uninstallFakeChrome);

  it('counts what actually closed instead of reporting a total failure', async () => {
    const fake = installFakeChrome({
      windows: [
        {
          groups: [{ title: 'Work', tabs: [{ url: 'https://a/' }, { url: 'https://b/' }] }],
          looseTabs: [{ url: 'https://keep/' }],
        },
      ],
    });
    const savedTabs = fake._state.tabs
      .filter((tab) => tab.groupId !== -1)
      .map((tab) => ({ id: tab.id, url: tab.url }));
    const realRemove = fake.tabs.remove.bind(fake.tabs);
    // Chrome removes the valid tabs and only then rejects; the caller must not
    // conclude that nothing happened.
    fake.tabs.remove = async (ids) => {
      await realRemove(ids);
      throw new Error('No tab with id: 999');
    };

    const result = await closeSavedTabs(savedTabs);

    assert.equal(result.closed, 2);
    assert.deepEqual(
      fake._state.tabs.map((tab) => tab.url),
      ['https://keep/'],
    );
  });
});

describe('closeSavedTabs while a tab is still loading', () => {
  afterEach(uninstallFakeChrome);

  it('closes a tab that has not committed its navigation yet', async () => {
    const fake = installFakeChrome({
      windows: [
        {
          groups: [{ title: 'Work', tabs: [{ url: 'https://a/' }, { url: 'https://b/' }] }],
          looseTabs: [{ url: 'https://keep/' }],
        },
      ],
    });
    const savedTabs = fake._state.tabs
      .filter((tab) => tab.groupId !== -1)
      .map((tab) => ({ id: tab.id, url: tab.url }));
    const stillLoading = savedTabs[1];
    assert.ok(stillLoading);
    // Chrome reports an empty `url` and puts the target in `pendingUrl` until the
    // navigation commits. That must not read as "this tab navigated away".
    fake.tabs.query = () =>
      Promise.resolve(
        fake._state.tabs.map((tab) =>
          tab.id === stillLoading.id ? { ...tab, url: '', pendingUrl: tab.url } : tab,
        ),
      );

    const result = await closeSavedTabs(savedTabs);

    assert.equal(result.changed, 0, 'a loading tab has not changed');
    assert.equal(result.closed, 2);
    assert.deepEqual(
      fake._state.tabs.map((tab) => tab.url),
      ['https://keep/'],
    );
  });
});
