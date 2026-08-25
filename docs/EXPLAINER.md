# Explaining this to a person

Four lengths. Pick by who is asking and how much time there is. Everything here is
written to be said out loud rather than read.

---

## The one-liner

> "It reads tyre companies' quarterly results and turns them into a comparison
> spreadsheet and a deck — but every number it pulls out has to be backed by an exact
> quote from the filing, or it won't accept it."

That sentence does the most work, because "AI reads documents" is unremarkable and "it
can't make a number up" is the actual product.

---

## Thirty seconds

> "Every quarter someone has to go through the tyre companies' results — Apollo, MRF,
> CEAT, JK Tyre and the rest — pull out revenue, margins, debt ratios, segment splits,
> and put it all in one place to compare. It's a day or two of copy-paste and it's easy
> to get a number wrong.
>
> This does the reading. You point it at a quarter, it fetches each company's filing, and
> Claude pulls out 21 financial metrics per company. The important part is what happens
> next: for every single number, the model also has to give the exact sentence from the
> document it came from, and we check that the quote is really in the file *and* that the
> number actually appears in it. If it can't prove it, the record doesn't go through.
>
> Then a person reviews it — every figure sitting next to its quote — and only approved
> records become the workbook and the deck. You can also just ask it questions, like
> 'which company had the best EBITDA margin this quarter', and it answers only from those
> records, with the quote."

---

## Two minutes — for a manager

Everything above, then these three, in this order.

**Why the quote check matters more than it sounds.**

> "The failure mode with this kind of tool isn't that it breaks — it's that it hands you
> a confident wrong number. These filings put three or four columns side by side, so it's
> genuinely easy to read last quarter's figure off the right row. So there are two
> automatic gates and then a human. The automatic ones catch a made-up quote, a quote
> stitched together out of the document's own words in an order it never used, and a
> number that isn't in the sentence quoted to support it. What they *can't* catch is a
> number quoted perfectly from the wrong table — standalone results where you wanted
> consolidated. Only a person reading it catches that, which is why there's no way to
> skip the review step. Not a setting, not a flag — there's no code path for it."

**The deliberate limit.**

> "Two things it doesn't do, on purpose. It doesn't run on a schedule — a person starts
> it. And it doesn't keep the documents it downloads; they're processed in the run and
> that's it. Those aren't things we couldn't build. They're the two things that need a
> compliance answer first — whether we're allowed to automatically scrape and retain
> other companies' filings — and nobody's made that call yet. So it's built right up to
> that line and stops."

Worth using close to verbatim, because it turns "it's limited" into "we knew where the
line was", which is a completely different conversation.

**Where it stands.**

> "It's built and tested end to end — retrieval, extraction, verification, review, the
> four-sheet workbook, the deck, the Q&A, and a quarter-by-quarter archive. What hasn't
> happened is a run against real filings: no API key and no route to the exchange sites
> yet, so it's all been run on synthetic test filings. That's the first thing to do when
> the key comes through, and it's the honest caveat on everything else."

---

## The technical version

> "Two halves over one shared contract. A Node CLI does retrieval and extraction — it has
> to be outside the browser because NSE, BSE and the IR sites don't send CORS headers, so
> a page can't fetch them, full stop. The dashboard is a single HTML file and does
> everything a person looks at: review, comparison, the workbook, the deck, Q&A. They
> hand off through one JSON file.
>
> The schema, the transforms, the quote verification, the prompts, the workbook and deck
> models exist exactly once, in files that are inlined verbatim into the dashboard and
> loaded into Node through a `vm` shim. A test fails the build if the two copies drift,
> so the outputs can't quietly stop matching what the extractor produces.
>
> Verification is exact substring first, then a sliding window to find near-matches, then
> longest-common-subsequence re-scoring so word order counts, thresholded at 0.85 —
> because a PDF extractor mangles quote marks and dashes. Separately, the figure has to
> appear in its own quote, with parentheses read as the accounting minus and period
> labels like `Q1 FY26` scrubbed first so they can't stand in for the number they label.
>
> Zero runtime npm dependencies, 100 tests, and it runs fully offline against fixtures
> with no key and no network. The PowerPoint writer is hand-rolled — a `.pptx` is a ZIP
> of XML — so the browser needs no CDN and the CLI needs no library."

---

## The six questions you will get

**"Can't ChatGPT just do this?"**

> "It can read a filing, yes. What it won't do is refuse to answer. This one won't store a
> number it can't point at in the source, and it puts every figure next to its quote for a
> human before anything is treated as real. That's the whole difference — not the reading,
> the refusing."

**"How accurate is it?"**

> "I can't give you a percentage yet — it hasn't run on real filings. What I can tell you
> is what happens when it's wrong: it fails visibly rather than silently. A quote it can't
> verify blocks the record instead of publishing it, and a company whose site has changed
> shows up as a failed line with a reason, not a blank cell."

Resist the urge to quote a number. The moment you do, you own it.

**"Why only these companies?"**

> "The roster is one config file, and nothing else in the system knows the count — it's
> been tested from two companies up to nine. Add or remove them freely."

**"Why isn't it automated?"**

Use the deliberate-limit paragraph above, then: *"Turning that on is a decision, not a
task."*

**"How much does it cost to run?"**

> "One Claude call per company per run, plus whatever the Q&A uses. At this size,
> quarterly, that's negligible — the real cost is the twenty minutes someone spends
> reviewing. That's a feature, not overhead."

**"What's left?"**

> "Run it against real filings and tune the quote threshold on actual data. Everything
> else — the deck, the archive, the workbook — is done."

---

## What not to say

Three things that cost credibility if someone digs, and cost nothing to omit.

- **Don't say "it's accurate" or "it's verified."** Say *"every figure is traceable to a
  quote, and a person signs off."* That is true, and it is stronger.
- **Don't say "it's automated."** Someone will hear "it runs itself", and the interesting
  thing about this project is precisely that it doesn't.
- **Don't demo the fixture data as if it were real.** Every fixture says
  `*** SYNTHETIC TEST DATA` on line one for exactly this reason. If you show it, say
  "these are invented numbers, the point is the mechanism." People trust that more, not
  less.

---

## Demonstrating it

`npm run demo` is built to be the demo. It runs the retrieval check, a full run with every
quote verified, builds a deck, and then shows the archive refusing to accept any of it
because nobody has reviewed it yet. That last step is the one to point at: the boundary
is enforced, not described.

Then open the dashboard, import the run, and do one review live. Watching a figure sit
next to the sentence it came from is the thing that lands; describing it is not.

The general shape, if you remember one thing: **lead with the problem (a day of
copy-paste, easy to get wrong), then the guarantee (it can't keep a number it can't
prove), then the limit (a person starts it, a person approves it, and that's on
purpose).** The limit is what makes the rest believable.
