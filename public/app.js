/* ---------- Dates ---------- */
const pad2 = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
const parse = s => { if (!s) return null; const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); };
const TODAY = (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })();
const inDays = n => { const d = new Date(TODAY); d.setDate(d.getDate() + n); return iso(d); };
const daysLeft = s => Math.round((parse(s) - TODAY) / 864e5);
const fmtDate = s => s ? parse(s).toLocaleDateString('fr-FR', {day:'numeric', month:'short'}) : '';
function dueInfo(t){
  if (!t.due) return {txt:'Sans échéance', cls:'none'};
  if (t.status === 'done') return {txt:fmtDate(t.due), cls:'ok'};
  const n = daysLeft(t.due);
  if (n < 0) return {txt:`${fmtDate(t.due)} · ${-n} j de retard`, cls:'late'};
  if (n === 0) return {txt:"Aujourd'hui", cls:'soon'};
  if (n <= 3) return {txt:`${fmtDate(t.due)} · J-${n}`, cls:'soon'};
  return {txt:fmtDate(t.due), cls:'ok'};
}
const isLate = t => t.status !== 'done' && t.due && daysLeft(t.due) < 0;

// Exemple : échéances calculées par rapport à aujourd'hui pour rester parlant
const SAMPLE = {
  name: 'Lancement du site vitrine (exemple)',
  seq: 11,
  tasks: [
    {id:1, title:'Cadrage du besoin', status:'done', deps:[], owner:'Claire', due:inDays(-10), description:'Atelier avec la direction : objectifs du site, cibles, arborescence et budget.'},
    {id:2, title:"Choix de l'hébergeur", status:'done', deps:[1], owner:'Lucas', due:inDays(-5)},
    {id:3, title:'Maquettes des pages', status:'doing', deps:[1], owner:'Mehdi', due:inDays(2), description:'Accueil, offre, à propos, contact. Version mobile et ordinateur.'},
    {id:4, title:'Rédaction des contenus', status:'todo', deps:[1], owner:'Sophie', due:inDays(-1), description:'Textes des 4 pages, relus par la communication. Prévoir les mentions légales.'},
    {id:5, title:'Charte graphique', status:'todo', deps:[3], owner:'Mehdi', due:inDays(6)},
    {id:6, title:'Intégration HTML/CSS', status:'todo', deps:[3,5], owner:'Lucas', due:inDays(5), description:'Gabarits responsive à partir des maquettes validées et de la charte.'},
    {id:7, title:'Configuration du DNS', status:'todo', deps:[2], owner:'Lucas', due:inDays(4)},
    {id:8, title:'Intégration des contenus', status:'todo', deps:[4,6], owner:'Sophie', due:inDays(16)},
    {id:9, title:'Recette', status:'todo', deps:[7,8], owner:'Claire', due:inDays(20), description:'Tests sur Chrome, Safari et Firefox, mobile compris. Formulaire de contact à vérifier.'},
    {id:10, title:'Mise en ligne', status:'todo', type:'milestone', deps:[9], owner:'Claire', due:inDays(23), description:'Bascule DNS, vérification du certificat HTTPS, annonce interne.'}
  ]
};
let who = '';
const owners = () => [...new Set(T().map(t => (t.owner || '').trim()).filter(Boolean))].sort((a,b) => a.localeCompare(b, 'fr'));
const mine = t => !who || (t.owner || '') === who;
// Prérequis dont l'échéance tombe après celle de la tâche : planning incohérent
const lateDeps = t => t.due ? t.deps.map(byId).filter(d => d && d.due && d.status !== 'done' && d.due > t.due) : [];
const LABEL = {ready:'PRÊTE', doing:'EN COURS', blocked:'BLOQUÉE', done:'FAITE'};
// Jalon : point de passage daté (pas de durée, pas d'état « en cours »)
const isMs = t => t.type === 'milestone';
const MS_LABEL = {ready:'ATTEIGNABLE', doing:'ATTEIGNABLE', blocked:'EN ATTENTE', done:'ATTEINT'};
const lbl = (t, s = state(t)) => isMs(t) ? MS_LABEL[s] : LABEL[s];
const tagTxt = (t, s) => isMs(t) ? '◆ JALON · ' + MS_LABEL[s] : LABEL[s];

const blankProject = (name = 'Nouveau projet') => ({ name, seq: 1, tasks: [] });
let data = blankProject();
let selected = null;

function clone(o){ return JSON.parse(JSON.stringify(o)); }
const newId = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
const summary = (id, d) => ({ id, name: d.name || 'Sans nom', total: d.tasks.length, done: d.tasks.filter(t => t.status === 'done').length });

/* ---------- Stockage ----------
   Mode "server" : si l'API /api/projects répond, les projets sont partagés sur le serveur
   (contrôle de version optimiste : en cas de conflit, la version du serveur gagne).
   Mode "local"  : sinon (ex. GitHub Pages), stockage dans le navigateur. */
const LKEY = 'graphe-taches-projets-v1', CUR_KEY = 'graphe-taches-projet-courant';
const store = { mode: 'local', id: null, version: 0, timer: null, saving: false, again: false, dirty: false, list: [] };
let ldb = { projects: {} };

