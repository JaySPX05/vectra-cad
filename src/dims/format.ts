import type { DimStyle } from './style';

/**
 * Dimension text formatting, following AutoCAD's dimension variables:
 * DIMLUNIT / DIMDEC / DIMFRAC / DIMDSEP / DIMRND / DIMZIN / DIMLFAC / DIMPOST (primary units),
 * DIMAUNIT / DIMADEC / DIMAZIN (angles), DIMALT* (alternate units) and DIMTOL / DIMLIM / DIMTP /
 * DIMTM / DIMTDEC / DIMTZIN / DIMTFAC / DIMTOLJ (tolerances). Output is MTEXT, so fractions and
 * tolerances use stacking codes (\S…;).
 */

export interface UnitOpts {
  unit: number; // 1 sci, 2 decimal, 3 engineering, 4 architectural, 5 fractional, 6 windows
  prec: number; // decimals (or fraction denominator 2^prec for arch/fractional)
  frac: number; // 0 horizontal stack, 1 diagonal, 2 not stacked
  dsep: string; // decimal separator
  rnd: number; // round to multiples of this (0 = off)
  zin: number; // zero suppression flags
}

const isFeetFormat = (u: number) => u === 3 || u === 4;

/** Round to a multiple of `rnd` (DIMRND / DIMALTRND). */
function roundTo(v: number, rnd: number): number {
  return rnd > 0 ? Math.round(v / rnd) * rnd : v;
}

