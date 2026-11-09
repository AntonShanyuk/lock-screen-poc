'use strict';
// AC-03 … AC-09: malicious pages are detected and the user is taken out of them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { launch, track, isWarning, waitFor, waitForWarning, newPageFromClick, warningDetails, sleep } = require('../support/harness');

let h;
test.before(async () => {
  h = await launch();
});
test.after(async () => {
  await h.close();
});

test('AC-03/AC-09: reference malicious sample is replaced by the warning page within 2 s, with reasons and origin', async () => {
  const page = await h.browser.newPage();
  const log = track(page);
  await page.goto(h.url('malicious.html'));
  assert.ok(await waitForWarning(page, 4000), `ended on ${page.url()}`);
  const elapsed = log.warningAt() - log.firstBlobAt();
  assert.ok(log.firstBlobAt() !== undefined, 'the blob lock screen did commit (the attack ran)');
  assert.ok(elapsed <= 2000, `blocked ${elapsed} ms after the blob page committed`);
  assert.deepEqual(log.dialogs, [], 'no dialogs');

  const details = await warningDetails(page);
  assert.equal(details.origin, h.origin, 'names the site that generated the blob');
  assert.ok(details.reasons.length >= 4, details.reasons.join(' | '));
  assert.ok(details.reasons.some((r) => r.includes('1-800-555-0199')));
  assert.ok(details.reasons.some((r) => r.startsWith('Blocks escape keys')));
  await page.close();
});

test('AC-08: tab is muted, Back does not return to a live lock screen, warning page actions work', async () => {
  const page = await h.browser.newPage();
  await page.goto(h.url('malicious.html'));
  assert.ok(await waitForWarning(page));
  assert.equal(await page.evaluate(() => new Promise((r) => chrome.tabs.getCurrent((t) => r(t.mutedInfo.muted)))), true, 'tab muted');

  await page.goBack({ timeout: 3000 }).catch(() => {});
  await sleep(1500);
  const backUrl = page.url();
  const liveLockScreen = backUrl.startsWith('blob:') && (await page.evaluate(() => document.body && document.body.innerText.includes('locked')).catch(() => false));
  assert.equal(liveLockScreen, false, `after Back: ${backUrl}`);

  // "Open a new tab" leaves the warning page and unmutes.
  await page.goto(h.url('malicious.html'));
  assert.ok(await waitForWarning(page));
  await page.click('#new-tab');
  assert.ok(await waitFor(() => !isWarning(page.url()) && !page.url().startsWith('blob:'), { timeout: 3000 }), page.url());
  assert.ok(await waitFor(async () => (await h.mutedTabCount()) === 0, { timeout: 2000 }), 'unmuted after leaving');

  // A second scam in the same tab right away is blocked too; "Close this tab" closes it.
  await page.goto(h.url('malicious.html'));
  assert.ok(await waitForWarning(page));
  await page.click('#close-tab');
  assert.ok(await waitFor(() => page.isClosed(), { timeout: 3000 }), 'tab closed');
});

test('AC-04: Apple-themed variant without a phone number and with legacy keyCode trapping is blocked', async () => {
  const page = await h.browser.newPage();
  await page.goto(h.url('test-pages/mal-apple-no-phone.html'));
  assert.ok(await waitForWarning(page), page.url());
  const { reasons } = await warningDetails(page);
  assert.ok(!reasons.some((r) => r.startsWith('Shows a phone number')));
  assert.ok(reasons.some((r) => r.includes('Cmd+R')), reasons.join(' | '));
  await page.close();
});

test('AC-05/AC-07: late-rendered lock screen is blocked within 2 s of appearing, with no "Leave site?" dialog after the user clicked', async () => {
  const page = await h.browser.newPage();
  const log = track(page);
  await page.goto(h.url('test-pages/mal-delayed.html'));
  assert.ok(await waitFor(() => page.url().startsWith('blob:'), { timeout: 3000 }));
  await sleep(300);
  await page.mouse.click(200, 200); // sticky activation: a beforeunload prompt is now allowed
  await page.keyboard.press('KeyA');
  await sleep(800);
  assert.ok(page.url().startsWith('blob:'), 'not blocked while only the neutral placeholder is shown');
  assert.ok(await waitForWarning(page, 5000), page.url());
  const sinceLockShown = log.warningAt() - log.firstBlobAt() - 2000;
  assert.ok(sinceLockShown <= 2000, `blocked ${sinceLockShown} ms after the lock screen appeared`);
  assert.deepEqual(log.dialogs, [], 'no beforeunload dialog');
  await page.close();
});

test('AC-06: lock screen opened in a new tab after a user click (benign-looking arrival) is blocked', async () => {
  const launcher = await h.browser.newPage();
  await launcher.goto(h.url('test-pages/mal-new-tab-click.html'));
  const popup = await newPageFromClick(h.browser, launcher, '#play');
  assert.ok(await waitForWarning(popup), popup.url());
  await popup.close();
  await launcher.close();
});

test('AC-06: lock screen launched through a script-clicked <a> is blocked', async () => {
  const page = await h.browser.newPage();
  await page.goto(h.url('test-pages/mal-anchor-click.html'));
  assert.ok(await waitForWarning(page), page.url());
  await page.close();
});

test('blatant self-opened lock screen with no trapping code is blocked by the content-only rule', async () => {
  const page = await h.browser.newPage();
  await page.goto(h.url('test-pages/mal-no-traps.html'));
  assert.ok(await waitForWarning(page), page.url());
  const stats = await h.stats();
  assert.equal(stats.lastVerdict.rule, 'blatant-auto-open');
  assert.deepEqual(stats.lastVerdict.trapIds, [], 'no trap evidence was needed — and none existed');
  await page.close();
});
