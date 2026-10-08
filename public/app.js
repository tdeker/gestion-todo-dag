const KEY = 'graphe-taches-v3';
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
    {id:1, title:'Cadrage du besoin', status:'done', deps:[], owner:'Claire', start:inDays(-14), due:inDays(-10)},
    {id:2, title:"Choix de l'hébergeur", status:'done', deps:[1], owner:'Lucas', start:inDays(-9), due:inDays(-5)},
    {id:3, title:'Maquettes des pages', status:'doing', deps:[1], owner:'Mehdi', start:inDays(-6), due:inDays(2)},
    {id:4, title:'Rédaction des contenus', status:'todo', deps:[1], owner:'Sophie', start:inDays(-8), due:inDays(-1)},
    {id:5, title:'Charte graphique', status:'todo', deps:[3], owner:'Mehdi', start:inDays(3), due:inDays(6)},
    {id:6, title:'Intégration HTML/CSS', status:'todo', deps:[3,5], owner:'Lucas', start:inDays(1), due:inDays(5)},
    {id:7, title:'Configuration du DNS', status:'todo', deps:[2], owner:'Lucas', start:inDays(1), due:inDays(4)},
    {id:8, title:'Intégration des contenus', status:'todo', deps:[4,6], owner:'Sophie', start:inDays(10), due:inDays(16)},
    {id:9, title:'Recette', status:'todo', deps:[7,8], owner:'Claire', start:inDays(17), due:inDays(20)},
    {id:10, title:'Mise en ligne', status:'todo', deps:[9], owner:'Claire', start:inDays(22), due:inDays(23)}
  ]
};
let who = '';
const owners = () => [...new Set(T().map(t => (t.owner || '').trim()).filter(Boolean))].sort((a,b) => a.localeCompare(b, 'fr'));
const mine = t => !who || (t.owner || '') === who;
// Prérequis dont l'échéance tombe après celle de la tâche : planning incohérent
const lateDeps = t => t.due ? t.deps.map(byId).filter(d => d && d.due && d.status !== 'done' && d.due > t.due) : [];
// Début prévu avant (ou le jour de) l'échéance d'un prérequis non terminé
const earlyStart = t => t.start ? t.deps.map(byId).filter(d => d && d.due && d.status !== 'done' && d.due >= t.start) : [];
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

/* ---------- Ligne de temps ----------
   Une barre va du début à l'échéance (incluse). Sans date de début, la barre dure un jour.
   Glisser = déplacer, bords = changer début / échéance. */
const TL = { zoom: 'day', drag: null, scrolled: false, min: null, px: 34 };
const ZOOM = { day: 34, week: 14 };
const ROW = 34, HEAD = 46;
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
const fmtLong = s => parse(s).toLocaleDateString('fr-FR', {weekday:'short', day:'numeric', month:'short'});
function span(t){
  const e = t.due || t.start;
  if (!e) return null;
  return { s: t.start && t.start <= e ? t.start : e, e };
}
function tlRows(){
  const rank = {};
  const r = id => { if (rank[id] != null) return rank[id]; rank[id] = 0;
    let m = 0; for (const d of byId(id).deps) if (byId(d)) m = Math.max(m, r(d) + 1); return rank[id] = m; };
  T().forEach(t => r(t.id));
  return [...T()].sort((a, b) => {
    const sa = span(a), sb = span(b);
    if (!!sa !== !!sb) return sa ? -1 : 1;              // tâches non planifiées en bas
    if (sa && sb && sa.s !== sb.s) return sa.s.localeCompare(sb.s);
    return rank[a.id] - rank[b.id] || a.id - b.id;
  });
}