function lsGet(k){ try { return localStorage.getItem(k); } catch(e){ return null; } }
function lsSet(k, v){ try { localStorage.setItem(k, v); } catch(e){} }
function loadLocalDb(){
  try { const s = lsGet(LKEY); if (s) return JSON.parse(s); } catch(e){}
  // Reprise de l'ancien format (un seul projet) s'il existe
  let old = null; try { old = JSON.parse(lsGet('graphe-taches-v2') || 'null'); } catch(e){}
  return { projects: { [newId()]: old || clone(SAMPLE) } };
}
function setSync(text, warn){
  const el = document.getElementById('syncNote');
  if (el){ el.textContent = text; el.style.color = warn ? 'var(--doing)' : ''; }
}
function save(){
  if (store.mode !== 'server'){ ldb.projects[store.id] = data; lsSet(LKEY, JSON.stringify(ldb)); renderMenu(); return; }
  store.dirty = true;
  setSync('Enregistrement…');
  clearTimeout(store.timer);
  store.timer = setTimeout(pushServer, 500);
  renderMenu();
}
async function pushServer(){
  if (store.saving){ store.again = true; return; }
  store.saving = true;
  const id = store.id;
  try {
    const r = await fetch('api/projects/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': String(store.version) },
      body: JSON.stringify(data)
    });
    const j = await r.json().catch(() => ({}));
    if (store.id !== id) return;                      // on a changé de projet entre-temps
    if (r.status === 404){
      store.dirty = false; store.again = false;
      await projectGone();
    } else if (r.status === 409){
      store.version = j.version; data = j.data; store.dirty = false; store.again = false;
      refreshAll();
      setSync("Modifié entre-temps par quelqu'un d'autre : version du serveur rechargée.", true);
    } else if (!r.ok){
      throw new Error(j.error || 'HTTP ' + r.status);
    } else {
      store.version = j.version;
      if (!store.again) store.dirty = false;
      setSync('Enregistré sur le serveur');
    }
  } catch(e){
    setSync("Échec de l'enregistrement (" + e.message + '), nouvel essai dans 5 s…', true);
    clearTimeout(store.timer);
    store.timer = setTimeout(pushServer, 5000);
  } finally {
    store.saving = false;
    if (store.again){ store.again = false; pushServer(); }
  }
}
async function flush(){
  if (store.mode === 'server' && store.dirty){ clearTimeout(store.timer); await pushServer(); }
}
async function refreshList(){
  if (store.mode === 'server'){
    try { const r = await fetch('api/projects', { cache: 'no-store' }); if (r.ok) store.list = await r.json(); } catch(e){}
  } else {
    store.list = Object.entries(ldb.projects).map(([id, d]) => summary(id, d));
  }
  renderMenu();
}
async function openProject(id){
  await flush();
  clearTimeout(store.timer);
  store.dirty = false; store.again = false;
  if (store.mode === 'server'){
    const r = await fetch('api/projects/' + id, { cache: 'no-store' });
    if (!r.ok) throw new Error('Projet introuvable');
    const j = await r.json();
    store.version = j.version; data = j.data;
    setSync('Enregistré sur le serveur');
  } else {
    data = ldb.projects[id];
  }
  store.id = id; selected = null; who = ''; undo = null; hideToast();
  lsSet(CUR_KEY, id);
  refreshAll();
}
async function createProject(d){
  let id;
  if (store.mode === 'server'){
    const r = await fetch('api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok){ setSync('Création impossible : ' + (j.error || 'HTTP ' + r.status), true); return; }
    id = j.id;
  } else {
    id = newId(); ldb.projects[id] = d; lsSet(LKEY, JSON.stringify(ldb));
  }
  await openProject(id);
  await refreshList();
}
async function deleteProject(id){
  if (store.mode === 'server'){
    const r = await fetch('api/projects/' + id, { method: 'DELETE' });
    if (!r.ok && r.status !== 404){ setSync('Suppression impossible (HTTP ' + r.status + ').', true); return; }
    if (id === store.id){ store.dirty = false; clearTimeout(store.timer); }
  } else {
    delete ldb.projects[id]; lsSet(LKEY, JSON.stringify(ldb));
  }
  await refreshList();
  if (id === store.id){
    if (store.list.length) await openProject(store.list[0].id);
    else await createProject(blankProject());
  }
}
// Le projet courant a été supprimé par quelqu'un d'autre
async function projectGone(){
  await refreshList();
  if (store.list.length) await openProject(store.list[0].id); else await createProject(blankProject());
  setSync("Le projet que vous consultiez a été supprimé par quelqu'un d'autre.", true);
}
// Récupère les modifications des autres utilisateurs (sauf pendant une saisie)
async function poll(){
  if (store.mode !== 'server' || store.dirty || store.saving || document.hidden) return;
  refreshList();
  if (document.activeElement && document.activeElement.matches('input, select, textarea')) return;
  const id = store.id;
  try {
    const r = await fetch('api/projects/' + id, { cache: 'no-store' });
    if (store.id !== id || store.dirty) return;
    if (r.status === 404) return projectGone();
    if (!r.ok) return;
    const j = await r.json();
    if (j.version !== store.version && j.data){ store.version = j.version; data = j.data; refreshAll(); }
  } catch(e){}
}
function refreshAll(){
  if (selected && !byId(selected)) selected = null;
  document.getElementById('projectName').value = data.name || '';
  render();
  renderMenu();
}
async function boot(){
  try {
    const r = await fetch('api/projects', { cache: 'no-store' });
    if (!r.ok) throw new Error();
    store.mode = 'server';
    store.list = await r.json();
    setInterval(poll, 10000);
    document.addEventListener('visibilitychange', poll);
  } catch(e){
    store.mode = 'local';
    ldb = loadLocalDb();
    lsSet(LKEY, JSON.stringify(ldb));
    await refreshList();
    setSync('Enregistré dans ce navigateur uniquement.');
  }
  if (!store.list.length){ await createProject(clone(SAMPLE)); return; }   // serveur vide : projet d'exemple
  const last = lsGet(CUR_KEY);
  await openProject(store.list.some(p => p.id === last) ? last : store.list[0].id);
  if (store.mode === 'local') setSync('Enregistré dans ce navigateur uniquement.');
}
const T = () => data.tasks;
const byId = id => T().find(t => t.id === id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function state(t){
  if (t.status === 'done') return 'done';
  if (t.status === 'doing' && !isMs(t)) return 'doing';
  return t.deps.every(d => byId(d)?.status === 'done') ? 'ready' : 'blocked';
}
function ancestors(id){ const acc = new Set(), st = [id];
  while (st.length){ const t = byId(st.pop()); if (!t) continue; for (const d of t.deps) if (!acc.has(d)){ acc.add(d); st.push(d); } } return acc; }
function descendants(id){ const acc = new Set(), st = [id];
  while (st.length){ const x = st.pop(); for (const t of T()) if (t.deps.includes(x) && !acc.has(t.id)){ acc.add(t.id); st.push(t.id); } } return acc; }
const children = id => T().filter(t => t.deps.includes(id));
// Ajouter "dep" comme prérequis de "id" crée un cycle si dep dépend déjà (transitivement) de id
const wouldCycle = (id, dep) => id === dep || ancestors(dep).has(id);

/* ---------- Mise en page du graphe ----------
   Axe horizontal = temps : le bord droit de chaque activité tombe sur son échéance.
   Les activités qui se chevauchent dans le temps sont empilées ; celles sans échéance vont à droite. */
const NW = 196, NH = 84, GY = 14, PAD = 24, TOP = 28, DAY = 30;
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
function layout(){
  const dated = T().filter(t => t.due).sort((a, b) => a.due.localeCompare(b.due) || a.id - b.id);
  const undated = T().filter(t => !t.due);
  let min = iso(TODAY), max = iso(TODAY);
  dated.forEach(t => { if (t.due < min) min = t.due; if (t.due > max) max = t.due; });
  min = addDays(min, -Math.ceil(NW / DAY) - 1); max = addDays(max, 3);
  const X = s => PAD + (diffDays(min, s) + 1) * DAY;      // fin de la journée s
  const laneEnd = [], laneOf = {}, xy = {};
  for (const t of dated){
    const right = X(t.due) - (isMs(t) ? DAY / 2 : 0), left = right - NW;   // un jalon pointe sur le milieu du jour
    const free = l => laneEnd[l] == null || laneEnd[l] + 10 <= left;
    // on garde si possible la ligne d'un prérequis, pour des flèches plus droites
    let lane = t.deps.map(d => laneOf[d]).find(l => l != null && free(l));
    if (lane == null){ lane = 0; while (!free(lane)) lane++; }
    laneEnd[lane] = right; laneOf[t.id] = lane;
    xy[t.id] = {x: left, y: TOP + lane * (NH + GY)};
  }
  const axisEnd = X(max) + PAD;
  const ux = undated.length ? axisEnd + 48 : null;
  undated.forEach((t, i) => xy[t.id] = {x: ux, y: TOP + i * (NH + GY)});
  const rows = Math.max(laneEnd.length, undated.length, 1);
  const axisY = TOP + rows * (NH + GY) - GY + 18;
  return {xy, min, max, X, axisY, axisEnd, ux, w: ux != null ? ux + NW + PAD : axisEnd, h: axisY + 50};
}

function drawAxis(L){
  const {min, max, X, axisY, axisEnd, ux} = L;
  let out = '';
  const days = diffDays(min, max) + 1;
  for (let i = 0; i < days; i++){
    const d = addDays(min, i), dt = parse(d), x0 = X(d) - DAY, wd = dt.getDay();
    if (wd === 0 || wd === 6) out += `<rect class="ax-we" x="${x0}" y="${TOP - 10}" width="${DAY}" height="${axisY - TOP + 10}"/>`;
  }
  const tx = X(iso(TODAY)) - DAY / 2;
  out += `<line class="ax-today" x1="${tx}" x2="${tx}" y1="${TOP - 8}" y2="${axisY}"/>
    <text class="ax-todaylbl" x="${tx}" y="${TOP - 13}" text-anchor="middle">Aujourd'hui</text>`;
  for (const t of T()){
    const p = L.xy[t.id];
    if (isMs(t) && t.due && p) out += `<line class="ax-ms ${state(t)}" x1="${p.x + NW}" x2="${p.x + NW}" y1="${p.y + NH / 2}" y2="${axisY}"/>
      <path class="ax-ms-mark ${state(t)}" d="M${p.x + NW} ${axisY - 6} l6 6 l-6 6 l-6 -6 z"/>`;
  }
  if (selected){
    const t = byId(selected), p = L.xy[selected];
    if (t && t.due && p) out += `<line class="ax-guide" x1="${p.x + NW}" x2="${p.x + NW}" y1="${p.y + NH}" y2="${axisY}"/>`;
  }
  out += `<line class="ax-line" x1="${PAD}" x2="${axisEnd - PAD / 2}" y1="${axisY}" y2="${axisY}"/>`;
  for (let i = 0; i < days; i++){
    const d = addDays(min, i), dt = parse(d), xc = X(d) - DAY / 2, first = dt.getDate() === 1 || i === 0;
    out += `<line class="ax-tick" x1="${X(d) - DAY}" x2="${X(d) - DAY}" y1="${axisY}" y2="${axisY + (first ? 30 : 5)}"/>`;
    out += `<text class="ax-day ${dt.getDay() % 6 === 0 ? 'we' : ''} ${d === iso(TODAY) ? 'now' : ''}" x="${xc}" y="${axisY + 17}" text-anchor="middle">${dt.getDate()}</text>`;
    if (first) out += `<text class="ax-month" x="${X(d) - DAY + 5}" y="${axisY + 40}">${esc(dt.toLocaleDateString('fr-FR', {month:'long', year:'numeric'}))}</text>`;
  }
  if (ux != null) out += `<line class="ax-sep" x1="${ux - 24}" x2="${ux - 24}" y1="${TOP - 10}" y2="${axisY}"/>
    <text class="ax-todaylbl ax-none" x="${ux}" y="${TOP - 13}">Sans échéance</text>`;
  return out;
}

function wrap(text, max = 25){
  const words = text.split(/\s+/), lines = [];
  let cur = '';
  for (const w of words){
    if ((cur + ' ' + w).trim().length > max && cur){ lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  if (lines.length > 2){ lines.length = 2; lines[1] = lines[1].slice(0, max - 1) + '…'; }
  return lines.map(l => l.length > max ? l.slice(0, max - 1) + '…' : l);
}

function drawGraph(){
  const svg = document.getElementById('g');
  if (!T().length){ svg.setAttribute('width', 360); svg.setAttribute('height', 120);
    svg.innerHTML = `<text x="28" y="60" class="title" style="fill:var(--muted);font:14px var(--f-ui)">Aucune tâche. Ajoutez-en une à gauche.</text>`; return; }
  const L = layout(), {xy, w, h} = L;
  const anc = selected ? ancestors(selected) : new Set(), desc = selected ? descendants(selected) : new Set();
  const chain = selected ? new Set([selected, ...anc, ...desc]) : null;
  svg.setAttribute('width', w); svg.setAttribute('height', h); svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.classList.toggle('focus', !!chain);
  svg.classList.toggle('filter', !!who);
  let out = `<defs>${['ok','wait','hi','bad'].map(k => `<marker id="m-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" class="mk-${k}"/></marker>`).join('')}</defs>` + drawAxis(L);
  for (const t of T()) for (const d of t.deps){
    const a = xy[d], b = xy[t.id]; if (!a || !b) continue;
    const x1 = a.x + NW, y1 = a.y + NH/2, x2 = b.x - 2, y2 = b.y + NH/2, c = Math.max(40, Math.abs(x2 - x1) / 2);
    const up = x => x === selected || anc.has(x), down = x => x === selected || desc.has(x);
    const hi = chain && ((up(d) && up(t.id)) || (down(d) && down(t.id)));
    const dd = byId(d), bad = dd.status !== 'done' && dd.due && t.due && dd.due > t.due;
    const k = hi ? 'hi' : bad ? 'bad' : (dd.status === 'done' ? 'ok' : 'wait');
    out += `<path class="edge ${k}" d="M${x1} ${y1}C${x1 + c} ${y1} ${x2 - c} ${y2} ${x2} ${y2}" marker-end="url(#m-${k})"/>`;
  }
  for (const t of T()){
    const {x, y} = xy[t.id], s = state(t);
    const ms = isMs(t);
    const lines = wrap(t.title, ms ? 22 : 25);
    const di = dueInfo(t);
    const own = (t.owner || '').trim();
    const ownTxt = own ? (own.length > 14 ? own.slice(0, 13) + '…' : own) : 'Non assignée';
    const dueTxt = t.due ? (di.cls === 'late' ? `⚠ ${fmtDate(t.due)}` : fmtDate(t.due)) : '—';
    const cls = ['node', s, ms ? 'ms' : '', t.id === selected ? 'sel' : '', chain && chain.has(t.id) ? 'chain' : '', mine(t) ? '' : 'other'].join(' ');
    const P = 26, flag = (o) => `M${8 - o} ${-o} H${NW - P + o * .4} L${NW + o * 1.4} ${NH / 2} L${NW - P + o * .4} ${NH + o} H${8 - o} Q${-o} ${NH + o} ${-o} ${NH - 8} V8 Q${-o} ${-o} ${8 - o} ${-o} Z`;
    const R = ms ? NW - P - 4 : NW - 12;   // bord droit utile pour le texte
    out += `<g class="${cls}" data-id="${t.id}" transform="translate(${x} ${y})" tabindex="0" role="button" aria-label="${ms ? 'Jalon ' : ''}${esc(t.title)} : ${lbl(t, s).toLowerCase()}, ${esc(own || 'non assignée')}, ${esc(di.txt)}">
      <title>${ms ? 'Jalon : ' : ''}${esc(t.title)}${t.description ? '\n\n' + esc(t.description) : ''}</title>
      ${ms ? `<path class="halo" d="${flag(5)}"/><path class="box" d="${flag(0)}"/>`
           : `<rect class="halo" x="-5" y="-5" width="${NW+10}" height="${NH+10}" rx="12"/><rect class="box" width="${NW}" height="${NH}" rx="8"/>`}
      <text class="tag" x="12" y="17">${tagTxt(t, s)}</text>
      ${ms ? '' : `<text class="num" x="${NW-12}" y="17" text-anchor="end">#${t.id}</text>`}
      ${lines.map((l,i) => `<text class="title" x="12" y="${lines.length === 1 ? 41 : 36 + i*16}">${esc(l)}</text>`).join('')}
      <line class="sep" x1="12" x2="${R}" y1="${NH-22}" y2="${NH-22}"/>
      <text class="meta ${own ? '' : 'none'}" x="12" y="${NH-8}">${esc(ownTxt)}</text>
      <text class="meta due ${di.cls}" x="${R}" y="${NH-8}" text-anchor="end">${esc(dueTxt)}</text>
    </g>`;
  }
  svg.innerHTML = out;
}

/* ---------- Vue Kanban ----------
   Alternative à la vue en séquence. Colonnes par statut (glisser = changer de statut)
   ou par personne (glisser = changer de responsable). */
const UI_KEY = 'graphe-taches-vue';
let view = 'seq', group = 'status', dragId = null;
try { const v = JSON.parse(lsGet(UI_KEY) || '{}'); if (v.view === 'kanban') view = 'kanban'; if (v.group === 'owner') group = 'owner'; } catch(e){}
const saveUi = () => lsSet(UI_KEY, JSON.stringify({ view, group }));
const ORDER = { doing: 0, ready: 1, blocked: 2, done: 3 };
const byDueId = (a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.id - b.id;
const initials = n => n.split(/[\s-]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');

function kanbanCols(){
  if (group === 'status') return [
    { key: 'blocked', label: 'Bloquées', dot: 'blocked', hint: 'En attente de prérequis' },
    { key: 'ready',   label: 'Prêtes',   dot: 'ready',   hint: 'Peuvent démarrer' },
    { key: 'doing',   label: 'En cours', dot: 'doing' },
    { key: 'done',    label: 'Faites',   dot: 'done' }
  ].map(c => ({ ...c, tasks: T().filter(t => state(t) === c.key).sort(byDueId) }));
  const sortOwner = (a, b) => ORDER[state(a)] - ORDER[state(b)] || byDueId(a, b);
  const cols = owners().map(o => ({ key: 'o:' + o, owner: o, label: o, tasks: T().filter(t => (t.owner || '').trim() === o).sort(sortOwner) }));
  cols.push({ key: 'o:', owner: '', label: 'Non assignée', tasks: T().filter(t => !(t.owner || '').trim()).sort(sortOwner) });
  return cols;
}
function kcard(t){
  const s = state(t), di = dueInfo(t);
  const blockers = t.deps.map(byId).filter(d => d && d.status !== 'done');
  const kids = children(t.id).length;
  const cls = ['kcard', s, isMs(t) ? 'ms' : '', t.id === selected ? 'sel' : '', mine(t) ? '' : 'other', isLate(t) ? 'late' : ''].join(' ');
  return `<article class="${cls}" data-id="${t.id}" draggable="true" tabindex="0" role="button"
      aria-label="${isMs(t) ? 'Jalon ' : ''}${esc(t.title)} : ${lbl(t, s).toLowerCase()}, ${esc(t.owner || 'non assignée')}, ${esc(di.txt)}">
    <div class="khead"><span class="ktag">${tagTxt(t, s)}</span><span class="knum">#${t.id}</span></div>
    <div class="ktitle">${esc(t.title)}</div>
    ${t.description ? `<p class="kdesc">${esc(t.description)}</p>` : ''}
    ${blockers.length && s !== 'done' ? `<div class="kblock">Attend : ${blockers.map(b => esc(b.title)).join(', ')}</div>` : ''}
    <div class="kmeta">
      ${group === 'owner' ? `<span class="klinks">${t.deps.length ? `${t.deps.length} prérequis` : ''}${t.deps.length && kids ? ' · ' : ''}${kids ? `débloque ${kids}` : ''}</span>`
                          : `<span class="kowner ${t.owner ? '' : 'none'}">${esc(t.owner || 'Non assignée')}</span>`}
      <span class="kdue ${di.cls}" title="${esc(di.txt)}">${t.due ? esc(di.cls === 'late' ? '⚠ ' + fmtDate(t.due) : di.cls === 'soon' ? di.txt : fmtDate(t.due)) : '—'}</span>
    </div>
  </article>`;
}
function drawKanban(){
  const el = document.getElementById('kanban');
  const cols = kanbanCols();
  el.classList.toggle('filter', !!who);
  el.innerHTML = cols.map(c => `
    <section class="kcol ${c.dot ? 'st-' + c.dot : 'by-owner'} ${group === 'owner' && who && c.owner !== who ? 'other' : ''}" data-col="${esc(c.key)}">
      <header>
        ${c.dot ? `<i class="dot ${c.dot}"></i>` : `<span class="avatar ${c.owner ? '' : 'none'}">${c.owner ? esc(initials(c.owner)) : '?'}</span>`}
        <h3>${esc(c.label)}</h3><b>${c.tasks.length}</b>
      </header>
      ${c.hint ? `<p class="khint">${c.hint}</p>` : ''}
      <div class="klist">${c.tasks.length ? c.tasks.map(kcard).join('') : '<p class="kempty">Aucune tâche</p>'}</div>
    </section>`).join('');
  document.getElementById('kbHelp').textContent = group === 'status'
    ? 'Glissez une carte vers une autre colonne pour changer son statut. Une tâche bloquée ne peut pas passer en cours tant que ses prérequis ne sont pas faits.'
    : 'Glissez une carte vers une autre colonne pour changer de responsable. Pour une nouvelle personne, saisissez son nom dans la fiche de la tâche.';
}
// Déplacer une carte : renvoie un message d'erreur si le déplacement est impossible
function moveTo(t, key){
  if (group === 'owner'){
    const owner = key.slice(2);
    if ((t.owner || '').trim() === owner) return null;
    t.owner = owner; return null;
  }
  const blockers = t.deps.map(byId).filter(d => d && d.status !== 'done');
  if (key === 'doing' && isMs(t))
    return `« ${t.title} » est un jalon : il n'a pas d'état « en cours ». Glissez-le dans Faites quand il est atteint.`;
  if ((key === 'doing' || key === 'done') && blockers.length)
    return `« ${t.title} » attend encore : ${blockers.map(b => b.title).join(', ')}.`;
  if (key === 'ready' && blockers.length)
    return `« ${t.title} » ne peut pas être prête : ses prérequis ne sont pas faits.`;
  if (key === 'blocked' && !blockers.length)
    return `« ${t.title} » n'a aucun prérequis en attente : elle ne peut pas être bloquée.`;
  t.status = key === 'doing' ? 'doing' : key === 'done' ? 'done' : 'todo';
  return null;
}
function drawMain(){ if (view === 'kanban') drawKanban(); else drawGraph(); }
function syncView(){
  const k = view === 'kanban';
  document.getElementById('canvas').hidden = k;
  document.getElementById('kanban').hidden = !k;
  document.getElementById('kbHelp').hidden = !k;
  document.getElementById('kbGroup').hidden = !k;
  document.querySelector('.graph').classList.toggle('is-kanban', k);
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', b.dataset.view === view));
  document.querySelectorAll('[data-group]').forEach(b => b.setAttribute('aria-pressed', b.dataset.group === group));
}
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => { view = b.dataset.view; saveUi(); render(); }));
document.querySelectorAll('[data-group]').forEach(b => b.addEventListener('click', () => { group = b.dataset.group; saveUi(); render(); }));

const kbEl = document.getElementById('kanban');
kbEl.addEventListener('click', e => {
  const c = e.target.closest('.kcard');
  if (c) select(+c.dataset.id); else if (e.target.closest('.kcol') && selected){ selected = null; render(); }
});
kbEl.addEventListener('keydown', e => {
  const c = e.target.closest('.kcard');
  if (c && (e.key === 'Enter' || e.key === ' ')){ e.preventDefault(); select(+c.dataset.id); document.querySelector(`.kcard[data-id="${c.dataset.id}"]`)?.focus(); }
});
kbEl.addEventListener('dragstart', e => {
  const c = e.target.closest('.kcard'); if (!c) return;
  dragId = +c.dataset.id;
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', c.dataset.id); } catch(err){}
  requestAnimationFrame(() => c.classList.add('dragging'));
});
kbEl.addEventListener('dragend', () => { dragId = null; kbEl.querySelectorAll('.dragging, .over').forEach(x => x.classList.remove('dragging', 'over')); });
kbEl.addEventListener('dragover', e => {
  const col = e.target.closest('.kcol'); if (!col || dragId == null) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'move';
  kbEl.querySelectorAll('.kcol.over').forEach(x => x !== col && x.classList.remove('over'));
  col.classList.add('over');
});
kbEl.addEventListener('dragleave', e => {
  const col = e.target.closest('.kcol');
  if (col && !col.contains(e.relatedTarget)) col.classList.remove('over');
});
kbEl.addEventListener('drop', e => {
  const col = e.target.closest('.kcol'); if (!col || dragId == null) return;
  e.preventDefault();
  const t = byId(dragId); dragId = null;
  if (!t) return;
  const err = moveTo(t, col.dataset.col);
  if (err){ render(); showToast(err, false); return; }
  selected = t.id; commit();
});

/* ---------- Panneau ---------- */
function setStatus(id, st){ const t = byId(id); if (!t) return; t.status = st; commit(); }
function select(id){ selected = selected === id ? null : id; render(); }

function listItem(t, action){
  const s = state(t);
  const di = dueInfo(t);
  return `<li><i class="dot ${s} ${isMs(t) ? 'dia' : ''}"></i><div class="tbody"><span class="tname" data-sel="${t.id}">${isMs(t) ? '<span class="ms-pfx">Jalon</span> ' : ''}${esc(t.title)}</span>
    <span class="tmeta">${esc(t.owner || 'Non assignée')} · <span class="${di.cls}">${esc(di.txt)}</span></span></div>${action}</li>`;
}
const byDue = (a, b) => (a.due || '9999') .localeCompare(b.due || '9999');

function renderFilters(){
  const list = owners();
  if (who && !list.includes(who)) who = '';
  document.getElementById('ownerList').innerHTML = list.map(o => `<option value="${esc(o)}"></option>`).join('');
  const f = document.getElementById('whoFilter');
  f.innerHTML = `<option value="">Tout le monde</option>` + list.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  f.value = who;
}

function renderSide(){
  const st = T().map(state);
  const c = k => st.filter(x => x === k).length;
  const total = T().length, done = c('done');
  const pct = total ? Math.round(done / total * 100) : 0;
  document.getElementById('barFill').style.width = pct + '%';
  document.getElementById('pct').textContent = `${done}/${total} · ${pct} %`;
  document.getElementById('counts').innerHTML =
    [['ready','Prêtes'],['doing','En cours'],['blocked','Bloquées'],['done','Faites']]
      .map(([k,l]) => `<div class="count c-${k}"><strong>${c(k)}</strong><span>${l}</span></div>`).join('');
  const late = T().filter(isLate).length;
  document.getElementById('lateCount').textContent = late ? `${late} en retard` : '';
  const nm = T().filter(t => isMs(t) && t.status !== 'done' && t.due).sort(byDue)[0];
  const nmEl = document.getElementById('nextMs');
  nmEl.hidden = !nm;
  if (nm){
    const n = daysLeft(nm.due);
    nmEl.innerHTML = `<span class="ms-ico" aria-hidden="true">◆</span> Prochain jalon : <button type="button" class="linkish" data-selms="${nm.id}">${esc(nm.title)}</button> · ${fmtDate(nm.due)} <b class="${n < 0 ? 'late' : n <= 3 ? 'soon' : ''}">${n < 0 ? `${-n} j de retard` : n === 0 ? "aujourd'hui" : `J-${n}`}</b>`;
  }
  renderFilters();
  const ready = T().filter(t => state(t) === 'ready' && mine(t)).sort(byDue), doing = T().filter(t => t.status === 'doing' && mine(t)).sort(byDue);
  document.getElementById('nReady').textContent = ready.length;
  document.getElementById('nDoing').textContent = doing.length;
  document.getElementById('readyList').innerHTML = ready.length
    ? ready.map(t => listItem(t, isMs(t) ? `<button class="btn" data-act="finish" data-id="${t.id}">Atteint</button>` : `<button class="btn" data-act="start" data-id="${t.id}">Démarrer</button>`)).join('')
    : `<p class="empty">${total && done === total ? 'Tout est terminé.' : 'Rien de disponible : terminez une tâche en cours.'}</p>`;
  document.getElementById('doingList').innerHTML = doing.length
    ? doing.map(t => listItem(t, `<button class="btn" data-act="finish" data-id="${t.id}">Terminer</button>`)).join('')
    : `<p class="empty">Aucune tâche en cours.</p>`;
  document.getElementById('addHint').textContent = selected && byId(selected)
    ? `La nouvelle tâche dépendra de « ${byId(selected).title} ».`
    : 'Astuce : sélectionnez d\'abord une tâche pour que la nouvelle en dépende.';
  renderDetail();
}

function renderDetail(){
  const el = document.getElementById('detail');
  const t = selected && byId(selected);
  if (!t){ el.innerHTML = `<h2>Tâche sélectionnée</h2><p class="empty">Cliquez une tâche dans le graphe ou le Kanban pour la modifier et gérer ses dépendances.</p>`; return; }
  const s = state(t);
  const blockers = t.deps.map(byId).filter(d => d && d.status !== 'done');
  const canProgress = blockers.length === 0;
  const options = T().filter(o => !t.deps.includes(o.id) && !wouldCycle(t.id, o.id));
  const kids = children(t.id);
  el.innerHTML = `
    <h2>${isMs(t) ? 'Jalon' : 'Tâche'} #${t.id} <b style="color:var(--${s})">${lbl(t, s)}</b></h2>
    <div class="seg seg-type" role="group" aria-label="Type">
      <button data-type="task" aria-pressed="${!isMs(t)}">Tâche</button>
      <button data-type="milestone" aria-pressed="${isMs(t)}">◆ Jalon</button>
    </div>
    <input type="text" id="editTitle" value="${esc(t.title)}" aria-label="Titre de la tâche">
    <div class="field"><label class="label" for="editDesc">Description</label><textarea id="editDesc" rows="3" placeholder="Contexte, livrable attendu, critères de fin…">${esc(t.description || '')}</textarea></div>
    <div class="grid2">
      <div><label class="label" for="editOwner">Responsable</label><input type="text" id="editOwner" list="ownerList" value="${esc(t.owner || '')}" placeholder="Non assignée" autocomplete="off"></div>
      <div><label class="label" for="editDue">Échéance</label><input type="date" id="editDue" value="${esc(t.due || '')}"></div>
    </div>
    ${isLate(t) ? `<p class="hint" style="color:var(--danger)">${esc(dueInfo(t).txt)}.</p>` : ''}
    ${lateDeps(t).length ? `<p class="hint warn">Échéance antérieure à celle de son prérequis : ${lateDeps(t).map(d => `${esc(d.title)} (${fmtDate(d.due)})`).join(', ')}.</p>` : ''}
    ${isMs(t) ? `<div class="seg seg-2w" role="group" aria-label="Statut du jalon">
      <button data-st="todo" aria-pressed="${t.status!=='done'}">À venir</button>
      <button data-st="done" aria-pressed="${t.status==='done'}" ${!canProgress && t.status!=='done' ? 'disabled' : ''}>Atteint</button>
    </div>` : `<div class="seg" role="group" aria-label="Statut">
      <button data-st="todo" aria-pressed="${t.status==='todo'}">À faire</button>
      <button data-st="doing" aria-pressed="${t.status==='doing'}" ${!canProgress && t.status!=='doing' ? 'disabled' : ''}>En cours</button>
      <button data-st="done" aria-pressed="${t.status==='done'}" ${!canProgress && t.status!=='done' ? 'disabled' : ''}>Faite</button>
    </div>`}
    ${isMs(t) && !t.due ? `<p class="hint warn">Donnez une date à ce jalon pour le placer sur l'axe de temps.</p>` : ''}
    ${blockers.length ? `<p class="hint warn">${isMs(t) ? 'Atteint quand ces tâches seront faites' : 'Bloquée par'} : ${blockers.map(b => esc(b.title)).join(', ')}.</p>` : ''}
    <div class="label">Dépend de</div>
    <div class="chips">${t.deps.length ? t.deps.map(byId).filter(Boolean).map(d =>
      `<span class="chip"><i class="dot ${state(d)}"></i><span data-sel="${d.id}">${esc(d.title)}</span><button data-undep="${d.id}" aria-label="Retirer la dépendance ${esc(d.title)}">×</button></span>`).join('') : '<span class="hint">Aucun prérequis.</span>'}</div>
    <select id="addDep" aria-label="Ajouter une dépendance" ${options.length ? '' : 'disabled'}>
      <option value="">${options.length ? '+ Ajouter un prérequis…' : 'Aucun prérequis possible (cycle)'}</option>
      ${options.map(o => `<option value="${o.id}">#${o.id} ${esc(o.title)}</option>`).join('')}
    </select>
    <div class="label">Débloque</div>
    <div class="chips">${kids.length ? kids.map(k => `<span class="chip" style="padding-right:9px"><i class="dot ${state(k)}"></i><span data-sel="${k.id}">${esc(k.title)}</span></span>`).join('') : '<span class="hint">Aucune tâche ne dépend de celle-ci.</span>'}</div>
    <div class="row"><button class="btn" data-act="deselect">Fermer</button><span class="kbd-hint">ou touche <kbd>Suppr</kbd></span><button class="btn danger" data-act="delete">Supprimer</button></div>`;
}

function render(){ syncView(); drawMain(); renderSide(); }
function commit(){ save(); render(); }

/* ---------- Événements ---------- */
document.getElementById('g').addEventListener('click', e => {
  const n = e.target.closest('.node');
  if (n) select(+n.dataset.id); else { selected = null; render(); }
});
document.getElementById('g').addEventListener('keydown', e => {
  const n = e.target.closest('.node'); if (n && (e.key === 'Enter' || e.key === ' ')){ e.preventDefault(); select(+n.dataset.id); }
});
document.querySelector('aside').addEventListener('click', e => {
  const sel = e.target.closest('[data-sel]'); if (sel){ selected = null; select(+sel.dataset.sel); return; }
  const st = e.target.closest('[data-st]'); if (st && !st.disabled){ setStatus(selected, st.dataset.st); return; }
  const ty = e.target.closest('[data-type]');
  if (ty){
    const t = byId(selected);
    if (ty.dataset.type === 'milestone'){ t.type = 'milestone'; if (t.status === 'doing') t.status = 'todo'; }
    else delete t.type;
    commit(); return;
  }
  const un = e.target.closest('[data-undep]'); if (un){ const t = byId(selected); t.deps = t.deps.filter(d => d !== +un.dataset.undep); commit(); return; }
  const a = e.target.closest('[data-act]'); if (!a) return;
  const act = a.dataset.act;
  if (act === 'start') setStatus(+a.dataset.id, 'doing');
  if (act === 'finish') setStatus(+a.dataset.id, 'done');
  if (act === 'deselect'){ selected = null; render(); }
  if (act === 'delete') deleteTask(selected);
});
document.querySelector('aside').addEventListener('change', e => {
  if (e.target.id === 'addDep' && e.target.value){ byId(selected).deps.push(+e.target.value); commit(); }
  if (e.target.id === 'editOwner'){ byId(selected).owner = e.target.value.trim(); commit(); }
  if (e.target.id === 'editDue'){ byId(selected).due = e.target.value; commit(); }
});
document.querySelector('aside').addEventListener('input', e => {
  if (e.target.id === 'editTitle'){ byId(selected).title = e.target.value || 'Sans titre'; save(); drawMain(); }
  if (e.target.id === 'editDesc'){ byId(selected).description = e.target.value; save(); drawMain(); }
});
document.getElementById('addForm').addEventListener('submit', e => {
  e.preventDefault();
  const inp = document.getElementById('newTitle'), title = inp.value.trim();
  if (!title){ inp.focus(); return; }
  const id = data.seq++;
  const ownEl = document.getElementById('newOwner'), dueEl = document.getElementById('newDue'), descEl = document.getElementById('newDesc');
  const msEl = document.getElementById('newMs');
  T().push({id, title, status:'todo', deps: selected && byId(selected) ? [selected] : [], owner: ownEl.value.trim(), due: dueEl.value, description: descEl.value.trim(), ...(msEl.checked ? {type:'milestone'} : {})});
  msEl.checked = false;
  inp.value = ''; dueEl.value = ''; descEl.value = ''; selected = id; commit();
});
document.getElementById('whoFilter').addEventListener('change', e => { who = e.target.value; render(); });
document.getElementById('nextMs').addEventListener('click', e => {
  const b = e.target.closest('[data-selms]'); if (!b) return;
  selected = +b.dataset.selms; render();
  document.querySelector(`#g [data-id="${b.dataset.selms}"], .kcard[data-id="${b.dataset.selms}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
});
/* ---------- Suppression d'une tâche (bouton ou touche Suppr), avec annulation ---------- */
let undo = null, toastTimer = null;
function deleteTask(id){
  const t = byId(id); if (!t) return;
  const saved = clone(t), pid = store.id;
  const dependents = T().filter(x => x.deps.includes(id)).map(x => x.id);
  data.tasks = T().filter(x => x.id !== id);
  T().forEach(x => x.deps = x.deps.filter(d => d !== id));
  if (selected === id) selected = null;
  commit();
  undo = () => {
    if (store.id !== pid || byId(id)) return;
    saved.deps = saved.deps.filter(d => byId(d));
    T().push(saved);
    dependents.forEach(x => { const k = byId(x); if (k && !k.deps.includes(id)) k.deps.push(id); });
    selected = id; commit();
  };
  showToast(`« ${t.title} » supprimée.`);
}
function showToast(text, canUndo = true){
  const el = document.getElementById('toast');
  el.querySelector('span').textContent = text;
  document.getElementById('toastUndo').hidden = !canUndo;
  if (!canUndo) undo = null;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 7000);
}
function hideToast(){ const el = document.getElementById('toast'); if (el) el.hidden = true; undo = null; }
function runUndo(){ const f = undo; hideToast(); if (f) f(); }
document.getElementById('toastUndo').addEventListener('click', runUndo);

const isTyping = el => !!(el && el.closest && el.closest('input, textarea, select, [contenteditable]'));
document.addEventListener('keydown', e => {
  if (e.key === 'Escape'){
    if (!document.getElementById('projMenu').hidden){
      if (armedDel){ armedDel = null; renderMenu(); menuEl.querySelector('button')?.focus(); return; }
      closeMenu(); document.getElementById('projBtn').focus(); return;
    }
    if (selected && !isTyping(e.target)){ selected = null; render(); }
    return;
  }
  if (isTyping(e.target) || e.altKey) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.metaKey && selected){
    e.preventDefault(); deleteTask(selected); return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && undo){ e.preventDefault(); runUndo(); }
});

