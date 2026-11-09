'use strict';
// AC-01 (loads cleanly) and AC-13 (no work on normal pages).
const test = require('node:test');
const assert = require('node:assert/strict');
const { launch, waitForWarning, sleep } = require('../support/harness');

let h;
test.before(async () => {
  h = await launch();
});
test.after(async () => {
  await h.close();
});

test('AC-01: MV3 service worker starts and logs no errors while handling pages', async () => {
  const worker = await h.worker();
  const problems = [];
  worker.on('console', (m) => {
    if (['error', 'warn'].includes(m.type())) problems.push(m.text());
  });
  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  assert.equal(manifest.manifest_version, 3);

  const page = await h.browser.newPage();
  await page.goto(h.url('malicious.html'));
  assert.ok(await waitForWarning(page));
  await page.goto(h.url('benign.html'));
  await sleep(500);
  assert.deepEqual(problems, []);
  await page.close();
});

test('AC-02: no network requests from the service worker or caused in pages by the extension', async () => {
  const worker = await h.worker();
  const requests = [];
  await worker.client.send('Network.enable');
  worker.client.on('Network.requestWillBeSent', (e) => requests.push(`worker: ${e.request.url}`));
  const page = await h.browser.newPage();
  page.on('request', (r) => requests.push(`page: ${r.url()}`));
  await page.goto(h.url('malicious.html'));
  assert.ok(await waitForWarning(page));
  await page.goto(h.url('benign.html'));
  await page.click('#view-report');
  await sleep(1000);
  const unexpected = requests.filter((r) => !/^(page|worker): (blob:|chrome-extension:|data:)/.test(r) && !r.startsWith(`page: ${h.origin}/`));
  assert.deepEqual(unexpected, [], 'only the test server, blob: documents and the extension\'s own files');
  await page.close();
});

test('AC-13: ordinary http pages are not instrumented and cause no reports', async () => {
  const before = (await h.stats()).reports;
  const page = await h.browser.newPage();
  for (const p of ['test-pages/index.html', 'benign.html', 'test-pages/ben-editor.html']) {
    await page.goto(h.url(p));
    const probe = await page.evaluate(() => {
      const isNative = (fn) => typeof fn === 'function' && /\{\s*\[native code\]\s*\}/.test(Function.prototype.toString.call(fn));
      return {
        addEventListener: isNative(EventTarget.prototype.addEventListener),
        pushState: isNative(History.prototype.pushState),
        alert: isNative(window.alert),
        requestFullscreen: isNative(Element.prototype.requestFullscreen),
        keyboardLock: !navigator.keyboard || isNative(navigator.keyboard.lock),
      };
    });
    assert.deepEqual(probe, { addEventListener: true, pushState: true, alert: true, requestFullscreen: true, keyboardLock: true }, p);
  }
  await sleep(500);
  assert.equal((await h.stats()).reports, before, 'no messages from non-blob pages');
  await page.close();
});

test('AC-13 (control): blob documents ARE instrumented', async () => {
  const page = await h.browser.newPage();
  await page.goto(h.url('test-pages/ben-same-tab-preview.html'));
  await page.click('#preview');
  await sleep(500);
  assert.ok(page.url().startsWith('blob:'));
  const hooked = await page.evaluate(() => !/\[native code\]/.test(Function.prototype.toString.call(EventTarget.prototype.addEventListener)));
  assert.equal(hooked, true);
  await page.close();
});
