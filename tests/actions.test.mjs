import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

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
} from '../extension/src/actions.js';
import { EXPORT_FORMAT, LIMITS, SCHEMA_VERSION } from '../extension/src/constants.js';
import { readSessions } from '../extension/src/storage.js';
import { installFakeChrome, uninstallFakeChrome } from './helpers/fake-chrome.mjs';

/** A window holding two groups plus one ungrouped tab. */
const TWO_GROUPS = {
  windows: [
    {
      groups: [
        {
          title: 'Work',
          color: 'blue',
          collapsed: false,
          tabs: [
            { url: 'https://work.example/one', title: 'One' },
            { url: 'https://work.example/two', title: 'Two' },
          ],
        },
        {
          title: 'Reading',
          color: 'green',
          collapsed: true,
          tabs: [{ url: 'https://read.example/', title: 'Read' }],
        },
      ],
      looseTabs: [{ url: 'https://loose.example/', title: 'Loose' }],
    },
  ],
};

describe('saveGroups', () => {
  afterEach(uninstallFakeChrome);

  it('stores the open groups without touching any tab', async () => {
    const fake = installFakeChrome(TWO_GROUPS);
    const before = fake._state.tabs.length;

    const result = await saveGroups({ windowId: 1 });

    assert.equal(result.saved.groupCount, 2);
    assert.equal(result.saved.tabCount, 3);
    assert.equal(result.skippedTabs, 0);
    assert.equal(fake._state.tabs.length, before, 'no tab may be closed by a save');
    assert.equal((await readSessions()).length, 1);
  });

  it('reports a clear error when there is nothing to save', async () => {
    installFakeChrome({ windows: [{ looseTabs: [{ url: 'https://only.example/' }] }] });
    await assert.rejects(
      () => saveGroups({ windowId: 1 }),
      /No tab groups are open in this window/,
    );
    await assert.rejects(
      () => saveGroups({ scope: 'all' }),
      /No tab groups are open in any window/,
    );
  });
});

describe('closeAllGroups', () => {
  afterEach(uninstallFakeChrome);

  it('saves first, then closes only the grouped tabs', async () => {
    const fake = installFakeChrome(TWO_GROUPS);

    const result = await closeAllGroups({ windowId: 1 });

    assert.equal(result.saved.groupCount, 2);
    assert.equal(result.closedTabs, 3);
    assert.equal(result.placeholdersOpened, 0);
    assert.deepEqual(
      fake._state.tabs.map((tab) => tab.url),
      ['https://loose.example/'],
      'ungrouped tabs are never touched',
    );
    assert.equal(fake._state.groups.length, 0);

    const stored = await readSessions();
    assert.equal(stored.length, 1);
    assert.deepEqual(
      stored[0]?.groups.map((group) => group.title),
      ['Work', 'Reading'],
    );
  });

  it('closes nothing when the session cannot be stored', async () => {
    const fake = installFakeChrome({ ...TWO_GROUPS, quotaBytes: 50 });

    await assert.rejects(() => closeAllGroups({ windowId: 1 }));

    assert.equal(fake._state.tabs.length, 4, 'every tab must survive a failed save');
    assert.equal(fake._state.groups.length, 2);
  });

  it('leaves tabs open that it could not save', async () => {
    const fake = installFakeChrome({
      windows: [
        {
          groups: [
            {
              title: 'Mixed',
              color: 'blue',
              tabs: [{ url: 'https://ok.example/' }, { url: 'chrome://settings' }],
            },
          ],
        },
      ],
    });

    const result = await closeAllGroups({ windowId: 1 });

    assert.equal(result.closedTabs, 1);
    assert.equal(result.skippedTabs, 1);
    assert.deepEqual(
      fake._state.tabs.map((tab) => tab.url),
      ['chrome://settings'],
    );
  });

  it('keeps the window open when the groups were all it contained', async () => {
    const fake = installFakeChrome({
      windows: [
        { groups: [{ title: 'Only', color: 'blue', tabs: [{ url: 'https://a.example/' }] }] },
      ],
    });

    const result = await closeAllGroups({ windowId: 1 });

    assert.equal(result.placeholdersOpened, 1);
    assert.equal(fake._state.windows.length, 1);
    assert.equal(fake._state.tabs.length, 1);
  });

  it('covers every window when the scope says so', async () => {
    const fake = installFakeChrome({
      windows: [
        { groups: [{ title: 'A', color: 'blue', tabs: [{ url: 'https://a.example/' }] }] },
        { groups: [{ title: 'B', color: 'red', tabs: [{ url: 'https://b.example/' }] }] },
      ],
    });

    const result = await closeAllGroups({ scope: 'all' });

    assert.equal(result.saved.groupCount, 2);
    assert.equal(fake._state.groups.length, 0);
    assert.equal(fake._state.windows.length, 2);
  });
});

