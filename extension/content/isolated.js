/*
 * Isolated-world sensor + relay.
 *   - merges signals from the MAIN-world sensor (content/main-world.js),
 *   - observes things the page cannot hide from an isolated world: real
 *     (trusted) escape attempts the page cancels, entering full screen,
 *   - snapshots the visible text, re-snapshotting when content changes late,
 *   - sends reports to the service worker and carries out its instructions
 *     ("probe" or "block").
 *
 * Performance: on every non-blob: document this script returns after one
 * protocol comparison. Nothing is read, observed or sent.
 */
(() => {
  'use strict';
  if (location.protocol !== 'blob:' || window.top !== window) return;

  // One live instance per document. This global lives in the extension's
  // isolated world, so the page can neither see nor forge it. An instance
  // orphaned by an extension reload reports itself as not alive.
  if (globalThis.__blgIsolated && globalThis.__blgIsolated.alive()) return;
  globalThis.__blgIsolated = {
    alive: () => {
      try {
        return !dead && !!chrome.runtime.id;
      } catch (_) {
        return false;
      }
    },
  };

  const EVT_STATE = '__blobLockGuard:state';
  const EVT_CMD = '__blobLockGuard:cmd';
  const MIN_REPORT_INTERVAL_MS = 250;
  const MUTATION_DEBOUNCE_MS = 400;
  const MAX_TEXT = 20000;

  const late = document.readyState !== 'loading';
  let main = {};
  const iso = { fullscreenEntered: 0, escapeBlocked: [], contextMenuBlockedTrusted: 0 };
  const arrival = readArrival();

  let blocked = false;
  let dead = false;
  let probeRequested = false;
  let inFlight = false;
  let pending = false;
  let timer = null;
  let lastReportAt = -Infinity;
  let lastFingerprint = '';
  let observer = null;

  function readArrival() {
    const out = { hasOpener: false, activationType: null, activationFromUrl: false, fromUrl: null };
    try {
      out.hasOpener = window.opener != null;
    } catch (_) {
      out.hasOpener = true; // cross-origin opener exists but is inaccessible
    }
    try {
      const act = typeof navigation !== 'undefined' && navigation.activation;
      if (act) {
        out.activationType = act.navigationType || null;
        out.activationFromUrl = !!(act.from && act.from.url);
        // The launcher page (same origin), used if the user chooses to reopen.
        out.fromUrl = (act.from && act.from.url) || null;
      }
    } catch (_) {
      /* Navigation API unavailable */
    }
    return out;
  }

  // Monotonic merge: a signal, once seen, is never "un-seen". A page that spoofs
  // our state event can therefore only add signals, never erase real ones.
  function merge(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) return [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])];
    if (typeof b === 'number') return Math.max(typeof a === 'number' ? a : 0, b);
    if (typeof b === 'boolean') return !!a || b;
    if (b && typeof b === 'object') {
      const out = a && typeof a === 'object' ? { ...a } : {};
      for (const k of Object.keys(b)) out[k] = merge(out[k], b[k]);
      return out;
    }
    return a === undefined ? b : a;
  }

  let lastUrgentKey = '0000';
  function urgentKey(m) {
    const api = m.api || {};
    const bursts = m.bursts || {};
    return [api.keyboardLock > 0, api.requestFullscreen > 0, bursts.dialogsMax10s >= 2, !!(m.probe && m.probe.done)].map(Number).join('');
  }

  function command(cmd) {
    window.dispatchEvent(new CustomEvent(EVT_CMD, { detail: JSON.stringify({ cmd }) }));
  }

  function escapeLabel(e) {
    const k = (e.key || '').toLowerCase();
    const mod = e.ctrlKey ? 'Ctrl+' : e.metaKey ? 'Cmd+' : '';
    if (k === 'escape') return 'Esc';
    if (k === 'f5' || k === 'f11' || k === 'f12') return k.toUpperCase();
    if (k === 'f4' && e.altKey) return 'Alt+F4';
    if (mod && ['r', 'l', 'w', 'q', 't', 'n'].includes(k)) return mod + k.toUpperCase();
    if (mod && e.shiftKey && k === 'i') return mod + 'Shift+I';
    return null;
  }

  function snapshot() {
    let text = '';
    try {
      const root = document.body || document.documentElement;
      text = (root && root.innerText) || '';
    } catch (_) {
      /* ignore */
    }
    return {
      v: 1,
      late,
      title: document.title || '',
      text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text,
      main,
      iso,
      arrival,
    };
  }

  function teardown() {
    dead = true;
    if (observer) observer.disconnect();
    if (timer) clearTimeout(timer);
  }

  async function send(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (_) {
      // Extension reloaded/uninstalled: this script is orphaned.
      teardown();
      return null;
    }
  }

  // urgent: send even while another report is in flight. Needed when the page
  // blocks its own event loop (alert() loops): promise callbacks never run there,
  // but a synchronous sendMessage() still reaches the service worker, which can
  // then navigate the tab without our help.
  function report(force, urgent) {
    if (blocked || dead) return;
    if (inFlight && !urgent) {
      pending = true;
      return;
    }
    const snap = snapshot();
    const fingerprint = JSON.stringify([snap.title, snap.text.length, snap.text.slice(0, 2000), main, iso]);
    if (!force && fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    inFlight = true;
    lastReportAt = Date.now();
    send({ type: 'blg:report', snapshot: snap }).then((resp) => {
      inFlight = false;
      if (!resp || dead) return;
      if (resp.action === 'block') {
        onBlock();
        return;
      }
      if (resp.action === 'probe' && !probeRequested) {
        probeRequested = true;
        command('probe'); // results come back as a state event -> new report
      }
      if (pending) {
        pending = false;
        schedule(0);
      }
    });
  }

  function schedule(delay) {
    if (blocked || dead || timer) return;
    const wait = Math.max(delay, MIN_REPORT_INTERVAL_MS - (Date.now() - lastReportAt), 0);
    timer = setTimeout(() => {
      timer = null;
      report(false);
    }, wait);
  }

  function onBlock() {
    if (blocked) return;
    blocked = true;
    if (observer) observer.disconnect();
    command('disarm');
    try {
      window.stop();
    } catch (_) {
      /* ignore */
    }
    try {
      // Take the lock screen off the screen immediately; the service worker is
      // navigating the tab to the warning page right after this.
      document.documentElement.replaceChildren();
    } catch (_) {
      /* ignore */
    }
    send({ type: 'blg:disarmed' });
  }

  // --- signal sources --------------------------------------------------------
  window.addEventListener(
    EVT_STATE,
    (e) => {
      if (typeof e.detail !== 'string') return;
      let s;
      try {
        s = JSON.parse(e.detail);
      } catch (_) {
        return;
      }
      if (!s || typeof s !== 'object') return;
      main = merge(main, s);
      // Urgent signals are reported synchronously, once each, when they first
      // appear (dialog loops block the event loop, so timers would never fire).
      const key = urgentKey(main);
      if (key !== lastUrgentKey) {
        lastUrgentKey = key;
        report(false, true);
      } else {
        schedule(150);
      }
    },
    true,
  );

  document.addEventListener(
    'fullscreenchange',
    () => {
      if (document.fullscreenElement) {
        iso.fullscreenEntered += 1;
        schedule(0);
      }
    },
    true,
  );

  // Real user escape attempts that the page cancels are the strongest evidence
  // of a trap. Checked after dispatch so page listeners have run.
  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted) return;
      const label = escapeLabel(e);
      if (!label) return;
      setTimeout(() => {
        if (e.defaultPrevented && !iso.escapeBlocked.includes(label)) {
          iso.escapeBlocked.push(label);
          schedule(0);
        }
      }, 0);
    },
    true,
  );
  window.addEventListener(
    'contextmenu',
    (e) => {
      if (!e.isTrusted) return;
      setTimeout(() => {
        if (e.defaultPrevented) {
          iso.contextMenuBlockedTrusted += 1;
          schedule(0);
        }
      }, 0);
    },
    true,
  );

  // If the browser ever restores this document from the back/forward cache
  // after we blocked it, send the tab back to the warning page.
  window.addEventListener(
    'pageshow',
    (e) => {
      if (e.persisted && blocked) send({ type: 'blg:report', snapshot: { ...snapshot(), neutralized: true } });
    },
    true,
  );

  function start() {
    report(true);
    observer = new MutationObserver(() => schedule(MUTATION_DEBOUNCE_MS));
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  command('announce'); // handshake: MAIN may have been injected before us
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
