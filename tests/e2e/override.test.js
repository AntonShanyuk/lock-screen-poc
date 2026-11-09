'use strict';
// AC-19: "I trust this site — reopen the page" false-positive override.
const test = require('node:test');
const assert = require('node:assert/strict');
const { launch, track, isWarning, waitFor, waitForWarning, newPageFromClick, sleep } = require('../support/harness');

let h;
let other; // same server reached through a different origin (localhost vs 127.0.0.1)
test.before(async () => {
  h = await launch();
  other = (p) => h.url(p).replace('127.0.0.1', 'localhost');
});
test.after(async () => {
  await h.close();
});

/** Asks the page-world sensor for its state (white-box: it is what the hooks see). */
function sensorState(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        window.addEventListener('__blobLockGuard:state', (e) => resolve(JSON.parse(e.detail)), { once: true });
        window.dispatchEvent(new CustomEvent('__blobLockGuard:cmd', { detail: JSON.stringify({ cmd: 'announce' }) }));
        setTimeout(() => resolve(null), 1000);
      }),
  );
}

async function reopenFromWarning(page) {
  assert.equal(await page.evaluate(() => document.getElementById('override').hidden), false, 'override offered');
  assert.equal(await page.evaluate(() => document.getElementById('override').open), false, 'collapsed by default');
  await page.click('#override summary');
  await page.click('#reopen');
}

test('AC-19: reopen a self-opening page — launcher reloads, page is shown, not blocked, and defanged', async () => {
  const page = await h.browser.newPage();
  const log = track(page);
  await page.goto(h.url('malicious.html'));
  assert.ok(await waitForWarning(page));
  const reopenLabel = await page.$eval('#reopen', (b) => b.textContent);
  assert.ok(reopenLabel.includes(h.origin) && reopenLabel.includes('not recommended'), reopenLabel);

  await reopenFromWarning(page);
  // The launcher (malicious.html) is reopened and regenerates its blob page.
  assert.ok(await waitFor(() => page.url().startsWith('blob:'), { timeout: 4000 }), page.url());
  await sleep(3000);
  assert.ok(page.url().startsWith('blob:'), `still shown after 3 s: ${page.url()}`);
  assert.equal(await page.title(), 'Windows Security Alert');
  assert.ok(log.urls.some((u) => u.url === h.url('malicious.html')), 'went through the launcher');

  const state = await sensorState(page);
  assert.equal(state && state.defanged, true, 'page-world sensor is in defanged mode');
  const stats = await h.stats();
  assert.ok(stats.allowedSkips >= 1, 'allow-list consulted and honoured');

  // Defanged: even after the user interacts, leaving raises no "Leave site?" prompt.
  await page.mouse.click(300, 300);
  await page.goto(h.url('test-pages/index.html'));
  assert.equal(page.url(), h.url('test-pages/index.html'));
  assert.deepEqual(log.dialogs, [], 'no beforeunload dialog');
  await page.close();
});

test('AC-19: the allow-list is session-only and exact to the origin', async () => {
  const w = await h.worker();
  const scripts = await w.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  assert.equal(scripts.length, 1);
  assert.deepEqual(scripts[0].matches, [`${h.origin}/*`]);
  assert.equal(scripts[0].persistAcrossSessions, false, 'forgotten when the browser closes');
  assert.equal(scripts[0].world, 'MAIN');
  assert.equal(scripts[0].runAt, 'document_start');
});

test('AC-19: the same scam from another origin is still blocked', async () => {
  const page = await h.browser.newPage();
  await page.goto(other('malicious.html'));
  assert.ok(await waitForWarning(page), page.url());
  await page.close();
});

test('AC-19: an alert() loop on an allowed origin is still rescued', async () => {
  const page = await h.browser.newPage();
  page.on('dialog', async (d) => {
    await sleep(300);
    await d.accept().catch(() => {});
  });
  await page.goto(h.url('test-pages/mal-alert-loop.html'));
  const existing = new Set(h.browser.targets());
  const warningTab = h.browser.waitForTarget((t) => !existing.has(t) && isWarning(t.url()), { timeout: 8000 }).catch(() => null);
  await page.click('#go');
  const target = await warningTab;
  assert.ok(target, 'warning page opened');
  assert.ok(await waitFor(() => page.isClosed(), { timeout: 3000 }), 'trapped tab closed');
  await (await target.page()).close();
});

test('AC-19: reopen when the launcher is still open (new-tab pattern) goes back to the blob page', async () => {
  const launcher = await h.browser.newPage();
  await launcher.goto(other('test-pages/mal-new-tab-click.html'));
  const popup = await newPageFromClick(h.browser, launcher, '#play');
  assert.ok(await waitForWarning(popup), popup.url());
  const blobBefore = await popup.evaluate(() => new URLSearchParams(location.search).get('blob'));
  assert.ok(blobBefore && blobBefore.startsWith('blob:http://localhost:'), blobBefore);

  await reopenFromWarning(popup);
  assert.ok(await waitFor(() => popup.url() === blobBefore, { timeout: 4000 }), `reopened ${popup.url()}`);
  await sleep(2000);
  assert.equal(popup.url(), blobBefore, 'shown, not blocked again');
  assert.equal(await popup.title(), 'Windows Firewall Warning');
  await popup.close();
  await launcher.close();
});
