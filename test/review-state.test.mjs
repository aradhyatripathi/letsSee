// The safety property, tested where it is actually decided.
//
// Every output used to compare `r.review.status === 'rejected'` at its own call site. A
// status of 'Rejected' or ' rejected ' — which any file not written by this dashboard can
// carry — matched none of them, so a record a person had explicitly thrown out went into
// the workbook, onto the deck, and into the model's context as though it were fine.
//
// These tests exist because that bug was invisible: nothing failed, nothing warned, and
// the record simply appeared. They enumerate the outputs rather than checking one, so a
// new output added later without asking reviewStatus() shows up here as a failure.

import test from 'node:test';
import assert from 'node:assert/strict';

import { TyreCore } from '../pipeline/lib/core.mjs';
import { archiveRejectionReason } from '../pipeline/archive.mjs';

const MARK = 'ZZTOPSECRET';

function record(company, status) {
  return {
    id: company,
    company,
    quarter: 'Q1 FY26',
    source: 'fixture:q1-fy26/x.txt',
    currency: { code: 'INR', unit: 'Crore', fx_to_inr: 1 },
    core: Object.fromEntries(TyreCore.CORE_KEYS.map((k, i) => [k, 100 + i])),
    quotes: Object.fromEntries(TyreCore.CORE_KEYS.map((k) => [k, `span for ${k}`])),
    segments: { channels: { replacement: 60, oem: 30, export: 10 }, product_categories: { TBR: 40, TBB: 10, PCR: 30, '2W': 15, OHT: 5 } },
    outlook: { commentary: 'c', rm_trend: 'r', capex: 'x' },
    review: { status, reviewer: 'Priya Nair', reviewed_at: '2026-08-25T09:00:00Z', note: null },
    verification: { ok: true, checked: 21, verified: 21, failed: 0, unquoted: 0, checks: [] }
  };
}

// Every way a record can leave the system as something a person reads.
const OUTPUTS = [
  {
    name: 'Excel workbook',
    render: (records) => JSON.stringify(TyreCore.buildWorkbookModel(records, {}))
  },
  {
    name: 'Excel workbook (approved only)',
    render: (records) => JSON.stringify(TyreCore.buildWorkbookModel(records, { reviewedOnly: true }))
  },
  {
    name: 'deck',
    render: (records) => JSON.stringify(TyreCore.buildDeckModel(records, {}))
  },
  {
    name: 'deck (approved only)',
    render: (records) => JSON.stringify(TyreCore.buildDeckModel(records, { reviewedOnly: true }))
  },
  {
    name: 'Q&A context',
    render: (records) => TyreCore.buildQAPrompt(records, 'anything').user
  }
];

const REJECTIONS = ['rejected', 'Rejected', 'REJECTED', ' rejected ', '\trejected\n', '  ReJeCtEd  '];

test('reviewStatus normalises case and whitespace, and nothing else', () => {
  for (const spelling of REJECTIONS) {
    assert.equal(TyreCore.reviewStatus(record('x', spelling)), 'rejected', `'${spelling}'`);
  }
  for (const spelling of ['approved', 'APPROVED', ' Approved ']) {
    assert.equal(TyreCore.reviewStatus(record('x', spelling)), 'approved', `'${spelling}'`);
  }
  // Anything unrecognisable is pending: never approved, so it cannot reach an
  // approved-only export, and never silently treated as a rejection either.
  for (const junk of ['', null, undefined, 'ok', 'signed off', 42, {}]) {
    assert.equal(TyreCore.reviewStatus(record('x', junk)), 'pending', JSON.stringify(junk));
  }
  assert.equal(TyreCore.reviewStatus(null), 'pending');
  assert.equal(TyreCore.reviewStatus('not a record'), 'pending');
  assert.equal(TyreCore.reviewStatus({}), 'pending');
});

test('a rejected record reaches no output, however its status is spelled', () => {
  for (const spelling of REJECTIONS) {
    const records = [record('CEAT', 'approved'), record(MARK, spelling)];
    for (const output of OUTPUTS) {
      assert.ok(
        !output.render(records).includes(MARK),
        `'${spelling}' reached the ${output.name} — a record a person threw out must not appear anywhere`
      );
    }
    assert.equal(
      archiveRejectionReason(record(MARK, spelling)),
      'rejected',
      `'${spelling}' was archivable`
    );
  }
});

test('an unrecognised status is never treated as approved', () => {
  for (const junk of ['ok', 'signed off', '', null]) {
    const records = [record(MARK, junk)];
    assert.ok(
      !TyreCore.buildWorkbookModel(records, { reviewedOnly: true }).generated_for,
      `'${junk}' was exported as approved`
    );
    assert.equal(TyreCore.buildDeckModel(records, { reviewedOnly: true }).provenance.total, 0);
    assert.equal(archiveRejectionReason(record(MARK, junk)), 'pending');
  }
});

test('an approved record still reaches every output', () => {
  const records = [record(MARK, 'Approved')];
  for (const output of OUTPUTS) {
    assert.ok(output.render(records).includes(MARK), `an approved record is missing from the ${output.name}`);
  }
  assert.equal(archiveRejectionReason(record(MARK, ' APPROVED ')), null);
});

test('a records array carrying junk does not take an output down', () => {
  const messy = [null, undefined, 42, 'x', [], record('CEAT', 'approved')];
  for (const output of OUTPUTS) {
    let rendered;
    assert.doesNotThrow(() => { rendered = output.render(messy); }, `${output.name} threw on a malformed array`);
    assert.ok(rendered.includes('CEAT'), `${output.name} lost the one good record`);
  }
});

test('the Q&A context reports review state per record and withholds rejections', () => {
  const prompt = TyreCore.buildQAPrompt(
    [record('Approved Co', 'approved'), record('Pending Co', 'whatever'), record(MARK, 'REJECTED')],
    'which company did best?'
  );
  assert.ok(!prompt.user.includes(MARK));
  assert.equal(prompt.excluded_rejected, 1);
  assert.equal(prompt.record_count, 2);
  assert.match(prompt.user, /1 human-approved, 1 still pending review/);
  assert.match(prompt.user, /1 rejected record\(s\) were withheld/);
});