describe('restoreStoredSession', () => {
  afterEach(uninstallFakeChrome);

  it('brings back exactly what was closed', async () => {
    const fake = installFakeChrome(TWO_GROUPS);
    await closeAllGroups({ windowId: 1 });

    const result = await restoreStoredSession({ windowId: 1 });

    assert.equal(result.restoredGroups, 2);
    assert.equal(result.restoredTabs, 3);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(
      fake._state.groups.map((group) => [group.title, group.color, group.collapsed]),
      [
        ['Work', 'blue', false],
        ['Reading', 'green', true],
      ],
    );
    assert.deepEqual(
      fake._state.tabs.filter((tab) => tab.groupId !== -1).map((tab) => tab.url),
      ['https://work.example/one', 'https://work.example/two', 'https://read.example/'],
    );
  });

  it('restores the most recent session when no id is given', async () => {
    const fake = installFakeChrome(TWO_GROUPS);
    await saveGroups({ windowId: 1 });
    await closeAllGroups({ windowId: 1 });

    const result = await restoreStoredSession({ windowId: 1 });
    assert.equal(result.restoredGroups, 2);
    assert.equal(fake._state.groups.length, 2);
  });

  it('restores a specific session by id', async () => {
    installFakeChrome(TWO_GROUPS);
    const saved = await saveGroups({ windowId: 1 });

    const result = await restoreStoredSession({ sessionId: saved.saved.id, windowId: 1 });
    assert.equal(result.session.id, saved.saved.id);
  });

  it('explains that there is nothing to restore', async () => {
    installFakeChrome({ windows: [{ looseTabs: [{ url: 'https://a.example/' }] }] });
    await assert.rejects(() => restoreStoredSession(), /nothing saved to restore/);
    await assert.rejects(
      () => restoreStoredSession({ sessionId: 'does-not-exist' }),
      /no longer exists/,
    );
  });
});

describe('runAutoBackup', () => {
  afterEach(uninstallFakeChrome);

  it('stores a snapshot of every window', async () => {
    installFakeChrome(TWO_GROUPS);
    assert.deepEqual(await runAutoBackup(), { stored: true, reason: 'stored' });
    const stored = await readSessions();
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.source, 'auto');
  });

  it('skips a second identical snapshot', async () => {
    installFakeChrome(TWO_GROUPS);
    await runAutoBackup();
    assert.deepEqual(await runAutoBackup(), {
      stored: false,
      reason: 'unchanged since last backup',
    });
    assert.equal((await readSessions()).length, 1);
  });

  it('stores again once the groups actually change', async () => {
    const fake = installFakeChrome(TWO_GROUPS);
    await runAutoBackup();
    await fake.tabs.create({ windowId: 1, url: 'https://new.example/' });
    const created = fake._state.tabs.at(-1);
    assert.ok(created);
    await fake.tabs.group({ tabIds: [created.id], createProperties: { windowId: 1 } });

    assert.equal((await runAutoBackup()).stored, true);
    assert.equal((await readSessions()).length, 2);
  });

  it('does nothing when the user turned it off', async () => {
    installFakeChrome(TWO_GROUPS);
    await updateSettings({ autoBackup: false });
    assert.deepEqual(await runAutoBackup(), { stored: false, reason: 'auto backup disabled' });
  });

  it('does nothing when no groups are open', async () => {
    installFakeChrome({ windows: [{ looseTabs: [{ url: 'https://a.example/' }] }] });
    assert.deepEqual(await runAutoBackup(), { stored: false, reason: 'no tab groups open' });
  });

  it('does nothing on a browser without the tab groups API', async () => {
    const fake = installFakeChrome(TWO_GROUPS);
    // @ts-expect-error - simulating an unsupported Chromium fork
    fake.tabGroups = undefined;
    assert.deepEqual(await runAutoBackup(), { stored: false, reason: 'tab groups unsupported' });
  });
});

