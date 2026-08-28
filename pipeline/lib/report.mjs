// The written record of one manual run (build spec, Section 8).
//
// A run is triggered by a person, finishes, and is then read the next morning by
// someone deciding what to trust. That reader needs three things this module is
// built to give them: which companies came through and how they were retrieved,
// what the quote verification actually found, and every failure with its real
// error rather than a count. It also states, unmissably, that nothing in the run
// is trustworthy until a human has reviewed it.
//
// runResult (produced by pipeline/run.mjs):
// {
//   run_id, quarter, mode, model, extractor: 'api' | 'offline',
//   started_at, generated_at, duration_ms,
//   run_dir, records_path, report_path,
//   companies: [{
//     id, name, ok, stage: 'retrieval' | 'extraction' | 'done', error,
//     retrieval: { ok, strategy, source, bytes, path, error, attempts: [{ strategy, target, ok, error, ms }] },
//     extraction: { ok, engine, error },
//     verification: { ok, checked, verified, failed, unquoted, checks } | null,
//     issues: string[],
//     record: storedRecord | null,
//     duration_ms
//   }],
//   records: storedRecord[]
// }

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { TyreCore } from './core.mjs';

const STRATEGY_LABELS = {
  fixture: 'offline fixture',
  file: 'manual upload',
  firecrawl: 'Firecrawl',
  http: 'direct HTTP'
};

const PENDING_REVIEW_STATEMENT =
  'These records are PENDING REVIEW and are not trustworthy until a human approves them. ' +
  'Nothing in this run has been checked by a person: quote verification proves a quote came ' +
  'from the retrieved text, not that the figure was read correctly or that the filing is the ' +
  'right one. No number here should be quoted, exported or acted on before review.';

const METRIC_BY_KEY = new Map(TyreCore.CORE_METRICS.map((m) => [m.key, m]));
const HEADLINE_KEYS = ['revenue', 'ebitda_margin', 'pat'];

