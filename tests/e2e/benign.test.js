'use strict';
// AC-10 / AC-11: legitimate uses of blob: documents keep working, untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const { launch, track, waitFor, newPageFromClick, sleep } = require('../support/harness');

const OBSERVE_MS = 5000;
let h;
test.before(async () => {
  h = await launch();
});
test.after(async () => {
  await h.close();
});

async function assertUntouched(page, log, { title, text }) {
  await sleep(OBSERVE_MS);
  assert.ok(page.url().startsWith('blob:'), `still on the blob document (${page.url()})`);
  assert.equal(await page.title(), title);
  if (text) assert.ok((await page.evaluate(() => document.body.innerText)).includes(text), 'content intact');
  assert.deepEqual(log.dialogs, [], 'no dialogs');
  assert.equal(await h.mutedTabCount(), 0, 'no tab muted');
}

async function blocksSoFar() {
  return (await h.stats()).blocks;
}

test('AC-10: reference benign sample — report opens in a new tab and stays', async () => {
  const before = await blocksSoFar();
  const launcher = await h.browser.newPage();
  await launcher.goto(h.url('benign.html'));
  const report = await newPageFromClick(h.browser, launcher, '#view-report');
  const log = track(report);
  await waitFor(() => report.url().startsWith('blob:'));
  await assertUntouched(report, log, { title: 'Monthly Report', text: 'Conversions' });
  assert.equal(await blocksSoFar(), before);
  await report.close();
  await launcher.close();
});

test('AC-11: blob preview opened in the same tab after a click', async () => {
  const page = await h.browser.newPage();
  const log = track(page);
  await page.goto(h.url('test-pages/ben-same-tab-preview.html'));
  await page.click('#preview');
  assert.ok(await waitFor(() => page.url().startsWith('blob:')));
  await assertUntouched(page, log, { title: 'Quarterly export', text: 'Revenue' });
  await page.close();
});

test('AC-11: blob editor with beforeunload, Ctrl+S and Esc handling (keys pressed by the user)', async () => {
  const launcher = await h.browser.newPage();
  await launcher.goto(h.url('test-pages/ben-editor.html'));
  const editor = await newPageFromClick(h.browser, launcher, '#open');
  const log = track(editor);
  await waitFor(() => editor.url().startsWith('blob:'));
  await editor.click('#pad');
  await editor.keyboard.type(' More notes.');
  await editor.keyboard.down('Control');
  await editor.keyboard.press('KeyS');
  await editor.keyboard.up('Control');
  await editor.keyboard.press('Escape');
  await assertUntouched(editor, log, { title: 'Scratchpad', text: 'More notes.' });
  assert.equal(await editor.evaluate(() => document.getElementById('status').textContent), 'Saved.', 'editor still works');

  // The editor's own legitimate "Leave site?" prompt must still work.
  await editor.click('#pad');
  await editor.keyboard.type(' Unsaved.');
  const prompt = new Promise((resolve) => editor.once('dialog', (d) => resolve(d)));
  await editor.close({ runBeforeUnload: true });
  const dialog = await Promise.race([prompt, sleep(3000).then(() => null)]);
  assert.ok(dialog, 'editor beforeunload prompt shown');
  assert.equal(dialog.type(), 'beforeunload');
  await dialog.accept().catch(() => {}); // track() may already have accepted it
  await launcher.close();
});

test('AC-11: receipt with a vendor name and a toll-free support number (no traps)', async () => {
  const launcher = await h.browser.newPage();
  await launcher.goto(h.url('test-pages/ben-support-receipt.html'));
  const receipt = await newPageFromClick(h.browser, launcher, '#receipt');
  const log = track(receipt);
  await waitFor(() => receipt.url().startsWith('blob:'));
  await assertUntouched(receipt, log, { title: 'Receipt #A-20931', text: '1-800-555-0123' });
  await receipt.close();
  await launcher.close();
});

test('AC-11 (adversarial): IT security report full of alarming vocabulary, same tab', async () => {
  const page = await h.browser.newPage();
  const log = track(page);
  await page.goto(h.url('test-pages/ben-security-report.html'));
  await page.click('#report');
  assert.ok(await waitFor(() => page.url().startsWith('blob:')));
  await assertUntouched(page, log, { title: 'Weekly security report', text: 'malware' });
  await page.close();
});

test('AC-11 (adversarial): training handout quoting a scam lock screen, opened by the user', async () => {
  const page = await h.browser.newPage();
  const log = track(page);
  await page.goto(h.url('test-pages/ben-scam-awareness.html'));
  await page.click('#handout');
  assert.ok(await waitFor(() => page.url().startsWith('blob:')));
  await assertUntouched(page, log, { title: 'Module 3: Tech support scams', text: 'Your computer has been locked' });
  await page.close();
});

test('AC-11: blob slideshow that goes full screen and handles Esc / arrow keys', async () => {
  const launcher = await h.browser.newPage();
  await launcher.goto(h.url('test-pages/ben-slideshow.html'));
  const deck = await newPageFromClick(h.browser, launcher, '#open');
  const log = track(deck);
  await waitFor(() => deck.url().startsWith('blob:'));
  await deck.click('#start');
  await sleep(300);
  await deck.keyboard.press('ArrowRight');
  await deck.keyboard.press('Escape');
  await assertUntouched(deck, log, { title: 'Q3 business review', text: 'Slide 2 of 3' });
  await deck.close();
  await launcher.close();
});

test('AC-11: PDF and image blob previews', async () => {
  const launcher = await h.browser.newPage();
  await launcher.goto(h.url('test-pages/ben-file-previews.html'));
  for (const selector of ['#pdf', '#png']) {
    const before = await blocksSoFar();
    const preview = await newPageFromClick(h.browser, launcher, selector);
    await waitFor(() => preview.url().startsWith('blob:'), { timeout: 3000 });
    await sleep(OBSERVE_MS);
    assert.ok(preview.url().startsWith('blob:'), `${selector}: ${preview.url()}`);
    assert.equal(await blocksSoFar(), before, `${selector}: no block`);
    await preview.close();
  }
  await launcher.close();
});
