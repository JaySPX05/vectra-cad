import type { Vec3 } from '../dxf/record';
import { add, mulS } from './ocs';

const TAU = Math.PI * 2;
const SEGS_PER_CIRCLE = 128;

function segCount(sweep: number): number {
  // the epsilon keeps counts stable when a sweep picks up float noise (e.g. after rotation)
  return Math.max(4, Math.ceil((Math.abs(sweep) / TAU) * SEGS_PER_CIRCLE - 1e-6));
}

/** Counter-clockwise arc from start to end angle (radians) in the XY plane at z. */
export function arcPoints(c: Vec3, r: number, start: number, end: number): Vec3[] {
  let sweep = end - start;
  while (sweep <= 0) sweep += TAU;
  if (sweep > TAU) sweep = TAU;
  const n = segCount(sweep);
  const out: Vec3[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const a = start + (sweep * i) / n;
    out[i] = [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a), c[2]];
  }
  return out;
}

/** Closed circle without the duplicated end point. */
export function circlePoints(c: Vec3, r: number): Vec3[] {
  const pts = arcPoints(c, r, 0, TAU);
  pts.pop();
  return pts;
}

/**
 * Polyline bulge segment: bulge = tan(theta/4), positive = counter-clockwise.
 * Returns points after p1 up to and including p2.
 */
export function bulgePoints(p1: Vec3, p2: Vec3, bulge: number): Vec3[] {
  if (Math.abs(bulge) < 1e-12) return [p2];
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-12) return [p2];
  const theta = 4 * Math.atan(bulge);
  const r = chord / (2 * Math.sin(theta / 2));
  // center lies on the chord's perpendicular bisector
  const mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
  const h = r * Math.cos(theta / 2); // signed distance from chord midpoint to center
  const cx = mx - (dy / chord) * h, cy = my + (dx / chord) * h;
  const a1 = Math.atan2(p1[1] - cy, p1[0] - cx);
  const n = segCount(theta);
  const out: Vec3[] = [];
  const rad = Math.abs(r);
  for (let i = 1; i <= n; i++) {
    const a = a1 + (theta * i) / n;
    out.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a), p1[2] + ((p2[2] - p1[2]) * i) / n]);
  }
  out[out.length - 1] = p2;
  return out;
}

/** Ellipse: p(t) = c + major*cos(t) + minor*sin(t), t in [t0, t1] (counter-clockwise). */
export function ellipsePoints(c: Vec3, major: Vec3, minor: Vec3, t0: number, t1: number): Vec3[] {
  let sweep = t1 - t0;
  while (sweep <= 1e-12) sweep += TAU;
  if (sweep > TAU + 1e-9) sweep = TAU;
  const n = segCount(sweep);
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = t0 + (sweep * i) / n;
    out.push(add(add(c, mulS(major, Math.cos(t))), mulS(minor, Math.sin(t))));
  }
  return out;
}

/** Evaluate a (rational) B-spline with de Boor's algorithm. */
export function splinePoints(degree: number, knots: number[], ctrl: Vec3[], weights?: number[]): Vec3[] {
  const n = ctrl.length;
  if (n === 0) return [];
  if (n <= degree || knots.length !== n + degree + 1) {
    return ctrl.slice(); // malformed: fall back to the control polygon
  }
  const w = weights && weights.length === n ? weights : null;
  const lo = knots[degree], hi = knots[n];
  const samples = Math.min(4000, Math.max(32, n * 24));
  const out: Vec3[] = [];
  for (let s = 0; s <= samples; s++) {
    const t = lo + ((hi - lo) * s) / samples;
    out.push(deBoor(degree, knots, ctrl, w, t));
  }
  return out;
}

function deBoor(p: number, U: number[], P: Vec3[], W: number[] | null, t: number): Vec3 {
  const n = P.length;
  let k = p;
  while (k < n - 1 && t >= U[k + 1]) k++;
  const d: number[][] = [];
  for (let j = 0; j <= p; j++) {
    const i = j + k - p;
    const wi = W ? W[i] : 1;
    d.push([P[i][0] * wi, P[i][1] * wi, P[i][2] * wi, wi]);
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = j + k - p;
      const den = U[i + p - r + 1] - U[i];
      const a = den === 0 ? 0 : (t - U[i]) / den;
      for (let c = 0; c < 4; c++) d[j][c] = (1 - a) * d[j - 1][c] + a * d[j][c];
    }
  }
  const h = d[p][3] || 1;
  return [d[p][0] / h, d[p][1] / h, d[p][2] / h];
}

/** Smooth curve through fit points (centripetal-free Catmull-Rom), used when a SPLINE has no control points. */
export function fitPointCurve(fit: Vec3[]): Vec3[] {
  if (fit.length < 3) return fit.slice();
  const out: Vec3[] = [fit[0]];
  const steps = 16;
  for (let i = 0; i < fit.length - 1; i++) {
    const p0 = fit[Math.max(0, i - 1)], p1 = fit[i], p2 = fit[i + 1], p3 = fit[Math.min(fit.length - 1, i + 2)];
    for (let s = 1; s <= steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      const f = (k: 0 | 1 | 2) =>
        0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
      out.push([f(0), f(1), f(2)]);
    }
  }
  return out;
}