describe('getState', () => {
  afterEach(uninstallFakeChrome);

  it('describes the browser, the settings and the saved sessions', async () => {
    installFakeChrome(TWO_GROUPS);
    await saveGroups({ windowId: 1 });

    const state = await getState({ windowId: 1 });

    assert.equal(state.supported, true);
    assert.equal(state.settings.scope, 'window');
    assert.deepEqual(state.live, { groupCount: 2, tabCount: 3 });
    assert.equal(state.sessions.length, 1);
    assert.deepEqual(
      state.sessions[0]?.groups.map((group) => group.title),
      ['Work', 'Reading'],
    );
    assert.equal(state.sessions[0]?.groups[0]?.tabCount, 2);
  });

  it('reports an unsupported browser without throwing', async () => {
    const fake = installFakeChrome(TWO_GROUPS);
    // @ts-expect-error - simulating an unsupported Chromium fork
    fake.tabGroups = undefined;

    const state = await getState({ windowId: 1 });
    assert.equal(state.supported, false);
    assert.deepEqual(state.live, { groupCount: 0, tabCount: 0 });
  });
});

describe('session management', () => {
  afterEach(uninstallFakeChrome);

  it('deletes one and then all sessions', async () => {
    installFakeChrome(TWO_GROUPS);
    const first = await saveGroups({ windowId: 1 });
    await saveGroups({ windowId: 1 });

    const afterDelete = await removeSession(first.saved.id);
    assert.equal(afterDelete.length, 1);
    assert.deepEqual(await removeAllSessions(), []);
  });

  it('round-trips through export and import', async () => {
    installFakeChrome(TWO_GROUPS);
    await saveGroups({ windowId: 1 });

    const exported = await exportSessions('9.9.9');
    assert.match(exported.text, /"appVersion": "9.9.9"/);
    await removeAllSessions();

    const imported = await importSessions(exported.text);
    assert.equal(imported.imported, 1);
    assert.equal(imported.rejected, 0);
    assert.equal(imported.sessions[0]?.source, 'import');
    assert.deepEqual(
      imported.sessions[0]?.groups.map((group) => group.title),
      ['Work', 'Reading'],
    );
  });

  it('rejects a file that is not one of its exports', async () => {
    installFakeChrome(TWO_GROUPS);
    await assert.rejects(
      () => importSessions('{"format":"evil","sessions":[]}'),
      /not exported by/,
    );
    await assert.rejects(() => importSessions('nonsense'), /not valid JSON/);
    await assert.rejects(() => importSessions(undefined), /could not be read as text/);
  });

  it('never imports a session that would restore an unsafe URL', async () => {
    installFakeChrome(TWO_GROUPS);
    const payload = JSON.stringify({
      format: 'manage-tabgroups.sessions',
      sessions: [
        {
          groups: [
            {
              title: 'Evil',
              color: 'red',
              tabs: [{ url: 'javascript:fetch("https://evil.example")' }],
            },
          ],
        },
      ],
    });
    await assert.rejects(() => importSessions(payload), /no restorable session/);
    assert.deepEqual(await readSessions(), []);
  });
});

describe('save-before-close guarantee', () => {
  afterEach(uninstallFakeChrome);

  it('closes nothing when storage accepts the write but keeps nothing', async () => {
    const fake = installFakeChrome(TWO_GROUPS);
    fake.storage.local.set = () => Promise.resolve();

    await assert.rejects(() => closeAllGroups({ windowId: 1 }), /did not keep this session/);
    assert.equal(fake._state.tabs.length, 4, 'every tab must survive');
    assert.equal(fake._state.groups.length, 2);
  });

  it('reports a full store instead of claiming an automatic backup was taken', async () => {
    const fake = installFakeChrome(TWO_GROUPS);
    fake.storage.local.set = () => Promise.resolve();
    assert.deepEqual(await runAutoBackup(), { stored: false, reason: 'storage is full' });
  });

  it('leaves a tab open when it navigated while the session was being written', async () => {
    const fake = installFakeChrome(TWO_GROUPS);
    const realQuery = fake.tabs.query.bind(fake.tabs);
    const realSet = fake.storage.local.set.bind(fake.storage.local);
    fake.storage.local.set = async (items) => {
      const result = await realSet(items);
      const moved = fake._state.tabs.find((tab) => tab.url === 'https://work.example/two');
      if (moved) {
        fake.tabs.query = async (query) =>
          (await realQuery(query)).map((tab) =>
            tab.id === moved.id ? { ...tab, url: 'https://work.example/somewhere-new' } : tab,
          );
      }
      return result;
    };

    const result = await closeAllGroups({ windowId: 1 });

    assert.equal(result.changedTabs, 1);
    assert.equal(result.closedTabs, 2);
    assert.ok(
      fake._state.tabs.some((tab) => tab.url === 'https://work.example/two'),
      'the navigated tab is still open because its new address was never saved',
    );
  });
});

