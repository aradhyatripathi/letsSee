# Tyre Intelligence Pipeline — Expanded Build Spec

> Verbatim transcription of the build spec supplied for this project
> (`Tyre_Pipeline_Expanded_Build_Spec.docx`). Kept in the repo so the
> implementation can be checked against it line by line.

Wider scope than a minimal POC — built to feel close to the real pipeline your manager has in mind. Two boundaries stay fixed regardless of scope (Section 0); everything else — company count, filing depth, Excel richness, Q&A power — is built as large as a focused week allows.

## 0. The Two Boundaries That Don't Move

Everything else in this spec is deliberately ambitious. These two are not scope dials — they're the difference between "a strong demo I can stand behind" and "the exact unattended system I told someone I couldn't responsibly own without a team, timeline, and compliance sign-off." Moving these isn't a bigger version of the same demo — it's building the thing that was declined.
- Trigger stays manual. A person runs the pipeline for a chosen company + filing, on demand. No n8n cron, no hourly polling, no unattended runs — at any scale, for any number of companies. This can be a genuinely slick one-click “run everything for Q1 FY26 across all 9 companies” button — that's still manual triggering, just a well-built manual trigger.
- No unattended storage of scraped source documents. Retrieved filings are processed in the run and written to reviewed output — not archived on a schedule to Drive or anywhere else without a human in the loop. This is the specific thing the original note flagged as needing a compliance check first, and that check hasn't happened.
If Claude Code hits a wall where the only way to make something feel more “real-pipeline” is to cross one of these two, stop and flag it back rather than building past it — that's the actual signal that a feature belongs in the real, team-owned build, not this one.

## 1. What Already Exists — Build On This, Don't Rebuild It

A working dashboard already exists (tyre_comparison_dashboard.html, ~1280 lines, single-file HTML/CSS/JS). Real, functioning pieces — reuse all of them:
- extractWithClaude() — a working Anthropic Messages API call with a schema-constrained extraction prompt that already has real guardrails: never fabricate a quote, never estimate a number, detect currency/unit explicitly from the source.
- SCHEMA_HINT — the full extraction schema (reproduced in Section 2). Use this exact shape as the backbone for everything downstream — extraction, storage, Excel, and Q&A all key off it.
- window.storage persistence under key 'tyre-records-v2', an array of records in the recToStoredShape() shape.
- SheetJS (XLSX.js) already loaded and doing a basic flat CSV-style export (exportRows(), ~line 1050) — this is the library to build the richer auto-populated workbook on top of (Section 4), not a new dependency.
- Chart.js rendering, currency normalization, quarter-over-quarter delta computation — functional, reuse as-is.
Read the actual HTML file before writing new code. Treat it as a working component to extend, not a spec to reimplement.

## 2. Data Contract — Exact Schema (Reuse As-Is)

Copied verbatim from the dashboard's SCHEMA_HINT. Every stage below — retrieval, extraction, Excel, Q&A — keys off this same shape so nothing built this week needs a translation layer later.
{
  company, quarter,                       // strings, or null
  currency: { code, unit },               // INR/USD/... , Crore/Million/...
  core: {
    revenue, ebitda, ebitda_margin, pat, net_margin, roe, roce,
    debt_equity, current_ratio, quick_ratio, interest_coverage,
    total_assets, total_liabilities, total_equity, cash,
    ocf, capex_amt, fcf, inv_turnover, dso, dpo
    // number or null, never estimated
  },
  core_quotes: { ...same keys as core, short exact quote or "" },
  segments: {
    channels: { replacement, oem, export },
    product_categories: { TBR, TBB, PCR, "2W", OHT }
  },
  outlook: { commentary, rm_trend, capex }  // paraphrased, no verbatim quotes
}
Stored shape (post recToStoredShape): id, company, quarter, source, currency{code,unit,fx_to_inr}, core{...}, quotes{...}, segments{...}, outlook{...}. Reuse the existing transform function field-for-field.

## 3. Companies & Filing Scope

