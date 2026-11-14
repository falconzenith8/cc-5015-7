import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ---------- Default specs ----------
const DEFAULTS = {
  line: { a: [0, 0, 0], b: [10, 0, 0] },
  circle: { center: [0, 0, 0], radius: 5, e1: [1, 0, 0], e2: [0, 1, 0] },
  helix: { center: [0, 0, 0], r: 2, turns: 3, rise: 7, e1: [1, 0, 0], e2: [0, 1, 0], e3: [0, 0, 1] },
  polyline: { points: [[0, 0, 0], [5, 0, 0], [5, 5, 0], [1, 5, 0]], closed: false },
};

const PROFILE_DEFAULTS = {
  circle: { radius: 0.6, segments: 24 },
  ellipse: { rx: 0.7, ry: 0.45, segments: 32 },
  polygon: { radius: 0.6, sides: 6, phase: 0 },
  rectangle: { width: 1, height: 0.7 },
  roundedRect: { width: 1, height: 0.8, radius: 0.2, cornerSteps: 4 },
  ribbon: { width: 1, thickness: 0.15, cornerSteps: 3 },
};

let state = {
  project: null,
  geometry: null,
  report: null,
};

// ---------- Three.js scene ----------
const host = document.getElementById('canvasHost');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
host.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14171c);
const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 5000);
camera.position.set(10, 8, 14);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const key = new THREE.DirectionalLight(0xffffff, 1.1);
key.position.set(8, 12, 6);
scene.add(key);
const grid = new THREE.GridHelper(30, 30, 0x2a323d, 0x20262e);
scene.add(grid);

const layers = { mesh: null, wire: null, path: null, frames: null, rings: null };

function resize() {
  const w = host.clientWidth;
  const h = host.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

function clearLayer(name) {
  if (layers[name]) {
    scene.remove(layers[name]);
    layers[name].traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose && o.material.dispose();
    });
    layers[name] = null;
  }
}

function buildMeshLayer(geo) {
  const g = new THREE.Group();
  const positions = [];
  for (const v of geo.vertices) positions.push(v[0], v[1], v[2]);
  const indices = [];
  for (const f of geo.faces) indices.push(f[0], f[1], f[2]);
  const bg = new THREE.BufferGeometry();
  bg.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  bg.setIndex(indices);
  bg.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: 0xd8b25a, metalness: 0.85, roughness: 0.3, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(bg, mat);
  g.add(mesh);
  const wire = new THREE.LineSegments(new THREE.WireframeGeometry(bg),
    new THREE.LineBasicMaterial({ color: 0x6b5326, transparent: true, opacity: 0.25 }));
  wire.visible = false;
  g.add(wire);
  layers.wire = wire;
  return g;
}

function buildPathLayer(geo) {
  const g = new THREE.Group();
  const pts = geo.path.map((s) => new THREE.Vector3(...s.position));
  if (geo.closed) pts.push(new THREE.Vector3(...geo.path[0].position));
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0x4f9cf9 }));
  g.add(line);
  // Corner markers
  for (const s of geo.path) {
    if (!s.corner) continue;
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xe8a83a }));
    m.position.set(...s.position);
    g.add(m);
  }
  return g;
}

function buildFramesLayer(geo) {
  const g = new THREE.Group();
  const mk = (color) => new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 });
  const matN = mk(0x37c27b);
  const matB = mk(0xe5534b);
  for (const r of geo.rings) {
    const o = new THREE.Vector3(...r.position);
    const len = 0.55;
    const ln = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([o, o.clone().add(new THREE.Vector3(...r.n).multiplyScalar(len))]), matN);
    const lb = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([o, o.clone().add(new THREE.Vector3(...r.b).multiplyScalar(len))]), matB);
    g.add(ln, lb);
  }
  return g;
}

function buildRingsLayer(geo) {
  const g = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color: 0x9aa6b5, transparent: true, opacity: 0.7 });
  for (const r of geo.rings) {
    const o = new THREE.Vector3(...r.position);
    const n = new THREE.Vector3(...r.n);
    const b = new THREE.Vector3(...r.b);
    const pts = geo.profile.map((q) => o.clone()
      .add(n.clone().multiplyScalar(q[0] * r.su))
      .add(b.clone().multiplyScalar(q[1] * r.sv)));
    pts.push(pts[0].clone());
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
  }
  return g;
}