/* ---------- Menu des projets ---------- */
const menuEl = document.getElementById('projMenu'), projBtn = document.getElementById('projBtn');
let armedDel = null;   // id du projet dont la suppression attend une confirmation
const plural = n => `${n} tâche${n > 1 ? 's' : ''}`;
function renderMenu(){
  const list = store.list.map(p => p.id === store.id ? summary(p.id, data) : p)
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  if (armedDel && !list.some(p => p.id === armedDel)) armedDel = null;
  document.getElementById('projCount').textContent = list.length;
  document.getElementById('projList').innerHTML = list.length ? list.map(p => p.id === armedDel ? `
    <li class="prow confirm">
      <span class="pconfirm">Supprimer « ${esc(p.name)} » et ${plural(p.total)} ? Action définitive.</span>
      <span class="pconfirm-actions">
        <button type="button" class="pc-cancel" data-pcancel>Annuler</button>
        <button type="button" class="pc-ok" data-pdelok="${esc(p.id)}">Supprimer</button>
      </span>
    </li>` : `
    <li class="prow"><button type="button" role="menuitem" class="popen" data-proj="${esc(p.id)}" ${p.id === store.id ? 'aria-current="true"' : ''}>
      <span class="pname">${esc(p.name)}</span>
      <span class="pstat">${p.done}/${p.total}</span>
      <span class="pbar"><i style="width:${p.total ? Math.round(p.done / p.total * 100) : 0}%"></i></span>
    </button><button type="button" class="pdel" data-pdel="${esc(p.id)}" aria-label="Supprimer le projet ${esc(p.name)}" title="Supprimer ce projet">
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M6.8 7v4M9.2 7v4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button></li>`).join('') : '<li class="empty">Aucun projet.</li>';
}
function openMenu(){
  armedDel = null; refreshList(); renderMenu();
  menuEl.hidden = false; projBtn.setAttribute('aria-expanded', 'true');
  (menuEl.querySelector('[aria-current]') || menuEl.querySelector('button'))?.focus();
}
function closeMenu(){ menuEl.hidden = true; projBtn.setAttribute('aria-expanded', 'false'); armedDel = null; }
function armDelete(id){
  armedDel = id; renderMenu();
  menuEl.querySelector('[data-pdelok]')?.focus();
}
projBtn.addEventListener('click', () => menuEl.hidden ? openMenu() : closeMenu());
document.addEventListener('click', e => {
  // un élément du menu re-dessiné n'est plus dans la page : ce n'est pas un clic extérieur
  if (!menuEl.hidden && e.target.isConnected && !e.target.closest('.proj')) closeMenu();
});
menuEl.addEventListener('click', async e => {
  const p = e.target.closest('[data-proj]');
  if (p){ closeMenu(); if (p.dataset.proj !== store.id) await openProject(p.dataset.proj); return; }
  const d = e.target.closest('[data-pdel]');
  if (d){ armDelete(d.dataset.pdel); return; }
  if (e.target.closest('[data-pcancel]')){
    const id = armedDel; armedDel = null; renderMenu();
    menuEl.querySelector(`[data-pdel="${CSS.escape(id || '')}"]`)?.focus();
    return;
  }
  const ok = e.target.closest('[data-pdelok]');
  if (ok){
    const id = ok.dataset.pdelok, current = id === store.id;
    armedDel = null;
    if (current) closeMenu();
    await deleteProject(id);
    if (!current){ renderMenu(); (menuEl.querySelector('[aria-current]') || menuEl.querySelector('button'))?.focus(); }
    setSync('Projet supprimé.');
    return;
  }
  const a = e.target.closest('[data-pact]'); if (!a) return;
  if (a.dataset.pact === 'new'){
    closeMenu(); await createProject(blankProject());
    const n = document.getElementById('projectName'); n.focus(); n.select();
  }
  if (a.dataset.pact === 'sample'){ closeMenu(); await createProject(clone(SAMPLE)); }
  if (a.dataset.pact === 'delete') armDelete(store.id);
});
menuEl.addEventListener('keydown', e => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = [...menuEl.querySelectorAll('button')], i = items.indexOf(document.activeElement);
  items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
});

const nameEl = document.getElementById('projectName');
nameEl.addEventListener('input', () => { data.name = nameEl.value; save(); });

boot();
