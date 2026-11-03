'use strict';

// MIND-05 AC6 · Every online.* text exists in both TR and EN, and every key the online code uses is defined.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const Core = require('../online/online-core.js');

function loadStrings() {
  const m = /<script id="mind-data">([\s\S]*?)<\/script>/.exec(HTML);
  assert.ok(m, 'index.html has <script id="mind-data">');
  const ctx = vm.createContext({});
  vm.runInContext('var window = globalThis;', ctx);
  vm.runInContext(m[1], ctx, { filename: 'index.html#mind-data' });
  return vm.runInContext('window.MindData.STR', ctx);
}

const STR = loadStrings();
const onlineKeys = (lang) => Object.keys(STR[lang]).filter((k) => k.startsWith('online.'));
const placeholders = (s) => (s.match(/\{\w+\}/g) || []).sort();

test('every online.* key exists in both TR and EN, with text', () => {
  const en = onlineKeys('en');
  const tr = onlineKeys('tr');
  assert.ok(en.length > 40, `expected the online texts, found ${en.length}`);
  assert.deepEqual(en.filter((k) => !tr.includes(k)), [], 'missing in TR');
  assert.deepEqual(tr.filter((k) => !en.includes(k)), [], 'missing in EN');
  for (const lang of ['en', 'tr']) {
    for (const k of onlineKeys(lang)) assert.ok(typeof STR[lang][k] === 'string' && STR[lang][k].trim(), `${lang} ${k} is empty`);
  }
});

test('TR and EN use the same {placeholders}', () => {
  for (const k of onlineKeys('en')) assert.deepEqual(placeholders(STR.tr[k]), placeholders(STR.en[k]), k);
});

test('every key the online code uses is defined in both languages', () => {
  const sources = ['online/online-lobby.js', 'online/online-client.js', 'online/online-core.js', 'online/online-table.js', 'index.html']
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  const used = new Set();
  for (const m of sources.matchAll(/'((?:online|setup|mode|nav)\.[\w.]+)'/g)) used.add(m[1]);
  // Keys built at run time: the status line ('online.lobby.' + reason) and the mode cards ('mode.' + id + …).
  for (const reason of ['waitHost', 'needPlayers', 'needOnline', 'ready']) used.add('online.lobby.' + reason);
  for (const id of ['classic', 'reverse', 'blind', 'dual']) used.add(`mode.${id}.t`).add(`mode.${id}.b`);
  for (const key of Object.values(Core.ERROR_KEYS)) used.add(key);
  used.delete('online.lobby.'); // the prefix itself
  for (const k of used) {
    assert.ok(STR.en[k], `EN is missing ${k}`);
    assert.ok(STR.tr[k], `TR is missing ${k}`);
  }
});

test('the online-play-off message reads as the issue asks', () => {
  assert.equal(STR.en['online.home.off'], "Online play isn't set up yet");
  assert.equal(STR.tr['online.home.off'], 'Çevrimiçi oyun henüz kurulmadı');
  assert.equal(STR.en['online.err.full'], 'Room is full.');
  assert.equal(STR.en['online.err.nicknameTaken'], 'Name already taken in this room.');
  assert.equal(STR.en['online.err.rateLimited'], 'Too many tries — wait a minute.');
  assert.equal(STR.en['online.err.network'], "Can't reach the server.");
});

test('MIND-07: every FAQ entry exists in TR and EN, the page shows all of them, and the online privacy entry is there', () => {
  const faq = (lang) => Object.keys(STR[lang]).filter((k) => /^faq\.\d+\.[qa]$/.test(k)).sort();
  assert.deepEqual(faq('tr'), faq('en'));
  const count = faq('en').length / 2;
  const m = /const FAQ_COUNT = (\d+);/.exec(HTML);
  assert.ok(m, 'index.html defines FAQ_COUNT');
  assert.equal(Number(m[1]), count, 'the FAQ screen shows every entry');
  assert.match(STR.en['faq.11.a'], /only store a nickname and game data\. Rooms are deleted 24 hours after the last activity\. There are no accounts and no email\./);
  assert.match(STR.tr['faq.11.a'], /24 saat sonra silinir.*Hesap yok, e-posta yok\./);
});