function drawTimeline(){
  const svg = document.getElementById('tl'), labels = document.getElementById('tlLabels');
  const px = TL.px = ZOOM[TL.zoom];
  const rows = tlRows();
  let min = iso(TODAY), max = iso(TODAY);
  rows.forEach(t => { const sp = span(t); if (!sp) return; if (sp.s < min) min = sp.s; if (sp.e > max) max = sp.e; });
  min = addDays(min, TL.zoom === 'week' ? -7 : -3); max = addDays(max, TL.zoom === 'week' ? 21 : 7);
  TL.min = min;
  const days = diffDays(min, max) + 1, W = days * px, H = HEAD + Math.max(rows.length, 1) * ROW + 6;
  const X = s => diffDays(min, s) * px;
  const rowY = {}; rows.forEach((t, i) => rowY[t.id] = HEAD + i * ROW);
  const anc = selected ? ancestors(selected) : new Set(), desc = selected ? descendants(selected) : new Set();
  const chain = selected ? new Set([selected, ...anc, ...desc]) : null;
  svg.setAttribute('width', W); svg.setAttribute('height', H); svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.classList.toggle('focus', !!chain);
  svg.classList.toggle('filter', !!who);

  let out = `<defs><marker id="tm-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" class="mk-wait"/></marker>
    <marker id="tm-hi" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" class="mk-hi"/></marker>
    <marker id="tm-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" class="mk-bad"/></marker></defs>`;
  // Fond : week-ends, mois, jours
  for (let i = 0; i < days; i++){
    const d = addDays(min, i), dt = parse(d), x = i * px, wd = dt.getDay();
    if (wd === 0 || wd === 6) out += `<rect class="tl-weekend" x="${x}" y="${HEAD - 18}" width="${px}" height="${H - HEAD + 18}"/>`;
    if (i === 0 || dt.getDate() === 1){
      out += `<line class="tl-monthline" x1="${x}" x2="${x}" y1="0" y2="${H}"/>`;
      out += `<text class="tl-month" x="${x + 6}" y="15">${esc(dt.toLocaleDateString('fr-FR', {month:'long', year:'numeric'}))}</text>`;
    }
    if (TL.zoom === 'day') out += `<text x="${x + px/2}" y="${HEAD - 6}" text-anchor="middle" class="${wd === 0 || wd === 6 ? 'tl-we' : ''}">${dt.getDate()}</text>`;
    else if (wd === 1){ out += `<line class="tl-tick" x1="${x}" x2="${x}" y1="${HEAD - 18}" y2="${H}"/><text x="${x + 3}" y="${HEAD - 6}">${dt.getDate()}</text>`; }
  }
  out += `<line class="tl-rowline" x1="0" x2="${W}" y1="${HEAD}" y2="${HEAD}"/>`;
  rows.forEach((t, i) => out += `<line class="tl-rowline" x1="0" x2="${W}" y1="${HEAD + (i + 1) * ROW}" y2="${HEAD + (i + 1) * ROW}"/>`);
  const tx = X(iso(TODAY));
  out += `<rect class="tl-today" x="${tx}" y="${HEAD - 18}" width="${px}" height="${H - HEAD + 18}"/>
    <line class="tl-todayline" x1="${tx + px/2}" x2="${tx + px/2}" y1="${HEAD - 18}" y2="${H}"/>`;
  if (TL.zoom === 'week') out += `<text class="tl-todaylbl" x="${tx + px/2}" y="${HEAD - 22}" text-anchor="middle">auj.</text>`;

  // Liens de dépendance : fin du prérequis → début de la tâche
  for (const t of rows){
    const sp = span(t); if (!sp) continue;
    for (const d of t.deps){
      const dt = byId(d), dsp = dt && span(dt); if (!dsp) continue;
      const x1 = X(dsp.e) + px - 2, y1 = rowY[d] + ROW/2, x2 = X(sp.s) + 2, y2 = rowY[t.id] + ROW/2;
      const bad = dt.status !== 'done' && dsp.e >= sp.s;
      const up = x => x === selected || anc.has(x), down = x => x === selected || desc.has(x);
      const hi = chain && ((up(d) && up(t.id)) || (down(d) && down(t.id)));
      const xm = x1 + 8, ya = y2 + (y2 > y1 ? -ROW/2 + 3 : ROW/2 - 3);
      const path = x2 - 8 >= xm
        ? `M${x1} ${y1}H${xm}V${y2}H${x2 - 1}`
        : `M${x1} ${y1}H${xm}V${ya}H${x2 - 8}V${y2}H${x2 - 1}`;
      out += `<path class="tl-dep ${bad ? 'bad' : ''} ${hi ? 'hi' : ''} ${dt.status === 'done' ? 'done' : ''}" d="${path}" marker-end="url(#${bad ? 'tm-bad' : hi ? 'tm-hi' : 'tm-a'})"/>`;
    }
  }
  // Barres
  for (const t of rows){
    const y = rowY[t.id], sp = span(t);
    if (!sp){
      out += `<rect class="tl-plan" data-plan="${t.id}" x="0" y="${y}" width="${W}" height="${ROW}"><title>Cliquez sur un jour pour planifier</title></rect>
        <text class="tl-plan-txt" x="${tx + px + 6}" y="${y + ROW/2 + 4}">Cliquez sur un jour pour planifier</text>`;
      continue;
    }
    const s = state(t);
    const cls = ['bar', s, isLate(t) ? 'late' : '', t.id === selected ? 'sel' : '', chain && chain.has(t.id) ? 'chain' : '', mine(t) ? '' : 'other'].join(' ');
    const dur = diffDays(sp.s, sp.e) + 1;
    out += `<g class="${cls}" data-bar="${t.id}" tabindex="0" role="slider" aria-label="${esc(t.title)} : du ${fmtLong(sp.s)} au ${fmtLong(sp.e)}, ${dur} j" aria-valuetext="${esc(fmtLong(sp.s))}">
      <rect class="b" x="${X(sp.s) + 2}" y="${y + 7}" width="${dur * px - 4}" height="${ROW - 14}" rx="5"/>
      <rect class="h" data-edge="start" x="${X(sp.s)}" y="${y + 4}" width="8" height="${ROW - 8}"/>
      <rect class="h" data-edge="end" x="${X(sp.e) + px - 8}" y="${y + 4}" width="8" height="${ROW - 8}"/>
      <text class="o" x="${X(sp.e) + px + 4}" y="${y + ROW/2 + 4}">${esc(t.owner || '')}</text>
    </g>`;
  }
  svg.innerHTML = out;

  labels.innerHTML = `<div class="tl-labhead">Tâche</div>` + rows.map(t => {
    const sp = span(t);
    const cls = ['tl-label', t.id === selected ? 'sel' : '', (chain && !chain.has(t.id)) || !mine(t) ? 'dim' : ''].join(' ');
    return `<div class="${cls}" data-sel="${t.id}" title="${esc(t.title)}"><i class="dot ${state(t)}"></i><span>${esc(t.title)}</span>${sp ? '' : '<em>non planifiée</em>'}</div>`;
  }).join('');
  document.querySelectorAll('[data-zoom]').forEach(b => b.setAttribute('aria-pressed', b.dataset.zoom === TL.zoom));
  if (!TL.scrolled){ TL.scrolled = true; scrollToToday(); }
}
function scrollToToday(){
  const sc = document.getElementById('tlScroll');
  sc.scrollLeft = Math.max(0, diffDays(TL.min, iso(TODAY)) * TL.px - sc.clientWidth / 3);
}
function dayAt(clientX){
  const r = document.getElementById('tl').getBoundingClientRect();
  return addDays(TL.min, Math.floor((clientX - r.left) / TL.px));
}
function placeBar(g, s, e){
  const X = d => diffDays(TL.min, d) * TL.px, px = TL.px;
  const [b, h1, h2] = g.querySelectorAll('rect'), o = g.querySelector('text');
  b.setAttribute('x', X(s) + 2); b.setAttribute('width', (diffDays(s, e) + 1) * px - 4);
  h1.setAttribute('x', X(s)); h2.setAttribute('x', X(e) + px - 8); o.setAttribute('x', X(e) + px + 4);
}
function showTip(text, clientX){
  const tip = document.getElementById('tlTip'), sc = document.getElementById('tlScroll');
  tip.textContent = text; tip.hidden = false;
  tip.style.left = Math.max(4, clientX - sc.getBoundingClientRect().left + sc.scrollLeft - 60) + 'px';
}
function setSpan(t, s, e){ t.start = s; t.due = e; }

