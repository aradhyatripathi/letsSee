# Two definitions of this project, and what separates them

There are two documents describing what this is meant to be, and they disagree. This is
the decision note for choosing between them.

One framing point first, because it changes how the rest reads: **these are not two
independent proposals. The scoping note came first, and the build spec is the written
reply to it.** Section 0 of the spec says so in its own words — the boundaries exist to
separate "a strong demo I can stand behind" from *"the exact unattended system I told
someone I couldn't responsibly own without a team, timeline, and compliance sign-off."*

So the spec is not a smaller idea that happened to land nearby. It is the scoping note
minus the two things that were declined, with everything else deliberately dialled up.
That matters, because some moves toward the scoping note are ordinary scope additions and
exactly two of them are reversals of a decision someone already made.

---

## Document B — the original scoping note

**What it is.** The production system: a continuously-running competitive-intelligence
machine for the Indian tyre sector that maintains itself without anyone tending it.

**Trigger.** n8n on an hourly cron. Nobody starts a run; runs happen. The system *is* the
current state of the world, and "is today's data there?" is answered by the system rather
than by a person.

| Stage | Tool | What happens |
|---|---|---|
| Schedule | n8n | Hourly tick, fans out across the roster |
| Retrieve | Firecrawl | Scrapes IR pages / NSE / BSE for new filings |
| Stage | Google Drive | Scraped documents land in a Drive folder |
| Extract | Claude | Pulls the financial schema out of the document |
| Generate | Claude | Writes the commentary layer for the deck |
| Archive | Git + Obsidian | Cross-quarter store, so history accumulates |
| Publish | SheetJS + PPT | Excel workbook **and** a PowerPoint deck |

**Scope.** Nine companies, three channels, five product categories. Identical to the
spec — the data model is not a point of disagreement between the two documents.

**Phasing.** Phase 1: validate the extraction schema against real filings. Phase 2: turn
on scheduled automation. Phase 3: the full output suite.

**Vendor and credential surface.** n8n, Firecrawl (paid at real volume), Google Workspace
(OAuth or a service account, plus a Drive folder that is now a third-party document
repository), Anthropic, a Git host, an Obsidian vault. Six systems, six sets of
credentials, six independent failure modes, and an integration between each adjacent
pair.

**Running cost and effort.** Hourly across nine companies is roughly 216 retrieval
attempts a day, about 1,500 a week. Nearly all of them find nothing — filings arrive a
handful of times a quarter. The dominant cost is not the useful work, it is the polling.
And unattended systems do not reduce human effort to zero; they convert *scheduled*
attention into *unscheduled* attention, which is more expensive per hour.

**Failure modes, and who absorbs them.** This, more than the cron itself, is the
substantive difference.

- An IR page reorganises — these sites do, routinely — and the scraper now returns a nav
  shell. Unattended, that is not an error. It is a filing that quietly never appears, and
  someone downstream sees the right number of companies and never learns one is stale.
- A cookie wall starts returning 200 with no content. Same shape of silence.
- A company simply has not filed yet. Without extra engineering, indistinguishable from
  the two above.
- The model returns a plausible figure from the wrong comparative column. With no review
  gate, it is published.

Making these loud rather than silent is real engineering: per-company health signals,
format-change detection, distinguishing "not filed" from "cannot read", retry policy,
alerting, and a named person who is paged when it fires at 3am on a quarter-end night.
None of it is individually hard; all of it is required before "unattended" means anything
other than "unobserved".

**Compliance exposure.** The heaviest item, and the one the note itself flagged.
Scheduled retrieval of third-party documents, retained in a corporate Drive, is a
different act from a person opening a public page. It needs, in writing and before it
runs: whether each source's terms permit automated retrieval, what may be retained, for
how long, where, and who is accountable if the answer turns out to be no. That check has
not happened. It is not an engineering blocker — it is a decision belonging to people who
can make it.

**What "done" means.** It never is, and that is not a criticism. B is a system you
operate, not a deliverable you hand over.