/** Markdown for a whole run. */
export function buildRunReport(runResult) {
  const run = runResult;
  if (run.stop_after === 'retrieval') return buildRetrievalReport(run);
  if (run.stop_after === 'prompt') return buildPromptReport(run);
  const t = tally(run);
  const out = [];

  out.push(`# Tyre pipeline run — ${run.run_id}`, '');
  out.push(`> **PENDING REVIEW.** ${PENDING_REVIEW_STATEMENT}`, '');

  out.push('## Run', '');
  out.push(...kvTable([
    ['Quarter', run.quarter],
    ['Retrieval mode', run.mode === 'live' ? 'live (network)' : 'fixture (offline)'],
    ['Extractor', extractorLabel(run)],
    ['Started', run.started_at],
    ['Finished', run.generated_at],
    ['Duration', `${(run.duration_ms / 1000).toFixed(1)}s`],
    ['Companies attempted', String(t.total)],
    ['Records written', String((run.records || []).length)],
    ['Records file', run.records_path],
    ['Run directory', run.run_dir]
  ]));
  out.push('');

  out.push('## Outcome', '');
  out.push(`- **${t.ok.length} of ${t.total}** companies produced a record.`);
  out.push(
    t.fallback.length
      ? `- **${t.fallback.length}** needed the manual upload fallback: ${t.fallback.map((c) => c.name).join(', ')}.`
      : '- No company needed the manual upload fallback.'
  );
  if (t.retried.length) {
    out.push(`- **${t.retried.length}** succeeded only after an earlier retrieval strategy failed: ${t.retried.map((c) => c.name).join(', ')}.`);
  }
  out.push(
    t.failed.length
      ? `- **${t.failed.length}** failed: ${t.failed.map((c) => c.name).join(', ')} (detail below).`
      : '- No company failed.'
  );
  out.push(`- Quote verification across the records produced: **${t.verified} verified**, **${t.failedQuotes} not found in the source**, **${t.unquoted} reported with no quote at all**.`);
  out.push('');

  out.push('## Retrieval', '');
  out.push(...table(
    ['Company', 'Result', 'Strategy', 'Manual fallback', 'Source', 'Text retrieved'],
    (run.companies || []).map((c) => {
      const r = c.retrieval || {};
      return [
        c.name,
        r.ok ? 'ok' : 'failed',
        strategyLabel(r.strategy),
        r.strategy === 'file' ? 'yes — operator supplied the filing' : 'no',
        r.source || '—',
        r.ok ? `${formatBytes(r.bytes)}${attemptSuffix(r.attempts)}` : '—'
      ];
    })
  ));
  out.push('');
  out.push('Retrieved filing text for this run lives under `' + run.run_dir + '/sources/`. It is working space for this run only — gitignored, not archived, not uploaded anywhere.');
  out.push('');

  out.push('## Extraction and quote verification', '');
  const extracted = (run.companies || []).filter((c) => c.record);
  if (!extracted.length) {
    out.push('_No records were produced, so there is nothing to verify._', '');
  } else {
    out.push(...table(
      ['Company', 'Quarter', 'Currency', 'Metrics with a value', 'Verified quotes', 'Quotes not found', 'Values with no quote', 'Record id'],
      extracted.map((c) => {
        const v = c.verification || { verified: 0, failed: 0, unquoted: 0 };
        return [
          c.name,
          c.record.quarter || '—',
          currencyLabel(c.record.currency),
          `${countReported(c.record)} / ${TyreCore.CORE_KEYS.length}`,
          String(v.verified),
          v.failed ? `**${v.failed}**` : '0',
          String(v.unquoted),
          '`' + c.record.id + '`'
        ];
      })
    ));
    out.push('');
    if (t.reextracted.length) {
      out.push(`Re-extracted after a first pass whose quotes did not verify: ${t.reextracted.map((c) => `${c.name} (${c.extraction.attempts.length} passes)`).join(', ')}.`, '');
    }

    out.push('### Headline figures as extracted', '');
    out.push(...table(
      ['Company', 'Revenue', 'EBITDA margin', 'PAT', 'Raw-material trend (paraphrased)'],
      extracted.map((c) => [
        c.name,
        ...HEADLINE_KEYS.map((k) => TyreCore.formatMetric(c.record.core[k], METRIC_BY_KEY.get(k), c.record.currency)),
        clip((c.record.outlook && c.record.outlook.rm_trend) || '—', 120)
      ])
    ));
    out.push('');
  }

  const suspect = extracted.filter((c) => c.verification && (c.verification.failed || c.verification.unquoted));
  if (suspect.length) {
    out.push('### Quotes to check first', '');
    out.push('Every figure below is in the record but its quote did not verify, or it arrived with no quote. Start the review here.', '');
    for (const c of suspect) {
      out.push(`**${c.name}**`, '');
      const rows = c.verification.checks
        .filter((chk) => chk.status !== 'verified')
        .map((chk) => {
          const metric = METRIC_BY_KEY.get(chk.key);
          return [
            metric ? metric.label : chk.key,
            TyreCore.formatMetric(chk.value, metric, c.record.currency),
            chk.status === 'unquoted' ? 'no quote returned'
              : chk.status === 'quote_too_long' ? (chk.detail || `a ${chk.quote.length}-character section of the filing, not the line reporting the figure`)
              : `not found in source (best match ${chk.score})`,
            chk.quote ? `"${clip(chk.quote, 160)}"` : '—'
          ];
        });
      out.push(...table(['Metric', 'Value', 'Problem', 'Quote as returned'], rows));
      out.push('');
    }
  }

  const malformed = (run.companies || []).filter((c) => c.issues && c.issues.length);
  if (malformed.length) {
    out.push('### Structural problems in the stored records', '');
    for (const c of malformed) {
      out.push(`- **${c.name}**: ${c.issues.join('; ')}`);
    }
    out.push('');
  }

  out.push('## Failures', '');
  if (!t.failed.length) {
    out.push('None — every company attempted produced a record.', '');
  } else {
    for (const c of t.failed) {
      out.push(`### ${c.name} — failed at ${c.stage}`, '');
      out.push('```', String(c.error || 'no error recorded'), '```', '');
      const attempts = (c.retrieval && c.retrieval.attempts) || [];
      if (attempts.length) {
        out.push('Retrieval strategies tried, in order:', '');
        for (const a of attempts) {
          out.push(`- \`${strategyLabel(a.strategy)}\` → ${a.target} — ${a.ok ? 'ok' : a.error} (${a.ms}ms)`);
        }
        out.push('');
      }
      const passes = (c.extraction && c.extraction.attempts) || [];
      if (passes.length) {
        out.push('Extraction passes:', '');
        for (const p of passes) {
          out.push(`- pass ${p.n} — ${p.ok ? 'ok' : p.error || 'failed'}`);
        }
        out.push('');
      }
      out.push(
        c.stage === 'retrieval'
          ? `Next step: download ${c.name}'s filing by hand and re-run just this company with \`--companies=${c.id} --file=${c.id}:<path>\`.`
          : `Next step: the filing text is at \`${(c.retrieval && c.retrieval.path) || 'the run directory'}\` — re-run just this company with \`--companies=${c.id}\` once the cause above is addressed.`
      );
      out.push('');
    }
  }

  out.push('## Next steps', '');
  out.push(`1. **Import** \`${run.records_path}\` into the dashboard. The records land in storage under \`${TyreCore.STORAGE_KEY}\` with review status \`pending\`.`);
  out.push('2. **Review every record** on the verification screen — company, quarter and each stored quote side by side — and approve or reject each one. There is no auto-accept path, at any scale.');
  out.push('');
  out.push(`_${PENDING_REVIEW_STATEMENT}_`);
  out.push('');

  out.push('## Boundaries this run respected', '');
  out.push('- The run was triggered by a person and exited when it finished. Nothing schedules it, polls, or re-runs it unattended.');
  out.push('- Retrieved source documents stayed in this run directory as working space. They were not archived, synced or uploaded; the reviewed record is what leaves the pipeline.');
  out.push('');

  return out.join('\n');
}

