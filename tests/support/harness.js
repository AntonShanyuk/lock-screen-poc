'use strict';
// End-to-end harness: real Chromium (Chrome for Testing via Puppeteer) with the
// unpacked extension loaded, plus the local static server for the test pages.
const path = require('node:path');
const puppeteer = require('puppeteer');
const { start } = require('./server');

const EXT_PATH = path.resolve(__dirname, '..', '..', 'extension');
const TOGGLE_HELPER_PATH = path.resolve(__dirname, 'toggle-helper');
const WARNING_PATH = '/pages/blocked.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** extraExtensions: paths of additional unpacked extensions (e.g. the toggle helper). */
async function launch({ withExtension = true, extraExtensions = [] } = {}) {
  const { server, origin } = await start();
  const browser = await puppeteer.launch({
    headless: true,
    pipe: true, // required for installExtension()
    enableExtensions: withExtension || extraExtensions.length ? [...(withExtension ? [EXT_PATH] : []), ...extraExtensions] : true,
    args: ['--window-size=1280,800'],
  });
  const ctx = {
    browser,
    origin,
    url: (p) => `${origin}/${p}`,
    async worker() {
      const target = await browser.waitForTarget(
        (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://') && t.url().endsWith('/background.js'),
        { timeout: 10000 },
      );
      return target.worker();
    },
    async stats() {
      const w = await ctx.worker();
      return w.evaluate(() => JSON.parse(JSON.stringify(self.__blgStats)));
    },
    async mutedTabCount() {
      const w = await ctx.worker();
      return w.evaluate(async () => (await chrome.tabs.query({ muted: true })).length);
    },
    async close() {
      await browser.close().catch(() => {});
      server.close();
    },
  };
  return ctx;
}

/** Tracks the main-frame URL history of a page with timestamps, and dialogs. */
function track(page, { acceptDialogs = true } = {}) {
  const log = { urls: [], dialogs: [] };
  const t0 = Date.now();
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) log.urls.push({ url: frame.url(), t: Date.now() - t0 });
  });
  page.on('dialog', async (dialog) => {
    log.dialogs.push({ type: dialog.type(), message: dialog.message(), t: Date.now() - t0 });
    if (acceptDialogs) await dialog.accept().catch(() => {});
  });
  log.firstBlobAt = () => (log.urls.find((u) => u.url.startsWith('blob:')) || {}).t;
  log.warningAt = () => (log.urls.find((u) => isWarning(u.url)) || {}).t;
  return log;
}

function isWarning(url) {
  return typeof url === 'string' && url.startsWith('chrome-extension://') && url.includes(WARNING_PATH);
}

async function waitFor(predicate, { timeout = 5000, interval = 50 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    let ok = false;
    try {
      ok = await predicate();
    } catch (_) {
      ok = false;
    }
    if (ok) return true;
    if (Date.now() > end) return false;
    await sleep(interval);
  }
}

const waitForWarning = (page, timeout = 5000) => waitFor(() => isWarning(page.url()), { timeout });

async function newPageFromClick(browser, page, selector, { timeout = 5000 } = {}) {
  const created = browser.waitForTarget((t) => t.opener() === page.target() && t.type() === 'page', { timeout });
  await page.click(selector);
  const target = await created;
  const p = await target.page();
  return p;
}

async function warningDetails(page) {
  return page.evaluate(() => ({
    origin: document.getElementById('origin').textContent,
    reasons: [...document.querySelectorAll('#reasons li')].map((li) => li.textContent),
  }));
}

async function windowState(page) {
  const session = await page.createCDPSession();
  try {
    const { windowId } = await session.send('Browser.getWindowForTarget');
    const { bounds } = await session.send('Browser.getWindowBounds', { windowId });
    return bounds.windowState;
  } finally {
    await session.detach().catch(() => {});
  }
}

module.exports = { EXT_PATH, TOGGLE_HELPER_PATH, launch, track, isWarning, waitFor, waitForWarning, newPageFromClick, warningDetails, windowState, sleep };
