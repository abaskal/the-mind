#!/usr/bin/env node
/* Packages the static site for GitHub Pages (MIND-07): copies only the runtime files into an output folder
 * (default _site/), generates online-config.js from SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY, and adds a
 * Content-Security-Policy to the packaged index.html.
 *
 *   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_PUBLISHABLE_KEY=sb_publishable_… node scripts/package-site.mjs [out]
 *
 * Only the project URL and the publishable (anon) key ever reach the site (I8): any other key is refused.
 * The CSP is only added to the packaged copy: the repository's index.html stays as it is for offline play (I5).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const Core = createRequire(import.meta.url)('../online/online-core.js');

// The runtime files. Everything else (supabase/, test/, docs/, scripts/, node_modules/, .github/, package*.json and
// the legacy game.js, app.js, style.css, index.previous.html, game.test.js) stays out.
const RUNTIME_FILES = ['index.html', 'engine/mind-engine.js'];
const RUNTIME_DIRS = [{ dir: 'online', ext: '.js' }];
const CONFIG_FILE = 'online-config.js';
const SUPABASE_JS_ORIGIN = 'https://cdn.jsdelivr.net';
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];

export class PackageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PackageError';
  }
}

/** Checks the two repository variables. → { supabaseUrl (origin), supabaseKey }, or throws a PackageError. */
export function readConfig(env) {
  const url = (env.SUPABASE_URL || '').trim();
  const key = (env.SUPABASE_PUBLISHABLE_KEY || '').trim();
  const missing = [!url && 'SUPABASE_URL', !key && 'SUPABASE_PUBLISHABLE_KEY'].filter(Boolean);
  if (missing.length) {
    throw new PackageError(
      `Missing ${missing.join(' and ')}. Add ${missing.length > 1 ? 'them as repository variables' : 'it as a repository variable'} ` +
      '(Settings → Secrets and variables → Actions → Variables), see docs/online/DEPLOY.md.',
    );
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    throw new PackageError(`SUPABASE_URL is not a URL: "${url}". Expected https://<project-ref>.supabase.co`);
  }
  const loopback = LOOPBACK.includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new PackageError('SUPABASE_URL must use https:// (http:// is only accepted for a local stack on this machine).');
  }
  if (!Core.isPublishableKey(key)) {
    throw new PackageError(
      'SUPABASE_PUBLISHABLE_KEY is not a publishable (anon) key. Never put a secret or service-role key in the site; ' +
      'use the "Publishable key" from the project\'s API settings (sb_publishable_…), see docs/online/DEPLOY.md.',
    );
  }
  return { supabaseUrl: parsed.origin, supabaseKey: key };
}

/** The Content-Security-Policy of the deployed page: scripts from the site and jsDelivr, network to Supabase only. */
export function contentSecurityPolicy(supabaseUrl) {
  const api = new URL(supabaseUrl);
  const ws = `${api.protocol === 'https:' ? 'wss:' : 'ws:'}//${api.host}`;
  return [
    `default-src 'self'`,
    `script-src 'self' 'unsafe-inline' ${SUPABASE_JS_ORIGIN}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `connect-src 'self' ${api.origin} ${ws}`,
    `object-src 'none'`,
    `base-uri 'self'`,
  ].join('; ');
}

export function configScript(config) {
  return '/* Generated at deploy time by scripts/package-site.mjs from the repository variables SUPABASE_URL and\n' +
    ' * SUPABASE_PUBLISHABLE_KEY. Only the project URL and the publishable key (I8). */\n' +
    `window.MIND_ONLINE = ${JSON.stringify(config)};\n`;
}

function runtimeFiles(root) {
  const files = RUNTIME_FILES.slice();
  for (const { dir, ext } of RUNTIME_DIRS) {
    for (const name of fs.readdirSync(path.join(root, dir)).sort()) {
      if (name.endsWith(ext) && fs.statSync(path.join(root, dir, name)).isFile()) files.push(`${dir}/${name}`);
    }
  }
  return files;
}

// Local files the page loads (<script src>, <link href>, <img src>): each must be in the package.
function localReferences(html) {
  return [...html.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)="([^"]+)"/gi)]
    .map((m) => m[1])
    .filter((u) => !/^[a-z][a-z0-9+.-]*:/i.test(u) && !u.startsWith('//') && !u.startsWith('#') && !u.includes('${'));
}

/**
 * packageSite({ env, out, root? }) → { out, files, csp }. Throws a PackageError for anything a person must fix.
 * `out` is emptied first; it must not be the repository itself or contain it.
 */
export function packageSite({ env, out, root = ROOT }) {
  const config = readConfig(env);
  const dest = path.resolve(out);
  const rel = path.relative(dest, root);
  if (!rel || !rel.startsWith('..')) throw new PackageError(`Refusing to write the site into ${dest}: it contains the repository.`);
  fs.rmSync(dest, { recursive: true, force: true });

  const files = runtimeFiles(root);
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true });
    fs.copyFileSync(path.join(root, f), path.join(dest, f));
  }
  fs.writeFileSync(path.join(dest, CONFIG_FILE), configScript(config));
  files.push(CONFIG_FILE);

  const indexPath = path.join(dest, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');
  const missing = localReferences(html).filter((u) => !files.includes(u.split(/[?#]/)[0]));
  if (missing.length) throw new PackageError(`index.html loads files that are not packaged: ${missing.join(', ')}. Add them to scripts/package-site.mjs.`);
  const csp = contentSecurityPolicy(config.supabaseUrl);
  const charset = /<meta charset="utf-8"\s*\/?>/i;
  if (!charset.test(html)) throw new PackageError('index.html has no <meta charset="utf-8"> to put the Content-Security-Policy after.');
  html = html.replace(charset, (m) => `${m}\n  <meta http-equiv="Content-Security-Policy" content="${csp}" />`);
  fs.writeFileSync(indexPath, html);
  return { out: dest, files: files.sort(), csp };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = packageSite({ env: process.env, out: process.argv[2] || path.join(ROOT, '_site') });
    console.log(`Packaged ${result.files.length} files into ${path.relative(process.cwd(), result.out) || '.'}:`);
    for (const f of result.files) console.log(`  ${f}`);
    console.log(`Content-Security-Policy: ${result.csp}`);
  } catch (err) {
    if (err instanceof PackageError) {
      console.error(`::error title=Site packaging::${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
