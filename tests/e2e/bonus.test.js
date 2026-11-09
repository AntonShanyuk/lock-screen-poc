'use strict';
// AC-14 / AC-15: further trapping layers on top of the base technique.
const test = require('node:test');
const assert = require('node:assert/strict');
const { launch, track, isWarning, waitFor, waitForWarning, windowState, sleep } = require('../support/harness');

let h;
test.before(async () => {
  h = await launch();
});
test.after(async () => {
  await h.close();
});

test('AC-14: full screen + Keyboard Lock lock screen is blocked on the trap, and the window leaves full screen', async () => {
  const page = await h.browser.newPage();
  const log = track(page);
  await page.goto(h.url('test-pages/mal-fullscreen-keylock.html'));
  await page.click('#open');
  assert.ok(await waitFor(() => page.url().startsWith('blob:')));
  await sleep(1000);
  assert.ok(page.url().startsWith('blob:'), 'not blocked before it traps: content alone is not enough for a user-opened page');

  await page.mouse.click(400, 300); // user gesture -> requestFullscreen + keyboard.lock
  assert.ok(await waitForWarning(page, 4000), page.url());
  const stats = await h.stats();
  assert.ok(stats.lastVerdict.trapIds.includes('fullscreen'), JSON.stringify(stats.lastVerdict));
  assert.ok(await waitFor(async () => (await windowState(page)) !== 'fullscreen', { timeout: 2000 }), `window state: ${await windowState(page)}`);
  assert.equal(await page.evaluate(() => document.fullscreenElement), null);
  assert.deepEqual(log.dialogs, []);
  await page.close();
});

test('AC-15: history-flooding lock screen is blocked and the verdict names the flood', async () => {
  const page = await h.browser.newPage();
  await page.goto(h.url('test-pages/mal-history-flood.html'));
  await page.click('#continue');
  assert.ok(await waitForWarning(page, 4000), page.url());
  const stats = await h.stats();
  assert.ok(stats.lastVerdict.trapIds.includes('history-flood'), JSON.stringify(stats.lastVerdict));
  await page.close();
});

test('AC-15: alert() loop — user dismissing at human speed is rescued after the second dialog', async () => {
  const page = await h.browser.newPage();
  let dialogs = 0;
  page.on('dialog', async (d) => {
    dialogs += 1;
    await sleep(500); // a person reading and clicking OK
    await d.accept().catch(() => {}); // may already be closed by the rescue
  });
  await page.goto(h.url('test-pages/mal-alert-loop.html'));
  const warningTab = h.browser.waitForTarget((t) => isWarning(t.url()), { timeout: 6000 });
  await page.click('#go');
  const target = await warningTab;
  assert.ok(await waitFor(() => page.isClosed(), { timeout: 3000 }), 'trapped tab closed');
  assert.ok(dialogs <= 2, `${dialogs} dialogs shown before rescue`);
  const stats = await h.stats();
  assert.ok(stats.lastVerdict.trapIds.includes('dialog-loop'), JSON.stringify(stats.lastVerdict));
  await (await target.page()).close();
});

test('AC-15: alert() loop dismissed instantly (page never yields) — the stuck tab is replaced by the warning page', async () => {
  const page = await h.browser.newPage();
  let dialogs = 0;
  page.on('dialog', (d) => {
    dialogs += 1;
    d.accept().catch(() => {});
  });
  await page.goto(h.url('test-pages/mal-alert-loop.html'));
  const existing = new Set(h.browser.targets());
  const warningTab = h.browser.waitForTarget((t) => !existing.has(t) && isWarning(t.url()), { timeout: 8000 }).catch(() => null);
  await page.click('#go');
  const target = await warningTab;
  const diag = async () => `dialogs=${dialogs} url=${page.isClosed() ? 'closed' : page.url()} stats=${JSON.stringify(await h.stats())}`;
  assert.ok(target, `warning page opened (${await diag()})`);
  assert.ok(await waitFor(() => page.isClosed(), { timeout: 3000 }), `stuck tab closed (${await diag()})`);
  const stats = await h.stats();
  assert.ok(stats.replacedTabs >= 1, await diag());
  const warning = await target.page();
  await warning.close();
});
