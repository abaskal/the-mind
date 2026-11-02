'use strict';

// MIND-04 · I4: the Edge Functions can only reach files under supabase/functions/, so they load a copy of the
// engine that `npm run sync-engine` makes. The copy must stay byte-identical to the one source file.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('supabase/functions/_shared/mind-engine.js is identical to engine/mind-engine.js', () => {
  const root = path.join(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'engine', 'mind-engine.js'));
  const copy = fs.readFileSync(path.join(root, 'supabase', 'functions', '_shared', 'mind-engine.js'));
  assert.ok(source.equals(copy), 'The Edge Function copy of the engine is out of date: run `npm run sync-engine` and commit it');
});
