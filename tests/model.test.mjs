import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXPORT_FORMAT, LIMITS } from '../extension/src/constants.js';
import {
  buildSession,
  createSessionId,
  estimateSessionBytes,
  normalizeColor,
  normalizeUrl,
  parseExport,
  pruneSessions,
  sanitizeText,
  serializeExport,
  sessionSignature,
  sessionStats,
  validateSession,
} from '../extension/src/model.js';

describe('normalizeUrl', () => {
  it('canonicalises http and https URLs', () => {
    assert.equal(normalizeUrl('https://example.com'), 'https://example.com/');
    assert.equal(normalizeUrl('HTTP://Example.COM/Path?b=1'), 'http://example.com/Path?b=1');
    assert.equal(normalizeUrl('  https://example.com/a  '), 'https://example.com/a');
  });

  it('rejects every scheme that could execute or read local data', () => {
    for (const url of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      '\u0009javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'blob:https://example.com/1234',
      'filesystem:https://example.com/temporary/x',
      'file:///etc/passwd',
      'chrome://settings',
      'chrome-extension://abcdefghijklmnop/options.html',
      'about:blank',
      'view-source:https://example.com',
      'ftp://example.com/file',
      'vbscript:msgbox(1)',
    ]) {
      assert.equal(normalizeUrl(url), null, `expected ${url} to be rejected`);
    }
  });

  it('rejects URLs carrying embedded credentials', () => {
    assert.equal(normalizeUrl('https://user:secret@example.com/'), null);
    assert.equal(normalizeUrl('https://user@example.com/'), null);
  });

  it('rejects values that are not usable URLs', () => {
    assert.equal(normalizeUrl(''), null);
    assert.equal(normalizeUrl('not a url'), null);
    assert.equal(normalizeUrl(null), null);
    assert.equal(normalizeUrl(42), null);
    assert.equal(normalizeUrl({ href: 'https://example.com' }), null);
    assert.equal(normalizeUrl(`https://example.com/${'a'.repeat(LIMITS.MAX_URL_LENGTH)}`), null);
  });
});

describe('sanitizeText', () => {
  it('removes control characters, bidi overrides and zero-width characters', () => {
    assert.equal(sanitizeText('a\u0000b\u001fc'), 'abc');
    assert.equal(sanitizeText('safe\u202Etxt.exe'), 'safetxt.exe');
    assert.equal(sanitizeText('a\u200Bb\uFEFFc'), 'abc');
    assert.equal(sanitizeText('  padded  '), 'padded');
  });

  it('clamps length and coerces non-strings to an empty string', () => {
    assert.equal(sanitizeText('x'.repeat(500)).length, LIMITS.MAX_TITLE_LENGTH);
    assert.equal(sanitizeText(undefined), '');
    assert.equal(sanitizeText({}), '');
    assert.equal(sanitizeText(7), '');
  });
});

describe('normalizeColor', () => {
  it('passes known colours through and falls back for anything else', () => {
    assert.equal(normalizeColor('cyan'), 'cyan');
    assert.equal(normalizeColor('chartreuse'), 'grey');
    assert.equal(normalizeColor(null), 'grey');
    assert.equal(normalizeColor('<script>'), 'grey');
  });
});

