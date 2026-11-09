'use strict';
// AC-12 (+AC-07): the user is already on the lock screen — and has already
// clicked on it — when the extension is installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EXT_PATH, launch, track, waitFor, waitForWarning, newPageFromClick, sleep } = require('../support/harness');

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
