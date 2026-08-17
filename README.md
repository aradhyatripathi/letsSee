# Tyre Intelligence Pipeline

A manually-triggered, human-reviewed pipeline that turns Indian tyre-sector quarterly
filings into one comparable record set, a four-sheet Excel workbook, and a Q&A
assistant that can only answer from those records.

Two parts, one shared data contract:

- **`pipeline/`** — a Node 20 CLI (zero runtime npm dependencies) that retrieves a
  filing per company, extracts the schema with Claude, verifies every quote against the
  retrieved text, and writes `runs/<run-id>/records.json`.
- **`dashboard/tyre_comparison_dashboard.html`** — a single-file dashboard that imports
  that JSON, holds it in `localStorage`, runs the human review pass, compares companies,
  exports the workbook, and answers grounded questions.

The build spec this implements is checked in verbatim at
[`docs/BUILD_SPEC.md`](docs/BUILD_SPEC.md). Design rationale is in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); the honest write-up of what actually
happened is [`docs/WEEK_NOTE.md`](docs/WEEK_NOTE.md).

## The two boundaries

These are the point of the project, not footnotes. Spec Section 0 fixes them, and
nothing in this repo is allowed to cross them.

**1. The trigger is always manual.** A person runs the pipeline. There is no cron, no
scheduler, no polling loop, no filesystem watcher, and no path by which any part of this
re-runs itself. `node pipeline/run.mjs` with no arguments does all nine companies in one
press — that is a well-built manual trigger, not automation. If you find yourself
wanting a timer here, that is the signal the feature belongs in the real, team-owned
build with compliance sign-off behind it.

**2. No unattended storage of scraped source documents.** Retrieved filing text is
written under `runs/<run-id>/` as working space for the current run. `runs/` and `*.pdf`
are gitignored: nothing retrieved is committed, synced to Drive, or archived anywhere on
a schedule. The only things that leave `runs/` are outputs a human has reviewed — the
records they approved and the workbook they exported. Archiving source documents is
exactly the thing the original scoping note flagged as needing a compliance decision,
and that decision has not been made.

## 60-second quickstart (no API key, no network)

```bash
node --version          # needs 20 or newer
npm test                # the contract tests; no network, no key
node pipeline/run.mjs   # all nine companies against offline fixture filings
```

The run prints a per-company progress line and finishes with the path to
`runs/<run-id>/records.json` and a human-readable `report.md`. Then:

```bash
npm run serve:dashboard   # http://localhost:8080/tyre_comparison_dashboard.html
```

In the dashboard: **Import** → drop or paste `runs/<run-id>/records.json` → the records
land under storage key `tyre-records-v2` with `review.status: "pending"`. Go to
**Review**, read each figure next to its source quote, and approve or reject. Nothing is
treated as trustworthy until you do; **Compare**, the workbook export and Q&A all
respect the approved-only filter.

Everything above works offline. Two caveats when there is genuinely no network: the
fixture filings are **synthetic test data** (each one says so on its first line — the
numbers are invented and internally consistent, and no figure in them should ever be
quoted as real), and the dashboard loads SheetJS and Chart.js from a CDN, so with no
connection the Excel export button stays disabled and charts do not render. The review,
compare table, import and delta views work regardless.

Serve the dashboard rather than opening the file directly: browsers block
`localStorage` on `file://` URLs, so records would vanish on reload.

## CLI reference

### `node pipeline/run.mjs` (`npm run run:pipeline -- [options]`)

Retrieves one quarter's filing per selected company, extracts, verifies quotes, writes
records plus a report, and exits.

| Flag | Meaning |
| --- | --- |
| `--companies=apollo,mrf` | Subset to run, by id / NSE symbol / name. Default: all nine. |
| `--quarter="Q1 FY26"` | Quarter label. Default `Q1 FY26`. |
| `--mode=fixture\|live` | `fixture` (offline sample filings, default) or `live` (Firecrawl, then direct HTTP). |
| `--offline-extract` | Use the deterministic regex extractor instead of the Claude API. Implied in fixture mode when `ANTHROPIC_API_KEY` is unset. |
| `--model=<id>` | `claude-sonnet-4-6` (default), `claude-sonnet-5`, or `claude-opus-5`. |
| `--file=<id>:<path>` | Manual-upload fallback for one company (`.txt`/`.md`/`.pdf`). Repeatable; tried before any network source. |
| `--out=<path>` | Records file. Default `runs/<run-id>/records.json`. |
| `--concurrency=N` | Companies in flight at once. Default 3. |
| `--help` | Full option list. |

Environment: `ANTHROPIC_API_KEY` (required for API extraction), `FIRECRAWL_API_KEY`
(optional; when set, live retrieval tries Firecrawl before a direct fetch).

Exit code is 0 when at least one record was produced, 1 when none were. A company that
fails retrieval or extraction is recorded as a failure and the run continues — one
awkward investor-relations page must never cost the other eight.

### Other scripts

| Command | What it does |
| --- | --- |
| `npm test` | Node's built-in test runner over `test/`. Offline. |
| `npm run serve:dashboard` | Static server for `dashboard/`. `--port=N` to move off 8080; `--dir=<path>` must stay inside the repo. |
| `npm run sync:core` | Re-inlines `pipeline/lib/core-source.js` into the dashboard. |
| `npm run check:core` | Exits 1 if the dashboard's copy has drifted. Also asserted by `npm test`. |