describe('buildSession', () => {
  const groups = [
    { id: 2, windowId: 1, title: 'Second', color: 'green', collapsed: true },
    { id: 1, windowId: 1, title: 'First', color: 'neon', collapsed: false },
  ];
  const tabs = [
    { id: 11, groupId: 1, index: 0, url: 'https://a.example/1', title: 'A1' },
    { id: 12, groupId: 1, index: 1, url: 'https://a.example/2', title: 'A2' },
    { id: 21, groupId: 2, index: 2, url: 'https://b.example/1', title: 'B1' },
    { id: 99, groupId: -1, index: 3, url: 'https://loose.example/', title: 'loose' },
  ];

  it('orders groups by first tab and keeps tab order', () => {
    const { session } = buildSession({ groups, tabs, createdAt: 1_700_000_000_000, id: 'fixed' });
    assert.equal(session.id, 'fixed');
    assert.equal(session.createdAt, 1_700_000_000_000);
    assert.deepEqual(
      session.groups.map((group) => group.title),
      ['First', 'Second'],
    );
    assert.deepEqual(
      session.groups[0]?.tabs.map((tab) => tab.url),
      ['https://a.example/1', 'https://a.example/2'],
    );
  });

  it('never includes tabs that are not part of a group', () => {
    const { session, savedTabs } = buildSession({ groups, tabs });
    const urls = session.groups.flatMap((group) => group.tabs.map((tab) => tab.url));
    assert.ok(!urls.includes('https://loose.example/'));
    assert.ok(!savedTabs.some((tab) => tab.id === 99));
  });

  it('normalises an unknown colour and keeps the collapsed flag', () => {
    const { session } = buildSession({ groups, tabs });
    assert.equal(session.groups[0]?.color, 'grey');
    assert.equal(session.groups[1]?.color, 'green');
    assert.equal(session.groups[1]?.collapsed, true);
  });

  it('reports skipped tabs and excludes them from the closable ids', () => {
    const { session, savedTabs, skippedTabs } = buildSession({
      groups: [{ id: 1, windowId: 1, title: 'Mixed', color: 'blue' }],
      tabs: [
        { id: 1, groupId: 1, index: 0, url: 'https://ok.example/', title: 'ok' },
        { id: 2, groupId: 1, index: 1, url: 'chrome://settings', title: 'settings' },
        { id: 3, groupId: 1, index: 2, url: 'javascript:alert(1)', title: 'evil' },
      ],
    });
    assert.equal(skippedTabs, 2);
    assert.deepEqual(savedTabs, [{ id: 1, url: 'https://ok.example/' }]);
    assert.equal(session.groups[0]?.tabs.length, 1);
  });

  it('drops a group whose tabs are all unsupported without marking them closable', () => {
    const { session, savedTabs, skippedTabs } = buildSession({
      groups: [{ id: 1, windowId: 1, title: 'Internal', color: 'blue' }],
      tabs: [
        { id: 1, groupId: 1, index: 0, url: 'chrome://settings' },
        { id: 2, groupId: 1, index: 1, url: 'chrome://extensions' },
      ],
    });
    assert.equal(session.groups.length, 0);
    assert.deepEqual(savedTabs, []);
    assert.equal(skippedTabs, 2);
  });

  it('falls back to a pending URL while a tab is still loading', () => {
    const { session } = buildSession({
      groups: [{ id: 1, windowId: 1, title: 'Loading', color: 'blue' }],
      tabs: [{ id: 1, groupId: 1, index: 0, url: '', pendingUrl: 'https://slow.example/' }],
    });
    assert.equal(session.groups[0]?.tabs[0]?.url, 'https://slow.example/');
  });

  it('enforces the per-group tab ceiling', () => {
    const many = Array.from({ length: LIMITS.MAX_TABS_PER_GROUP + 10 }, (_, index) => ({
      id: index + 1,
      groupId: 1,
      index,
      url: `https://example.com/${index}`,
    }));
    const { session, skippedTabs } = buildSession({
      groups: [{ id: 1, windowId: 1, title: 'Huge', color: 'blue' }],
      tabs: many,
    });
    assert.equal(session.groups[0]?.tabs.length, LIMITS.MAX_TABS_PER_GROUP);
    assert.equal(skippedTabs, 10);
  });
});

