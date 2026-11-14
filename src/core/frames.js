// Explainable moving frames along the sampled path.
//
// Modes:
//   'rmf'      rotation-minimizing frame via double reflection (Wang et al.).
//              Fully deterministic: parallel transport, so straight / zero-curvature
//              sections keep a constant frame instead of spinning or flipping like Frenet.
//   'fixed-up' the frame normal is the up vector projected onto the plane normal to T;
//              useful for ribbons lying in a known reference orientation.
//
// Both modes are deterministic. At corners the frame is transported separately along
// the incoming and outgoing tangents; the sweep builder applies the miter/bevel rule.
import { dot, cross, normalize, projectPerpendicular, safeNormalize, add, sub, scale, lengthSq } from './vec3.js';

function reflect(v1, v2) {
  // Reflection of vector v1 across the plane through the origin with normal v2,
  // where v2 is required to be unit length: v1 - 2 (v1 . v2) v2.
  const d = dot(v1, v2);
  return [v1[0] - 2 * d * v2[0], v1[1] - 2 * d * v2[1], v1[2] - 2 * d * v2[2]];
}

function initialFrame(tangent, preferredUp) {
  const t = normalize(tangent);
  let up;
  if (preferredUp) {
    const pu = normalize(preferredUp);
    if (Math.abs(dot(pu, t)) > 0.95) {
      up = safeNormalize(cross([0, 0, 1], t), safeNormalize(cross([1, 0, 0], t), [0, 1, 0]));
    } else {
      up = projectPerpendicular(pu, t);
    }
  } else {
    const ref = Math.abs(t[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
    up = normalize(cross(t, ref)); // up ⟂ T, deterministic choice
  }
  const binormal = normalize(cross(t, up));
  return { t, n: up, b: binormal };
}

// Double-reflection parallel transport of one basis vector from tangent t_i to t_next.
// Wang et al. 2008: reflect across the plane normal to t_i, then across the plane
// normal to (t_i + t_next). The tangent row is never reflected; only N and B move.
function transportVector(vec, t_i, t_next) {
  const v1 = normalize(t_i);
  const q1 = reflect(vec, v1);
  const v2raw = add(t_next, v1);
  if (dot(v2raw, v2raw) < 1e-16) {
    // Opposite tangents: no unique transport; carry the vector over (reversal is
    // reported separately and handled by the sweep's miter/bevel rule).
    return vec;
  }
  return reflect(q1, normalize(v2raw));
}

function transport(r_i, t_i, t_next) {
  return [normalize(t_next), transportVector(r_i[1], t_i, t_next), transportVector(r_i[2], t_i, t_next)];
}

export { transportVector };

export function buildFrames(sampled, options = {}) {
  const mode = options.frameMode || 'rmf';
  const stations = sampled.stations;
  const n = stations.length;
  const frames = [];

  const first = initialFrame(stations[0].tangentIn || stations[0].tangent, options.upVector);
  frames.push({ t: [...stations[0].tangent], n: first.n, b: first.b });

  for (let i = 1; i < n; i++) {
    const st = stations[i];
    if (mode === 'fixed-up') {
      const t = normalize(st.tangent);
      const n = projectPerpendicular(first.n, t);
      frames.push({ t, n, b: normalize(cross(t, n)) });
    } else {
      const prev = frames[i - 1];
      const r = [prev.t, prev.n, prev.b];
      const rNext = transport(r, stations[i - 1].tangent, st.tangent);
      const t = normalize(st.tangent);
      const n = projectPerpendicular(rNext[1], t);
      frames.push({ t, n, b: normalize(cross(t, n)) });
    }
  }

  const diagnostics = [];

  // Flip / reversal detection: tangent reversal makes transport degenerate.
  for (let i = 1; i < n; i++) {
    const d = dot(stations[i - 1].tangent, stations[i].tangent);
    if (d < -0.95) {
      diagnostics.push({
        type: 'path_reversal',
        index: i,
        u: stations[i].u,
        tangentDot: d,
        message: 'Path tangent reverses here; frame transport is degenerate and a miter/bevel rule is required.',
      });
    }
  }

  // Closed-loop twist consistency. The final frame is transported across the closing
  // segment into the seam tangent plane and compared with the seam frame; any residual
  // twist is distributed by arc length so the mesh closes without a jump.
  let twistCorrection = null;
  if (sampled.closed && n > 2) {
    const seam = frames[0];
    const last = frames[n - 1];
    const tSeam = normalize(stations[0].tangent);
    // Signed angle of the transported last normal against the seam normal, measured
    // around the seam tangent. RMF double reflection is holonomy-free, so for RMF this
    // is only the discrete gap between the last and seam tangents; fixed-up frames can
    // carry a genuine geometric twist that must be unwound the same way.
    const nAtSeam = normalize(transportVector(last.n, stations[n - 1].tangent, tSeam));
    const cosA = Math.min(1, Math.max(-1, dot(nAtSeam, seam.n)));
    const sinA = dot(cross(nAtSeam, seam.n), tSeam);
    const residual = Math.atan2(sinA, cosA);
    // For a closed loop any nonzero residual is a seam jump; correct even tiny ones.
    if (Math.abs(residual) > 1e-12) {
      twistCorrection = { totalAngle: residual, distributed: true };
      // The bulk of the twist is unwound uniformly by arc length (frame 0 keeps its
      // orientation, the last frame takes the full angle). The rotation axis is each
      // frame's own tangent while the residual is measured in the seam tangent plane,
      // so the linear pass is approximate whenever the closing tangents differ.
      const sLast = stations[n - 1].s || 1;
      for (let i = 0; i < n; i++) {
        const phi = -residual * (stations[i].s / sLast);
        const f = frames[i];
        const n2 = add(scale(f.n, Math.cos(phi)), scale(f.b, Math.sin(phi)));
        const b2 = add(scale(f.n, -Math.sin(phi)), scale(f.b, Math.cos(phi)));
        f.n = normalize(n2);
        f.b = normalize(b2);
      }
      // Remove the remaining gap on the last frame only. The transported normal must
      // coincide with the seam normal; maximize their dot product (minimize 1 - dot)
      // over a full turn. A coarse scan brackets the best cell, then golden-section
      // search refines it. Using the dot product (not atan2) avoids angle-wrap artifacts.
      const fLast = frames[n - 1];
      const nBase = fLast.n;
      const bBase = fLast.b;
      const scoreAt = (theta) => {
        const nRot = normalize(add(scale(nBase, Math.cos(theta)), scale(bBase, Math.sin(theta))));
        const nCheck = normalize(transportVector(nRot, stations[n - 1].tangent, tSeam));
        return 1 - dot(nCheck, seam.n);
      };
      const STEPS = 96;
      const cell = (2 * Math.PI) / STEPS;
      let bestK = 0;
      let bestScore = Infinity;
      for (let k = 0; k < STEPS; k++) {
        const s = scoreAt(cell * (k + 0.5));
        if (s < bestScore) { bestScore = s; bestK = k; }
      }
      let lo = cell * bestK;
      let hi = cell * (bestK + 1);
      const GR = (Math.sqrt(5) - 1) / 2;
      let x1 = hi - GR * (hi - lo);
      let x2 = lo + GR * (hi - lo);
      let f1 = scoreAt(x1);
      let f2 = scoreAt(x2);
      for (let iter = 0; iter < 60 && hi - lo > 1e-15; iter++) {
        if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - GR * (hi - lo); f1 = scoreAt(x1); }
        else { lo = x1; x1 = x2; f1 = f2; x2 = lo + GR * (hi - lo); f2 = scoreAt(x2); }
      }
      const theta = (lo + hi) / 2;
      // Any theta + 2*pi*k is an equivalent closure; keep the smallest-magnitude one
      // so the last frame does not accumulate a gratuitous full turn.
      const thetaMin = theta - 2 * Math.PI * Math.round(theta / (2 * Math.PI));
      fLast.n = normalize(add(scale(nBase, Math.cos(thetaMin)), scale(bBase, Math.sin(thetaMin))));
      fLast.b = normalize(add(scale(nBase, -Math.sin(thetaMin)), scale(bBase, Math.cos(thetaMin))));
      twistCorrection.totalAngle = residual + thetaMin;
      // Verify seam identity in the seam tangent plane: the last normal is transported
      // across the closing segment before comparing with the seam normal.
      const nFinal = normalize(transportVector(frames[n - 1].n, stations[n - 1].tangent, tSeam));
      const errN = lengthSq(sub(nFinal, frames[0].n));
      if (errN > 1e-14) {
        diagnostics.push({ type: 'closure_mismatch', normalError: Math.sqrt(errN) });
      }
    }
  }

  return { frames, mode, diagnostics, twistCorrection };
}
