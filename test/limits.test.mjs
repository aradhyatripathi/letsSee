// What a file we did not write is allowed to cost us.
//
// These are not correctness tests. They exist because run.mjs makes a promise —
// "a failure on one company is recorded and the run continues; one awkward
// investor-relations page must never cost the other eight" — and that promise is
// only as strong as this code's willingness to give up on a hostile input. The
// failure mode being guarded against is not an exception. It is a heap abort or a
// blocked event loop, neither of which any caller's try/catch can see, and both of
// which lose the whole run rather than one company.
//
// Each case here was measured before the bound existed; the old numbers are in the
// comments so a later reader can tell what the limit is buying.

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createServer } from 'node:http';

import { extractPdfText } from '../pipeline/lib/pdf.mjs';
import { retrieveFiling } from '../pipeline/lib/retrieve.mjs';

/* ------------------------------------------------------------------- PDF -- */

// Cost used to grow as the square of the file size, because every object restarted
// an indexOf for 'endobj' and 'stream' that scanned to end-of-file when neither was
// present. 8 MB of such objects took 160 seconds of pinned CPU — synchronously, so
// every other company in the run waited behind it.
test('a PDF full of objects and no streams is scanned in one pass', () => {
  const lines = ['%PDF-1.4\n'];
  for (let i = 1; i <= 200000; i++) lines.push(`${i} 0 obj\n`);
  const pdf = Buffer.from(lines.join(''), 'latin1');

  const started = Date.now();
  const out = extractPdfText(pdf);
  const ms = Date.now() - started;

  assert.equal(out.ok, false, 'there is no text in it');
  assert.ok(ms < 3000, `took ${ms}ms — the scan is meant to be linear in the file size`);
});

// Deflate's ratio is unbounded, so a small PDF expands to gigabytes. Peak RSS on
// this shape was 2.1 GB before the cap, and the process aborted under any
// reasonable heap limit rather than returning an error the runner could record.
test('a stream that inflates to far more than the file is refused, not inflated', () => {
  const payload = zlib.deflateSync(Buffer.alloc(400 * 1024 * 1024));
  const pdf = Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Page /Filter /FlateDecode /Length ${payload.length} >>\nstream\n`, 'latin1'),
    payload,
    Buffer.from('\nendstream\nendobj\n', 'latin1')
  ]);
  assert.ok(pdf.length < 2 * 1024 * 1024, 'the file itself is small — that is the point');

  const before = process.memoryUsage().heapUsed;
  const out = extractPdfText(pdf);
  const grew = (process.memoryUsage().heapUsed - before) / (1024 * 1024);

  assert.equal(out.ok, false);
  assert.match(out.error, /no content stream could be decoded/);
  assert.ok(grew < 200, `heap grew ${grew.toFixed(0)}MB decoding a ${(pdf.length / 1048576).toFixed(1)}MB file`);
});

test('a PDF larger than the extractor will read is refused by size, not by trying', () => {
  const pdf = Buffer.alloc(65 * 1024 * 1024, 0x20);
  pdf.write('%PDF-1.4\n', 0, 'latin1');
  const out = extractPdfText(pdf);
  assert.equal(out.ok, false);
  assert.match(out.error, /past the \d+ MB this extractor will read/);
});

// The ordinary case still works, or the tests above would pass with extraction
// removed altogether.
test('an ordinary small PDF still yields its text', () => {
  const content = zlib.deflateSync(Buffer.from('BT /F1 12 Tf (Revenue from operations 6,500.00) Tj ET', 'latin1'));
  const pdf = Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode /Length ${content.length} >>\nstream\n`, 'latin1'),
    content,
    Buffer.from('\nendstream\nendobj\n', 'latin1')
  ]);
  const out = extractPdfText(pdf);
  assert.equal(out.ok, true, out.error || '');
  assert.match(out.text, /Revenue from operations 6,500\.00/);
});

/* ------------------------------------------------------------- retrieval -- */

/** A server that says whatever the test needs it to say. */
async function serving(handler, fn) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/ir`;
  try {
    await fn(url);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const attemptErrors = (result) => (result.attempts || []).map((a) => a.error).filter(Boolean).join(' ');

// The whole body was buffered before anything looked at its size, so 200 MB became
// roughly 7 GB of resident memory once htmlToText's string copies were counted, and
// the process aborted — losing every other company's work, and writing no records
// and no report at all.
test('an oversized response fails the company instead of the run', async () => {
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  await serving((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    let sent = 0;
    const push = () => {
      while (sent < 80) { sent++; if (!res.write(chunk)) return res.once('drain', push); }
      res.end();
    };
    push();
  }, async (url) => {
    const before = process.memoryUsage().rss;
    const out = await retrieveFiling({ id: 'apollo', name: 'Apollo Tyres', sources: [{ type: 'ir', url }] }, { mode: 'live' });
    const grew = (process.memoryUsage().rss - before) / (1024 * 1024);

    assert.equal(out.ok, false, 'the company failed');
    assert.match(attemptErrors(out), /past the \d+ MB limit for one filing/);
    assert.ok(grew < 300, `RSS grew ${grew.toFixed(0)}MB on an 80MB response`);
  });
});

// A server is free to lie about Content-Length or omit it, so the header is an
// early exit and never the check itself. This is the early exit.
test('a declared size past the limit is refused before the body is read', async () => {
  let bodyBytesSent = 0;
  await serving((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(500 * 1024 * 1024) });
    bodyBytesSent += 16;
    res.write('x'.repeat(16));
    // Deliberately never ended: if the limit were checked after the read, this hangs.
  }, async (url) => {
    const out = await retrieveFiling({ id: 'apollo', name: 'Apollo Tyres', sources: [{ type: 'ir', url }] }, { mode: 'live' });
    assert.equal(out.ok, false);
    assert.match(attemptErrors(out), /past the \d+ MB limit for one filing/);
    assert.ok(bodyBytesSent <= 16, 'the body was not drained');
  });
});
