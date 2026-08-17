// Loads the shared core (pipeline/lib/core-source.js) for Node.
//
// core-source.js is a plain browser script — no imports, no exports — because the
// same text is inlined into the dashboard. Rather than keep a second, divergent
// ES-module copy, we compile that one file here and re-export what it defines.
// One source of truth; scripts/sync-core.mjs keeps the copy inside the dashboard
// byte-identical, and test/core-sync.test.mjs fails if it ever drifts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));

export const CORE_SOURCE_PATH = join(here, 'core-source.js');
export const CORE_SOURCE = readFileSync(CORE_SOURCE_PATH, 'utf8');

// Compiled into this realm, not a fresh vm context: a record built by the core
// has to be an ordinary object here, and an error it throws has to be an ordinary
// Error, exactly as they are in the browser. `window` and `globalThis` are
// shadowed as undefined parameters so the file's two publishing lines are skipped
// and nothing lands on the real global.
const defineCore = vm.runInThisContext(
  `(function (window, globalThis) {\n${CORE_SOURCE}\n;return typeof TyreCore === 'undefined' ? null : TyreCore;\n})`,
  { filename: CORE_SOURCE_PATH }
);

const core = defineCore(undefined, undefined);
if (!core) {
  throw new Error(`${CORE_SOURCE_PATH} did not define TyreCore`);
}

/** The shared data contract: schema, transforms, verification, prompts, workbook. */
export const TyreCore = core;
export default TyreCore;
