// Dependency-free PDF text extraction for Stage 1.
//
// The pipeline runs with zero runtime npm dependencies, so there is no pdf.js or
// pdfminer here: we walk the file's indirect objects, inflate the FlateDecode
// streams with node:zlib, and pull the text-showing operators out of the content
// streams ourselves.
//
// This is deliberately a best-effort extractor. A filing that embeds its fonts
// with a custom encoding and no ToUnicode map will come out as mojibake, and a
// scanned PDF has no text layer at all. Both cases surface as ok:false with a
// reason the operator can act on — the retrieval runner then falls back to
// manual upload rather than feeding garbage into extraction.

import zlib from 'node:zlib';

const WHITESPACE = ' \t\r\n\f\0';
const DELIMITERS = '()<>[]{}/%';

// Everything below this line is a bound on what a file we did not write may cost us.
//
// The retrieval runner fetches from investor-relations sites and hands whatever
// comes back to this extractor, so the input is not trusted and the guarantee that
// matters is run.mjs's: a failure on one company is recorded and the run continues.
// That guarantee is only as good as this file's willingness to give up. An
// unbounded extractor does not fail the company — it takes the process down, and
// every other company's work with it, because a heap abort is not catchable.
//
// Each limit is set well above a real filing (a 200-page annual report is around
// 30 MB with a few MB of content streams) and well below anything that hurts.
const MAX_PDF_BYTES = 64 * 1024 * 1024;
const MAX_INFLATED_BYTES = 16 * 1024 * 1024;      // one stream
const MAX_TOTAL_INFLATED_BYTES = 64 * 1024 * 1024; // the whole document
const EXTRACT_BUDGET_MS = 20000;

/** True when the buffer carries a PDF header (some producers pad before it). */
export function looksLikePdf(buffer) {
  if (!buffer || !buffer.length) return false;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return buf.subarray(0, 1024).toString('latin1').includes('%PDF-');
}

/**
 * Extract the text layer of a PDF.
 * @returns {{ok:boolean, text:string, error:(string|null), streams:number, objectStreams:number}}
 */
export function extractPdfText(buffer) {
  const empty = { ok: false, text: '', error: null, streams: 0, objectStreams: 0 };
  try {
    if (!buffer || !buffer.length) return { ...empty, error: 'empty buffer' };
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (!looksLikePdf(buf)) return { ...empty, error: 'not a PDF: no %PDF- header in the first 1024 bytes' };
    if (buf.length > MAX_PDF_BYTES) {
      return { ...empty, error: `PDF is ${mb(buf.length)} MB, past the ${mb(MAX_PDF_BYTES)} MB this extractor will read — open it and save the financial-statement pages, or paste the text` };
    }

    const raw = buf.toString('latin1');
    const parts = [];
    const deadline = Date.now() + EXTRACT_BUDGET_MS;
    let streams = 0;
    let objectStreams = 0;
    let undecodable = 0;
    let inflatedTotal = 0;

    for (const stream of iterateStreams(buf, raw)) {
      if (Date.now() > deadline) {
        return { ...empty, error: `PDF text extraction gave up after ${EXTRACT_BUDGET_MS / 1000}s — the file is structured in a way this extractor cannot walk quickly`, streams, objectStreams };
      }
      if (stream.kind === 'objstm') { objectStreams++; continue; }
      if (stream.kind === 'skip') continue;
      const content = decodeStream(stream, MAX_TOTAL_INFLATED_BYTES - inflatedTotal);
      if (content === null) { undecodable++; continue; }
      inflatedTotal += content.length;
      streams++;
      const text = textFromContentStream(content);
      if (text) parts.push(text);
    }

    const text = tidy(parts.join('\n\n'));
    if (!text) {
      const why = streams === 0
        ? (undecodable > 0
          ? `no content stream could be decoded (${undecodable} stream(s) used an unsupported filter or were corrupt)`
          : 'no content streams found — the file may be linearised in a way this extractor does not follow')
        : 'content streams decoded but contained no text-showing operators — the PDF is most likely a scan with no text layer';
      return { ...empty, error: why, streams, objectStreams };
    }

    return { ok: true, text, error: null, streams, objectStreams };
  } catch (err) {
    return { ...empty, error: `PDF extraction failed: ${err && err.message ? err.message : String(err)}` };
  }
}

