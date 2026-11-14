// Adaptive path sampling.
//
// Uniform parameter sampling is deliberately avoided: subdivision is driven by
// geometric error (chord deviation) and tangent turn (curvature action), so sharp
// bends receive as many stations as they need. Sharp corner knots are always kept.
import { sub, distance, dot, length, normalize } from './vec3.js';

const DEG = Math.PI / 180;

export function defaultToleranceOptions(curve) {
  const L = curve.arcLength(2000) || 1;
  return {
    chordTolerance: L / 1000,       // max distance of true curve from sampled chord
    maxTurnAngle: 6 * DEG,          // max tangent change across one segment
    minSegmentLength: L / 10000,    // refinement floor (prevents infinite recursion)
    maxSegmentLength: L / 12,       // refinement trigger on near-straight long stretches
    maxDepth: 14,
  };
}

function angleBetween(a, b) {
  const c = Math.min(1, Math.max(-1, dot(normalize(a), normalize(b))));
  return Math.acos(c);
}

export function sampleAdaptive(curve, options = {}) {
  const opts = { ...defaultToleranceOptions(curve), ...options };
  const warnings = [];

  // Split the parameter domain at every sharp corner knot so they survive exactly.
  const cornerKnots = curve.corners();
  const cornerByU = new Map();
  for (const c of cornerKnots) cornerByU.set(c.u, c);
  const bounds = [0, ...cornerKnots.map((c) => c.u), 1];

  const stations = [];

  function pushStation(u, forcedCorner) {
    const position = curve.point(u);
    const corner = forcedCorner || cornerByU.get(u) || null;
    let tangent;
    if (corner) {
      // Right-side tangent; tangentIn is preserved on the corner record for the frame builder.
      tangent = corner.tangentOut;
    } else {
      tangent = curve.tangent(u);
    }
    stations.push({
      u,
      position,
      tangent,
      tangentIn: corner ? corner.tangentIn : tangent,
      curvature: corner ? Infinity : curve.curvature(u),
      corner,
    });
  }

  pushStation(0, curve.closed && cornerByU.has(0) ? cornerByU.get(0) : null);

  function pointToChordDeviation(p, pa, chordVec, chordLen) {
    if (chordLen <= 1e-14) return distance(p, pa);
    const w = sub(p, pa);
    const along = dot(w, chordVec) / chordLen;
    const clamped = Math.min(Math.max(along, 0), chordLen);
    const foot = [pa[0] + (chordVec[0] / chordLen) * clamped,
      pa[1] + (chordVec[1] / chordLen) * clamped,
      pa[2] + (chordVec[2] / chordLen) * clamped];
    return distance(p, foot);
  }

  function refine(ua, ub, pa, pb, ta, tb, depth, boundedByCorner) {
    const um = (ua + ub) / 2;
    const pm = curve.point(um);
    const chordVec = sub(pb, pa);
    const chordLen = length(chordVec);

    // Probe several interior parameters, not just the midpoint: a periodic curve with
    // an integer number of cycles (e.g. a full-turn helix) can pass through the chord
    // midpoint exactly while swinging far away from the chord elsewhere.
    const probes = [0.25, 0.5, 0.75];
    let deviation = 0;
    for (const frac of probes) {
      const p = curve.point(ua + (ub - ua) * frac);
      deviation = Math.max(deviation, pointToChordDeviation(p, pa, chordVec, chordLen));
    }

    // Inside a polyline segment the tangent is constant, so tangent turn only carries
    // meaning on smooth curves; corner turn is captured exactly by the corner knot.
    const turn = boundedByCorner ? 0 : angleBetween(ta, tb);
    const errorOK = deviation <= opts.chordTolerance && turn <= opts.maxTurnAngle;
    const lengthOK = chordLen <= opts.maxSegmentLength;
    const atDepthFloor = depth >= opts.maxDepth;
    const atLengthFloor = chordLen <= opts.minSegmentLength && chordLen > 1e-14;
    // A zero-length chord with error/turn means the interval wraps a closed seam:
    // it must never be accepted, only the depth floor can stop refinement.
    const atFloor = atDepthFloor || (atLengthFloor && errorOK);

    if ((errorOK && lengthOK) || atFloor) {
      if (!errorOK || !lengthOK) {
        // Stopped by the refinement floor while geometric error remains: fidelity warning.
        warnings.push({
          type: 'fidelity_limit',
          u: ub,
          deviation,
          chordTolerance: opts.chordTolerance,
          turn,
          maxTurnAngle: opts.maxTurnAngle,
          reason: depth >= opts.maxDepth ? 'max_depth' : 'min_segment_length',
        });
      }
      pushStation(ub);
      return;
    }

    const tm = curve.tangent(um);
    refine(ua, um, pa, pm, ta, tm, depth + 1, boundedByCorner);
    refine(um, ub, pm, pb, tm, tb, depth + 1, boundedByCorner);
  }

  for (let k = 0; k < bounds.length - 1; k++) {
    const ua = bounds[k];
    const ub = bounds[k + 1];
    if (ub - ua < 1e-15) continue;
    const hasCorner = cornerByU.has(ua) || cornerByU.has(ub);
    const pa = curve.point(ua);
    const pb = curve.point(ub);
    const ta = cornerByU.has(ua) ? cornerByU.get(ua).tangentOut : curve.tangent(ua);
    const tb = cornerByU.has(ub) ? cornerByU.get(ub).tangentOut : curve.tangent(ub);
    refine(ua, ub, pa, pb, ta, tb, 0, hasCorner);
  }

  // Closed curve: u=1 duplicates u=0 spatially; keep the seam at u=0 only.
  let closedSeam = null;
  if (curve.closed) {
    const last = stations[stations.length - 1];
    if (Math.abs(last.u - 1) < 1e-12 && distance(last.position, stations[0].position) < 1e-9) {
      stations.pop();
    }
    closedSeam = { u: 0, index: 0 };
  }

  // Cumulative chord arc length.
  let s = 0;
  for (let i = 0; i < stations.length; i++) {
    if (i > 0) s += distance(stations[i].position, stations[i - 1].position);
    stations[i].s = s;
  }
  const totalLength = s + (curve.closed
    ? distance(stations[0].position, stations[stations.length - 1].position)
    : 0);

  // Coalesce potentially thousands of identical floor-hit warnings into one record per
  // reason carrying the worst observed deviation and the occurrence count.
  const merged = new Map();
  for (const w of warnings) {
    const key = w.type + ':' + w.reason;
    const existing = merged.get(key);
    if (!existing) merged.set(key, { ...w, count: 1 });
    else {
      existing.count++;
      existing.deviation = Math.max(existing.deviation, w.deviation);
      existing.turn = Math.max(existing.turn, w.turn);
      existing.u = w.u;
    }
  }
  const summaryWarnings = [...merged.values()];

  return {
    stations,
    closed: curve.closed,
    totalLength,
    options: opts,
    warnings: summaryWarnings,
    closedSeam,
  };
}
