/**
 * Typed wrapper around `chrome.runtime.sendMessage`.
 *
 * The service worker always answers with `{ ok, data }` or `{ ok, error }`;
 * this turns the failure envelope into a rejected promise so callers can use a
 * plain `try`/`catch`.
 */

/**
 * @param {string} type
 * @param {Record<string, unknown>} [payload]
 * @returns {Promise<unknown>}
 */
export async function request(type, payload = {}) {
  /** @type {unknown} */
  const response = await chrome.runtime.sendMessage({ ...payload, type });
  if (typeof response !== 'object' || response === null) {
    return Promise.reject(new Error('The extension did not respond. Try reloading it.'));
  }
  const envelope = /** @type {{ ok?: unknown, data?: unknown, error?: unknown }} */ (response);
  if (envelope.ok !== true) {
    const message = typeof envelope.error === 'string' ? envelope.error : 'Something went wrong.';
    return Promise.reject(new Error(message));
  }
  return envelope.data;
}

/**
 * The browser window the current extension page belongs to.
 *
 * @returns {Promise<number | undefined>}
 */
export async function currentWindowId() {
  try {
    const window = await chrome.windows.getCurrent();
    return typeof window.id === 'number' ? window.id : undefined;
  } catch {
    return undefined;
  }
}
