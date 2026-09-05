/**
 * Pure data model for tab-group sessions.
 *
 * This module never touches `chrome.*`, the DOM or the network, which keeps it
 * fully unit-testable and makes it the single place where untrusted data
 * (page titles, stored JSON, imported files) is normalized before it can reach
 * the browser again.
 */

import {
  ALLOWED_URL_PROTOCOLS,
  DEFAULT_GROUP_COLOR,
  EXPORT_FORMAT,
  GROUP_COLORS,
  LIMITS,
  SCHEMA_VERSION,
  SESSION_SOURCES,
} from './constants.js';

/**
 * @typedef {object} StoredTab
 * @property {string} url Canonical `http(s)` URL.
 * @property {string} title Sanitized page title.
 */

/**
 * @typedef {object} StoredGroup
 * @property {string} title Sanitized group title (may be empty).
 * @property {string} color One of {@link GROUP_COLORS}.
 * @property {boolean} collapsed Whether the group was collapsed.
 * @property {StoredTab[]} tabs Ordered, non-empty list of tabs.
 */

/**
 * @typedef {object} Session
 * @property {string} id Stable identifier.
 * @property {number} createdAt Unix epoch milliseconds.
 * @property {'manual' | 'auto' | 'import'} source How the session was created.
 * @property {StoredGroup[]} groups Ordered list of groups.
 */

/**
 * @typedef {object} SavedTab
 * @property {number} id Live tab id at the moment of the snapshot.
 * @property {string} url The URL that was stored for it.
 */

/**
 * @typedef {object} RawTabLike
 * @property {number} [id]
 * @property {number} [groupId]
 * @property {number} [index]
 * @property {number} [windowId]
 * @property {string} [url]
 * @property {string} [pendingUrl]
 * @property {string} [title]
 */

/**
 * @typedef {object} RawGroupLike
 * @property {number} [id]
 * @property {number} [windowId]
 * @property {string} [title]
 * @property {string} [color]
 * @property {boolean} [collapsed]
 */

/**
 * Control characters plus the invisible/bidirectional formatting characters that
 * can be used to spoof a title in the popup list.
 */
const UNSAFE_TEXT_PATTERN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

const textEncoder = new TextEncoder();

/**
 * Coerce arbitrary input into a short, display-safe single-line string.
 *
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeText(value, maxLength = LIMITS.MAX_TITLE_LENGTH) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(UNSAFE_TEXT_PATTERN, '').trim().slice(0, maxLength);
}

/**
 * Normalize a URL, or reject it.
 *
 * Only `http(s)` survives. URLs carrying embedded credentials are rejected
 * because re-opening them would silently replay a secret.
 *
 * @param {unknown} value
 * @returns {string | null} Canonical URL, or `null` when it must not be restored.
 */
export function normalizeUrl(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  if (value.length > LIMITS.MAX_URL_LENGTH) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!ALLOWED_URL_PROTOCOLS.includes(parsed.protocol)) {
    return null;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return null;
  }
  if (parsed.href.length > LIMITS.MAX_URL_LENGTH) {
    return null;
  }
  return parsed.href;
}

/**
 * The URL a live tab should be stored under.
 *
 * A tab that has not committed its navigation yet reports an empty `url` and
 * carries the target in `pendingUrl`. The save path and the close path must
 * resolve this identically: if they disagree, a tab that is merely still
 * loading looks like it navigated and is never closed.
 *
 * @param {RawTabLike} tab
 * @returns {string | null}
 */
export function resolveTabUrl(tab) {
  return normalizeUrl(tab.url) ?? normalizeUrl(tab.pendingUrl);
}

/**
 * @param {unknown} value
 * @returns {string} A color `chrome.tabGroups.update` will accept.
 */
export function normalizeColor(value) {
  return typeof value === 'string' && GROUP_COLORS.includes(value) ? value : DEFAULT_GROUP_COLOR;
}

/**
 * @returns {string} A random session identifier.
 */
export function createSessionId() {
  return `s-${crypto.randomUUID()}`;
}

/**
 * A 64-bit fingerprint, used only to derive a stable identifier for a stored
 * session whose own id was lost or corrupted.
 *
 * Two independent FNV-1a rounds are combined because a single 32-bit round
 * collides far too easily to identify a session: `sa9uz22nclo` and
 * `2twd3704ck7` both hash to 2402c7ee. Deleting one session would then delete
 * the other. It must also stay deterministic - `readSessions` runs this on
 * every read, and a changing id makes an entry impossible to restore or delete.
 *
 * @param {string} value
 * @returns {string}
 */
