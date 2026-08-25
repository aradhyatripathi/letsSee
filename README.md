# Tyre Intelligence Pipeline

A manually-triggered, human-reviewed pipeline that turns Indian tyre-sector quarterly
filings into one comparable record set, a four-sheet Excel workbook, a slide deck, and a
Q&A assistant that can only answer from those records.

Two parts, one shared data contract:

- **`pipeline/`** — a Node 20 CLI (zero runtime npm dependencies) that retrieves a
  filing per company, extracts the schema with Claude, verifies every quote against the
  retrieved text, and writes `runs/<run-id>/records.json`.
- **`dashboard/tyre_comparison_dashboard.html`** — a single-file dashboard that imports
  that JSON, holds it in `localStorage`, runs the human review pass, compares companies,
  exports the workbook and the deck, and answers grounded questions.

The build spec this implements is checked in verbatim at
[`docs/BUILD_SPEC.md`](docs/BUILD_SPEC.md). Design rationale is in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); the honest write-up of what actually
happened is [`docs/WEEK_NOTE.md`](docs/WEEK_NOTE.md). If you are deciding how far this
should go, [`docs/SCOPE_OPTIONS.md`](docs/SCOPE_OPTIONS.md) lays out the two competing
definitions of the project. If you have to explain it to someone,
[`docs/EXPLAINER.md`](docs/EXPLAINER.md).

## The two boundaries

These are the point of the project, not footnotes. Spec Section 0 fixes them, and
nothing in this repo is allowed to cross them.

**1. The trigger is always manual.** A person runs the pipeline. There is no cron, no
scheduler, no polling loop, no filesystem watcher, and no path by which any part of this
re-runs itself. `node pipeline/run.mjs` with no arguments does the whole roster in one
press — that is a well-built manual trigger, not automation. If you find yourself
wanting a timer here, that is the signal the feature belongs in the real, team-owned
build with compliance sign-off behind it.

**2. No unattended storage of scraped source documents.** Retrieved filing text is
written under `runs/<run-id>/` as working space for the current run. `runs/` and `*.pdf`
are gitignored: nothing retrieved is committed, synced to Drive, or archived anywhere on
a schedule. What leaves `runs/` is output a human has reviewed — the records they
approved, the workbook and deck they exported, and the quarters they chose to archive.
Archiving *source documents* is the thing the original scoping note flagged as needing a
compliance decision, and that decision has not been made.

