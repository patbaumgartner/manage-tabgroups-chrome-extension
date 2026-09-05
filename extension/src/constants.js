/**
 * Shared, dependency-free constants.
 *
 * Everything in this module is a plain value so that it can be imported from the
 * service worker, extension pages and the Node test runner alike.
 */

/** Storage schema version. Bump only together with a migration in `storage.js`. */
export const SCHEMA_VERSION = 1;

/** Keys used in `chrome.storage.local`. */
export const STORAGE_KEYS = Object.freeze({
  SCHEMA_VERSION: 'schemaVersion',
  SESSIONS: 'sessions',
  SETTINGS: 'settings',
});

/** Colors accepted by `chrome.tabGroups`. */
export const GROUP_COLORS = Object.freeze([
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
]);

/** Fallback color for groups whose stored color is unknown or invalid. */
export const DEFAULT_GROUP_COLOR = 'grey';

/**
 * URL schemes the extension is willing to re-open.
 *
 * Restoring is the one place where stored data turns back into browser
 * navigation, so the allowlist is deliberately tiny: `javascript:`, `data:`,
 * `blob:`, `filesystem:` and `chrome-extension:` URLs are never restored.
 */
export const ALLOWED_URL_PROTOCOLS = Object.freeze(['http:', 'https:']);

/** How a session came into existence. */
export const SESSION_SOURCES = Object.freeze(['manual', 'auto', 'import']);

/** Hard limits. They bound storage usage and make imported data safe to trust. */
export const LIMITS = Object.freeze({
  MAX_TITLE_LENGTH: 200,
  MAX_URL_LENGTH: 8192,
  MAX_TABS_PER_GROUP: 500,
  MAX_GROUPS_PER_SESSION: 200,
  MAX_TABS_PER_SESSION: 2000,
  MAX_SESSION_BYTES: 2 * 1024 * 1024,
  MAX_IMPORT_BYTES: 8 * 1024 * 1024,
  MAX_IMPORT_SESSIONS: 100,
  MAX_MANUAL_SESSIONS: 25,
  MAX_AUTO_SESSIONS: 10,
});

/** Persisted user settings and their defaults. */
export const DEFAULT_SETTINGS = Object.freeze({
  /** `'window'` closes/saves the current window only, `'all'` covers every window. */
  scope: 'window',
  /** Periodically snapshot open groups so a crash or a stray quit is recoverable. */
  autoBackup: true,
  /** Chrome clamps alarms to a one minute minimum. */
  autoBackupIntervalMinutes: 5,
  /** Close the popup right after a successful action. */
  closePopupAfterAction: false,
});

/** Bounds accepted for `autoBackupIntervalMinutes`. */
export const AUTO_BACKUP_INTERVAL_BOUNDS = Object.freeze({ MIN: 1, MAX: 240 });

/** Alarm name used for the periodic backup. */
export const ALARM_AUTO_BACKUP = 'manage-tabgroups:auto-backup';

/** Keyboard command ids declared in the manifest. */
export const COMMANDS = Object.freeze({
  CLOSE_ALL_GROUPS: 'close-all-groups',
  RESTORE_LATEST: 'restore-latest-session',
});

/** Message types accepted by the service worker. Anything else is rejected. */
export const MESSAGE_TYPES = Object.freeze({
  GET_STATE: 'get-state',
  SAVE_GROUPS: 'save-groups',
  CLOSE_ALL_GROUPS: 'close-all-groups',
  RESTORE_SESSION: 'restore-session',
  DELETE_SESSION: 'delete-session',
  CLEAR_SESSIONS: 'clear-sessions',
  UPDATE_SETTINGS: 'update-settings',
  IMPORT_SESSIONS: 'import-sessions',
  EXPORT_SESSIONS: 'export-sessions',
});

/** File format identifier written into exports and required on import. */
export const EXPORT_FORMAT = 'manage-tabgroups.sessions';
