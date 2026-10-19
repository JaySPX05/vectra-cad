import type { Vec3 } from '../dxf/record';

/** Affine 3D transform stored row-major as 3 rows x 4 columns: [m00 m01 m02 tx, m10 ... ty, m20 ... tz]. */
export type Mat = number[];

export const IDENTITY: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

export function mul(a: Mat, b: Mat): Mat {
  // result = a * b  (apply b first, then a)
  const r = new Array(12);
  for (let i = 0; i < 3; i++) {
    const a0 = a[i * 4], a1 = a[i * 4 + 1], a2 = a[i * 4 + 2], a3 = a[i * 4 + 3];
    r[i * 4] = a0 * b[0] + a1 * b[4] + a2 * b[8];
    r[i * 4 + 1] = a0 * b[1] + a1 * b[5] + a2 * b[9];
    r[i * 4 + 2] = a0 * b[2] + a1 * b[6] + a2 * b[10];
    r[i * 4 + 3] = a0 * b[3] + a1 * b[7] + a2 * b[11] + a3;
  }
  return r;
}

export function apply(m: Mat, p: Vec3 | [number, number]): Vec3 {
  const x = p[0], y = p[1], z = p[2] ?? 0;
  return [
    m[0] * x + m[1] * y + m[2] * z + m[3],
    m[4] * x + m[5] * y + m[6] * z + m[7],
    m[8] * x + m[9] * y + m[10] * z + m[11],
  ];
}
export function applyDir(m: Mat, d: Vec3): Vec3 {
  return [m[0] * d[0] + m[1] * d[1] + m[2] * d[2], m[4] * d[0] + m[5] * d[1] + m[6] * d[2], m[8] * d[0] + m[9] * d[1] + m[10] * d[2]];
}

export const translate = (x: number, y: number, z = 0): Mat => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
export const scale = (sx: number, sy: number, sz = 1): Mat => [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0];
export function rotateZ(rad: number): Mat {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0];
}

export function invert(m: Mat): Mat {
  const [a, b, c, tx, d, e, f, ty, g, h, i, tz] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-300) return IDENTITY.slice();
  const inv = [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det, 0,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det, 0,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det, 0,
  ];
  const t = applyDir(inv, [tx, ty, tz]);
  inv[3] = -t[0];
  inv[7] = -t[1];
  inv[11] = -t[2];
  return inv;
}

export function determinant2d(m: Mat): number {
  return m[0] * m[5] - m[1] * m[4];
}

// ---- vectors ---------------------------------------------------------------
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const mulS = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export function norm(a: Vec3): Vec3 {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
}

/**
 * Arbitrary Axis Algorithm (DXF Reference, "Object Coordinate Systems"):
 * derives the OCS X and Y axes from the extrusion (normal) vector N.
 */
export function ocsAxes(extrusion: Vec3): [Vec3, Vec3, Vec3] {
  const n = norm(extrusion);
  const limit = 1 / 64;
  const ax = Math.abs(n[0]) < limit && Math.abs(n[1]) < limit ? norm(cross([0, 1, 0], n)) : norm(cross([0, 0, 1], n));
  const ay = norm(cross(n, ax));
  return [ax, ay, n];
}

export function isDefaultExtrusion(e: Vec3): boolean {
  return Math.abs(e[0]) < 1e-12 && Math.abs(e[1]) < 1e-12 && e[2] > 0;
}

/** Matrix taking OCS coordinates to WCS. */
export function ocsToWcs(extrusion: Vec3): Mat {
  if (isDefaultExtrusion(extrusion)) return IDENTITY.slice();
  const [ax, ay, n] = ocsAxes(extrusion);
  return [ax[0], ay[0], n[0], 0, ax[1], ay[1], n[1], 0, ax[2], ay[2], n[2], 0];
}

export function wcsToOcs(extrusion: Vec3): Mat {
  if (isDefaultExtrusion(extrusion)) return IDENTITY.slice();
  const [ax, ay, n] = ocsAxes(extrusion);
  return [ax[0], ax[1], ax[2], 0, ay[0], ay[1], ay[2], 0, n[0], n[1], n[2], 0];
}

export const DEG = Math.PI / 180;