## Doing a real run

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node pipeline/run.mjs --mode=live --quarter="Q1 FY26"
```

What to expect, honestly:

- **Retrieval is the fragile stage.** Each company has an ordered source list in
  `pipeline/config/companies.mjs`; the runner tries them in turn and records which one
  worked. NSE and BSE pages block unfamiliar clients, IR pages move their result PDFs
  every quarter, and some pages are JavaScript shells that return a few hundred useful
  characters. Anything that thin is treated as a failure so it fails over instead of
  reaching the extractor.
- **Expect to use the manual fallback.** When a company fails, download its results PDF
  yourself and re-run just that one:
  `node pipeline/run.mjs --mode=live --companies=goodyear --file=goodyear:~/Downloads/goodyear-q1fy26.pdf`.
  The dashboard's Import → *Extract from a filing* panel does the same thing in the
  browser if you would rather not touch the CLI.
- **Live mode refuses to start without a key** rather than quietly producing
  deterministic placeholder records that look like model output. If you want live
  retrieval with the offline extractor, ask for it explicitly with `--offline-extract`.
- **PDF text extraction is dependency-free and therefore imperfect.** Scanned filings
  have no text layer and exotic font encodings come out as mojibake; both surface as an
  actionable failure, not as garbage fed forward.
- **Quote verification will reject some extractions.** Every non-empty quote must match
  the retrieved text at 85% token coverage within a window. A failure re-extracts once,
  then reports the company as failed with the offending quotes attached. That is the
  enforcement of "never fabricate a quote" — a prompt instruction alone is not.
- **Cost.** One extraction call per company (`max_tokens` 8000) plus one call per Q&A
  question (4000). Nine companies is nine calls; long filings dominate input tokens.

The two boundaries hold in live mode exactly as they do offline: you pressed the button,
and the retrieved text stays in `runs/`.

## The workbook

**Export Workbook** in the dashboard generates the four sheets from whatever records are
in storage (approved-only by default). It works for one company or all nine.

| Sheet | Contents |
| --- | --- |
| **Core Financials** | One row per company, one column per core metric, current quarter. Nulls render as `—`, never `0` or blank. |
| **Segments** | Channel split (replacement / OEM / export) and product categories (TBR, TBB, PCR, 2W, OHT). |
| **Outlook** | Paraphrased commentary, raw-material trend and capex per company. |
| **Sources & Quotes** | Every figure with its exact source quote, verification status, and the source it came from. |

Traceability means something specific here. Each populated Core Financials cell carries
a cell comment keyed `COMPANY|QUARTER|metric` — for example `Apollo Tyres|Q1 FY26|ebitda` — and that key
is the first column of Sources & Quotes. A reader who doubts a number hovers the cell,
reads the quote that produced it, and can find the full row without leaving the
workbook. A figure with no stored quote is not silently presented as equal to one: its
comment says it is unverified and its Sources & Quotes row is marked `unquoted`.

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

## Repo layout

```
pipeline/
  run.mjs                  the manual trigger: retrieve -> extract -> verify -> write
  config/companies.mjs     the nine companies and their ordered sources
  fixtures/                synthetic filings, one per company, for offline runs
  lib/
    core-source.js         THE SHARED DATA CONTRACT — schema, transforms, quote
                           verification, prompts, workbook model. Plain script,
                           inlined verbatim into the dashboard.
    core.mjs               loads core-source.js for Node: import { TyreCore }
    retrieve.mjs           Stage 1 — manual file, Firecrawl, direct fetch, fixture
    pdf.mjs                dependency-free PDF text extraction
    extract.mjs            Stage 2 — Claude extraction and the offline extractor
    anthropic.mjs          Messages API client over global fetch
    report.mjs             the per-run report.md and console summary
dashboard/
  tyre_comparison_dashboard.html   review, compare, workbook export, Q&A, import
scripts/
  sync-core.mjs            keeps the dashboard's copy of the core byte-identical
  serve.mjs                the static server behind npm run serve:dashboard
docs/                      BUILD_SPEC.md, ARCHITECTURE.md, WEEK_NOTE.md
runs/                      gitignored working space, one directory per run
```

`core-source.js` is the single source of truth. If a stage seems to need its own copy of
the schema, a transform, or a prompt, import `TyreCore` instead — `npm test` fails if the
dashboard's inlined copy drifts from the file.

## What this is not

- **Not automated.** No schedule, no watcher, no unattended re-run. See boundary 1.
- **Not an archive.** Retrieved filings live in `runs/` for the run and are not synced or
  committed. Multi-quarter historical archiving is separate engineering with a
  compliance decision in front of it.
- **Not unattended-reliable.** There is no alerting, no format-change detection and no
  retry policy beyond one re-extraction. A run is allowed to fail and need a person to
  press the button again.
- **Not a source of truth without the review pass.** Extraction produces candidates.
  Quote verification catches fabricated quotes, not wrong-but-quoted numbers. Records are
  `pending` until a human approves them, and the review gate is the safety property this
  whole design rests on.
- **Not a PowerPoint generator, and not a second dashboard.** The workbook is the primary
  output artifact; the deferred UI polish stays deferred.
- **Not real data offline.** The fixtures are synthetic. Nothing produced by a fixture run
  should be shown to anyone as a real financial figure.
