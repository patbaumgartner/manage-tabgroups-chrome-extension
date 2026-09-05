/**
 * Minimal DOM helpers.
 *
 * Every node is built from `createElement` and `textContent`; the extension never
 * assigns `innerHTML`, so a hostile page title cannot become markup.
 */

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {object} [options]
 * @param {string} [options.className]
 * @param {string} [options.text]
 * @param {Record<string, string>} [options.attrs]
 * @param {readonly Node[]} [options.children]
 * @returns {HTMLElementTagNameMap[K]}
 */
export function el(tag, options = {}) {
  const node = document.createElement(tag);
  if (options.className !== undefined) {
    node.className = options.className;
  }
  if (options.text !== undefined) {
    node.textContent = options.text;
  }
  if (options.attrs !== undefined) {
    for (const [name, value] of Object.entries(options.attrs)) {
      node.setAttribute(name, value);
    }
  }
  if (options.children !== undefined) {
    node.append(...options.children);
  }
  return node;
}

/**
 * @param {Element} node
 * @returns {void}
 */
export function clearChildren(node) {
  node.replaceChildren();
}

/**
 * Look up a required element and fail loudly when the markup drifts.
 *
 * @template {Element} T
 * @param {string} selector
 * @param {new () => T} type
 * @returns {T}
 */
export function requireElement(selector, type) {
  const node = document.querySelector(selector);
  if (!(node instanceof type)) {
    throw new Error(`Missing element: ${selector}`);
  }
  return node;
}

/**
 * Turn a button into a two-step confirmation without using `confirm()`, which
 * Chrome suppresses inside extension popups.
 *
 * @param {HTMLButtonElement} button
 * @param {string} confirmLabel
 * @param {() => void} onConfirm
 * @param {number} [timeoutMs]
 * @returns {void}
 */
export function armConfirmButton(button, confirmLabel, onConfirm, timeoutMs = 4000) {
  if (button.dataset.armed === 'true') {
    button.dataset.armed = 'false';
    onConfirm();
    return;
  }
  const originalLabel = button.textContent ?? '';
  button.dataset.armed = 'true';
  button.textContent = confirmLabel;
  button.classList.add('is-armed');
  globalThis.setTimeout(() => {
    if (button.dataset.armed !== 'true') {
      return;
    }
    button.dataset.armed = 'false';
    button.textContent = originalLabel;
    button.classList.remove('is-armed');
  }, timeoutMs);
}