---

## Document A — the Expanded Build Spec

**What it is.** The same pipeline with the trigger and the retention model changed, and
everything else — company count, filing depth, workbook richness, Q&A power — pushed as
far as a focused week allows. Explicitly not a token proof of concept: Section 3 asks for
the full roster.

**Trigger.** A person, on demand, for a chosen quarter. Section 0 is careful to say this
can be a genuinely slick one-click "run everything" button. Batch size is not the
boundary; the boundary is that no run begins without a press.

| Stage | Where | What happens |
|---|---|---|
| 1 Retrieve | Node CLI | Manual file → Firecrawl (if a key exists) → direct fetch → fixture; per company, one failure never stops the run |
| 2 Extract | Claude | Schema-constrained, guardrailed prompt, adaptive thinking, financial-section selection instead of blind truncation |
| — Verify | Local | Every quote must be in the source, and every figure must be in its own quote |
| 3 Store | JSON → dashboard | `recToStoredShape`, `tyre-records-v2`, one-drop import |
| 4 Review | Dashboard | Every figure beside its quote, the whole run in one pass. **No auto-accept, at any scale** |
| 5 Excel | SheetJS | Four sheets, every cell traceable to its quote |
| 6 Q&A | Claude | Grounded in stored records only; rejected records withheld; review state declared |

**The two boundaries, stated precisely** — worth reading literally rather than as a
summary:

1. *The trigger stays manual* — no cron, no polling, no unattended runs, at any scale,
   for any number of companies.
2. *No unattended storage of scraped source documents* — retrieved filings are processed
   in the run and **written to reviewed output**, not archived on a schedule to Drive or
   anywhere else without a human in the loop.

Note the phrasing of the second. It forbids archiving *scraped source documents*
unattended. It explicitly names *reviewed output* as the permitted destination. That
distinction does a great deal of work below.

**Explicit non-goals (Section 7)** — a different category from the boundaries, and the
single most useful distinction in either document: no scheduled automation *(a restated
boundary)*; no PowerPoint deck; no cross-quarter Git/Obsidian archive; no
unattended-reliability engineering; no new paid vendor signups; no general dashboard
polish.

**Vendor and credential surface.** Anthropic (required). Firecrawl (optional — used only
when a key is present). SheetJS and pdf.js, already in the dashboard. That is all. Zero
runtime npm dependencies, no OAuth, no service accounts, no hosted anything. It runs from
a laptop with one environment variable.

**Running cost and effort.** One extraction call per company per run, plus Q&A traffic.
At this roster and a quarterly cadence that is a rounding error. The real cost is the
review pass — a person reading each record against its quotes, a few minutes each. That
cost is visible, bounded, and scheduled.

**Failure modes.** Every one of B's silent failures is loud here, because a person is
present when it happens. A changed IR page is a failed line in a run report with a
reason, and `--file=<company>:<path>` fixes it in thirty seconds. A quote that does not
verify blocks the record rather than publishing it. A figure that verifies but came from
the wrong *table* is caught only by a human reading it — which is why the review gate
exists and why there is no auto-accept path at any scale.

**Compliance exposure.** Close to nil, by construction. Retrieved text lives in `runs/`,
gitignored, never synced. A person fetching a public filing on demand is the same act as
opening the IR page in a browser, at the same cadence. This is the specific reason the
work could proceed at all without a sign-off.

**What "done" means.** Section 8 is a closed list: one trigger runs the roster; every
record is quote-verified *and* human-reviewed; the four-sheet workbook exports cleanly;
Q&A answers single- and cross-company questions from quotes; and a written note covering
what worked, what broke, and what would have to change to move toward B's Phase 2.

---

## Where they actually differ