Read boundary 2 precisely, because a lot follows from it: scraped filings may not be
kept, and "reviewed output" is named as the permitted destination. That is why
[`archive/`](#keeping-quarters) exists and why it refuses anything a person has not
approved.

## 60-second quickstart (no API key, no network)

```bash
node --version    # needs 20 or newer
npm test          # the contract tests; no network, no key
npm run demo      # retrieval check, full run, a draft deck, and the archive refusing it
```

`npm run demo` is the whole thing end to end, across two quarters so the
quarter-on-quarter deltas and the deck's trend slides have something to compute. It
finishes by telling you how to do the review for real, and it stops short of approving
anything on purpose: a script that ticked the review box would be manufacturing a review
while demonstrating a system whose entire argument is that it doesn't.

Then look at it:

```bash
npm run serve:dashboard   # http://localhost:8080/tyre_comparison_dashboard.html
```

In the dashboard: **Records → Restore / import JSON** → `demo-output/records.json` → the
records land under storage key `tyre-records-v2` with `review.status: "pending"`. An
imported file can never approve anything — it can introduce a rejection, keep a decision
this browser already made, and nothing else. Go to
**Review**, read each figure next to its source quote, and approve or reject. Nothing is
treated as trustworthy until you do; **Compare**, the workbook, the deck and Q&A all
respect the approved-only filter.

Serve the dashboard rather than opening the file directly: browsers block `localStorage`
on `file://` URLs, so records would vanish on reload.

Two caveats worth stating plainly.

The fixture filings are **synthetic test data** — each says so on its first line, the
numbers are invented, and no figure in them should ever be quoted as real. Two quarters
are on disk, Q4 FY25 and Q1 FY26. Where a company's Q1 FY26 filing carries comparative
columns, the Q4 FY25 fixture restates that column exactly, so the two agree about the same
quarter the way successive real filings do.

And the dashboard loads Chart.js and pdf.js from a CDN, so with no connection the charts do
not render and a PDF cannot be read in the browser. **Both output artefacts work
regardless** — the workbook and the deck are written by this project rather than by a
library, precisely so the things it exists to produce do not depend on a network.

## Working without an API key

The key is the one thing that cannot be worked around, so these three routes exist to
make everything else demonstrable without it. None of them loosens a guardrail.

| Route | Answers | Needs |
| --- | --- | --- |
| `--retrieve-only` | Which company's investor-relations page actually hands over a filing | Network |
| `--emit-prompt` | What exactly would be sent to the model | Nothing |
| `--response=<id>:<path>` | Whether a real filing survives real extraction | A person with a Claude chat open |

The third is the interesting one. `--emit-prompt` writes the real prompt — same
guardrails, same schema, same filing text — to `runs/<run-id>/prompts/`, along with the
exact command to feed the answer back. Paste it into a Claude chat, paste the JSON that
comes back into a file, and:

```bash
node pipeline/run.mjs --companies=ceat --file=ceat:~/Downloads/ceat-q1fy26.pdf --emit-prompt
# ... carry the prompt to a chat, save the answer ...
node pipeline/run.mjs --companies=ceat --file=ceat:~/Downloads/ceat-q1fy26.pdf --response=ceat:answer.json
```

You are the transport; nothing else changes. The answer goes through the same
`parseModelJSON → recToStoredShape → validateStored → verifyQuotes` path an API answer
does, verified against the same retrieved text, so a quote that is not in the filing is
rejected on the way back in exactly as it would be live. Records that arrive this way are
stamped `claude-manual` so a reader can always tell which crossed the network and which
were carried.

## CLI reference

### `node pipeline/run.mjs` (`npm run run:pipeline -- [options]`)

Retrieves one quarter's filing per selected company, extracts, verifies quotes, writes
records plus a report, and exits.

| Flag | Meaning |
| --- | --- |
| `--companies=apollo,mrf` | Subset to run, by id / NSE symbol / name. Default: the whole roster. |
| `--quarter="Q1 FY26"` | Quarter label. Default `Q1 FY26`. |
| `--mode=fixture\|live` | `fixture` (offline sample filings, default) or `live` (Firecrawl, then direct HTTP). |
| `--offline-extract` | Use the deterministic regex extractor instead of the Claude API. Implied in fixture mode when `ANTHROPIC_API_KEY` is unset. |
| `--model=<id>` | `claude-sonnet-4-6` (default), `claude-sonnet-5`, or `claude-opus-5`. |
| `--no-thinking` | Extract without adaptive thinking. On by default. |
| `--file=<id>:<path>` | Manual-upload fallback for one company (`.txt`/`.md`/`.pdf`). Repeatable; tried before any network source. |
| `--retrieve-only` | Stage 1 only. Reports what each source returned and writes no records. |
| `--emit-prompt` | Write the real extraction prompt and stop. Sends nothing. |
| `--response=<id>:<path>` | Read a pasted answer back in and verify it. Repeatable. |
| `--out=<path>` | Records file. Default `runs/<run-id>/records.json`. |
| `--concurrency=N` | Companies in flight at once. Default 3. |
| `--help` | Full option list. |

Environment: `ANTHROPIC_API_KEY` (required for API extraction), `FIRECRAWL_API_KEY`
(optional; when set, live retrieval tries Firecrawl before a direct fetch).

Exit code is 0 when at least one record was produced, 1 when none were. A company that
fails retrieval or extraction is recorded as a failure and the run continues — one
awkward investor-relations page must never cost the rest.

### `node pipeline/deck.mjs` (`npm run deck -- [options]`)

Builds the sector deck from a records file. Approved-only by default, because a deck
circulates further than a workbook does.

| Flag | Meaning |
| --- | --- |
| `--records=<path>` | Records JSON: a run output, a dashboard export, or a bare array. Required. |
| `--out=<path>` | Where to write the `.pptx`. Default: alongside `--records`. |
| `--quarter="Q1 FY26"` | Which quarter to compare. Default: the latest in the file. |
| `--include-pending` | Include unreviewed records, marked `*` on every slide they appear on. |

### `node pipeline/workbook.mjs` (`npm run workbook -- [options]`)

Builds the four-sheet workbook from a records file. Approved-only by default; every row
carries its review state either way.

| Flag | Meaning |
| --- | --- |
| `--records=<path>` | Records JSON: a run output, a dashboard export, or a bare array. Required. |
| `--out=<path>` | Where to write the `.xlsx`. Default: alongside `--records`. |
| `--include-pending` | Include unreviewed records. Every row still says `NOT REVIEWED`. |

### `node pipeline/archive.mjs` (`npm run archive -- [options]`)

| Flag | Meaning |
| --- | --- |
| `--records=<path>` | Add approved records to the archive. Anything unapproved is refused by name. |
| `--export=<path>` | Write the whole archive as one records file, ready to import. |
| `--list` | Show what is archived. |
| `--dir=<path>` | Archive location. Default `archive/`. |
| `--force` | Accept a change to an already-archived record. |

### Other scripts

| Command | What it does |
| --- | --- |
| `npm run demo` | The whole pipeline offline — both artefacts — ending in the archive refusing unreviewed records. |
| `npm test` | Node's built-in test runner over `test/`. Offline. |
| `npm run serve:dashboard` | Static server for `dashboard/`. `--port=N` to move off 8080; `--dir=<path>` must stay inside the repo. |
| `npm run sync:core` | Re-inlines the shared source blocks into the dashboard. |
| `npm run check:core` | Exits 1 if the dashboard's copies have drifted. Also asserted by `npm test` and in CI. |

## Doing a real run

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node pipeline/run.mjs --mode=live --quarter="Q1 FY26"
```

What to expect, honestly:

- **Retrieval is the fragile stage, and it is the one thing never tested against a live
  site.** Each company has an ordered source list in `pipeline/config/companies.mjs`; the
  runner tries them in turn and records which one worked. NSE and BSE pages block
  unfamiliar clients, IR pages move their result PDFs every quarter, and some pages are
  JavaScript shells that return a few hundred useful characters. Anything that thin is
  treated as a failure so it fails over instead of reaching the extractor. Run
  `--retrieve-only` first from a machine with network and you will know where you stand
  in about a minute.
- **Expect to use the manual fallback.** When a company fails, download its results PDF
  yourself and re-run just that one:
  `node pipeline/run.mjs --mode=live --companies=goodyear --file=goodyear:~/Downloads/goodyear-q1fy26.pdf`.
  The dashboard's *Extract from a filing* panel does the same thing in the browser.
- **Live mode refuses to start without a key** rather than quietly producing
  deterministic placeholder records that look like model output. It names the key-free
  routes in the error instead of only refusing.
- **PDF text extraction is dependency-free and therefore imperfect.** Scanned filings
  have no text layer and exotic font encodings come out as mojibake; both surface as an
  actionable failure, not as garbage fed forward.
- **Quote verification will reject some extractions.** Every quote must match the
  retrieved text at 85% coverage within a window, word order counted, and the figure must
  appear in its own quote. A figure reported with *no* quote fails too — the prompt's own
  rule is that a figure you cannot quote is returned as null, so an unquoted figure is the
  model breaking it. A failure re-extracts once, then reports the company as failed with
  the offending quotes attached. That is the enforcement of "never fabricate a quote" — a
  prompt instruction alone is not.
- **Cost.** One extraction call per company (`max_tokens` 16000, adaptive thinking) plus
  one call per Q&A question (4000). Seven companies is seven calls; long filings dominate
  input tokens.

The two boundaries hold in live mode exactly as they do offline: you pressed the button,
and the retrieved text stays in `runs/`.

## The workbook

**Export Excel workbook** in the dashboard, or `npm run workbook`. Four sheets from
whatever records are in storage, approved-only by default.

| Sheet | Contents |
| --- | --- |
| **Core Financials** | One row per company, one column per core metric, and a **Review** column saying who approved it or `NOT REVIEWED`. Nulls render as `—`, never `0` or blank. |
| **Segments** | Channel split (replacement / OEM / export) and product categories (TBR, TBB, PCR, 2W, OHT). |
| **Outlook** | Paraphrased commentary, raw-material trend and capex per company. |
| **Sources & Quotes** | Every figure with its exact source quote, review state, verification status, and the source it came from. |

The file is written directly — a `.xlsx` is a ZIP of XML, the same as the deck — so it
needs no library and no network. It used to come from a CDN, which made the spec's primary
deliverable the one thing that failed on a machine behind a corporate proxy. Writing it
here also recovers the styled headers and wrapped text the community build of SheetJS
dropped.

Traceability means something specific here. Each populated Core Financials cell carries a
cell comment keyed `COMPANY|QUARTER|metric` — for example `Apollo Tyres|Q1 FY26|ebitda` —
and that key is the first column of Sources & Quotes. A reader who doubts a number hovers
the cell, reads the quote that produced it, and can find the full row without leaving the
workbook. A figure with no stored quote is not silently presented as equal to one: its
comment says it is unverified and its Sources & Quotes row is marked `unquoted`.

## The deck

**Export PowerPoint deck**, or `npm run deck`. Title, a provenance slide, one comparison
slide per metric group, channel and product mix, outlook themes, a slide per company, and
a closing slide stating plainly what quote verification does *not* catch.

Three rules it will not bend:

- A record a reviewer rejected is never on it, with the approved-only box ticked or not.
- Unreviewed companies are marked `*` on every slide they appear on, explained in the
  footnote rather than only in the preamble.
- Figures are never converted between currencies. Where the selected records disagree,
  the unit moves into its own column and the slide says the columns are not a ranking.

The file is built with no library on either side — a `.pptx` is a ZIP of XML, and the
renderer writes both, so the browser needs no CDN and the CLI needs no dependency. The
dashboard button and `pipeline/deck.mjs` run the same inlined code and cannot drift.

## Keeping quarters

```bash
npm run archive -- --records=<your reviewed export>   # add approved records
npm run archive -- --list                             # what is in it
npm run archive -- --export=history.json              # read it back out
```

`archive/` holds one JSON file per company per quarter, committed by a person. Only
approved records go in, which is the whole distinction boundary 2 draws: reviewed output
may be kept, scraped filings may not. Retrieved text never reaches it, and a test fails if
a document-sized string ever lands in one.

Once the archive spans more than one quarter, the deck compares the latest quarter and
adds trend slides for revenue and EBITDA margin across all of them.

## How Q&A is grounded

The **Ask** view sends the currently-loaded records — serialized whole, so cross-company
questions like "which company has the best EBITDA margin this quarter" or "which
companies mentioned rising rubber costs" work naturally — along with your question. The
system instruction says the records are the entire world: answer only from them, say so
plainly when they do not contain the answer, and never fall back on general knowledge
about these companies. Any cited number must be shown with the record's stored quote,
company and quarter; a number with no quote is reported as unverified. Comparisons only
happen across the same currency and unit basis, and the model is told that `null` means
"not reported", which is not zero. The same entry point also knows the workbook's sheet
structure, so "which sheet has the segment breakdown" is answerable without a second
retrieval system over the file.

The API key you enter in Settings is held in memory for that browser tab only. It is not
written to `localStorage`.

## The roster

`pipeline/config/companies.mjs` is the only file that knows which companies exist, and
nothing anywhere assumes a count — the suite has been run green at two, three, four,
five, six, seven and nine. Add or remove entries freely; the only follow-up is a fixture
per new company id in each quarter directory (`pipeline/fixtures/<quarter-slug>/<id>.txt`)
so offline runs keep covering it, which the tests will tell you about by name if you
forget.

## Repo layout

```
pipeline/
  run.mjs                  the manual trigger: retrieve -> extract -> verify -> write
  deck.mjs                 the sector deck, from a records file
  workbook.mjs             the four-sheet workbook, from a records file
  archive.mjs              the cross-quarter archive of reviewed records
  config/companies.mjs     the roster and each company's ordered sources
  fixtures/<quarter>/      synthetic filings, one per company per quarter, offline runs
  lib/
    core-source.js         THE SHARED DATA CONTRACT — schema, transforms, quote
                           verification, prompts, workbook and deck models. Plain
                           script, inlined verbatim into the dashboard.
    deck-source.js         the PowerPoint renderer, inlined the same way
    xlsx-source.js         the Excel renderer; uses the deck block's ZIP container
    core.mjs / deck.mjs / xlsx.mjs   load those three for Node
    retrieve.mjs           Stage 1 — manual file, Firecrawl, direct fetch, fixture
    pdf.mjs                dependency-free PDF text extraction
    extract.mjs            Stage 2 — Claude, the offline extractor, and the carried answer
    anthropic.mjs          Messages API client over global fetch
    report.mjs             the per-run report.md and console summary
dashboard/
  tyre_comparison_dashboard.html   review, compare, workbook, deck, Q&A, import
scripts/
  sync-core.mjs            keeps the dashboard's inlined copies byte-identical
  serve.mjs                the static server behind npm run serve:dashboard
  demo.mjs                 npm run demo
archive/                   reviewed records, one file per company per quarter (committed)
runs/                      gitignored working space, one directory per run
docs/                      BUILD_SPEC, ARCHITECTURE, WEEK_NOTE, SCOPE_OPTIONS, EXPLAINER
```

`core-source.js` is the single source of truth. If a stage seems to need its own copy of
the schema, a transform, or a prompt, import `TyreCore` instead — `npm test` fails if the
dashboard's inlined copies drift from the files. The three blocks load in order: the core
is data, the deck block owns the ZIP container both output formats are built on, and the
xlsx block uses it.

## What this is not

- **Not automated.** No schedule, no watcher, no unattended re-run. See boundary 1.
- **Not an archive of source documents.** Retrieved filings live in `runs/` for the run
  and are not synced or committed. `archive/` holds reviewed records only — that is the
  distinction boundary 2 draws, and it is enforced, not merely described.
- **Not unattended-reliable.** There is no alerting, no format-change detection and no
  retry policy beyond one re-extraction. A run is allowed to fail and need a person to
  press the button again.
- **Not a source of truth without the review pass.** Extraction produces candidates.
  Quote verification catches a fabricated quote, a quote reassembled out of order, a
  figure that is not in the span quoted to support it, and a figure offered with no quote
  at all. It cannot catch a figure quoted faithfully from the wrong *table*. Records are
  `pending` until a human approves them, and that gate is the safety property this whole
  design rests on — which is why no imported file can approve anything, and why restoring
  a backup brings the data back pending and the reviews have to be made again.
- **Not proven against a real filing.** Nothing here has been run against a live site or
  a live API. Every number in this repo came from a synthetic fixture. The routes above
  exist so that can be fixed without waiting for a key.
