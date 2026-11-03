// MIND-07 AC2 · scripts/package-site.mjs: exactly the runtime files, a generated online-config.js, the CSP, and clear
// failures for a missing variable or a key that must never reach the site (I8).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packageSite, readConfig, contentSecurityPolicy, PackageError } from '../scripts/package-site.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'package-site.mjs');
const URL_OK = 'https://abcdefghijklmnopqrst.supabase.co';
const KEY_OK = 'sb_publishable_example0000000000';
const ENV = { SUPABASE_URL: URL_OK, SUPABASE_PUBLISHABLE_KEY: KEY_OK };
const jwt = (payload) => ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-site-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function listFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  })(dir);
  return out.sort();
}

describe('the packaged site', () => {
  let out, result;
  before(() => {
    out = path.join(tmp, 'site');
    result = packageSite({ env: ENV, out });
  });

  test('contains exactly the runtime files and the generated config', () => {
    const online = fs.readdirSync(path.join(ROOT, 'online')).filter((f) => f.endsWith('.js')).map((f) => `online/${f}`);
    const expected = ['index.html', 'engine/mind-engine.js', 'online-config.js', ...online].sort();
    assert.deepEqual(listFiles(out), expected);
    assert.deepEqual(result.files, expected);
    for (const f of ['supabase', 'test', 'docs', 'scripts', 'node_modules', '.github', 'package.json', 'package-lock.json',
      'game.js', 'app.js', 'style.css', 'index.previous.html', 'game.test.js', 'README.md']) {
      assert.equal(fs.existsSync(path.join(out, f)), false, `${f} must not be deployed`);
    }
  });

  test('copies the runtime files unchanged, except the CSP in index.html', () => {
    for (const f of result.files.filter((x) => x !== 'index.html' && x !== 'online-config.js')) {
      assert.equal(fs.readFileSync(path.join(out, f), 'utf8'), fs.readFileSync(path.join(ROOT, f), 'utf8'), f);
    }
    const repo = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const site = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.equal(site.replace(/\n {2}<meta http-equiv="Content-Security-Policy" content="[^"]*" \/>/, ''), repo);
  });

  test('online-config.js holds the project URL and the publishable key', () => {
    const ctx = vm.createContext({});
    vm.runInContext('var window = globalThis;', ctx);
    vm.runInContext(fs.readFileSync(path.join(out, 'online-config.js'), 'utf8'), ctx);
    assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('window.MIND_ONLINE', ctx))), { supabaseUrl: URL_OK, supabaseKey: KEY_OK });
  });

  test('index.html gets one Content-Security-Policy, right after the charset; the repository copy has none (I5)', () => {
    const site = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    const metas = [...site.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/g)];
    assert.equal(metas.length, 1);
    assert.equal(metas[0][1], result.csp);
    assert.ok(site.indexOf('Content-Security-Policy') < site.indexOf('<title>'), 'before any script');
    assert.equal(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').includes('Content-Security-Policy'), false);
  });

  test('the CSP allows only the site, jsDelivr and the project', () => {
    const d = Object.fromEntries(result.csp.split('; ').map((x) => { const [k, ...v] = x.split(' '); return [k, v]; }));
    assert.deepEqual(d['script-src'], ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net']);
    assert.deepEqual(d['connect-src'], ["'self'", URL_OK, URL_OK.replace('https:', 'wss:')]);
    assert.deepEqual(d['default-src'], ["'self'"]);
    assert.deepEqual(d['object-src'], ["'none'"]);
    assert.ok(!result.csp.includes('unsafe-eval'));
    // The jsDelivr URL the client loads is covered.
    assert.match(fs.readFileSync(path.join(ROOT, 'online', 'online-client.js'), 'utf8'), /src: 'https:\/\/cdn\.jsdelivr\.net\//);
  });

  test('a second run replaces the folder', () => {
    fs.writeFileSync(path.join(out, 'stale.txt'), 'x');
    packageSite({ env: ENV, out });
    assert.equal(fs.existsSync(path.join(out, 'stale.txt')), false);
  });
});

