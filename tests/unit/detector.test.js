'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../../extension/lib/detector.js');
const { blobDocumentFrom } = require('../support/fixtures');

const T = D.THRESHOLDS;

// Signals the MAIN-world probe reports for the reference malicious sample.
const SAMPLE_PROBE = {
  done: true,
  blockedKeys: ['Esc', 'F5', 'F11', 'F12', 'Ctrl+R', 'Ctrl+L', 'Ctrl+W'],
  contextMenuBlocked: true,
  beforeUnloadCanceled: true,
  onbeforeunloadSet: false,
};
const AUTO_ARRIVAL = { hasOpener: false, activationType: 'replace', activationFromUrl: true };
const CLICK_NEW_TAB_ARRIVAL = { hasOpener: true, activationType: 'replace', activationFromUrl: false };
const CLICK_SAME_TAB_ARRIVAL = { hasOpener: false, activationType: 'push', activationFromUrl: true };

const malicious = blobDocumentFrom('malicious.html');
const benign = blobDocumentFrom('benign.html');

// ---------------------------------------------------------------------------
test('normalizeText: case, whitespace, invisible characters, homoglyphs, NFKC', () => {
  assert.equal(D.normalizeText('  Your   COMPUTER\n\thas been LOCKED '), 'your computer has been locked');
  assert.equal(D.normalizeText('lo​cked'), 'locked', 'zero-width space removed');
  assert.equal(D.normalizeText('Micrоsoft'), 'microsoft', 'Cyrillic o mapped to Latin o');
  assert.equal(D.normalizeText('ＬＯＣＫＥＤ'), 'locked', 'full-width letters folded by NFKC');
  assert.equal(D.normalizeText('1‑800'), '1-800', 'unicode non-breaking hyphen normalised');
  assert.equal(D.normalizeText(undefined), '');
  assert.equal(D.normalizeText(42), '');
});

test('findPhoneNumbers: real formats are found', () => {
  for (const s of ['1-800-555-0199', '(888) 555 0100', '+1 844.555.0123', '888-555-0175', '+44 20 7946 0958', '0800 123 4567', '+1 (844) 555-0142']) {
    assert.equal(D.findPhoneNumbers(`call ${s} now`).length, 1, s);
  }
});

test('findPhoneNumbers: numbers that are not phone numbers are ignored', () => {
  for (const s of ['Error code 0x800704cf', 'Generated 2026-11-09', 'Order 8005550199', 'Sessions 1,204', '$51,200', 'IP 192.168.100.200', 'build 10.0.19045.1234', 'Card ending 4242']) {
    assert.deepEqual(D.findPhoneNumbers(s), [], s);
  }
});

// ---------------------------------------------------------------------------
test('scoreContent: reference malicious sample scores in every category', () => {
  const c = D.scoreContent(malicious);
  assert.ok(c.has.lock && c.has.threat && c.has.cta && c.has.phone);
  assert.ok(c.score >= T.contentBlatant, `score ${c.score}`);
  assert.ok(c.hits.phone.includes('1-800-555-0199'));
  assert.ok(c.reasons.length >= 5);
  assert.deepEqual(c.hits.brand.sort(), ['microsoft', 'windows'], 'every impersonated brand is listed as evidence');
  assert.ok(c.hits.errorCode.includes('error code: 0x800704cf'), 'evidence quotes the whole error code');
  assert.equal(c.points.brand, 1, 'several brands still count once');
  assert.ok(c.reasons.includes('Fake error code: “error code: 0x800704cf”'), 'evidence contained in a longer quote is not repeated');
});

test('scoreContent: reference benign sample scores zero', () => {
  assert.equal(D.scoreContent(benign).score, 0);
});

