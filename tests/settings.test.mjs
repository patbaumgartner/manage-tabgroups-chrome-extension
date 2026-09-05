import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AUTO_BACKUP_INTERVAL_BOUNDS, DEFAULT_SETTINGS } from '../extension/src/constants.js';
import { normalizeSettings } from '../extension/src/settings.js';

describe('normalizeSettings', () => {
  it('returns the defaults for missing or hostile input', () => {
    for (const value of [undefined, null, 'nope', 42, []]) {
      assert.deepEqual(normalizeSettings(value), { ...DEFAULT_SETTINGS });
    }
  });

  it('keeps valid values', () => {
    assert.deepEqual(
      normalizeSettings({
        scope: 'all',
        autoBackup: false,
        autoBackupIntervalMinutes: 30,
        closePopupAfterAction: true,
      }),
      {
        scope: 'all',
        autoBackup: false,
        autoBackupIntervalMinutes: 30,
        closePopupAfterAction: true,
      },
    );
  });

  it('falls back to the window scope for anything unrecognised', () => {
    assert.equal(normalizeSettings({ scope: 'everything' }).scope, 'window');
    assert.equal(normalizeSettings({ scope: 7 }).scope, 'window');
  });

  it('clamps and rounds the backup interval', () => {
    assert.equal(normalizeSettings({ autoBackupIntervalMinutes: 0 }).autoBackupIntervalMinutes, 1);
    assert.equal(
      normalizeSettings({ autoBackupIntervalMinutes: -100 }).autoBackupIntervalMinutes,
      AUTO_BACKUP_INTERVAL_BOUNDS.MIN,
    );
    assert.equal(
      normalizeSettings({ autoBackupIntervalMinutes: 10_000 }).autoBackupIntervalMinutes,
      AUTO_BACKUP_INTERVAL_BOUNDS.MAX,
    );
    assert.equal(
      normalizeSettings({ autoBackupIntervalMinutes: 7.6 }).autoBackupIntervalMinutes,
      8,
    );
    assert.equal(
      normalizeSettings({ autoBackupIntervalMinutes: Number.NaN }).autoBackupIntervalMinutes,
      DEFAULT_SETTINGS.autoBackupIntervalMinutes,
    );
    assert.equal(
      normalizeSettings({ autoBackupIntervalMinutes: 'lots' }).autoBackupIntervalMinutes,
      DEFAULT_SETTINGS.autoBackupIntervalMinutes,
    );
  });

  it('coerces non-boolean flags back to their defaults', () => {
    assert.equal(normalizeSettings({ autoBackup: 'yes' }).autoBackup, DEFAULT_SETTINGS.autoBackup);
    assert.equal(normalizeSettings({ closePopupAfterAction: 1 }).closePopupAfterAction, false);
  });
});
