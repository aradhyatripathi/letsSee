// Section 3 — Companies & Filing Scope.
//
// The spec names Apollo Tyres, MRF, CEAT and JK Tyre explicitly and suggests
// Balkrishna Industries, TVS Srichakra and Goodyear India for the rest, "use
// whichever list your manager actually referenced." That is these seven.
//
// An earlier revision carried two more (Modi Rubber, PTL Enterprises) inferred
// to reach a count of nine. They were dropped as too small to be relevant to the
// comparison this pipeline exists to produce. The count is not load-bearing:
// changing the roster means editing this list and nothing else — nothing in the
// pipeline, the dashboard or the tests assumes a number. Add or remove entries
// freely; the only follow-up is a fixture per new company id in each quarter
// directory (pipeline/fixtures/<quarter-slug>/<id>.txt) so offline runs keep
// covering it, which the test suite will tell you about by name if you forget.
//
// `sources` is ordered: the pipeline tries each in turn and records which one
// worked, so a company whose IR page is awkward does not block the rest.

export const QUARTER_DEFAULT = 'Q1 FY26';

export const COMPANIES = [
  {
    id: 'apollo',
    name: 'Apollo Tyres',
    nse: 'APOLLOTYRE',
    bse: '500877',
    confirmed: true,
    sources: [
      { type: 'ir', url: 'https://corporate.apollotyres.com/investors/financials/' },
      { type: 'nse', url: 'https://www.nseindia.com/get-quotes/equity?symbol=APOLLOTYRE' }
    ]
  },
  {
    id: 'mrf',
    name: 'MRF',
    nse: 'MRF',
    bse: '500290',
    confirmed: true,
    sources: [
      { type: 'ir', url: 'https://www.mrftyres.com/investors' },
      { type: 'bse', url: 'https://www.bseindia.com/stock-share-price/mrf-ltd/mrf/500290/financials-results/' }
    ]
  },
  {
    id: 'ceat',
    name: 'CEAT',
    nse: 'CEATLTD',
    bse: '500878',
    confirmed: true,
    sources: [
      { type: 'ir', url: 'https://www.ceat.com/investors/financial-results.html' },
      { type: 'nse', url: 'https://www.nseindia.com/get-quotes/equity?symbol=CEATLTD' }
    ]
  },
  {
    id: 'jktyre',
    name: 'JK Tyre & Industries',
    nse: 'JKTYRE',
    bse: '530007',
    confirmed: true,
    sources: [
      { type: 'ir', url: 'https://www.jktyre.com/investors-financial-results.aspx' },
      { type: 'nse', url: 'https://www.nseindia.com/get-quotes/equity?symbol=JKTYRE' }
    ]
  },
  {
    id: 'balkrishna',
    name: 'Balkrishna Industries',
    nse: 'BALKRISIND',
    bse: '502355',
    confirmed: true,
    sources: [
      { type: 'ir', url: 'https://www.bkt-tires.com/in/en/investor-relations' },
      { type: 'nse', url: 'https://www.nseindia.com/get-quotes/equity?symbol=BALKRISIND' }
    ]
  },
  {
    id: 'tvssrichakra',
    name: 'TVS Srichakra',
    nse: 'TVSSRICHAK',
    bse: '509243',
    confirmed: true,
    sources: [
      { type: 'ir', url: 'https://www.tvseurogrip.com/investors' },
      { type: 'nse', url: 'https://www.nseindia.com/get-quotes/equity?symbol=TVSSRICHAK' }
    ]
  },
  {
    id: 'goodyear',
    name: 'Goodyear India',
    nse: 'GOODYEAR',
    bse: '500168',
    confirmed: true,
    sources: [
      { type: 'ir', url: 'https://www.goodyear.co.in/investor-relations' },
      { type: 'nse', url: 'https://www.nseindia.com/get-quotes/equity?symbol=GOODYEAR' }
    ]
  }
];

export const COMPANY_IDS = COMPANIES.map((c) => c.id);

/** Resolve a company by id, NSE symbol, or name (case-insensitive). */
export function findCompany(needle) {
  const n = String(needle || '').trim().toLowerCase();
  return COMPANIES.find(
    (c) =>
      c.id === n ||
      String(c.nse).toLowerCase() === n ||
      c.name.toLowerCase() === n ||
      c.name.toLowerCase().replace(/[^a-z0-9]/g, '') === n.replace(/[^a-z0-9]/g, '')
  ) || null;
}

/** Companies to run: an explicit selection, or the whole roster. */
export function selectCompanies(ids) {
  if (!ids || !ids.length) return COMPANIES.slice();
  return ids.map((id) => {
    const c = findCompany(id);
    if (!c) throw new Error(`unknown company: ${id} (known: ${COMPANY_IDS.join(', ')})`);
    return c;
  });
}
