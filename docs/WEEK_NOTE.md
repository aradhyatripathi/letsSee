# Week note — tyre intelligence pipeline

This is the Section 8 deliverable, and it is meant to be read alongside the code rather
than instead of it. The point of writing it is to carry the "if it works well, I'll sign
on" conversation forward honestly, which means being clear about what we did not manage
as well as what we did.

## The headline caveat: nothing was retrieved live

The most important thing to say first, because everything else is qualified by it: in
the environment this was built in there was no outbound network to NSE, BSE, or any
company's investor-relations site, and no Anthropic API key. So the honest answer to
"which companies' retrieval worked cleanly and which needed the manual fallback" is that
we do not know yet. Zero of the nine were retrieved live. All nine ran end to end
through synthetic fixture filings — one text file per company, each marked SYNTHETIC TEST
DATA on its first line, written in the register these companies actually file in, with
invented but internally consistent numbers. No figure anywhere in this repo is a real
reported figure.

What that does and does not prove. It proves the contract: nine companies go through
retrieval, extraction, quote verification, the stored shape, the review screen, the
four-sheet workbook and Q&A without a translation layer anywhere, and the whole thing is
runnable by a colleague with `node pipeline/run.mjs` and no credentials. It proves the
quote-verification gate rejects quotes that are not in the source, because we can force
that case deliberately. It proves nothing at all about whether Apollo's IR page will
serve us a PDF next Tuesday.

The retrieval code for a real run is written properly rather than stubbed: per-company
ordered source lists, an operator-supplied file tried first, Firecrawl when a key is
present, then a direct fetch with a browser user-agent, with a minimum-useful-length
check so a cookie wall or a JavaScript shell fails over instead of being handed to the
extractor as if it were a filing. Live mode refuses to start without an API key rather
than quietly falling back to the deterministic offline extractor and producing records
that look like model output. But written correctly is not the same as verified, and the
first real run should be treated as the actual test of Stage 1. Our expectation, based on
how these sites behave generally, is that the two or three companies whose results live
behind an NSE or BSE page will need the manual-upload path, and that the IR pages will
need their URLs rechecked every quarter because these sites reorganise their financials
sections routinely. The `--file=<company>:<path>` flag and the dashboard's upload panel
exist so that is a thirty-second fix per company, not a blocker.

One more thing that belongs in this section rather than buried: `pipeline/config/companies.mjs`
holds nine companies, but only seven are certain. The spec names four explicitly and
suggests three more; we filled the last two (Modi Rubber, PTL Enterprises) by inference
from the listed Indian tyre universe and marked them `confirmed: false` in the file.
Those two need checking against the original scoping note before anyone runs this for
real. Changing the roster means editing that one list and nothing else.

## What broke, and what we did about it

**The dashboard the spec said already existed was not in the repo — until it was.**
Section 1 describes `tyre_comparison_dashboard.html` as a working ~1280-line file to build
on. It was not there, so we rebuilt it from the spec's description, keeping the names the
spec quotes so the two could be reconciled by diff rather than by rewrite. The real file
then arrived, and that bet paid off: it is now the base, committed untouched first so
every change since is a reviewable diff, and the reconstruction was discarded.

Reading the real file changed several things. It is better than the reconstruction in
ways that mattered — a manual entry form with real validation, per-record FX editing, a
competitive-analysis view, JSON backup and restore, pdf.js reading PDFs in the browser,
and period handling that covers calendar-year reporters and half-years, which the
reconstruction dropped to null. Those are now the behaviour; where the two disagreed we
took the real file's values as authoritative, including its FX rates.

It also had sharp edges worth naming. `extractWithClaude` sent no authentication at all —
just a content-type header — which works only because the Claude artifact runtime proxies
the call on its behalf; with a real key, or served as an ordinary file, it would fail, and
browser-origin calls additionally need `anthropic-dangerous-direct-browser-access`. Its
schema asked for a quote for eight of the twenty-one metrics, so thirteen figures per
record were unverifiable by construction. It truncated filings at 60,000 characters and
capped `max_tokens` at 1,500, both of which Section 4 flags. And it had no verification,
no review gate and a single flat sheet for Excel. Those are the gaps this week closed.

