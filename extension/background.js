/*
 * Service worker: the only place that decides and acts.
 *
 *  - webNavigation listeners (filtered to blob: URLs, so ordinary browsing never
 *    wakes this worker) record how a blob document arrived.
 *  - Content scripts in blob: documents send reports; the detector scores them.
 *  - On a "block" verdict: the page disarms itself, the tab is muted and
 *    navigated to the extension's warning page.
 *  - On install/update, tabs that are already open are swept, so a user who is
 *    already stuck on a lock screen is rescued too.
 */
'use strict';

importScripts('lib/detector.js');
const Detector = self.BlobLockDetector;

const BLOB_ONLY = { url: [{ schemes: ['blob'] }] };
const DISARM_TIMEOUT_MS = 600; // navigate even if the page never confirms disarming
const NAVIGATION_TIMEOUT_MS = 1500; // warning page must load by then, else the tab is replaced
const CONTENT_SCRIPTS = { main: 'content/main-world.js', isolated: 'content/isolated.js', defang: 'content/allow-defang.js' };
const ALLOW_SCRIPT_ID = 'blg-allow-defang';
const WARNING_PAGE = chrome.runtime.getURL('pages/blocked.html');

// In-memory only: the worker may be restarted at any time; missing navigation
// info just means "arrival unknown", which never causes a block on its own.
const navByTab = new Map(); // tabId -> { url, transitionType, clientRedirect, openerTabId }
const openerByTab = new Map(); // tabId -> sourceTabId (blob opened into a new tab)
const pendingBlocks = new Map(); // tabId -> { go }
const lastBlockAt = new Map(); // tabId -> { url, at }
const stats = { reports: 0, probes: 0, blocks: 0, lastVerdict: null };
self.__blgStats = stats; // inspected by the e2e tests; never leaves the browser

// --- arrival ---------------------------------------------------------------
chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  openerByTab.set(d.tabId, d.sourceTabId);
}, BLOB_ONLY);

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  navByTab.set(d.tabId, {
    url: d.url,
    transitionType: d.transitionType,
    clientRedirect: (d.transitionQualifiers || []).includes('client_redirect'),
    openerTabId: openerByTab.has(d.tabId) ? openerByTab.get(d.tabId) : null,
  });
}, BLOB_ONLY);

function navFor(tabId, url) {
  const nav = navByTab.get(tabId);
  return nav && nav.url === url ? nav : null;
}

// --- session allow-list (false-positive override) ------------------------------
// The allow-list IS a dynamically registered content script: allow-defang.js,
// MAIN world, document_start, persistAcrossSessions: false. So it is
// session-only by construction, needs no extra permission, and switches allowed
// pages into "defanged" mode before any of their own code runs.
async function allowedPatterns() {
  try {
    const [script] = await chrome.scripting.getRegisteredContentScripts({ ids: [ALLOW_SCRIPT_ID] });
    return (script && script.matches) || [];
  } catch (_) {
    return [];
  }
}

let allowQueue = Promise.resolve(); // serialise concurrent "reopen" clicks
function allowPattern(pattern) {
  allowQueue = allowQueue.then(async () => {
    const current = await allowedPatterns();
    if (current.includes(pattern)) return;
    const script = {
      id: ALLOW_SCRIPT_ID,
      matches: [...current, pattern],
      js: [CONTENT_SCRIPTS.defang],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: false,
      matchOriginAsFallback: true,
      persistAcrossSessions: false,
    };
    if (current.length) await chrome.scripting.updateContentScripts([script]);
    else await chrome.scripting.registerContentScripts([script]);
  });
  return allowQueue;
}

// --- response ----------------------------------------------------------------
function warningPageUrl(blobUrl, verdict, fromUrl) {
  const params = new URLSearchParams({
    origin: Detector.blobCreatorOrigin(blobUrl) || 'unknown site',
    rule: verdict.rule || 'restored',
    reasons: JSON.stringify((verdict.reasons || []).slice(0, 10)),
  });
  // Offer "reopen" only when it can work (known http(s) origin).
  if (Detector.reopenPlan(blobUrl, fromUrl)) {
    params.set('blob', blobUrl);
    if (fromUrl) params.set('from', fromUrl);
  }
  return `${WARNING_PAGE}?${params}`;
}