/* ------------------------------------------------------------- structure -- */

// Walks `N M obj ... endobj` regions and yields the stream inside each one,
// classified so the caller can skip the ones that never hold page text.
function* iterateStreams(buf, raw) {
  const objRe = /(?:^|[^0-9])(\d+)\s+(\d+)\s+obj\b/g;
  const starts = [];
  let m;
  while ((m = objRe.exec(raw)) !== null) {
    starts.push(objRe.lastIndex);
    objRe.lastIndex = m.index + m[0].length;
  }

  const findEndobj = forwardScanner(raw, 'endobj');
  const findStream = forwardScanner(raw, 'stream');

  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    const hardEnd = i + 1 < starts.length ? starts[i + 1] : raw.length;
    const endObj = findEndobj(from);
    const to = endObj !== -1 && endObj < hardEnd ? endObj : hardEnd;

    const kw = findStream(from);
    if (kw === -1 || kw >= to) continue;

    const dict = raw.slice(from, kw);
    let dataStart = kw + 'stream'.length;
    if (raw[dataStart] === '\r') dataStart++;
    if (raw[dataStart] === '\n') dataStart++;

    const declared = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    let dataEnd = -1;
    if (declared) {
      const candidate = dataStart + parseInt(declared[1], 10);
      if (candidate <= raw.length && raw.slice(candidate, candidate + 20).includes('endstream')) {
        dataEnd = candidate;
      }
    }
    if (dataEnd === -1) {
      const marker = raw.indexOf('endstream', dataStart);
      dataEnd = marker === -1 ? to : marker;
      while (dataEnd > dataStart && (raw[dataEnd - 1] === '\n' || raw[dataEnd - 1] === '\r')) dataEnd--;
    }
    if (dataEnd <= dataStart) continue;

    yield { kind: classify(dict), dict, data: buf.subarray(dataStart, dataEnd) };
  }
}

/**
 * indexOf for a needle looked for from steadily increasing offsets.
 *
 * The offsets here are object starts, which ascend, and indexOf over an ascending
 * start is non-decreasing — so a hit already past the new start is still the
 * answer, and once the needle is absent from the tail it is absent from every
 * later tail. Restarting the search each time made the scan quadratic: a file that
 * is nothing but `N 0 obj` lines and contains neither keyword scanned to
 * end-of-file once per object, so 8 MB of them took 160 seconds of blocked event
 * loop — with every other company in the run waiting behind it.
 */
function forwardScanner(raw, needle) {
  let at = -1;
  let exhausted = false;
  return (from) => {
    if (exhausted) return -1;
    if (at >= from) return at;
    at = raw.indexOf(needle, from);
    if (at === -1) exhausted = true;
    return at;
  };
}

function mb(bytes) { return Math.round(bytes / (1024 * 1024)); }

function classify(dict) {
  // Object streams hold compressed *non-stream* objects, so they never contain
  // page content; inflating one would only produce object definitions.
  if (/\/Type\s*\/ObjStm/.test(dict)) return 'objstm';
  if (/\/Type\s*\/(XRef|Metadata)\b/.test(dict)) return 'skip';
  if (/\/Subtype\s*\/(Image|Type1C|CIDFontType0C|TrueType)\b/.test(dict)) return 'skip';
  if (/\/Type\s*\/(Font|FontDescriptor)\b/.test(dict)) return 'skip';
  return 'content';
}

function decodeStream({ dict, data }, budget) {
  const filters = [...dict.matchAll(/\/(FlateDecode|LZWDecode|ASCII85Decode|ASCIIHexDecode|DCTDecode|JPXDecode|CCITTFaxDecode|RunLengthDecode|JBIG2Decode)\b/g)]
    .map((f) => f[1]);

  if (!filters.length) return data.toString('latin1');
  if (filters.some((f) => f !== 'FlateDecode')) return null;

  const inflated = inflate(data, budget);
  return inflated === null ? null : inflated.toString('latin1');
}

