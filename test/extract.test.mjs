// Stage 2 — extraction, and the quote check that is the real enforcement of
// "never fabricate a quote".
//
// The API tests stub global fetch. Nothing here touches the network and nothing
// needs a key.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { TyreCore } from '../pipeline/lib/core.mjs';
import { fixturePath } from '../pipeline/fixtures/index.mjs';
import { extractRecord, extractRecordOffline } from '../pipeline/lib/extract.mjs';
import { DEFAULT_MODEL, MODELS, callMessages } from '../pipeline/lib/anthropic.mjs';

const APOLLO = readFileSync(fixturePath('apollo'), 'utf8');

function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return handler(calls.length);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function modelReply(record, overrides = {}) {
  return new Response(
    JSON.stringify({
      id: 'msg_test',
      model: DEFAULT_MODEL,
      content: [{ type: 'text', text: JSON.stringify(record) }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1200, output_tokens: 400 },
      ...overrides
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

function withoutEnvKey(fn) {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    return fn();
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
}

/* ------------------------------------------------------- offline extraction -- */

test('extractRecordOffline yields a valid stored record whose quotes verify', () => {
  const result = extractRecordOffline({
    sourceText: APOLLO,
    company: 'Apollo Tyres',
    quarter: 'Q1 FY26',
    source: 'fixture:apollo.txt',
    retrievedAt: '2025-08-08T00:00:00.000Z'
  });

  assert.equal(result.ok, true, result.error || '');
  assert.equal(result.error, null);
  assert.equal(result.extractor, 'offline-regex');

  const record = result.record;
  assert.deepEqual(TyreCore.validateStored(record), []);
  assert.equal(record.company, 'Apollo Tyres');
  assert.equal(record.quarter, 'Q1 FY26');
  assert.equal(record.source, 'fixture:apollo.txt');
  assert.equal(record.retrieved_at, '2025-08-08T00:00:00.000Z');
  assert.deepEqual(record.currency, { code: 'INR', unit: 'Crore', fx_to_inr: 1 });
  assert.equal(record.core.revenue, 6338.42, 'the headline number is read off the statement');
  assert.equal(record.core.ebitda_margin, 14.5);
  assert.equal(record.core.net_margin, null, 'a margin the filing does not state is not computed');

  // Re-verifying from scratch, not trusting the verification the extractor attached.
  const independent = TyreCore.verifyQuotes(record, APOLLO);
  assert.equal(independent.ok, true);
  assert.equal(independent.failed, 0);
  assert.equal(independent.unquoted, 0);
  assert.ok(independent.verified >= 15, `only ${independent.verified} quotes verified`);
  assert.equal(independent.verified, independent.checked);

  for (const check of independent.checks) {
    assert.ok(APOLLO.includes(record.quotes[check.key]), `${check.key}: the stored quote is a real span of the filing`);
  }

  assert.deepEqual(record.review, { status: 'pending', reviewer: null, reviewed_at: null, note: null });
});

test('extractRecordOffline reports empty source text instead of inventing a record', () => {
  const result = extractRecordOffline({ sourceText: '   ', company: 'MRF', quarter: 'Q1 FY26' });

  assert.equal(result.ok, false);
  assert.equal(result.record, null);
  assert.match(result.error, /MRF Q1 FY26: no source text/);
});

/* ------------------------------------------------------------ fabrication -- */

test('a fabricated quote is rejected rather than stored', async (t) => {
  const fabricated = {
    company: 'Apollo Tyres',
    quarter: 'Q1 FY26',
    currency: { code: 'INR', unit: 'Crore' },
    core: { revenue: 9999.99 },
    core_quotes: { revenue: 'Revenue from operations for the quarter was 9,999.99 crore, an all-time record for the Company' }
  };
  const stub = stubFetch(() => modelReply(fabricated));
  t.after(stub.restore);

  const result = await extractRecord({
    sourceText: APOLLO,
    company: 'Apollo Tyres',
    quarter: 'Q1 FY26',
    source: 'fixture:apollo.txt',
    apiKey: 'test-key'
  });

  assert.equal(result.ok, false, 'a record with an unverifiable quote must not be accepted');
  assert.match(result.error, /quote verification failed/);
  assert.match(result.error, /revenue/);
  assert.equal(result.verification.ok, false);
  assert.equal(result.verification.checks.find((c) => c.key === 'revenue').status, 'not_found');

  // It was re-asked once with the failure spelled out before being given up on.
  assert.equal(stub.calls.length, 2);
  assert.equal(result.attempts.length, 2);
  assert.ok(!stub.calls[0].body.messages[0].content.includes('CORRECTION'));
  assert.ok(stub.calls[1].body.messages[0].content.includes('CORRECTION'));
  assert.ok(stub.calls[1].body.messages[0].content.includes('9,999.99'), 'the correction names the rejected quote');
});

test('a verbatim quote from the same model path is accepted', async (t) => {
  const quote = '1   Revenue from operations                             6,338.42';
  assert.ok(APOLLO.includes(quote));

  const stub = stubFetch(() =>
    modelReply({
      company: 'Apollo Tyres',
      quarter: 'Q1 FY26',
      currency: { code: 'INR', unit: 'Crore' },
      core: { revenue: 6338.42 },
      core_quotes: { revenue: quote }
    })
  );
  t.after(stub.restore);

  const result = await extractRecord({
    sourceText: APOLLO,
    company: 'Apollo Tyres',
    quarter: 'Q1 FY26',
    apiKey: 'test-key'
  });

  assert.equal(result.ok, true, result.error || '');
  assert.equal(stub.calls.length, 1, 'a clean first pass is not re-asked');
  assert.equal(result.record.core.revenue, 6338.42);
  assert.equal(result.record.review.status, 'pending', 'extraction produces candidates, not accepted records');
  assert.equal(result.extractor, `claude:${DEFAULT_MODEL}`);

  const body = stub.calls[0].body;
  assert.equal(body.model, DEFAULT_MODEL);
  assert.equal(body.max_tokens, 8000, 'the spec raises the extraction budget from 1500');
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'system']);
  assert.deepEqual(body.messages.map((m) => m.role), ['user'], 'no assistant prefill');
});

test('a response cut off at the token limit says so instead of failing obscurely', async (t) => {
  const quote = 'Current ratio                                                1.18';
  const stub = stubFetch((n) =>
    n === 1
      ? new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '{"company":"Apollo Tyres","quarter":"Q1 FY26","currency":{"code":"INR","unit":"Crore"},"core":{"current_ratio":' }],
            stop_reason: 'max_tokens',
            usage: {}
          }),
          { status: 200 }
        )
      : modelReply({
          company: 'Apollo Tyres',
          quarter: 'Q1 FY26',
          currency: { code: 'INR', unit: 'Crore' },
          core: { current_ratio: 1.18 },
          core_quotes: { current_ratio: quote }
        })
  );
  t.after(stub.restore);

  const truncated = await extractRecord({ sourceText: APOLLO, company: 'Apollo Tyres', quarter: 'Q1 FY26', apiKey: 'k' });
  assert.equal(truncated.ok, false);
  assert.match(truncated.error, /could not read JSON/);
  assert.match(truncated.error, /raise maxTokens/);

  const complete = await extractRecord({ sourceText: APOLLO, company: 'Apollo Tyres', quarter: 'Q1 FY26', apiKey: 'k' });
  assert.equal(complete.ok, true, complete.error || '');
  assert.equal(complete.record.core.current_ratio, 1.18);
});

