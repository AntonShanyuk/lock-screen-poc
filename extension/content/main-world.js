/*
 * MAIN-world sensor. Runs in the page's own JavaScript context so it can
 *   - observe trapping APIs as the page calls them (hooks installed at document_start,
 *     before any page script),
 *   - probe whether the page cancels escape keys / right-click / unload,
 *   - disarm the page's traps right before the extension navigates away.
 *
 * It never decides anything: it reports raw signals to the isolated-world script
 * (content/isolated.js) through DOM events, and the service worker decides.
 *
 * Performance: on every non-blob: document this script returns after one
 * protocol comparison. Nothing is patched, read or registered.
 */
(() => {
  'use strict';
  if (location.protocol !== 'blob:' || window.top !== window) return;

  const EVT_STATE = '__blobLockGuard:state';
  const EVT_CMD = '__blobLockGuard:cmd';

  // Keep pristine references: the page may overwrite globals later.
  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeDispatch = EventTarget.prototype.dispatchEvent;
  const defineProperty = Object.defineProperty;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const NativeCustomEvent = CustomEvent;
  const NativeKeyboardEvent = KeyboardEvent;
  const NativeMouseEvent = MouseEvent;
  const NativeEvent = Event;
  const nativeSetTimeout = setTimeout;
  const now = () => performance.now();

  const WATCHED_LISTENERS = new Set(['keydown', 'keyup', 'keypress', 'contextmenu', 'beforeunload']);

  const state = {
    v: 1,
    late: document.readyState !== 'loading', // injected after the page had already loaded
    listeners: {},
    api: {},
    bursts: { dialogsMax10s: 0, historyMax2s: 0 },
    probe: null,
    disarmed: false, // the extension is about to navigate away: all traps off
    defanged: false, // the user trusted this origin: page shown, but no "Leave site?" / keyboard lock
  };
  const SKIP = Symbol('skip'); // a hook's way of saying "don't call the original"
  const recent = { dialogs: [], history: [] };

  // --- reporting ------------------------------------------------------------
  let lastAnnounce = -Infinity;
  let trailing = null;
  function emit() {
    lastAnnounce = now();
    try {
      nativeDispatch.call(window, new NativeCustomEvent(EVT_STATE, { detail: stringify(state) }));
    } catch (_) {
      /* ignore */
    }
  }
  // urgent=true dispatches synchronously (needed when the page is about to block
  // the event loop, e.g. inside an alert() loop). Otherwise throttle to 1 per 100 ms.
  function announce(urgent) {
    if (urgent || now() - lastAnnounce > 100) {
      emit();
      return;
    }
    if (trailing === null) {
      trailing = nativeSetTimeout(() => {
        trailing = null;
        emit();
      }, 100);
    }
  }

  function bump(group, key) {
    state[group][key] = (state[group][key] || 0) + 1;
  }
  function burst(list, windowMs) {
    const t = now();
    list.push(t);
    while (list.length && t - list[0] > windowMs) list.shift();
    return list.length;
  }

  // --- hooks ----------------------------------------------------------------
  function wrap(target, name, before) {
    // Find the object that actually owns the property (window methods may live
    // on the instance or on Window.prototype depending on the engine).
    let obj = target;
    let desc;
    while (obj && !(desc = getOwnPropertyDescriptor(obj, name))) obj = Object.getPrototypeOf(obj);
    if (!desc || typeof desc.value !== 'function') return;
    const original = desc.value;
    // Method shorthand: keeps .name, is not a constructor, like native methods.
    // `before` records the call; it may rewrite `args`, or return
    // { [SKIP]: true, value } to replace the call entirely.
    const wrapped = {
      [name](...args) {
        let override;
        try {
          override = before(this, args);
        } catch (_) {
          /* never break the page */
        }
        if (override && override[SKIP]) return override.value;
        return original.apply(this, args);
      },
    }[name];
    try {
      defineProperty(obj, name, { ...desc, value: wrapped });
    } catch (_) {
      /* ignore */
    }
  }

  wrap(EventTarget.prototype, 'addEventListener', (_target, [type]) => {
    if (typeof type === 'string' && WATCHED_LISTENERS.has(type)) {
      bump('listeners', type);
      announce(false);
    }
  });

  const onFullscreen = (_el, args) => {
    const options = args[0];
    bump('api', 'requestFullscreen');
    if (options && options.keyboardLock) {
      bump('api', 'keyboardLock');
      // Defanged: full screen is allowed (slides, kiosks), keyboard lock is not.
      if (state.defanged) args[0] = { ...options, keyboardLock: undefined };
    }
    announce(true);
  };
  for (const name of ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen']) {
    wrap(Element.prototype, name, onFullscreen);
  }
  if (typeof Keyboard !== 'undefined') {
    wrap(Keyboard.prototype, 'lock', () => {
      bump('api', 'keyboardLock');
      announce(true);
      // Defanged: pretend success, lock nothing.
      if (state.defanged) return { [SKIP]: true, value: Promise.resolve() };
      return undefined;
    });
  }
  wrap(Element.prototype, 'requestPointerLock', () => {
    bump('api', 'pointerLock');
    announce(true);
  });

  for (const name of ['alert', 'confirm', 'prompt', 'print']) {
    wrap(window, name, () => {
      bump('api', name);
      if (name !== 'print') {
        const n = burst(recent.dialogs, 10000);
        if (n > state.bursts.dialogsMax10s) state.bursts.dialogsMax10s = n;
      }
      // Synchronous: the dialog is about to block the page's event loop.
      announce(true);
    });
  }

  for (const name of ['pushState', 'replaceState']) {
    wrap(History.prototype, name, () => {
      bump('api', name);
      const n = burst(recent.history, 2000);
      if (n > state.bursts.historyMax2s) state.bursts.historyMax2s = n;
      announce(false);
    });
  }

  wrap(window, 'open', () => {
    bump('api', 'open');
    announce(false);
  });

  // First capture listener on window: once disarmed (or defanged), it stops
  // every page beforeunload handler, so no "Leave site?" prompt can appear.
  nativeAdd.call(
    window,
    'beforeunload',
    (e) => {
      if (state.disarmed || state.defanged) e.stopImmediatePropagation();
    },
    true,
  );

  const attempt = (fn) => {
    try {
      fn();
    } catch (_) {
      /* best effort */
    }
  };

  function neutraliseBeforeUnload() {
    attempt(() => {
      window.onbeforeunload = null;
    });
    // Also covers handlers we could not stop (e.g. registered before a late injection).
    attempt(() => defineProperty(BeforeUnloadEvent.prototype, 'returnValue', { configurable: true, get: () => '', set: () => {} }));
    attempt(() => defineProperty(BeforeUnloadEvent.prototype, 'preventDefault', { configurable: true, writable: true, value: function preventDefault() {} }));
  }

  // --- probes ---------------------------------------------------------------
  // Synthetic, cancelable events dispatched where page handlers listen. If the
  // page calls preventDefault() (or returns false), dispatchEvent returns false.
  // Probes are only requested by the service worker once the content already
  // looks suspicious, so ordinary blob previews never receive them.
  const KEY_PROBES = [
    ['Esc', { key: 'Escape', code: 'Escape', keyCode: 27 }],
    ['F5', { key: 'F5', code: 'F5', keyCode: 116 }],
    ['F11', { key: 'F11', code: 'F11', keyCode: 122 }],
    ['F12', { key: 'F12', code: 'F12', keyCode: 123 }],
    ['Ctrl+R', { key: 'r', code: 'KeyR', keyCode: 82, ctrlKey: true }],
    ['Cmd+R', { key: 'r', code: 'KeyR', keyCode: 82, metaKey: true }],
    ['Ctrl+L', { key: 'l', code: 'KeyL', keyCode: 76, ctrlKey: true }],
    ['Cmd+L', { key: 'l', code: 'KeyL', keyCode: 76, metaKey: true }],
    ['Ctrl+W', { key: 'w', code: 'KeyW', keyCode: 87, ctrlKey: true }],
    ['Cmd+W', { key: 'w', code: 'KeyW', keyCode: 87, metaKey: true }],
    ['Cmd+Q', { key: 'q', code: 'KeyQ', keyCode: 81, metaKey: true }],
    ['Alt+F4', { key: 'F4', code: 'F4', keyCode: 115, altKey: true }],
    ['Ctrl+Shift+I', { key: 'I', code: 'KeyI', keyCode: 73, ctrlKey: true, shiftKey: true }],
  ];

  function legacy(ev, props) {
    for (const [k, v] of Object.entries(props)) {
      try {
        defineProperty(ev, k, { get: () => v, configurable: true });
      } catch (_) {
        /* ignore */
      }
    }
    return ev;
  }

  function probe() {
    const target = document.body || document.documentElement;
    if (!target) return;
    const blockedKeys = [];
    for (const [label, init] of KEY_PROBES) {
      const ev = legacy(
        new NativeKeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true, composed: true, view: window }),
        { keyCode: init.keyCode, which: init.keyCode },
      );
      let notCancelled = true;
      try {
        notCancelled = nativeDispatch.call(target, ev);
      } catch (_) {
        /* a throwing page handler still counts as "not cancelled" */
      }
      if (!notCancelled || ev.defaultPrevented) blockedKeys.push(label);
    }

    let contextMenuBlocked = false;
    try {
      const ev = legacy(
        new NativeMouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          composed: true,
          button: 2,
          buttons: 2,
          clientX: Math.round(innerWidth / 2),
          clientY: Math.round(innerHeight / 2),
          view: window,
        }),
        { which: 3 },
      );
      contextMenuBlocked = !nativeDispatch.call(target, ev) || ev.defaultPrevented;
    } catch (_) {
      /* ignore */
    }

    let beforeUnloadCanceled = false;
    try {
      const ev = new NativeEvent('beforeunload', { cancelable: true });
      beforeUnloadCanceled = !nativeDispatch.call(window, ev) || ev.defaultPrevented;
    } catch (_) {
      /* ignore */
    }

    state.probe = {
      done: true,
      blockedKeys,
      contextMenuBlocked,
      beforeUnloadCanceled,
      onbeforeunloadSet: typeof window.onbeforeunload === 'function',
    };
    announce(true);
  }

  // --- disarm ---------------------------------------------------------------
  function disarm() {
    if (state.disarmed) return;
    state.disarmed = true;
    neutraliseBeforeUnload();
    attempt(() => document.fullscreenElement && document.exitFullscreen());
    attempt(() => document.webkitFullscreenElement && document.webkitExitFullscreen());
    attempt(() => navigator.keyboard && navigator.keyboard.unlock());
    attempt(() => document.pointerLockElement && document.exitPointerLock());
    for (const name of ['alert', 'confirm', 'prompt', 'print']) {
      attempt(() => defineProperty(window, name, { configurable: true, writable: true, value: () => (name === 'confirm' ? false : name === 'prompt' ? null : undefined) }));
    }
    attempt(() => defineProperty(window, 'open', { configurable: true, writable: true, value: () => null }));
    for (const name of ['pushState', 'replaceState']) {
      attempt(() => defineProperty(History.prototype, name, { configurable: true, writable: true, value: () => undefined }));
    }
    attempt(() => {
      for (const media of document.querySelectorAll('audio, video')) {
        media.muted = true;
        media.pause();
      }
    });
    announce(true);
  }

  // --- defang (origin trusted by the user) -------------------------------------
  // The page keeps working, including full screen, but cannot hold the user:
  // no "Leave site?" prompt, no keyboard lock. Dialog loops are handled by the
  // service worker, which still replaces a tab frozen by one.
  function defang() {
    if (state.defanged) return;
    state.defanged = true;
    neutraliseBeforeUnload();
    attempt(() => navigator.keyboard && navigator.keyboard.unlock());
    announce(true);
  }

  // --- commands from the isolated world (and allow-defang.js) ---------------------
  nativeAdd.call(
    window,
    EVT_CMD,
    (e) => {
      let cmd;
      try {
        cmd = parse(e.detail).cmd;
      } catch (_) {
        return;
      }
      if (cmd === 'announce') announce(true);
      else if (cmd === 'probe') probe();
      else if (cmd === 'disarm') disarm();
      else if (cmd === 'defang') defang();
    },
    true,
  );

  // allow-defang.js may have run before this script (registration order is not guaranteed).
  attempt(() => window.__blobLockGuardDefang === true && defang());

  announce(true);
})();