/** Write the report, creating the run directory if it is not there yet. */
export async function writeRunReport(runResult, path) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buildRunReport(runResult), 'utf8');
  return path;
}

/** The stdout summary: what happened, and the two things to do next. */
export function summarizeForConsole(runResult) {
  const run = runResult;
  if (run.stop_after === 'retrieval') return summarizeRetrieval(run);
  if (run.stop_after === 'prompt') return summarizePrompts(run);
  const t = tally(run);
  const lines = [];

  const engine = extractorLabel(run);
  lines.push(`Run ${run.run_id} — ${run.quarter} — ${run.mode} retrieval, ${engine}`);
  lines.push('');
  lines.push(`  ${t.ok.length} of ${t.total} companies produced a record`);

  if (t.fallback.length) {
    lines.push(`  ${t.fallback.length} needed the manual upload fallback: ${t.fallback.map((c) => c.name).join(', ')}`);
  }
  if (t.retried.length) {
    lines.push(`  ${t.retried.length} needed a second retrieval strategy: ${t.retried.map((c) => `${c.name} (${strategyLabel(c.retrieval.strategy)})`).join(', ')}`);
  }

  if (t.failed.length) {
    lines.push(`  ${t.failed.length} failed:`);
    for (const c of t.failed) {
      lines.push(`    - ${c.name} (${c.stage}): ${clip(c.error, 180)}`);
    }
  } else {
    lines.push('  0 failed');
  }

  lines.push('');
  lines.push(`  Quote verification: ${t.verified} verified, ${t.failedQuotes} not found in the source, ${t.unquoted} value${t.unquoted === 1 ? '' : 's'} reported with no quote (${t.checked} checked)`);
  lines.push('');
  lines.push(`  Records: ${run.records_path}`);
  lines.push(`  Report:  ${run.report_path}`);
  lines.push('');
  lines.push('Next steps');
  lines.push(`  1. Import ${run.records_path} into the dashboard — the records land under storage key '${TyreCore.STORAGE_KEY}' with review status "pending".`);
  lines.push('  2. Review every record on the verification screen and approve or reject each one.');
  lines.push('     These records are PENDING REVIEW — nothing here is trustworthy until a person approves it.');

  return lines.join('\n');
}