function frameScene() {
  if (!state.geometry) return;
  const geo = state.geometry;
  clearLayer('mesh'); clearLayer('path'); clearLayer('frames'); clearLayer('rings');
  layers.mesh = buildMeshLayer(geo); scene.add(layers.mesh);
  layers.path = buildPathLayer(geo); scene.add(layers.path);
  layers.frames = buildFramesLayer(geo); scene.add(layers.frames);
  layers.rings = buildRingsLayer(geo); scene.add(layers.rings);
  applyLayerVisibility();
  const box = new THREE.Box3().setFromObject(layers.mesh);
  if (box.isEmpty() === false) {
    const c = box.getCenter(new THREE.Vector3());
    controls.target.copy(c);
    grid.position.y = box.min.y;
  }
}

function applyLayerVisibility() {
  const vis = (id) => document.getElementById(id).checked;
  if (layers.mesh) layers.mesh.visible = vis('layerMesh');
  if (layers.wire) layers.wire.visible = vis('layerWire') && vis('layerMesh');
  if (layers.path) layers.path.visible = vis('layerPath');
  if (layers.frames) layers.frames.visible = vis('layerFrames');
  if (layers.rings) layers.rings.visible = vis('layerRings');
}
['layerMesh', 'layerWire', 'layerPath', 'layerFrames', 'layerRings'].forEach((id) => {
  document.getElementById(id).addEventListener('change', applyLayerVisibility);
});

(function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
})();
resize();

// ---------- Dynamic parameter forms ----------
const curveParamsEl = document.getElementById('curveParams');
const profileParamsEl = document.getElementById('profileParams');

function vecInput(prefix, value, length = 3) {
  const wrap = document.createElement('div');
  wrap.className = 'grid2';
  value.forEach((v, i) => {
    const lab = document.createElement('label');
    lab.textContent = `${prefix}${['x', 'y', 'z'][i] || i}`;
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.step = '0.1';
    inp.dataset.field = `${prefix}.${i}`;
    inp.value = v;
    lab.appendChild(inp);
    wrap.appendChild(lab);
  });
  return wrap;
}

function scalarInput(field, value, step = 0.1) {
  const lab = document.createElement('label');
  lab.textContent = field;
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.step = String(step);
  inp.dataset.field = field;
  inp.value = value;
  lab.appendChild(inp);
  return lab;
}

function renderCurveParams(type, params) {
  curveParamsEl.innerHTML = '';
  if (type === 'line') {
    curveParamsEl.appendChild(vecInput('a', params.a));
    curveParamsEl.appendChild(vecInput('b', params.b));
  } else if (type === 'circle') {
    curveParamsEl.appendChild(vecInput('center', params.center));
    curveParamsEl.appendChild(scalarInput('radius', params.radius, 0.1));
    curveParamsEl.appendChild(vecInput('e1', params.e1));
    curveParamsEl.appendChild(vecInput('e2', params.e2));
  } else if (type === 'helix') {
    curveParamsEl.appendChild(vecInput('center', params.center));
    curveParamsEl.appendChild(scalarInput('r', params.r));
    curveParamsEl.appendChild(scalarInput('turns', params.turns, 1));
    curveParamsEl.appendChild(scalarInput('rise', params.rise));
    curveParamsEl.appendChild(vecInput('e3', params.e3));
  } else if (type === 'polyline') {
    const lab = document.createElement('label');
    lab.textContent = '点（每行 x,y,z，逗号分隔）';
    const ta = document.createElement('textarea');
    ta.rows = 6;
    ta.dataset.field = 'points';
    ta.value = params.points.map((p) => p.join(',')).join('\n');
    lab.appendChild(ta);
    curveParamsEl.appendChild(lab);
    const closed = document.createElement('label');
    closed.innerHTML = '<input type="checkbox" data-field="closed" ' + (params.closed ? 'checked' : '') + '> 闭合环';
    curveParamsEl.appendChild(closed);
  }
}

