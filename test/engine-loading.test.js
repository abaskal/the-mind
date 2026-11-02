'use strict';

// MIND-01 AC4: engine/mind-engine.js must load as a Node module, as a classic browser script,
// and as a side-effect ES module (how the Deno Edge Function will load it in MIND-04).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ENGINE = path.join(__dirname, '..', 'engine', 'mind-engine.js');
const SOURCE = fs.readFileSync(ENGINE, 'utf8');

function assertEngineApi(api) {
  assert.equal(typeof api.MindEngine, 'function');
  assert.equal(typeof api.mulberry32, 'function');
  assert.equal(typeof api.longestRun, 'function');
  assert.deepEqual(Object.keys(api.VARIANTS), ['classic', 'reverse', 'blind', 'dual']);
  const e = new api.MindEngine({ players: [{ id: 'you', human: true }, { id: 'b1' }], rng: api.mulberry32(1) });
  e.start(0);
  assert.equal(e.phase, 'sync');
  assert.equal(e.players[0].hand.length, 1);
}

test('require() returns the engine API', () => {
  assertEngineApi(require(ENGINE));
});

test('a classic script in a context with no module and no window sets globalThis.Mind', () => {
  const ctx = vm.createContext({});
  vm.runInContext(SOURCE, ctx, { filename: ENGINE });
  assert.equal(vm.runInContext('typeof module', ctx), 'undefined');
  assert.equal(vm.runInContext('typeof window', ctx), 'undefined');
  assertEngineApi(vm.runInContext('globalThis.Mind', ctx));
});

test('a classic <script src> in a browser-like global sets window.Mind', () => {
  const ctx = vm.createContext({});
  vm.runInContext('var window = globalThis;', ctx);
  vm.runInContext(SOURCE, ctx, { filename: ENGINE });
  assert.equal(vm.runInContext('window.Mind === globalThis.Mind', ctx), true);
  assertEngineApi(vm.runInContext('window.Mind', ctx));
});

test('a side-effect ES module import sets globalThis.Mind', async () => {
  delete globalThis.Mind;
  try {
    await import('data:text/javascript,' + encodeURIComponent(SOURCE));
    assertEngineApi(globalThis.Mind);
  } finally {
    delete globalThis.Mind;
  }
});