describe('validateSession', () => {
  const valid = {
    id: 'abc',
    createdAt: 1_700_000_000_000,
    source: 'manual',
    groups: [
      {
        title: 'Work',
        color: 'blue',
        collapsed: false,
        tabs: [{ url: 'https://example.com/', title: 'Example' }],
      },
    ],
  };

  it('accepts a well formed session', () => {
    const result = validateSession(valid);
    assert.ok(result.ok);
    assert.equal(result.session.id, 'abc');
    assert.equal(result.session.source, 'manual');
    assert.equal(result.session.groups[0]?.tabs[0]?.url, 'https://example.com/');
  });

  it('rejects values that are not sessions', () => {
    for (const value of [null, undefined, 42, 'x', [], {}, { groups: 'nope' }]) {
      assert.equal(validateSession(value).ok, false);
    }
  });

  it('drops unsafe URLs instead of restoring them', () => {
    const result = validateSession({
      groups: [
        {
          title: 'Mixed',
          color: 'blue',
          tabs: [
            { url: 'javascript:alert(document.cookie)' },
            { url: 'https://good.example/' },
            { url: 'file:///etc/shadow' },
          ],
        },
      ],
    });
    assert.ok(result.ok);
    assert.deepEqual(
      result.session.groups[0]?.tabs.map((tab) => tab.url),
      ['https://good.example/'],
    );
  });

  it('rejects a session whose groups contain nothing restorable', () => {
    const result = validateSession({
      groups: [{ title: 'Bad', color: 'blue', tabs: [{ url: 'javascript:alert(1)' }] }],
    });
    assert.equal(result.ok, false);
  });

  it('repairs an implausible timestamp and an unknown source', () => {
    const now = 1_800_000_000_000;
    const result = validateSession(
      { ...valid, createdAt: -5, source: 'hacked' },
      { now, source: undefined },
    );
    assert.ok(result.ok);
    assert.equal(result.session.createdAt, now);
    assert.equal(result.session.source, 'import');
  });

  it('replaces an oversized identifier', () => {
    const result = validateSession({ ...valid, id: 'x'.repeat(500) });
    assert.ok(result.ok);
    assert.notEqual(result.session.id, 'x'.repeat(500));
    assert.ok(result.session.id.length <= 128);
  });
});

describe('export round-trip', () => {
  it('serialises and parses back to the same data', () => {
    const { session } = buildSession({
      groups: [{ id: 1, windowId: 1, title: 'Work', color: 'blue' }],
      tabs: [{ id: 1, groupId: 1, index: 0, url: 'https://example.com/', title: 'Example' }],
      createdAt: 1_700_000_000_000,
      id: 'session-1',
    });
    const parsed = parseExport(serializeExport([session], { exportedAt: 1, version: '1.0.0' }));
    assert.ok(parsed.ok);
    assert.equal(parsed.sessions.length, 1);
    assert.deepEqual(parsed.sessions[0]?.groups, session.groups);
    assert.equal(parsed.sessions[0]?.source, 'import');
  });

  it('refuses files that are not exports of this extension', () => {
    assert.equal(parseExport('not json').ok, false);
    assert.equal(parseExport('[]').ok, false);
    assert.equal(parseExport('null').ok, false);
    assert.equal(parseExport(JSON.stringify({ sessions: [] })).ok, false);
    assert.equal(parseExport(JSON.stringify({ format: 'other', sessions: [] })).ok, false);
    assert.equal(parseExport(JSON.stringify({ format: EXPORT_FORMAT })).ok, false);
    assert.equal(parseExport(42).ok, false);
  });

  it('refuses a file above the import size limit', () => {
    const huge = JSON.stringify({
      format: EXPORT_FORMAT,
      sessions: [{ groups: [{ tabs: [{ url: `https://e.example/${'a'.repeat(9_000_000)}` }] }] }],
    });
    const result = parseExport(huge);
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : '', /import limit/);
  });

  it('counts entries it had to reject', () => {
    const result = parseExport(
      JSON.stringify({
        format: EXPORT_FORMAT,
        sessions: [
          { groups: [{ tabs: [{ url: 'https://ok.example/' }] }] },
          { groups: [{ tabs: [{ url: 'javascript:alert(1)' }] }] },
          'garbage',
        ],
      }),
    );
    assert.ok(result.ok);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.rejected, 2);
  });

  it('caps the number of imported sessions', () => {
    const sessions = Array.from({ length: LIMITS.MAX_IMPORT_SESSIONS + 5 }, () => ({
      groups: [{ tabs: [{ url: 'https://ok.example/' }] }],
    }));
    const result = parseExport(JSON.stringify({ format: EXPORT_FORMAT, sessions }));
    assert.ok(result.ok);
    assert.equal(result.sessions.length, LIMITS.MAX_IMPORT_SESSIONS);
    assert.equal(result.rejected, 5);
  });

  it('does not let a crafted file pollute Object.prototype', () => {
    const payload = `{"format":"${EXPORT_FORMAT}","sessions":[{"__proto__":{"polluted":true},
      "groups":[{"__proto__":{"polluted":true},"tabs":[{"url":"https://ok.example/"}]}]}]}`;
    const result = parseExport(payload);
    assert.ok(result.ok);
    assert.equal(
      /** @type {Record<string, unknown>} */ ({}).polluted,
      undefined,
      'Object.prototype must not be polluted',
    );
    assert.equal(Object.hasOwn(result.sessions[0] ?? {}, 'polluted'), false);
  });
});

