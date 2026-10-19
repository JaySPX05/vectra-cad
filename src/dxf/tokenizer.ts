import type { Group } from './groups';

const BINARY_SENTINEL = 'AutoCAD Binary DXF';

export class DxfFormatError extends Error {}

/** Map $DWGCODEPAGE values to WHATWG encoding labels (pre-R2007 files are ANSI, not UTF-8). */
const CODEPAGES: Record<string, string> = {
  ANSI_874: 'windows-874', ANSI_932: 'shift_jis', ANSI_936: 'gbk', ANSI_949: 'euc-kr',
  ANSI_950: 'big5', ANSI_1250: 'windows-1250', ANSI_1251: 'windows-1251',
  ANSI_1252: 'windows-1252', ANSI_1253: 'windows-1253', ANSI_1254: 'windows-1254',
  ANSI_1255: 'windows-1255', ANSI_1256: 'windows-1256', ANSI_1257: 'windows-1257',
  ANSI_1258: 'windows-1258',
};

/** Decode file bytes to text. UTF-8 first (R2007+), else the header's ANSI code page. */
export function decodeDxfBytes(bytes: Uint8Array): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 22));
  if (head.startsWith(BINARY_SENTINEL)) {
    throw new DxfFormatError('Binary DXF is not supported yet; save the drawing as ASCII DXF.');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    const latin = new TextDecoder('latin1').decode(bytes.subarray(0, 64 * 1024));
    const m = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n([^\r\n]+)/i.exec(latin);
    const label = (m && CODEPAGES[m[1].trim().toUpperCase()]) || 'windows-1252';
    return new TextDecoder(label).decode(bytes);
  }
}

/** Split DXF text into group pairs. Codes are trimmed; values keep everything but the line break. */
export function tokenize(text: string): Group[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r\n|\r|\n/);
  // Trailing empty line after the final EOF is normal.
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length % 2 !== 0) {
    // Tolerate a dangling line only if the file already ended at EOF.
    lines.pop();
  }
  const out: Group[] = new Array(lines.length / 2);
  for (let i = 0, j = 0; i < lines.length; i += 2, j++) {
    const codeText = lines[i].trim();
    const code = Number(codeText);
    if (!Number.isInteger(code) || codeText === '') {
      throw new DxfFormatError(`Invalid group code "${lines[i]}" at line ${i + 1}`);
    }
    out[j] = { code, value: lines[i + 1] };
  }
  return out;
}
