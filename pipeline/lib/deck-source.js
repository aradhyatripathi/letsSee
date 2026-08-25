/* ==== TYRE-DECK:BEGIN ====
 * PowerPoint rendering for the deck model that TyreCore.buildDeckModel produces.
 * Inlined verbatim into dashboard/tyre_comparison_dashboard.html between the
 * TYRE-DECK markers and loaded by pipeline/lib/deck.mjs, the same way the core
 * is. `npm run sync:core` copies it; `npm test` fails if the two drift.
 *
 * Plain script — no imports, no exports, no top-level await. Everything hangs
 * off the TyreDeck object defined at the bottom.
 *
 * Why hand-rolled: the pipeline carries no runtime npm dependencies, and the
 * dashboard is one file with no build step, so a library is not available on
 * either side. A .pptx is a ZIP of XML parts, and the parts a presentation
 * actually needs are few. Entries are STORED rather than deflated, because the
 * browser has no zlib and a stored ZIP is equally valid — a deck of this size
 * lands around a quarter of a megabyte either way.
 *
 * Every shape is positioned explicitly rather than inheriting from a layout
 * placeholder, so what the code says is what the slide shows.
 */

/* ------------------------------------------------------------------ bytes -- */

var TD_CRC_TABLE = (function () {
  var table = new Int32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function tdCrc32(bytes) {
  var c = -1;
  for (var i = 0; i < bytes.length; i++) c = TD_CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function tdUtf8(str) {
  var s = String(str == null ? '' : str);
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
  var out = [];
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    var lo = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c >= 0xd800 && c <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) {
      // Only consume the next unit when it really is the low half of the pair —
      // otherwise this ate an ordinary character, and eating the '<' of the next tag
      // breaks the document rather than one word.
      var cp = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
      i++;
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdfff) {
      out.push(0xef, 0xbf, 0xbd);                 // unpaired surrogate -> U+FFFD
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return new Uint8Array(out);
}

// One fixed timestamp for every entry: the same deck model must render to the
// same bytes twice, or the tests cannot compare anything. 1 Jan 2020, 00:00.
var TD_DOS_TIME = 0;
var TD_DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

function tdZip(entries) {
  // The end-of-central-directory record holds the entry count in 16 bits. ZIP64 would
  // lift that; nothing here needs it, so refuse loudly rather than wrap silently and
  // produce an archive that unzips to a fraction of its contents.
  if (entries.length > 0xffff) {
    throw new Error('too many parts for a plain ZIP (' + entries.length + ' > 65535); this deck needs ZIP64');
  }
  var chunks = [];
  var central = [];
  var offset = 0;

  function push(bytes) { chunks.push(bytes); offset += bytes.length; }
  function u16(v) { return new Uint8Array([v & 0xff, (v >> 8) & 0xff]); }
  function u32(v) { return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]); }
  function join(list) {
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i].length;
    var out = new Uint8Array(total), at = 0;
    for (i = 0; i < list.length; i++) { out.set(list[i], at); at += list[i].length; }
    return out;
  }

  entries.forEach(function (entry) {
    var name = tdUtf8(entry.name);
    var data = entry.data instanceof Uint8Array ? entry.data : tdUtf8(entry.data);
    var crc = tdCrc32(data);
    var localAt = offset;

    push(join([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(TD_DOS_TIME), u16(TD_DOS_DATE),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name
    ]));
    push(data);

    central.push(join([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(TD_DOS_TIME), u16(TD_DOS_DATE),
      u32(crc), u32(data.length), u32(data.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(localAt), name
    ]));
  });

  var cdStart = offset;
  var cd = join(central);
  push(cd);
  push(join([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(cd.length), u32(cdStart), u16(0)
  ]));

  return join(chunks);
}

/* -------------------------------------------------------------------- xml -- */

// XML 1.0 admits a specific set of characters, and a PDF text layer hands over
// things outside it more often than you would hope. Anything not in the Char
// production is dropped before escaping, because the consequence is not a stray
// glyph: a single U+FFFF in a company name makes ppt/slides/slideN.xml
// not-well-formed, and the reader that notices does not report an error — it opens
// the deck and silently drops every table row after the bad character.
//
// Done character by character rather than by regex because the surrogate rule is
// contextual: a properly paired surrogate is a perfectly valid astral character and
// must survive, while a lone half of a pair is not representable at all.
function tdSanitize(value) {
  var str = String(value == null ? '' : value);
  var out = '';
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      var next = i + 1 < str.length ? str.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) { out += str.charAt(i) + str.charAt(i + 1); i++; }
      continue;                                   // lone high surrogate
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;     // lone low surrogate
    if (c === 0xfffe || c === 0xffff) continue;   // not characters
    if (c === 0x7f) continue;
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) continue;
    out += str.charAt(i);
  }
  return out;
}