/** Decimal number with leading/trailing zero suppression (bits 4 / 8) and separator. */
function decimal(v: number, prec: number, zin: number, dsep: string): string {
  let s = Math.abs(v).toFixed(Math.max(0, Math.min(8, prec)));
  if (zin & 8 && s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (zin & 4 && /^0\./.test(s)) s = s.slice(1);
  if (dsep !== '.') s = s.replace('.', dsep);
  const neg = v < 0 && Number(s.replace(dsep, '.')) !== 0;
  return (neg ? '-' : '') + s;
}

/** A fraction as text in the requested style: horizontal / diagonal stack, or inline. */
function stack(num: number, den: number, frac: number): string {
  if (frac === 2) return `${num}/${den}`;
  return `\\S${num}${frac === 1 ? '#' : '/'}${den};`;
}

/** Whole number + fraction with denominator 2^prec (architectural / fractional units). */
function fractional(v: number, prec: number, frac: number): { whole: number; text: string } {
  const den = 2 ** Math.max(0, Math.min(8, prec));
  let n = Math.round(Math.abs(v) * den);
  const whole = Math.floor(n / den);
  n -= whole * den;
  let d = den;
  while (n && n % 2 === 0 && d > 1) {
    n /= 2;
    d /= 2;
  }
  return { whole, text: n ? stack(n, d, frac) : '' };
}

/** Format a length in any AutoCAD unit format (value already multiplied by DIMLFAC/DIMALTF). */
export function formatUnits(value: number, o: UnitOpts): string {
  const v = roundTo(value, o.rnd);
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  switch (o.unit) {
    case 1: {
      // scientific: 1.2345E+01
      const [m, e] = a.toExponential(Math.max(0, Math.min(8, o.prec))).split('e');
      const exp = Number(e);
      return `${sign}${decimal(Number(m), o.prec, o.zin & 8, o.dsep)}E${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
    }
    case 3:
    case 4: {
      // engineering 1'-6.50"  /  architectural 1'-6 1/2"  (drawing unit = inch)
      let feet = Math.floor(a / 12);
      let inches = a - feet * 12;
      let inchText: string;
      if (o.unit === 3) {
        inchText = decimal(inches, o.prec, o.zin & 8, o.dsep);
        if (Number(inchText.replace(o.dsep, '.')) >= 12) {
          feet++;
          inches = 0;
          inchText = decimal(0, o.prec, o.zin & 8, o.dsep);
        }
      } else {
        const f = fractional(inches, o.prec, o.frac);
        let whole = f.whole;
        if (whole >= 12) {
          feet++;
          whole -= 12;
        }
        inches = whole + (f.text ? 0.5 : 0);
        inchText = f.text ? (whole ? `${whole} ${f.text}` : f.text) : String(whole);
      }
      // DIMZIN low bits: 0 suppress 0 ft and 0 in; 1 include both; 2 include 0 ft; 3 include 0 in
      const mode = o.zin & 3;
      const zeroFeet = feet === 0;
      const zeroInches = Number(inches) === 0 && (o.unit === 4 ? !inchText.includes('\\S') && !inchText.includes('/') : true);
      const showFeet = !zeroFeet || mode === 1 || mode === 2;
      const showInches = !zeroInches || mode === 1 || mode === 3 || !showFeet;
      const parts: string[] = [];
      if (showFeet) parts.push(`${feet}'`);
      if (showInches) parts.push(`${inchText}"`);
      return sign + parts.join('-');
    }
    case 5: {
      const f = fractional(a, o.prec, o.frac);
      if (!f.text) return sign + String(f.whole);
      return sign + (f.whole ? `${f.whole} ${f.text}` : f.text);
    }
    default:
      return decimal(v, o.prec, o.zin, o.dsep);
  }
}

const sepOf = (st: DimStyle) => String.fromCharCode(Number(st.v.DIMDSEP) || 46);

function primaryOpts(st: DimStyle): UnitOpts {
  return {
    unit: Number(st.v.DIMLUNIT) || 2, prec: st.dec, frac: Number(st.v.DIMFRAC) || 0,
    dsep: sepOf(st), rnd: Number(st.v.DIMRND) || 0, zin: st.zin,
  };
}

function altOpts(st: DimStyle, tolerance = false): UnitOpts {
  return {
    unit: Number(st.v.DIMALTU) || 2, prec: Number(tolerance ? st.v.DIMALTTD : st.v.DIMALTD) || 0,
    frac: Number(st.v.DIMFRAC) || 0, dsep: sepOf(st), rnd: tolerance ? 0 : Number(st.v.DIMALTRND) || 0,
    zin: Number(tolerance ? st.v.DIMALTTZ : st.v.DIMALTZ) || 0,
  };
}

/** Linear value in primary units (DIMLFAC applied). */
export function formatLinear(value: number, st: DimStyle): string {
  return formatUnits(value * st.lfac, primaryOpts(st));
}

/** Angle (radians) in DIMAUNIT format with DIMADEC / DIMAZIN. */
export function formatAngle(rad: number, st: DimStyle): string {
  const unit = Number(st.v.DIMAUNIT) || 0;
  const zin = st.azin;
  const dz = (v: number, p: number) => decimal(v, p, (zin & 1 ? 4 : 0) | (zin & 2 ? 8 : 0), sepOf(st));
  const deg = (rad * 180) / Math.PI;
  switch (unit) {
    case 1: {
      // degrees/minutes/seconds; precision 0 = d, 1-2 = d m, 3-4 = d m s, more = decimal seconds
      const p = st.adec;
      const a = Math.abs(deg);
      if (p === 0) return `${Math.round(a)}%%d`;
      if (p <= 2) {
        let d = Math.floor(a), m = Math.round((a - d) * 60);
        if (m === 60) { d++; m = 0; }
        return `${deg < 0 ? '-' : ''}${d}%%d${m}'`;
      }
      const sp = Math.max(0, p - 4);
      let d = Math.floor(a);
      let m = Math.floor((a - d) * 60);
      let s = +((((a - d) * 60 - m) * 60).toFixed(sp));
      if (s >= 60) { s = 0; m++; }
      if (m >= 60) { m = 0; d++; }
      return `${deg < 0 ? '-' : ''}${d}%%d${m}'${s.toFixed(sp)}"`;
    }
    case 2:
      return dz((rad * 200) / Math.PI, st.adec) + 'g';
    case 3:
      return dz(rad, st.adec) + 'r';
    default:
      return dz(deg, st.adec) + '%%d';
  }
}

/** Tolerance part (after the value) in MTEXT, or '' when tolerances are off. */
function tolerance(st: DimStyle, fmt: (v: number) => string): string {
  if (!Number(st.v.DIMTOL) || Number(st.v.DIMLIM)) return '';
  const tp = Number(st.v.DIMTP) || 0, tm = Number(st.v.DIMTM) || 0;
  const tfac = Number(st.v.DIMTFAC) || 1;
  if (Math.abs(tp - tm) < 1e-12) return tp ? `%%p${fmt(tp)}` : ''; // symmetrical
  // deviation: stacked +upper over -lower, aligned per DIMTOLJ, sized by DIMTFAC
  const up = (tp >= 0 ? '+' : '') + fmt(tp);
  const lo = tm === 0 ? fmt(0) : (tm > 0 ? '-' : '+') + fmt(Math.abs(tm));
  return `{\\H${tfac}x;\\A${Number(st.v.DIMTOLJ) || 0};\\S${up}^${lo};}`;
}

/**
 * The full measurement text: limits or value + tolerance, DIMPOST, then alternate units.
 * `kind` picks linear or angular formatting; `prefix` is R / %%c for radius and diameter.
 */
export function measurementText(value: number, kind: 'linear' | 'angular', st: DimStyle, prefix = ''): { primary: string; alt: string } {
  const linear = kind === 'linear';
  const tdec = Number(st.v.DIMTDEC);
  const tolFmt = (v: number) =>
    linear ? formatUnits(v * st.lfac, { ...primaryOpts(st), prec: Number.isFinite(tdec) ? tdec : st.dec, rnd: 0, zin: Number(st.v.DIMTZIN) || 0 })
      : formatAngle((v * Math.PI) / 180, { ...st, adec: Number.isFinite(tdec) ? tdec : st.adec });
  const fmt = (v: number) => (linear ? formatLinear(v, st) : formatAngle(v, st));
  let primary: string;
  if (Number(st.v.DIMLIM)) {
    // limits: upper over lower
    const tp = Number(st.v.DIMTP) || 0, tm = Number(st.v.DIMTM) || 0;
    const conv = linear ? (x: number) => x : (x: number) => (x * Math.PI) / 180;
    const tfac = Number(st.v.DIMTFAC) || 1;
    primary = `{\\H${tfac}x;\\S${fmt(value + conv(tp))}^${fmt(value - conv(tm))};}`;
  } else primary = fmt(value) + tolerance(st, tolFmt);
  primary = prefix + primary;
  const post = String(st.v.DIMPOST ?? '');
  if (post) primary = post.includes('<>') ? post.replace('<>', primary) : primary + post;

  let alt = '';
  if (linear && Number(st.v.DIMALT)) {
    const f = Number(st.v.DIMALTF) || 1;
    let a = formatUnits(value * st.lfac * f, altOpts(st));
    if (Number(st.v.DIMTOL) && !Number(st.v.DIMLIM)) {
      a += tolerance(st, (v) => formatUnits(v * st.lfac * f, altOpts(st, true)));
    }
    a = prefix + a;
    const apost = String(st.v.DIMAPOST ?? '');
    const below = apost.startsWith('\\X');
    const ap = below ? apost.slice(2) : apost;
    a = ap ? (ap.includes('[]') ? ap.replace('[]', a) : a + ap) : `[${a}]`;
    alt = below ? `\\X${a}` : ` ${a}`;
  }
  return { primary, alt };
}

/**
 * Final label: text override (group 1), where "<>" stands for the measurement and "[]" for the
 * alternate value; "" means the measurement alone and " " means no text.
 */
export function dimLabel(value: number, kind: 'linear' | 'angular', st: DimStyle, override: string | undefined, prefix = ''): string {
  const { primary, alt } = measurementText(value, kind, st, prefix);
  if (override === undefined || override === '') return primary + alt;
  if (override === ' ') return '';
  let s = override.replace('<>', primary);
  if (alt) s = s.includes('[]') ? s.replace('[]', alt.trim().replace(/^\\X/, '')) : s + (override.includes('<>') ? alt : '');
  return s;
}

/** Compatibility helper: apply DIMPOST and a text override to an already formatted value. */
export function labelText(measured: string, override: string | undefined, st: DimStyle, prefix = ''): string {
  let m = prefix + measured;
  if (st.post) m = st.post.includes('<>') ? st.post.replace('<>', m) : m + st.post;
  if (override === undefined || override === '') return m;
  if (override === ' ') return '';
  return override.replace('<>', m);
}

export { isFeetFormat };
