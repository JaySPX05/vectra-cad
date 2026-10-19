import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDxf } from '../src/dxf/parser';
import { writeDxf } from '../src/dxf/writer';
import { decodeDxfBytes, tokenize } from '../src/dxf/tokenizer';

const root = join(__dirname, '..', 'public', 'samples');
const files = [
  ...readdirSync(root).filter((f) => f.endsWith('.dxf')).map((f) => join(root, f)),
  ...readdirSync(join(root, 'public')).filter((f) => f.endsWith('.dxf')).map((f) => join(root, 'public', f)),
];

/** Semantic group stream: comments dropped, values trimmed. */
function stream(text: string) {
  return tokenize(text)
    .filter((g) => g.code !== 999)
    .map((g) => `${g.code}|${g.value.trim()}`);
}

describe('lossless round-trip', () => {
  for (const f of files) {
    it(f.split(/[\\/]/).pop()!, () => {
      const text = decodeDxfBytes(readFileSync(f));
      const doc = parseDxf(text);
      const out = writeDxf(doc);
      const a = stream(text);
      const b = stream(out);
      // Pre-2007 files: non-ASCII is re-encoded as \U+XXXX; compare after normalising that.
      const norm = (s: string) => s.replace(/\\U\+([0-9A-F]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
      expect(b.map(norm)).toEqual(a.map(norm));
      // Re-parsing our own output is stable.
      expect(writeDxf(parseDxf(out))).toBe(out);
    });
  }
});
