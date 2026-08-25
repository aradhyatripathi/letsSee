/* ==== TYRE-XLSX:BEGIN ====
 * Excel rendering for the workbook model that TyreCore.buildWorkbookModel produces.
 * Inlined verbatim into dashboard/tyre_comparison_dashboard.html between the TYRE-XLSX
 * markers and loaded by pipeline/lib/xlsx.mjs, the same way the core and the deck are.
 * `npm run sync:core` copies it; `npm test` fails if the copies drift.
 *
 * Plain script — no imports, no exports, no top-level await. Everything hangs off the
 * TyreXlsx object defined at the bottom. It must be loaded AFTER the deck block, because
 * it uses that block's ZIP writer: a .xlsx and a .pptx are the same kind of package and
 * there is no reason to have two copies of the container code.
 *
 * Why write this at all, when the dashboard already loaded SheetJS. Two reasons, and the
 * first is the serious one.
 *
 * The workbook is the build spec's primary output artefact (Section 5), and it was the one
 * output that did not work without a network — SheetJS came from a CDN, so on a machine
 * behind a corporate proxy the Export button disabled itself and the main deliverable
 * simply was not there. Everything else in this project runs with nothing installed and
 * nothing reachable; the deliverable it exists to produce should too.
 *
 * The second is that the community build of SheetJS ignores per-cell styling, so the
 * styled headers Section 5 asks for never survived the round trip. Here they do.
 */

/* ------------------------------------------------------------------ util -- */