One integration detail worth recording because it is the kind of thing that bites later:
the shared core is inlined in its own script wrapped in an IIFE. The dashboard declares
`SCHEMA_HINT`, `computeDeltas` and `recToStoredShape` at the top level and the core
declares all three too, so a naive inline either throws on the `const` redeclaration or
silently replaces the dashboard's versions with differently-shaped ones. Function-scoping
the core and publishing only `TyreCore` keeps both intact.

**Two copies of the data contract would have drifted immediately.** The dashboard is a
single file by design and the pipeline is Node ES modules; both need the schema,
transforms, verification, prompts and workbook model. We put one copy in
`pipeline/lib/core-source.js`, written as a plain script so it can be inlined verbatim
into the dashboard, and loaded it into Node through a small `vm` shim.
`scripts/sync-core.mjs` copies it; `npm test` fails if the dashboard's copy has drifted.
That removes the whole class of bug where the workbook quietly stops matching what the
extractor produces.

**The 60,000-character truncation the spec flags is a real problem.** A full quarterly
results PDF for one of these companies runs well past that, and the financial statements
are usually not in the first 60,000 characters — the cover, the auditor's report and the
notes come first. Cutting there would silently produce records full of nulls that look
like "the company didn't report it". We raised the budget to 400,000 characters and,
when a document still exceeds it, kept the head of the document (for company and quarter
context) plus the highest-scoring window of financial-statement markers rather than the
first N characters. This is better than truncating blindly and it is not the same as
solving it: a filing with its statements split across two distant regions can still lose
one of them, and the honest fix is a real section-aware pre-pass. We would want to see
that against a handful of actual filings before trusting it at scale.

**PDF text extraction is dependency-free and therefore imperfect.** The constraint was
zero runtime npm dependencies, so there is no pdf.js here: we walk the indirect objects,
inflate the FlateDecode streams with `node:zlib`, and pull text-showing operators out of
the content streams ourselves. That handles ordinary text-layer PDFs. It does not handle
a scanned filing (no text layer at all) and it produces mojibake for a document with
custom font encodings and no ToUnicode map. Both cases surface as an actionable failure
with a reason, and retrieval falls through to manual upload, which is the right
degradation — but it does mean some fraction of real filings will land on a human, and
we will not know what fraction until a live run.

**Quote verification rejects real quotes sometimes.** The threshold is 0.85 after
normalising quote marks, dashes and whitespace, which is the kind of mangling a PDF
extractor reliably introduces. It is tuned by judgement, not by data. Set it too high and
honest extractions get rejected and re-run for nothing; too low and the gate stops
meaning anything. Tuning it against real filings is on the list below, and until then the
failure mode is conservative: a rejected record is reported as a failure with the
offending quotes attached, so a person can look at it.

**Two holes in that gate turned up in review, and both are closed.** The first: the check
confirmed a quote appeared in the source but never confirmed the reported *number*
appeared in the span quoted to support it. Since these filings put three or four
comparative columns side by side, a model could quote an entirely genuine row label and
report the prior quarter's figure from it, and the record would be stamped `verified`.
The check now requires the figure to appear in its own quote, with a tolerance so a
rounded percentage still passes; a mismatch is reported as `value_not_in_quote`, which
names the likely cause rather than just failing. The second: the matcher scored an
unordered bag of words, so a quote reassembled from the document's own words in an order
the document never used scored a perfect 1.0. It now re-scores candidate spans by longest
common subsequence, so word order counts. Both cases are pinned by tests. Worth saying
plainly: these were found by reading the code adversarially, not by any run failing — the
141 fixture quotes passed before the fix and pass after it, which is exactly why a green
run is not evidence that a gate works.