| | **A — build spec** | **B — scoping note** |
|---|---|---|
| Who starts a run | A person | A clock |
| Runs per week | ~1 | ~1,500 attempts |
| Source documents | Gitignored run scratch | Staged in Drive, retained |
| Human review | Mandatory, no bypass | None in the described flow |
| Outputs | Excel + Q&A | Excel + PowerPoint |
| History | Current quarter in browser storage | Cross-quarter Git/Obsidian archive |
| Systems to keep alive | 1 | 6 |
| Failure signature | Loud, in front of someone | Silent gap in a dataset |
| Compliance status | Cleared by construction | Open question, unanswered |
| On-call | Not needed | Required, unnamed |
| Wrong number reaching a reader | Blocked by two gates | Nothing between model and deck |
| Ends | Yes — it is a deliverable | No — it is an operation |

---

## What "mostly A, nudged toward B" can mean

Three buckets. Only the first is off the table.

### Bucket 1 — crosses Section 0. Exactly two items.

- The **hourly trigger**. Any code path that starts a run without a person.
- **Unattended staging or archiving of scraped source documents** — the Drive folder, and
  the Git/Obsidian archive insofar as it holds retrieved filings.

These are what the note says was declined. Building them is not a bigger version of A; it
is building the thing someone said they could not responsibly own yet. The honest route
is the compliance and ownership decision first, in writing, then the code.

### Bucket 2 — in B, a non-goal in A, but not a boundary. Most of what B has that A lacks.

This is where the work since has gone, and all of it is now built:

- **PowerPoint generation.** A pure Section 7 non-goal with no boundary implication — it
  reads the same reviewed records the workbook reads. `pipeline/deck.mjs`, and the
  dashboard's Export PowerPoint deck button, from one shared renderer.
- **A cross-quarter archive of *reviewed records*.** Boundary 2 forbids archiving scraped
  documents and names "written to reviewed output" as the permitted destination. A
  committed, per-quarter store of human-approved record JSON is reviewed output by
  definition. `pipeline/archive.mjs` refuses anything unapproved, which is precisely what
  keeps the two apart. B's accumulating history, none of B's retention question.
- **Reliability signals.** `--retrieve-only` counts financial-statement markers in what
  came back, so a cookie wall that returned 200 reads as a failure rather than a success
  with thin text. Not unattended alerting — a person still reads it — but the same
  detection.

Still available and not yet built: historical backfill, investor-call transcripts (both
named in A Section 3 as stretch goals), and scheduled *reminders* rather than scheduled
runs — a nudge on results-season dates prompts a person; it does not replace one.

### Bucket 3 — already in both, already built.

The schema, the 21 metrics, three channels, five product categories, Claude extraction
with the guardrails, the Excel workbook, the full roster.

B's Phase 1 — *validate the extraction schema against real filings* — is the one piece of
B's own phasing that remains undone, and it is blocked on a key and a network rather than
on any decision. `--emit-prompt` and `--response` exist so it can be done by hand in the
meantime.

---

## Where that leaves the choice

Taking A and adding the deck, the reviewed-record archive, transcripts and backfill gets
you visibly most of B's value and crosses neither boundary. What remains on B's side
after that is precisely the cron and the document retention — the two things that were
declined, and the two that need a written decision rather than a commit.

A clean way to say it: **take B's outputs, skip B's plumbing.** The deck and the history
are what people see; n8n, Drive staging and hourly scraping are what create the risk.
Those are also exactly the two things Section 0 forbids, which is a convenient
coincidence.

One consideration specific to this being ApolloTyres' work product used across many
companies. A wrong figure about your own company is embarrassing and self-correcting —
someone internally knows the real number. A wrong figure about a competitor, produced by
you and used in your own decision, has nobody in the room who knows it is wrong. The
quote-per-figure audit trail, the reviewer name and timestamp, the Sources & Quotes sheet
matter *more* when the subject is a competitor, not less. That is an argument for A's
spine regardless of what else is adopted — and it raises rather than lowers the stakes on
boundary 2, because scheduled scraping of competitors' investor-relations pages from
corporate infrastructure is exactly the question the compliance check exists to answer.