function xlEsc(value) {
  var sanitize = (typeof TyreCore !== 'undefined' && TyreCore && TyreCore.sanitizeText)
    || (typeof window !== 'undefined' && window.TyreCore && window.TyreCore.sanitizeText)
    || function (v) { return String(v == null ? '' : v); };
  return String(sanitize(value))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Excel refuses a cell holding more than 32,767 characters. It does not refuse the
// file — it opens it, announces that it repaired unreadable content, and drops the
// part it did not like, which in a workbook whose whole claim is traceability is
// the worst available outcome. Records are bounded upstream too; this is the last
// line before bytes, and a format guarantee should not depend on an upstream step
// having run.
var XL_MAX_CELL_CHARS = 32000;
var XL_CLIP_MARKER = ' …[clipped]';

function xlClip(value) {
  var s = String(value == null ? '' : value);
  return s.length > XL_MAX_CELL_CHARS
    ? s.slice(0, XL_MAX_CELL_CHARS - XL_CLIP_MARKER.length) + XL_CLIP_MARKER
    : s;
}

/** 0 -> A, 25 -> Z, 26 -> AA. */
function xlColName(index) {
  var s = '';
  var n = index + 1;
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function xlParseRef(ref) {
  var m = /^([A-Z]+)(\d+)$/.exec(String(ref || ''));
  if (!m) return null;
  var col = 0;
  for (var i = 0; i < m[1].length; i++) col = col * 26 + (m[1].charCodeAt(i) - 64);
  return { col: col - 1, row: Number(m[2]) - 1 };
}

// Excel rejects these characters in a sheet name and truncates past 31.
function xlSheetName(name, index) {
  var s = String(name == null ? '' : name).replace(/[\[\]:*?\/\\]/g, ' ').trim();
  if (!s) s = 'Sheet' + (index + 1);
  return s.length > 31 ? s.slice(0, 31) : s;
}

var XL_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
var XL_NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

var XL_THEME = { headerFill: '1F3A5F', headerText: 'FFFFFF', muted: '6B7280', rule: 'D8D5CC' };

var XL_STYLE = { DEFAULT: 0, HEADER: 1, WRAP: 2, CELL: 3 };

/* ----------------------------------------------------------------- parts -- */

function xlStyles() {
  return XL_DECL +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="3">' +
      '<font><sz val="11"/><color theme="1"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><color rgb="FF' + XL_THEME.headerText + '"/><name val="Calibri"/></font>' +
      '<font><sz val="11"/><color rgb="FF' + XL_THEME.muted + '"/><name val="Calibri"/></font>' +
    '</fonts>' +
    '<fills count="3">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FF' + XL_THEME.headerFill + '"/><bgColor indexed="64"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="2">' +
      '<border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border><left/><right/><top/><bottom style="thin"><color rgb="FF' + XL_THEME.rule + '"/></bottom><diagonal/></border>' +
    '</borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="4">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1">' +
        '<alignment vertical="center" wrapText="1"/></xf>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">' +
        '<alignment vertical="top" wrapText="1"/></xf>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';
}

function xlSheet(sheet, hasComments) {
  var aoa = sheet.aoa || [];
  var wrapCols = {};
  (sheet.wrap || []).forEach(function (c) { wrapCols[c] = true; });

  var xml = XL_DECL + '<worksheet ' + XL_NS + '>';

  var freeze = xlParseRef(sheet.freeze);
  if (freeze && (freeze.col || freeze.row)) {
    xml += '<sheetViews><sheetView workbookViewId="0">' +
      '<pane' + (freeze.col ? ' xSplit="' + freeze.col + '"' : '') +
      (freeze.row ? ' ySplit="' + freeze.row + '"' : '') +
      ' topLeftCell="' + xlEsc(sheet.freeze) + '" activePane="bottomRight" state="frozen"/>' +
      '</sheetView></sheetViews>';
  }

  if (sheet.widths && sheet.widths.length) {
    xml += '<cols>';
    sheet.widths.forEach(function (w, i) {
      xml += '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (Number(w) || 12) + '" customWidth="1"/>';
    });
    xml += '</cols>';
  }

  xml += '<sheetData>';
  aoa.forEach(function (row, r) {
    xml += '<row r="' + (r + 1) + '"' + (r === 0 ? ' ht="22" customHeight="1"' : '') + '>';
    (row || []).forEach(function (value, c) {
      var ref = xlColName(c) + (r + 1);
      var style = r === 0 ? XL_STYLE.HEADER : (wrapCols[c] ? XL_STYLE.WRAP : XL_STYLE.CELL);
      if (typeof value === 'number' && isFinite(value)) {
        xml += '<c r="' + ref + '" s="' + style + '"><v>' + value + '</v></c>';
        return;
      }
      var text = xlEsc(xlClip(value));
      if (!text) { xml += '<c r="' + ref + '" s="' + style + '"/>'; return; }
      // Inline strings rather than a shared-string table: one part fewer, and no index to
      // get wrong. The size cost is irrelevant at this scale.
      xml += '<c r="' + ref + '" s="' + style + '" t="inlineStr"><is><t xml:space="preserve">' + text + '</t></is></c>';
    });
    xml += '</row>';
  });
  xml += '</sheetData>';

  if (hasComments) xml += '<legacyDrawing r:id="rIdVml"/>';
  return xml + '</worksheet>';
}

// A cell note in .xlsx is the old VML-backed kind: the text lives in one part and a shape
// positioned on the cell in another, and a reader wants the pair. This is what carries the
// source quote behind every figure, which is the whole point of the workbook.
function xlComments(comments) {
  var xml = XL_DECL + '<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<authors><author>pipeline</author></authors><commentList>';
  comments.forEach(function (c) {
    xml += '<comment ref="' + xlEsc(c.addr) + '" authorId="0"><text><r>' +
      '<rPr><sz val="9"/><rFont val="Calibri"/></rPr>' +
      '<t xml:space="preserve">' + xlEsc(xlClip(c.text)) + '</t></r></text></comment>';
  });
  return xml + '</commentList></comments>';
}

function xlVml(comments) {
  var shapes = '';
  comments.forEach(function (c, i) {
    var at = xlParseRef(c.addr) || { col: 0, row: 0 };
    shapes +=
      '<v:shape id="_x0000_s' + (1025 + i) + '" type="#_x0000_t202" style="position:absolute;' +
      'margin-left:80pt;margin-top:2pt;width:280pt;height:90pt;z-index:' + (i + 1) + ';visibility:hidden" ' +
      'fillcolor="#fbf6d6" strokecolor="#c9c3b3" o:insetmode="auto">' +
      '<v:fill color2="#fbf6d6"/><v:shadow on="t" color="black" obscured="t"/>' +
      '<v:path o:connecttype="none"/>' +
      '<v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox>' +
      '<x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/>' +
      '<x:Anchor>' + (at.col + 1) + ', 15, ' + at.row + ', 2, ' + (at.col + 4) + ', 15, ' + (at.row + 5) + ', 2</x:Anchor>' +
      '<x:AutoFill>False</x:AutoFill><x:Row>' + at.row + '</x:Row><x:Column>' + at.col + '</x:Column>' +
      '</x:ClientData></v:shape>';
  });
  return '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" ' +
    'xmlns:x="urn:schemas-microsoft-com:office:excel">' +
    '<o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout>' +
    '<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe">' +
    '<v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>' +
    shapes + '</xml>';
}

function xlRels(items) {
  var xml = XL_DECL + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
  items.forEach(function (it) {
    xml += '<Relationship Id="' + it.id + '" Type="' + it.type + '" Target="' + it.target + '"/>';
  });
  return xml + '</Relationships>';
}

var XL_REL = {
  officeDocument: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  worksheet: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
  styles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
  comments: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments',
  vml: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing',
  coreProps: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties'
};

/* ------------------------------------------------------------------- api -- */

/** The package parts for a workbook model, as [{ name, data }]. */
function buildXlsxParts(model) {
  var sheets = (model && model.sheets) || [];
  if (!sheets.length) throw new Error('workbook model has no sheets');

  var commentsBySheet = {};
  ((model && model.comments) || []).forEach(function (c) {
    (commentsBySheet[c.sheet] = commentsBySheet[c.sheet] || []).push(c);
  });

  var entries = [];
  var types = XL_DECL + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>';

  var sheetTags = '';
  var workbookRels = [{ id: 'rIdStyles', type: XL_REL.styles, target: 'styles.xml' }];
  var seenNames = {};

  sheets.forEach(function (sheet, i) {
    var n = i + 1;
    var name = xlSheetName(sheet.name, i);
    // Two sheets cannot share a name; a model that produced one would otherwise write a
    // package Excel refuses to open.
    if (seenNames[name.toLowerCase()]) name = xlSheetName(name.slice(0, 28) + ' ' + n, i);
    seenNames[name.toLowerCase()] = true;

    var comments = commentsBySheet[sheet.name] || [];
    var hasComments = comments.length > 0;

    entries.push({ name: 'xl/worksheets/sheet' + n + '.xml', data: xlSheet(sheet, hasComments) });
    types += '<Override PartName="/xl/worksheets/sheet' + n + '.xml" ' +
      'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';

    if (hasComments) {
      entries.push({ name: 'xl/comments' + n + '.xml', data: xlComments(comments) });
      entries.push({ name: 'xl/drawings/vmlDrawing' + n + '.vml', data: xlVml(comments) });
      entries.push({ name: 'xl/worksheets/_rels/sheet' + n + '.xml.rels', data: xlRels([
        { id: 'rIdVml', type: XL_REL.vml, target: '../drawings/vmlDrawing' + n + '.vml' },
        { id: 'rIdComments', type: XL_REL.comments, target: '../comments' + n + '.xml' }
      ]) });
      types += '<Override PartName="/xl/comments' + n + '.xml" ' +
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>';
    }

    sheetTags += '<sheet name="' + xlEsc(name) + '" sheetId="' + n + '" r:id="rIdSheet' + n + '"/>';
    workbookRels.push({ id: 'rIdSheet' + n, type: XL_REL.worksheet, target: 'worksheets/sheet' + n + '.xml' });
  });

  entries.push({ name: '_rels/.rels', data: xlRels([
    { id: 'rId1', type: XL_REL.officeDocument, target: 'xl/workbook.xml' },
    { id: 'rId2', type: XL_REL.coreProps, target: 'docProps/core.xml' }
  ]) });
  entries.push({ name: 'docProps/core.xml', data: XL_DECL +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    '<dc:title>Tyre sector — reviewed filing extracts</dc:title>' +
    '<dc:subject>Every figure carries the quote it came from</dc:subject>' +
    '</cp:coreProperties>' });
  entries.push({ name: 'xl/workbook.xml', data: XL_DECL + '<workbook ' + XL_NS + '><sheets>' + sheetTags + '</sheets></workbook>' });
  entries.push({ name: 'xl/_rels/workbook.xml.rels', data: xlRels(workbookRels) });
  entries.push({ name: 'xl/styles.xml', data: xlStyles() });

  // [Content_Types].xml must be the first entry in the package.
  entries.unshift({ name: '[Content_Types].xml', data: types + '</Types>' });
  return entries;
}

/**
 * Render a workbook model to .xlsx bytes.
 * @param {object} model  TyreCore.buildWorkbookModel output.
 * @returns {Uint8Array}
 */
function writeXlsx(model) {
  var deck = (typeof TyreDeck !== 'undefined' && TyreDeck) ||
    (typeof window !== 'undefined' && window.TyreDeck) ||
    (typeof globalThis !== 'undefined' && globalThis.TyreDeck) || null;
  if (!deck || !deck.zip) {
    throw new Error('TyreDeck.zip is not available — the deck block must load before this one');
  }
  return deck.zip(buildXlsxParts(model));
}

/** Convenience for callers that only hold records. */
function recordsToXlsx(records, opts) {
  var core = (typeof TyreCore !== 'undefined' && TyreCore) ||
    (typeof window !== 'undefined' && window.TyreCore) ||
    (typeof globalThis !== 'undefined' && globalThis.TyreCore) || null;
  if (!core || !core.buildWorkbookModel) throw new Error('TyreCore.buildWorkbookModel is not available');
  return writeXlsx(core.buildWorkbookModel(records, opts));
}

var TyreXlsx = {
  writeXlsx: writeXlsx,
  recordsToXlsx: recordsToXlsx,
  buildXlsxParts: buildXlsxParts,
  colName: xlColName,
  sheetName: xlSheetName,
  clip: xlClip,
  MAX_CELL_CHARS: XL_MAX_CELL_CHARS,
  MIME: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

if (typeof window !== 'undefined') { window.TyreXlsx = TyreXlsx; }
if (typeof globalThis !== 'undefined') { globalThis.TyreXlsx = TyreXlsx; }
/* ==== TYRE-XLSX:END ==== */