/* ------------------------------------------------- stop-early run reports -- */

// Retrieval-only. This is the answer to the one question that cannot be settled
// from a machine with no route to these sites: which companies' investor-relations
// pages actually hand over a filing, and which need a person to download it. The
// table is written to be pasted straight into the week note.
function buildRetrievalReport(run) {
  const companies = run.companies || [];
  const ok = companies.filter((c) => c.ok);
  const failed = companies.filter((c) => !c.ok);
  const thin = ok.filter((c) => financialSignal(c).level === 'none');
  const out = [];

  out.push(`# Retrieval check — ${run.run_id}`, '');
  out.push('> Stage 1 only. Nothing was extracted, no model was called, and no record was produced.', '');

  out.push('## Run', '');
  out.push(...kvTable([
    ['Quarter', run.quarter],
    ['Retrieval mode', run.mode === 'live' ? 'live (network)' : 'fixture (offline)'],
    ['Started', run.started_at],
    ['Duration', `${(run.duration_ms / 1000).toFixed(1)}s`],
    ['Companies attempted', String(companies.length)],
    ['Run directory', run.run_dir]
  ]));
  out.push('');

  out.push('## Outcome', '');
  out.push(`- **${ok.length} of ${companies.length}** companies returned text.`);
  out.push(
    failed.length
      ? `- **${failed.length}** returned nothing usable: ${failed.map((c) => c.name).join(', ')}. These need the manual upload path.`
      : '- Every company returned something.'
  );
  if (thin.length) {
    out.push(`- **${thin.length}** returned text with no financial-statement wording in it: ${thin.map((c) => c.name).join(', ')}. That is the signature of a cookie wall or a JavaScript shell, not a filing — treat these as failures.`);
  }
  out.push('');

  out.push('## What each source returned', '');
  out.push(...table(
    ['Company', 'Result', 'Strategy that worked', 'Source', 'Text', 'Reads like a filing?'],
    companies.map((c) => {
      const r = c.retrieval || {};
      const sig = financialSignal(c);
      return [
        c.name,
        r.ok ? 'ok' : '**failed**',
        strategyLabel(r.strategy),
        r.source || '—',
        r.ok ? formatBytes(r.bytes) : '—',
        r.ok ? sig.label : '—'
      ];
    })
  ));
  out.push('');
  out.push('"Reads like a filing?" counts financial-statement wording in the retrieved text. It is a smoke test, not a guarantee — a page can score well and still be the wrong quarter.');
  out.push('');

  const withAttempts = companies.filter((c) => ((c.retrieval && c.retrieval.attempts) || []).length);
  if (withAttempts.length) {
    out.push('## Every strategy tried, in order', '');
    for (const c of withAttempts) {
      out.push(`**${c.name}**`, '');
      for (const a of c.retrieval.attempts) {
        out.push(`- \`${strategyLabel(a.strategy)}\` → ${a.target} — ${a.ok ? 'ok' : a.error} (${a.ms}ms)`);
      }
      out.push('');
    }
  }

  if (failed.length || thin.length) {
    out.push('## Companies needing a manual download', '');
    for (const c of [...failed, ...thin]) {
      out.push(`- **${c.name}** — download the quarterly results PDF, then:`);
      out.push(`  \`\`\``);
      out.push(`  node pipeline/run.mjs --companies=${c.id} --file=${c.id}:<path-to.pdf>`);
      out.push(`  \`\`\``);
    }
    out.push('');
  }

  out.push('## Boundaries this run respected', '');
  out.push('- A person triggered it and it exited. Nothing schedules it.');
  out.push('- Retrieved text stayed in this run directory as working space. It was not archived, synced or uploaded.');
  out.push('');
  return out.join('\n');
}