/* -------------------------------------------------------- anthropic client -- */

test('the client reports a missing API key without calling out', async (t) => {
  const stub = stubFetch(() => {
    throw new Error('the client must not reach fetch without a key');
  });
  t.after(stub.restore);

  const result = await withoutEnvKey(() => callMessages({ system: 's', user: 'u' }));

  assert.equal(result.ok, false);
  assert.match(result.error, /no Anthropic API key/);
  assert.match(result.error, /ANTHROPIC_API_KEY/);
  assert.equal(result.status, null);
  assert.equal(result.attempts, 0);
  assert.equal(stub.calls.length, 0);
});

test('the client reports a 400 with the API\'s own message and does not retry it', async (t) => {
  const stub = stubFetch(() =>
    new Response(
      JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: must be greater than 0' } }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    )
  );
  t.after(stub.restore);

  const result = await callMessages({ apiKey: 'test-key', system: 's', user: 'u' });

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error, /HTTP 400/);
  assert.match(result.error, /max_tokens: must be greater than 0/);
  assert.match(result.error, /invalid_request_error/);
  assert.equal(result.attempts, 1, 'the same bad body would fail the same way');
  assert.equal(stub.calls.length, 1);
});

test('the client reports a refusal distinctly and hands back no text', async (t) => {
  const stub = stubFetch(() =>
    modelReply(null, {
      content: [{ type: 'text', text: '{"company":"Apollo Tyres"}' }],
      stop_reason: 'refusal'
    })
  );
  t.after(stub.restore);

  const result = await callMessages({ apiKey: 'test-key', system: 's', user: 'u' });

  assert.equal(result.ok, false);
  assert.equal(result.status, 200);
  assert.equal(result.stop_reason, 'refusal');
  assert.match(result.error, /refusal/);
  assert.match(result.error, /must not be used/);
  assert.equal(result.text, '', 'the content of a refused response is never surfaced');
  assert.equal(stub.calls.length, 1);
});

test('a successful call sends exactly the headers the API requires', async (t) => {
  const stub = stubFetch(() => modelReply(null, { content: [{ type: 'text', text: 'hello' }] }));
  t.after(stub.restore);

  const result = await callMessages({ apiKey: 'test-key', model: MODELS[2], system: 'sys', user: 'usr', maxTokens: 4000 });

  assert.equal(result.ok, true);
  assert.equal(result.text, 'hello');
  assert.equal(result.stop_reason, 'end_turn');

  const { url, init, body } = stub.calls[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['anthropic-version'], '2023-06-01');
  assert.equal(init.headers['x-api-key'], 'test-key');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(body.model, 'claude-opus-5');
  assert.equal(body.max_tokens, 4000);
  assert.equal(body.system, 'sys');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'usr' }]);
  for (const rejected of ['temperature', 'top_p', 'top_k']) {
    assert.ok(!(rejected in body), `${rejected} is rejected by these models`);
  }
});

test('the client reports a transport failure after exhausting its attempts', async (t) => {
  const stub = stubFetch(() => {
    throw new TypeError('fetch failed');
  });
  t.after(stub.restore);

  const result = await callMessages({ apiKey: 'test-key', system: 's', user: 'u' });

  assert.equal(result.ok, false);
  assert.match(result.error, /request to the Anthropic API failed/);
  assert.equal(result.attempts, 3);
  assert.equal(stub.calls.length, 3);
});
