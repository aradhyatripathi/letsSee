// Things that work on the machine they were written on and nowhere else.
//
// The pipeline is meant to be handed to an analyst and run on their own laptop, which
// in this case is a Windows PC. Both defects below were found the day before a demo,
// and neither would have shown up here: everything is developed and tested on Linux,
// and CI runs on Linux too.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every .mjs file we ship, excluding anything generated or vendored. */
function sourceFiles(dir = REPO_ROOT, found = []) {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.git', 'runs', 'demo-output', 'archive'].includes(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (entry.endsWith('.mjs')) found.push(path);
  }
  return found;
}

// A CLI decides whether it is being run directly or imported. Comparing
// import.meta.url against a string built as `file://` + process.argv[1] is true on
// Linux and macOS and never true on Windows, where argv[1] is C:\path\to\file.mjs
// and the URL is file:///C:/path/to/file.mjs.
//
// The failure is the worst kind: silent. `npm run workbook` exits 0 having done
// nothing at all — no output, no error, no file. Someone would reasonably conclude
// the tool is broken and not know why.
test('no entry point decides it was run directly by string-building a file:// URL', () => {
  const offenders = [];
  for (const path of sourceFiles()) {
    const source = readFileSync(path, 'utf8');
    for (const [i, line] of source.split('\n').entries()) {
      // The comment explaining the fix mentions the shape, so match code that
      // actually compares — a template literal against import.meta.url.
      if (/import\.meta\.url\s*===\s*`file:\/\/\$\{/.test(line)) {
        offenders.push(`${path.replace(`${REPO_ROOT}/`, '')}:${i + 1}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'compare resolve(process.argv[1]) with fileURLToPath(import.meta.url) instead');
});

// npm runs package scripts through cmd.exe on Windows, and cmd.exe does not expand
// globs — it hands `test/*.test.mjs` to node verbatim, which cannot open a file by
// that name. `npm test`, the first thing anyone runs, failed on Windows with an
// error that says nothing about the real cause.
test('no package script relies on the shell expanding a wildcard', () => {
  const { scripts } = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const offenders = Object.entries(scripts || {})
    .filter(([, command]) => /[*?]/.test(command) || /\[[^\]]+\]/.test(command))
    .map(([name, command]) => `${name}: ${command}`);

  assert.deepEqual(offenders, [], 'cmd.exe does not expand globs, so the pattern reaches the program as text');
});

// Paths are joined, not concatenated. A path built with a literal '/' is wrong on
// Windows in exactly the places it matters least often and hurts most: writing an
// output file the user then cannot find.
test('output paths are built with join or resolve, not string concatenation', () => {
  const offenders = [];
  for (const path of sourceFiles()) {
    if (path.includes('/test/')) continue;              // test fixtures may fake paths
    const source = readFileSync(path, 'utf8');
    for (const [i, line] of source.split('\n').entries()) {
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
      // A template literal that glues a directory variable to a filename with a slash.
      if (/`\$\{\s*(?:dir|outDir|runDir|root|REPO_ROOT|base)\w*\s*\}\//.test(line)) {
        offenders.push(`${path.replace(`${REPO_ROOT}/`, '')}:${i + 1}: ${line.trim().slice(0, 80)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'use join() so the separator is right on every platform');
});