function fingerprint(value) {
  let low = 0x81_1c_9d_c5;
  let high = 0xc2_b2_ae_35;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    low = Math.imul(low ^ code, 0x01_00_01_93) >>> 0;
    high = Math.imul(high ^ code, 0x85_eb_ca_6b) >>> 0;
  }
  return low.toString(16).padStart(8, '0') + high.toString(16).padStart(8, '0');
}

/**
 * @param {Session} session
 * @returns {{ groupCount: number, tabCount: number }}
 */
export function sessionStats(session) {
  let tabCount = 0;
  for (const group of session.groups) {
    tabCount += group.tabs.length;
  }
  return { groupCount: session.groups.length, tabCount };
}

/**
 * @param {Session} session
 * @returns {number} Size of the session once serialized, in UTF-8 bytes.
 */
export function estimateSessionBytes(session) {
  return textEncoder.encode(JSON.stringify(session)).length;
}

/**
 * A stable fingerprint of a session's contents, ignoring id, time and source.
 * Used to avoid storing an automatic backup identical to the previous one.
 *
 * @param {Session} session
 * @returns {string}
 */
export function sessionSignature(session) {
  return JSON.stringify(
    session.groups.map((group) => [
      group.title,
      group.color,
      group.collapsed,
      group.tabs.map((tab) => tab.url),
    ]),
  );
}

/**
 * Group live tabs by their group id, preserving tab order.
 *
 * @param {readonly RawTabLike[]} tabs
 * @returns {Map<number, RawTabLike[]>}
 */
function indexTabsByGroup(tabs) {
  /** @type {Map<number, RawTabLike[]>} */
  const byGroup = new Map();
  for (const tab of tabs) {
    if (!tab || typeof tab.groupId !== 'number' || tab.groupId < 0) {
      continue;
    }
    const bucket = byGroup.get(tab.groupId);
    if (bucket) {
      bucket.push(tab);
    } else {
      byGroup.set(tab.groupId, [tab]);
    }
  }
  for (const bucket of byGroup.values()) {
    bucket.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  }
  return byGroup;
}

/**
 * Convert one live group into its stored representation.
 *
 * @param {RawGroupLike} group
 * @param {readonly RawTabLike[]} groupTabs
 * @returns {{ stored: StoredGroup | null, savedTabs: SavedTab[], skippedTabs: number }}
 */
function convertGroup(group, groupTabs) {
  /** @type {StoredTab[]} */
  const tabs = [];
  /** @type {SavedTab[]} */
  const savedTabs = [];
  let skippedTabs = 0;

  for (const tab of groupTabs) {
    if (tabs.length >= LIMITS.MAX_TABS_PER_GROUP) {
      skippedTabs += 1;
      continue;
    }
    const url = resolveTabUrl(tab);
    if (url === null) {
      skippedTabs += 1;
      continue;
    }
    tabs.push({ url, title: sanitizeText(tab.title) });
    if (typeof tab.id === 'number') {
      savedTabs.push({ id: tab.id, url });
    }
  }

  if (tabs.length === 0) {
    return { stored: null, savedTabs: [], skippedTabs };
  }
  return {
    stored: {
      title: sanitizeText(group.title),
      color: normalizeColor(group.color),
      collapsed: group.collapsed === true,
      tabs,
    },
    savedTabs,
    skippedTabs,
  };
}

/**
 * Build a session from live `chrome.tabGroups` / `chrome.tabs` data.
 *
 * `savedTabs` lists exactly the tabs that made it into the session, each paired
 * with the URL that was stored for it. Callers that close tabs afterwards must
 * close only those, and must confirm the URL still matches, so a tab that could
 * not be saved or that navigated in the meantime is never lost.
 *
 * @param {object} input
 * @param {readonly RawGroupLike[]} input.groups
 * @param {readonly RawTabLike[]} input.tabs
 * @param {'manual' | 'auto' | 'import'} [input.source]
 * @param {number} [input.createdAt]
 * @param {string} [input.id]
 * @returns {{ session: Session, savedTabs: SavedTab[], skippedTabs: number }}
 */