test('scoreContent: generalises beyond the sample wording (AC-04)', () => {
  const cases = {
    apple_no_phone: {
      title: 'Apple Security Warning',
      text: 'Your Mac has been locked. We detected suspicious activity on this Mac. Contact Apple Support to unlock it. Do not close this window.',
    },
    defender: {
      title: 'Windows Defender Security Center',
      text: 'Access to this PC has been blocked for security reasons. Trojan spyware detected. Call Windows Support: +1 (844) 555-0142',
    },
    browser_locked: {
      title: 'Critical Security Alert',
      text: 'Error # 268D3: your browser has been locked. Malware infection detected. Call the Help Desk immediately: 1-888-555-0161',
    },
    obfuscated: {
      title: 'Security',
      text: 'YOUR COMPUTER HAS BEEN LO​CKED. Call Micrоsoft Support 1-800-555-0199',
    },
  };
  for (const [name, input] of Object.entries(cases)) {
    const c = D.scoreContent(input);
    assert.ok(c.has.lock, `${name}: lock wording`);
    assert.ok(c.score >= T.contentWithTraps, `${name}: score ${c.score}`);
  }
  assert.equal(D.scoreContent(cases.apple_no_phone).has.phone, false, 'no phone needed');
});

test('scoreContent: legitimate documents with alarming vocabulary have no lock wording', () => {
  const receipt = { title: 'Receipt #A-20931', text: 'Microsoft 365 Family — $99.99. Questions about your order? Call our support team toll-free at 1-800-555-0123.' };
  const secReport = {
    title: 'Weekly security report',
    text: 'Microsoft Defender quarantined 2 malware detections. Suspicious activity: 1 unusual login. 1 laptop failed to update with error code 0x80070005 (access denied). Contact the IT help desk at +1 (415) 555-0134.',
  };
  for (const input of [receipt, secReport]) {
    const c = D.scoreContent(input);
    assert.equal(c.has.lock, false, input.title);
    assert.ok(c.score >= T.probe, `${input.title} is suspicious enough to be probed`);
  }
  assert.equal(D.scoreContent({ title: 'Scratchpad', text: 'Press Ctrl+S to save. Unsaved changes will be lost.' }).score, 0);
  assert.equal(D.scoreContent({ title: 'Q3 business review', text: 'Slide 1 of 3 — revenue grew 12%' }).score, 0);
});

// ---------------------------------------------------------------------------
test('scoreTraps: nothing observed -> 0', () => {
  const t = D.scoreTraps(undefined, undefined);
  assert.equal(t.score, 0);
  assert.equal(t.strong, false);
});

test('scoreTraps: reference malicious sample probe results', () => {
  const t = D.scoreTraps({ probe: SAMPLE_PROBE }, {});
  assert.deepEqual(t.ids, ['escape-keys', 'context-menu', 'beforeunload']);
  assert.equal(t.score, 4);
  assert.equal(t.strong, false);
});

test('scoreTraps: escape-key weight scales with the number of keys', () => {
  assert.equal(D.scoreTraps({ probe: { done: true, blockedKeys: ['Esc'] } }).score, 1);
  assert.equal(D.scoreTraps({ probe: { done: true, blockedKeys: ['Esc', 'F5', 'F11'] } }).score, 2);
});

test('scoreTraps: a real escape attempt cancelled by the page is strong evidence', () => {
  const t = D.scoreTraps({}, { escapeBlocked: ['Esc'] });
  assert.ok(t.ids.includes('user-escape-blocked'));
  assert.ok(t.strong);
});

test('scoreTraps: bonus layers (fullscreen, keyboard lock, pointer lock)', () => {
  assert.deepEqual(D.scoreTraps({ api: { keyboardLock: 1 } }).ids, ['keyboard-lock']);
  assert.equal(D.scoreTraps({ api: { keyboardLock: 1 } }).score, 3);
  assert.ok(D.scoreTraps({ api: { requestFullscreen: 1 } }).strong);
  assert.ok(D.scoreTraps({}, { fullscreenEntered: 1 }).strong, 'fullscreen seen via fullscreenchange');
  assert.deepEqual(D.scoreTraps({ api: { pointerLock: 1 } }).ids, ['pointer-lock']);
});

