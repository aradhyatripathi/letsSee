// Stage 1 — filing retrieval.
//
// The property that matters most here is that nothing throws: a batch run over
// nine companies has to survive one investor-relations page being awkward, so
// every failure has to come back as a result the runner can report.
//
// Nothing in this file touches the network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import zlib from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { COMPANIES } from '../pipeline/config/companies.mjs';
import { fixturePath, listFixtureQuarters, listFixtures, quarterSlug } from '../pipeline/fixtures/index.mjs';
import { TyreCore } from '../pipeline/lib/core.mjs';
import { htmlToText, retrieveFiling } from '../pipeline/lib/retrieve.mjs';
import { extractPdfText, looksLikePdf } from '../pipeline/lib/pdf.mjs';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'tyre-retrieve-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------ fixture mode -- */

test('fixture mode returns text for every company, in every quarter on disk', async () => {
  // The roster is a config list, not a fixed number — the spec says nine but also
  // says to use whichever list the scoping note actually named, so this asserts
  // breadth (every company runs) rather than a count that would need editing here
  // every time a company is added or dropped. The same now goes for quarters: every
  // quarter directory must cover the whole roster, or an offline run of that quarter
  // silently loses a company.
  assert.ok(COMPANIES.length >= 2, 'the spec asks for real breadth, not a two-company demo');

  const quarters = [
    { label: 'Q1 FY26', slug: 'q1-fy26' },
    { label: 'Q4 FY25', slug: 'q4-fy25' }
  ];
  assert.deepEqual(
    listFixtureQuarters(),
    quarters.map((q) => q.slug).sort(),
    'the quarters on disk are the quarters this test covers'
  );

  for (const quarter of quarters) {
    for (const company of COMPANIES) {
      const result = await retrieveFiling(company, { quarter: quarter.label });
      const who = `${company.name} ${quarter.label}`;

      assert.equal(result.ok, true, `${who}: ${result.error}`);
      assert.equal(result.error, null);
      assert.equal(result.strategy, 'fixture');
      assert.equal(
        result.source,
        `fixture:${quarter.slug}/${company.id}.txt`,
        `${who}: the source has to name the quarter, or two quarters of one company are indistinguishable`
      );
      assert.equal(result.company, company.name);
      assert.equal(result.quarter, quarter.label);
      assert.ok(result.bytes > 1000, `${who}: only ${result.bytes} bytes`);
      assert.ok(
        result.text.startsWith('*** SYNTHETIC TEST DATA'),
        `${who}: a fixture must announce that it is not a real filing`
      );
      assert.ok(/Revenue from operations/i.test(result.text), `${who}: fixture has no income statement`);
      assert.ok(
        !/FY26 Q1|Q1 FY26/.test(result.text) || quarter.label === 'Q1 FY26' || /for FY26|outlook/i.test(result.text),
        `${who}: reads like the wrong quarter`
      );
    }

    const onDisk = new Set(listFixtures(quarter.label).map((f) => f.id));
    const missing = COMPANIES.filter((c) => !onDisk.has(c.id)).map((c) => c.id);
    assert.deepEqual(
      missing,
      [],
      `every configured company needs a fixture in every quarter or it has no offline coverage — create ` +
        missing.map((id) => `pipeline/fixtures/${quarterSlug(quarter.label)}/${id}.txt`).join(', ')
    );
  }

  const onDisk = new Set(listFixtures().map((f) => f.id));
  const orphans = [...onDisk].filter((id) => !COMPANIES.some((c) => c.id === id));

  // A fixture left behind by a company that has since been dropped costs nothing
  // and should not fail a build, but it is worth saying out loud so it can be
  // tidied up deliberately rather than lingering unnoticed.
  if (orphans.length) {
    console.log(`  note: fixtures with no company on the roster: ${orphans.join(', ')}`);
  }
});

test('fixture mode never reaches the network', async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('fixture retrieval must not call fetch');
  };
  t.after(() => { globalThis.fetch = original; });

  const result = await retrieveFiling(COMPANIES[0], { quarter: 'Q1 FY26' });
  assert.equal(result.ok, true);
});

/* ------------------------------------------------------------- failure path -- */

test('a company whose retrieval fails returns ok:false rather than throwing', async () => {
  const missing = { id: 'no-such-company', name: 'No Such Tyres', sources: [] };

  const result = await retrieveFiling(missing, { quarter: 'Q1 FY26' });

  assert.equal(result.ok, false);
  assert.equal(result.text, '');
  assert.equal(result.strategy, null);
  assert.ok(result.error.includes('No Such Tyres'), 'the error names the company that needs attention');
  assert.ok(result.error.includes(fixturePath('no-such-company')), 'and says what it looked for');
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].ok, false);
  assert.equal(result.attempts[0].strategy, 'fixture');
});

test('a live company with no configured source is refused before any request', async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('there was nothing to request');
  };
  t.after(() => { globalThis.fetch = original; });

  const result = await retrieveFiling({ id: 'unsourced', name: 'Unsourced Tyres', sources: [] }, { mode: 'live' });

  assert.equal(result.ok, false);
  assert.match(result.error, /no source URLs configured/);
  assert.match(result.error, /--file/);
  assert.deepEqual(result.attempts, []);
});