// Prompt-only. The pipeline stops one step before the network call it cannot make,
// having written down exactly what it would have said.
function buildPromptReport(run) {
  const companies = run.companies || [];
  const ok = companies.filter((c) => c.ok && c.prompt);
  const failed = companies.filter((c) => !c.ok);
  const out = [];

  out.push(`# Extraction prompts — ${run.run_id}`, '');
  out.push('> No model was called. Each prompt below is exactly what would have been sent, written to disk for a person to carry into a Claude chat by hand.', '');

  out.push('## Run', '');
  out.push(...kvTable([
    ['Quarter', run.quarter],
    ['Retrieval mode', run.mode === 'live' ? 'live (network)' : 'fixture (offline)'],
    ['Prompts written', String(ok.length)],
    ['Started', run.started_at],
    ['Run directory', run.run_dir]
  ]));
  out.push('');

  out.push('## Prompts', '');
  out.push(...table(
    ['Company', 'Prompt file', 'Characters', 'Filing text it was built from', 'Source text trimmed?'],
    ok.map((c) => [
      c.name,
      '`' + c.prompt.path + '`',
      c.prompt.chars.toLocaleString('en-US'),
      c.prompt.source_path ? '`' + c.prompt.source_path + '`' : '—',
      selectionNote(c.prompt.selection)
    ])
  ));
  out.push('');

  if (failed.length) {
    out.push('## Failed before a prompt could be built', '');
    for (const c of failed) {
      out.push(`- **${c.name}** (${c.stage}): ${clip(c.error, 240)}`);
    }
    out.push('');
  }

  out.push('## Carrying the answer back', '');
  out.push('See `prompts/README.md` in this run directory for the exact command per company.');
  out.push('');
  out.push('The answer is verified against the same retrieved text the prompt was built from, so a quote that is not in the filing is rejected on the way back in. Carrying it by hand does not skip the gate — it only replaces the transport.');
  out.push('');
  return out.join('\n');
}

function summarizeRetrieval(run) {
  const companies = run.companies || [];
  const ok = companies.filter((c) => c.ok);
  const failed = companies.filter((c) => !c.ok);
  const thin = ok.filter((c) => financialSignal(c).level === 'none');
  const lines = [];

  lines.push(`Run ${run.run_id} — ${run.quarter} — ${run.mode} retrieval, Stage 1 only (nothing extracted)`);
  lines.push('');
  lines.push(`  ${ok.length} of ${companies.length} companies returned text`);
  for (const c of ok) {
    const r = c.retrieval;
    lines.push(`    - ${c.name}: ${strategyLabel(r.strategy)}, ${formatBytes(r.bytes)}, ${financialSignal(c).label}`);
  }
  if (failed.length) {
    lines.push(`  ${failed.length} returned nothing usable:`);
    for (const c of failed) lines.push(`    - ${c.name}: ${clip(c.error, 160)}`);
  }
  if (thin.length) {
    lines.push('');
    lines.push(`  ${thin.length} returned text with no financial wording — likely a cookie wall or a JS shell, not a filing:`);
    for (const c of thin) lines.push(`    - ${c.name}`);
  }
  lines.push('');
  lines.push(`  Report: ${run.report_path}`);
  lines.push('');
  lines.push('Next steps');
  lines.push('  1. Paste the table in the report into the week note — this is the retrieval answer the note is missing.');
  if (failed.length || thin.length) {
    lines.push('  2. Download the filing by hand for the companies listed above and re-run them with --file=<id>:<path>.');
  } else {
    lines.push('  2. Nothing needs a manual download — every source returned a filing.');
  }
  return lines.join('\n');
}

