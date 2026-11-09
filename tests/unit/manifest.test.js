'use strict';
// AC-01 / AC-02: manifest shape, minimal permissions, and a static check that the
// extension contains no network or remote-code paths.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EXT = path.resolve(__dirname, '..', '..', 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? listFiles(path.join(dir, d.name)) : [path.join(dir, d.name)]));
}

test('manifest: MV3 with a background service worker and content scripts', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(typeof manifest.background.service_worker, 'string');
  assert.ok(Array.isArray(manifest.content_scripts) && manifest.content_scripts.length === 2);
});

test('manifest: content scripts run at document_start, top frame only, inside blob: documents', () => {
  for (const cs of manifest.content_scripts) {
    assert.equal(cs.run_at, 'document_start');
    assert.equal(cs.match_origin_as_fallback, true, 'required for blob: documents');
    assert.equal(cs.all_frames, false);
  }
  const worlds = manifest.content_scripts.map((cs) => cs.world || 'ISOLATED').sort();
  assert.deepEqual(worlds, ['ISOLATED', 'MAIN']);
});

test('manifest: minimal permissions (AC-02)', () => {
  assert.deepEqual([...manifest.permissions].sort(), ['scripting', 'storage', 'webNavigation'], 'storage: session-only sweep flag, no install warning');
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  assert.equal(manifest.content_security_policy, undefined, 'default (strict) CSP');
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined, 'the warning page is not exposed to websites');
});

test('manifest: minimum Chrome version supports matchOriginAsFallback for registered scripts (119)', () => {
  assert.ok(Number(manifest.minimum_chrome_version) >= 119);
});

test('manifest: every referenced file exists', () => {
  const refs = [
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap((cs) => cs.js),
    ...Object.values(manifest.icons),
    'lib/detector.js',
    'content/allow-defang.js', // registered at runtime by background.js

    'pages/blocked.html',
    'pages/blocked.js',
    'pages/blocked.css',
  ];
  for (const ref of refs) assert.ok(fs.existsSync(path.join(EXT, ref)), ref);
});

test('source: no network APIs, remote code or eval (AC-02)', () => {
  const forbidden = [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /sendBeacon/, /EventSource/, /\beval\s*\(/, /new\s+Function\s*\(/, /https?:\/\/(?!www\.w3\.org)/];
  for (const file of listFiles(EXT).filter((f) => /\.(js|html|json)$/.test(f))) {
    // Code only: example URLs in comments are fine.
    const src = fs
      .readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/<!--[\s\S]*?-->/g, '');
    for (const re of forbidden) assert.ok(!re.test(src), `${path.relative(EXT, file)} matches ${re}`);
  }
});

test('warning page renders page-derived text safely (no innerHTML)', () => {
  const src = fs.readFileSync(path.join(EXT, 'pages/blocked.js'), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src));
});