test('an unknown retrieval mode is an error, not a silent fixture read', async () => {
  const result = await retrieveFiling(COMPANIES[0], { mode: 'staging' });

  assert.equal(result.ok, false);
  assert.match(result.error, /unknown retrieval mode 'staging'/);
});

/* ----------------------------------------------------------- manual upload -- */

test('a manual upload is tried before anything else, and is read as text', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'goodyear-q1fy26.txt');
    const body = `Revenue from operations 1,234.56\n${'filler line\n'.repeat(60)}`;
    await writeFile(path, body, 'utf8');

    const result = await retrieveFiling(COMPANIES[0], { quarter: 'Q1 FY26', file: path });

    assert.equal(result.ok, true, result.error || '');
    assert.equal(result.strategy, 'file');
    assert.equal(result.text, body);

    // The filename, not the path. `source` is stored on every record and travels: onto
    // the review card, into the deck footnote, into the workbook's Source column, into
    // the committed archive, and into every Q&A payload sent to Anthropic. An absolute
    // path carries the operator's username and their directory layout, none of which is
    // about the filing, all of which then leaves with a deck sent outside the team.
    assert.equal(result.source, 'file:goodyear-q1fy26.txt');
    assert.ok(!result.source.includes(dir), 'the local path is not in what the record stores');

    // It is not lost — the run knows exactly which file on this machine it read.
    // runs/ is gitignored working space; that is the same split boundary 2 draws.
    assert.equal(result.local_path, path);
  });
});

test('retrieved text is written into the run directory as working space', async () => {
  await withTempDir(async (dir) => {
    const runDir = join(dir, 'runs', '2025-08-08T000000-000Z');

    const result = await retrieveFiling(COMPANIES[0], { quarter: 'Q1 FY26', runDir });

    assert.equal(result.ok, true, result.error || '');
    assert.equal(result.path, join(runDir, 'sources', `${COMPANIES[0].id}.txt`));
    assert.ok(existsSync(result.path));
    assert.equal(await readFile(result.path, 'utf8'), result.text);
  });
});

/* ------------------------------------------------------------ html -> text -- */

test('the HTML-to-text helper keeps numbers adjacent to their labels', () => {
  const html = `
    <html><head><style>td { color: red }</style></head><body>
      <script>var hidden = "Revenue from operations 0.00";</script>
      <h2>Statement of Unaudited Financial Results</h2>
      <table>
        <tr><th>Particulars</th><th>Quarter ended 30.06.2025</th></tr>
        <tr><td>Revenue from operations</td><td>6,338.42</td></tr>
        <tr><td>Profit for the period</td><td>394.61</td></tr>
        <tr><td>EBITDA&nbsp;margin</td><td>14.5&#37;</td></tr>
      </table>
      <p>Total assets stood at &#8377;24,850.32 crore &mdash; up sequentially.</p>
    </body></html>`;

  const text = htmlToText(html);

  assert.ok(text.includes('Revenue from operations 6,338.42'), text);
  assert.ok(text.includes('Profit for the period 394.61'), text);
  assert.ok(text.includes('EBITDA margin 14.5%'), text);
  assert.ok(text.includes('Total assets stood at ₹24,850.32 crore — up sequentially.'), text);

  assert.ok(!text.includes('var hidden'), 'script bodies are dropped');
  assert.ok(!text.includes('color: red'), 'style bodies are dropped');
  assert.ok(!/<[a-z]/i.test(text), 'no markup survives');

  for (const line of text.split('\n')) assert.equal(line, line.trim(), 'lines are not padded');
});

test('the HTML-to-text helper keeps rows apart', () => {
  const text = htmlToText('<table><tr><td>Current ratio</td><td>1.18</td></tr><tr><td>Quick ratio</td><td>0.63</td></tr></table>');

  assert.deepEqual(text.split('\n'), ['Current ratio 1.18', 'Quick ratio 0.63']);
});

/* -------------------------------------------------------------------- pdf -- */