function tdEsc(value) {
  return tdSanitize(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

var TD_XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
var TD_NS_P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

/* ----------------------------------------------------------------- layout -- */

var TD = {
  W: 12192000, H: 6858000,          // 16:9, in EMU (914400 EMU to the inch)
  MARGIN: 685800,                   // 0.75"
  TITLE_Y: 411480,
  TITLE_H: 800100,
  SUB_Y: 1188720,
  SUB_H: 365760,
  BODY_Y: 1691640,
  FOOT_H: 457200,
  ink: '1A1A1A',
  navy: '1F3A5F',
  muted: '6B7280',
  band: 'F4F5F7',
  line: 'C9CFD8',
  paper: 'FFFFFF',
  font: 'Calibri'
};
TD.CONTENT_W = TD.W - TD.MARGIN * 2;
TD.FOOT_Y = TD.H - TD.MARGIN / 2 - TD.FOOT_H;
TD.BODY_H = TD.FOOT_Y - TD.BODY_Y - 91440;

function tdRun(text, opts) {
  var o = opts || {};
  var props = '<a:rPr lang="en-US" sz="' + (o.sz || 1400) + '"' +
    (o.b ? ' b="1"' : '') + (o.i ? ' i="1"' : '') + ' dirty="0">' +
    '<a:solidFill><a:srgbClr val="' + (o.color || TD.ink) + '"/></a:solidFill>' +
    '<a:latin typeface="' + TD.font + '"/><a:cs typeface="' + TD.font + '"/></a:rPr>';
  return '<a:r>' + props + '<a:t>' + tdEsc(text) + '</a:t></a:r>';
}

// DrawingML validates a:pPr's children by order, not just presence: spacing comes
// before the bullet elements, and a consumer that checks will refuse the whole
// package if they are swapped rather than ignoring the paragraph.
function tdPara(text, opts) {
  var o = opts || {};
  var pPr = '<a:pPr algn="' + (o.algn || 'l') + '"' + (o.indent ? ' marL="285750" indent="-285750"' : '') + '>' +
    (o.spaceAfter ? '<a:spcAft><a:spcPts val="' + o.spaceAfter + '"/></a:spcAft>' : '') +
    (o.bullet ? '<a:buFont typeface="Arial"/><a:buChar char="&#8226;"/>' : '<a:buNone/>') +
    '</a:pPr>';
  return '<a:p>' + pPr + (text === '' ? '' : tdRun(text, o)) + '</a:p>';
}

var TD_SHAPE_ID = { n: 1 };

function tdTextBox(x, y, cx, cy, paragraphs, opts) {
  var o = opts || {};
  var id = ++TD_SHAPE_ID.n;
  return '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="Text ' + id + '"/>' +
    '<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="' + x + '" y="' + y + '"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
    (o.fill ? '<a:solidFill><a:srgbClr val="' + o.fill + '"/></a:solidFill>' : '<a:noFill/>') +
    '</p:spPr>' +
    '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="45720" rIns="0" bIns="45720" anchor="' + (o.anchor || 't') + '">' +
    '<a:normAutofit/></a:bodyPr><a:lstStyle/>' + paragraphs.join('') + '</p:txBody></p:sp>';
}

function tdRect(x, y, cx, cy, color) {
  var id = ++TD_SHAPE_ID.n;
  return '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="Rule ' + id + '"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="' + x + '" y="' + y + '"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
    '<a:solidFill><a:srgbClr val="' + color + '"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>';
}

/* Column widths: the first column carries names, the rest share what is left. */
function tdColumnWidths(columns, totalWidth, align) {
  var n = columns.length;
  if (n === 1) return [totalWidth];
  var algn = align || columns.map(function (_, i) { return i === 0 ? 'l' : 'r'; });
  // Label columns hold names and carry more text than a figure does, so they get
  // a heavier share of the width; the rest split what is left evenly.
  var weights = algn.map(function (a) { return a === 'l' ? (n <= 3 ? 1.9 : 1.7) : 1; });
  var total = weights.reduce(function (a, b) { return a + b; }, 0);
  var widths = weights.map(function (w) { return Math.floor((totalWidth * w) / total); });
  var used = widths.reduce(function (a, b) { return a + b; }, 0);
  widths[n - 1] += totalWidth - used;
  return widths;
}

function tdCell(text, opts) {
  var o = opts || {};
  var body = '<a:txBody><a:bodyPr/><a:lstStyle/>' +
    tdPara(text, { sz: o.sz || 1200, b: o.b, color: o.color || TD.ink, algn: o.algn || 'l' }) +
    '</a:txBody>';
  var margins = ' marL="91440" marR="91440" marT="45720" marB="45720" anchor="ctr"';
  var fill = o.fill ? '<a:solidFill><a:srgbClr val="' + o.fill + '"/></a:solidFill>' : '<a:noFill/>';
  var borders =
    '<a:lnB w="6350" cap="flat" cmpd="sng"><a:solidFill><a:srgbClr val="' + TD.line + '"/></a:solidFill></a:lnB>';
  return '<a:tc>' + body + '<a:tcPr' + margins + '>' + borders + fill + '</a:tcPr></a:tc>';
}

// `align` is an array of 'l'/'r' per column. Left-aligned columns are the label
// columns, so they are the ones that take bold — a two-up metric table has two of
// them and a comparison table has one, and neither should have to say so twice.
function tdTable(x, y, cx, columns, rows, align) {
  var id = ++TD_SHAPE_ID.n;
  var algn = align && align.length === columns.length
    ? align
    : columns.map(function (_, i) { return i === 0 ? 'l' : 'r'; });
  var widths = tdColumnWidths(columns, cx, algn);
  var headH = 411480;
  var rowH = Math.max(274320, Math.min(457200, Math.round((TD.BODY_H - headH) / Math.max(1, rows.length))));

  var xml = '<a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>';
  widths.forEach(function (w) { xml += '<a:gridCol w="' + w + '"/>'; });
  xml += '</a:tblGrid>';

  xml += '<a:tr h="' + headH + '">';
  columns.forEach(function (c, i) {
    xml += tdCell(c, { b: true, color: TD.paper, fill: TD.navy, sz: 1200, algn: algn[i] });
  });
  xml += '</a:tr>';

  rows.forEach(function (row, ri) {
    xml += '<a:tr h="' + rowH + '">';
    columns.forEach(function (_, ci) {
      xml += tdCell(row[ci] == null ? '' : row[ci], {
        fill: ri % 2 ? TD.band : TD.paper,
        sz: 1200,
        algn: algn[ci],
        b: algn[ci] === 'l'
      });
    });
    xml += '</a:tr>';
  });
  xml += '</a:tbl>';

  return '<p:graphicFrame><p:nvGraphicFramePr>' +
    '<p:cNvPr id="' + id + '" name="Table ' + id + '"/>' +
    '<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/>' +
    '</p:nvGraphicFramePr>' +
    '<p:xfrm><a:off x="' + x + '" y="' + y + '"/><a:ext cx="' + cx + '" cy="' + (headH + rowH * rows.length) + '"/></p:xfrm>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
    xml + '</a:graphicData></a:graphic></p:graphicFrame>';
}

/* ---------------------------------------------------------------- slides -- */

function tdSlideXml(slide, index, total) {
  TD_SHAPE_ID.n = 1;
  var shapes = [];

  if (slide.kind === 'title') {
    shapes.push(tdRect(TD.MARGIN, 2011680, 1828800, 45720, TD.navy));
    shapes.push(tdTextBox(TD.MARGIN, 2286000, TD.CONTENT_W, 1188720,
      [tdPara(slide.title, { sz: 4000, b: true, color: TD.navy })]));
    if (slide.subtitle) {
      shapes.push(tdTextBox(TD.MARGIN, 3566160, TD.CONTENT_W, 640080,
        [tdPara(slide.subtitle, { sz: 1800, color: TD.muted })]));
    }
    if (slide.footnote) {
      shapes.push(tdTextBox(TD.MARGIN, TD.FOOT_Y, TD.CONTENT_W, TD.FOOT_H,
        [tdPara(slide.footnote, { sz: 1100, color: TD.muted })]));
    }
  } else {
    shapes.push(tdTextBox(TD.MARGIN, TD.TITLE_Y, TD.CONTENT_W, TD.TITLE_H,
      [tdPara(slide.title, { sz: 2800, b: true, color: TD.navy })]));
    shapes.push(tdRect(TD.MARGIN, TD.TITLE_Y + TD.TITLE_H - 45720, 1188720, 27432, TD.navy));
    if (slide.subtitle) {
      shapes.push(tdTextBox(TD.MARGIN, TD.SUB_Y, TD.CONTENT_W, TD.SUB_H,
        [tdPara(slide.subtitle, { sz: 1200, color: TD.muted })]));
    }

    if (slide.kind === 'table') {
      shapes.push(tdTable(TD.MARGIN, TD.BODY_Y, TD.CONTENT_W, slide.columns || [], slide.rows || [], slide.align || null));
    } else {
      var paras = (slide.bullets || []).map(function (b) {
        return tdPara(b, { sz: 1400, bullet: true, indent: true, spaceAfter: 800, color: TD.ink });
      });
      shapes.push(tdTextBox(TD.MARGIN, TD.BODY_Y, TD.CONTENT_W, TD.BODY_H, paras.length ? paras : [tdPara('')]));
    }

    if (slide.footnote) {
      shapes.push(tdTextBox(TD.MARGIN, TD.FOOT_Y, TD.CONTENT_W, TD.FOOT_H,
        [tdPara(slide.footnote, { sz: 1000, color: TD.muted, i: true })]));
    }
    shapes.push(tdTextBox(TD.W - TD.MARGIN - 914400, TD.FOOT_Y + 182880, 914400, 274320,
      [tdPara(String(index + 1) + ' / ' + total, { sz: 1000, color: TD.muted, algn: 'r' })]));
  }

  return TD_XML_DECL +
    '<p:sld ' + TD_NS_P + '><p:cSld><p:spTree>' +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    shapes.join('') +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
}

/* --------------------------------------------------------- fixed package -- */

function tdTheme() {
  var fontScheme = '<a:fontScheme name="Tyre">' +
    '<a:majorFont><a:latin typeface="' + TD.font + '"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="' + TD.font + '"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>' +
    '</a:fontScheme>';
  var fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  var line = '<a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:prstDash val="solid"/></a:ln>';
  return TD_XML_DECL +
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Tyre">' +
    '<a:themeElements>' +
    '<a:clrScheme name="Tyre">' +
    '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
    '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
    '<a:dk2><a:srgbClr val="' + TD.navy + '"/></a:dk2>' +
    '<a:lt2><a:srgbClr val="' + TD.band + '"/></a:lt2>' +
    '<a:accent1><a:srgbClr val="' + TD.navy + '"/></a:accent1>' +
    '<a:accent2><a:srgbClr val="2E6E8E"/></a:accent2>' +
    '<a:accent3><a:srgbClr val="4F7942"/></a:accent3>' +
    '<a:accent4><a:srgbClr val="B4762B"/></a:accent4>' +
    '<a:accent5><a:srgbClr val="8A5A83"/></a:accent5>' +
    '<a:accent6><a:srgbClr val="A34A3B"/></a:accent6>' +
    '<a:hlink><a:srgbClr val="0563C1"/></a:hlink>' +
    '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>' +
    '</a:clrScheme>' + fontScheme +
    '<a:fmtScheme name="Tyre">' +
    '<a:fillStyleLst>' + fill + fill + fill + '</a:fillStyleLst>' +
    '<a:lnStyleLst>' + line + line + line + '</a:lnStyleLst>' +
    '<a:effectStyleLst>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle>' +
    '</a:effectStyleLst>' +
    '<a:bgFillStyleLst>' + fill + fill + fill + '</a:bgFillStyleLst>' +
    '</a:fmtScheme></a:themeElements>' +
    '<a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';
}

function tdEmptyTree() {
  return '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>';
}

function tdMaster() {
  return TD_XML_DECL + '<p:sldMaster ' + TD_NS_P + '>' +
    '<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="' + TD.paper + '"/></a:solidFill>' +
    '<a:effectLst/></p:bgPr></p:bg>' + tdEmptyTree() + '</p:cSld>' +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
    'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
    '</p:sldMaster>';
}

function tdLayout() {
  return TD_XML_DECL + '<p:sldLayout ' + TD_NS_P + ' type="blank" preserve="1">' +
    '<p:cSld name="Blank">' + tdEmptyTree() + '</p:cSld>' +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';
}

function tdPresentation(count) {
  var ids = '';
  for (var i = 0; i < count; i++) ids += '<p:sldId id="' + (256 + i) + '" r:id="rId' + (i + 2) + '"/>';
  return TD_XML_DECL + '<p:presentation ' + TD_NS_P + ' saveSubsetFonts="1">' +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    '<p:sldIdLst>' + ids + '</p:sldIdLst>' +
    '<p:sldSz cx="' + TD.W + '" cy="' + TD.H + '"/><p:notesSz cx="' + TD.H + '" cy="' + TD.W + '"/>' +
    '</p:presentation>';
}

function tdRels(items) {
  var xml = TD_XML_DECL + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
  items.forEach(function (it) {
    xml += '<Relationship Id="' + it.id + '" Type="' + it.type + '" Target="' + it.target + '"/>';
  });
  return xml + '</Relationships>';
}

var TD_REL = {
  officeDocument: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  coreProps: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  extProps: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties',
  slideMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
  slideLayout: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
  slide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  theme: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme'
};

function tdContentTypes(count) {
  var xml = TD_XML_DECL + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>';
  for (var i = 1; i <= count; i++) {
    xml += '<Override PartName="/ppt/slides/slide' + i + '.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>';
  }
  return xml + '</Types>';
}

function tdCoreProps(model) {
  var stamp = model.generated_at || '2020-01-01T00:00:00Z';
  return TD_XML_DECL +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    '<dc:title>' + tdEsc(model.title || 'Tyre sector') + '</dc:title>' +
    '<dc:subject>Reviewed quarterly filing extracts</dc:subject>' +
    '<dcterms:created xsi:type="dcterms:W3CDTF">' + tdEsc(stamp) + '</dcterms:created>' +
    '<dcterms:modified xsi:type="dcterms:W3CDTF">' + tdEsc(stamp) + '</dcterms:modified>' +
    '</cp:coreProperties>';
}

function tdAppProps(count) {
  return TD_XML_DECL +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    '<Application>tyre-intelligence-pipeline</Application><Slides>' + count + '</Slides>' +
    '<ScaleCrop>false</ScaleCrop><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc>' +
    '<HyperlinksChanged>false</HyperlinksChanged></Properties>';
}

/* ------------------------------------------------------------------- api -- */

/**
 * Render a deck model to .pptx bytes.
 * @param {object} model  TyreCore.buildDeckModel output.
 * @returns {Uint8Array}
 */
function writePptx(model) {
  var m = model || {};
  var slides = m.slides || [];
  if (!slides.length) throw new Error('deck model has no slides');

  var entries = [
    { name: '[Content_Types].xml', data: tdContentTypes(slides.length) },
    { name: '_rels/.rels', data: tdRels([
      { id: 'rId1', type: TD_REL.officeDocument, target: 'ppt/presentation.xml' },
      { id: 'rId2', type: TD_REL.coreProps, target: 'docProps/core.xml' },
      { id: 'rId3', type: TD_REL.extProps, target: 'docProps/app.xml' }
    ]) },
    { name: 'docProps/core.xml', data: tdCoreProps(m) },
    { name: 'docProps/app.xml', data: tdAppProps(slides.length) },
    { name: 'ppt/presentation.xml', data: tdPresentation(slides.length) },
    { name: 'ppt/theme/theme1.xml', data: tdTheme() },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: tdMaster() },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: tdRels([
      { id: 'rId1', type: TD_REL.slideLayout, target: '../slideLayouts/slideLayout1.xml' },
      { id: 'rId2', type: TD_REL.theme, target: '../theme/theme1.xml' }
    ]) },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: tdLayout() },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: tdRels([
      { id: 'rId1', type: TD_REL.slideMaster, target: '../slideMasters/slideMaster1.xml' }
    ]) }
  ];

  var presRels = [{ id: 'rId1', type: TD_REL.slideMaster, target: 'slideMasters/slideMaster1.xml' }];
  slides.forEach(function (slide, i) {
    var n = i + 1;
    presRels.push({ id: 'rId' + (n + 1), type: TD_REL.slide, target: 'slides/slide' + n + '.xml' });
    entries.push({ name: 'ppt/slides/slide' + n + '.xml', data: tdSlideXml(slide, i, slides.length) });
    entries.push({ name: 'ppt/slides/_rels/slide' + n + '.xml.rels', data: tdRels([
      { id: 'rId1', type: TD_REL.slideLayout, target: '../slideLayouts/slideLayout1.xml' }
    ]) });
  });
  presRels.push({ id: 'rId' + (slides.length + 2), type: TD_REL.theme, target: 'theme/theme1.xml' });
  entries.push({ name: 'ppt/_rels/presentation.xml.rels', data: tdRels(presRels) });

  return tdZip(entries);
}

/** Convenience for callers that only hold records. */
function recordsToPptx(records, opts) {
  var core = (typeof TyreCore !== 'undefined' && TyreCore) ||
    (typeof window !== 'undefined' && window.TyreCore) ||
    (typeof globalThis !== 'undefined' && globalThis.TyreCore) || null;
  if (!core || !core.buildDeckModel) throw new Error('TyreCore.buildDeckModel is not available');
  return writePptx(core.buildDeckModel(records, opts));
}

var TyreDeck = {
  writePptx: writePptx,
  sanitizeXmlText: tdSanitize,
  recordsToPptx: recordsToPptx,
  slideXml: tdSlideXml,
  zip: tdZip,
  crc32: tdCrc32,
  escapeXml: tdEsc,
  MIME: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};

if (typeof window !== 'undefined') { window.TyreDeck = TyreDeck; }
if (typeof globalThis !== 'undefined') { globalThis.TyreDeck = TyreDeck; }
/* ==== TYRE-DECK:END ==== */
