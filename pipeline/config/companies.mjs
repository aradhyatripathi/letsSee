// Section 3 — Companies & Filing Scope.
//
// The spec names Apollo Tyres, MRF, CEAT and JK Tyre explicitly and says the
// remaining five "likely include Balkrishna Industries, TVS Srichakra, Goodyear
// India, and 1-2 more depending on what 'tyre sector' was scoped to mean; use
// whichever list your manager actually referenced."
//
// The four named companies are certain. Balkrishna, TVS Srichakra and Goodyear
// India are the spec's own suggestions. The last two are this file's inference
// from the listed Indian tyre universe and are marked `confirmed: false` — they
// are the ones to check against the original scoping note before a real run.
// Changing the roster means editing this list and nothing else.
//
// `sources` is ordered: the pipeline tries each in turn and records which one
// worked, so a company whose IR page is awkward does not block the other eight.

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
  },
  {
    id: 'modirubber',
    name: 'Modi Rubber',
    nse: 'MODIRUBBER',
    bse: '500890',
    confirmed: false,
    note: 'Inferred to complete the nine — confirm against the original scoping note.',
    sources: [
      { type: 'bse', url: 'https://www.bseindia.com/stock-share-price/modi-rubber-ltd/modirubber/500890/financials-results/' }
    ]
  },
  {
    id: 'ptlenterprises',
    name: 'PTL Enterprises',
    nse: 'PTL',
    bse: '509220',
    confirmed: false,
    note: 'Inferred to complete the nine — confirm against the original scoping note.',
    sources: [
      { type: 'bse', url: 'https://www.bseindia.com/stock-share-price/ptl-enterprises-ltd/ptl/509220/financials-results/' }
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

/** Companies to run: an explicit selection, or all nine. */
export function selectCompanies(ids) {
  if (!ids || !ids.length) return COMPANIES.slice();
  return ids.map((id) => {
    const c = findCompany(id);
    if (!c) throw new Error(`unknown company: ${id} (known: ${COMPANY_IDS.join(', ')})`);
    return c;
  });
}
