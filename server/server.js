// Serveur minimal, sans dépendance : sert l'application (public/) et une API JSON
// qui stocke les projets dans un fichier. Node.js 20+.
import http from 'node:http';
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { join, normalize, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, randomBytes } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = resolve(process.env.DATA_DIR || join(ROOT, 'data'));
const DATA_FILE = join(DATA_DIR, 'projects.json');
const LEGACY_FILE = join(DATA_DIR, 'project.json'); // ancien format : un seul projet
const MAX_PROJECTS = 500;
const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
const MAX_BODY = 1024 * 1024; // 1 Mo

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json'
};

/* ---------- Données ----------
   { projects: { <id>: { version, updatedAt, data } } } */
let db = { projects: {} };
const newId = () => randomBytes(6).toString('hex');
const ID_RE = /^[a-z0-9]{6,32}$/;

async function loadDb() {
  try {
    db = JSON.parse(await readFile(DATA_FILE, 'utf8'));
    console.log(`${Object.keys(db.projects).length} projet(s) chargé(s) depuis ${DATA_FILE}`);
    return;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  // Reprise de l'ancien fichier project.json (version mono-projet)
  try {
    const old = JSON.parse(await readFile(LEGACY_FILE, 'utf8'));
    if (old && old.data) {
      db.projects[newId()] = { version: old.version || 1, updatedAt: old.updatedAt || new Date().toISOString(), data: old.data };
      await persist();
      console.log(`Ancien projet repris depuis ${LEGACY_FILE}.`);
      return;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  console.log(`Aucun projet existant : ${DATA_FILE} sera créé au premier enregistrement.`);
}

// Écriture atomique : fichier temporaire puis renommage
let writing = Promise.resolve();
function persist() {
  writing = writing.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    await writeFile(tmp, JSON.stringify(db, null, 2));
    await rename(tmp, DATA_FILE);
  });
  return writing;
}

const STATUSES = new Set(['todo', 'doing', 'done']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validate(p) {
  if (!p || typeof p !== 'object') return 'Projet invalide.';
  if (typeof p.name !== 'string') return 'Nom de projet manquant.';
  if (!Number.isInteger(p.seq)) return 'Compteur "seq" invalide.';
  if (!Array.isArray(p.tasks) || p.tasks.length > 2000) return 'Liste de tâches invalide.';
  const ids = new Set();
  for (const t of p.tasks) {
    if (!t || !Number.isInteger(t.id) || ids.has(t.id)) return 'Identifiant de tâche invalide ou en double.';
    ids.add(t.id);
    if (typeof t.title !== 'string' || t.title.length > 300) return `Titre invalide (tâche #${t.id}).`;
    if (!STATUSES.has(t.status)) return `Statut invalide (tâche #${t.id}).`;
    if (!Array.isArray(t.deps) || !t.deps.every(Number.isInteger)) return `Dépendances invalides (tâche #${t.id}).`;
    if (t.owner != null && (typeof t.owner !== 'string' || t.owner.length > 100)) return `Responsable invalide (tâche #${t.id}).`;
    if (t.due != null && t.due !== '' && !DATE_RE.test(t.due)) return `Échéance invalide (tâche #${t.id}).`;
  }
  for (const t of p.tasks) for (const d of t.deps) if (!ids.has(d)) return `La tâche #${t.id} dépend d'une tâche inexistante (#${d}).`;
  // Détection de cycle (le graphe doit rester un DAG)
  const byId = new Map(p.tasks.map(t => [t.id, t]));
  const mark = new Map(); // 1 = en cours de visite, 2 = visité
  const visit = id => {
    if (mark.get(id) === 2) return false;
    if (mark.get(id) === 1) return true;
    mark.set(id, 1);
    for (const d of byId.get(id).deps) if (visit(d)) return true;
    mark.set(id, 2);
    return false;
  };
  for (const t of p.tasks) if (visit(t.id)) return 'Les dépendances forment un cycle.';
  return null;
}

/* ---------- HTTP ---------- */
function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

function safeEqual(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function authorized(req) {
  if (!AUTH_USER || !AUTH_PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, ...rest] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  return safeEqual(u, AUTH_USER) & safeEqual(rest.join(':'), AUTH_PASSWORD);
}

function readBody(req) {
  return new Promise((ok, ko) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { ko(Object.assign(new Error('Requête trop volumineuse.'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', ko);
  });
}

async function readProject(req) {
  let payload;
  try { payload = JSON.parse(await readBody(req)); }
  catch (e) { return { err: [e.status || 400, e.status ? e.message : 'JSON invalide.'] }; }
  const err = validate(payload);
  return err ? { err: [422, err] } : { payload };
}

async function api(req, res, path) {
  if (path === '/api/health') return send(res, 200, { ok: true });

  if (path === '/api/projects') {
    if (req.method === 'GET') {
      const list = Object.entries(db.projects).map(([id, p]) => ({
        id, name: p.data.name || 'Sans nom', version: p.version, updatedAt: p.updatedAt,
        total: p.data.tasks.length, done: p.data.tasks.filter(t => t.status === 'done').length
      }));
      return send(res, 200, list, { 'Cache-Control': 'no-store' });
    }
    if (req.method === 'POST') {
      if (Object.keys(db.projects).length >= MAX_PROJECTS) return send(res, 422, { error: `Limite de ${MAX_PROJECTS} projets atteinte.` });
      const { payload, err } = await readProject(req);
      if (err) return send(res, err[0], { error: err[1] });
      const id = newId();
      db.projects[id] = { version: 1, updatedAt: new Date().toISOString(), data: payload };
      await persist();
      return send(res, 201, { id, version: 1 });
    }
    return send(res, 405, { error: 'Méthode non autorisée.' }, { Allow: 'GET, POST' });
  }

  const m = path.match(/^\/api\/projects\/([^/]+)$/);
  if (!m) return send(res, 404, { error: 'Route inconnue.' });
  const id = m[1];
  if (!ID_RE.test(id) || !Object.hasOwn(db.projects, id)) return send(res, 404, { error: 'Projet introuvable.' });
  const p = db.projects[id];

  if (req.method === 'GET') return send(res, 200, { id, ...p }, { 'Cache-Control': 'no-store' });

  if (req.method === 'PUT') {
    const expected = Number(req.headers['if-match']);
    if (!Number.isFinite(expected)) return send(res, 428, { error: 'En-tête If-Match (version) requis.' });
    if (expected !== p.version) return send(res, 409, { id, ...p });
    const { payload, err } = await readProject(req);
    if (err) return send(res, err[0], { error: err[1] });
    // Re-vérification après lecture du corps : une autre requête a pu passer entre-temps
    if (!Object.hasOwn(db.projects, id)) return send(res, 404, { error: 'Projet introuvable.' });
    if (db.projects[id].version !== expected) return send(res, 409, { id, ...db.projects[id] });
    db.projects[id] = { version: expected + 1, updatedAt: new Date().toISOString(), data: payload };
    await persist();
    return send(res, 200, { version: db.projects[id].version });
  }

  if (req.method === 'DELETE') {
    delete db.projects[id];
    await persist();
    return send(res, 204, '');
  }
  return send(res, 405, { error: 'Méthode non autorisée.' }, { Allow: 'GET, PUT, DELETE' });
}

async function serveStatic(req, res, path) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Méthode non autorisée.');
  const rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '');
  let file = join(PUBLIC_DIR, rel || 'index.html');
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Accès refusé.');
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    send(res, 404, 'Introuvable.');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== '/api/health' && !authorized(req)) {
      return send(res, 401, 'Authentification requise.', { 'WWW-Authenticate': 'Basic realm="Graphe de taches", charset="UTF-8"' });
    }
    if (pathname.startsWith('/api/')) return await api(req, res, pathname);
    return await serveStatic(req, res, pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Erreur interne.' });
  }
});

await loadDb();
server.listen(PORT, HOST, () => {
  console.log(`Graphe de tâches : http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (!AUTH_USER) console.warn('⚠ Pas d\'authentification (AUTH_USER / AUTH_PASSWORD non définis).');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await writing; process.exit(0); });