test('scoreTraps: dialog-loop and history-flood thresholds (AC-15)', () => {
  assert.equal(D.scoreTraps({ bursts: { dialogsMax10s: T.dialogBurst - 1 } }).score, 0);
  assert.deepEqual(D.scoreTraps({ bursts: { dialogsMax10s: T.dialogBurst } }).ids, ['dialog-loop']);
  assert.equal(D.scoreTraps({ bursts: { historyMax2s: T.historyBurst - 1 } }).score, 0);
  assert.deepEqual(D.scoreTraps({ bursts: { historyMax2s: T.historyBurst } }).ids, ['history-flood']);
  assert.deepEqual(D.scoreTraps({ api: { pushState: T.historyTotal } }).ids, ['history-flood']);
  assert.deepEqual(D.scoreTraps({ api: { open: T.popupTotal } }).ids, ['popup-flood']);
});

test('scoreTraps: malformed input never throws', () => {
  assert.doesNotThrow(() => D.scoreTraps({ api: 'x', bursts: null, probe: { blockedKeys: 'Esc' } }, { escapeBlocked: 5 }));
  assert.equal(D.scoreTraps({ api: { keyboardLock: 'yes' } }).score, 0);
});

// ---------------------------------------------------------------------------
test('scoreArrival: self-opened vs user-opened', () => {
  assert.equal(D.scoreArrival(AUTO_ARRIVAL, { clientRedirect: true, openerTabId: null }).autoReplaced, true);
  assert.equal(D.scoreArrival(AUTO_ARRIVAL, null).autoReplaced, true, 'webNavigation info missing (worker restarted)');
  assert.equal(D.scoreArrival(AUTO_ARRIVAL, { clientRedirect: false, openerTabId: null }).autoReplaced, false);
  assert.equal(D.scoreArrival(AUTO_ARRIVAL, { clientRedirect: true, openerTabId: 7 }).autoReplaced, false);
  assert.equal(D.scoreArrival(CLICK_NEW_TAB_ARRIVAL, null).autoReplaced, false);
  assert.equal(D.scoreArrival(CLICK_SAME_TAB_ARRIVAL, null).autoReplaced, false);
  assert.equal(D.scoreArrival(undefined, undefined).autoReplaced, false);
});

// ---------------------------------------------------------------------------
test('evaluate: reference malicious sample is blocked by content + traps (AC-03)', () => {
  const v = D.evaluate({ ...malicious, main: { probe: SAMPLE_PROBE }, arrival: AUTO_ARRIVAL }, { clientRedirect: true, openerTabId: null });
  assert.equal(v.block, true);
  assert.equal(v.rule, 'content+traps');
  assert.ok(v.reasons.some((r) => r.includes('1-800-555-0199')));
  assert.ok(v.reasons.some((r) => r.startsWith('Blocks escape keys')));
});

test('evaluate: malicious sample before probing asks for a probe, not a block, when it did not open itself', () => {
  const v = D.evaluate({ ...malicious, main: {}, arrival: CLICK_NEW_TAB_ARRIVAL }, null);
  assert.equal(v.block, false);
  assert.equal(v.needsProbe, true);
  assert.deepEqual(v.reasons, []);
});

test('evaluate: reference benign sample is left alone and never probed (AC-10)', () => {
  const v = D.evaluate({ ...benign, main: {}, arrival: CLICK_NEW_TAB_ARRIVAL }, { clientRedirect: false, openerTabId: 1 });
  assert.equal(v.block, false);
  assert.equal(v.needsProbe, false);
});

test('evaluate: same content opened by a click into a new tab is still blocked once traps are seen (AC-06)', () => {
  const v = D.evaluate({ ...malicious, main: { probe: SAMPLE_PROBE }, arrival: CLICK_NEW_TAB_ARRIVAL }, { clientRedirect: false, openerTabId: 3 });
  assert.equal(v.block, true);
});