const tlSvg = document.getElementById('tl');
tlSvg.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const g = e.target.closest('[data-bar]');
  if (g){
    const t = byId(+g.dataset.bar), sp = span(t);
    TL.drag = { id: t.id, g, mode: e.target.dataset.edge || 'move', x0: e.clientX, s: sp.s, e: sp.e, ns: sp.s, ne: sp.e, moved: false };
    tlSvg.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  const p = e.target.closest('[data-plan]');
  if (p){ const t = byId(+p.dataset.plan), d = dayAt(e.clientX); setSpan(t, d, d); selected = t.id; commit(); }
});
tlSvg.addEventListener('pointermove', e => {
  const D = TL.drag; if (!D) return;
  const dd = Math.round((e.clientX - D.x0) / TL.px);
  if (dd !== 0) D.moved = true;
  if (D.mode === 'move'){ D.ns = addDays(D.s, dd); D.ne = addDays(D.e, dd); }
  else if (D.mode === 'start'){ D.ns = addDays(D.s, dd); if (D.ns > D.e) D.ns = D.e; D.ne = D.e; }
  else { D.ne = addDays(D.e, dd); if (D.ne < D.s) D.ne = D.s; D.ns = D.s; }
  placeBar(D.g, D.ns, D.ne);
  if (D.moved) showTip(`${fmtDate(D.ns)} → ${fmtDate(D.ne)} · ${diffDays(D.ns, D.ne) + 1} j`, e.clientX);
});
function endDrag(){
  const D = TL.drag; if (!D) return;
  TL.drag = null;
  document.getElementById('tlTip').hidden = true;
  if (D.moved && (D.ns !== D.s || D.ne !== D.e)){ setSpan(byId(D.id), D.ns, D.ne); selected = D.id; armedDelete = false; commit(); }
  else if (!D.moved){ armedDelete = false; select(D.id); }
}
tlSvg.addEventListener('pointerup', endDrag);
tlSvg.addEventListener('pointercancel', endDrag);
tlSvg.addEventListener('keydown', e => {
  const g = e.target.closest('[data-bar]'); if (!g) return;
  const t = byId(+g.dataset.bar), sp = span(t);
  if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); select(t.id); return; }
  const k = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  if (!k) return;
  e.preventDefault();
  if (e.shiftKey){ const ne = addDays(sp.e, k); if (ne < sp.s) return; setSpan(t, sp.s, ne); }
  else setSpan(t, addDays(sp.s, k), addDays(sp.e, k));
  selected = t.id; commit();
  document.querySelector(`#tl [data-bar="${t.id}"]`)?.focus();
});
document.getElementById('tlLabels').addEventListener('click', e => {
  const l = e.target.closest('[data-sel]'); if (l){ armedDelete = false; select(+l.dataset.sel); }
});
document.querySelectorAll('[data-zoom]').forEach(b => b.addEventListener('click', () => {
  TL.zoom = b.dataset.zoom; TL.scrolled = false; drawTimeline();
}));
document.getElementById('tlToday').addEventListener('click', scrollToToday);

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
  if (!t){ el.innerHTML = `<h2>Tâche sélectionnée</h2><p class="empty">Cliquez une tâche dans le graphe ou la ligne de temps pour la modifier et gérer ses dépendances.</p>`; return; }
  const s = state(t);
  const blockers = t.deps.map(byId).filter(d => d && d.status !== 'done');
  const canProgress = blockers.length === 0;
  const options = T().filter(o => !t.deps.includes(o.id) && !wouldCycle(t.id, o.id));
  const kids = children(t.id);
  el.innerHTML = `
    <h2>Tâche #${t.id} <b style="color:var(--${s})">${LABEL[s]}</b></h2>
    <input type="text" id="editTitle" value="${esc(t.title)}" aria-label="Titre de la tâche">
    <div class="field"><label class="label" for="editOwner">Responsable</label><input type="text" id="editOwner" list="ownerList" value="${esc(t.owner || '')}" placeholder="Non assignée" autocomplete="off"></div>
    <div class="grid2">
      <div><label class="label" for="editStart">Début</label><input type="date" id="editStart" value="${esc(t.start || '')}" ${t.due ? `max="${t.due}"` : ''}></div>
      <div><label class="label" for="editDue">Échéance</label><input type="date" id="editDue" value="${esc(t.due || '')}" ${t.start ? `min="${t.start}"` : ''}></div>
    </div>
    ${t.start && t.due && t.start > t.due ? `<p class="hint warn">Le début est après l'échéance.</p>` : ''}
    ${earlyStart(t).length ? `<p class="hint warn">Commence avant la fin de son prérequis : ${earlyStart(t).map(d => `${esc(d.title)} (${fmtDate(d.due)})`).join(', ')}.</p>` : ''}
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

function render(){ drawGraph(); drawTimeline(); renderSide(); }
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
  if (e.target.id === 'editStart'){ byId(selected).start = e.target.value; commit(); }
});
document.querySelector('aside').addEventListener('input', e => {
  if (e.target.id === 'editTitle'){ byId(selected).title = e.target.value || 'Sans titre'; save(); drawGraph(); drawTimeline(); }
});
document.getElementById('addForm').addEventListener('submit', e => {
  e.preventDefault();
  const inp = document.getElementById('newTitle'), title = inp.value.trim();
  if (!title){ inp.focus(); return; }
  const id = data.seq++;
  const ownEl = document.getElementById('newOwner'), dueEl = document.getElementById('newDue'), startEl = document.getElementById('newStart');
  T().push({id, title, status:'todo', deps: selected && byId(selected) ? [selected] : [], owner: ownEl.value.trim(), start: startEl.value, due: dueEl.value});
  inp.value = ''; dueEl.value = ''; startEl.value = ''; selected = id; armedDelete = false; commit();
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
