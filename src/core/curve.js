// Parametric space paths. All curves share domain u in [0, 1].
// Each curve implements point(u), tangent(u), curvature(u) and serialization.
import { v, sub, add, scale, normalize, cross, dot, length, safeNormalize } from './vec3.js';

class Curve {
  constructor(closed = false) {
    this.closed = closed;
  }

  // Sharp vertices of this curve, if any. Entry:
  // { u, position, tangentIn, tangentOut, turnAngle }
  corners() {
    return [];
  }

  // Arc length, measured numerically for generic curves; overridden when analytic.
  arcLength(samples = 500) {
    let total = 0;
    let prev = this.point(0);
    for (let i = 1; i <= samples; i++) {
      const cur = this.point(i / samples);
      total += length(sub(cur, prev));
      prev = cur;
    }
    return total;
  }

  toJSON() {
    return { type: this.type, closed: this.closed, params: this.params };
  }
}

export class LineCurve extends Curve {
  constructor(a, b) {
    super(false);
    this.type = 'line';
    this.a = a;
    this.b = b;
    this._t = normalize(sub(b, a));
    this.params = { a, b };
  }
  point(u) {
    return add(this.a, scale(sub(this.b, this.a), u));
  }
  tangent() {
    return this._t;
  }
  curvature() {
    return 0;
  }
  arcLength() {
    return length(sub(this.b, this.a));
  }
}

export class CircleCurve extends Curve {
  // Full circle in the plane spanned by e1, e2 through center, with normal e1 x e2.
  constructor(center, radius, e1, e2) {
    super(true);
    this.type = 'circle';
    this.center = center;
    this.radius = radius;
    this.e1 = normalize(e1);
    this.e2 = normalize(e2);
    this.params = { center, radius, e1, e2 };
  }
  point(u) {
    const th = 2 * Math.PI * u;
    return add(
      this.center,
      add(scale(this.e1, this.radius * Math.cos(th)), scale(this.e2, this.radius * Math.sin(th)))
    );
  }
  tangent(u) {
    const th = 2 * Math.PI * u;
    return normalize(add(scale(this.e1, -Math.sin(th)), scale(this.e2, Math.cos(th))));
  }
  curvature() {
    return 1 / this.radius;
  }
  arcLength() {
    return 2 * Math.PI * this.radius;
  }
}

export class HelixCurve extends Curve {
  // radius r, turns n, total rise h, around axis e3 through center; e1/e2 span the plane.
  constructor(center, r, turns, rise, e1, e2, e3) {
    super(false);
    this.type = 'helix';
    this.center = center;
    this.r = r;
    this.turns = turns;
    this.rise = rise;
    this.e1 = normalize(e1);
    this.e2 = normalize(e2);
    this.e3 = normalize(e3);
    this._b = rise / (2 * Math.PI * turns); // dz per radian
    this.params = { center, r, turns, rise, e1, e2, e3 };
  }
  point(u) {
    const th = 2 * Math.PI * this.turns * u;
    return add(
      this.center,
      add(
        add(scale(this.e1, this.r * Math.cos(th)), scale(this.e2, this.r * Math.sin(th))),
        scale(this.e3, this.rise * u)
      )
    );
  }
  tangent(u) {
    const th = 2 * Math.PI * this.turns * u;
    return safeNormalize(
      add(
        add(scale(this.e1, -this.r * Math.sin(th)), scale(this.e2, this.r * Math.cos(th))),
        scale(this.e3, this._b)
      )
    );
  }
  curvature() {
    return this.r / (this.r * this.r + this._b * this._b);
  }
  // Exact analytic arc length: integral of sqrt((r)^2 + (b)^2) dtheta over all turns.
  arcLength() {
    const totalAngle = 2 * Math.PI * this.turns;
    return totalAngle * Math.sqrt(this.r * this.r + this._b * this._b);
  }
}

export class PolylineCurve extends Curve {
  // Open or closed polyline through the given points. Arc-length parameterization.
  constructor(points, closed = false) {
    super(closed);
    if (points.length < 2) throw new Error('Polyline needs at least 2 points');
    this.type = 'polyline';
    this.points = points.map((p) => [...p]);
    const n = points.length;
    const segCount = closed ? n : n - 1;
    const segLen = [];
    let total = 0;
    for (let i = 0; i < segCount; i++) {
      const d = length(sub(points[(i + 1) % n], points[i]));
      if (d < 1e-12) throw new Error('Polyline contains duplicate consecutive points');
      segLen.push(d);
      total += d;
    }
    this.segLen = segLen;
    this.totalLen = total;
    this.params = { points, closed };
  }

  _locate(u) {
    const target = Math.min(Math.max(u, 0), 1) * this.totalLen;
    let acc = 0;
    for (let i = 0; i < this.segLen.length; i++) {
      if (acc + this.segLen[i] >= target - 1e-12 || i === this.segLen.length - 1) {
        const local = this.segLen[i] > 0 ? (target - acc) / this.segLen[i] : 0;
        return { i, local: Math.min(Math.max(local, 0), 1) };
      }
      acc += this.segLen[i];
    }
    return { i: this.segLen.length - 1, local: 1 };
  }

  point(u) {
    const { i, local } = this._locate(u);
    const n = this.points.length;
    return add(this.points[i], scale(sub(this.points[(i + 1) % n], this.points[i]), local));
  }

  tangent(u) {
    const { i } = this._locate(u);
    const n = this.points.length;
    return normalize(sub(this.points[(i + 1) % n], this.points[i]));
  }

  curvature() {
    return 0; // curvature concentrates at corner knots, reported via corners()
  }

  arcLength() {
    return this.totalLen;
  }

  corners() {
    const n = this.points.length;
    const knotCount = this.closed ? n : n - 1; // internal corner knots
    const out = [];
    let acc = 0;
    for (let k = 1; k < knotCount; k++) {
      const i = k - 1;
      const tIn = normalize(sub(this.points[k], this.points[i]));
      const tOut = normalize(sub(this.points[(k + 1) % n], this.points[k]));
      const cosA = Math.min(1, Math.max(-1, dot(tIn, tOut)));
      acc += this.segLen[i];
      out.push({
        u: acc / this.totalLen,
        position: [...this.points[k]],
        tangentIn: tIn,
        tangentOut: tOut,
        turnAngle: Math.acos(cosA),
      });
    }
    return out;
  }
}

// Numerical curvature for arbitrary curves: |T'| / |r'| using central differences.
export function numericalCurvature(curve, u) {
  const h = 1e-4;
  const u0 = Math.max(0, u - h);
  const u1 = Math.min(1, u + h);
  const p0 = curve.point(u0);
  const p1 = curve.point(u1);
  const d = sub(p1, p0);
  const dl = length(d);
  if (dl < 1e-12) return 0;
  const t0 = curve.tangent(u0);
  const t1 = curve.tangent(u1);
  return length(sub(t1, t0)) / dl;
}

export function createCurve(spec) {
  const p = spec.params;
  switch (spec.type) {
    case 'line':
      return new LineCurve(p.a, p.b);
    case 'circle':
      return new CircleCurve(p.center, p.radius, p.e1, p.e2);
    case 'helix':
      return new HelixCurve(p.center, p.r, p.turns, p.rise, p.e1, p.e2, p.e3);
    case 'polyline':
      return new PolylineCurve(p.points, p.closed);
    default:
      throw new Error(`Unknown curve type: ${spec.type}`);
  }
}
