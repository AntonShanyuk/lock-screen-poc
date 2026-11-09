/*
 * Registered at runtime (chrome.scripting.registerContentScripts, MAIN world,
 * document_start, persistAcrossSessions: false) for origins the user chose to
 * trust from the warning page. It runs before any page script and switches the
 * MAIN-world sensor into "defanged" mode: the page is shown, but it cannot
 * raise "Leave site?" prompts or lock the keyboard.
 *
 * Both orders work: the marker covers "this script ran before main-world.js",
 * the command covers "after". A page can only ever defang itself with these.
 */
(() => {
  'use strict';
  if (location.protocol !== 'blob:' || window.top !== window) return;
  try {
    Object.defineProperty(window, '__blobLockGuardDefang', { value: true });
  } catch (_) {
    /* already set */
  }
  window.dispatchEvent(new CustomEvent('__blobLockGuard:cmd', { detail: JSON.stringify({ cmd: 'defang' }) }));
})();
