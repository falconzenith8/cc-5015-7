// Cross-section profiles: closed 2D polygons in the (N, B) frame plane,
// plus size keyframes evaluated along arc-length fraction.

// ---- Primitive profile generators (counter-clockwise in the (x, y) plane) ----

export function circleProfile(radius, segments = 24) {
  const pts = [];
  for (let i = 0; i < segments; i++) {
    const a = (2 * Math.PI * i) / segments;
    pts.push([radius * Math.cos(a), radius * Math.sin(a)]);
  }
  return pts;
}

export function ellipseProfile(rx, ry, segments = 32) {
  const pts = [];
  for (let i = 0; i < segments; i++) {
    const a = (2 * Math.PI * i) / segments;
    pts.push([rx * Math.cos(a), ry * Math.sin(a)]);
  }
  return pts;
}

export function polygonProfile(radius, sides, phase = 0) {
  const pts = [];
  for (let i = 0; i < sides; i++) {
    const a = phase + (2 * Math.PI * i) / sides;
    pts.push([radius * Math.cos(a), radius * Math.sin(a)]);
  }
  return pts;
}

export function rectangleProfile(w, h) {
  const x = w / 2;
  const y = h / 2;
  return [[-x, -y], [x, -y], [x, y], [-x, y]];
}

function arc2D(cx, cy, r, a0, a1, steps, out) {
  for (let i = 1; i <= steps; i++) {
    const a = a0 + (a1 - a0) * (i / steps);
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
}

export function roundedRectProfile(w, h, r, cornerSteps = 4) {
  const x = w / 2;
  const y = h / 2;
  r = Math.min(r, x, y);
  const pts = [[-x + r, -y]];
  pts.push([x - r, -y]);
  // Each corner runs from angle a0 (exclusive) to a1 (inclusive); the a1 endpoint is the
  // next straight-edge start, so the following explicit push is skipped to avoid dupes.
  arc2D(x - r, -y + r, r, -Math.PI / 2, 0, cornerSteps, pts);
  pts.pop();
  pts.push([x, y - r]);
  arc2D(x - r, y - r, r, 0, Math.PI / 2, cornerSteps, pts);
  pts.pop();
  pts.push([-x + r, y]);
  arc2D(-x + r, y - r, r, Math.PI / 2, Math.PI, cornerSteps, pts);
  pts.pop();
  pts.push([-x, -y + r]);
  arc2D(-x + r, -y + r, r, Math.PI, 1.5 * Math.PI, cornerSteps, pts);
  pts.pop();
  return pts;
}

// Flat band: a very thin rounded rectangle, giving a genuine ribbon solid sweep.
export function ribbonProfile(width, thickness, cornerSteps = 3) {
  return roundedRectProfile(width, thickness, Math.min(thickness / 2, width / 4), cornerSteps);
}

export function createProfile(spec) {
  switch (spec.type) {
    case 'circle':
      return circleProfile(spec.radius, spec.segments ?? 24);
    case 'ellipse':
      return ellipseProfile(spec.rx, spec.ry, spec.segments ?? 32);
    case 'polygon':
      return polygonProfile(spec.radius, spec.sides, spec.phase ?? 0);
    case 'rectangle':
      return rectangleProfile(spec.width, spec.height);
    case 'roundedRect':
      return roundedRectProfile(spec.width, spec.height, spec.radius ?? 0, spec.cornerSteps ?? 4);
    case 'ribbon':
      return ribbonProfile(spec.width, spec.thickness, spec.cornerSteps ?? 3);
    case 'custom':
      return spec.points.map((p) => [...p]);
    default:
      throw new Error(`Unknown profile type: ${spec.type}`);
  }
}

// ---- 2D self-intersection (including coincident-point) detection ----

function segIntersect(p1, p2, p3, p4) {
  const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0], d2y = p4[1] - p3[1];
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-14) return null; // parallel
  const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / denom;
  const u = ((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) / denom;
  return { t, u };
}

export function profileIssues(points) {
  const issues = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
      issues.push({ type: 'invalid_point', index: i });
    }
    const q = points[(i + 1) % n];
    if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-12) {
      issues.push({ type: 'duplicate_point', index: (i + 1) % n });
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Adjacent edges share a vertex by construction; those are not self-intersections.
      if (i === j || (i === 0 && j === n - 1) || j === i + 1) continue;
      const hit = segIntersect(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n]);
      if (hit && hit.t > 1e-9 && hit.t < 1 - 1e-9 && hit.u > 1e-9 && hit.u < 1 - 1e-9) {
        issues.push({ type: 'self_intersection', edges: [i, j], t: hit.t, u: hit.u });
      }
    }
  }
  // Signed area gives winding orientation.
  let area = 0;
  for (let i = 0; i < n; i++) {
    const q = points[(i + 1) % n];
    area += points[i][0] * q[1] - q[0] * points[i][1];
  }
  return { issues, area: area / 2, ccw: area > 0 };
}

// ---- Size variation along the path ----

export function createScaleTrack(keyframes, interpolation = 'linear') {
  // keyframes: [{ u, su, sv }] sorted by u in [0,1]; u is arc-length fraction.
  const kf = [...keyframes].sort((a, b) => a.u - b.u);
  if (kf.length === 0) kf.push({ u: 0, su: 1, sv: 1 }, { u: 1, su: 1, sv: 1 });
  if (kf[0].u > 0) kf.unshift({ u: 0, ...kf[0] });
  if (kf[kf.length - 1].u < 1) kf.push({ u: 1, ...kf[kf.length - 1] });

  function smooth(t) {
    return t * t * (3 - 2 * t);
  }

  return function evaluate(u) {
    for (let i = 0; i < kf.length - 1; i++) {
      const a = kf[i];
      const b = kf[i + 1];
      if (u >= a.u && u <= b.u) {
        const span = b.u - a.u;
        let t = span < 1e-12 ? 0 : (u - a.u) / span;
        if (interpolation === 'smoothstep') t = smooth(t);
        return {
          su: a.su + (b.su - a.su) * t,
          sv: a.sv + (b.sv - a.sv) * t,
        };
      }
    }
    const last = kf[kf.length - 1];
    return { su: last.su, sv: last.sv };
  };
}

export function scaleIssues(evalScale, samples = 64) {
  const out = [];
  for (let i = 0; i <= samples; i++) {
    const { su, sv } = evalScale(i / samples);
    if (!(su > 0) || !(sv > 0)) {
      out.push({ type: 'non_positive_scale', u: i / samples, su, sv });
      break;
    }
  }
  return out;
}