describe('pruneSessions', () => {
  /**
   * @param {number} index
   * @param {'manual' | 'auto' | 'import'} source
   * @returns {import('../extension/src/model.js').Session}
   */
  const make = (index, source) => ({
    id: `${source}-${index}`,
    createdAt: 1_700_000_000_000 + index,
    source,
    groups: [
      { title: '', color: 'grey', collapsed: false, tabs: [{ url: 'https://e/', title: '' }] },
    ],
  });

  it('keeps the newest of each bucket independently', () => {
    const sessions = [
      ...Array.from({ length: LIMITS.MAX_AUTO_SESSIONS + 5 }, (_, i) => make(i, 'auto')),
      ...Array.from({ length: LIMITS.MAX_MANUAL_SESSIONS + 5 }, (_, i) => make(i, 'manual')),
    ];
    const pruned = pruneSessions(sessions);
    assert.equal(pruned.filter((s) => s.source === 'auto').length, LIMITS.MAX_AUTO_SESSIONS);
    assert.equal(pruned.filter((s) => s.source === 'manual').length, LIMITS.MAX_MANUAL_SESSIONS);
  });

  it('never lets automatic backups evict a manual session', () => {
    const manual = make(0, 'manual');
    const autos = Array.from({ length: 50 }, (_, i) => make(i + 1, 'auto'));
    const pruned = pruneSessions([manual, ...autos]);
    assert.ok(pruned.some((session) => session.id === manual.id));
  });

  it('returns newest first', () => {
    const pruned = pruneSessions([make(1, 'manual'), make(3, 'manual'), make(2, 'manual')]);
    assert.deepEqual(
      pruned.map((session) => session.id),
      ['manual-3', 'manual-2', 'manual-1'],
    );
  });
});

describe('helpers', () => {
  it('produces unique session ids', () => {
    assert.notEqual(createSessionId(), createSessionId());
    assert.match(createSessionId(), /^s-[0-9a-f-]{36}$/);
  });

  it('summarises and measures a session', () => {
    const session = {
      id: 'x',
      createdAt: 1,
      /** @type {'manual'} */
      source: /** @type {const} */ ('manual'),
      groups: [
        {
          title: 'a',
          color: 'blue',
          collapsed: false,
          tabs: [
            { url: 'https://a/', title: '' },
            { url: 'https://b/', title: '' },
          ],
        },
      ],
    };
    assert.deepEqual(sessionStats(session), { groupCount: 1, tabCount: 2 });
    assert.ok(estimateSessionBytes(session) > 0);
  });

  it('ignores id, time and source when fingerprinting a session', () => {
    const groups = [
      { title: 'a', color: 'blue', collapsed: false, tabs: [{ url: 'https://a/', title: 't' }] },
    ];
    assert.equal(
      sessionSignature({ id: '1', createdAt: 1, source: 'manual', groups }),
      sessionSignature({ id: '2', createdAt: 2, source: 'auto', groups }),
    );
  });
});

