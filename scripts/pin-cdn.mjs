#!/usr/bin/env node
// Pin the dashboard's two CDN scripts by hash.
//
// A review made the cost of not doing this concrete: a stand-in serving a different
// chart.umd.min.js read the operator's API key out of the page and posted it, with
// every record, to a collector. The Content-Security-Policy in the page now stops
// the sending half — the only host it may connect to is the Anthropic API — but a
// substituted script can still do anything else it likes inside the page, including
// rewriting review decisions.
//
// An integrity attribute closes that: the browser refuses a file whose hash does not
// match, so a compromised or MITM'd CDN serves nothing rather than something else.
// The hashes cannot be committed blind — they have to be computed from the real
// files — so this runs on a machine that can reach cdnjs and writes them in.
//
//   npm run pin:cdn            fetch, hash, and write the integrity attributes
//   npm run pin:cdn -- --check exit 1 if either tag is unpinned (no network needed)

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = join(REPO_ROOT, 'dashboard/tyre_comparison_dashboard.html');
const UNPINNED = '<!-- unpinned: run `npm run pin:cdn` to add integrity hashes -->';

/** Every <script src="https://..."> in the page, with the text of its whole tag. */
function cdnScripts(html) {
  return [...html.matchAll(/<script\b[^>]*\bsrc="(https:\/\/[^"]+)"[^>]*><\/script>/g)]
    .map((m) => ({ tag: m[0], url: m[1], pinned: /\bintegrity="/.test(m[0]) }));
}

async function check() {
  const html = await readFile(PAGE, 'utf8');
  const scripts = cdnScripts(html);
  const loose = scripts.filter((s) => !s.pinned);
  if (!scripts.length) {
    process.stdout.write('No CDN scripts in the dashboard — nothing to pin.\n');
    return 0;
  }
  for (const s of scripts) {
    process.stdout.write(`  ${s.pinned ? 'pinned  ' : 'UNPINNED'}  ${s.url}\n`);
  }
  if (loose.length) {
    process.stderr.write(
      `\n${loose.length} of ${scripts.length} scripts are unpinned. On a machine that can reach\n` +
      'cdnjs, run: npm run pin:cdn\n'
    );
    return 1;
  }
  return 0;
}

async function pin() {
  const html = await readFile(PAGE, 'utf8');
  const scripts = cdnScripts(html);
  if (!scripts.length) {
    process.stdout.write('No CDN scripts in the dashboard — nothing to pin.\n');
    return 0;
  }

  let out = html;
  for (const s of scripts) {
    let bytes;
    try {
      const res = await fetch(s.url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      bytes = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      process.stderr.write(
        `could not fetch ${s.url} — ${err.message}\n` +
        'Nothing was written. Run this where cdnjs is reachable.\n'
      );
      return 1;
    }
    const integrity = `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
    const tag = s.tag
      .replace(/\s+integrity="[^"]*"/, '')
      .replace('<script ', `<script integrity="${integrity}" `);
    out = out.replace(s.tag, tag.includes('crossorigin') ? tag : tag.replace('><\/script>', ' crossorigin="anonymous"></script>'));
    process.stdout.write(`  ${integrity}  ${s.url}\n`);
  }
  // The comments only apply while the tags are bare.
  out = out.split(`${UNPINNED}\n`).join('');

  if (out === html) {
    process.stdout.write('Already pinned; nothing changed.\n');
    return 0;
  }
  await writeFile(PAGE, out, 'utf8');
  process.stdout.write(
    `\nWrote ${scripts.length} integrity attribute(s) into dashboard/tyre_comparison_dashboard.html.\n` +
    'Open the page and confirm the charts still render before committing: a wrong hash\n' +
    'means the browser refuses the file silently.\n'
  );
  return 0;
}

// Windows gives process.argv[1] as C:\path\to\file.mjs while import.meta.url is
// file:///C:/path/to/file.mjs, so comparing the two as strings is never true there —
// and the failure is silent: the CLI exits 0 having done nothing. Compare resolved
// paths instead, which is what scripts/serve.mjs already did.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  (process.argv.includes('--check') ? check() : pin()).then(
    (code) => { process.exitCode = code; },
    (err) => { process.stderr.write(`${err.stack || err.message}\n`); process.exitCode = 1; }
  );
}

export { cdnScripts };
