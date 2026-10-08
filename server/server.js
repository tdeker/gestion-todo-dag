// Serveur minimal, sans dépendance : sert l'application (public/) et une API JSON
// qui stocke le projet dans un fichier. Node.js 20+.
import http from 'node:http';
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { join, normalize, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = resolve(process.env.DATA_DIR || join(ROOT, 'data'));
const DATA_FILE = join(DATA_DIR, 'project.json');
const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
const MAX_BODY = 1024 * 1024; // 1 Mo

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json'
};

/* ---------- Données ---------- */
let state = { version: 0, data: null };

async function loadState() {
  try {
    state = JSON.parse(await readFile(DATA_FILE, 'utf8'));
    console.log(`Projet chargé (version ${state.version}) depuis ${DATA_FILE}`);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    console.log(`Aucun projet existant : ${DATA_FILE} sera créé au premier enregistrement.`);
  }
}

// Écriture atomique : fichier temporaire puis renommage
let writing = Promise.resolve();
function persist() {
  writing = writing.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    await writeFile(tmp, JSON.stringify(state, null, 2));
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

async function api(req, res, path) {
  if (path === '/api/health') return send(res, 200, { ok: true });
  if (path !== '/api/project') return send(res, 404, { error: 'Route inconnue.' });

  if (req.method === 'GET') return send(res, 200, state, { 'Cache-Control': 'no-store' });

  if (req.method === 'PUT') {
    const expected = Number(req.headers['if-match']);
    if (!Number.isFinite(expected)) return send(res, 428, { error: 'En-tête If-Match (version) requis.' });
    if (expected !== state.version) return send(res, 409, state);
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch (e) { return send(res, e.status || 400, { error: e.status ? e.message : 'JSON invalide.' }); }
    const err = validate(payload);
    if (err) return send(res, 422, { error: err });
    state = { version: state.version + 1, updatedAt: new Date().toISOString(), data: payload };
    await persist();
    return send(res, 200, { version: state.version });
  }
  return send(res, 405, { error: 'Méthode non autorisée.' }, { Allow: 'GET, PUT' });
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

await loadState();
server.listen(PORT, HOST, () => {
  console.log(`Graphe de tâches : http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (!AUTH_USER) console.warn('⚠ Pas d\'authentification (AUTH_USER / AUTH_PASSWORD non définis).');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await writing; process.exit(0); });
