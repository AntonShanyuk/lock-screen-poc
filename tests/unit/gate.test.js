'use strict';
// AC-13: on anything but a top-level blob: document, the content scripts must
// stop after the protocol check — no DOM reads, no hooks, no listeners, no
// messages. The scripts are executed in a VM whose browser globals record every
// access; a blob: run serves as the positive control.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EXT = path.resolve(__dirname, '..', '..', 'extension');
const SCRIPTS = ['content/main-world.js', 'content/isolated.js', 'content/allow-defang.js'];
const BROWSER_GLOBALS = [
  'document', 'navigator', 'navigation', 'performance', 'chrome', 'EventTarget', 'Element', 'History', 'Keyboard',
  'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'Event', 'MutationObserver', 'BeforeUnloadEvent',
  'addEventListener', 'dispatchEvent', 'setTimeout', 'clearTimeout', 'innerWidth', 'innerHeight', 'opener',
];

function run(file, { protocol, topFrame }) {
  const accessed = [];
  const sandbox = { location: { protocol } };
  for (const name of BROWSER_GLOBALS) {
    Object.defineProperty(sandbox, name, {
      get() {
        accessed.push(name);
        throw new Error(`accessed ${name}`);
      },
    });
  }
  const context = vm.createContext(sandbox);
  vm.runInContext('var window = this;', context);
  Object.defineProperty(sandbox, 'top', { get: () => (topFrame ? context.window : {}) });
  let error = null;
  try {
    vm.runInContext(fs.readFileSync(path.join(EXT, file), 'utf8'), context, { filename: file });
  } catch (e) {
    error = e;
  }
  return { accessed, error };
}

for (const file of SCRIPTS) {
  for (const protocol of ['https:', 'http:', 'file:', 'data:', 'about:', 'chrome-extension:']) {
    test(`${file}: does nothing on ${protocol} pages`, () => {
      const { accessed, error } = run(file, { protocol, topFrame: true });
      assert.equal(error, null);
      assert.deepEqual(accessed, []);
    });
  }

  test(`${file}: does nothing in blob: sub-frames`, () => {
    const { accessed, error } = run(file, { protocol: 'blob:', topFrame: false });
    assert.equal(error, null);
    assert.deepEqual(accessed, []);
  });

  test(`${file}: positive control — proceeds past the gate in a top-level blob: document`, () => {
    const { accessed } = run(file, { protocol: 'blob:', topFrame: true });
    assert.ok(accessed.length > 0, 'the harness detects browser API access');
  });
}