export function buildSession({ groups, tabs, source = 'manual', createdAt = Date.now(), id }) {
  const tabsByGroup = indexTabsByGroup(tabs);

  const ordered = [...groups]
    .filter((group) => typeof group?.id === 'number')
    .sort((a, b) => {
      const windowDelta = (a.windowId ?? 0) - (b.windowId ?? 0);
      if (windowDelta !== 0) {
        return windowDelta;
      }
      const aIndex = tabsByGroup.get(/** @type {number} */ (a.id))?.[0]?.index ?? 0;
      const bIndex = tabsByGroup.get(/** @type {number} */ (b.id))?.[0]?.index ?? 0;
      return aIndex - bIndex;
    });

  /** @type {StoredGroup[]} */
  const storedGroups = [];
  /** @type {SavedTab[]} */
  const savedTabs = [];
  let skippedTabs = 0;
  let totalTabs = 0;

  for (const group of ordered) {
    if (storedGroups.length >= LIMITS.MAX_GROUPS_PER_SESSION) {
      break;
    }
    const groupTabs = tabsByGroup.get(/** @type {number} */ (group.id)) ?? [];
    const converted = convertGroup(group, groupTabs);
    if (converted.stored === null) {
      skippedTabs += converted.skippedTabs;
      continue;
    }
    if (totalTabs + converted.stored.tabs.length > LIMITS.MAX_TABS_PER_SESSION) {
      break;
    }
    skippedTabs += converted.skippedTabs;
    storedGroups.push(converted.stored);
    savedTabs.push(...converted.savedTabs);
    totalTabs += converted.stored.tabs.length;
  }

  return {
    session: { id: id ?? createSessionId(), createdAt, source, groups: storedGroups },
    savedTabs,
    skippedTabs,
  };
}

/**
 * @param {unknown} value
 * @param {number} now
 * @returns {number}
 */
function normalizeTimestamp(value, now) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return now;
  }
  // A timestamp from the future would outrank every genuine snapshot forever and
  // could push newer sessions out of the retention window, so it is clamped.
  const earliest = 1_000_000_000_000;
  if (value < earliest || value > now) {
    return now;
  }
  return Math.trunc(value);
}

/**
 * @param {unknown} value
 * @returns {StoredGroup | null}
 */
function validateGroup(value) {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = /** @type {Record<string, unknown>} */ (value);
  if (!Array.isArray(candidate.tabs)) {
    return null;
  }

  /** @type {StoredTab[]} */
  const tabs = [];
  for (const rawTab of candidate.tabs) {
    if (tabs.length >= LIMITS.MAX_TABS_PER_GROUP) {
      break;
    }
    if (typeof rawTab !== 'object' || rawTab === null) {
      continue;
    }
    const tabRecord = /** @type {Record<string, unknown>} */ (rawTab);
    const url = normalizeUrl(tabRecord.url);
    if (url === null) {
      continue;
    }
    tabs.push({ url, title: sanitizeText(tabRecord.title) });
  }

  if (tabs.length === 0) {
    return null;
  }
  return {
    title: sanitizeText(candidate.title),
    color: normalizeColor(candidate.color),
    collapsed: candidate.collapsed === true,
    tabs,
  };
}

/**
 * @param {readonly unknown[]} rawGroups
 * @returns {StoredGroup[]}
 */
function validateGroups(rawGroups) {
  /** @type {StoredGroup[]} */
  const groups = [];
  let totalTabs = 0;
  for (const rawGroup of rawGroups) {
    if (groups.length >= LIMITS.MAX_GROUPS_PER_SESSION) {
      break;
    }
    const group = validateGroup(rawGroup);
    if (group === null) {
      continue;
    }
    if (totalTabs + group.tabs.length > LIMITS.MAX_TABS_PER_SESSION) {
      break;
    }
    groups.push(group);
    totalTabs += group.tabs.length;
  }
  return groups;
}

/**
 * @param {unknown} value
 * @returns {'manual' | 'auto' | 'import'}
 */
function normalizeSource(value) {
  return typeof value === 'string' && SESSION_SOURCES.includes(value)
    ? /** @type {'manual' | 'auto' | 'import'} */ (value)
    : 'import';
}

/**
 * Derive an id from the session's contents alone.
 *
 * The timestamp is deliberately excluded: `normalizeTimestamp` substitutes the
 * current time for an out-of-range value, so including it would hand the same
 * session a different id on every read and make it impossible to restore or
 * delete from the UI.
 *
 * @param {unknown} value
 * @param {readonly StoredGroup[]} groups
 * @returns {string}
 */
function normalizeId(value, groups) {
  if (typeof value === 'string' && value.length > 0 && value.length <= 128) {
    return value;
  }
  return `s-${fingerprint(JSON.stringify(groups))}`;
}