test('evaluate: blatant self-opened lock screen with no traps is blocked; the same text opened by the user is not', () => {
  const auto = D.evaluate({ ...malicious, main: { probe: { done: true, blockedKeys: [] } }, arrival: AUTO_ARRIVAL }, { clientRedirect: true });
  assert.equal(auto.rule, 'blatant-auto-open');
  const userOpened = D.evaluate({ ...malicious, main: { probe: { done: true, blockedKeys: [] } }, arrival: CLICK_SAME_TAB_ARRIVAL }, { clientRedirect: true });
  assert.equal(userOpened.block, false, 'e.g. a scam-awareness handout quoting a lock screen');
});

test('evaluate: strong-trap rule (fullscreen + keyboard lock) with moderate scary content', () => {
  const snapshot = {
    title: 'Security',
    text: 'Windows Defender: ransomware detected. Your files are at risk.',
    main: { api: { requestFullscreen: 1, keyboardLock: 1 } },
    arrival: CLICK_SAME_TAB_ARRIVAL,
  };
  const c = D.scoreContent(snapshot);
  assert.ok(c.score >= T.contentWithStrongTrap && c.score < T.contentWithTraps, `content ${c.score} is between thresholds`);
  const v = D.evaluate(snapshot, null);
  assert.equal(v.rule, 'strong-trap');
});

test('evaluate: strong traps without lock/threat wording do not block', () => {
  const v = D.evaluate(
    { title: 'Receipt', text: 'Call our support team at 1-800-555-0123', main: { api: { requestFullscreen: 1, keyboardLock: 1 } }, arrival: CLICK_SAME_TAB_ARRIVAL },
    null,
  );
  assert.equal(v.block, false);
});

test('evaluate: decision boundaries of the content+traps rule', () => {
  // content exactly 5 (lock 3 + phone 2), traps exactly 2 (3 escape keys)
  const base = { title: '', text: 'Your device has been locked. 1-800-555-0199', arrival: CLICK_NEW_TAB_ARRIVAL };
  assert.equal(D.scoreContent(base).score, T.contentWithTraps);
  const trapsTwo = { probe: { done: true, blockedKeys: ['Esc', 'F5', 'F11'] } };
  assert.equal(D.evaluate({ ...base, main: trapsTwo }).block, true, 'at both thresholds');
  const trapsOne = { probe: { done: true, blockedKeys: ['Esc'] } };
  assert.equal(D.evaluate({ ...base, main: trapsOne }).block, false, 'one trap point short');
  // content 4 (cta 2 + phone 2): even many weak traps are not enough
  const weakContent = { title: '', text: 'Call our support team at 1-800-555-0123', arrival: CLICK_NEW_TAB_ARRIVAL };
  assert.equal(D.scoreContent(weakContent).score, 4);
  assert.equal(D.evaluate({ ...weakContent, main: { probe: SAMPLE_PROBE } }).block, false);
});

test('evaluate: legitimate blob apps that use trap-like APIs are left alone (AC-11)', () => {
  const slideshow = { title: 'Q3 business review', text: 'Slide 1 of 3', main: { api: { requestFullscreen: 1 }, probe: { done: true, blockedKeys: ['Esc'] } }, iso: { fullscreenEntered: 1 } };
  assert.equal(D.evaluate(slideshow).block, false);
  const editor = { title: 'Scratchpad', text: 'Press Ctrl+S to save', main: { listeners: { beforeunload: 1, keydown: 1 } } };
  assert.equal(D.evaluate(editor).block, false);
  assert.equal(D.evaluate(editor).needsProbe, false, 'neutral content is never probed');
  const receipt = { title: 'Receipt', text: 'Microsoft 365 Family. Call our support team toll-free at 1-800-555-0123.', main: { probe: { done: true, blockedKeys: [] } } };
  assert.equal(D.evaluate(receipt).block, false);
  assert.equal(D.evaluate(receipt).needsProbe, false, 'already probed');
});

