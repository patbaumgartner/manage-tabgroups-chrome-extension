import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatCloseResult,
  formatCounts,
  formatFileTimestamp,
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
