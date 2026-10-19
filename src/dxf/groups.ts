// A DXF file is a flat stream of (group code, value) pairs. The group code
// fixes the value's type; see "Group Code Value Types" in the DXF Reference.

export interface Group {
  code: number;
  /** Raw value text exactly as read (minus line terminator) so round-trips are lossless. */
  value: string;
}

export type ValueType = 'string' | 'float' | 'int' | 'bool' | 'handle' | 'binary';

export function valueType(code: number): ValueType {
  if (code >= 0 && code <= 9) return 'string';
  if (code >= 10 && code <= 59) return 'float';
  if (code >= 60 && code <= 99) return 'int';
  if (code === 100 || code === 101 || code === 102) return 'string';
  if (code === 105) return 'handle';
  if (code >= 110 && code <= 149) return 'float';
  if (code >= 160 && code <= 179) return 'int';
  if (code >= 210 && code <= 239) return 'float';
  if (code >= 270 && code <= 289) return 'int';
  if (code >= 290 && code <= 299) return 'bool';
  if (code >= 300 && code <= 309) return 'string';
  if (code >= 310 && code <= 319) return 'binary';
  if (code >= 320 && code <= 369) return 'handle';
  if (code >= 370 && code <= 389) return 'int';
  if (code >= 390 && code <= 399) return 'handle';
  if (code >= 400 && code <= 409) return 'int';
  if (code >= 410 && code <= 419) return 'string';
  if (code >= 420 && code <= 429) return 'int';
  if (code >= 430 && code <= 439) return 'string';
  if (code >= 440 && code <= 459) return 'int';
  if (code >= 460 && code <= 469) return 'float';
  if (code >= 470 && code <= 479) return 'string';
  if (code >= 480 && code <= 481) return 'handle';
  if (code === 999) return 'string';
  if (code >= 1000 && code <= 1009) return 'string';
  if (code >= 1010 && code <= 1059) return 'float';
  if (code >= 1060 && code <= 1071) return 'int';
  return 'string';
}

/** Format a number for a group of the given code (floats always carry a decimal point, like AutoCAD). */
export function formatValue(code: number, v: number | string | boolean): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? '1' : '0';
  const t = valueType(code);
  if (t === 'float') {
    if (!Number.isFinite(v)) return '0.0';
    let s = Number(v.toPrecision(15)).toString();
    if (s.includes('e')) s = v.toExponential(14).replace(/\.?0+e/, 'e');
    else if (!s.includes('.')) s += '.0';
    return s;
  }
  return String(Math.round(v));
}

export function group(code: number, v: number | string | boolean): Group {
  return { code, value: formatValue(code, v) };
}

export function cloneGroups(gs: Group[]): Group[] {
  return gs.map((x) => ({ code: x.code, value: x.value }));
}
