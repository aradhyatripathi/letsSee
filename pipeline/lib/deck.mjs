// Loads the shared deck renderer (pipeline/lib/deck-source.js) for Node.
//
// Same arrangement as core.mjs and for the same reason: deck-source.js is a plain
// browser script because the identical text is inlined into the dashboard, so the
// CLI and the Export Deck button cannot render different slides. One source of
// truth; scripts/sync-core.mjs keeps the inlined copy byte-identical and
// test/core-sync.test.mjs fails if it drifts.
//
// TyreCore is passed in as a parameter rather than read off a global, because the
// renderer's recordsToPptx() looks for it and nothing here should be publishing
// onto the real global object.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

import { TyreCore } from './core.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export const DECK_SOURCE_PATH = join(here, 'deck-source.js');
export const DECK_SOURCE = readFileSync(DECK_SOURCE_PATH, 'utf8');

const defineDeck = vm.runInThisContext(
  `(function (window, globalThis, TyreCore) {\n${DECK_SOURCE}\n;return typeof TyreDeck === 'undefined' ? null : TyreDeck;\n})`,
  { filename: DECK_SOURCE_PATH }
);

const deck = defineDeck(undefined, undefined, TyreCore);
if (!deck) {
  throw new Error(`${DECK_SOURCE_PATH} did not define TyreDeck`);
}

/** The shared PowerPoint renderer: deck model in, .pptx bytes out. */
export const TyreDeck = deck;
export default TyreDeck;
