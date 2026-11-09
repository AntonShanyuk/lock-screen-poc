/*
 * Blob lock-screen detector — pure decision logic (no browser APIs).
 *
 * Loaded by the service worker via importScripts() and by Node unit tests via
 * require(). Content scripts do NOT load this file: they only collect signals,
 * so the code injected into every page stays a few lines long.
 *
 * The decision combines three independent signal groups:
 *   1. content  — does the document read like a fake OS/vendor lock screen?
 *   2. traps    — does the page try to stop the user from leaving?
 *   3. arrival  — did the page open itself without user involvement?
 * Being a blob: document is only the gate that decides whether we look at all.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BlobLockDetector = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Tunables. Every number here is exercised by tests/unit/detector.test.js.
  // ---------------------------------------------------------------------------
  const THRESHOLDS = Object.freeze({
    probe: 3, // content score at which the page is probed for escape blocking
    contentWithTraps: 5, // rule "content+traps": content >= 5 and trap >= 2
    trapsWithContent: 2,
    contentWithStrongTrap: 4, // rule "strong-trap": strong trap, trap >= 2, content >= 4 (+ lock/threat wording)
    contentBlatant: 8, // rule "blatant-auto-open": content >= 8 with lock wording, page opened itself
    dialogBurst: 2, // >= 2 alert/confirm/prompt within 10 s (the user only has to dismiss one)
    historyBurst: 10, // >= 10 pushState/replaceState within 2 s
    historyTotal: 25,
    popupTotal: 3,
  });

  const MAX_TEXT = 20000;
  const MAX_EVIDENCE = 60;

  // ---------------------------------------------------------------------------
  // Text normalisation
  // ---------------------------------------------------------------------------
  // Common Cyrillic/Greek look-alikes used to dodge keyword filters ("Micrоsoft").
  const HOMOGLYPHS = {
    а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ӏ: 'l', һ: 'h', ԛ: 'q', ԝ: 'w',
    А: 'a', В: 'b', Е: 'e', К: 'k', М: 'm', Н: 'h', О: 'o', Р: 'p', С: 'c', Т: 't', Х: 'x', І: 'i', Ѕ: 's',
    α: 'a', ο: 'o', ρ: 'p', ν: 'v', τ: 't', ι: 'i', κ: 'k', Α: 'a', Β: 'b', Ε: 'e', Ζ: 'z', Η: 'h', Ι: 'i', Κ: 'k', Μ: 'm', Ν: 'n', Ο: 'o', Ρ: 'p', Τ: 't', Χ: 'x', Υ: 'y',
  };
  const HOMOGLYPH_RE = new RegExp('[' + Object.keys(HOMOGLYPHS).join('') + ']', 'g');
  const INVISIBLE_RE = /[­​-‏⁠-⁤﻿]/g;

  function normalizeText(input) {
    if (typeof input !== 'string' || input.length === 0) return '';
    let s = input.length > MAX_TEXT ? input.slice(0, MAX_TEXT) : input;
    try {
      s = s.normalize('NFKC');
    } catch (_) {
      /* ignore */
    }
    return s
      .replace(INVISIBLE_RE, '')
      .replace(HOMOGLYPH_RE, (c) => HOMOGLYPHS[c])
      .replace(/[‘’‛′]/g, "'")
      .replace(/[‐-―−]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  // ---------------------------------------------------------------------------
  // Phone numbers
  // ---------------------------------------------------------------------------
  // Separators are required between groups so order numbers / IDs / hex error
  // codes (0x800704cf) are not mistaken for phone numbers.
  const PHONE_PATTERNS = [
    // North American: 1-800-555-0199, (888) 555 0100, +1 844.555.0123
    /(?:\+?1[\s.-]?)?\(?\b[2-9]\d{2}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g,
    // International with explicit +: +44 20 7946 0958, +61 2 5550 1234
    /\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]\d{2,4}){2,4}\b/g,
    // European toll-free style: 0800 123 4567, 0808-555-0199
    /\b0[89]0\d[\s.-]\d{3}[\s.-]?\d{3,4}\b/g,
  ];

  function findPhoneNumbers(text) {
    if (typeof text !== 'string' || !text) return [];
    const found = new Set();
    for (const re of PHONE_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const digits = m[0].replace(/\D/g, '');
        if (digits.length >= 10 && digits.length <= 15) found.add(m[0].trim());
      }
    }
    return [...found];
  }

  // ---------------------------------------------------------------------------
  // Content scoring
  // ---------------------------------------------------------------------------
  const DEVICE = '(?:computer|device|pc|system|laptop|mac|macbook|windows|browser|screen|access|account)';
  const CONTENT_RULES = {
    lock: [
      new RegExp(`\\b${DEVICE}\\s+(?:has|have|is|was|were)\\s+(?:been\\s+)?(?:temporarily\\s+)?(?:locked|blocked|suspended|disabled|frozen|restricted)\\b`),
      /\b(?:locked|blocked|suspended|disabled)\s+(?:your|this)\s+(?:computer|device|pc|system|browser|mac|laptop)\b/,
      /\b(?:computer|device|pc|system|mac|laptop|windows)\s+(?:is\s+)?locked\b/,
      /\bdo\s+not\s+(?:restart|reboot|shut\s*down|turn\s+off|power\s+off|close\s+this\s+(?:window|page|tab|browser))\b/,
    ],
    threat: [
      /\b(?:virus(?:es)?|malware|trojan|spyware|ransomware|adware|keylogger|rootkit|zeus)\b/,
      /\binfect(?:ed|ion|ions)\b/,
      /\bhack(?:ed|er|ers)\b/,
      /\bsecurity\s+(?:alert|warning|breach|threat|risk|violation)\b/,
      /\b(?:suspicious|unusual|illegal|unauthori[sz]ed|malicious)\s+(?:activity|access|login|connection|traffic)\b/,
      /\b(?:files|data|information|passwords?|credit\s+cards?|photos|banking|identity|accounts?)\b[^.!?]{0,40}\b(?:at\s+risk|compromised|stolen|exposed|deleted|leaked)\b/,
      /\bip\s+address\b/,
    ],
    cta: [
      /\bcall\b[^.!?\n]{0,40}\b(?:microsoft|apple|windows|google|support|technician|helpline|help\s*desk|toll[\s-]*free|immediately|right\s+away)\b/,
      /\b(?:toll[\s-]*free|helpline|tech(?:nical)?\s+support|support\s+(?:number|team|line|hotline)|certified\s+technicians?)\b/,
      /\bcontact\s+(?:microsoft|apple|windows|google|the)?\s*support\b/,
    ],
    brand: [/\b(?:microsoft|windows|apple|macos|mac\s?os|icloud|defender|norton|mcafee|avast|kaspersky|bitdefender)\b/g],
    errorCode: [/\b0x[0-9a-f]{6,8}\b/, /\berror\s*(?:code|#|no\.?)\s*[:#]?\s*[a-z0-9][\w-]*/],
  };
  const TITLE_ALARM = /\b(?:alert|warning|security|virus|locked|error|threat|blocked|critical|infected)\b/;

  const CONTENT_LABELS = {
    lock: 'Lock-screen wording',
    threat: 'Scareware wording',
    cta: 'Pushes you to call "support"',
    phone: 'Shows a phone number',
    brand: 'Impersonates',
    errorCode: 'Fake error code',
    titleAlarm: 'Alarming page title',
  };

  // One hit per rule; a /g rule contributes every distinct match (e.g. all brands named).
  function matchAll(rules, text) {
    const hits = [];
    for (const re of rules) {
      if (re.global) {
        for (const m of new Set(text.match(re) || [])) hits.push(m.slice(0, MAX_EVIDENCE));
      } else {
        const m = re.exec(text);
        if (m) hits.push(m[0].slice(0, MAX_EVIDENCE));
      }
    }
    return hits;
  }

  function scoreContent(input) {
    const title = normalizeText((input && input.title) || '');
    const body = normalizeText((input && input.text) || '');
    const text = `${title} ${body}`.trim();

    const hits = {
      lock: matchAll(CONTENT_RULES.lock, text),
      threat: matchAll(CONTENT_RULES.threat, text),
      cta: matchAll(CONTENT_RULES.cta, text),
      phone: findPhoneNumbers(text),
      brand: matchAll(CONTENT_RULES.brand, text),
      errorCode: matchAll(CONTENT_RULES.errorCode, text),
      titleAlarm: title && TITLE_ALARM.test(title) ? [title.slice(0, MAX_EVIDENCE)] : [],
    };

    const points = {
      lock: hits.lock.length ? 3 : 0,
      threat: hits.threat.length >= 2 ? 2 : hits.threat.length,
      cta: hits.cta.length ? 2 : 0,
      phone: hits.phone.length ? 2 : 0,
      brand: hits.brand.length ? 1 : 0,
      errorCode: hits.errorCode.length ? 1 : 0,
      titleAlarm: hits.titleAlarm.length ? 1 : 0,
    };
    const score = Object.values(points).reduce((a, b) => a + b, 0);

    const reasons = [];
    for (const key of Object.keys(points)) {
      if (!points[key]) continue;
      // Drop quotes contained in a longer one ("0x800704cf" inside "error code: 0x800704cf").
      const unique = [...new Set(hits[key])];
      const evidence = unique
        .filter((e) => !unique.some((o) => o !== e && o.includes(e)))
        .slice(0, 2)
        .map((e) => `“${e}”`)
        .join(', ');
      reasons.push(`${CONTENT_LABELS[key]}: ${evidence}`);
    }

    return {
      score,
      points,
      hits,
      has: { lock: points.lock > 0, threat: points.threat > 0, phone: points.phone > 0, cta: points.cta > 0 },
      reasons,
    };
  }

  // ---------------------------------------------------------------------------
  // Trap scoring
  // ---------------------------------------------------------------------------
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

  function scoreTraps(main, iso) {
    const m = main || {};
    const i = iso || {};
    const api = m.api || {};
    const bursts = m.bursts || {};
    const listeners = m.listeners || {};
    const probe = m.probe || {};

    const items = [];
    const add = (id, weight, reason, strong = false) => items.push({ id, weight, reason, strong });

    const probedKeys = Array.isArray(probe.blockedKeys) ? probe.blockedKeys : [];
    const userKeys = Array.isArray(i.escapeBlocked) ? i.escapeBlocked : [];
    const keys = [...new Set([...probedKeys, ...userKeys])];
    if (keys.length) add('escape-keys', keys.length >= 3 ? 2 : 1, `Blocks escape keys: ${keys.slice(0, 8).join(', ')}`);
    if (userKeys.length) add('user-escape-blocked', 2, 'Cancelled your attempt to leave with the keyboard', true);

    if (probe.contextMenuBlocked || num(i.contextMenuBlockedTrusted) > 0) add('context-menu', 1, 'Blocks right-click');
    if (probe.beforeUnloadCanceled || probe.onbeforeunloadSet || num(listeners.beforeunload) > 0) {
      add('beforeunload', 1, 'Tries to stop you leaving the page ("Leave site?" prompt)');
    }
    if (num(api.requestFullscreen) > 0 || num(i.fullscreenEntered) > 0) add('fullscreen', 2, 'Forces full screen to hide the browser', true);
    if (num(api.keyboardLock) > 0) add('keyboard-lock', 3, 'Locks the keyboard (Keyboard Lock API)', true);
    if (num(api.pointerLock) > 0) add('pointer-lock', 1, 'Captures the mouse pointer');
    if (num(bursts.dialogsMax10s) >= THRESHOLDS.dialogBurst) add('dialog-loop', 2, 'Shows pop-up dialogs in a loop', true);
    if (num(bursts.historyMax2s) >= THRESHOLDS.historyBurst || num(api.pushState) >= THRESHOLDS.historyTotal) {
      add('history-flood', 2, 'Floods browser history to break the Back button', true);
    }
    if (num(api.open) >= THRESHOLDS.popupTotal) add('popup-flood', 1, 'Opens pop-up windows repeatedly');

    return {
      score: items.reduce((a, it) => a + it.weight, 0),
      strong: items.some((it) => it.strong),
      items,
      ids: items.map((it) => it.id),
      reasons: items.map((it) => it.reason),
    };
  }

  // ---------------------------------------------------------------------------
  // Arrival scoring
  // ---------------------------------------------------------------------------
  // `arrival` comes from inside the blob document; `nav` from chrome.webNavigation.
  // "autoReplaced": the page replaced its own history entry with the blob while
  // loading (no user gesture, per the HTML spec) and was not opened by a click
  // into a new tab.
  function scoreArrival(arrival, nav) {
    const a = arrival || {};
    const n = nav || null;
    const openedAsNewTab = !!a.hasOpener || (n !== null && n.openerTabId != null);
    const replacedSelf = a.activationType === 'replace' && !!a.activationFromUrl;
    const clientRedirect = n ? !!n.clientRedirect : null;
    const autoReplaced = replacedSelf && !openedAsNewTab && clientRedirect !== false;
    const reasons = [];
    if (autoReplaced) reasons.push('Opened itself without a click (script redirect into a generated blob: page)');
    return { autoReplaced, openedAsNewTab, clientRedirect, reasons };
  }

  // ---------------------------------------------------------------------------
  // Decision
  // ---------------------------------------------------------------------------
  function evaluate(snapshot, nav) {
    const s = snapshot || {};
    const content = scoreContent({ title: s.title, text: s.text });
    const traps = scoreTraps(s.main, s.iso);
    const arrival = scoreArrival(s.arrival, nav);

    const probeDone = !!(s.main && s.main.probe && s.main.probe.done);
    const needsProbe = !probeDone && content.score >= THRESHOLDS.probe;

    let rule = null;
    if (traps.score >= THRESHOLDS.trapsWithContent && content.score >= THRESHOLDS.contentWithTraps) {
      rule = 'content+traps';
    } else if (
      traps.strong &&
      traps.score >= THRESHOLDS.trapsWithContent &&
      content.score >= THRESHOLDS.contentWithStrongTrap &&
      (content.has.lock || content.has.threat)
    ) {
      rule = 'strong-trap';
    } else if (!needsProbe && content.score >= THRESHOLDS.contentBlatant && content.has.lock && arrival.autoReplaced) {
      // Content + arrival only, and only once the trap probes have run: trap
      // evidence is always gathered first, arrival never decides on its own.
      rule = 'blatant-auto-open';
    }

    const block = rule !== null;
    return {
      block,
      rule,
      needsProbe: !block && needsProbe,
      contentScore: content.score,
      trapScore: traps.score,
      strongTrap: traps.strong,
      trapIds: traps.ids,
      reasons: block ? [...content.reasons, ...traps.reasons, ...arrival.reasons] : [],
      details: { content, traps, arrival },
    };
  }

  // ---------------------------------------------------------------------------
  // URL helpers
  // ---------------------------------------------------------------------------
  /** The gate: only top-level blob: documents are inspected. */
  function shouldInspect(url, frameId) {
    return typeof url === 'string' && url.startsWith('blob:') && (frameId === undefined || frameId === 0);
  }

  /** "blob:https://evil.example/uuid" -> "https://evil.example" (the site that generated it). */
  function blobCreatorOrigin(url) {
    if (typeof url !== 'string' || !url.startsWith('blob:')) return null;
    const inner = url.slice(5);
    if (inner.startsWith('null/')) return null;
    try {
      const origin = new URL(inner).origin;
      return origin && origin !== 'null' ? origin : null;
    } catch (_) {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // False-positive override ("I trust this site — reopen the page")
  // ---------------------------------------------------------------------------
  /** Match pattern for exactly one origin, port included: "http://127.0.0.1:8080" -> "http://127.0.0.1:8080/*". */
  function allowPatternFor(origin) {
    if (typeof origin !== 'string') return null;
    let u;
    try {
      u = new URL(origin);
    } catch (_) {
      return null;
    }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.origin !== origin) return null;
    return `${origin}/*`;
  }

  /** Is `origin` covered by one of the allow-list match patterns produced by allowPatternFor()? */
  function isOriginAllowed(origin, patterns) {
    const pattern = allowPatternFor(origin);
    return !!pattern && Array.isArray(patterns) && patterns.includes(pattern);
  }

  /**
   * Where "reopen" should go. The blob document usually died with the page that
   * created it, so the launcher page (same origin, reported by the browser via
   * navigation.activation) is preferred; the blob URL is used when no launcher
   * is known (e.g. it was opened into a new tab). Anything cross-origin is rejected.
   */
  function reopenPlan(blobUrl, fromUrl) {
    const origin = blobCreatorOrigin(blobUrl);
    if (!origin || !allowPatternFor(origin)) return null;
    let target = blobUrl;
    if (typeof fromUrl === 'string') {
      try {
        const from = new URL(fromUrl);
        if (from.origin === origin) target = from.href;
      } catch (_) {
        /* keep the blob URL */
      }
    }
    return { origin, pattern: allowPatternFor(origin), target };
  }

  return {
    THRESHOLDS,
    allowPatternFor,
    isOriginAllowed,
    reopenPlan,
    normalizeText,
    findPhoneNumbers,
    scoreContent,
    scoreTraps,
    scoreArrival,
    evaluate,
    shouldInspect,
    blobCreatorOrigin,
  };
});