As wide as the week realistically allows — the original note's full company list, not a token 2-company demo:
- All 9 companies from the original scoping note: Apollo Tyres, MRF, CEAT, JK Tyre & Industries, and the remaining 5 (confirm the full list — likely includes Balkrishna Industries, TVS Srichakra, Goodyear India, and 1-2 more depending on what “tyre sector” was scoped to mean; use whichever list your manager actually referenced).
- Filing types: quarterly results PDF (primary) and investor call transcripts (secondary, if time allows after the core pipeline is solid — don't let transcript parsing block getting the financials pipeline working end-to-end first).
- Depth over breadth if the week runs short: a genuinely solid pipeline across all 9 companies for one quarter beats a fragile pipeline across 2 companies for many quarters. If a choice has to be made, prioritize company breadth (matches the original ask) over historical depth.
- Historical backfill (prior quarters) is a good stretch goal once the current-quarter path works reliably for all 9 — not a Day 1 requirement.

## 4. Pipeline Stages


### Stage 1 — Filing Retrieval (manual trigger, batch-capable)

- Input: one click can trigger retrieval for one company or all 9 for a given quarter — still a manual trigger (a person presses it), just built to not be tedious to press 9 times.
- Use Firecrawl where it's the fastest path to stand up; fall back to direct HTTP fetch + PDF text extraction per-company if Firecrawl adds friction for any specific site. Don't block the whole pipeline on one company's site being awkward — build a per-company retrieval function so one hard case doesn't stop the other 8.
- NSE/BSE filing pages and each company's own investor-relations page are the realistic sources. Map out which of the 9 have stable, scrapeable URLs before building retrieval logic around them — note which don't, and use manual PDF upload as the fallback path for those (the dashboard already has a working file-upload → extraction path; reuse it).
- Output: raw extracted text per company, written to local files for this run — not archived on a schedule (Section 0).

### Stage 2 — Extraction (Claude API, reuse existing prompt)

- Reuse extractWithClaude() and its prompt — the guardrails are already right. Model: claude-sonnet-4-6. Raise max_tokens from the current 1500 if outputs are getting truncated on longer filings — test against a real filing early to confirm.
- The existing prompt truncates source text to 60,000 chars — verify this doesn't cut off financial statements on a full quarterly report; if it does, either raise the limit or add a pre-pass that extracts just the financial-statement section before the main extraction call.
- Validation before accepting output: reject and retry if any core_quotes value isn't a verifiable substring/fuzzy match of the Stage 1 source text — this is the actual enforcement of “never fabricate a quote,” not just a prompt instruction hoping the model complies.
- Run this per-company so a bad extraction on one filing doesn't block the other 8 from completing.

### Stage 3 — Write to Storage

- Transform via recToStoredShape() logic, write to window.storage 'tyre-records-v2', appending (not overwriting) across all 9 companies' records.
- If running outside the dashboard's own runtime (a standalone script rather than inside the artifact), write matching JSON locally and provide a clear one-step import into the dashboard.

### Stage 4 — Verification Pass (still manual, now with batch support)

- A review screen across all newly-extracted records for a run — company, quarter, and each core_quotes value visible together — so reviewing 9 companies is fast, not 9 separate slow reviews.
- No auto-accept path, at any scale. A human confirms before any record is treated as trustworthy.

## 5. Excel Auto-Population — Full Feature (explicitly requested)

Build this out properly, not as a thin wrapper on the existing flat CSV export. Reuse SheetJS (already loaded) but generate a genuinely structured workbook:
- One sheet per logical grouping: a “Core Financials” comparison sheet (all companies × all core metrics, current quarter), a “Segments” sheet (channel + product-category breakdowns where available), an “Outlook” sheet (commentary/RM trend/capex per company), and a “Sources & Quotes” sheet (every figure's exact source quote, for audit).
- Core Financials sheet: companies as rows, metrics as columns (or the transpose, whichever reads better once real data is in it), auto-populated directly from the stored records — no manual copy-paste.
- Every populated cell in the Core Financials sheet should be traceable back to the Sources & Quotes sheet (a cell comment, or a consistent row/column key) so a reader can verify any number without leaving the workbook.
- Formatting: this is a real deliverable, not a data dump — headers styled, numbers formatted with the correct unit/currency label from each record, null values shown as “—” not blank or 0.
- Trigger: a single “Export Workbook” action in the dashboard, generating the full multi-sheet file from whatever records are currently in storage — works for 1 company or all 9.

## 6. Q&A Feature — Over Stored Records AND the Excel Workbook

Your manager explicitly asked for this alongside the Excel piece — build them as one connected feature, not two separate things bolted together:
- A chat-style input in the dashboard, scoped to the currently-loaded records (window.storage 'tyre-records-v2') — covers all 9 companies once populated, not just one.
- On question submit: construct a Claude API call with the relevant stored records serialized as context (filtered by company/quarter if the question implies a scope, otherwise the full set), plus the user's question.
- System instruction: answer only from the provided records; if the records don't contain the answer, say so explicitly rather than guessing or pulling from general knowledge about these companies.
- Every answer that cites a number should show the traceable quote from the relevant record alongside the answer — same grounding discipline as the extraction stage.
- Cross-company questions should work naturally (“which company has the best EBITDA margin this quarter”, “which companies mentioned rising rubber costs in their outlook”) — this is the actual value of having all 9 companies in one place, so make sure the context sent to Claude isn't artificially limited to one company at a time.
- Same Q&A entry point should also be able to answer questions “about” the generated Excel workbook's structure (e.g. “which sheet has the segment breakdown”) — lightweight, just means the assistant knows what it built, not a second RAG system over the file.

## 7. Explicit Non-Goals (Still, Even at This Scope)

- No hourly/scheduled automation — restated from Section 0, applies regardless of how many companies or how polished the demo gets.
- No auto-generated PowerPoint deck this week — the Excel workbook (Section 5) is the primary output artifact; a PPT layer is a reasonable future ask once the core pipeline + Excel + Q&A are solid, not this week's target.
- No cross-quarter Git/Obsidian archive — window.storage persistence covers this week's scope; multi-quarter historical archiving is a real, separate piece of engineering for later.
- No unattended-reliability engineering (retry/alerting for scrape failures, format-change detection) — acceptable for a run to fail and need a manual re-trigger this week.
- No new paid vendor signups — if a tool needs a paid tier to function at 9-company scale, use a fallback (direct fetch, manual upload) rather than blocking on a new commercial relationship this week.
- Dashboard's own additional UI polish (the separately-mentioned “half-built dashboard” improvements) — explicitly deferred, to be added after this pipeline+Excel+Q&A core is working, not in parallel this week.

## 8. Definition of Done for This Week

- A single trigger runs retrieval → extraction → storage for all 9 companies' current-quarter filing (or as many as have a working retrieval path — see Section 4, Stage 1).
- Every extracted record has passed the quote-verification check (Stage 2) and a human review pass (Stage 4) before being treated as final.
- The Excel workbook exports cleanly with all 4 sheets, correctly populated, for the full company set.
- The Q&A feature can answer both single-company and cross-company questions, grounded in stored-record quotes.
- A short written note (roughly a page) covering: which companies' retrieval worked cleanly vs. needed manual fallback, what broke and how it was handled, and — explicitly — what would need to change (engineering, compliance, ownership) to move from this manual, reviewed weekly run toward the original scoping note's Phase 2 (scheduled automation). This note is the artifact that actually carries the “if it works well, I’ll sign on” conversation forward honestly — it's as important as the working code.