function summarizePrompts(run) {
  const companies = run.companies || [];
  const ok = companies.filter((c) => c.ok && c.prompt);
  const failed = companies.filter((c) => !c.ok);
  const lines = [];

  lines.push(`Run ${run.run_id} — ${run.quarter} — prompts written, no model called`);
  lines.push('');
  lines.push(`  ${ok.length} of ${companies.length} prompts written`);
  for (const c of ok) {
    lines.push(`    - ${c.name}: ${c.prompt.chars.toLocaleString('en-US')} characters → ${c.prompt.path}`);
  }
  if (failed.length) {
    lines.push(`  ${failed.length} failed before a prompt could be built:`);
    for (const c of failed) lines.push(`    - ${c.name} (${c.stage}): ${clip(c.error, 160)}`);
  }
  lines.push('');
  lines.push(`  Report: ${run.report_path}`);
  return lines.join('\n');
}

// A retrieved page that came back 200 with no financial wording in it is the
// failure this whole check exists to catch: retrieval "succeeded", and what it
// got was a cookie banner. Counting distinct statement markers separates that
// from a real filing without pretending to judge whether it is the right one.
const FINANCIAL_MARKERS = [
  /revenue from operations/i, /total income/i, /\bebitda\b/i, /profit before tax/i,
  /profit after tax/i, /\bpat\b/i, /earnings per share/i, /balance sheet/i,
  /cash flow/i, /unaudited financial results/i, /audited financial results/i,
  /segment (?:revenue|results)/i, /finance cost/i, /total equity/i
];

/** How many distinct financial-statement markers appear in retrieved text. */
export function countFinancialMarkers(text) {
  const sample = String(text || '');
  if (!sample) return 0;
  return FINANCIAL_MARKERS.filter((re) => re.test(sample)).length;
}

/** How many numbers are in it. A filing is dense with them; a banner is not. */
export function countNumbers(text) {
  const found = String(text || '').match(/\d[\d,]*(?:\.\d+)?/g);
  return found ? found.length : 0;
}

// Markers alone are not enough: a nav bar or a cookie banner can mention "cash flow" and
// "balance sheet" and score well while containing no figures and barely any text. A
// filing is long and full of numbers, so length and digits are part of the verdict.
const MIN_FILING_CHARS = 3000;
const MIN_FILING_NUMBERS = 20;

function financialSignal(entry) {
  const r = entry.retrieval;
  if (!r || !r.ok) return { level: 'none', hits: 0, label: '—' };
  const hits = r.financial_markers;
  if (!Number.isFinite(hits)) return { level: 'unknown', hits: 0, label: 'not checked' };

  const short = Number.isFinite(r.bytes) && r.bytes < MIN_FILING_CHARS;
  const fewNumbers = Number.isFinite(r.number_count) && r.number_count < MIN_FILING_NUMBERS;
  if (short || fewNumbers) {
    const why = [short ? 'too short' : null, fewNumbers ? `only ${r.number_count} numbers in it` : null]
      .filter(Boolean).join(', ');
    return { level: 'none', hits, label: `**no — ${why}**` };
  }
  if (hits === 0) return { level: 'none', hits, label: '**no — no financial wording found**' };
  if (hits <= 3) return { level: 'weak', hits, label: `thin (${hits} of ${FINANCIAL_MARKERS.length} markers)` };
  return { level: 'strong', hits, label: `yes (${hits} of ${FINANCIAL_MARKERS.length} markers)` };
}

function selectionNote(selection) {
  if (!selection) return 'no';
  if (selection.trimmed === false || selection.selected === selection.total) return 'no — whole document sent';
  const kept = selection.selected || selection.kept || null;
  const total = selection.total || selection.original || null;
  if (kept && total) {
    return `yes — ${Math.round((kept / total) * 100)}% of the document kept (${kept.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} chars)`;
  }
  return 'yes';
}

