// Project state model.
//
// The source curve definition is preserved as first-class data and never overwritten by
// sampling or frame results. Parameter edits live on a draft; "adopting" a build stores
// an immutable version snapshot (the adopted parameters plus its geometry report), so
// every accepted iteration can be inspected or rolled back.

let counter = 1;

export function createProject({ name, spec }) {
  const now = new Date().toISOString();
  return {
    id: `proj_${counter++}_${Date.now().toString(36)}`,
    name: name || 'Untitled sweep',
    sourceCurve: structuredClone(spec.curve), // original authored curve, retained
    draft: structuredClone(spec),
    versions: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function updateDraft(project, patch) {
  // Edit working parameters only; sourceCurve stays untouched.
  project.draft = {
    ...structuredClone(project.draft),
    ...structuredClone(patch),
    curve: patch.curve ? structuredClone(patch.curve) : structuredClone(project.draft.curve),
  };
  project.updatedAt = new Date().toISOString();
  return project.draft;
}

export function adoptVersion(project, spec, report, geometryRef) {
  const version = {
    id: `v${project.versions.length + 1}`,
    adoptedAt: new Date().toISOString(),
    spec: structuredClone(spec),
    report: structuredClone(report),
    geometryRef, // filename / key of the cached built geometry, if persisted
  };
  project.versions.push(version);
  project.updatedAt = version.adoptedAt;
  return version;
}

export function rollback(project, versionId) {
  const found = project.versions.find((x) => x.id === versionId);
  if (!found) throw new Error(`Unknown version: ${versionId}`);
  project.draft = structuredClone(found.spec);
  project.updatedAt = new Date().toISOString();
  return project.draft;
}

// Lightweight JSON-file backed store so the zero-dependency server can persist projects.
export class ProjectStore {
  constructor(fs, path, dir) {
    this.fs = fs;
    this.path = path;
    this.dir = dir;
    this.file = path.join(dir, 'projects.json');
    this.fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, '[]');
  }

  list() {
    return JSON.parse(this.fs.readFileSync(this.file, 'utf8'));
  }

  save(projects) {
    this.fs.writeFileSync(this.file, JSON.stringify(projects, null, 2));
  }

  get(id) {
    return this.list().find((p) => p.id === id);
  }

  upsert(project) {
    const all = this.list();
    const i = all.findIndex((p) => p.id === project.id);
    if (i >= 0) all[i] = project;
    else all.push(project);
    this.save(all);
    return project;
  }
}
