'use strict';
// AC-12 (+AC-07): the user is already on the lock screen, and has already
// clicked on it, when the extension is installed or re-enabled.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EXT_PATH, TOGGLE_HELPER_PATH, launch, track, waitFor, waitForWarning, newPageFromClick, sleep } = require('../support/harness');

let h;
test.before(async () => {
  h = await launch({ withExtension: false });
});
test.after(async () => {
  await h.close();
});

test('AC-12: installing the extension rescues an open lock screen within 3 s and leaves an open benign preview alone', async () => {
  // Benign blob report open in its own tab.
  const launcher = await h.browser.newPage();
  await launcher.goto(h.url('benign.html'));
  const report = await newPageFromClick(h.browser, launcher, '#view-report');
  await waitFor(() => report.url().startsWith('blob:'));

  // The user is stuck on the lock screen and has interacted with it.
  const scam = await h.browser.newPage();
  const log = track(scam);
  await scam.goto(h.url('malicious.html'));
  assert.ok(await waitFor(() => scam.url().startsWith('blob:')));
  await scam.mouse.click(300, 300);
  await scam.keyboard.press('Escape');
  await sleep(300);
  assert.ok(scam.url().startsWith('blob:'), 'still trapped before install');

  const t0 = Date.now();
  await h.browser.installExtension(EXT_PATH);
  assert.ok(await waitForWarning(scam, 5000), `ended on ${scam.url()}`);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed <= 3000, `rescued ${elapsed} ms after install`);
  assert.deepEqual(log.dialogs, [], 'no "Leave site?" dialog even though the page had user activation');

  await sleep(5000);
  assert.ok(report.url().startsWith('blob:'), `benign report untouched: ${report.url()}`);
  assert.equal(await report.title(), 'Monthly Report');
});

test('AC-12: install rescues a lock screen in a background tab (the user is on another page, e.g. chrome://extensions)', async () => {
  const b = await launch({ withExtension: false });
  try {
    const scam = await b.browser.newPage();
    await scam.goto(b.url('malicious.html'));
    assert.ok(await waitFor(() => scam.url().startsWith('blob:')));
    await scam.mouse.click(300, 300);
    const front = await b.browser.newPage();
    await front.goto(b.url('test-pages/index.html'));
    await front.bringToFront();

    await b.browser.installExtension(EXT_PATH);
    assert.ok(await waitForWarning(scam, 3000), `background tab ended on ${scam.url()}`);
    assert.equal(front.url(), b.url('test-pages/index.html'), 'the page in front is untouched');
  } finally {
    await b.close();
  }
});

test('AC-12: re-enabling a disabled extension rescues a lock screen opened while it was off', async () => {
  const b = await launch({ extraExtensions: [TOGGLE_HELPER_PATH] });
  try {
    const helperTarget = await b.browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/bg.js'));
    const helper = await helperTarget.worker();
    const ours = await helper.evaluate(() => findByName('Lock-Screen Scam Guard'));
    assert.ok(ours && ours.enabled, 'extension under test is installed and enabled');
    await helper.evaluate((id) => setEnabled(id, false), ours.id);

    const scam = await b.browser.newPage();
    const log = track(scam);
    await scam.goto(b.url('malicious.html'));
    assert.ok(await waitFor(() => scam.url().startsWith('blob:')));
    await scam.mouse.click(300, 300);
    await sleep(500);
    assert.ok(scam.url().startsWith('blob:'), 'not protected while disabled');

    // Chrome does not fire runtime.onInstalled on enable; the start-up sweep must catch it.
    const t0 = Date.now();
    await helper.evaluate((id) => setEnabled(id, true), ours.id);
    assert.ok(await waitForWarning(scam, 5000), `ended on ${scam.url()}`);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed <= 3000, `rescued ${elapsed} ms after enabling`);
    assert.deepEqual(log.dialogs, [], 'no "Leave site?" dialog');

    // The sweep ran once for this extension instance and is remembered for the session.
    const stats = await b.stats();
    assert.equal(stats.sweeps, 1);
    const w = await b.worker();
    assert.deepEqual(await w.evaluate(() => chrome.storage.session.get('swept')), { swept: true });
  } finally {
    await b.close();
  }
});
