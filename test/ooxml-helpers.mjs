// Shared helpers for the two OOXML writers.
//
// Not named *.test.mjs on purpose: the suite's glob is test/*.test.mjs, so this is a
// library the deck and workbook tests import rather than a file the runner executes.
//
// The point of reading the package back rather than trusting the writer is that both
// formats fail the same way — a reader that meets a malformed part does not report an
// error, it opens the file and silently drops content.

import assert from 'node:assert/strict';

/** Read a stored-entry ZIP back out, the way a consumer's unzip would. */
export function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let eocd = bytes.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, 'end-of-central-directory signature is present');

  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(at, true), 0x02014b50, 'central directory header signature');
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));

    assert.equal(view.getUint32(localAt, true), 0x04034b50, `local header for ${name}`);
    const lNameLen = view.getUint16(localAt + 26, true);
    const lExtraLen = view.getUint16(localAt + 28, true);
    const start = localAt + 30 + lNameLen + lExtraLen;
    files.set(name, decoder.decode(bytes.subarray(start, start + size)));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/**
 * Well-formedness enough to catch the mistakes that actually happen here: an unescaped
 * `<` or `&` from a company name, and a tag left open.
 */
export function assertBalancedXml(name, xml) {
  // Blank the prolog and any comments first, keeping the length so every offset below
  // still lines up, then scan the masked text.
  const masked = xml.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g, (s) => ' '.repeat(s.length));
  const stack = [];
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let cursor = 0;
  let m;
  while ((m = tag.exec(masked)) !== null) {
    const text = masked.slice(cursor, m.index);
    assert.ok(
      !/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(text),
      `${name}: bare & in text near ${JSON.stringify(text.slice(0, 60))}`
    );
    assert.ok(!text.includes('<'), `${name}: bare < in text near ${JSON.stringify(text.slice(0, 60))}`);
    cursor = m.index + m[0].length;
    if (m[4] === '/') continue;
    if (m[1] === '/') {
      assert.equal(stack.pop(), m[2], `${name}: mismatched closing tag </${m[2]}>`);
    } else {
      stack.push(m[2]);
    }
  }
  assert.deepEqual(stack, [], `${name}: unclosed tags ${stack.join(', ')}`);
  assert.ok(!masked.slice(cursor).includes('<'), `${name}: bare < after the last tag`);
}

/** Every XML part in a package is balanced and escaped. */
export function assertPackageWellFormed(files) {
  for (const [name, xml] of files) {
    if (!name.endsWith('.xml') && !name.endsWith('.rels') && !name.endsWith('.vml')) continue;
    assertBalancedXml(name, xml);
  }
}

/** Every relationship target in the package resolves to a part that exists. */
export function assertRelationshipsResolve(files) {
  for (const [name, xml] of files) {
    if (!name.endsWith('.rels')) continue;
    const base = name.split('/').slice(0, -2).join('/');
    for (const [, target] of xml.matchAll(/Target="([^"]+)"/g)) {
      if (/^https?:/.test(target)) continue;
      const joined = base ? `${base}/${target}` : target;
      // Resolve ../ by hand; the package uses posix separators regardless of platform.
      const parts = [];
      for (const seg of joined.split('/')) {
        if (seg === '.' || seg === '') continue;
        if (seg === '..') parts.pop();
        else parts.push(seg);
      }
      const resolved = parts.join('/');
      assert.ok(files.has(resolved), `${name} points at ${target}, which resolves to ${resolved} and is not in the package`);
    }
  }
}

/** Every part except [Content_Types].xml itself has a declared content type. */
export function assertContentTypesCover(files) {
  const types = files.get('[Content_Types].xml');
  assert.ok(types, '[Content_Types].xml is present');
  const defaults = new Set([...types.matchAll(/Extension="([^"]+)"/g)].map((m) => m[1].toLowerCase()));
  const overrides = new Set([...types.matchAll(/PartName="\/([^"]+)"/g)].map((m) => m[1]));
  for (const name of files.keys()) {
    if (name === '[Content_Types].xml') continue;
    const ext = name.split('.').pop().toLowerCase();
    assert.ok(
      overrides.has(name) || defaults.has(ext),
      `${name} has no content type, so a reader does not know what it is`
    );
  }
}
