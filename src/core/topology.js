// Mesh connection: ring vertex emission, quad-band stitching, end caps, and the
// connectivity evidence used to prove the result is a genuine swept surface.
//
// Contract:
//   emitRingVertices(mesh, ring, points) -> writes m vertices, returns the start index
//   stitchRings(mesh, fromRing, toRing, m, points, rings) -> appends 2*m triangles
//   capRing(mesh, ringIndex, m, center, outwardNormal)    -> appends m fan triangles
//   edgeConnectivity(mesh) -> { edgeCount, boundary, nonManifold, sharedTwice,
//                               consistent, inconsistent }
//
// `consistent` counts undirected edges whose two incident triangles traverse the edge in
// opposite directions (coherent winding). `inconsistent` counts edges that are shared by
// two triangles but traversed the same way — a winding contradiction, even though the
// edge count may still look watertight. Callers must not equate "watertight" with
// "consistently oriented".
import { normalize, cross, dot, add, sub, scale } from './vec3.js';

export const ringIndex = (ringCount, ring, j, m) => ring * m + (j % m);

function lengthSq(a) {
  return dot(a, a);
}

export function ringVertices(ring, points) {
  const m = points.length;
  const verts = new Array(m);
  for (let j = 0; j < m; j++) {
    const q = points[j];
    const x = q[0] * ring.su;
    const y = q[1] * ring.sv;
    verts[j] = add(ring.position, add(scale(ring.frame.n, x), scale(ring.frame.b, y)));
  }
  return verts;
}

export function emitRingVertices(mesh, ring, points) {
  const start = mesh.vertices.length;
  for (const p of ringVertices(ring, points)) mesh.vertices.push(p);
  return start;
}

// Connect ring A (index ia) to ring B (index ib), which may be coincident (bevel/seam).
// Winding is chosen so each triangle normal points away from the sweep axis.
export function stitchRings(mesh, ia, ib, m, points, rings) {
  const A = rings[ia];
  const B = rings[ib];
  const dir = lengthSq(sub(B.position, A.position)) > 1e-16
    ? normalize(sub(B.position, A.position))
    : A.frame.t;
  for (let j = 0; j < m; j++) {
    const j2 = (j + 1) % m;
    const a = ringIndex(0, ia, j, m);
    const b = ringIndex(0, ia, j2, m);
    const c = ringIndex(0, ib, j2, m);
    const d = ringIndex(0, ib, j, m);
    // Representative radial direction of this panel; orientation check vs. direction.
    const radial = normalize(add(scale(A.frame.n, points[j][0]), scale(A.frame.b, points[j][1])));
    const outwardFirst = dot(cross(sub(mesh.vertices[b], mesh.vertices[a]),
      sub(mesh.vertices[c], mesh.vertices[a])), radial) >= 0;
    if (outwardFirst && dot(dir, radial) >= -1e-9 || !outwardFirst && dot(dir, radial) < -1e-9) {
      mesh.faces.push([a, b, c], [a, c, d]);
    } else {
      mesh.faces.push([a, c, b], [a, d, c]);
    }
  }
}

export function capRing(mesh, ringIdx, m, center, outwardNormal) {
  const start = ringIdx * m;
  const centerIndex = mesh.vertices.length;
  mesh.vertices.push(center);
  for (let j = 0; j < m; j++) {
    const a = start + j;
    const b = start + ((j + 1) % m);
    const nrm = cross(sub(mesh.vertices[b], mesh.vertices[a]),
      sub(mesh.vertices[centerIndex], mesh.vertices[a]));
    if (dot(nrm, outwardNormal) >= 0) mesh.faces.push([centerIndex, a, b]);
    else mesh.faces.push([centerIndex, b, a]);
  }
}

// Per-edge connectivity evidence. Edge direction (a->b) is tracked as +1/-1 so a
// coherently oriented closed surface cancels to 0 on every shared edge.
export function edgeConnectivity(mesh) {
  const dirs = new Map();
  for (const f of mesh.faces) {
    for (let k = 0; k < 3; k++) {
      const a = f[k];
      const b = f[(k + 1) % 3];
      const key = a < b ? a + '>' + b : b + '>' + a;
      const sign = a < b ? 1 : -1;
      dirs.set(key, (dirs.get(key) || 0) + sign);
    }
  }
  let boundary = 0;
  let nonManifold = 0;
  let sharedTwice = 0;
  let consistent = 0;
  let inconsistent = 0;
  const incident = new Map();
  for (const f of mesh.faces) {
    for (let k = 0; k < 3; k++) {
      const a = f[k];
      const b = f[(k + 1) % 3];
      const key = a < b ? a + '>' + b : b + '>' + a;
      incident.set(key, (incident.get(key) || 0) + 1);
    }
  }
  for (const [key, count] of incident) {
    if (count === 1) boundary++;
    else if (count !== 2) nonManifold++;
    else {
      sharedTwice++;
      if (dirs.get(key) === 0) consistent++;
      else inconsistent++;
    }
  }
  return {
    edgeCount: incident.size,
    boundary,
    nonManifold,
    sharedTwice,
    consistent,
    inconsistent,
    coherent: boundary === 0 && nonManifold === 0 && inconsistent === 0,
  };
}

export function meshTopologyContract(mesh) {
  const edge = edgeConnectivity(mesh);
  return {
    closed: mesh.closed === true,
    seam: mesh.seam ?? null,
    capRule: mesh.capRule ?? null,
    faceRule: mesh.faceRule ?? null,
    edge,
    // Legacy field: "watertight" only means every edge has two incidents. It does NOT
    // certify coherent winding; use edge.inconsistent / edge.coherent for that.
    watertight: edge.boundary === 0 && edge.nonManifold === 0,
  };
}