describe('normalizeUrl against unusual but parseable inputs', () => {
  it('keeps only canonical http(s) URLs, whatever shape they arrive in', () => {
    /** @type {[string, string | null][]} */
    const cases = [
      ['https://example.com/a\\b', 'https://example.com/a/b'],
      ['https:example.com/x', 'https://example.com/x'],
      ['https:/example.com/x', 'https://example.com/x'],
      ['http://192.168.0.1/', 'http://192.168.0.1/'],
      ['http://[::1]:8080/x', 'http://[::1]:8080/x'],
      ['https://example.com/%2e%2e/x', 'https://example.com/x'],
      ['https://exam ple.com/', null],
      ['java\nscript:alert(1)', null],
      ['java\tscript:alert(1)', null],
      [' javascript:alert(1)', null],
      ['JAVASCRIPT:alert(1)', null],
      ['jav\u0000ascript:alert(1)', null],
      ['https://user:pw@example.com/', null],
      ['//example.com/protocol-relative', null],
      ['/just/a/path', null],
    ];

    for (const [input, expected] of cases) {
      assert.equal(normalizeUrl(input), expected, `input: ${JSON.stringify(input)}`);
    }
  });

  it('never returns a value whose scheme is outside the allowlist', () => {
    const inputs = [
      'https://example.com/',
      'http://example.com/',
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd',
      'chrome://settings',
      'ws://example.com/',
      'mailto:a@b.c',
    ];
    for (const input of inputs) {
      const result = normalizeUrl(input);
      if (result !== null) {
        assert.match(result, /^https?:\/\//, `leaked scheme for ${input}`);
      }
    }
  });
});

describe('stability of repaired data', () => {
  it('derives the same id every time a session without one is read', () => {
    const raw = {
      createdAt: 1_700_000_000_000,
      source: 'manual',
      groups: [
        {
          title: 'Work',
          color: 'blue',
          collapsed: false,
          tabs: [{ url: 'https://example.com/', title: 'Example' }],
        },
      ],
    };
    const first = validateSession(raw);
    const second = validateSession(raw);
    assert.ok(first.ok && second.ok);
    assert.equal(
      first.session.id,
      second.session.id,
      'a changing id would make the entry impossible to restore or delete',
    );
    assert.notEqual(first.session.id, '');
  });

  it('gives different ids to sessions with different contents', () => {
    const make = (/** @type {string} */ url) =>
      validateSession({
        createdAt: 1_700_000_000_000,
        groups: [{ title: 'x', color: 'blue', tabs: [{ url }] }],
      });
    const a = make('https://a.example/');
    const b = make('https://b.example/');
    assert.ok(a.ok && b.ok);
    assert.notEqual(a.session.id, b.session.id);
  });

  it('clamps a timestamp from the future so it cannot outrank real snapshots', () => {
    const now = 1_700_000_000_000;
    const result = validateSession(
      {
        createdAt: now + 90 * 24 * 60 * 60 * 1000,
        groups: [{ title: 'x', color: 'blue', tabs: [{ url: 'https://a.example/' }] }],
      },
      { now },
    );
    assert.ok(result.ok);
    assert.equal(result.session.createdAt, now);
  });
});

describe('sessionSignature', () => {
  it('changes when a group is collapsed or expanded', () => {
    const build = (/** @type {boolean} */ collapsed) => ({
      id: 'x',
      createdAt: 1,
      /** @type {'manual'} */
      source: /** @type {const} */ ('manual'),
      groups: [{ title: 'a', color: 'blue', collapsed, tabs: [{ url: 'https://a/', title: 't' }] }],
    });
    assert.notEqual(
      sessionSignature(build(true)),
      sessionSignature(build(false)),
      'an automatic backup must notice a collapse-only change',
    );
  });
});