/**
 * Validate and normalize an untrusted session object.
 *
 * Everything that cannot be made safe is dropped rather than repaired, so the
 * result is always a session that is safe to store and to restore.
 *
 * @param {unknown} value
 * @param {{ now?: number, source?: 'manual' | 'auto' | 'import' }} [options]
 * @returns {{ ok: true, session: Session } | { ok: false, error: string }}
 */
export function validateSession(value, options = {}) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'The session is not an object.' };
  }
  const candidate = /** @type {Record<string, unknown>} */ (value);
  if (!Array.isArray(candidate.groups)) {
    return { ok: false, error: 'The session has no groups array.' };
  }

  const groups = validateGroups(candidate.groups);
  if (groups.length === 0) {
    return { ok: false, error: 'The session contains no restorable tab group.' };
  }

  const createdAt = normalizeTimestamp(candidate.createdAt, options.now ?? Date.now());
  return {
    ok: true,
    session: {
      id: normalizeId(candidate.id, groups),
      createdAt,
      source: options.source ?? normalizeSource(candidate.source),
      groups,
    },
  };
}

/**
 * Serialize sessions into the on-disk export format.
 *
 * @param {readonly Session[]} sessions
 * @param {{ exportedAt?: number, version?: string }} [meta]
 * @returns {string} Pretty-printed JSON.
 */
export function serializeExport(sessions, meta = {}) {
  return `${JSON.stringify(
    {
      format: EXPORT_FORMAT,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: meta.exportedAt ?? Date.now(),
      appVersion: meta.version ?? '',
      sessions,
    },
    null,
    2,
  )}\n`;
}

/**
 * Parse and validate an exported file.
 *
 * @param {unknown} text Raw file contents.
 * @param {{ now?: number }} [options]
 * @returns {{ ok: true, sessions: Session[], rejected: number } | { ok: false, error: string }}
 */
export function parseExport(text, options = {}) {
  if (typeof text !== 'string') {
    return { ok: false, error: 'The file could not be read as text.' };
  }
  if (textEncoder.encode(text).length > LIMITS.MAX_IMPORT_BYTES) {
    return { ok: false, error: 'The file is larger than the 8 MB import limit.' };
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The file is not valid JSON.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'The file does not contain an export object.' };
  }

  const record = /** @type {Record<string, unknown>} */ (parsed);
  if (record.format !== EXPORT_FORMAT) {
    return { ok: false, error: 'The file was not exported by this extension.' };
  }
  const declaredSchema = record.schemaVersion;
  const schemaIsUsable =
    declaredSchema === undefined ||
    (typeof declaredSchema === 'number' &&
      Number.isInteger(declaredSchema) &&
      declaredSchema <= SCHEMA_VERSION);
  if (!schemaIsUsable) {
    return {
      ok: false,
      error: 'The file was written by a newer version of this extension. Update it first.',
    };
  }
  if (!Array.isArray(record.sessions)) {
    return { ok: false, error: 'The export contains no sessions array.' };
  }

  /** @type {Session[]} */
  const sessions = [];
  let rejected = 0;
  for (const rawSession of record.sessions.slice(0, LIMITS.MAX_IMPORT_SESSIONS)) {
    const result = validateSession(rawSession, { now: options.now, source: 'import' });
    if (!result.ok || estimateSessionBytes(result.session) > LIMITS.MAX_SESSION_BYTES) {
      rejected += 1;
      continue;
    }
    sessions.push(result.session);
  }
  rejected += Math.max(0, record.sessions.length - LIMITS.MAX_IMPORT_SESSIONS);

  if (sessions.length === 0) {
    return { ok: false, error: 'The export contains no restorable session.' };
  }
  return { ok: true, sessions, rejected };
}

/**
 * Keep the newest sessions per bucket so storage cannot grow without bound.
 *
 * Automatic backups are pruned independently from user-created ones, so a burst
 * of automatic snapshots can never evict a session the user saved on purpose.
 *
 * @param {readonly Session[]} sessions
 * @returns {Session[]} Newest first.
 */
export function pruneSessions(sessions) {
  const sorted = [...sessions].sort((a, b) => b.createdAt - a.createdAt);
  let autoKept = 0;
  let manualKept = 0;
  /** @type {Session[]} */
  const kept = [];
  for (const session of sorted) {
    if (session.source === 'auto') {
      if (autoKept >= LIMITS.MAX_AUTO_SESSIONS) {
        continue;
      }
      autoKept += 1;
    } else {
      if (manualKept >= LIMITS.MAX_MANUAL_SESSIONS) {
        continue;
      }
      manualKept += 1;
    }
    kept.push(session);
  }
  return kept;
}