describe('configuration checks', () => {
  test('a missing variable fails with a message that names it', () => {
    assert.throws(() => readConfig({ SUPABASE_PUBLISHABLE_KEY: KEY_OK }), (e) => e instanceof PackageError && /Missing SUPABASE_URL\./.test(e.message) && /DEPLOY\.md/.test(e.message));
    assert.throws(() => readConfig({ SUPABASE_URL: URL_OK, SUPABASE_PUBLISHABLE_KEY: '  ' }), /Missing SUPABASE_PUBLISHABLE_KEY\. Add it as a repository variable/);
    assert.throws(() => readConfig({}), /Missing SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY\. Add them as repository variables/);
  });

  test('secret and service-role keys are refused (I8)', () => {
    for (const key of ['sb_secret_abcdef', jwt({ role: 'service_role' }), 'not-a-key']) {
      assert.throws(() => readConfig({ SUPABASE_URL: URL_OK, SUPABASE_PUBLISHABLE_KEY: key }), /not a publishable \(anon\) key/);
    }
    assert.equal(readConfig({ SUPABASE_URL: URL_OK, SUPABASE_PUBLISHABLE_KEY: jwt({ role: 'anon' }) }).supabaseUrl, URL_OK);
  });

  test('the URL must be https, except a local stack', () => {
    assert.throws(() => readConfig({ SUPABASE_URL: 'http://abc.supabase.co', SUPABASE_PUBLISHABLE_KEY: KEY_OK }), /must use https/);
    assert.throws(() => readConfig({ SUPABASE_URL: 'abc.supabase.co', SUPABASE_PUBLISHABLE_KEY: KEY_OK }), /not a URL/);
    assert.equal(readConfig({ SUPABASE_URL: 'https://abc.supabase.co/rest/v1/', SUPABASE_PUBLISHABLE_KEY: KEY_OK }).supabaseUrl, 'https://abc.supabase.co');
    const local = readConfig({ SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: KEY_OK });
    assert.match(contentSecurityPolicy(local.supabaseUrl), /connect-src 'self' http:\/\/127\.0\.0\.1:54321 ws:\/\/127\.0\.0\.1:54321;/);
  });

  test('it never writes into the repository itself', () => {
    assert.throws(() => packageSite({ env: ENV, out: ROOT }), /contains the repository/);
    assert.throws(() => packageSite({ env: ENV, out: path.dirname(ROOT) }), /contains the repository/);
  });

  test('a page that loads a file outside the package fails the build', () => {
    const root = path.join(tmp, 'fake-root');
    fs.mkdirSync(path.join(root, 'engine'), { recursive: true });
    fs.mkdirSync(path.join(root, 'online'), { recursive: true });
    fs.writeFileSync(path.join(root, 'engine', 'mind-engine.js'), '');
    fs.writeFileSync(path.join(root, 'index.html'), '<meta charset="utf-8" /><script src="extra/new.js"></script>');
    assert.throws(() => packageSite({ env: ENV, out: path.join(tmp, 'fake-site'), root }), /not packaged: extra\/new\.js/);
  });
});

describe('the command line (as the deploy workflow runs it)', () => {
  test('exits 0 and lists the files', () => {
    const out = path.join(tmp, 'cli-site');
    const stdout = execFileSync(process.execPath, [SCRIPT, out], { env: { ...process.env, ...ENV }, encoding: 'utf8' });
    assert.match(stdout, /Packaged 9 files|Packaged \d+ files/);
    assert.ok(fs.existsSync(path.join(out, 'online-config.js')));
  });

  test('exits 1 with a GitHub error annotation when a variable is missing, and prints no key', () => {
    const env = { ...process.env, SUPABASE_URL: URL_OK };
    delete env.SUPABASE_PUBLISHABLE_KEY;
    const r = spawnSync(process.execPath, [SCRIPT, path.join(tmp, 'cli-missing')], { env, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^::error title=Site packaging::Missing SUPABASE_PUBLISHABLE_KEY\./);
    const bad = spawnSync(process.execPath, [SCRIPT, path.join(tmp, 'cli-bad')], { env: { ...process.env, SUPABASE_URL: URL_OK, SUPABASE_PUBLISHABLE_KEY: 'sb_secret_TOPSECRET' }, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.equal((bad.stdout + bad.stderr).includes('TOPSECRET'), false, 'a refused key is never echoed');
  });
});