test('evaluate: tolerates missing or malformed snapshots', () => {
  assert.equal(D.evaluate(undefined).block, false);
  assert.equal(D.evaluate({ title: 5, text: null, main: 'x', iso: [] }).block, false);
});

// ---------------------------------------------------------------------------
test('shouldInspect: only top-level blob: documents pass the gate (AC-13)', () => {
  assert.equal(D.shouldInspect('blob:https://a.example/1234'), true);
  assert.equal(D.shouldInspect('blob:https://a.example/1234', 0), true);
  assert.equal(D.shouldInspect('blob:https://a.example/1234', 3), false);
  for (const url of ['https://a.example/', 'http://a/blob:', 'data:text/html,x', 'about:blank', 'chrome://newtab/', '', null, undefined]) {
    assert.equal(D.shouldInspect(url, 0), false, String(url));
  }
});

test('allowPatternFor / isOriginAllowed: exact origin, port included (AC-19)', () => {
  assert.equal(D.allowPatternFor('http://127.0.0.1:8080'), 'http://127.0.0.1:8080/*');
  assert.equal(D.allowPatternFor('https://tools.example'), 'https://tools.example/*');
  for (const bad of ['null', 'file://', 'chrome-extension://abc', 'https://tools.example/path', 'not a url', '', null, undefined]) {
    assert.equal(D.allowPatternFor(bad), null, String(bad));
  }
  const patterns = [D.allowPatternFor('http://127.0.0.1:8080')];
  assert.equal(D.isOriginAllowed('http://127.0.0.1:8080', patterns), true);
  assert.equal(D.isOriginAllowed('http://127.0.0.1:9090', patterns), false, 'other port');
  assert.equal(D.isOriginAllowed('http://localhost:8080', patterns), false, 'other host');
  assert.equal(D.isOriginAllowed('https://127.0.0.1:8080', patterns), false, 'other scheme');
  assert.equal(D.isOriginAllowed(null, patterns), false);
  assert.equal(D.isOriginAllowed('http://127.0.0.1:8080', undefined), false);
});

test('reopenPlan: prefers the same-origin launcher, falls back to the blob, rejects the rest (AC-19)', () => {
  const blob = 'blob:http://127.0.0.1:8080/550e8400';
  assert.deepEqual(D.reopenPlan(blob, 'http://127.0.0.1:8080/launcher.html?x=1'), {
    origin: 'http://127.0.0.1:8080',
    pattern: 'http://127.0.0.1:8080/*',
    target: 'http://127.0.0.1:8080/launcher.html?x=1',
  });
  assert.equal(D.reopenPlan(blob, null).target, blob, 'no launcher known');
  assert.equal(D.reopenPlan(blob, 'https://evil.example/').target, blob, 'cross-origin launcher ignored');
  assert.equal(D.reopenPlan(blob, 'javascript:alert(1)').target, blob, 'non-http launcher ignored');
  assert.equal(D.reopenPlan('blob:null/550e8400', null), null, 'opaque origin cannot be allowed');
  assert.equal(D.reopenPlan('https://evil.example/', null), null, 'not a blob');
  assert.equal(D.reopenPlan(undefined, undefined), null);
});

test('blobCreatorOrigin: extracts the scannable site that generated the blob', () => {
  assert.equal(D.blobCreatorOrigin('blob:https://evil.example/550e8400-e29b'), 'https://evil.example');
  assert.equal(D.blobCreatorOrigin('blob:http://127.0.0.1:8080/abc'), 'http://127.0.0.1:8080');
  assert.equal(D.blobCreatorOrigin('blob:null/abc'), null, 'opaque origin (file://)');
  assert.equal(D.blobCreatorOrigin('https://evil.example/'), null);
  assert.equal(D.blobCreatorOrigin('blob:garbage'), null);
});