**A second review pass found two more, in the same place.** The value check we had just
added rejected a loss quoted the way Indian filings actually write one — `(1,234.50)` in
the accounting convention — because it read the parentheses as punctuation rather than a
minus sign. The consequence was worse than a false alarm: the extract path refuses to
store a record whose quotes fail, so one loss-making quarter would have thrown away all
twenty other correctly-verified figures on that filing with it. In the other direction,
the same check treated every digit run in a quote as a candidate figure, so the text
`Q1 FY26` would happily support a fabricated ROCE of 26, or a fabricated ratio of 1 — a
hole in exactly the gate that is supposed to be load-bearing. Period labels and dates are
now scrubbed before the figure is looked for, and a bare four-digit number is deliberately
left alone, because it can be a real figure rather than a year.

Three more turned up away from verification. The workbook exported records a reviewer had
explicitly rejected whenever the "approved only" box was unticked, which made the primary
deliverable the one output that circulated data a person had already thrown out. A
currency or unit edit kept an existing approval, so switching a record from INR crore to
USD million left it approved with every figure wrong by two orders of magnitude. And a
file only had to declare `backup_version` to have its own review decisions trusted, which
meant any JSON could import itself as approved. A review decision is now carried in only
where this browser already holds that exact record unchanged: a genuine backup restores
its approvals, a foreign file does not.

The pattern across all five is worth stating once. None of them surfaced from a run. Every
one was found by reading the code against a hostile case, and every one would have put a
confident, plausible, wrong number in front of a reviewer.

## What would have to change for Phase 2

Phase 2 in the original scoping note is scheduled automation. This week deliberately did
not build toward it — the two Section 0 boundaries hold everywhere in this repo, and the
one-click "run all nine" button is a well-built manual trigger, not a step toward a cron.
Moving to Phase 2 is a different project with different risk, and this is the honest list
of what it would actually take.

*Engineering.* Retrieval reliability is the whole problem. Right now a company that
fails is a line in a report that a person reads; unattended, it is a silent gap in a
dataset someone else is about to make a decision from. That means format-change
detection — noticing that a page we have scraped for six months now returns a login wall
or an empty shell, and distinguishing that from a company that simply has not filed yet —
plus retry policy, alerting, and a health signal per company rather than per run. The
truncation pre-pass needs to be section-aware and validated against real filings. Quote
verification needs its threshold tuned against a corpus we have actually labelled, and
probably needs to distinguish "not in the source" from "in the source but mangled by the
PDF extractor", because those want different responses. Cost needs a number attached:
one extraction call per company per run plus Q&A traffic is trivially cheap at nine
companies and weekly cadence, and stops being trivial at a larger universe or a daily
one, so someone should put a real figure on it before the cadence is chosen.

*Compliance.* This is the piece that cannot be engineered around, and it is the specific
thing the original note flagged. Today every retrieved document lives in `runs/`, is
gitignored, and is never synced anywhere — that is boundary 2, and it is the reason we can
run this at all without a sign-off. Any scheduled version stores scraped source documents
unattended, which needs an actual retention and permitted-use decision first: what may be
retained, for how long, where it may be stored, whether each source's terms allow
automated retrieval at all, and who is accountable if the answer turns out to be no. That
decision has not been made. It should be made by the people who can make it, in writing,
before any archiving is switched on — not inferred from the fact that the code could do
it.

*Ownership.* The question we would want answered before anything runs on a schedule is
who is on the hook when it fails at 3am on a quarter-end night. Not who wrote it — who is
paged, who decides whether to re-run or to publish with a gap, who tells the people
downstream that Tuesday's numbers are one company short. Unattended systems generate that
question whether or not anyone has agreed to answer it.

And the one that matters most: the review gate is the safety property this design rests
on. Quote verification now catches a fabricated quote, a quote reassembled out of order,
and a figure that is not in the span quoted to support it. What it still cannot catch is
a figure quoted faithfully from the wrong *table* — standalone results where consolidated
were wanted, or a segment sub-total read as a group total. The quote is real, the number
is in it, and the record is wrong. Only a person reading the figure next to its quote
catches that, which is why there is no auto-accept path anywhere in here at any scale. Automation as described in Phase 2 removes exactly that gate. That is
not an argument against ever doing it — it is an argument that whatever replaces the gate
(sampling, reconciliation against a second source, tolerance checks against the prior
quarter) has to be designed and agreed on deliberately, and not simply left out because
the pipeline appeared to work fine during a week when a human was checking every record
by hand.