test('extractPdfText returns ok:false on garbage input instead of throwing', () => {
  const cases = [
    [Buffer.alloc(0), /empty buffer/],
    [Buffer.from(''), /empty buffer/],
    [Buffer.from('this is a plain text file, not a filing'), /not a PDF/],
    [Buffer.from([0x00, 0xff, 0x10, 0x42, 0x99]), /not a PDF/],
    [Buffer.from('%PDF-1.7\nthis header is the only real thing about me\n%%EOF'), /no content stream/],
    [Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length 12 /Filter /FlateDecode >>\nstream\n${'\x00\x01\x02\x03'.repeat(3)}\nendstream\nendobj\n%%EOF`), /./]
  ];

  for (const [buffer, pattern] of cases) {
    const result = extractPdfText(buffer);
    assert.equal(result.ok, false, `expected failure for ${JSON.stringify(buffer.subarray(0, 16).toString('latin1'))}`);
    assert.equal(result.text, '');
    assert.match(result.error, pattern);
  }

  assert.equal(extractPdfText(null).ok, false);
  assert.equal(extractPdfText(undefined).ok, false);
});

test('extractPdfText reads the text layer of a real PDF', () => {
  const result = extractPdfText(buildPdf(['Revenue from operations 6,338.42', 'Current ratio 1.18']));

  assert.equal(result.ok, true, result.error || '');
  assert.ok(result.text.includes('Revenue from operations 6,338.42'), result.text);
  assert.ok(result.text.includes('Current ratio 1.18'), result.text);
  assert.equal(result.streams, 1);
});

test('looksLikePdf recognises a header even behind padding', () => {
  assert.equal(looksLikePdf(Buffer.from('%PDF-1.7\n')), true);
  assert.equal(looksLikePdf(Buffer.concat([Buffer.alloc(200), Buffer.from('%PDF-1.4')])), true);
  assert.equal(looksLikePdf(Buffer.from('PK')), false);
  assert.equal(looksLikePdf(Buffer.alloc(0)), false);
  assert.equal(looksLikePdf(null), false);
});

/** A minimal single-page PDF with an uncompressed content stream. */
function buildPdf(lines) {
  const content = ['BT', '/F1 12 Tf', '72 720 Td', ...lines.map((l) => `(${l}) Tj T*`), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  ];

  let pdf = '%PDF-1.4\n';
  objects.forEach((body, i) => { pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  pdf += 'trailer\n<< /Size 5 /Root 1 0 R >>\n%%EOF\n';
  return Buffer.from(pdf, 'latin1');
}

/* ------------------------------------------ regression from the review pass -- */

/** A minimal PDF whose text layer is a UTF-16BE hex string carrying `text`. */
function pdfWithUtf16Text(text) {
  const hex = 'FEFF' + [...text].map((c) => c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')).join('');
  const content = Buffer.from(`BT /F1 12 Tf 72 700 Td <${hex}> Tj ET`, 'latin1');
  const stream = zlibDeflate(content);

  const objs = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'),
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`), stream, Buffer.from('\nendstream')]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  ];

  let buf = Buffer.from('%PDF-1.4\n');
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(buf.length);
    buf = Buffer.concat([buf, Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
  });
  const xrefAt = buf.length;
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.concat([buf, Buffer.from(xref)]);
}

function zlibDeflate(buf) {
  // eslint-disable-next-line global-require
  return zlib.deflateSync(buf);
}

test('a character XML cannot carry never survives retrieval', async () => {
  // The reachability chain a reviewer demonstrated, pinned end to end. A PDF text string
  // may be UTF-16BE; pdf.mjs decodes it code unit by code unit, so the byte pair FF FF in
  // a filing becomes U+FFFF. Everything this project writes is XML underneath, and the
  // readers that meet an illegal character there do not report an error — they open the
  // file and silently drop content from that point on.
  const NOT_A_CHARACTER = '￿';
  const filing = `Revenue from operations 6,338.42 ${NOT_A_CHARACTER} for the quarter. Total income 6,400.00`;

  await withTempDir(async (dir) => {
    const pdfPath = join(dir, 'filing.pdf');
    await writeFile(pdfPath, pdfWithUtf16Text(filing));

    // The decoder itself is faithful — that is its job. The sanitiser is what protects.
    const decoded = extractPdfText(await readFile(pdfPath));
    const decodedText = typeof decoded === 'string' ? decoded : decoded.text;
    assert.ok(decodedText.includes(NOT_A_CHARACTER), 'the decoder reproduces what the PDF actually said');

    const result = await retrieveFiling({ id: 'apollo', name: 'Apollo Tyres', sources: [] },
      { quarter: 'Q1 FY26', mode: 'fixture', file: pdfPath });
    assert.equal(result.ok, true, result.error);
    assert.ok(!result.text.includes(NOT_A_CHARACTER), 'retrieval is the boundary where it stops');
    assert.match(result.text, /Revenue from operations 6,338\.42/, 'and the rest of the filing survives intact');
  });
});

test('a stored record cannot carry one either, whatever route it arrived by', () => {
  const NOT_A_CHARACTER = '￿';
  const record = TyreCore.recToStoredShape({
    company: `CEAT${NOT_A_CHARACTER} Ltd`,
    quarter: 'Q1 FY26',
    currency: { code: 'INR', unit: 'Crore' },
    core: { revenue: 100 },
    core_quotes: { revenue: `Revenue from operations 100.00${NOT_A_CHARACTER}` },
    outlook: { commentary: `Rubber eased${NOT_A_CHARACTER}`, rm_trend: null, capex: null }
  }, { source: 'file:x.pdf' });

  const serialized = JSON.stringify(record);
  assert.ok(!serialized.includes(NOT_A_CHARACTER), 'nothing unrepresentable reaches storage');
  assert.equal(record.company, 'CEAT Ltd');
  assert.equal(record.core.revenue, 100, 'figures are untouched');
});
