/* L'école de Kono — moteur de leçons guidées par la voix.
   Une leçon = un fichier JSON (lessons/*.json). Le même fichier produit les fiches imprimables (tools/build_print.py). */
'use strict';
(() => {
const VERSION = '0.1.0';
const FAST = location.hash === '#test';
const app = document.getElementById('app');
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, FAST ? 5 : ms));
const pick = a => a[Math.floor(Math.random() * a.length)];
const today = () => new Date().toISOString().slice(0, 10);

/* ============================ données ============================ */
const KEY = 'kono-v1';
const blank = () => ({ setup: false, pin: '', names: { bleu: '', orange: '' }, girl: { bleu: false, orange: false },
  voice: { name: '', rate: 0.9 }, progress: { bleu: { runs: [], review: [], done: {} }, orange: { runs: [], review: [], done: {} } } });
function loadStore() {
  try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (s && s.progress) { const b = blank(); return Object.assign(b, s, { progress: Object.assign(b.progress, s.progress) }); } } catch (e) {}
  return blank();
}
const S = loadStore();
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }

const DB = (() => {
  let p = null;
  const open = () => p || (p = new Promise((res, rej) => {
    if (!('indexedDB' in window)) return rej(new Error('pas de stockage'));
    const r = indexedDB.open('kono', 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('clips'); d.createObjectStore('recs', { keyPath: 'id', autoIncrement: true }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const run = async (store, mode, fn) => { const d = await open(); return new Promise((res, rej) => { const t = d.transaction(store, mode); const q = fn(t.objectStore(store)); t.oncomplete = () => res(q ? q.result : undefined); t.onerror = () => rej(t.error); }); };
  const safe = f => async (...a) => { try { return await f(...a); } catch (e) { return undefined; } };
  return {
    getClip: safe(id => run('clips', 'readonly', s => s.get(id))),
    putClip: safe((id, b) => run('clips', 'readwrite', s => s.put(b, id))),
    delClip: safe(id => run('clips', 'readwrite', s => s.delete(id))),
    clipKeys: safe(() => run('clips', 'readonly', s => s.getAllKeys())),
    addRec: safe(r => run('recs', 'readwrite', s => s.add(r))),
    recs: safe(() => run('recs', 'readonly', s => s.getAll())),
    delRec: safe(id => run('recs', 'readwrite', s => s.delete(id))),
  };
})();

/* Phrases que Maman enregistre elle-même. Si elle ne l'a pas fait, Kono dit une phrase neutre (jamais « c'est Maman »). */
const CLIPS = [
  { id: 'bonjour_bleu', who: 'bleu', maman: 'Bonjour [prénom], c\'est Maman. Travaille bien avec Kono, je suis juste à côté.', kono: 'Bonjour {prenom} ! On commence.' },
  { id: 'bonjour_orange', who: 'orange', maman: 'Bonjour [prénom], c\'est Maman. Travaille bien avec Kono, je suis juste à côté.', kono: 'Bonjour {prenom} ! On commence.' },
  { id: 'bravo_effort', maman: 'Tu t\'es trompé(e), et tu as continué. Je suis fière de toi.', kono: '' },
  { id: 'courage', maman: 'Ce n\'est pas grave. Respire, et essaie une autre façon.', kono: '' },
  { id: 'fiche', maman: 'Va chercher ta fiche et ton crayon. Je viendrai voir ton travail.', kono: 'Va chercher ta fiche et ton crayon.' },
  { id: 'explique', maman: 'Explique bien, je t\'écouterai ce soir.', kono: 'Maman écoutera ton explication ce soir.' },
  { id: 'fin_bleu', who: 'bleu', maman: 'C\'est fini pour aujourd\'hui. Viens me montrer ta fiche !', kono: 'C\'est fini pour aujourd\'hui. Va montrer ta fiche à Maman !' },
  { id: 'fin_orange', who: 'orange', maman: 'C\'est fini pour aujourd\'hui. Viens me montrer ta fiche !', kono: 'C\'est fini pour aujourd\'hui. Va montrer ta fiche à Maman !' },
];

let LESSONS = {}, INDEX = [];
async function loadLessons() {
  const idx = await (await fetch('lessons/index.json', { cache: 'no-cache' })).json();
  INDEX = idx.lessons.slice().sort((a, b) => a.order - b.order);
  await Promise.all(INDEX.map(async l => { LESSONS[l.id] = await (await fetch(`lessons/${l.id}.json`, { cache: 'no-cache' })).json(); }));
}

/* ============================ voix ============================ */
let child = null;
const name = c => S.names[c || child] || '';
function fill(t) {
  if (!t) return '';
  const n = name();
  let s = n ? t.replace(/\{prenom\}/g, n) : t.replace(/ ?\{prenom\}/g, '');
  s = s.replace(/\{e\}/g, S.girl[child] ? 'e' : '');
  return s;
}
let voices = [];
function loadVoices() { try { voices = speechSynthesis.getVoices().filter(v => /^fr/i.test(v.lang)); } catch (e) { voices = []; } }
if ('speechSynthesis' in window) { loadVoices(); try { speechSynthesis.onvoiceschanged = loadVoices; } catch (e) {} }
const pickVoice = () => voices.find(v => v.name === S.voice.name) || voices.find(v => /fr[-_]FR/i.test(v.lang)) || voices[0] || null;
let token = 0, curAudio = null;
function setTalking(on) { document.body.classList.toggle('talking', !!on); }
function stopSpeech() {
  token++;
  try { speechSynthesis.cancel(); } catch (e) {}
  if (curAudio) { try { curAudio.pause(); } catch (e) {} curAudio = null; }
  setTalking(false);
}
function speakOne(text) {
  return new Promise(res => {
    if (FAST || !('speechSynthesis' in window)) { setTimeout(res, FAST ? 5 : Math.min(7000, 500 + text.length * 60)); return; }
    let done = false; const fin = () => { if (!done) { done = true; clearTimeout(t); res(); } };
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'fr-FR'; const v = pickVoice(); if (v) u.voice = v; u.rate = S.voice.rate || 0.9;
    u.onend = fin; u.onerror = fin;
    const t = setTimeout(fin, 3000 + text.length * 120 / u.rate);
    try { speechSynthesis.speak(u); } catch (e) { fin(); }
  });
}
async function speak(text) {
  stopSpeech(); const my = token;
  const clean = String(text || '').replace(/[«»]/g, '').replace(/★/g, ' étoile ');
  const parts = clean.match(/[^.!?…]+[.!?…]*/g) || [clean];
  setTalking(true);
  for (const p of parts) { if (my !== token) return; if (p.trim()) await speakOne(p.trim()); }
  if (my === token) setTalking(false);
}
async function hasClip(id) { return !!(await DB.getClip(id)); }
/* renvoie true si c'est la vraie voix de Maman qui a parlé */
async function playClip(id, onMaman) {
  const def = CLIPS.find(c => c.id === id);
  const blob = await DB.getClip(id);
  if (blob && !FAST) {
    stopSpeech(); if (onMaman) onMaman(true);
    await new Promise(res => { const a = new Audio(URL.createObjectURL(blob)); curAudio = a; a.onended = a.onerror = () => res(); a.play().catch(() => res()); });
    curAudio = null; return true;
  }
  if (def && def.kono) { if (onMaman) onMaman(false, fill(def.kono)); await speak(fill(def.kono)); }
  return false;
}

/* ============================ dessins ============================ */
const KONO = `<svg class="kono" viewBox="0 0 150 150" role="img" aria-label="Kono, l'oiseau du fleuve">
<path d="M18 132 H132" stroke="#8a5a3c" stroke-width="6" stroke-linecap="round"/>
<path d="M60 122 l-4 10 M84 122 l4 10" stroke="#c35713" stroke-width="4" stroke-linecap="round"/>
<ellipse cx="72" cy="86" rx="44" ry="40" fill="#3d7fa3"/>
<ellipse cx="80" cy="96" rx="26" ry="24" fill="#dcebf3"/>
<path d="M38 80 q-24 18 -8 40 q16 -6 30 -22z" fill="#2b6184"/>
<circle cx="72" cy="46" r="30" fill="#3d7fa3"/>
<path d="M58 22 q6 -16 18 -6 q-8 2 -10 10z" fill="#2b6184"/>
<circle cx="80" cy="42" r="9" fill="#fff"/><circle cx="82" cy="43" r="4.5" fill="#1b2430"/>
<path d="M96 50 L124 56 L96 60 Z" fill="#e89a2b"/>
<path class="beak-low" d="M96 58 L118 60 L96 66 Z" fill="#c35713"/>
</svg>`;
function vNumberline(v) {
  const W = 640, x0 = 30, x1 = 610, y = 104, span = v.to - v.from; const X = n => x0 + (n - v.from) * (x1 - x0) / span;
  let s = `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="#1b2430" stroke-width="3"/>`;
  for (let n = v.from; n <= v.to; n++) {
    const big = n % 10 === 0, mid = n % 5 === 0;
    s += `<line x1="${X(n)}" y1="${y - (big ? 12 : mid ? 9 : 6)}" x2="${X(n)}" y2="${y + (big ? 12 : mid ? 9 : 6)}" stroke="#1b2430" stroke-width="${big ? 3 : 1.6}"/>`;
    if (big) s += `<text x="${X(n)}" y="${y + 38}" text-anchor="middle" font-size="22" font-family="Nunito, Andika, sans-serif" font-weight="800" fill="#1b2430">${n}</text>`;
  }
  (v.jumps || []).forEach(([a, b, lab]) => {
    const xa = X(a), xb = X(b), h = 26 + (xb - xa) * 0.35, mx = (xa + xb) / 2;
    s += `<path d="M${xa} ${y - 6} Q${mx} ${y - 6 - 2 * h} ${xb} ${y - 6}" fill="none" stroke="var(--c)" stroke-width="3.5" marker-end="url(#ar)"/>`;
    s += `<text x="${mx}" y="${y - 12 - h}" text-anchor="middle" font-size="24" font-family="Nunito, Andika, sans-serif" font-weight="800" fill="var(--c)">${esc(lab)}</text>`;
  });
  (v.marks || []).forEach(n => {
    s += `<circle cx="${X(n)}" cy="${y}" r="8" fill="var(--c)" stroke="#fff" stroke-width="2"/>`;
    if (n % 10 !== 0) s += `<text x="${X(n)}" y="${y + 38}" text-anchor="middle" font-size="22" font-family="Nunito, Andika, sans-serif" font-weight="800" fill="var(--c)">${n}</text>`;
  });
  return `<svg class="v-svg" viewBox="0 0 ${W} 150" role="img" aria-label="ligne des nombres de ${v.from} à ${v.to}"><defs><marker id="ar" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--c)"/></marker></defs>${s}</svg>`;
}
function vSplit(v) {
  const [a, b] = v.parts, circ = (cx, cy, r, val, q) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${q ? '#fff' : 'var(--c-soft)'}" stroke="var(--c)" stroke-width="3" ${q ? 'stroke-dasharray="6 5"' : ''}/><text x="${cx}" y="${cy + 11}" text-anchor="middle" font-size="32" font-family="Nunito, Andika, sans-serif" font-weight="800" fill="${q ? 'var(--c)' : '#1b2430'}">${val == null ? '?' : val}</text>`;
  return `<svg class="v-svg small" viewBox="0 0 260 160" role="img" aria-label="${v.whole} coupé en ${a == null ? '?' : a} et ${b == null ? '?' : b}"><line x1="130" y1="44" x2="70" y2="118" stroke="#1b2430" stroke-width="3"/><line x1="130" y1="44" x2="190" y2="118" stroke="#1b2430" stroke-width="3"/>${circ(130, 38, 30, v.whole)}${circ(70, 122, 28, a, a == null)}${circ(190, 122, 28, b, b == null)}</svg>`;
}
function vTenframe(v) {
  const c = 58; let s = '';
  for (let i = 0; i < 10; i++) {
    const x = 3 + (i % 5) * c, y = 3 + Math.floor(i / 5) * c, full = i < v.filled;
    s += `<rect x="${x}" y="${y}" width="${c}" height="${c}" fill="${!full && v.highlightEmpty ? '#ffe27a' : '#fff'}" ${!full && v.highlightEmpty ? 'class="pulse"' : ''} stroke="#1b2430" stroke-width="3"/>`;
    if (full) s += `<circle cx="${x + c / 2}" cy="${y + c / 2}" r="${c * 0.32}" fill="#c35713"/>`;
  }
  return `<svg class="v-svg" style="max-width:420px" viewBox="0 0 ${5 * c + 6} ${2 * c + 6}" role="img" aria-label="boîte à dix avec ${v.filled} points">${s}</svg>`;
}
function vFingers(v) {
  let s = '';
  const hand = (x0, n0) => {
    let h = `<rect x="${x0 - 6}" y="96" width="${5 * 30 + 6}" height="52" rx="22" fill="#b07a55"/>`;
    for (let k = 0; k < 5; k++) {
      const up = n0 + k < v.up, x = x0 + k * 30, hgt = up ? 84 - (k === 0 ? 24 : 0) : 30;
      h += `<rect x="${x}" y="${104 - hgt}" width="22" height="${hgt + 8}" rx="11" fill="${up ? '#b07a55' : '#d8d2cc'}" stroke="${up ? '#7a4f33' : '#b8b0a8'}" stroke-width="2"/>`;
    }
    return h;
  };
  s += hand(18, 0) + hand(200, 5);
  return `<svg class="v-svg" style="max-width:420px" viewBox="0 0 370 160" role="img" aria-label="${v.up} doigts levés">${s}</svg>`;
}
function visual(list) {
  return (list || []).map(v => {
    if (v.kind === 'title') return `<div class="v-title">${esc(fill(v.text))}</div>`;
    if (v.kind === 'expr') return `<div class="v-expr">${esc(v.text)}</div>`;
    if (v.kind === 'text') return `<div class="v-text">${esc(v.text)}</div>`;
    if (v.kind === 'numberline') return vNumberline(v);
    if (v.kind === 'split') return vSplit(v);
    if (v.kind === 'tenframe') return vTenframe(v);
    if (v.kind === 'fingers') return vFingers(v);
    return '';
  }).join('');
}
const FISH = gold => `<svg width="40" height="25" viewBox="0 0 40 25" aria-hidden="true"><path d="M30 12.5 L40 3 L40 22 Z" fill="${gold ? '#e0a100' : '#7fb4cf'}" stroke="${gold ? '#8a6400' : '#3d7fa3'}" stroke-width="1.5"/><ellipse cx="17" cy="12.5" rx="15" ry="9.5" fill="${gold ? '#e0a100' : '#7fb4cf'}" stroke="${gold ? '#8a6400' : '#3d7fa3'}" stroke-width="1.5"/><circle cx="9" cy="10.5" r="1.8" fill="#1b2430"/></svg>`;

/* ============================ écrans ============================ */
function setChild(c) { child = c; document.body.dataset.child = c || ''; }
function kidLabel(c) { return name(c) || (c === 'bleu' ? 'Bleu' : 'Orange'); }

function screenSetup() {
  setChild(null); stopSpeech();
  app.innerHTML = `<div class="stack">
  <div class="brand">${KONO.replace('class="kono"', 'class="kono" style="width:90px"')}<div><h1>L'école de Kono</h1><p class="muted">Réglage de départ, à faire une seule fois par un parent.</p></div></div>
  <div class="card stack">
    <h3>Les enfants</h3>
    ${['bleu', 'orange'].map(c => `<div class="row"><label class="f" style="flex:1 1 220px">Prénom de l'enfant ${c === 'bleu' ? 'Bleu (7 ans)' : 'Orange (5 ans ½)'}<input type="text" id="n-${c}" value="${esc(S.names[c])}" autocomplete="off"></label>
      <div class="seg" role="group" aria-label="Fille ou garçon"><button data-g="${c}:0" class="${S.girl[c] ? '' : 'on'}">Garçon</button><button data-g="${c}:1" class="${S.girl[c] ? 'on' : ''}">Fille</button></div></div>`).join('')}
    <p class="small muted">Le prénom sert à Kono pour saluer l'enfant. Garçon ou fille sert à accorder les phrases (« tu t'es trompée »).</p>
  </div>
  <div class="card stack">
    <h3>Code parent (4 chiffres)</h3>
    <input type="password" id="pin" inputmode="numeric" maxlength="4" value="${esc(S.pin)}" placeholder="ex. 2468">
    <p class="small muted">Il protège l'espace parent : suivi, enregistrements, voix de Maman.</p>
  </div>
  <div class="card stack">
    <h3>La voix de Kono</h3>
    ${voiceControls()}
  </div>
  <div class="row"><button class="btn big" id="go" style="--c:var(--river)">Enregistrer et commencer</button><span id="err" class="small" style="color:var(--try)"></span></div>
  </div>`;
  bindVoiceControls();
  app.querySelectorAll('[data-g]').forEach(b => b.onclick = () => { const [c, g] = b.dataset.g.split(':'); S.girl[c] = g === '1'; b.parentElement.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); });
  app.querySelector('#go').onclick = () => {
    const pin = app.querySelector('#pin').value.trim();
    if (!/^\d{4}$/.test(pin)) { app.querySelector('#err').textContent = 'Le code doit faire 4 chiffres.'; return; }
    S.pin = pin; S.names.bleu = app.querySelector('#n-bleu').value.trim(); S.names.orange = app.querySelector('#n-orange').value.trim();
    S.setup = true; save(); screenHome();
  };
}
function voiceControls() {
  loadVoices();
  const opts = voices.map(v => `<option value="${esc(v.name)}" ${v.name === (pickVoice() || {}).name ? 'selected' : ''}>${esc(v.name)} (${esc(v.lang)})${v.localService ? ' · hors ligne' : ''}</option>`).join('');
  return `${voices.length ? `<label class="f">Voix française<select id="v-name">${opts}</select></label>` : `<p class="small" style="color:var(--try)">Aucune voix française trouvée sur cet appareil. Sur Android : Paramètres › Synthèse vocale › Services de reconnaissance et synthèse vocales de Google › installer « Français (France) ». Puis rouvrir l'application.</p>`}
  <label class="f">Vitesse<input type="range" id="v-rate" min="0.7" max="1.1" step="0.05" value="${S.voice.rate}"></label>
  <div class="row"><button class="btn soft" id="v-test" type="button">Écouter Kono</button><span class="small muted">Choisissez de préférence une voix marquée « hors ligne ».</span></div>`;
}
function bindVoiceControls() {
  const sel = app.querySelector('#v-name'), rate = app.querySelector('#v-rate');
  if (sel) sel.onchange = () => { S.voice.name = sel.value; save(); };
  if (rate) rate.oninput = () => { S.voice.rate = Number(rate.value); save(); };
  const t = app.querySelector('#v-test');
  if (t) t.onclick = () => speak('Bonjour ! Moi, c\'est Kono, l\'oiseau du fleuve. Trente-huit plus sept, ça fait quarante-cinq. On apprend ensemble ?');
}

function screenHome() {
  setChild(null); stopSpeech();
  app.innerHTML = `<div class="stack">
  <div class="brand">${KONO.replace('class="kono"', 'class="kono" style="width:96px"')}<div><h1>L'école de Kono</h1><p class="muted">Qui travaille avec Kono aujourd'hui ?</p></div></div>
  <div class="kids">
    <button class="kid bleu" data-c="bleu"><b>${esc(kidLabel('bleu'))}</b><span>Parcours bleu · 7 ans</span></button>
    <button class="kid orange" data-c="orange"><b>${esc(kidLabel('orange'))}</b><span>Parcours orange · 5 ans ½</span></button>
  </div>
  <div class="row" style="justify-content:space-between"><button class="link" id="parent">Espace parent</button><span class="small muted">v${VERSION}</span></div>
  </div>`;
  app.querySelectorAll('[data-c]').forEach(b => b.onclick = () => screenChild(b.dataset.c));
  app.querySelector('#parent').onclick = () => screenPin();
}

function nextLesson(c) { return INDEX.filter(l => l.child === c).find(l => !S.progress[c].done[l.id]) || null; }
function screenChild(c) {
  setChild(c); stopSpeech();
  const list = INDEX.filter(l => l.child === c), nx = nextLesson(c);
  app.innerHTML = `<div class="stack">
  <div class="row" style="justify-content:space-between"><button class="btn ghost" id="back">Retour</button><h2 style="color:var(--c)">${esc(kidLabel(c))}</h2></div>
  <div class="card stack center">
    ${nx ? `<p class="muted" style="margin:0">Séance du jour</p><h2 style="font-size:2rem">${esc(nx.title)}</h2><div><button class="btn big" id="start">Commencer avec Kono</button></div>
      <p class="small muted" style="margin:0">Prépare ton crayon et ta fiche ${c === 'bleu' ? 'bleue' : 'orange'}.</p>`
    : `<h2>Toutes les séances sont faites</h2><p class="muted">La prochaine séance arrive dimanche. Tu peux refaire une séance ci-dessous.</p>`}
  </div>
  <div class="card"><h3 style="margin-bottom:6px">Mes séances</h3>
    ${list.map(l => `<div class="lesson-row"><span class="tick ${S.progress[c].done[l.id] ? 'done' : ''}">${S.progress[c].done[l.id] ? '✓' : ''}</span><span style="flex:1">${esc(l.title)} <span class="small muted">· ${esc(l.week)}</span></span><button class="btn soft" data-l="${l.id}" style="font-size:1rem;padding:8px 14px 6px">${S.progress[c].done[l.id] ? 'Refaire' : 'Ouvrir'}</button></div>`).join('')}
  </div></div>`;
  app.querySelector('#back').onclick = screenHome;
  const st = app.querySelector('#start'); if (st) st.onclick = () => startLesson(nx.id);
  app.querySelectorAll('[data-l]').forEach(b => b.onclick = () => startLesson(b.dataset.l));
}

/* ============================ lecteur de leçon ============================ */
let P = null, wake = null;
function expandSteps(lesson) {
  const out = [];
  lesson.steps.forEach(st => {
    if (st.type !== 'review') { out.push(st); return; }
    const q = S.progress[child].review.slice(0, 2).map(r => {
      const L = LESSONS[r.lesson]; const s = L && L.steps.concat(...L.steps.filter(x => x.type === 'review').map(x => x.fallback)).find(x => x.id === r.id);
      return s ? Object.assign({}, s, { fromReview: r, text: 'On revoit un défi d\'avant. ' + s.text, say: s.say ? 'On revoit un défi d\'avant. ' + s.say : undefined }) : null;
    }).filter(Boolean);
    out.push(...(q.length ? q : st.fallback || []));
  });
  return out;
}
async function startLesson(id) {
  const lesson = LESSONS[id];
  P = { lesson, steps: expandSteps(lesson), i: 0, run: { lesson: id, title: lesson.title, date: today(), start: Date.now(), end: null, done: false, items: [], recs: 0 }, fish: 0, gold: 0, stepToken: 0 };
  try { if ('wakeLock' in navigator) wake = await navigator.wakeLock.request('screen'); } catch (e) { wake = null; }
  app.innerHTML = `<div class="lesson">
    <div class="l-top"><button class="btn ghost" id="quit" style="font-size:1rem;padding:8px 14px 6px">Arrêter</button><h2>${esc(lesson.title)}</h2><div class="dots" id="dots"></div></div>
    <div class="l-main"><aside class="guide">${KONO}<div class="bubble" id="bubble"></div></aside><section class="stage" id="stage"></section></div>
    <section class="answer" id="answer"></section>
    <div class="l-ctrl"><button class="btn ghost" id="repeat">Répéter</button><button class="btn" id="next" hidden>Suivant</button></div>
  </div>`;
  app.querySelector('#quit').onclick = () => { saveRun(false); endWake(); screenChild(child); };
  app.querySelector('#next').onclick = () => { P.i++; runStep(); };
  app.querySelector('#repeat').onclick = () => { if (P.repeat) P.repeat(); };
  runStep();
}
function endWake() { try { if (wake) wake.release(); } catch (e) {} wake = null; }
const $ = s => app.querySelector(s);
function bubble(text, kind) {
  const b = $('#bubble'); if (!b) return;
  b.className = 'bubble' + (kind ? ' ' + kind : '');
  b.innerHTML = `<span class="who">${kind === 'maman' ? 'Maman' : 'Kono'}</span>${esc(text)}`;
}
function stage(list) { $('#stage').innerHTML = visual(list) || KONO.replace('class="kono"', 'class="kono" style="width:120px"'); }
function showNext(on = true) { const n = $('#next'); if (n) n.hidden = !on; }
function dots() { $('#dots').innerHTML = P.steps.map((_, k) => `<i class="${k <= P.i ? 'on' : ''}"></i>`).join(''); }

async function runStep() {
  stopSpeech(); showNext(false); $('#answer').innerHTML = ''; P.repeat = null;
  const st = P.steps[P.i]; if (!st) return;
  dots();
  const my = ++P.stepToken;
  const alive = () => P && P.stepToken === my;
  const nx = $('#next'); if (nx) nx.textContent = 'Suivant';
  switch (st.type) {
    case 'maman': {
      stage([]);
      const said = await playClip(st.clip, (isMaman, txt) => bubble(isMaman ? 'Un message pour toi…' : txt, isMaman ? 'maman' : ''));
      if (!alive()) return;
      if (!said && !(CLIPS.find(c => c.id === st.clip) || {}).kono) { P.i++; return runStep(); }
      P.repeat = () => playClip(st.clip);
      await sleep(300); if (alive()) { P.i++; runStep(); }
      return;
    }
    case 'say': {
      stage(st.show); bubble(fill(st.text));
      P.repeat = () => speak(fill(st.say || st.text));
      await speak(fill(st.say || st.text)); if (alive()) showNext();
      return;
    }
    case 'demo': {
      let demoRun = 0;
      const play = async () => {
        const me = ++demoRun;
        showNext(false);
        for (const ln of st.lines) {
          if (!alive() || me !== demoRun) return;
          stage(ln.show); bubble(fill(ln.text));
          await speak(fill(ln.say || ln.text)); await sleep(450);
        }
        if (alive() && me === demoRun) showNext();
      };
      P.repeat = play; return play();
    }
    case 'number': case 'choice': return askStep(st, alive);
    case 'paper': return paperStep(st, alive);
    case 'record': return recordStep(st, alive);
    case 'end': return endStep(st, alive);
    default: P.i++; return runStep();
  }
}

const GOOD = ['Trouvé ! Tu peux dire à Maman comment tu as fait ?', 'Oui ! Bonne méthode.', 'Juste. Tu as bien cherché.', 'C\'est ça !'];
function addReview(st) { if (!st.id) return; const r = { lesson: st.fromReview ? st.fromReview.lesson : P.lesson.id, id: st.id }; const q = S.progress[child].review; if (!q.some(x => x.lesson === r.lesson && x.id === r.id)) q.push(r); }
function dropReview(st) { if (!st.fromReview) return; const q = S.progress[child].review; const k = q.findIndex(x => x.lesson === st.fromReview.lesson && x.id === st.fromReview.id); if (k >= 0) q.splice(k, 1); }

function askStep(st, alive) {
  stage(st.show); bubble(fill(st.text));
  const item = { id: st.id || '', q: st.text, answer: st.answer, answers: [], ok: false, first: false, review: !!st.fromReview };
  P.run.items.push(item);
  let tries = 0, value = '', wrong = [], done = false;
  P.repeat = () => speak(fill(st.say || st.text));
  speak(fill(st.say || st.text));
  const draw = () => {
    if (st.type === 'number') {
      $('#answer').innerHTML = `<div class="ans-box ${value ? 'filled' : ''}" aria-live="polite">${esc(value) || '&nbsp;'}</div>` + (done ? '' :
        `<div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button class="key" data-k="${n}">${n}</button>`).join('')}<button class="key del" data-k="del">Effacer</button><button class="key" data-k="0">0</button><button class="key ok" data-k="ok">OK</button></div>`);
      $('#answer').querySelectorAll('[data-k]').forEach(b => b.onclick = () => {
        const k = b.dataset.k;
        if (k === 'del') value = value.slice(0, -1);
        else if (k === 'ok') { if (value !== '') submit(value); return; }
        else if (value.length < 4) value = (value === '0' ? '' : value) + k;
        draw();
      });
    } else {
      $('#answer').innerHTML = `<div class="choices">${st.options.map(o => `<button class="choice ${wrong.includes(String(o)) ? 'no' : ''} ${done && String(o) === String(st.answer) ? 'yes' : ''}" data-o="${esc(o)}" ${done || wrong.includes(String(o)) ? 'disabled' : ''}>${esc(o)}</button>`).join('')}</div>`;
      $('#answer').querySelectorAll('[data-o]').forEach(b => b.onclick = () => submit(b.dataset.o));
    }
  };
  const submit = async val => {
    if (done) return;
    item.answers.push(String(val));
    if (String(val) === String(st.answer)) {
      done = true; item.ok = true; item.first = tries === 0;
      if (item.first) { P.fish++; dropReview(st); } else { P.gold++; addReview(st); }
      save(); draw(); if (st.after) stage(st.after);
      const msg = item.first ? pick(GOOD) : fill('Poisson doré ! Tu t\'es trompé{e}, tu as cherché encore, et tu as trouvé.');
      const full = msg + (st.sol ? ' ' + st.sol : '');
      bubble(full, 'good'); await speak(full);
      if (!item.first && alive() && await hasClip('bravo_effort')) { bubble('Un message pour toi…', 'maman'); await playClip('bravo_effort'); }
      if (alive()) showNext();
      return;
    }
    tries++; wrong.push(String(val)); value = '';
    const left = st.type === 'choice' ? st.options.filter(o => !wrong.includes(String(o))).length : 9;
    if (tries >= 3 || left <= 1) {
      done = true; item.ok = false; addReview(st); save();
      if (st.type === 'number') value = String(st.answer);
      draw(); if (st.after) stage(st.after);
      const msg = `Voici la réponse : ${String(st.sol || st.answer).replace(/[.\s]+$/, '')}. On la reverra une autre fois.`;
      bubble(msg, 'try'); await speak(msg); if (alive()) showNext();
      return;
    }
    draw();
    const why = (st.errors && st.errors[String(val)]) || (st.hints && st.hints[Math.min(tries - 1, st.hints.length - 1)]) || 'Regarde encore une fois.';
    const msg = (tries === 1 ? 'Pas encore. ' : 'Pas encore. Essaie une autre façon. ') + why;
    bubble(msg, 'try'); await speak(msg);
  };
  draw();
}

function paperItems() {
  const out = [];
  (P.lesson.paper.levels || []).forEach(lv => lv.items.forEach(it => { if (it.answer !== undefined) out.push(Object.assign({ stars: lv.stars }, it)); }));
  return out;
}
function paperStep(st, alive) {
  stage([{ kind: 'title', text: 'Ta fiche ' + (child === 'bleu' ? 'bleue' : 'orange') }, { kind: 'text', text: `« ${P.lesson.paper.title} »` }]);
  bubble(fill(st.text));
  P.repeat = () => speak(fill(st.say || st.text));
  speak(fill(st.say || st.text));
  $('#answer').innerHTML = `<div class="center"><button class="btn big" id="fini">J'ai fini ma fiche</button></div>`;
  $('#fini').onclick = () => {
    const items = paperItems(); const vals = {}, res = {}; let sel = items[0] ? items[0].id : null, round = 0;
    const draw = () => {
      $('#answer').innerHTML = `<div class="paper-list">${items.map(it => {
        const r = res[it.id];
        return `<button class="p-item ${sel === it.id && round < 2 && (!r || !r.ok) ? 'sel' : ''} ${r ? (r.ok ? 'ok' : 'ko') : ''}" data-i="${it.id}"><span class="lab"><span class="stars">${'★'.repeat(it.stars)}</span> ${esc(it.short || it.q)}${r && !r.ok && r.why ? `<span class="why">${esc(r.why)}</span>` : ''}</span><span class="val">${esc(vals[it.id] || '')}</span><span class="mark">${r ? (r.ok ? '✓' : '✗') : ''}</span></button>`;
      }).join('')}</div>
      ${round < 2 ? `<div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button class="key" data-k="${n}">${n}</button>`).join('')}<button class="key del" data-k="del">Effacer</button><button class="key" data-k="0">0</button><button class="key ok" data-k="ok">Vérifier</button></div>` : ''}
      <p class="small muted center" style="margin:0">Touche une ligne, puis tape ta réponse. Laisse vide ce que tu n'as pas fait.</p>`;
      $('#answer').querySelectorAll('[data-i]').forEach(b => b.onclick = () => { if (round < 2) { sel = b.dataset.i; draw(); } });
      $('#answer').querySelectorAll('[data-k]').forEach(b => b.onclick = () => {
        const k = b.dataset.k;
        if (k === 'ok') return check();
        if (!sel || (res[sel] && res[sel].ok)) return;
        let v = vals[sel] || '';
        if (k === 'del') v = v.slice(0, -1); else if (v.length < 4) v = (v === '0' ? '' : v) + k;
        vals[sel] = v; if (res[sel]) delete res[sel]; draw();
      });
    };
    const check = async () => {
      if (!items.some(it => vals[it.id])) { const m = 'Touche une ligne, puis tape au moins une réponse de ta fiche.'; bubble(m, 'try'); speak(m); return; }
      round++;
      let firstWhy = '', nOk = 0, nKo = 0;
      items.forEach(it => {
        const v = vals[it.id]; if (v === undefined || v === '') return;
        if (res[it.id] && res[it.id].ok) { nOk++; return; }
        const ok = String(v) === String(it.answer);
        let rec = P.run.items.find(x => x.id === 'fiche-' + it.id);
        if (!rec) { rec = { id: 'fiche-' + it.id, q: 'Fiche ' + '★'.repeat(it.stars) + ' ' + (it.short || it.q), answer: it.answer, answers: [], ok: false, first: false, paper: true }; P.run.items.push(rec); }
        rec.answers.push(String(v)); rec.ok = ok; rec.first = ok && rec.answers.length === 1;
        const why = ok ? '' : ((it.errors && it.errors[String(v)]) || (round >= 2 ? `La réponse était ${it.answer}.` : 'Regarde encore ton calcul sur la fiche.'));
        res[it.id] = { ok, why };
        if (ok) { nOk++; if (rec.first) P.fish++; else P.gold++; } else { nKo++; if (!firstWhy) firstWhy = why; }
      });
      if (round >= 2) items.forEach(it => { if (res[it.id] && !res[it.id].ok) vals[it.id] = String(it.answer); });
      save(); draw();
      const msg = nKo === 0 ? (nOk ? `Tout est juste : ${nOk} réponse${nOk > 1 ? 's' : ''}. Montre ta fiche à Maman.` : 'Tape au moins une réponse de ta fiche.')
        : round < 2 ? `${nOk} juste${nOk > 1 ? 's' : ''}, ${nKo} à revoir. ${firstWhy} Corrige sur ta fiche, puis tape la nouvelle réponse.` : `Voici les bonnes réponses. Regarde-les avec Maman.`;
      bubble(msg, nKo ? 'try' : 'good'); await speak(msg);
      if (alive() && (nKo === 0 && nOk > 0 || round >= 2)) { round = 2; draw(); showNext(); }
    };
    draw();
  };
}

