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
  const t = tally(run);
  const out = [];

  out.push(`# Tyre pipeline run — ${run.run_id}`, '');
  out.push(`> **PENDING REVIEW.** ${PENDING_REVIEW_STATEMENT}`, '');

  out.push('## Run', '');
  out.push(...kvTable([
    ['Quarter', run.quarter],
    ['Retrieval mode', run.mode === 'live' ? 'live (network)' : 'fixture (offline)'],
    ['Extractor', run.extractor === 'api' ? `Claude API — ${run.model}` : 'deterministic offline extractor (no API call)'],
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
            chk.status === 'unquoted' ? 'no quote returned' : `not found in source (best match ${chk.score})`,
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
  const t = tally(run);
  const lines = [];

  const engine = run.extractor === 'api' ? `Claude API (${run.model})` : 'offline deterministic extractor';
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
