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

async function withPage(fn) {
  const site = await serve();
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox']
  });
  try {
    const page = await browser.newContext().then((c) => c.newPage());
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    // The import path asks for confirmation; a test that cannot answer it hangs.
    page.on('dialog', (d) => d.accept());
    await page.goto(site.url);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForFunction(() => typeof records !== 'undefined');
    await fn(page, errors);
    assert.deepEqual(errors, [], 'the page threw while the test was driving it');
  } finally {
    await browser.close();
    await site.close();
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
