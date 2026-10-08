const KEY = 'graphe-taches-v2';
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
    {id:1, title:'Cadrage du besoin', status:'done', deps:[], owner:'Claire', due:inDays(-10)},
    {id:2, title:"Choix de l'hébergeur", status:'done', deps:[1], owner:'Lucas', due:inDays(-5)},
    {id:3, title:'Maquettes des pages', status:'doing', deps:[1], owner:'Mehdi', due:inDays(2)},
    {id:4, title:'Rédaction des contenus', status:'todo', deps:[1], owner:'Sophie', due:inDays(-1)},
    {id:5, title:'Charte graphique', status:'todo', deps:[3], owner:'Mehdi', due:inDays(6)},
    {id:6, title:'Intégration HTML/CSS', status:'todo', deps:[3,5], owner:'Lucas', due:inDays(5)},
    {id:7, title:'Configuration du DNS', status:'todo', deps:[2], owner:'Lucas', due:inDays(4)},
    {id:8, title:'Intégration des contenus', status:'todo', deps:[4,6], owner:'Sophie', due:inDays(16)},
    {id:9, title:'Recette', status:'todo', deps:[7,8], owner:'Claire', due:inDays(20)},
    {id:10, title:'Mise en ligne', status:'todo', deps:[9], owner:'Claire', due:inDays(23)}
  ]
};
let who = '';
const owners = () => [...new Set(T().map(t => (t.owner || '').trim()).filter(Boolean))].sort((a,b) => a.localeCompare(b, 'fr'));
const mine = t => !who || (t.owner || '') === who;
// Prérequis dont l'échéance tombe après celle de la tâche : planning incohérent
const lateDeps = t => t.due ? t.deps.map(byId).filter(d => d && d.due && d.status !== 'done' && d.due > t.due) : [];
const LABEL = {ready:'PRÊTE', doing:'EN COURS', blocked:'BLOQUÉE', done:'FAITE'};

let data = loadLocal() || clone(SAMPLE);
let selected = null;

function clone(o){ return JSON.parse(JSON.stringify(o)); }

/* ---------- Stockage ----------
   Mode "server" : si l'API /api/project répond, les données sont partagées sur le serveur
   (contrôle de version optimiste : en cas de conflit, la version du serveur gagne).
   Mode "local"  : sinon (ex. GitHub Pages), stockage dans le navigateur. */
const store = { mode: 'local', version: 0, timer: null, saving: false, again: false, dirty: false };