function recordStep(st, alive) {
  stage([{ kind: 'title', text: 'Explique avec ta voix' }]);
  bubble(fill(st.text));
  P.repeat = () => speak(fill(st.say || st.text));
  (async () => { await speak(fill(st.say || st.text)); if (alive() && st.clip && await hasClip(st.clip)) { bubble('Un message pour toi…', 'maman'); await playClip(st.clip); if (alive()) bubble(fill(st.text)); } })();
  const canRec = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  if (!canRec) { $('#answer').innerHTML = `<p class="center">Le micro n'est pas disponible ici. Explique à Maman à voix haute.</p>`; showNext(); return; }
  let rec = null, chunks = [], blob = null, t0 = 0, timer = null, stream = null;
  const draw = state => {
    $('#answer').innerHTML = state === 'idle' ? `<button class="rec-btn" id="rb" aria-label="Enregistrer"></button><p class="center muted" style="margin:0">Appuie sur le rond rouge pour parler.</p>`
      : state === 'on' ? `<button class="rec-btn on" id="rb" aria-label="Arrêter"></button><p class="center" style="margin:0"><b id="tm">0 s</b> · appuie encore pour t'arrêter</p>`
      : `<div class="row" style="justify-content:center"><button class="btn soft" id="play">Écouter</button><button class="btn ghost" id="redo">Recommencer</button><button class="btn" id="keep">Garder</button></div>`;
    const rb = $('#rb'); if (rb) rb.onclick = state === 'idle' ? startRec : stopRec;
    if (state === 'done') {
      $('#play').onclick = () => { stopSpeech(); const a = new Audio(URL.createObjectURL(blob)); curAudio = a; a.play().catch(() => {}); };
      $('#redo').onclick = () => { blob = null; draw('idle'); };
      $('#keep').onclick = async () => {
        showNext(false); $('#keep').disabled = true;
        await DB.addRec({ child, lesson: P.lesson.id, title: P.lesson.title, kind: st.kind || 'methode', q: st.text, ts: Date.now(), dur: Math.round((Date.now() - t0) / 1000), mime: blob.type, blob });
        P.run.recs++; save(); P.i++; runStep();
      };
    }
  };
  const startRec = async () => {
    stopSpeech();
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { $('#answer').innerHTML = `<p class="center">Le micro est refusé. Explique à Maman à voix haute.</p>`; showNext(); return; }
    chunks = []; rec = new MediaRecorder(stream); rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => { blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' }); stream.getTracks().forEach(t => t.stop()); clearInterval(timer); draw('done'); };
    rec.start(); t0 = Date.now(); draw('on');
    timer = setInterval(() => { const s = Math.round((Date.now() - t0) / 1000); const el = $('#tm'); if (el) el.textContent = s + ' s'; if (s >= 90) stopRec(); }, 500);
  };
  const stopRec = () => { try { if (rec && rec.state !== 'inactive') rec.stop(); } catch (e) {} };
  draw('idle');
  showNext(); $('#next').textContent = 'Passer';
}

function saveRun(done) {
  if (!P || P.run.end) return;
  P.run.end = Date.now(); P.run.done = done; P.run.fish = P.fish; P.run.gold = P.gold;
  S.progress[child].runs.push(P.run);
  if (done) S.progress[child].done[P.lesson.id] = today();
  save();
}
async function endStep(st, alive) {
  saveRun(true); endWake();
  const mins = Math.max(1, Math.round((P.run.end - P.run.start) / 60000));
  $('#next').textContent = 'Terminer'; $('#repeat').hidden = true;
  $('#stage').innerHTML = `<div class="v-title">Séance terminée</div><div class="fishes">${Array.from({ length: P.fish }, () => FISH(false)).join('')}${Array.from({ length: P.gold }, () => FISH(true)).join('')}</div>`;
  const msg = fill(`Tu as travaillé ${mins} minute${mins > 1 ? 's' : ''}. Tu as trouvé ${P.fish + P.gold} réponse${P.fish + P.gold > 1 ? 's' : ''}` + (P.gold ? `, dont ${P.gold} après t'être trompé{e} : ce sont les poissons dorés.` : '.'));
  bubble(msg, 'good'); await speak(msg);
  if (!alive()) return;
  await playClip(st.clip, (isMaman, txt) => bubble(isMaman ? 'Un message pour toi…' : txt, isMaman ? 'maman' : 'good'));
  if (!alive()) return;
  showNext(); $('#next').onclick = () => screenChild(child);
}

/* ============================ espace parent ============================ */
function screenPin() {
  setChild(null); stopSpeech();
  let v = '';
  const draw = () => {
    app.innerHTML = `<div class="stack" style="max-width:420px;margin:0 auto">
    <div class="row" style="justify-content:space-between"><button class="btn ghost" id="back" style="--c:var(--river)">Retour</button><h2>Espace parent</h2></div>
    <p class="center muted">Tapez le code parent.</p>
    <div class="pin">${[0, 1, 2, 3].map(k => `<span>${v[k] ? '•' : ''}</span>`).join('')}</div>
    <div class="keypad" style="--c-soft:var(--river-soft)">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button class="key" data-k="${n}">${n}</button>`).join('')}<button class="key del" data-k="del">Effacer</button><button class="key" data-k="0">0</button><span></span></div>
    <p class="center small" id="msg" style="color:var(--try)"></p></div>`;
    $('#back').onclick = screenHome;
    app.querySelectorAll('[data-k]').forEach(b => b.onclick = () => {
      const k = b.dataset.k; if (k === 'del') v = v.slice(0, -1); else if (v.length < 4) v += k;
      if (v.length === 4) { if (v === S.pin) return screenParent('suivi'); v = ''; draw(); $('#msg').textContent = 'Code incorrect.'; return; }
      draw();
    });
  };
  draw();
}
function fmtDate(ts) { const d = new Date(ts); return d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
function status(it) { return it.ok ? (it.first ? '<span class="pill first">1er essai</span>' : '<span class="pill after">après erreur</span>') : (it.answers.length ? '<span class="pill shown">réponse montrée</span>' : '<span class="pill shown">non fait</span>'); }
async function screenParent(tab) {
  setChild(null); stopSpeech();
  const tabs = [['suivi', 'Suivi'], ['maman', 'Voix de Maman'], ['kono', 'Voix de Kono'], ['rapport', 'Rapport'], ['reglages', 'Réglages']];
  app.innerHTML = `<div class="stack">
  <div class="row" style="justify-content:space-between"><h2>Espace parent</h2><button class="btn ghost" id="out" style="--c:var(--river)">Sortir</button></div>
  <div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${k === tab ? 'on' : ''}" data-t="${k}">${l}</button>`).join('')}</div>
  <div id="pane" class="stack"></div></div>`;
  $('#out').onclick = screenHome;
  app.querySelectorAll('[data-t]').forEach(b => b.onclick = () => screenParent(b.dataset.t));
  const pane = $('#pane');
  if (tab === 'suivi') {
    const recs = (await DB.recs()) || [];
    pane.innerHTML = ['bleu', 'orange'].map(c => {
      const runs = S.progress[c].runs.slice().reverse();
      const rr = recs.filter(r => r.child === c).sort((a, b) => b.ts - a.ts);
      return `<div class="card stack"><h3 style="color:${c === 'bleu' ? 'var(--bleu)' : 'var(--orange)'}">${esc(kidLabel(c))}</h3>
      ${runs.length ? runs.map(r => `<div><p style="margin:0 0 4px"><b>${esc(r.title)}</b> · ${fmtDate(r.start)} · ${Math.max(1, Math.round(((r.end || r.start) - r.start) / 60000))} min ${r.done ? '' : '· <span class="pill shown">arrêtée avant la fin</span>'}</p>
        <div class="table-wrap"><table class="t"><tr><th>Question</th><th>Réponses tapées</th><th>Résultat</th></tr>${r.items.map(it => `<tr><td>${esc(it.q)}</td><td>${esc(it.answers.join(' → ') || '—')}</td><td>${status(it)}</td></tr>`).join('')}</table></div></div>`).join('') : '<p class="muted">Pas encore de séance.</p>'}
      <h3 style="font-size:1rem">Enregistrements</h3>
      ${rr.length ? rr.map(r => `<div class="clip"><span class="txt"><b>${esc(r.title)}</b> · ${fmtDate(r.ts)} · ${r.dur || '?'} s<br><span class="small muted">${esc(r.q)}</span></span><button class="btn soft" data-play="${r.id}" style="font-size:1rem;padding:8px 14px 6px">Écouter</button><button class="link" data-del="${r.id}">Supprimer</button></div>`).join('') : '<p class="muted small">Aucun enregistrement.</p>'}
      <p class="small muted">À revoir automatiquement dans les prochaines séances : ${S.progress[c].review.length} défi${S.progress[c].review.length > 1 ? 's' : ''}.</p></div>`;
    }).join('');
    pane.querySelectorAll('[data-play]').forEach(b => b.onclick = () => { const r = recs.find(x => String(x.id) === b.dataset.play); if (r) { stopSpeech(); const a = new Audio(URL.createObjectURL(r.blob)); curAudio = a; a.play().catch(() => {}); } });
    pane.querySelectorAll('[data-del]').forEach(b => { let armed = false; b.onclick = async () => { if (!armed) { armed = true; b.textContent = 'Confirmer la suppression'; return; } await DB.delRec(Number(b.dataset.del)); screenParent('suivi'); }; });
  }
  if (tab === 'maman') {
    const keys = new Set((await DB.clipKeys()) || []);
    pane.innerHTML = `<div class="card"><p style="margin-top:0">Maman enregistre ces phrases une fois, avec ses mots à elle. Kono les fera entendre au bon moment. Une phrase non enregistrée est remplacée par une phrase neutre de Kono, qui ne se fait jamais passer pour Maman.</p>
      ${CLIPS.map(c => `<div class="clip" data-id="${c.id}"><span class="txt">${c.who ? `<span class="pill ${c.who === 'bleu' ? 'first' : 'after'}">${esc(kidLabel(c.who))}</span> ` : ''}${esc(c.maman.replace('[prénom]', c.who ? kidLabel(c.who) : '…'))}</span>
        <span class="state" style="color:${keys.has(c.id) ? 'var(--good)' : 'var(--muted)'}">${keys.has(c.id) ? 'Enregistrée' : 'À enregistrer'}</span>
        <button class="btn" data-rec style="font-size:1rem;padding:8px 14px 6px;--c:var(--maman)">${keys.has(c.id) ? 'Refaire' : 'Enregistrer'}</button>
        ${keys.has(c.id) ? `<button class="btn soft" data-play style="font-size:1rem;padding:8px 14px 6px">Écouter</button><button class="link" data-del>Effacer</button>` : ''}</div>`).join('')}</div>`;
    pane.querySelectorAll('.clip').forEach(row => {
      const id = row.dataset.id; let rec = null, stream = null, chunks = [];
      const rb = row.querySelector('[data-rec]');
      rb.onclick = async () => {
        if (rec && rec.state === 'recording') { rec.stop(); return; }
        if (!(navigator.mediaDevices && window.MediaRecorder)) { rb.textContent = 'Micro indisponible'; return; }
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { rb.textContent = 'Micro refusé'; return; }
        chunks = []; rec = new MediaRecorder(stream); rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
        rec.onstop = async () => { stream.getTracks().forEach(t => t.stop()); await DB.putClip(id, new Blob(chunks, { type: rec.mimeType || 'audio/webm' })); screenParent('maman'); };
        rec.start(); rb.textContent = 'Arrêter'; rb.style.setProperty('--c', '#a31226');
      };
      const pb = row.querySelector('[data-play]'); if (pb) pb.onclick = () => playClip(id);
      const db = row.querySelector('[data-del]'); if (db) db.onclick = async () => { await DB.delClip(id); screenParent('maman'); };
    });
  }
  if (tab === 'kono') { pane.innerHTML = `<div class="card stack">${voiceControls()}</div>`; bindVoiceControls(); }
  if (tab === 'rapport') {
    const txt = report();
    pane.innerHTML = `<div class="card stack"><p style="margin:0">À copier et à envoyer à Claude le dimanche : les séances de la semaine suivante seront réglées sur ce rapport.</p><textarea id="rep" readonly>${esc(txt)}</textarea><div class="row"><button class="btn" id="copy" style="--c:var(--river)">Copier le rapport</button><span id="cp" class="small muted"></span></div></div>`;
    $('#copy').onclick = async () => { try { await navigator.clipboard.writeText(txt); $('#cp').textContent = 'Copié.'; } catch (e) { const t = $('#rep'); t.focus(); t.select(); $('#cp').textContent = 'Sélectionné : utilisez Copier.'; } };
  }
  if (tab === 'reglages') {
    pane.innerHTML = `<div class="card stack"><p style="margin:0">Prénoms, garçon ou fille, et code parent.</p><div><button class="btn" id="setup" style="--c:var(--river)">Modifier les réglages</button></div></div>
    <div class="card stack"><h3>Bloquer la tablette sur l'application</h3><p class="small" style="margin:0">Android : Paramètres › Sécurité › Épinglage d'écran (ou « Épingler l'application »). Ouvrez L'école de Kono, affichez les applications récentes, touchez l'icône de l'application puis « Épingler ». Pour sortir : maintenir Retour + Aperçu, puis le code de la tablette.</p></div>
    <div class="card stack"><h3>Remettre le suivi à zéro</h3><p class="small muted" style="margin:0">Efface les séances et la file de révision (pas les enregistrements de Maman).</p><div class="row"><input type="text" id="conf" placeholder="Tapez EFFACER"><button class="btn ghost" id="wipe">Effacer le suivi</button></div></div>`;
    $('#setup').onclick = screenSetup;
    $('#wipe').onclick = () => { if ($('#conf').value.trim().toUpperCase() !== 'EFFACER') return; S.progress = blank().progress; save(); screenParent('suivi'); };
  }
}
function report() {
  const L = [`Rapport L'école de Kono · ${today()} · v${VERSION}`];
  ['bleu', 'orange'].forEach(c => {
    L.push('', `== ${c === 'bleu' ? 'BLEU (7 ans)' : 'ORANGE (5 ans ½)'} : ${kidLabel(c)} ==`);
    const runs = S.progress[c].runs;
    if (!runs.length) L.push('Aucune séance.');
    runs.forEach(r => {
      L.push(`- ${r.date} · ${r.title} · ${Math.max(1, Math.round(((r.end || r.start) - r.start) / 60000))} min · ${r.done ? 'terminée' : 'arrêtée avant la fin'} · enregistrements : ${r.recs || 0}`);
      r.items.forEach(it => L.push(`    ${it.ok ? (it.first ? 'OK 1er essai' : 'OK après erreur') : (it.answers.length ? 'MONTRÉE' : 'non fait')} | ${it.q} | réponses : ${it.answers.join(' → ') || '—'} | attendu : ${it.answer}`));
    });
    L.push(`File de révision : ${S.progress[c].review.map(r => r.id).join(', ') || 'vide'}`);
  });
  return L.join('\n');
}

/* ============================ démarrage ============================ */
async function boot() {
  try { await loadLessons(); } catch (e) { app.innerHTML = `<div class="card"><h2>Leçons introuvables</h2><p>Connectez la tablette à internet une fois pour télécharger les leçons, puis rouvrez l'application.</p></div>`; return; }
  if (!S.setup) screenSetup(); else screenHome();
}
if ('serviceWorker' in navigator && location.protocol === 'https:') { try { navigator.serviceWorker.register('sw.js').catch(() => {}); } catch (e) {} }
document.addEventListener('visibilitychange', () => { if (document.hidden) stopSpeech(); });
boot();
})();