// A run whose records were carried out of a chat by hand was described to the operator
// as "deterministic offline extractor (no API call)" — which is a different provenance
// entirely, and the one thing a reader of this report most needs to get right.
function extractorLabel(run) {
  switch (run.extractor) {
    case 'api': return `Claude API — ${run.model}`;
    case 'manual': return 'Claude, by hand — answers pasted back from a chat (--response)';
    case 'offline': return 'deterministic offline extractor (no API call)';
    case 'stopped-after-retrieval': return 'none — the run stopped after retrieval';
    case 'stopped-after-prompt': return 'none — the run wrote the prompt and stopped';
    default: return String(run.extractor || 'unknown');
  }
}

/* ---------------------------------------------------------------- helpers -- */

function tally(run) {
  const companies = run.companies || [];
  const ok = companies.filter((c) => c.ok);
  const totals = { checked: 0, verified: 0, failedQuotes: 0, unquoted: 0 };
  for (const c of ok) {
    if (!c.verification) continue;
    totals.checked += c.verification.checked;
    totals.verified += c.verification.verified;
    totals.failedQuotes += c.verification.failed;
    totals.unquoted += c.verification.unquoted;
  }
  return {
    total: companies.length,
    ok,
    failed: companies.filter((c) => !c.ok),
    fallback: ok.filter((c) => c.retrieval && c.retrieval.strategy === 'file'),
    retried: ok.filter((c) => c.retrieval && (c.retrieval.attempts || []).length > 1),
    reextracted: ok.filter((c) => c.extraction && (c.extraction.attempts || []).length > 1),
    ...totals
  };
}

function countReported(record) {
  return TyreCore.CORE_KEYS.filter((k) => TyreCore.isNum(record.core[k])).length;
}

function strategyLabel(strategy) {
  if (!strategy) return '—';
  return STRATEGY_LABELS[strategy] || strategy;
}

function attemptSuffix(attempts) {
  const failedBefore = (attempts || []).filter((a) => !a.ok).length;
  if (!failedBefore) return '';
  return ` (after ${failedBefore} failed attempt${failedBefore === 1 ? '' : 's'})`;
}

function currencyLabel(currency) {
  const parts = [currency && currency.code, currency && currency.unit].filter(Boolean);
  return parts.length ? parts.join(' ') : '—';
}

function formatBytes(bytes) {
  if (!TyreCore.isNum(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function clip(value, max) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function cell(value) {
  return String(value == null ? '—' : value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function table(header, rows) {
  const out = [`| ${header.map(cell).join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
  for (const row of rows) out.push(`| ${row.map(cell).join(' | ')} |`);
  return out;
}

function kvTable(pairs) {
  return table(['Field', 'Value'], pairs);
}

/**
 * What a CLI knows about the approvals it is acting on, said out loud.
 *
 * Approval happens in one place: a person clicking a button in the dashboard, in
 * their own browser. Everything on this side reads a records file, and a file is a
 * copy of what that browser wrote — or a copy of what somebody wants us to think it
 * wrote. There is no way to tell the two apart: a static page has no secret to sign
 * with, so a signature would be one anybody could forge.
 *
 * What can be fixed is the tools' phrasing. Saying "1 approved record" reads as a
 * fact the tool checked; naming the file it came out of reads as what it is. The
 * deck and the workbook carry the same distinction in their own text.
 */
export function approvalSourceNote(count, path) {
  if (!count) return '';
  // The filename, not the whole path. This line prints on screen while somebody is
  // demonstrating the tool, and an absolute path carries their username and home
  // directory with it — the same leak that was closed in what records store and in
  // the archive's own output, reappearing in a third place.
  const shown = String(path == null ? '' : path).split(/[\\/]/).pop() || path;
  return [
    `  ${count} approval${count === 1 ? '' : 's'} read from ${shown}.`,
    '  Approvals are made in the dashboard; this reads what the file records about them',
    '  and cannot re-check them.',
    ''
  ].join('\n');
}
