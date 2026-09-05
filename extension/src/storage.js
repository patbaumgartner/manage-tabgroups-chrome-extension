/**
 * Persistence layer on top of `chrome.storage.local`.
 *
 * Nothing leaves the device: there is no sync storage, no remote endpoint and no
 * telemetry. Data is re-validated on read so a corrupted or hand-edited profile
 * can never inject an unsafe URL into the restore path.
 */

import { LIMITS, SCHEMA_VERSION, STORAGE_KEYS } from './constants.js';
import { estimateSessionBytes, pruneSessions, validateSession } from './model.js';
import { normalizeSettings } from './settings.js';

/**
 * @typedef {import('./model.js').Session} Session
 * @typedef {import('./settings.js').Settings} Settings
 */

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isQuotaError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /quota|QUOTA_BYTES/i.test(message);
}

/**
 * Tail of the mutation queue.
 *
 * Every stored value is updated with a read-modify-write sequence, and the
 * popup, the options page, a keyboard command and the backup alarm can all run
 * one at the same time. Without a queue two of them read the same list and the
 * second write silently discards the first one's session. Chrome runs a single
 * service worker per extension, so serializing here is sufficient.
 *
 * @type {Promise<unknown>}
 */
let mutationQueue = Promise.resolve();

/**
 * @template T
 * @param {() => Promise<T>} mutation
 * @returns {Promise<T>}
 */
function serialize(mutation) {
  const result = mutationQueue.then(mutation, mutation);
  mutationQueue = result.catch(() => undefined);
  return result;
}

/**
 * @returns {Promise<void>}
 * @throws {Error} When the profile holds data from a newer extension version.
 */
async function assertWritableSchema() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SCHEMA_VERSION);
  const version = stored[STORAGE_KEYS.SCHEMA_VERSION];
  if (typeof version === 'number' && version > SCHEMA_VERSION) {
    throw new Error(
      'This profile holds data from a newer version of this extension.' +
        ' Update the extension before saving, so nothing is overwritten.',
    );
  }
}

/**
 * @returns {Promise<Settings>}
 */
export async function readSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return normalizeSettings(stored[STORAGE_KEYS.SETTINGS]);
}

/**
 * Merge a partial update into the stored settings.
 *
 * @param {Partial<Settings>} patch
 * @returns {Promise<Settings>} The settings as they were actually persisted.
 */
export function writeSettings(patch) {
  return serialize(async () => {
    await assertWritableSchema();
    const current = await readSettings();
    const next = normalizeSettings({ ...current, ...patch });
    await chrome.storage.local.set({
      [STORAGE_KEYS.SETTINGS]: next,
      [STORAGE_KEYS.SCHEMA_VERSION]: SCHEMA_VERSION,
    });
    return next;
  });
}

/**
 * @returns {Promise<Session[]>} Stored sessions, newest first.
 */
export async function readSessions() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SESSIONS);
  const raw = stored[STORAGE_KEYS.SESSIONS];
  if (!Array.isArray(raw)) {
    return [];
  }
  /** @type {Session[]} */
  const sessions = [];
  for (const entry of raw) {
    const result = validateSession(entry);
    if (result.ok) {
      sessions.push(result.session);
    }
  }
  return sessions.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Write a session list, pruning it to the configured limits first.
 *
 * If the write is rejected for quota reasons the automatic backups are dropped
 * and the write is retried once. Automatic backups are disposable, so they are
 * sacrificed first. If the retry also fails the error propagates and the caller
 * closes nothing.
 *
 * The result is read back from storage rather than returned from memory, so a
 * caller that is about to close tabs can tell whether the session really landed.
 *
 * @param {readonly Session[]} sessions
 * @returns {Promise<Session[]>} The list as it is actually stored.
 */
async function persistSessions(sessions) {
  await assertWritableSchema();
  const pruned = pruneSessions(sessions);
  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.SESSIONS]: pruned,
      [STORAGE_KEYS.SCHEMA_VERSION]: SCHEMA_VERSION,
    });
  } catch (error) {
    if (!isQuotaError(error)) {
      throw error;
    }
    await chrome.storage.local.set({
      [STORAGE_KEYS.SESSIONS]: pruned.filter((session) => session.source !== 'auto'),
      [STORAGE_KEYS.SCHEMA_VERSION]: SCHEMA_VERSION,
    });
  }
  return readSessions();
}

/**
 * @param {readonly Session[]} sessions
 * @returns {Promise<Session[]>}
 */
export function writeSessions(sessions) {
  return serialize(() => persistSessions(sessions));
}

/**
 * Add a session, replacing any existing entry with the same id.
 *
 * @param {Session} session
 * @returns {Promise<Session[]>} The stored list, newest first.
 */
export function addSession(session) {
  return serialize(async () => {
    const bytes = estimateSessionBytes(session);
    if (bytes > LIMITS.MAX_SESSION_BYTES) {
      throw new Error(
        `Session is too large to store (${Math.round(bytes / 1024)} KB, limit ${Math.round(
          LIMITS.MAX_SESSION_BYTES / 1024,
        )} KB).`,
      );
    }
    const existing = await readSessions();
    return persistSessions([session, ...existing.filter((entry) => entry.id !== session.id)]);
  });
}

/**
 * Add several sessions at once (used by import).
 *
 * @param {readonly Session[]} sessions
 * @returns {Promise<Session[]>}
 */
export function addSessions(sessions) {
  return serialize(async () => {
    const existing = await readSessions();
    const incomingIds = new Set(sessions.map((session) => session.id));
    return persistSessions([
      ...sessions,
      ...existing.filter((entry) => !incomingIds.has(entry.id)),
    ]);
  });
}

/**
 * @param {string} id
 * @returns {Promise<Session[]>}
 */
export function deleteSession(id) {
  return serialize(async () => {
    const existing = await readSessions();
    return persistSessions(existing.filter((session) => session.id !== id));
  });
}

/**
 * @returns {Promise<Session[]>}
 */
export function clearSessions() {
  return serialize(() => persistSessions([]));
}

/**
 * @param {string} id
 * @returns {Promise<Session | null>}
 */
export async function findSession(id) {
  const sessions = await readSessions();
  return sessions.find((session) => session.id === id) ?? null;
}
