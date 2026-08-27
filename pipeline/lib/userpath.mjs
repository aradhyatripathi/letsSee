// Turning what a person typed into a path this machine understands.
//
// Every CLI here takes paths from the command line, and three of them carried their
// own copy of this, each reading process.env.HOME directly. That is a Unix-only
// variable: cmd.exe and PowerShell set USERPROFILE and leave HOME unset, so on
// Windows `--out=~/Desktop/deck.pptx` created a folder literally named `~` in
// whatever directory the user happened to be in and wrote the file there. The
// command reported success and named a path that did not exist. `~` is also not
// something the shell expands for you inside a `--flag=value` argument on any
// platform, so this cannot simply be deleted.
//
// os.homedir() already knows the answer on every platform. The fourth CLI,
// archive.mjs, had no expansion at all and now shares this one.

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** `~` and `~/x` (or `~\x` on Windows) become the user's home directory. */
export function expandHome(path) {
  const s = String(path == null ? '' : path);
  if (s === '~') return homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return join(homedir(), s.slice(2));
  return s;
}

/**
 * A path the user typed, resolved against where they ran the command.
 *
 * This is what every CLI wants: expand `~` first, then make it absolute relative to
 * the working directory, so a relative path means what the person standing in that
 * directory expects it to mean.
 */
export function resolveUserPath(path, from = process.cwd()) {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? expanded : resolve(from, expanded);
}
