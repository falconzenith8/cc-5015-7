// Explainable moving frames along the sampled path.
//
// Modes:
//   'rmf'      rotation-minimizing frame via double reflection (Wang et al.).
//              Fully deterministic: parallel transport, so straight / zero-curvature
//              sections keep a constant frame instead of spinning or flipping like Frenet.
//   'fixed-up' the frame normal is the up vector projected onto the plane normal to T;
//              useful for ribbons lying in a known reference orientation.
//
// Layering:
//   transportFrames(stations, state, options)   initial frame + segment transport
//   closeFrames(frames, stations, state)        closed-loop twist residual + seam snap
//   evaluateFrames(stations, state, options)    the layered entry (strict state)
//   buildFrames(sampled, options)               compatibility adapter for curve sweep
//
// State contract. The layered entry requires an explicit state object:
//   { closed: boolean, degenerate: [{ index, u, reason, ... }] }
// It never infers `closed` from the station list, and it never substitutes a default
// tangent for a degenerate one. The legacy buildFrames entry derives the state from the
// sampler result for existing curve-sweep callers only.
import { dot, cross, normalize, projectPerpendicular, safeNormalize, add, scale, sub, lengthSq } from './vec3.js';

const REVERSAL_DOT = -0.95;

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

// Degenerate-tangent evidence is a property of the station list, not of a frame mode.
// A station tangent with (near) zero length, or a consecutive pair that folds back, is
// an explicit state item the caller must see and decide on.
export function degenerateTangents(stations) {
  const out = [];
  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    const t = st && st.tangent;
    const magnitude = t ? Math.hypot(t[0], t[1], t[2]) : 0;
    if (!(magnitude > 1e-12)) {
      out.push({ index: i, u: st ? st.u : null, reason: 'zero_tangent', magnitude });
    }
  }
  for (let i = 1; i < stations.length; i++) {
    const t0 = stations[i - 1].tangent;
    const t1 = stations[i].tangent;
    const d = dot(normalize(t0), normalize(t1));
    if (d < REVERSAL_DOT) {
      out.push({ index: i, u: stations[i].u, reason: 'tangent_reversal', tangentDot: d });
    }
  }
  return out;
}

// Initial frame plus parallel transport from station i to i+1. No closure correction.
export function transportFrames(stations, state, options = {}) {
  const mode = options.frameMode || 'rmf';
  const n = stations.length;
  const frames = [];
  const first = initialFrame(stations[0].tangentIn || stations[0].tangent, options.upVector);
  frames.push({ t: [...stations[0].tangent], n: first.n, b: first.b });

  for (let i = 1; i < n; i++) {
    const st = stations[i];
    if (mode === 'fixed-up') {
      const t = normalize(st.tangent);
      const nrm = projectPerpendicular(first.n, t);
      frames.push({ t, n: nrm, b: normalize(cross(t, nrm)) });
    } else {
      const prev = frames[i - 1];
      const r = [prev.t, prev.n, prev.b];
      const rNext = transport(r, stations[i - 1].tangent, st.tangent);
      const t = normalize(st.tangent);
      const nrm = projectPerpendicular(rNext[1], t);
      frames.push({ t, n: nrm, b: normalize(cross(t, nrm)) });
    }
  }
  return { frames, mode };
}

// Closed-loop twist consistency. The final frame is transported across the closing
// segment into the seam tangent plane and compared with the seam frame; any residual
// twist is distributed by arc length so the mesh closes without a jump.
export function closeFrames(frames, stations, state) {
  const diagnostics = [];
  let twistCorrection = null;
  const n = stations.length;
  if (!state.closed || n <= 2) return { frames, diagnostics, twistCorrection };

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
  return { frames, diagnostics, twistCorrection };
}

function frameDiagnostics(stations, degenerate) {
  const diagnostics = [];
  for (const d of degenerate) {
    if (d.reason !== 'tangent_reversal') continue;
    diagnostics.push({
      type: 'path_reversal',
      index: d.index,
      u: d.u,
      tangentDot: d.tangentDot,
      message: 'Path tangent reverses here; frame transport is degenerate and a miter/bevel rule is required.',
    });
  }
  return diagnostics;
}

// Layered entry: requires an explicit closed/degenerate state; rejects silent defaults.
export function evaluateFrames(stations, state, options = {}) {
  if (!Array.isArray(stations) || stations.length < 2) {
    throw new TypeError('evaluateFrames: stations must contain at least two entries');
  }
  if (!state || typeof state.closed !== 'boolean') {
    throw new TypeError('evaluateFrames: state.closed must be an explicit boolean');
  }
  if (!Array.isArray(state.degenerate)) {
    throw new TypeError('evaluateFrames: state.degenerate must be an explicit array');
  }
  const transported = transportFrames(stations, state, options);
  const closed = closeFrames(transported.frames, stations, state);
  const diagnostics = [...frameDiagnostics(stations, state.degenerate), ...closed.diagnostics];
  return {
    frames: closed.frames,
    mode: transported.mode,
    diagnostics,
    twistCorrection: closed.twistCorrection,
    state: { closed: state.closed, degenerate: state.degenerate, frameMode: transported.mode },
  };
}

// Compatibility adapter for existing curve-sweep callers. It builds the explicit state
// from the sampler result and preserves the historical option defaults.
export function buildFrames(sampled, options = {}) {
  const stations = sampled.stations;
  const result = evaluateFrames(stations, {
    closed: !!sampled.closed,
    degenerate: degenerateTangents(stations),
  }, options);
  return {
    frames: result.frames,
    mode: result.mode,
    diagnostics: result.diagnostics,
    twistCorrection: result.twistCorrection,
    state: result.state,
  };
}
