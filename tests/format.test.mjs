import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatCloseResult,
  formatCounts,
  formatFileTimestamp,
  formatImportResult,
  formatRelativeTime,
  formatRestoreResult,
  formatSource,
  pluralize,
} from '../extension/src/format.js';

describe('pluralize and formatCounts', () => {
  it('uses the singular form for exactly one', () => {
    assert.equal(pluralize(1, 'group', 'groups'), '1 group');
    assert.equal(pluralize(0, 'group', 'groups'), '0 groups');
    assert.equal(pluralize(2, 'group', 'groups'), '2 groups');
  });

  it('joins group and tab counts', () => {
    assert.equal(formatCounts(1, 1), '1 group · 1 tab');
    assert.equal(formatCounts(3, 24), '3 groups · 24 tabs');
  });
});

describe('formatRelativeTime', () => {
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);

  it('describes recent timestamps in words', () => {
    assert.equal(formatRelativeTime(now, now), 'just now');
    assert.equal(formatRelativeTime(now - 30_000, now), 'just now');
    assert.equal(formatRelativeTime(now - 60_000, now), '1 minute ago');
    assert.equal(formatRelativeTime(now - 5 * 60_000, now), '5 minutes ago');
    assert.equal(formatRelativeTime(now - 3_600_000, now), '1 hour ago');
    assert.equal(formatRelativeTime(now - 5 * 3_600_000, now), '5 hours ago');
    assert.equal(formatRelativeTime(now - 86_400_000, now), '1 day ago');
    assert.equal(formatRelativeTime(now - 3 * 86_400_000, now), '3 days ago');
  });

  it('falls back to a date for anything older than a week', () => {
    assert.ok(formatRelativeTime(now - 30 * 86_400_000, now).length > 0);
    assert.doesNotMatch(formatRelativeTime(now - 30 * 86_400_000, now), /ago/);
  });

  it('treats a future timestamp as just now', () => {
    assert.equal(formatRelativeTime(now + 60_000, now), 'just now');
  });
});

describe('result sentences', () => {
  it('mentions tabs that were left open', () => {
    assert.equal(
      formatCloseResult({ groupCount: 2, tabCount: 9 }, 0),
      'Saved and closed 2 groups · 9 tabs.',
    );
    assert.match(formatCloseResult({ groupCount: 2, tabCount: 9 }, 1), /1 tab left open/);
  });

  it('mentions restore failures', () => {
    assert.equal(
      formatRestoreResult({ restoredGroups: 1, restoredTabs: 4, failures: [] }),
      'Restored 1 group · 4 tabs.',
    );
    assert.match(
      formatRestoreResult({ restoredGroups: 1, restoredTabs: 4, failures: ['a', 'b'] }),
      /2 items could not be restored/,
    );
  });

  it('labels the origin of a session', () => {
    assert.equal(formatSource('auto'), 'Auto backup');
    assert.equal(formatSource('import'), 'Imported');
    assert.equal(formatSource('manual'), 'Saved');
    assert.equal(formatSource('anything else'), 'Saved');
  });
});

describe('formatFileTimestamp', () => {
  it('produces a sortable, filesystem-safe stamp', () => {
    const stamp = formatFileTimestamp(new Date(2026, 8, 5, 9, 7, 3).getTime());
    assert.equal(stamp, '2026-09-05_09-07-03');
  });
});

describe('formatCloseResult', () => {
  it('mentions tabs left open because they changed while saving', () => {
    assert.equal(
      formatCloseResult({ groupCount: 1, tabCount: 4 }, 0, 1),
      'Saved and closed 1 group · 4 tabs. 1 tab left open (changed while saving).',
    );
    assert.equal(
      formatCloseResult({ groupCount: 1, tabCount: 4 }, 0, 3),
      'Saved and closed 1 group · 4 tabs. 3 tabs left open (changed while saving).',
    );
  });

  it('reports both reasons a tab can be left open', () => {
    const message = formatCloseResult({ groupCount: 2, tabCount: 9 }, 2, 1);
    assert.match(message, /2 tabs left open \(unsupported address\)/);
    assert.match(message, /1 tab left open \(changed while saving\)/);
  });

  it('says nothing extra when everything was closed', () => {
    assert.equal(
      formatCloseResult({ groupCount: 1, tabCount: 1 }, 0, 0),
      'Saved and closed 1 group · 1 tab.',
    );
  });
});

describe('formatImportResult', () => {
  it('reports only what was actually kept', () => {
    assert.equal(
      formatImportResult({ imported: 3, rejected: 0, evicted: 0, replaced: 0 }),
      'Imported 3 sessions.',
    );
    assert.equal(
      formatImportResult({ imported: 1, rejected: 0, evicted: 0, replaced: 0 }),
      'Imported 1 session.',
    );
  });

  it('names entries it could not use', () => {
    assert.equal(
      formatImportResult({ imported: 2, rejected: 1, evicted: 0, replaced: 0 }),
      'Imported 2 sessions. 1 entry skipped as unusable.',
    );
    assert.match(
      formatImportResult({ imported: 2, rejected: 4, evicted: 0, replaced: 0 }),
      /4 entries skipped as unusable/,
    );
  });

  it('warns when the import pushed older sessions out', () => {
    assert.equal(
      formatImportResult({ imported: 25, rejected: 0, evicted: 1, replaced: 0 }),
      'Imported 25 sessions. 1 older session dropped to stay within the limit.',
    );
    assert.match(
      formatImportResult({ imported: 25, rejected: 0, evicted: 3, replaced: 0 }),
      /3 older sessions dropped to stay within the limit/,
    );
  });

  it('reports every outcome at once', () => {
    const message = formatImportResult({ imported: 25, rejected: 2, evicted: 4, replaced: 0 });
    assert.match(message, /^Imported 25 sessions\./);
    assert.match(message, /2 entries skipped as unusable/);
    assert.match(message, /4 older sessions dropped/);
  });
});

describe('formatCloseResult when fewer tabs closed than were saved', () => {
  it('does not claim everything saved was closed', () => {
    const message = formatCloseResult({ groupCount: 2, tabCount: 3 }, 0, 1, 2);
    assert.equal(
      message,
      'Saved 2 groups \u00b7 3 tabs, closed 2 tabs. 1 tab left open (changed while saving).',
    );
    assert.doesNotMatch(message, /Saved and closed/);
  });
});

describe('formatImportResult replacement reporting', () => {
  it('says when an import overwrote stored sessions', () => {
    assert.equal(
      formatImportResult({ imported: 1, rejected: 0, evicted: 0, replaced: 1 }),
      'Imported 1 session. 1 existing session replaced.',
    );
    assert.match(
      formatImportResult({ imported: 3, rejected: 0, evicted: 0, replaced: 2 }),
      /2 existing sessions replaced/,
    );
  });
});