// The warning page reports when it has loaded in a tab.
const warningWaiters = new Map(); // tabId -> resolve()
function warningShownIn(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      warningWaiters.delete(tabId);
      resolve(false);
    }, timeoutMs);
    warningWaiters.set(tabId, () => {
      clearTimeout(timer);
      warningWaiters.delete(tabId);
      resolve(true);
    });
  });
}

// Last resort for a renderer that never yields (e.g. an alert() loop the user
// keeps dismissing): a navigation cannot commit there, but closing the tab can.
// The warning page opens in a fresh tab in the same position.
async function replaceTab(tabId, url) {
  const tab = await chrome.tabs.get(tabId);
  const fresh = await chrome.tabs.create({ url, windowId: tab.windowId, index: tab.index + 1, active: true });
  await chrome.tabs.remove(tabId);
  stats.replacedTabs = (stats.replacedTabs || 0) + 1;
  return fresh.id;
}

async function leave(tabId, blobUrl, verdict, fromUrl) {
  lastBlockAt.set(tabId, { url: blobUrl, at: Date.now() });
  const url = warningPageUrl(blobUrl, verdict, fromUrl);
  chrome.tabs.update(tabId, { muted: true }).catch(() => {});
  if (verdict.trapIds && verdict.trapIds.includes('dialog-loop')) {
    // The page's thread is busy re-opening dialogs, so a navigation would only
    // commit after several more of them. Replace the tab right away.
    await replaceTab(tabId, url).catch(() => {});
    return;
  }
  const shown = warningShownIn(tabId, NAVIGATION_TIMEOUT_MS);
  // Not awaited: on a stuck renderer this call may never settle.
  chrome.tabs.update(tabId, { url }).catch((err) => console.warn('[blob-lock-guard] could not navigate tab', tabId, err));
  let finalTabId = tabId;
  if (!(await shown)) {
    try {
      finalTabId = await replaceTab(tabId, url);
    } catch (_) {
      return; // tab already gone
    }
  }
  // HTML fullscreen normally ends with the document; make sure the window is
  // not left in fullscreen if the page forced it.
  if (verdict.trapIds && verdict.trapIds.includes('fullscreen')) {
    try {
      const tab = await chrome.tabs.get(finalTabId);
      const win = await chrome.windows.get(tab.windowId);
      if (win.state === 'fullscreen') await chrome.windows.update(win.id, { state: 'normal' });
    } catch (_) {
      /* ignore */
    }
  }
}

function startBlock(tabId, blobUrl, verdict, fromUrl) {
  if (pendingBlocks.has(tabId)) return;
  const recent = lastBlockAt.get(tabId);
  if (recent && recent.url === blobUrl && Date.now() - recent.at < NAVIGATION_TIMEOUT_MS + 500) return; // same document, already handled
  stats.blocks += 1;
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    pendingBlocks.delete(tabId);
    leave(tabId, blobUrl, verdict, fromUrl);
  };
  // A page stuck in a dialog loop can never confirm it disarmed: don't wait for it.
  const stuck = verdict.trapIds && verdict.trapIds.includes('dialog-loop');
  const timer = setTimeout(go, stuck ? 0 : DISARM_TIMEOUT_MS);
  pendingBlocks.set(tabId, { go });
}

