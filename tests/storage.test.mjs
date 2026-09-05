import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { LIMITS, SCHEMA_VERSION, STORAGE_KEYS } from '../extension/src/constants.js';
import {
  addSession,
  addSessions,
  clearSessions,
  deleteSession,
  findSession,
  readSessions,
  readSettings,
  writeSessions,
  writeSettings,
} from '../extension/src/storage.js';
import { installFakeChrome, uninstallFakeChrome } from './helpers/fake-chrome.mjs';

/**
 * @param {string} id
 * @param {'manual' | 'auto' | 'import'} [source]
 * @param {number} [createdAt]
 * @returns {import('../extension/src/model.js').Session}
 */
function makeSession(id, source = 'manual', createdAt = 1_700_000_000_000) {
  return {
    id,
    createdAt,
    source,
    groups: [
      {
        title: `Group ${id}`,
        color: 'blue',
        collapsed: false,
        tabs: [{ url: `https://example.com/${id}`, title: id }],
      },
    ],
  };
}

describe('settings storage', () => {
  /** @type {ReturnType<typeof installFakeChrome>} */
  let fake;

  beforeEach(() => {
    fake = installFakeChrome();
  });
  afterEach(uninstallFakeChrome);

  it('returns defaults when nothing is stored', async () => {
    assert.deepEqual(await readSettings(), {
      scope: 'window',
      autoBackup: true,
      autoBackupIntervalMinutes: 5,
      closePopupAfterAction: false,
    });
  });

  it('merges a partial update and stamps the schema version', async () => {
    await writeSettings({ scope: 'all' });
    const settings = await writeSettings({ autoBackup: false });
    assert.equal(settings.scope, 'all');
    assert.equal(settings.autoBackup, false);
    assert.equal(fake._state.storage[STORAGE_KEYS.SCHEMA_VERSION], SCHEMA_VERSION);
  });

  it('repairs settings that were tampered with on disk', async () => {
    fake._state.seedStorage({
      [STORAGE_KEYS.SETTINGS]: { scope: 'everything', autoBackupIntervalMinutes: -3 },
    });
    const settings = await readSettings();
    assert.equal(settings.scope, 'window');
    assert.equal(settings.autoBackupIntervalMinutes, 1);
  });
});

describe('session storage', () => {
  /** @type {ReturnType<typeof installFakeChrome>} */
  let fake;

  beforeEach(() => {
    fake = installFakeChrome();
  });
  afterEach(uninstallFakeChrome);

  it('round-trips a session', async () => {
    await addSession(makeSession('a'));
    const sessions = await readSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.id, 'a');
    assert.equal(await findSession('a').then((s) => s?.id), 'a');
    assert.equal(await findSession('missing'), null);
  });

  it('returns sessions newest first', async () => {
    await addSession(makeSession('old', 'manual', 1_700_000_000_000));
    await addSession(makeSession('new', 'manual', 1_700_000_100_000));
    assert.deepEqual(
      (await readSessions()).map((s) => s.id),
      ['new', 'old'],
    );
  });

  it('replaces an entry with the same id instead of duplicating it', async () => {
    await addSession(makeSession('a'));
    await addSession(makeSession('a'));
    assert.equal((await readSessions()).length, 1);
  });

  it('drops stored entries that are no longer valid', async () => {
    fake._state.seedStorage({
      [STORAGE_KEYS.SESSIONS]: [
        makeSession('good'),
        { id: 'bad', groups: 'not-an-array' },
        null,
        { id: 'unsafe', groups: [{ tabs: [{ url: 'javascript:alert(1)' }] }] },
      ],
    });
    const sessions = await readSessions();
    assert.deepEqual(
      sessions.map((session) => session.id),
      ['good'],
    );
  });

  it('re-validates URLs that were edited into storage', async () => {
    fake._state.seedStorage({
      [STORAGE_KEYS.SESSIONS]: [
        {
          id: 'tampered',
          createdAt: 1_700_000_000_000,
          source: 'manual',
          groups: [
            {
              title: 'x',
              color: 'blue',
              tabs: [{ url: 'javascript:fetch("https://evil")' }, { url: 'https://ok.example/' }],
            },
          ],
        },
      ],
    });
    const sessions = await readSessions();
    assert.deepEqual(
      sessions[0]?.groups[0]?.tabs.map((tab) => tab.url),
      ['https://ok.example/'],
    );
  });

  it('returns an empty list when storage holds something unexpected', async () => {
    fake._state.seedStorage({ [STORAGE_KEYS.SESSIONS]: { not: 'an array' } });
    assert.deepEqual(await readSessions(), []);
  });

  it('prunes to the configured limits on write', async () => {
    const many = Array.from({ length: LIMITS.MAX_MANUAL_SESSIONS + 8 }, (_, index) =>
      makeSession(`m${index}`, 'manual', 1_700_000_000_000 + index),
    );
    const stored = await writeSessions(many);
    assert.equal(stored.length, LIMITS.MAX_MANUAL_SESSIONS);
    assert.equal(stored[0]?.id, `m${many.length - 1}`);
  });

  it('deletes one session and clears them all', async () => {
    await addSession(makeSession('a'));
    await addSession(makeSession('b', 'manual', 1_700_000_100_000));
    assert.deepEqual(
      (await deleteSession('a')).map((s) => s.id),
      ['b'],
    );
    assert.deepEqual(await clearSessions(), []);
    assert.deepEqual(await readSessions(), []);
  });

  it('adds imported sessions ahead of the existing ones', async () => {
    await addSession(makeSession('existing'));
    const stored = await addSessions([makeSession('imported', 'import', 1_600_000_000_000)]);
    assert.deepEqual(stored.map((s) => s.id).sort(), ['existing', 'imported']);
  });

  it('refuses a session larger than the per-session ceiling', async () => {
    /** @type {import('../extension/src/model.js').Session} */
    const big = {
      id: 'big',
      createdAt: 1_700_000_000_000,
      source: 'manual',
      groups: [
        {
          title: 'Huge',
          color: 'blue',
          collapsed: false,
          tabs: Array.from({ length: 400 }, (_, index) => ({
            url: `https://example.com/${'p'.repeat(6000)}${index}`,
            title: 'x'.repeat(200),
          })),
        },
      ],
    };
    await assert.rejects(() => addSession(big), /too large/);
    assert.deepEqual(await readSessions(), []);
  });
});