describe('automatic backup change detection', () => {
  afterEach(uninstallFakeChrome);

  it('takes a new snapshot when only the collapsed state changed', async () => {
    const fake = installFakeChrome(TWO_GROUPS);
    await runAutoBackup();

    const group = fake._state.groups[0];
    assert.ok(group);
    await fake.tabGroups.update(group.id, { collapsed: !group.collapsed });

    assert.equal((await runAutoBackup()).stored, true);
    assert.equal((await readSessions()).length, 2);
  });
});

describe('import accounting', () => {
  afterEach(uninstallFakeChrome);

  /**
   * @param {number} count
   * @param {number} [baseTime]
   * @returns {string}
   */
  const exportOf = (count, baseTime = 1_700_000_000_000) =>
    JSON.stringify({
      format: EXPORT_FORMAT,
      schemaVersion: SCHEMA_VERSION,
      sessions: Array.from({ length: count }, (_, index) => ({
        id: `imported-${index}`,
        createdAt: baseTime + index * 1000,
        source: 'manual',
        groups: [
          {
            title: `Group ${index}`,
            color: 'blue',
            collapsed: false,
            tabs: [{ url: `https://example.com/${index}`, title: `Tab ${index}` }],
          },
        ],
      })),
    });

  it('reports only the sessions that actually survived the retention limit', async () => {
    installFakeChrome(TWO_GROUPS);
    const overLimit = LIMITS.MAX_MANUAL_SESSIONS + 5;

    const result = await importSessions(exportOf(overLimit));

    assert.equal(result.imported, LIMITS.MAX_MANUAL_SESSIONS);
    assert.equal(result.rejected, 5);
    assert.equal((await readSessions()).length, LIMITS.MAX_MANUAL_SESSIONS);
  });

  it('says how many existing sessions the import pushed out', async () => {
    const fake = installFakeChrome(TWO_GROUPS);
    fake._state.seedStorage({
      sessions: [
        {
          id: 'long-standing',
          createdAt: 1_600_000_000_000,
          source: 'manual',
          groups: [
            {
              title: 'Old',
              color: 'blue',
              collapsed: false,
              tabs: [{ url: 'https://old.example/', title: 'Old' }],
            },
          ],
        },
      ],
    });

    const result = await importSessions(exportOf(LIMITS.MAX_MANUAL_SESSIONS, 1_700_000_000_000));

    assert.equal(result.imported, LIMITS.MAX_MANUAL_SESSIONS);
    assert.equal(result.evicted, 1);
    assert.ok(
      !(await readSessions()).some((session) => session.id === 'long-standing'),
      'the evicted session is genuinely gone, and the count says so',
    );
  });

  it('refuses a file written by a newer schema version', async () => {
    installFakeChrome(TWO_GROUPS);
    const payload = JSON.stringify({
      format: EXPORT_FORMAT,
      schemaVersion: SCHEMA_VERSION + 1,
      sessions: [{ groups: [{ tabs: [{ url: 'https://ok.example/' }] }] }],
    });
    await assert.rejects(() => importSessions(payload), /newer version/);
    assert.deepEqual(await readSessions(), []);
  });

  it('refuses an imported session that exceeds the per-session size limit', async () => {
    installFakeChrome(TWO_GROUPS);
    const payload = JSON.stringify({
      format: EXPORT_FORMAT,
      sessions: [
        {
          groups: [
            {
              title: 'Huge',
              color: 'blue',
              tabs: Array.from({ length: 400 }, (_, index) => ({
                url: `https://example.com/${'p'.repeat(6000)}${index}`,
                title: 'x'.repeat(200),
              })),
            },
          ],
        },
      ],
    });
    await assert.rejects(() => importSessions(payload), /no restorable session/);
    assert.deepEqual(await readSessions(), []);
  });
});