/**
 * Inflate one stream, refusing to produce more than `budget` bytes.
 *
 * Deflate's ratio is unbounded in principle and about 1000:1 on a stream of
 * zeroes, so a few hundred kilobytes of PDF expands to gigabytes — and the abort
 * that follows is a heap failure, which no caller can catch and which loses the
 * whole run rather than this one company. A stream that will not fit is treated
 * exactly like a stream in an unsupported filter: undecodable, counted, skipped.
 */
function inflate(data, budget) {
  const maxOutputLength = Math.max(0, Math.min(MAX_INFLATED_BYTES, budget == null ? MAX_INFLATED_BYTES : budget));
  if (!maxOutputLength) return null;
  let start = 0;
  while (start < data.length && WHITESPACE.includes(String.fromCharCode(data[start]))) start++;
  const body = start ? data.subarray(start) : data;
  for (const fn of [zlib.inflateSync, zlib.inflateRawSync]) {
    try {
      return fn(body, { maxOutputLength });
    } catch {
      // Truncated streams are common in the wild; take whatever inflated before
      // the error rather than losing the whole page.
      try {
        return fn(body, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength });
      } catch {
        /* try the next codec */
      }
    }
  }
  return null;
}

/* -------------------------------------------------------- content stream -- */

function isWhitespace(ch) { return WHITESPACE.includes(ch); }
function isDelimiter(ch) { return DELIMITERS.includes(ch); }

// A PDF string is a byte string. Text strings may be UTF-16BE with a byte-order
// mark; everything else is close enough to Latin-1 for our purposes.
function decodeBytes(s) {
  if (s.length >= 2 && s.charCodeAt(0) === 0xfe && s.charCodeAt(1) === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < s.length; i += 2) {
      out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
    }
    return out;
  }
  return s;
}

function readLiteralString(s, i) {
  const out = [];
  let depth = 1;
  let j = i + 1;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '\\') {
      const n = s[j + 1];
      j += 2;
      if (n === 'n') out.push('\n');
      else if (n === 'r') out.push('\r');
      else if (n === 't') out.push('\t');
      else if (n === 'b') out.push('\b');
      else if (n === 'f') out.push('\f');
      else if (n === '\n') { /* line continuation */ }
      else if (n === '\r') { if (s[j] === '\n') j++; }
      else if (n >= '0' && n <= '7') {
        let oct = n;
        while (oct.length < 3 && s[j] >= '0' && s[j] <= '7') { oct += s[j]; j++; }
        out.push(String.fromCharCode(parseInt(oct, 8) & 0xff));
      } else if (n !== undefined) out.push(n);
      continue;
    }
    if (ch === '(') { depth++; out.push(ch); j++; continue; }
    if (ch === ')') {
      depth--;
      j++;
      if (depth === 0) break;
      out.push(')');
      continue;
    }
    out.push(ch);
    j++;
  }
  return { value: decodeBytes(out.join('')), next: j };
}

function readHexString(s, i) {
  let hex = '';
  let j = i + 1;
  while (j < s.length && s[j] !== '>') {
    const ch = s[j];
    if (/[0-9a-fA-F]/.test(ch)) hex += ch;
    j++;
  }
  if (hex.length % 2) hex += '0';
  let out = '';
  for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
  return { value: decodeBytes(out), next: j + 1 };
}

function skipDictionary(s, i) {
  let depth = 0;
  let j = i;
  while (j < s.length) {
    if (s[j] === '<' && s[j + 1] === '<') { depth++; j += 2; continue; }
    if (s[j] === '>' && s[j + 1] === '>') { depth--; j += 2; if (depth === 0) return j; continue; }
    if (s[j] === '(') { j = readLiteralString(s, j).next; continue; }
    j++;
  }
  return j;
}

function readArray(s, i) {
  const items = [];
  let j = i + 1;
  while (j < s.length && s[j] !== ']') {
    const ch = s[j];
    if (isWhitespace(ch)) { j++; continue; }
    if (ch === '(') { const r = readLiteralString(s, j); items.push(r.value); j = r.next; continue; }
    if (ch === '<') { const r = readHexString(s, j); items.push(r.value); j = r.next; continue; }
    if (/[-+.0-9]/.test(ch)) {
      let k = j;
      while (k < s.length && /[-+.0-9eE]/.test(s[k])) k++;
      items.push(parseFloat(s.slice(j, k)));
      j = k;
      continue;
    }
    j++;
  }
  return { value: items, next: j + 1 };
}