function renderProfileParams(type, params) {
  profileParamsEl.innerHTML = '';
  for (const [key, val] of Object.entries(params)) {
    if (Array.isArray(val)) profileParamsEl.appendChild(vecInput(key, val, val.length));
    else profileParamsEl.appendChild(scalarInput(key, val, Number.isInteger(val) ? 1 : 0.05));
  }
}

function readFormInto(obj, rootEl) {
  rootEl.querySelectorAll('[data-field]').forEach((el) => {
    const path = el.dataset.field.split('.');
    let target = obj;
    for (let i = 0; i < path.length - 1; i++) {
      target[path[i]] = target[path[i]] || {};
      target = target[path[i]];
    }
    const leaf = path[path.length - 1];
    if (el.type === 'checkbox') target[leaf] = el.checked;
    else if (el.dataset.field === 'points') {
      target[leaf] = el.value.split('\n').map((line) => line.split(',').map(Number)).filter((p) => p.length >= 2 && p.every(Number.isFinite));
    } else target[leaf] = Number(el.value);
  });
}

// ---------- Scale keyframes ----------
const scaleBody = document.querySelector('#scaleTable tbody');
function renderScaleTable(keyframes) {
  scaleBody.innerHTML = '';
  keyframes.forEach((kf, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input type="number" step="0.05" min="0" max="1" value="${kf.u}" data-k="u"></td>
      <td><input type="number" step="0.05" value="${kf.su}" data-k="su"></td>
      <td><input type="number" step="0.05" value="${kf.sv}" data-k="sv"></td>
      <td><button data-del="${i}">删</button></td>`;
    scaleBody.appendChild(tr);
  });
}
document.getElementById('addKeyframe').addEventListener('click', () => {
  const spec = collectSpec();
  spec.scaleKeyframes.push({ u: 0.5, su: 1, sv: 1 });
  spec.scaleKeyframes.sort((a, b) => a.u - b.u);
  renderScaleTable(spec.scaleKeyframes);
});
scaleBody.addEventListener('click', (e) => {
  if (e.target.dataset.del !== undefined) {
    const spec = collectSpec();
    spec.scaleKeyframes.splice(Number(e.target.dataset.del), 1);
    renderScaleTable(spec.scaleKeyframes);
  }
});

// ---------- Collect spec from form ----------
function collectSpec() {
  const curveType = document.getElementById('curveType').value;
  const profileType = document.getElementById('profileType').value;
  const curve = { type: curveType, params: structuredClone(DEFAULTS[curveType]) };
  readFormInto(curve.params, curveParamsEl);
  const profile = { type: profileType, ...structuredClone(PROFILE_DEFAULTS[profileType]) };
  readFormInto(profile, profileParamsEl);
  const keyframes = [];
  scaleBody.querySelectorAll('tr').forEach((tr) => {
    const get = (k) => Number(tr.querySelector(`[data-k="${k}"]`).value);
    keyframes.push({ u: get('u'), su: get('su'), sv: get('sv') });
  });
  const sampling = {
    chordTolerance: Number(document.getElementById('chordTolerance').value),
    maxTurnAngle: Number(document.getElementById('maxTurnAngle').value) * Math.PI / 180,
  };
  return {
    curve,
    profile,
    scaleKeyframes: keyframes.sort((a, b) => a.u - b.u),
    scaleInterpolation: 'linear',
    frameMode: document.getElementById('frameMode').value,
    sampling,
    miterLimit: Number(document.getElementById('miterLimit').value),
    bevelOffset: Number(document.getElementById('bevelOffset').value),
  };
}

function fillForm(spec) {
  document.getElementById('curveType').value = spec.curve.type;
  renderCurveParams(spec.curve.type, spec.curve.params);
  document.getElementById('profileType').value = spec.profile.type;
  const { type, ...pParams } = spec.profile;
  renderProfileParams(type, pParams);
  renderScaleTable(spec.scaleKeyframes);
  document.getElementById('frameMode').value = spec.frameMode || 'rmf';
  document.getElementById('chordTolerance').value = spec.sampling?.chordTolerance ?? 0.02;
  document.getElementById('maxTurnAngle').value = (spec.sampling?.maxTurnAngle ?? 6 * Math.PI / 180) * 180 / Math.PI;
  document.getElementById('miterLimit').value = spec.miterLimit ?? 2;
  document.getElementById('bevelOffset').value = spec.bevelOffset ?? 0.35;
}

// ---------- API ----------
async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json()).error || res.status);
  return res.json();
}

function renderReport(report) {
  state.report = report;
  const sum = document.getElementById('reportSummary');
  const t = report.topology;
  sum.innerHTML = `<div class="kv">
    <b>采样站</b><span>${report.sampling.stationCount}（尖角 ${report.sampling.cornerCount}）</span>
    <b>环 / 顶点 / 面</b><span>${report.mesh.ringCount} / ${report.mesh.vertexCount} / ${report.mesh.faceCount}</span>
    <b>闭合</b><span>${report.mesh.closed ? '是（单接缝 u=0）' : '否（双端盖）'}</span>
    <b>水密</b><span class="${t.watertight ? 'ok-text' : 'err-text'}">${t.watertight ? '是' : `否（${t.boundaryEdges.length} 条边界边）`}</span>
    <b>框架</b><span>${report.frameMode}${report.twistCorrection ? '，扭转均布修正 ' + report.twistCorrection.totalAngle.toFixed(4) + ' rad' : ''}</span>
    <b>面规则</b><span>${report.mesh.faceRule}</span>
    <b>端盖规则</b><span>${report.mesh.capRule}</span>
  </div>`;
  const errUl = document.getElementById('errorList');
  const warnUl = document.getElementById('warningList');
  errUl.innerHTML = '';
  warnUl.innerHTML = '';
  for (const e of report.errors) {
    const li = document.createElement('li');
    li.className = 'error';
    li.innerHTML = `<b>${e.type}</b><span class="meta">阶段 ${e.stage}${e.index !== undefined ? '，索引 ' + e.index : ''}</span>`;
    errUl.appendChild(li);
  }
  if (!report.errors.length) errUl.innerHTML = '<li class="note">无错误</li>';
  for (const w of report.warnings) {
    const li = document.createElement('li');
    li.className = 'warning';
    li.innerHTML = `<b>${w.type}</b><span class="meta">阶段 ${w.stage}${w.u !== undefined ? '，u=' + Number(w.u).toFixed(3) : ''}</span>
      ${w.message ? `<span class="meta">${w.message}</span>` : ''}`;
    warnUl.appendChild(li);
  }
  if (!report.warnings.length) warnUl.innerHTML = '<li class="note">无警告</li>';
  document.getElementById('disclaimer').textContent = report.disclaimer;
  const badge = document.getElementById('diagBadge');
  const total = report.errors.length + report.warnings.length;
  badge.textContent = total;
  badge.classList.toggle('hidden', total === 0);
  badge.classList.toggle('err', report.errors.length > 0);
}

async function build() {
  const spec = collectSpec();
  if (!state.project) throw new Error('no project open');
  // Preview arbitrary form parameters without mutating the saved draft.
  const { report, geometry } = await api(`/api/projects/${state.project.id}/build-custom`, 'POST', spec);
  state.geometry = geometry;
  renderReport(report);
  frameScene();
  return { report, geometry };
}

// ---------- Projects / versions ----------
async function loadProjectList() {
  const projects = await api('/api/projects');
  const sel = document.getElementById('projectSelect');
  sel.innerHTML = '';
  for (const p of projects) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = `${p.name}（${p.versionCount} 版本）`;
    sel.appendChild(o);
  }
  return projects;
}

async function openProject(id) {
  state.project = await api(`/api/projects/${id}`);
  fillForm(state.project.draft);
  document.getElementById('sourceCurveView').textContent = JSON.stringify(state.project.sourceCurve, null, 2);
  renderVersions();
  updateExportLinks();
  await build();
}

function renderVersions() {
  const ul = document.getElementById('versionList');
  ul.innerHTML = '';
  state.project.versions.forEach((v) => {
    const li = document.createElement('li');
    const ok = v.report.errors.length === 0 && v.report.warnings.length === 0;
    li.innerHTML = `<div class="vhead"><span>${v.id}</span>
      <span class="${ok ? 'ok-text' : 'warn-text'}">${ok ? '无诊断' : v.report.errors.length + ' 错 / ' + v.report.warnings.length + ' 警'}</span></div>
      <div class="note">${v.adoptedAt} · 站 ${v.report.sampling.stationCount} · 面 ${v.report.mesh.faceCount}${v.report.topology.watertight ? ' · 水密' : ''}</div>`;
    const btn = document.createElement('button');
    btn.textContent = '回滚到该版本参数';
    btn.onclick = async () => {
      await api(`/api/projects/${state.project.id}/rollback/${v.id}`, 'POST');
      await openProject(state.project.id);
    };
    li.appendChild(btn);
    ul.appendChild(li);
  });
  if (!state.project.versions.length) ul.innerHTML = '<li class="note">尚未采用任何版本。生成满意后点“采用为版本”。</li>';
}

document.getElementById('newProjectBtn').addEventListener('click', async () => {
  const name = prompt('项目名称', '饰品扫掠 ' + new Date().toLocaleTimeString());
  if (!name) return;
  const seedSpec = collectSpec();
  const p = await api('/api/projects', 'POST', { name, spec: seedSpec });
  await loadProjectList();
  document.getElementById('projectSelect').value = p.id;
  await openProject(p.id);
});

document.getElementById('buildBtn').addEventListener('click', async () => {
  if (state.project) {
    const spec = collectSpec();
    await api(`/api/projects/${state.project.id}/draft`, 'PUT', spec);
  }
  await build();
});

document.getElementById('adoptBtn').addEventListener('click', async () => {
  if (!state.project) return alert('请先新建项目');
  await api(`/api/projects/${state.project.id}/draft`, 'PUT', collectSpec());
  const { project } = await api(`/api/projects/${state.project.id}/adopt`, 'POST');
  state.project = project;
  renderVersions();
  await loadProjectList();
});

document.getElementById('projectSelect').addEventListener('change', (e) => openProject(e.target.value));

['curveType', 'profileType'].forEach((id) => {
  document.getElementById(id).addEventListener('change', () => {
    const ct = document.getElementById('curveType').value;
    const pt = document.getElementById('profileType').value;
    if (id === 'curveType') renderCurveParams(ct, DEFAULTS[ct]);
    if (id === 'profileType') renderProfileParams(pt, PROFILE_DEFAULTS[pt]);
  });
});

// Export links follow the open project; otherwise disabled.
['exportObj', 'exportStl', 'exportStlBin'].forEach((id) => {
  const el = document.getElementById(id);
  el.addEventListener('click', (e) => {
    if (!state.project) { e.preventDefault(); alert('请先新建并保存项目'); }
  });
});
function updateExportLinks() {
  const ids = ['exportObj', 'exportStl', 'exportStlBin'];
  if (!state.project) {
    ids.forEach((id) => (document.getElementById(id).removeAttribute('href')));
    return;
  }
  const base = `/api/projects/${state.project.id}/export`;
  document.getElementById('exportObj').href = `${base}/obj`;
  document.getElementById('exportStl').href = `${base}/stl`;
  document.getElementById('exportStlBin').href = `${base}/stl-bin`;
}

// Tabs
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.tabpanel').forEach((p) => p.classList.add('hidden'));
    document.getElementById('tab-' + tab.dataset.tab).classList.remove('hidden');
  });
});

// ---------- Boot ----------
const seed = {
  curve: { type: 'circle', params: structuredClone(DEFAULTS.circle) },
  profile: { type: 'circle', ...structuredClone(PROFILE_DEFAULTS.circle) },
  scaleKeyframes: [{ u: 0, su: 1, sv: 1 }, { u: 1, su: 1, sv: 1 }],
  frameMode: 'rmf',
  sampling: { chordTolerance: 0.02, maxTurnAngle: 6 * Math.PI / 180 },
  miterLimit: 2,
  bevelOffset: 0.35,
};
fillForm(seed);
(async function init() {
  const projects = await loadProjectList();
  if (projects.length) await openProject(projects[0].id);
  else {
    // Preview without a project via a temporary project so export still works later.
    const p = await api('/api/projects', 'POST', { name: '示例圆环', spec: seed });
    await loadProjectList();
    document.getElementById('projectSelect').value = p.id;
    await openProject(p.id);
  }
})();
