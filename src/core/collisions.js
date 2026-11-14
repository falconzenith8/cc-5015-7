// Post-build self-intersection reporting for the swept mesh.
// A spatial hash finds candidate triangle pairs; Moller-Trumbore gives exact edge
// crossings and vertex containment. Adjacent surface triangles and the cap/body join
// are topology, not collisions, so ring adjacency is used to exclude false positives.
import { sub, cross, dot, scale, add } from './vec3.js';

function triEdgeCross(edge, a, b, c) {
  // Moller-Trumbore: edge (p, p+d) vs triangle (a,b,c). Returns t in [0,1] or null.
  const [p, d] = edge;
  const e1 = sub(b, a);
  const e2 = sub(c, a);
  const h = cross(d, e2);
  const det = dot(e1, h);
  if (Math.abs(det) < 1e-14) return null;
  const inv = 1 / det;
  const s = sub(p, a);
  const u = inv * dot(s, h);
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  const q = cross(s, e1);
  const v = inv * dot(d, q);
  if (v < -1e-9 || u + v > 1 + 1e-9) return null;
  const t = inv * dot(e2, q);
  if (t >= 1e-9 && t <= 1 - 1e-9) return t;
  return null;
}

export function findMeshSelfIntersections(mesh, opts = {}) {
  const { vertices, faces, ringCount, profileCount: m, rings } = mesh;
  const cellSize = opts.cellSize || autoCellSize(mesh);
  const buckets = new Map();
  const key = (ix, iy, iz) => ix + ',' + iy + ',' + iz;

  function triBounds(idx) {
    const f = faces[idx];
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (const vi of f) {
      const p = vertices[vi];
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p[k]);
        max[k] = Math.max(max[k], p[k]);
      }
    }
    return { min, max };
  }

  function insert(idx) {
    const { min, max } = triBounds(idx);
    const seen = new Set();
    for (let ix = Math.floor(min[0] / cellSize); ix <= Math.floor(max[0] / cellSize); ix++) {
      for (let iy = Math.floor(min[1] / cellSize); iy <= Math.floor(max[1] / cellSize); iy++) {
        for (let iz = Math.floor(min[2] / cellSize); iz <= Math.floor(max[2] / cellSize); iz++) {
          const k = key(ix, iy, iz);
          if (seen.has(k)) continue;
          seen.add(k);
          if (!buckets.has(k)) buckets.set(k, []);
          buckets.get(k).push(idx);
        }
      }
    }
  }

  // Which ring does a face belong to? Body vertices are ring-major: index = ring*m + j.
  // Cap center vertices live after all ring vertices, so their containing faces are
  // recognized separately instead of being mapped through the ring index formula.
  const bodyVertexCount = ringCount * m;
  function faceRing(idx) {
    const f = faces[idx];
    const bodyVi = f.filter((vi) => vi < bodyVertexCount);
    if (bodyVi.length === 0) return -1; // pure cap-center fan (should not happen)
    return Math.floor(Math.min(...bodyVi) / m);
  }

  // Rings that participate in the same miter/bevel joint touch intentionally. Group
  // them by their corner reference so the adjacency test follows the actual topology
  // rather than a fixed ring-index distance (which breaks under dense adaptive sampling).
  const jointGroups = new Map();
  rings.forEach((ring, idx) => {
    if (!ring.corner) return;
    const key = ring.u;
    if (!jointGroups.has(key)) jointGroups.set(key, []);
    jointGroups.get(key).push(idx);
  });
  const jointOf = new Map();
  for (const [, group] of jointGroups) {
    for (const idx of group) jointOf.set(idx, group);
  }

  function topologicallyAdjacent(r1, r2) {
    if (r1 < 0 || r2 < 0) return false; // cap fans are handled separately
    if (r1 === r2) return true;
    if (Math.abs(r1 - r2) === 1) return true; // consecutive sweep rings
    if (mesh.closed && ringCount - Math.abs(r1 - r2) === 1) return true;
    const g1 = jointOf.get(r1);
    const g2 = jointOf.get(r2);
    if (g1 && g2 && g1 === g2) return true; // same miter/bevel joint
    // A ring immediately next to a joint ring is its connecting panel.
    if (g1 && g1.some((g) => Math.abs(g - r2) <= 1)) return true;
    if (g2 && g2.some((g) => Math.abs(g - r1) <= 1)) return true;
    return false;
  }

  for (let i = 0; i < faces.length; i++) insert(i);

  const checked = new Set();
  const hits = [];
  const maxCandidates = opts.maxCandidates || 200000;
  let candidates = 0;
  let truncated = false;
  outer:
  for (const bucket of buckets.values()) {
    for (let x = 0; x < bucket.length; x++) {
      for (let y = x + 1; y < bucket.length; y++) {
        const i = bucket[x];
        const j = bucket[y];
        const pair = i < j ? i + ':' + j : j + ':' + i;
        if (checked.has(pair)) continue;
        checked.add(pair);
        if (++candidates > maxCandidates) { truncated = true; break outer; }
        if (topologicallyAdjacent(faceRing(i), faceRing(j))) continue;

        const fi = faces[i];
        const fj = faces[j];
        const triA = fi.map((vi) => vertices[vi]);
        const triB = fj.map((vi) => vertices[vi]);

        // Edges of A against triangle B, then edges of B against triangle A.
        let hitPoint = null;
        const edgesA = [[triA[0], sub(triA[1], triA[0])], [triA[1], sub(triA[2], triA[1])], [triA[2], sub(triA[0], triA[2])]];
        for (const e of edgesA) {
          const t = triEdgeCross(e, triB[0], triB[1], triB[2]);
          if (t !== null) {
            hitPoint = add(e[0], scale(e[1], t));
            break;
          }
        }
        if (!hitPoint) {
          const edgesB = [[triB[0], sub(triB[1], triB[0])], [triB[1], sub(triB[2], triB[1])], [triB[2], sub(triB[0], triB[2])]];
          for (const e of edgesB) {
            const t = triEdgeCross(e, triA[0], triA[1], triA[2]);
            if (t !== null) {
              hitPoint = add(e[0], scale(e[1], t));
              break;
            }
          }
        }
        if (hitPoint) {
          hits.push({ faces: [i, j], rings: [faceRing(i), faceRing(j)], point: hitPoint });
          if (hits.length >= (opts.maxHits || 50)) { truncated = true; break outer; }
        }
      }
    }
  }
  return { hits, truncated, cellSize };
}

function autoCellSize(mesh) {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (const p of mesh.vertices) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  }
  const span = Math.max(...max.map((v, k) => v - min[k]), 1e-9);
  return Math.max(span / 24, 1e-9);
}
