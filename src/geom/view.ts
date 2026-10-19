import type { Vec3 } from '../dxf/record';
import type { DxfDocument } from '../model/database';
import { cross, dot, type Mat, norm } from './ocs';

/**
 * Parallel (orthographic) views. A view is a rotation taking WCS to camera space:
 * camera x = screen right, y = screen up, z = toward the viewer. Because the projection
 * is affine, all 2D drawing, picking and extents logic can run on the projected geometry.
 */

export const TOP: Vec3 = [0, 0, 1];

/** AutoCAD's preset view directions (from the target toward the eye). */
export const PRESET_VIEWS: { name: string; dir: Vec3 }[] = [
  { name: 'Top', dir: [0, 0, 1] },
  { name: 'Bottom', dir: [0, 0, -1] },
  { name: 'Front', dir: [0, -1, 0] },
  { name: 'Back', dir: [0, 1, 0] },
  { name: 'Left', dir: [-1, 0, 0] },
  { name: 'Right', dir: [1, 0, 0] },
  { name: 'SW Isometric', dir: [-1, -1, 1] },
  { name: 'SE Isometric', dir: [1, -1, 1] },
  { name: 'NE Isometric', dir: [1, 1, 1] },
  { name: 'NW Isometric', dir: [-1, 1, 1] },
];

/** World -> camera rotation (rows are the camera axes), with optional twist about the view axis. */
export function viewRotation(dir: Vec3, twist = 0): Mat {
  const z = norm(dir);
  let x: Vec3;
  if (Math.abs(z[0]) < 1e-9 && Math.abs(z[1]) < 1e-9) x = [1, 0, 0];
  else x = norm(cross([0, 0, 1], z));
  let y = cross(z, x);
  if (twist) {
    const c = Math.cos(twist), s = Math.sin(twist);
    const nx: Vec3 = [x[0] * c + y[0] * s, x[1] * c + y[1] * s, x[2] * c + y[2] * s];
    y = cross(z, nx);
    x = nx;
  }
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0];
}

export function isTopView(rot: Mat): boolean {
  return rot[0] === 1 && rot[5] === 1 && rot[10] === 1 && rot[1] === 0 && rot[4] === 0;
}

/** The view direction (camera z axis in WCS). */
export function viewDir(rot: Mat): Vec3 {
  return [rot[8], rot[9], rot[10]];
}

/** Camera coordinates of a world point. */
export function project(rot: Mat, p: Vec3): Vec3 {
  return [
    rot[0] * p[0] + rot[1] * p[1] + rot[2] * p[2],
    rot[4] * p[0] + rot[5] * p[1] + rot[6] * p[2],
    rot[8] * p[0] + rot[9] * p[1] + rot[10] * p[2],
  ];
}

/** World point for camera coordinates (rotation is orthonormal, so the inverse is the transpose). */
export function unproject(rot: Mat, c: Vec3): Vec3 {
  return [
    rot[0] * c[0] + rot[4] * c[1] + rot[8] * c[2],
    rot[1] * c[0] + rot[5] * c[1] + rot[9] * c[2],
    rot[2] * c[0] + rot[6] * c[1] + rot[10] * c[2],
  ];
}

/**
 * Where the view ray through camera point (cx, cy) meets the plane Z = z.
 * Null when the view is (nearly) edge-on to that plane, e.g. front/side views.
 */
export function rayToPlaneZ(rot: Mat, cx: number, cy: number, z: number): Vec3 | null {
  const d = viewDir(rot);
  if (Math.abs(d[2]) < 0.02) return null;
  const p0 = unproject(rot, [cx, cy, 0]);
  const t = (z - p0[2]) / d[2];
  return [p0[0] + d[0] * t, p0[1] + d[1] * t, z];
}

/** Orbit: yaw about world Z and change elevation, clamped short of the poles. */
export function orbitDir(dir: Vec3, dYaw: number, dPitch: number): Vec3 {
  const d = norm(dir);
  let yaw = Math.atan2(d[1], d[0]);
  let pitch = Math.asin(Math.max(-1, Math.min(1, d[2])));
  // looking straight down has no defined yaw: start from "south" like AutoCAD
  if (Math.abs(d[0]) < 1e-9 && Math.abs(d[1]) < 1e-9) yaw = -Math.PI / 2;
  yaw += dYaw;
  const lim = (89.9 * Math.PI) / 180;
  pitch = Math.max(-lim, Math.min(lim, pitch + dPitch));
  return [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)];
}

/** Saved view of the *Active viewport (16/26/36 direction, 51 twist), if any. */
export function viewFromVport(doc: DxfDocument): { dir: Vec3; twist: number } | null {
  const vp = doc.tableEntry('VPORT', '*Active');
  if (!vp || !vp.hasPoint(16)) return null;
  const dir = vp.point(16);
  if (!Number.isFinite(dir[0] + dir[1] + dir[2]) || Math.hypot(...dir) < 1e-12) return null;
  return { dir: norm(dir), twist: (vp.num(51, 0) * Math.PI) / 180 };
}

export function sameDir(a: Vec3, b: Vec3): boolean {
  return dot(norm(a), norm(b)) > 1 - 1e-9;
}

/**
 * Where the view ray through camera point (cx, cy) meets the plane through `origin` with
 * normal `n` (e.g. the UCS XY plane). Null when the view is (nearly) edge-on to the plane.
 */
export function rayToPlane(rot: Mat, cx: number, cy: number, origin: Vec3, n: Vec3): Vec3 | null {
  const d = viewDir(rot);
  const den = dot(d, n);
  if (Math.abs(den) < 0.02) return null;
  const p0 = unproject(rot, [cx, cy, 0]);
  const t = (dot(origin, n) - dot(p0, n)) / den;
  return [p0[0] + d[0] * t, p0[1] + d[1] * t, p0[2] + d[2] * t];
}