describe('quota handling', () => {
  afterEach(uninstallFakeChrome);

  it('sacrifices automatic backups before user-created sessions', async () => {
    const fake = installFakeChrome({ quotaBytes: 800 });
    const sessions = [
      makeSession('manual-1', 'manual', 1_700_000_900_000),
      ...Array.from({ length: 8 }, (_, index) =>
        makeSession(`auto-${index}`, 'auto', 1_700_000_000_000 + index),
      ),
    ];
    const stored = await writeSessions(sessions);
    assert.deepEqual(
      stored.map((session) => session.id),
      ['manual-1'],
    );
    assert.ok(Object.keys(fake._state.storage).length > 0);
  });

  it('gives up when even the user-created sessions do not fit', async () => {
    installFakeChrome({ quotaBytes: 10 });
    await assert.rejects(() => writeSessions([makeSession('manual-1')]), /quota/i);
  });

  it('propagates errors that are not about quota', async () => {
    installFakeChrome();
    globalThis.chrome.storage.local.set = () => Promise.reject(new Error('disk on fire'));
    await assert.rejects(() => writeSessions([makeSession('a')]), /disk on fire/);
  });
});

describe('concurrent mutations', () => {
  afterEach(uninstallFakeChrome);

  it('keeps both sessions when two are added at the same time', async () => {
    installFakeChrome();
    await Promise.all([addSession(makeSession('a')), addSession(makeSession('b'))]);
    assert.deepEqual(
      (await readSessions()).map((session) => session.id).sort(),
      ['a', 'b'],
      'an unserialized read-modify-write would drop one of them',
    );
  });

  it('does not lose a session to a concurrent delete of another one', async () => {
    installFakeChrome();
    await addSession(makeSession('old', 'manual', 1_600_000_000_000));
    await Promise.all([addSession(makeSession('new')), deleteSession('old')]);
    assert.deepEqual(
      (await readSessions()).map((session) => session.id),
      ['new'],
    );
  });

  it('keeps both settings changes when two are saved at the same time', async () => {
    installFakeChrome();
    await Promise.all([writeSettings({ scope: 'all' }), writeSettings({ autoBackup: false })]);
    const settings = await readSettings();
    assert.equal(settings.scope, 'all');
    assert.equal(settings.autoBackup, false);
  });

  it('runs queued mutations even after one of them fails', async () => {
    installFakeChrome();
    const failing = addSession(makeSession('too-big')).then(
      () => undefined,
      () => undefined,
    );
    globalThis.chrome.storage.local.set = () => Promise.reject(new Error('transient'));
    await failing;
    installFakeChrome();
    await addSession(makeSession('later'));
    assert.deepEqual(
      (await readSessions()).map((session) => session.id),
      ['later'],
    );
  });
});

describe('schema version gate', () => {
  afterEach(uninstallFakeChrome);

  it('refuses to overwrite data written by a newer version', async () => {
    const fake = installFakeChrome();
    fake._state.seedStorage({
      [STORAGE_KEYS.SCHEMA_VERSION]: SCHEMA_VERSION + 1,
      [STORAGE_KEYS.SESSIONS]: [makeSession('from-the-future')],
    });

    await assert.rejects(() => addSession(makeSession('new')), /newer version/);
    await assert.rejects(() => clearSessions(), /newer version/);
    await assert.rejects(() => writeSettings({ scope: 'all' }), /newer version/);
    assert.deepEqual(
      (await readSessions()).map((session) => session.id),
      ['from-the-future'],
      'the newer data must survive untouched',
    );
  });

  it('accepts data written by the current or an older version', async () => {
    const fake = installFakeChrome();
    fake._state.seedStorage({ [STORAGE_KEYS.SCHEMA_VERSION]: SCHEMA_VERSION });
    await addSession(makeSession('a'));
    assert.equal((await readSessions()).length, 1);
  });
});