function loadLocal(){ try { const s = localStorage.getItem(KEY); return s ? JSON.parse(s) : null; } catch(e){ return null; } }
function setSync(text, warn){
  const el = document.getElementById('syncNote');
  if (el){ el.textContent = text; el.style.color = warn ? 'var(--doing)' : ''; }
}
function save(){
  if (store.mode !== 'server'){ try { localStorage.setItem(KEY, JSON.stringify(data)); } catch(e){} return; }
  store.dirty = true;
  setSync('Enregistrement…');
  clearTimeout(store.timer);
  store.timer = setTimeout(pushServer, 500);
}
async function pushServer(){
  if (store.saving){ store.again = true; return; }
  store.saving = true;
  try {
    const r = await fetch('api/project', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': String(store.version) },
      body: JSON.stringify(data)
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 409){
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
// Récupère les modifications des autres utilisateurs (sauf pendant une saisie)
async function poll(){
  if (store.mode !== 'server' || store.dirty || store.saving || document.hidden) return;
  if (document.activeElement && document.activeElement.matches('input, select')) return;
  try {
    const r = await fetch('api/project', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    if (j.version !== store.version && j.data && !store.dirty){ store.version = j.version; data = j.data; refreshAll(); }
  } catch(e){}
}
function refreshAll(){
  if (selected && !byId(selected)) selected = null;
  document.getElementById('projectName').value = data.name || '';
  render();
}
async function boot(){
  try {
    const r = await fetch('api/project', { cache: 'no-store' });
    if (!r.ok) throw new Error();
    const j = await r.json();
    store.mode = 'server';
    store.version = j.version;
    if (j.data) data = j.data; else save();   // serveur vide : on l'initialise avec l'exemple
    setSync('Enregistré sur le serveur');
    setInterval(poll, 10000);
    document.addEventListener('visibilitychange', poll);
  } catch(e){
    setSync('Enregistré dans ce navigateur uniquement.');
  }
  refreshAll();
}
const T = () => data.tasks;
const byId = id => T().find(t => t.id === id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function state(t){
  if (t.status === 'done') return 'done';
  if (t.status === 'doing') return 'doing';
  return t.deps.every(d => byId(d)?.status === 'done') ? 'ready' : 'blocked';
}
function ancestors(id){ const acc = new Set(), st = [id];
  while (st.length){ const t = byId(st.pop()); if (!t) continue; for (const d of t.deps) if (!acc.has(d)){ acc.add(d); st.push(d); } } return acc; }
function descendants(id){ const acc = new Set(), st = [id];
  while (st.length){ const x = st.pop(); for (const t of T()) if (t.deps.includes(x) && !acc.has(t.id)){ acc.add(t.id); st.push(t.id); } } return acc; }
const children = id => T().filter(t => t.deps.includes(id));
// Ajouter "dep" comme prérequis de "id" crée un cycle si dep dépend déjà (transitivement) de id
const wouldCycle = (id, dep) => id === dep || ancestors(dep).has(id);

/* ---------- Mise en page du graphe ---------- */
const NW = 210, NH = 84, GX = 64, GY = 18, PAD = 28;
function layout(){
  const rank = {};
  const r = id => { if (rank[id] != null) return rank[id]; rank[id] = 0;
    const t = byId(id); let m = 0; for (const d of t.deps) if (byId(d)) m = Math.max(m, r(d) + 1); return rank[id] = m; };
  T().forEach(t => r(t.id));
  const cols = [];
  T().forEach(t => (cols[rank[t.id]] ||= []).push(t.id));
  const pos = {};
  const idx = () => cols.forEach(c => c.forEach((id, i) => pos[id] = i));
  idx();
  const bary = (ids, fn) => { const v = ids.map(x => pos[x]).filter(x => x != null); return v.length ? v.reduce((a,b)=>a+b,0)/v.length : null; };
  for (let pass = 0; pass < 4; pass++){
    for (let c = 1; c < cols.length; c++){
      cols[c].sort((a,b) => (bary(byId(a).deps) ?? pos[a]) - (bary(byId(b).deps) ?? pos[b])); idx();
    }
    for (let c = cols.length - 2; c >= 0; c--){
      cols[c].sort((a,b) => (bary(children(a).map(t=>t.id)) ?? pos[a]) - (bary(children(b).map(t=>t.id)) ?? pos[b])); idx();
    }
  }
  const maxRows = Math.max(1, ...cols.map(c => c.length));
  const H = maxRows * (NH + GY) - GY;
  const xy = {};
  cols.forEach((c, ci) => { const off = (H - (c.length * (NH + GY) - GY)) / 2;
    c.forEach((id, i) => xy[id] = {x: PAD + ci * (NW + GX), y: PAD + off + i * (NH + GY)}); });
  return {xy, w: PAD*2 + cols.length * (NW + GX) - GX, h: PAD*2 + H};
}

function wrap(text, max = 27){
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
  const {xy, w, h} = layout();
  const anc = selected ? ancestors(selected) : new Set(), desc = selected ? descendants(selected) : new Set();
  const chain = selected ? new Set([selected, ...anc, ...desc]) : null;
  svg.setAttribute('width', w); svg.setAttribute('height', h); svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.classList.toggle('focus', !!chain);
  svg.classList.toggle('filter', !!who);
  let out = `<defs>${['ok','wait','hi'].map(k => `<marker id="m-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" class="mk-${k}"/></marker>`).join('')}</defs>`;
  for (const t of T()) for (const d of t.deps){
    const a = xy[d], b = xy[t.id]; if (!a || !b) continue;
    const x1 = a.x + NW, y1 = a.y + NH/2, x2 = b.x - 2, y2 = b.y + NH/2, mx = (x1 + x2) / 2;
    const up = x => x === selected || anc.has(x), down = x => x === selected || desc.has(x);
    const hi = chain && ((up(d) && up(t.id)) || (down(d) && down(t.id)));
    const k = hi ? 'hi' : (byId(d).status === 'done' ? 'ok' : 'wait');
    out += `<path class="edge ${k}" d="M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}" marker-end="url(#m-${k})"/>`;
  }
  for (const t of T()){
    const {x, y} = xy[t.id], s = state(t);
    const lines = wrap(t.title);
    const di = dueInfo(t);
    const own = (t.owner || '').trim();
    const ownTxt = own ? (own.length > 14 ? own.slice(0, 13) + '…' : own) : 'Non assignée';
    const dueTxt = t.due ? (di.cls === 'late' ? `⚠ ${fmtDate(t.due)}` : fmtDate(t.due)) : '—';
    const cls = ['node', s, t.id === selected ? 'sel' : '', chain && chain.has(t.id) ? 'chain' : '', mine(t) ? '' : 'other'].join(' ');
    out += `<g class="${cls}" data-id="${t.id}" transform="translate(${x} ${y})" tabindex="0" role="button" aria-label="${esc(t.title)} : ${LABEL[s].toLowerCase()}, ${esc(own || 'non assignée')}, ${esc(di.txt)}">
      <rect class="halo" x="-5" y="-5" width="${NW+10}" height="${NH+10}" rx="12"/>
      <rect class="box" width="${NW}" height="${NH}" rx="8"/>
      <text class="tag" x="12" y="17">${LABEL[s]}</text>
      <text class="num" x="${NW-12}" y="17" text-anchor="end">#${t.id}</text>
      ${lines.map((l,i) => `<text class="title" x="12" y="${lines.length === 1 ? 41 : 36 + i*16}">${esc(l)}</text>`).join('')}
      <line class="sep" x1="12" x2="${NW-12}" y1="${NH-22}" y2="${NH-22}"/>
      <text class="meta ${own ? '' : 'none'}" x="12" y="${NH-8}">${esc(ownTxt)}</text>
      <text class="meta due ${di.cls}" x="${NW-12}" y="${NH-8}" text-anchor="end">${esc(dueTxt)}</text>
    </g>`;
  }
  svg.innerHTML = out;
}

/* ---------- Panneau ---------- */
function setStatus(id, st){ const t = byId(id); if (!t) return; t.status = st; commit(); }
function select(id){ selected = selected === id ? null : id; render(); }

function listItem(t, action){
  const s = state(t);
  const di = dueInfo(t);
  return `<li><i class="dot ${s}"></i><div class="tbody"><span class="tname" data-sel="${t.id}">${esc(t.title)}</span>
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
  renderFilters();
  const ready = T().filter(t => state(t) === 'ready' && mine(t)).sort(byDue), doing = T().filter(t => t.status === 'doing' && mine(t)).sort(byDue);
  document.getElementById('nReady').textContent = ready.length;
  document.getElementById('nDoing').textContent = doing.length;
  document.getElementById('readyList').innerHTML = ready.length
    ? ready.map(t => listItem(t, `<button class="btn" data-act="start" data-id="${t.id}">Démarrer</button>`)).join('')
    : `<p class="empty">${total && done === total ? 'Tout est terminé.' : 'Rien de disponible : terminez une tâche en cours.'}</p>`;
  document.getElementById('doingList').innerHTML = doing.length
    ? doing.map(t => listItem(t, `<button class="btn" data-act="finish" data-id="${t.id}">Terminer</button>`)).join('')
    : `<p class="empty">Aucune tâche en cours.</p>`;
  document.getElementById('addHint').textContent = selected && byId(selected)
    ? `La nouvelle tâche dépendra de « ${byId(selected).title} ».`
    : 'Astuce : sélectionnez d\'abord une tâche pour que la nouvelle en dépende.';
  renderDetail();
}

let armedDelete = false;
function renderDetail(){
  const el = document.getElementById('detail');
  const t = selected && byId(selected);
  if (!t){ el.innerHTML = `<h2>Tâche sélectionnée</h2><p class="empty">Cliquez une tâche dans le graphe pour la modifier et gérer ses dépendances.</p>`; return; }
  const s = state(t);
  const blockers = t.deps.map(byId).filter(d => d && d.status !== 'done');
  const canProgress = blockers.length === 0;
  const options = T().filter(o => !t.deps.includes(o.id) && !wouldCycle(t.id, o.id));
  const kids = children(t.id);
  el.innerHTML = `
    <h2>Tâche #${t.id} <b style="color:var(--${s})">${LABEL[s]}</b></h2>
    <input type="text" id="editTitle" value="${esc(t.title)}" aria-label="Titre de la tâche">
    <div class="grid2">
      <div><label class="label" for="editOwner">Responsable</label><input type="text" id="editOwner" list="ownerList" value="${esc(t.owner || '')}" placeholder="Non assignée" autocomplete="off"></div>
      <div><label class="label" for="editDue">Échéance</label><input type="date" id="editDue" value="${esc(t.due || '')}"></div>
    </div>
    ${isLate(t) ? `<p class="hint" style="color:var(--danger)">${esc(dueInfo(t).txt)}.</p>` : ''}
    ${lateDeps(t).length ? `<p class="hint warn">Échéance antérieure à celle de son prérequis : ${lateDeps(t).map(d => `${esc(d.title)} (${fmtDate(d.due)})`).join(', ')}.</p>` : ''}
    <div class="seg" role="group" aria-label="Statut">
      <button data-st="todo" aria-pressed="${t.status==='todo'}">À faire</button>
      <button data-st="doing" aria-pressed="${t.status==='doing'}" ${!canProgress && t.status!=='doing' ? 'disabled' : ''}>En cours</button>
      <button data-st="done" aria-pressed="${t.status==='done'}" ${!canProgress && t.status!=='done' ? 'disabled' : ''}>Faite</button>
    </div>
    ${blockers.length ? `<p class="hint warn">Bloquée par : ${blockers.map(b => esc(b.title)).join(', ')}.</p>` : ''}
    <div class="label">Dépend de</div>
    <div class="chips">${t.deps.length ? t.deps.map(byId).filter(Boolean).map(d =>
      `<span class="chip"><i class="dot ${state(d)}"></i><span data-sel="${d.id}">${esc(d.title)}</span><button data-undep="${d.id}" aria-label="Retirer la dépendance ${esc(d.title)}">×</button></span>`).join('') : '<span class="hint">Aucun prérequis.</span>'}</div>
    <select id="addDep" aria-label="Ajouter une dépendance" ${options.length ? '' : 'disabled'}>
      <option value="">${options.length ? '+ Ajouter un prérequis…' : 'Aucun prérequis possible (cycle)'}</option>
      ${options.map(o => `<option value="${o.id}">#${o.id} ${esc(o.title)}</option>`).join('')}
    </select>
    <div class="label">Débloque</div>
    <div class="chips">${kids.length ? kids.map(k => `<span class="chip" style="padding-right:9px"><i class="dot ${state(k)}"></i><span data-sel="${k.id}">${esc(k.title)}</span></span>`).join('') : '<span class="hint">Aucune tâche ne dépend de celle-ci.</span>'}</div>
    <div class="row"><button class="btn" data-act="deselect">Fermer</button><button class="btn danger ${armedDelete ? 'armed' : ''}" data-act="delete">${armedDelete ? 'Confirmer la suppression' : 'Supprimer'}</button></div>`;
}

function render(){ drawGraph(); renderSide(); }
function commit(){ save(); render(); }

/* ---------- Événements ---------- */
document.getElementById('g').addEventListener('click', e => {
  const n = e.target.closest('.node'); armedDelete = false;
  if (n) select(+n.dataset.id); else { selected = null; render(); }
});
document.getElementById('g').addEventListener('keydown', e => {
  const n = e.target.closest('.node'); if (n && (e.key === 'Enter' || e.key === ' ')){ e.preventDefault(); select(+n.dataset.id); }
});
document.querySelector('aside').addEventListener('click', e => {
  const sel = e.target.closest('[data-sel]'); if (sel){ selected = null; armedDelete = false; select(+sel.dataset.sel); return; }
  const st = e.target.closest('[data-st]'); if (st && !st.disabled){ setStatus(selected, st.dataset.st); return; }
  const un = e.target.closest('[data-undep]'); if (un){ const t = byId(selected); t.deps = t.deps.filter(d => d !== +un.dataset.undep); commit(); return; }
  const a = e.target.closest('[data-act]'); if (!a) return;
  const act = a.dataset.act;
  if (act === 'start') setStatus(+a.dataset.id, 'doing');
  if (act === 'finish') setStatus(+a.dataset.id, 'done');
  if (act === 'deselect'){ selected = null; armedDelete = false; render(); }
  if (act === 'delete'){
    if (!armedDelete){ armedDelete = true; renderDetail(); return; }
    data.tasks = T().filter(t => t.id !== selected);
    T().forEach(t => t.deps = t.deps.filter(d => d !== selected));
    selected = null; armedDelete = false; commit();
  }
});
document.querySelector('aside').addEventListener('change', e => {
  if (e.target.id === 'addDep' && e.target.value){ byId(selected).deps.push(+e.target.value); commit(); }
  if (e.target.id === 'editOwner'){ byId(selected).owner = e.target.value.trim(); commit(); }
  if (e.target.id === 'editDue'){ byId(selected).due = e.target.value; commit(); }
});
document.querySelector('aside').addEventListener('input', e => {
  if (e.target.id === 'editTitle'){ byId(selected).title = e.target.value || 'Sans titre'; save(); drawGraph(); }
});
document.getElementById('addForm').addEventListener('submit', e => {
  e.preventDefault();
  const inp = document.getElementById('newTitle'), title = inp.value.trim();
  if (!title){ inp.focus(); return; }
  const id = data.seq++;
  const ownEl = document.getElementById('newOwner'), dueEl = document.getElementById('newDue');
  T().push({id, title, status:'todo', deps: selected && byId(selected) ? [selected] : [], owner: ownEl.value.trim(), due: dueEl.value});
  inp.value = ''; dueEl.value = ''; selected = id; armedDelete = false; commit();
});
document.getElementById('whoFilter').addEventListener('change', e => { who = e.target.value; render(); });
const nameEl = document.getElementById('projectName');
nameEl.value = data.name;
nameEl.addEventListener('input', () => { data.name = nameEl.value; save(); });
let armedReset = false;
const resetBtn = document.getElementById('resetBtn');
resetBtn.addEventListener('click', () => {
  if (!armedReset){ armedReset = true; resetBtn.textContent = 'Confirmer : tout remplacer'; resetBtn.classList.add('armed');
    setTimeout(() => { armedReset = false; resetBtn.textContent = "Recharger l'exemple"; resetBtn.classList.remove('armed'); }, 4000); return; }
  data = clone(SAMPLE); selected = null; nameEl.value = data.name; armedReset = false;
  resetBtn.textContent = "Recharger l'exemple"; resetBtn.classList.remove('armed'); commit();
});

boot();