// --- reports from content scripts --------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || sender.id !== chrome.runtime.id || !sender.tab) return;

  const fromWarningPage = typeof sender.url === 'string' && sender.url.startsWith(WARNING_PAGE);

  if (msg.type === 'blg:warning-shown' && fromWarningPage) {
    const resolve = warningWaiters.get(sender.tab.id);
    if (resolve) resolve();
    return;
  }

  // "I trust this site — reopen the page". Accepted only from the warning page;
  // origin and target are re-derived and validated here, not taken on trust.
  if (msg.type === 'blg:proceed' && fromWarningPage) {
    const plan = Detector.reopenPlan(msg.blobUrl, msg.fromUrl);
    if (!plan) {
      sendResponse({ ok: false, error: 'This page cannot be reopened.' });
      return;
    }
    allowPattern(plan.pattern)
      .then(() => chrome.tabs.update(sender.tab.id, { url: plan.target, muted: false }))
      .then(() => {
        stats.reopened = (stats.reopened || 0) + 1;
        sendResponse({ ok: true, target: plan.target });
      })
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true; // async response
  }

  if (!Detector.shouldInspect(sender.url, sender.frameId)) return;
  const tabId = sender.tab.id;

  if (msg.type === 'blg:report') {
    stats.reports += 1;
    const snapshot = msg.snapshot || {};
    const fromUrl = snapshot.arrival && typeof snapshot.arrival.fromUrl === 'string' ? snapshot.arrival.fromUrl : null;
    if (snapshot.neutralized) {
      // A document we already blocked came back (back/forward cache).
      startBlock(tabId, sender.url, { rule: 'restored', reasons: ['This page was already blocked as a fake lock screen'] }, fromUrl);
      sendResponse({ action: 'block' });
      return;
    }
    const verdict = Detector.evaluate(snapshot, navFor(tabId, sender.url));
    stats.lastVerdict = { url: sender.url, block: verdict.block, rule: verdict.rule, content: verdict.contentScore, traps: verdict.trapScore, trapIds: verdict.trapIds };
    if (!verdict.block && !verdict.needsProbe) {
      sendResponse({ action: 'none' }); // the common case for benign blobs: no allow-list lookup
      return;
    }
    allowedPatterns().then((patterns) => {
      if (Detector.isOriginAllowed(Detector.blobCreatorOrigin(sender.url), patterns)) {
        // Trusted by the user: shown, defanged by allow-defang.js, never probed.
        // A dialog loop is the exception: a frozen page cannot be defanged.
        const frozen = verdict.block && verdict.trapIds.includes('dialog-loop');
        if (!frozen) {
          stats.allowedSkips = (stats.allowedSkips || 0) + 1;
          sendResponse({ action: 'none' });
          return;
        }
      }
      if (verdict.block) {
        startBlock(tabId, sender.url, verdict, fromUrl);
        sendResponse({ action: 'block' });
      } else {
        stats.probes += 1;
        sendResponse({ action: 'probe' });
      }
    });
    return true; // async response
  }

  if (msg.type === 'blg:disarmed') {
    const pending = pendingBlocks.get(tabId);
    if (pending) pending.go();
  }
});

// --- rescue tabs that were already open when this extension instance started --
// Covers install, update/reload AND re-enabling after a disable. Chrome fires
// runtime.onInstalled only for the first two, but it always starts the service
// worker, so the sweep runs from top-level code. chrome.storage.session is
// cleared whenever the extension is disabled, reloaded or updated (and on browser
// restart), so the "swept" flag means "already swept for this instance": later
// wake-ups (blob navigations, messages) do not sweep again.
let sweeping = null;
function sweepOnce() {
  if (!sweeping) {
    sweeping = (async () => {
      try {
        const { swept } = await chrome.storage.session.get('swept');
        if (swept) return;
        await chrome.storage.session.set({ swept: true });
      } catch (_) {
        /* storage unavailable: sweep anyway */
      }
      stats.sweeps = (stats.sweeps || 0) + 1;
      await sweepOpenTabs();
    })();
  }
  return sweeping;
}

async function sweepOpenTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (_) {
    return;
  }
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id == null || tab.discarded) return;
      const target = { tabId: tab.id };
      try {
        // Cheap check first (we cannot read blob: tab URLs without the "tabs"
        // permission), and skip documents whose manifest-declared content scripts
        // are already running — otherwise the two sets would race each other.
        const [check] = await chrome.scripting.executeScript({
          target,
          func: () => location.protocol === 'blob:' && !(globalThis.__blgIsolated && globalThis.__blgIsolated.alive()),
        });
        if (!check || check.result !== true) return;
        await chrome.scripting.executeScript({ target, files: [CONTENT_SCRIPTS.main], world: 'MAIN', injectImmediately: true });
        await chrome.scripting.executeScript({ target, files: [CONTENT_SCRIPTS.isolated], injectImmediately: true });
      } catch (_) {
        // chrome://, Web Store, PDF viewer, discarded tabs, etc. are not scriptable.
      }
    }),
  );
}

chrome.runtime.onInstalled.addListener(() => sweepOnce());
sweepOnce();
