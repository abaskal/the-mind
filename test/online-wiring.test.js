'use strict';

// MIND-05 · How online play is wired into the page: offline keeps working with no network (I5), supabase-js is only
// loaded on demand from a pinned, integrity-checked URL, and no secret is committed (I8).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const HTML = read('index.html');
const CLIENT = read('online/online-client.js');

test('online-config.js is committed with empty values (MIND-07 fills them at deploy time)', () => {
  const ctx = vm.createContext({});
  vm.runInContext('var window = globalThis;', ctx);
  vm.runInContext(read('online-config.js'), ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('window.MIND_ONLINE', ctx))), { supabaseUrl: '', supabaseKey: '' });
});

test('index.html loads only local files: no http(s) script, stylesheet or image', () => {
  const external = [...HTML.matchAll(/<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)="(https?:)?\/\/[^"]*"/gi)].map((m) => m[0]);
  assert.deepEqual(external, []);
  assert.doesNotMatch(HTML, /supabase\.co|cdn\.jsdelivr\.net/);
});

test('the online scripts are local classic scripts that load after the app, config first', () => {
  const srcs = [...HTML.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(srcs, ['engine/mind-engine.js', 'online-config.js', 'online/online-core.js', 'online/online-client.js', 'online/online-lobby.js']);
  assert.ok(HTML.indexOf('src="online-config.js"') > HTML.indexOf('<script id="mind-app">'));
  for (const s of srcs) assert.ok(fs.existsSync(path.join(ROOT, s)), s);
  assert.doesNotMatch(HTML, /type="module"/);
});

test('supabase-js comes from a pinned exact version with Subresource Integrity, only through loadSdk()', () => {
  const urls = [...CLIENT.matchAll(/https:\/\/[^'"\s]+/g)].map((m) => m[0]);
  assert.deepEqual(urls, ['https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js']);
  assert.match(CLIENT, /version: '2\.118\.0'/);
  assert.match(CLIENT, /integrity: 'sha384-[A-Za-z0-9+/]{64}'/);
  assert.match(CLIENT, /s\.integrity = SUPABASE_JS\.integrity/);
  assert.match(CLIENT, /s\.crossOrigin = 'anonymous'/);
  for (const f of ['online/online-core.js', 'online/online-lobby.js', 'online-config.js']) {
    assert.doesNotMatch(read(f), /https?:\/\/(?!example|x\.)/, `${f} must not reference a network URL`);
  }
});

test('no secret key or service-role JWT in the front-end files (I8)', () => {
  for (const f of ['index.html', 'online-config.js', 'online/online-core.js', 'online/online-client.js', 'online/online-lobby.js']) {
    assert.doesNotMatch(read(f), /sb_secret_[A-Za-z0-9]|eyJhbGci|service_role/, f);
  }
});

test('the online code never inserts a nickname as HTML (I7)', () => {
  const lobby = read('online/online-lobby.js');
  // Nicknames are only rendered by paintSeats (textContent) and sr() (textContent); every other value in a template
  // goes through esc().
  assert.match(lobby, /node\('span', 'nick', s\.nickname\)/);
  for (const m of lobby.matchAll(/\$\{([^{}`]*)\}/g)) {
    if (/nickname|name|code|roomId|room\b/.test(m[1]) && !/^t\(/.test(m[1])) assert.match(m[1], /^esc\(/, `unescaped template value: \${${m[1]}}`);
  }
  assert.match(lobby, /'<b>' \+ esc\(snap\.room\.code\) \+ '<\/b>'/);
});