// Kerning adjustments in a TJ array are in thousandths of a text-space unit and
// are negative when they move the pen forward. Anything past this much of an em
// is a word gap rather than letter tightening.
const TJ_SPACE_THRESHOLD = 100;

function textFromContentStream(source) {
  const chunks = [];
  let pendingNewline = false;
  let pendingSpace = false;
  let lastX = null;
  let lastY = null;

  const emit = (text) => {
    if (!text) return;
    if (chunks.length) {
      if (pendingNewline) chunks.push('\n');
      else if (pendingSpace) chunks.push(' ');
    }
    pendingNewline = false;
    pendingSpace = false;
    chunks.push(text);
  };
  const newline = () => { if (chunks.length) pendingNewline = true; };
  const space = () => { if (chunks.length && !pendingNewline) pendingSpace = true; };

  const stack = [];
  const str = (v) => (typeof v === 'string' ? v : '');

  const apply = (op) => {
    switch (op) {
      case 'Tj':
        emit(str(stack[stack.length - 1]));
        break;
      case "'":
        newline();
        emit(str(stack[stack.length - 1]));
        break;
      case '"':
        newline();
        emit(str(stack[stack.length - 1]));
        break;
      case 'TJ': {
        const arr = stack[stack.length - 1];
        if (!Array.isArray(arr)) break;
        for (const item of arr) {
          if (typeof item === 'string') emit(item);
          else if (typeof item === 'number' && item <= -TJ_SPACE_THRESHOLD) space();
        }
        break;
      }
      case 'Td':
      case 'TD': {
        const ty = stack[stack.length - 1];
        const tx = stack[stack.length - 2];
        if (typeof ty === 'number' && ty !== 0) newline();
        else if (typeof tx === 'number' && Math.abs(tx) > 0.01) space();
        break;
      }
      case 'T*':
        newline();
        break;
      case 'Tm': {
        const f = stack[stack.length - 1];
        const e = stack[stack.length - 2];
        if (typeof e === 'number' && typeof f === 'number') {
          if (lastY !== null && Math.abs(f - lastY) > 0.5) newline();
          else if (lastX !== null && e - lastX > 1) space();
          lastX = e;
          lastY = f;
        }
        break;
      }
      case 'BT':
        lastX = null;
        lastY = null;
        break;
      case 'ET':
        newline();
        break;
      default:
        break;
    }
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i];

    if (isWhitespace(ch)) { i++; continue; }
    if (ch === '%') {
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
      continue;
    }
    if (ch === '(') { const r = readLiteralString(source, i); stack.push(r.value); i = r.next; continue; }
    if (ch === '<') {
      if (source[i + 1] === '<') { i = skipDictionary(source, i); stack.push(null); continue; }
      const r = readHexString(source, i);
      stack.push(r.value);
      i = r.next;
      continue;
    }
    if (ch === '[') { const r = readArray(source, i); stack.push(r.value); i = r.next; continue; }
    if (ch === '/') {
      i++;
      while (i < source.length && !isWhitespace(source[i]) && !isDelimiter(source[i])) i++;
      stack.push(null);
      continue;
    }
    if (/[-+.0-9]/.test(ch)) {
      let j = i;
      while (j < source.length && /[-+.0-9eE]/.test(source[j])) j++;
      stack.push(parseFloat(source.slice(i, j)));
      i = j;
      continue;
    }
    if (isDelimiter(ch)) { i++; continue; }

    let j = i;
    while (j < source.length && !isWhitespace(source[j]) && !isDelimiter(source[j])) j++;
    const op = source.slice(i, j);
    i = j;

    if (op === 'BI') {
      // Inline image data is raw bytes that would otherwise be read as operators.
      const end = source.indexOf('EI', i);
      i = end === -1 ? source.length : end + 2;
      stack.length = 0;
      continue;
    }

    apply(op);
    stack.length = 0;
  }

  return chunks.join('');
}

function tidy(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
