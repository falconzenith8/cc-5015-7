// Minimal 3D vector algebra. Vectors are plain [x, y, z] arrays.

export const v = (x = 0, y = 0, z = 0) => [x, y, z];
export const clone = (a) => [a[0], a[1], a[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a) => Math.hypot(a[0], a[1], a[2]);
export const lengthSq = (a) => dot(a, a);
export const distance = (a, b) => length(sub(a, b));

export function normalize(a) {
  const l = length(a);
  if (l < 1e-14) return [0, 0, 0];
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function safeNormalize(a, fallback) {
  const n = normalize(a);
  if (length(n) < 1e-12) {
    if (!fallback) throw new Error('Cannot normalize zero-length vector without fallback');
    return clone(fallback);
  }
  return n;
}

export const lerp = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

// Gram-Schmidt: remove component of n along t, re-normalize.
export function projectPerpendicular(n, t) {
  const d = dot(n, t);
  const r = [n[0] - d * t[0], n[1] - d * t[1], n[2] - d * t[2]];
  return normalize(r);
}

export const EPS = 1e-9;
