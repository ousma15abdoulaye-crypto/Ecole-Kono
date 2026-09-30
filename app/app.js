/* L'école de Kono — moteur de séances guidées par la voix (v0.2).
   Une séance = un fichier JSON (lessons/*.json), en quatre temps : automatismes, leçon, lecture ou histoire, méthode.
   Le même fichier produit les fiches imprimables (tools/build_print.py) et la liste des phrases à enregistrer (tools/build_audio.py). */
'use strict';
(() => {
const VERSION = '0.2.0';
const FAST = location.hash === '#test';
const app = document.getElementById('app');
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, FAST ? 5 : ms));
const pick = a => a[Math.floor(Math.random() * a.length)];
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const shuffle = a => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const today = () => new Date().toISOString().slice(0, 10);
const $ = s => app.querySelector(s);

/* ============================ données ============================ */
const KEY = 'kono-v1';
const kid = () => ({ runs: [], review: [], done: {}, records: {}, drillMisses: {}, skills: {}, measures: [] });
const blank = () => ({ setup: false, pin: '', names: { bleu: '', orange: '' }, girl: { bleu: false, orange: false }, voice: { name: '', rate: 0.9 }, progress: { bleu: kid(), orange: kid() } });
function loadStore() {
  const b = blank();
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s && s.progress) { Object.assign(b, s); ['bleu', 'orange'].forEach(c => { b.progress[c] = Object.assign(kid(), s.progress[c] || {}); }); }
  } catch (e) {}
  return b;
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

/* Phrases que Maman enregistre elle-même. Sans enregistrement, Kono dit une phrase neutre (jamais « c'est Maman »). */
let CLIPS = [];

let LESSONS = {}, INDEX = [], ESCALES = [], PH = {}, AUDIO = { files: {} };
async function getJSON(u) { const r = await fetch(u, { cache: 'no-cache' }); if (!r.ok) throw new Error(u); return r.json(); }
async function loadAll() {
  const idx = await getJSON('lessons/index.json');
  INDEX = idx.lessons.slice().sort((a, b) => a.order - b.order);
  ESCALES = idx.escales || [];
  await Promise.all(INDEX.map(async l => { LESSONS[l.id] = await getJSON(`lessons/${l.id}.json`); }));
  PH = await getJSON('phrases.json');
  CLIPS = PH.clips || [];
  try { AUDIO = await getJSON('audio/manifest.json'); if (!AUDIO.files) AUDIO.files = {}; } catch (e) { AUDIO = { files: {} }; }
}

/* ============================ voix ============================ */
let child = null;
const name = c => S.names[c || child] || '';
function fill(t) {
  if (!t) return '';
  const n = name();
  let s = n ? t.replace(/\{prenom\}/g, n) : t.replace(/ ?\{prenom\}/g, '');
  return s.replace(/\{e\}/g, S.girl[child] ? 'e' : '');
}
/* Même découpage et même clé que tools/build_audio.py : une phrase = un fichier audio. */
const normSpeech = t => String(t || '').replace(/[«»]/g, '').replace(/★/g, ' étoile ');
const sentences = t => (normSpeech(t).match(/[^.!?…]+[.!?…]*/g) || []).map(p => p.trim()).filter(Boolean);
function keyOf(t) {
  const s = normSpeech(t).replace(/\s+/g, ' ').trim(); const b = new TextEncoder().encode(s);
  let h = 0x811c9dc5; for (const x of b) { h ^= x; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
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
function playFile(src) {
  return new Promise(res => {
    const a = new Audio(src); curAudio = a; let done = false;
    const fin = ok => { if (!done) { done = true; clearTimeout(t); res(ok); } };
    const t = setTimeout(() => fin(true), 30000);
    a.onended = () => fin(true); a.onerror = () => fin(false);
    a.play().catch(() => fin(false));
  });
}
function ttsOne(text) {
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
async function speakOne(text) {
  const f = AUDIO.files[keyOf(text)];
  if (f && !FAST) { const ok = await playFile('audio/' + f); if (ok) return; }
  await ttsOne(text);
}
/* Voix du conteur : un élément de texte = un enregistrement, sinon découpage normal. */
async function speakWhole(text) {
  const f = AUDIO.files[keyOf(text)];
  if (!f || FAST) return speak(text);
  stopSpeech(); const my = token; setTalking(true);
  await playFile('audio/' + f);
  if (my === token) setTalking(false);
  return my === token;
}
/* onSentence(i) est appelé avant chaque phrase : sert au surlignage de la lecture. */
async function speak(text, onSentence) {
  stopSpeech(); const my = token;
  const parts = sentences(text);
  setTalking(true);
  for (let i = 0; i < parts.length; i++) { if (my !== token) return false; if (onSentence) onSentence(i); await speakOne(parts[i]); }
  if (my === token) setTalking(false);
  return my === token;
}
async function hasClip(id) { return !!(await DB.getClip(id)); }
async function playClip(id, onMaman) {
  const def = CLIPS.find(c => c.id === id);
  const blob = await DB.getClip(id);
  if (blob && !FAST) {
    stopSpeech(); if (onMaman) onMaman(true);
    await playFile(URL.createObjectURL(blob)); curAudio = null; return true;
  }
  if (def && def.kono) { if (onMaman) onMaman(false, fill(def.kono)); await speak(fill(def.kono)); }
  return false;
}

/* ============================ dessins ============================ */
const KONO = `<svg class="kono" viewBox="0 0 150 150" role="img" aria-label="Kono, l'oiseau du fleuve">
<path d="M18 132 H132" stroke="#8a5a3c" stroke-width="6" stroke-linecap="round"/>
<path d="M60 122 l-4 10 M84 122 l4 10" stroke="#c35713" stroke-width="4" stroke-linecap="round"/>
<ellipse cx="72" cy="86" rx="44" ry="40" fill="#3d7fa3"/><ellipse cx="80" cy="96" rx="26" ry="24" fill="#dcebf3"/>
<path d="M38 80 q-24 18 -8 40 q16 -6 30 -22z" fill="#2b6184"/><circle cx="72" cy="46" r="30" fill="#3d7fa3"/>
<path d="M58 22 q6 -16 18 -6 q-8 2 -10 10z" fill="#2b6184"/><circle cx="80" cy="42" r="9" fill="#fff"/><circle cx="82" cy="43" r="4.5" fill="#1b2430"/>
<path d="M96 50 L124 56 L96 60 Z" fill="#e89a2b"/><path class="beak-low" d="M96 58 L118 60 L96 66 Z" fill="#c35713"/></svg>`;
const BOAT = `<g class="boat"><path d="M-30 0 Q0 14 30 0 L25 7 Q0 16 -25 7 Z" fill="#5a3a22"/><path d="M-12 1 Q-12 -12 0 -12 Q12 -12 12 1" fill="#fbe8d9" stroke="#c35713" stroke-width="3"/></g>`;
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
  return `<svg class="v-svg" style="max-width:${v.small ? 260 : 420}px" viewBox="0 0 ${5 * c + 6} ${2 * c + 6}" role="img" aria-label="boîte à dix avec ${v.filled} points">${s}</svg>`;
}
function vFingers(v) {
  const hand = (x0, n0) => {
    let h = `<rect x="${x0 - 6}" y="96" width="156" height="52" rx="22" fill="#b07a55"/>`;
    for (let k = 0; k < 5; k++) {
      const up = n0 + k < v.up, x = x0 + k * 30, hgt = up ? 84 - (k === 0 ? 24 : 0) : 30;
      h += `<rect x="${x}" y="${104 - hgt}" width="22" height="${hgt + 8}" rx="11" fill="${up ? '#b07a55' : '#d8d2cc'}" stroke="${up ? '#7a4f33' : '#b8b0a8'}" stroke-width="2"/>`;
    }
    return h;
  };
  return `<svg class="v-svg" style="max-width:420px" viewBox="0 0 370 160" role="img" aria-label="${v.up} doigts levés">${hand(18, 0) + hand(200, 5)}</svg>`;
}
/* Petites scènes d'histoire, dessinées dans un même style (en attendant un illustrateur). */
const person = (x, y, s, dress, wrap, arm) => `<g transform="translate(${x} ${y}) scale(${s})"><path d="M-14 0 L14 0 L9 -38 L-9 -38 Z" fill="${dress}"/><circle cx="0" cy="-48" r="11" fill="#6b4226"/>${wrap ? `<path d="M-12 -52 Q0 -68 12 -52 Z" fill="${wrap}"/>` : ''}${arm || ''}</g>`;
const mango = (x, y, r = 7) => `<ellipse cx="${x}" cy="${y}" rx="${r}" ry="${r * 0.78}" fill="#f6b73c" stroke="#9a5b12" stroke-width="1.2"/>`;
const basket = (x, y, rot = 0) => `<g transform="translate(${x} ${y}) rotate(${rot})"><path d="M-22 -14 L22 -14 L16 8 L-16 8 Z" fill="#a0703f" stroke="#6b4a26" stroke-width="1.5"/>${mango(-10, -18)}${mango(2, -20)}${mango(13, -17)}</g>`;
const SCENES = {
  marche: `<rect x="0" y="120" width="240" height="40" fill="#e8d6b5"/><rect x="120" y="60" width="100" height="10" fill="#c35713"/><path d="M115 60 L170 36 L225 60 Z" fill="#e89a2b"/><rect x="128" y="70" width="6" height="50" fill="#8a5a3c"/><rect x="206" y="70" width="6" height="50" fill="#8a5a3c"/>${basket(168, 112)}${person(70, 124, 1, '#7a4ea3', '', '')}${person(105, 124, 1.25, '#2c8554', '#e0a100', '')}`,
  vent: `<rect x="0" y="120" width="160" height="40" fill="#e8d6b5"/><rect x="160" y="112" width="80" height="48" fill="#7fb4cf"/><path d="M10 40 q30 -12 60 0 t60 0 M20 62 q30 -12 60 0 t60 0 M5 84 q30 -12 60 0" fill="none" stroke="#9aa7ad" stroke-width="4" stroke-linecap="round"/>${basket(120, 116, 35)}${mango(150, 118)}${mango(172, 122)}${person(50, 124, 1, '#7a4ea3', '', '<path d="M-10 -34 L-26 -50 M10 -34 L26 -50" stroke="#6b4226" stroke-width="5" stroke-linecap="round"/>')}`,
  pecheur: `<rect x="0" y="80" width="240" height="80" fill="#7fb4cf"/><path d="M0 92 q20 -6 40 0 t40 0 t40 0 t40 0 t40 0 t40 0" fill="none" stroke="#dcebf3" stroke-width="3"/><path d="M40 118 Q100 140 170 118 L162 128 Q100 148 48 128 Z" fill="#5a3a22"/>${person(100, 120, 1.1, '#3d7fa3', '', '<path d="M10 -30 L34 10" stroke="#8a5a3c" stroke-width="4"/>')}${basket(200, 104, -10)}`,
  merci: `<rect x="0" y="120" width="240" height="40" fill="#e8d6b5"/>${person(80, 124, 1, '#7a4ea3', '', '<path d="M10 -32 L30 -40" stroke="#6b4226" stroke-width="5" stroke-linecap="round"/>')}${mango(120, 83, 9)}${person(160, 124, 1.2, '#3d7fa3', '', '<path d="M-10 -32 L-32 -40" stroke="#6b4226" stroke-width="5" stroke-linecap="round"/>')}<path d="M112 50 q8 -10 16 0 q8 -10 16 0 q0 12 -16 22 q-16 -10 -16 -22z" fill="#d7263d" transform="translate(-8 -8)"/>`,
};
function vScenes(v) {
  return `<div class="scenes">${v.scenes.map((k, i) => `<figure class="scene"><svg viewBox="0 0 240 160" role="img" aria-label="image ${i + 1} de l'histoire">${SCENES[k] || ''}</svg><figcaption>${i + 1}</figcaption></figure>`).join('')}</div>`;
}
function visual(list) {
  return (list || []).map(v => {
    if (v.kind === 'title') return `<div class="v-title">${esc(fill(v.text))}</div>`;
    if (v.kind === 'expr') return `<div class="v-expr">${esc(v.text)}</div>`;
    if (v.kind === 'text') return `<div class="v-text">${esc(v.text)}</div>`;
    if (v.kind === 'part') return `<div class="v-part"><span>${v.n}</span><b>${esc(v.title)}</b></div>`;
    if (v.kind === 'word') return `<div class="v-word"><b>${esc(v.text)}</b><span>Mime-le avec ton corps !</span></div>`;
    if (v.kind === 'listen') return `<div class="v-listen" aria-hidden="true"><svg viewBox="0 0 120 120" width="140"><circle cx="60" cy="60" r="56" fill="var(--c-soft)"/><path d="M42 72 q-6 -30 18 -36 q24 -4 26 20 q2 14 -12 20 q-8 4 -8 14 q0 10 -10 10" fill="none" stroke="var(--c)" stroke-width="8" stroke-linecap="round"/><path d="M84 30 q14 12 14 30 M92 22 q20 16 20 38" fill="none" stroke="var(--c)" stroke-width="5" stroke-linecap="round" opacity=".6"/></svg></div>`;
    if (v.kind === 'numberline') return vNumberline(v);
    if (v.kind === 'split') return vSplit(v);
    if (v.kind === 'tenframe') return vTenframe(v);
    if (v.kind === 'fingers') return vFingers(v);
    if (v.kind === 'scenes') return vScenes(v);
    return '';
  }).join('');
}
const FISH = gold => `<svg width="40" height="25" viewBox="0 0 40 25" aria-hidden="true"><path d="M30 12.5 L40 3 L40 22 Z" fill="${gold ? '#e0a100' : '#7fb4cf'}" stroke="${gold ? '#8a6400' : '#3d7fa3'}" stroke-width="1.5"/><ellipse cx="17" cy="12.5" rx="15" ry="9.5" fill="${gold ? '#e0a100' : '#7fb4cf'}" stroke="${gold ? '#8a6400' : '#3d7fa3'}" stroke-width="1.5"/><circle cx="9" cy="10.5" r="1.8" fill="#1b2430"/></svg>`;

/* ============================ carte du voyage ============================ */
const RIVER = 'M40 290 C 110 285, 150 262, 205 250 S 290 238, 318 205 S 360 110, 420 88 S 520 92, 575 160';
const ESC_AT = [0, 0.24, 0.45, 0.73, 1];
function journey(c) {
  const done = INDEX.filter(l => l.child === c && S.progress[c].done[l.id]);
  let f = 0, stamps = [];
  ESCALES.forEach((e, i) => {
    const n = done.filter(l => (l.escale || 1) === e.n).length;
    if (n >= e.sessions) stamps.push(e.n);
    if (n > 0 && i < ESC_AT.length - 1) f = Math.max(f, ESC_AT[i] + (ESC_AT[i + 1] - ESC_AT[i]) * Math.min(1, n / e.sessions));
  });
  return { f, stamps, count: done.length };
}
function mapHTML(c) {
  const j = journey(c);
  return `<div class="map"><svg viewBox="0 0 620 330" role="img" aria-label="Carte du voyage sur le fleuve Niger">
  <rect x="0" y="0" width="620" height="330" rx="18" fill="#f3ead6"/>
  <path d="M300 30 q60 -10 120 10 q70 20 150 0" fill="none" stroke="#e2cfa6" stroke-width="30" stroke-linecap="round" opacity=".7"/>
  <path d="${RIVER}" fill="none" stroke="#7fb4cf" stroke-width="16" stroke-linecap="round"/>
  <path class="river" d="${RIVER}" fill="none" stroke="#3d7fa3" stroke-width="3" stroke-dasharray="2 10" stroke-linecap="round"/>
  <g class="escales"></g><g class="boat-pos">${BOAT}</g></svg>
  <div class="passport">${ESCALES.map(e => `<span class="stamp ${j.stamps.includes(e.n) ? 'on' : ''}" title="${esc(e.name)}">${esc(e.name.split(' ')[0])}</span>`).join('')}</div></div>`;
}
function drawMap(root, c, from) {
  const svg = root.querySelector('.map svg'); if (!svg) return;
  const path = svg.querySelector('.river'), L = path.getTotalLength(), g = svg.querySelector('.escales');
  g.innerHTML = ESCALES.map((e, i) => { const p = path.getPointAtLength(L * ESC_AT[i]); return `<circle cx="${p.x}" cy="${p.y}" r="7" fill="#fff" stroke="#1b2430" stroke-width="3"/><text x="${p.x}" y="${p.y + (i === 3 ? -18 : 30)}" text-anchor="middle" font-family="Nunito, Andika, sans-serif" font-weight="800" font-size="17" fill="#1b2430">${esc(e.name)}</text>`; }).join('');
  const boat = svg.querySelector('.boat-pos'), to = journey(c).f;
  const place = f => { const p = path.getPointAtLength(L * f); boat.setAttribute('transform', `translate(${p.x} ${p.y - 18}) scale(1.6)`); };
  if (from == null || from === to || FAST) { place(to); return; }
  const t0 = performance.now();
  const step = t => { const k = Math.min(1, (t - t0) / 1600); place(from + (to - from) * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

/* ============================ écrans ============================ */
function setChild(c) { child = c; document.body.dataset.child = c || ''; }
function kidLabel(c) { return name(c) || (c === 'bleu' ? 'Bleu' : 'Orange'); }

function screenSetup() {
  setChild(null); stopSpeech();
  app.innerHTML = `<div class="stack">
  <div class="brand">${KONO.replace('class="kono"', 'class="kono" style="width:90px"')}<div><h1>L'école de Kono</h1><p class="muted">Réglage de départ, à faire une seule fois par un parent.</p></div></div>
  <div class="card stack"><h3>Les enfants</h3>
    ${['bleu', 'orange'].map(c => `<div class="row"><label class="f" style="flex:1 1 220px">Prénom de l'enfant ${c === 'bleu' ? 'Bleu (7 ans)' : 'Orange (5 ans ½)'}<input type="text" id="n-${c}" value="${esc(S.names[c])}" autocomplete="off"></label>
      <div class="seg" role="group" aria-label="Fille ou garçon"><button data-g="${c}:0" class="${S.girl[c] ? '' : 'on'}">Garçon</button><button data-g="${c}:1" class="${S.girl[c] ? 'on' : ''}">Fille</button></div></div>`).join('')}
    <p class="small muted">Le prénom sert à saluer l'enfant. Garçon ou fille sert à accorder les phrases (« tu t'es trompée »).</p></div>
  <div class="card stack"><h3>Code parent (4 chiffres)</h3><input type="password" id="pin" inputmode="numeric" maxlength="4" value="${esc(S.pin)}" placeholder="ex. 2468"><p class="small muted">Il protège l'espace parent : suivi, enregistrements, voix de Maman.</p></div>
  <div class="card stack"><h3>La voix de Kono</h3>${voiceControls()}</div>
  <div class="row"><button class="btn big" id="go" style="--c:var(--river)">Enregistrer et commencer</button><span id="err" class="small" style="color:var(--try)"></span></div></div>`;
  bindVoiceControls();
  app.querySelectorAll('[data-g]').forEach(b => b.onclick = () => { const [c, g] = b.dataset.g.split(':'); S.girl[c] = g === '1'; b.parentElement.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); });
  $('#go').onclick = () => {
    const pin = $('#pin').value.trim();
    if (!/^\d{4}$/.test(pin)) { $('#err').textContent = 'Le code doit faire 4 chiffres.'; return; }
    S.pin = pin; S.names.bleu = $('#n-bleu').value.trim(); S.names.orange = $('#n-orange').value.trim();
    S.setup = true; save(); screenHome();
  };
}
function voiceControls() {
  loadVoices();
  const nFiles = Object.keys(AUDIO.files).length;
  const opts = voices.map(v => `<option value="${esc(v.name)}" ${v.name === (pickVoice() || {}).name ? 'selected' : ''}>${esc(v.name)} (${esc(v.lang)})${v.localService ? ' · hors ligne' : ''}</option>`).join('');
  return `<p class="small" style="margin:0">${nFiles ? `${nFiles} phrases ont une voix enregistrée ou générée à l'avance. La voix de la tablette ne sert que pour les autres.` : `Aucune voix générée à l'avance pour l'instant : c'est la voix de la tablette qui parle.`}</p>
  ${voices.length ? `<label class="f">Voix française de la tablette<select id="v-name">${opts}</select></label>` : `<p class="small" style="color:var(--try)">Aucune voix française trouvée sur cet appareil. Android : Paramètres › Synthèse vocale › Moteur Google › Installer les données vocales › Français (France). Puis rouvrir l'application.</p>`}
  <label class="f">Vitesse<input type="range" id="v-rate" min="0.7" max="1.1" step="0.05" value="${S.voice.rate}"></label>
  <div class="row"><button class="btn soft" id="v-test" type="button">Écouter Kono</button><span class="small muted">Choisissez de préférence une voix marquée « hors ligne ».</span></div>`;
}
function bindVoiceControls() {
  const sel = $('#v-name'), rate = $('#v-rate');
  if (sel) sel.onchange = () => { S.voice.name = sel.value; save(); };
  if (rate) rate.oninput = () => { S.voice.rate = Number(rate.value); save(); };
  const t = $('#v-test'); if (t) t.onclick = () => speak(PH.voiceTest);
}

function screenHome() {
  setChild(null); stopSpeech();
  app.innerHTML = `<div class="stack">
  <div class="brand">${KONO.replace('class="kono"', 'class="kono" style="width:96px"')}<div><h1>L'école de Kono</h1><p class="muted">Qui voyage avec Kono aujourd'hui ?</p></div></div>
  <div class="kids">
    <button class="kid bleu" data-c="bleu"><b>${esc(kidLabel('bleu'))}</b><span>Parcours bleu · 7 ans</span></button>
    <button class="kid orange" data-c="orange"><b>${esc(kidLabel('orange'))}</b><span>Parcours orange · 5 ans ½</span></button>
  </div>
  <div class="row" style="justify-content:space-between"><button class="link" id="parent">Espace parent</button><span class="small muted">v${VERSION}</span></div></div>`;
  app.querySelectorAll('[data-c]').forEach(b => b.onclick = () => screenChild(b.dataset.c));
  $('#parent').onclick = screenPin;
}
function nextLesson(c) { return INDEX.filter(l => l.child === c).find(l => !S.progress[c].done[l.id]) || null; }
function screenChild(c) {
  setChild(c); stopSpeech();
  const list = INDEX.filter(l => l.child === c), nx = nextLesson(c);
  app.innerHTML = `<div class="stack">
  <div class="row" style="justify-content:space-between"><button class="btn ghost" id="back">Retour</button><h2 style="color:var(--c)">${esc(kidLabel(c))}</h2></div>
  <div class="home-grid">
    <div class="card stack center">
      ${nx ? `<p class="muted" style="margin:0">Séance du jour</p><h2 style="font-size:2rem">${esc(nx.title)}</h2><div><button class="btn big" id="start">Monter dans la pinasse</button></div>
        <p class="small muted" style="margin:0">Prépare ton crayon et ta fiche ${c === 'bleu' ? 'bleue' : 'orange'}.</p>`
      : `<h2>Toutes les séances sont faites</h2><p class="muted">La prochaine séance arrive dimanche. Tu peux refaire une séance ci-dessous.</p>`}
    </div>
    <div class="card">${mapHTML(c)}</div>
  </div>
  <div class="card"><h3 style="margin-bottom:6px">Mes séances</h3>
    ${list.map(l => `<div class="lesson-row"><span class="tick ${S.progress[c].done[l.id] ? 'done' : ''}">${S.progress[c].done[l.id] ? '✓' : ''}</span><span style="flex:1">${esc(l.title)} <span class="small muted">· ${esc(l.week)}</span></span><button class="btn soft sm" data-l="${l.id}">${S.progress[c].done[l.id] ? 'Refaire' : 'Ouvrir'}</button></div>`).join('')}
  </div></div>`;
  drawMap(app, c);
  $('#back').onclick = screenHome;
  const st = $('#start'); if (st) st.onclick = () => startLesson(nx.id);
  app.querySelectorAll('[data-l]').forEach(b => b.onclick = () => startLesson(b.dataset.l));
}

/* ============================ lecteur de séance ============================ */
let P = null, wake = null;
function expandSteps(lesson) {
  const out = [];
  lesson.steps.forEach(st => {
    if (st.type === 'review') {
      const q = S.progress[child].review.slice(0, 2).map(r => {
        const L = LESSONS[r.lesson]; if (!L) return null;
        const pool = L.steps.concat(...L.steps.filter(x => x.type === 'review').map(x => x.fallback || []), ...L.steps.filter(x => x.type === 'story').map(x => x.questions || []));
        const s = pool.find(x => x.id === r.id);
        return s ? Object.assign({}, s, { fromReview: r, text: PH.reviewIntro + ' ' + s.text, say: PH.reviewIntro + ' ' + (s.say || s.text) }) : null;
      }).filter(Boolean);
      out.push(...(q.length ? q : st.fallback || []));
      return;
    }
    if (st.type === 'story') {
      out.push({ type: 'listen', title: st.title, sentences: st.sentences });
      (st.vocab || []).forEach(v => out.push({ type: 'say', text: v.say, show: [{ kind: 'word', text: v.word }] }));
      out.push(...(st.questions || []));
      out.push({ type: 'say', text: PH.storyScenes, show: [{ kind: 'scenes', scenes: st.scenes }] });
      out.push({ type: 'record', kind: 'recit', story: st.id, text: st.retell, show: [{ kind: 'scenes', scenes: st.scenes }] });
      return;
    }
    out.push(st);
  });
  return out;
}
async function startLesson(id) {
  const lesson = LESSONS[id];
  const steps = expandSteps(lesson);
  P = { lesson, steps, i: 0, stepToken: 0, fish: 0, gold: 0, fromF: journey(child).f, fromStamps: journey(child).stamps.length,
    run: { lesson: id, title: lesson.title, date: today(), start: Date.now(), end: null, done: false, items: [], recs: 0, drill: null } };
  try { if ('wakeLock' in navigator) wake = await navigator.wakeLock.request('screen'); } catch (e) { wake = null; }
  app.innerHTML = `<div class="lesson">
    <div class="l-top"><button class="btn ghost sm" id="quit">Arrêter</button><h2>${esc(lesson.title)}</h2><div class="parts" id="parts"></div></div>
    <div class="l-main"><aside class="guide">${KONO}<div class="bubble" id="bubble"></div></aside><section class="stage" id="stage"></section></div>
    <section class="answer" id="answer"></section>
    <div class="l-ctrl"><button class="btn ghost" id="repeat">Répéter</button><button class="btn" id="next" hidden>Suivant</button></div></div>`;
  $('#quit').onclick = () => { stopSpeech(); saveRun(false); endWake(); screenChild(child); };
  $('#next').onclick = () => { P.i++; runStep(); };
  $('#repeat').onclick = () => { if (P.repeat) P.repeat(); };
  runStep();
}
function endWake() { try { if (wake) wake.release(); } catch (e) {} wake = null; }
function bubble(text, kind) {
  const b = $('#bubble'); if (!b) return;
  b.className = 'bubble' + (kind ? ' ' + kind : '');
  b.innerHTML = `<span class="who">${kind === 'maman' ? 'Maman' : 'Kono'}</span>${esc(text)}`;
}
function stage(list) { $('#stage').innerHTML = visual(list) || KONO.replace('class="kono"', 'class="kono" style="width:120px"'); }
function showNext(on = true, label) { const n = $('#next'); if (!n) return; n.hidden = !on; if (label) n.textContent = label; }
function drawParts() {
  const parts = P.steps.map((s, k) => [s, k]).filter(([s]) => s.type === 'part');
  const el = $('#parts'); if (!el) return;
  if (!parts.length) { el.innerHTML = ''; return; }
  const cur = parts.filter(([, k]) => k <= P.i).length;
  el.innerHTML = parts.map(([s], j) => `<span class="${j + 1 < cur ? 'done' : j + 1 === cur ? 'on' : ''}"><i>${s.n}</i><em>${esc(s.title)}</em></span>`).join('');
}

async function runStep() {
  stopSpeech(); showNext(false, 'Suivant'); $('#answer').innerHTML = ''; P.repeat = null;
  const st = P.steps[P.i]; if (!st) return;
  drawParts();
  const my = ++P.stepToken;
  const alive = () => P && P.stepToken === my;
  $('#repeat').hidden = false;
  switch (st.type) {
    case 'maman': {
      stage([]);
      const said = await playClip(st.clip, (isMaman, txt) => bubble(isMaman ? 'Un message pour toi…' : txt, isMaman ? 'maman' : ''));
      if (!alive()) return;
      if (said) await sleep(300);
      if (alive()) { P.i++; runStep(); }
      return;
    }
    case 'part': {
      stage([{ kind: 'part', n: st.n, title: st.title }]); bubble(st.text);
      await speak(st.text); await sleep(500);
      if (alive()) { P.i++; runStep(); }
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
        const me = ++demoRun; showNext(false);
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
    case 'drill': return drillStep(st, alive);
    case 'paper': return paperStep(st, alive);
    case 'reading': return readingStep(st, alive);
    case 'listen': return listenStep(st, alive);
    case 'record': return recordStep(st, alive);
    case 'end': return endStep(st, alive);
    default: P.i++; return runStep();
  }
}

function addReview(st) { if (!st.id) return; const r = { lesson: st.fromReview ? st.fromReview.lesson : P.lesson.id, id: st.id }; const q = S.progress[child].review; if (!q.some(x => x.lesson === r.lesson && x.id === r.id)) q.push(r); }
function dropReview(st) { if (!st.fromReview) return; const q = S.progress[child].review; const k = q.findIndex(x => x.lesson === st.fromReview.lesson && x.id === st.fromReview.id); if (k >= 0) q.splice(k, 1); }
function keypadHTML(okLabel = 'OK') { return `<div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button class="key" data-k="${n}">${n}</button>`).join('')}<button class="key del" data-k="del">Effacer</button><button class="key" data-k="0">0</button><button class="key ok" data-k="ok">${okLabel}</button></div>`; }

function askStep(st, alive) {
  stage(st.show); bubble(fill(st.text));
  const item = { id: st.id || '', q: st.text, answer: st.answer, answers: [], ok: false, first: false, review: !!st.fromReview };
  P.run.items.push(item);
  let tries = 0, value = '', wrong = [], done = false;
  P.repeat = () => speak(fill(st.say || st.text));
  speak(fill(st.say || st.text));
  const txt = st.options && st.options.some(o => String(o).length > 4);
  const draw = () => {
    if (st.type === 'number') {
      $('#answer').innerHTML = `<div class="ans-box ${value ? 'filled' : ''}" aria-live="polite">${esc(value) || '&nbsp;'}</div>` + (done ? '' : keypadHTML());
      $('#answer').querySelectorAll('[data-k]').forEach(b => b.onclick = () => {
        const k = b.dataset.k;
        if (k === 'del') value = value.slice(0, -1);
        else if (k === 'ok') { if (value !== '') submit(value); return; }
        else if (value.length < 4) value = (value === '0' ? '' : value) + k;
        draw();
      });
    } else {
      $('#answer').innerHTML = `<div class="choices ${txt ? 'txt' : ''}">${st.options.map(o => `<button class="choice ${txt ? 'txt' : ''} ${wrong.includes(String(o)) ? 'no' : ''} ${done && String(o) === String(st.answer) ? 'yes' : ''}" data-o="${esc(o)}" ${done || wrong.includes(String(o)) ? 'disabled' : ''}>${esc(o)}</button>`).join('')}</div>`;
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
      const msg = (item.first ? pick(PH.good) : fill(PH.gold)) + (st.sol ? ' ' + st.sol : '');
      bubble(msg, 'good'); await speak(msg);
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
      const msg = `${PH.revealStart} ${st.sol || st.answer} ${PH.revealEnd}`;
      bubble(msg, 'try'); await speak(msg); if (alive()) showNext();
      return;
    }
    draw();
    const why = (st.errors && st.errors[String(val)]) || (st.hints && st.hints[Math.min(tries - 1, st.hints.length - 1)]) || PH.lookAgain;
    const msg = PH.notYet + ' ' + (tries > 1 ? PH.otherWay + ' ' : '') + why;
    bubble(msg, 'try'); await speak(msg);
  };
  draw();
}

/* ---------- automatismes : calcul express / jeu rapide ---------- */
function opts3(ans, near) {
  const set = new Set([ans]); const cand = shuffle([near, ans + 1, ans - 1, ans + 2, ans - 2].filter(x => x != null && x >= 0 && x <= 10 && x !== ans));
  for (const x of cand) { if (set.size >= 3) break; set.add(x); }
  return shuffle([...set]);
}
function genItem(k) {
  switch (k.kind) {
    case 'complement10': { const a = rnd(1, 9); return { q: `${a} + ? = 10`, answer: 10 - a }; }
    case 'complement-next-ten': { const t = rnd(2, 9) * 10, a = t - rnd(1, 9); return { q: `${a} + ? = ${t}`, answer: t - a }; }
    case 'through10': { let a, b; do { a = rnd(1, 8) * 10 + rnd(5, 9); b = rnd(3, 9); } while (a % 10 + b < 10 || a + b > 99); return { q: `${a} + ${b}`, answer: a + b }; }
    case 'double': { const n = rnd(k.min || 5, k.max || 25); return { q: `le double de ${n}`, answer: 2 * n }; }
    case 'table': { const n = pick(k.n || [2]), m = rnd(1, 10); return { q: `${n} × ${m}`, answer: n * m }; }
    case 'tf-complement': { const f = rnd(1, 9); return { q: 'Combien de cases vides ?', show: [{ kind: 'tenframe', filled: f, small: true }], answer: 10 - f, options: opts3(10 - f, f) }; }
    case 'count-tf': { const f = rnd(2, 10); return { q: 'Combien de points ?', show: [{ kind: 'tenframe', filled: f, small: true }], answer: f, options: opts3(f, 10 - f) }; }
    case 'decomp': { const n = pick(k.n || [5]), a = rnd(0, n); return { q: `${n}, c'est ${a} et combien ?`, show: [{ kind: 'fingers', up: n }], answer: n - a, options: opts3(n - a, a) }; }
    default: return { q: '1 + 1', answer: 2 };
  }
}
function weightedKind(kinds) {
  const sk = S.progress[child].skills;
  const ws = kinds.map(k => { const s = sk[k.kind]; const err = s && s.n >= 3 ? s.ko / s.n : 0; return (k.w || 1) * (1 + 2 * err); });
  let r = Math.random() * ws.reduce((a, b) => a + b, 0);
  for (let i = 0; i < kinds.length; i++) { r -= ws[i]; if (r <= 0) return kinds[i]; }
  return kinds[kinds.length - 1];
}
function drillStep(st, alive) {
  const prog = S.progress[child], rec = prog.records[st.id];
  stage([{ kind: 'title', text: st.title }]);
  bubble(st.text);
  const intro = st.text + ' ' + PH.drillGo;
  P.repeat = () => speak(intro); speak(intro);
  $('#answer').innerHTML = `<div class="center stack"><p class="muted" style="margin:0">${rec ? `Ton record : <b>${rec.best} sur ${st.count}</b>` : 'Pas encore de record.'}</p><div><button class="btn big" id="go">C'est parti !</button></div></div>`;
  $('#go').onclick = () => {
    stopSpeech(); $('#repeat').hidden = true;
    const misses = (prog.drillMisses[st.id] || []).slice(0, 3);
    const items = misses.concat(Array.from({ length: Math.max(0, st.count - misses.length) }, () => { const k = weightedKind(st.kinds); return Object.assign(genItem(k), { kind: k.kind }); }));
    let i = 0, score = 0, value = '', over = false; const missed = []; const t0 = Date.now();
    const bar = () => { const el = $('#dbar'); if (el) el.style.width = Math.min(100, (Date.now() - t0) / (st.seconds * 10)) + '%'; };
    const timer = setInterval(() => { if (!alive()) { clearInterval(timer); return; } bar(); if (Date.now() - t0 >= st.seconds * 1000) finish(); }, 250);
    const draw = (flash) => {
      const it = items[i];
      stage([]);
      $('#stage').innerHTML = `<div class="drill"><div class="dbar"><i id="dbar"></i></div><p class="muted" style="margin:0">${i + 1} / ${items.length}</p>${visual(it.show)}<div class="v-expr">${esc(it.q)}</div>${flash || ''}</div>`;
      bar();
      if (st.input === 'keypad') {
        $('#answer').innerHTML = `<div class="ans-box ${value ? 'filled' : ''}">${esc(value) || '&nbsp;'}</div>` + keypadHTML();
        $('#answer').querySelectorAll('[data-k]').forEach(b => b.onclick = () => {
          if (over) return; const k = b.dataset.k;
          if (k === 'del') value = value.slice(0, -1); else if (k === 'ok') { if (value !== '') answer(value); return; } else if (value.length < 4) value = (value === '0' ? '' : value) + k;
          draw();
        });
      } else {
        $('#answer').innerHTML = `<div class="choices">${it.options.map(o => `<button class="choice" data-o="${o}">${o}</button>`).join('')}</div>`;
        $('#answer').querySelectorAll('[data-o]').forEach(b => b.onclick = () => { if (!over) answer(b.dataset.o); });
      }
    };
    const answer = async val => {
      const it = items[i], ok = String(val) === String(it.answer);
      const sk = S.progress[child].skills[it.kind] || (S.progress[child].skills[it.kind] = { n: 0, ko: 0 }); sk.n++; if (!ok) sk.ko++;
      if (ok) score++; else missed.push({ q: it.q, answer: it.answer, show: it.show, options: it.options, kind: it.kind });
      value = ''; over = true;
      draw(ok ? '<div class="flash ok">✓</div>' : `<div class="flash ko">La réponse : ${esc(it.answer)}</div>`);
      $('#answer').innerHTML = '';
      await sleep(ok ? 350 : 1400); over = false;
      if (!alive() || finish.done) return;
      i++; if (i >= items.length) finish(); else draw();
    };
    const finish = async () => {
      if (!alive() || finish.done) return; finish.done = true; clearInterval(timer); over = true;
      const secs = Math.round((Date.now() - t0) / 1000);
      const best = prog.records[st.id];
      const isRecord = !best || score > best.best || (score === best.best && secs < best.secs);
      prog.records[st.id] = isRecord ? { best: score, secs, date: today() } : best;
      prog.drillMisses[st.id] = missed.slice(0, 5);
      P.run.drill = { id: st.id, score, count: items.length, secs, record: isRecord };
      save();
      $('#stage').innerHTML = `<div class="drill"><div class="v-title">${score} sur ${items.length}</div><p class="muted" style="margin:0">en ${Math.floor(secs / 60)} min ${String(secs % 60).padStart(2, '0')} s</p>${isRecord ? '<p class="badge">Record !</p>' : `<p class="muted">Ton record : ${best.best} sur ${items.length}</p>`}</div>`;
      $('#answer').innerHTML = '';
      const msg = !best ? PH.drillFirst : isRecord ? PH.drillRecord : PH.drillNoRecord;
      bubble(msg, 'good'); await speak(msg);
      if (!alive()) return;
      if (missed.length) {
        bubble(PH.drillMisses); await speak(PH.drillMisses);
        for (const m of missed) {
          if (!alive()) return;
          const ok = await quickRetry(m, st.input);
          if (ok) { const k = prog.drillMisses[st.id].findIndex(x => x.q === m.q); if (k >= 0) prog.drillMisses[st.id].splice(k, 1); }
        }
        save();
      }
      if (alive()) { $('#repeat').hidden = false; showNext(); }
    };
    draw();
  };
}
function quickRetry(m, input) {
  return new Promise(res => {
    let value = '';
    const draw = () => {
      $('#stage').innerHTML = `<div class="drill">${visual(m.show)}<div class="v-expr">${esc(m.q)}</div></div>`;
      if (input === 'keypad') {
        $('#answer').innerHTML = `<div class="ans-box ${value ? 'filled' : ''}">${esc(value) || '&nbsp;'}</div>` + keypadHTML();
        $('#answer').querySelectorAll('[data-k]').forEach(b => b.onclick = () => { const k = b.dataset.k; if (k === 'del') value = value.slice(0, -1); else if (k === 'ok') { if (value !== '') done(value); return; } else if (value.length < 4) value = (value === '0' ? '' : value) + k; draw(); });
      } else {
        $('#answer').innerHTML = `<div class="choices">${m.options.map(o => `<button class="choice" data-o="${o}">${o}</button>`).join('')}</div>`;
        $('#answer').querySelectorAll('[data-o]').forEach(b => b.onclick = () => done(b.dataset.o));
      }
    };
    const done = async v => {
      const ok = String(v) === String(m.answer);
      $('#answer').innerHTML = '';
      $('#stage').insertAdjacentHTML('beforeend', ok ? '<div class="flash ok">✓</div>' : `<div class="flash ko">La réponse : ${m.answer}</div>`);
      await sleep(ok ? 400 : 1500); res(ok);
    };
    draw();
  });
}

/* ---------- la fiche papier ---------- */
function paperItems() {
  const out = [];
  (P.lesson.paper.levels || []).forEach(lv => lv.items.forEach(it => { if (it.answer !== undefined) out.push(Object.assign({ stars: lv.stars }, it)); }));
  return out;
}
function paperStep(st, alive) {
  stage([{ kind: 'title', text: 'Ta fiche ' + (child === 'bleu' ? 'bleue' : 'orange') }, { kind: 'text', text: `« ${P.lesson.paper.title} »` }]);
  bubble(fill(st.text));
  P.repeat = () => speak(fill(st.say || st.text)); speak(fill(st.say || st.text));
  $('#answer').innerHTML = `<div class="center"><button class="btn big" id="fini">J'ai fini ma fiche</button></div>`;
  $('#fini').onclick = () => {
    const items = paperItems(); const vals = {}, res = {}; let sel = items[0] ? items[0].id : null, round = 0;
    const draw = () => {
      $('#answer').innerHTML = `<div class="paper-list">${items.map(it => {
        const r = res[it.id];
        return `<button class="p-item ${sel === it.id && round < 2 && (!r || !r.ok) ? 'sel' : ''} ${r ? (r.ok ? 'ok' : 'ko') : ''}" data-i="${it.id}"><span class="lab"><span class="stars">${'★'.repeat(it.stars)}</span> ${esc(it.short || it.q)}${r && !r.ok && r.why ? `<span class="why">${esc(r.why)}</span>` : ''}</span><span class="val">${esc(vals[it.id] || '')}</span><span class="mark">${r ? (r.ok ? '✓' : '✗') : ''}</span></button>`;
      }).join('')}</div>${round < 2 ? keypadHTML('Vérifier') : ''}
      <p class="small muted center" style="margin:0">Touche une ligne, puis tape ta réponse. Laisse vide ce que tu n'as pas fait.</p>`;
      $('#answer').querySelectorAll('[data-i]').forEach(b => b.onclick = () => { if (round < 2) { sel = b.dataset.i; draw(); } });
      $('#answer').querySelectorAll('[data-k]').forEach(b => b.onclick = () => {
        const k = b.dataset.k; if (k === 'ok') return check();
        if (!sel || (res[sel] && res[sel].ok)) return;
        let v = vals[sel] || ''; if (k === 'del') v = v.slice(0, -1); else if (v.length < 4) v = (v === '0' ? '' : v) + k;
        vals[sel] = v; if (res[sel]) delete res[sel]; draw();
      });
    };
    const check = async () => {
      if (!items.some(it => vals[it.id])) { bubble(PH.paperEmpty, 'try'); speak(PH.paperEmpty); return; }
      round++; let firstWhy = '', nOk = 0, nKo = 0;
      items.forEach(it => {
        const v = vals[it.id]; if (v === undefined || v === '') return;
        if (res[it.id] && res[it.id].ok) { nOk++; return; }
        const ok = String(v) === String(it.answer);
        let rec = P.run.items.find(x => x.id === 'fiche-' + it.id);
        if (!rec) { rec = { id: 'fiche-' + it.id, q: 'Fiche ' + '★'.repeat(it.stars) + ' ' + (it.short || it.q), answer: it.answer, answers: [], ok: false, first: false, paper: true }; P.run.items.push(rec); }
        rec.answers.push(String(v)); rec.ok = ok; rec.first = ok && rec.answers.length === 1;
        const why = ok ? '' : ((it.errors && it.errors[String(v)]) || (round >= 2 ? `La réponse était ${it.answer}.` : PH.paperLook));
        res[it.id] = { ok, why };
        if (ok) { nOk++; if (rec.first) P.fish++; else P.gold++; } else { nKo++; if (!firstWhy && it.errors && it.errors[String(v)]) firstWhy = why; }
      });
      if (round >= 2) items.forEach(it => { if (res[it.id] && !res[it.id].ok) vals[it.id] = String(it.answer); });
      save(); draw();
      const said = nKo === 0 ? PH.paperAllGood : round < 2 ? PH.paperFix + (firstWhy ? ' ' + firstWhy : '') : PH.paperFinal;
      bubble(`${nOk} juste${nOk > 1 ? 's' : ''}${nKo ? `, ${nKo} à revoir` : ''}. ${said}`, nKo ? 'try' : 'good'); await speak(said);
      if (alive() && (nKo === 0 || round >= 2)) { round = 2; draw(); showNext(); }
    };
    draw();
  };
}

/* ---------- enregistreur réutilisable ---------- */
function recorder(onKeep, onSkip) {
  const canRec = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  if (!canRec) { $('#answer').innerHTML = `<p class="center">${esc(PH.micOff)}</p>`; onSkip(); return; }
  let rec = null, chunks = [], blob = null, t0 = 0, dur = 0, timer = null, stream = null;
  const draw = state => {
    $('#answer').innerHTML = state === 'idle' ? `<button class="rec-btn" id="rb" aria-label="Enregistrer"></button><p class="center muted" style="margin:0">Appuie sur le rond rouge pour parler.</p>`
      : state === 'on' ? `<button class="rec-btn on" id="rb" aria-label="Arrêter"></button><p class="center" style="margin:0"><b id="tm">0 s</b> · appuie encore pour t'arrêter</p>`
      : `<div class="row" style="justify-content:center"><button class="btn soft" id="play">Écouter</button><button class="btn ghost" id="redo">Recommencer</button><button class="btn" id="keep">Garder</button></div>`;
    const rb = $('#rb'); if (rb) rb.onclick = state === 'idle' ? start : stop;
    if (state === 'done') {
      $('#play').onclick = () => { stopSpeech(); playFile(URL.createObjectURL(blob)); };
      $('#redo').onclick = () => { blob = null; draw('idle'); };
      $('#keep').onclick = async () => { showNext(false); $('#keep').disabled = true; await onKeep(blob, dur); };
    }
  };
  const start = async () => {
    stopSpeech();
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { $('#answer').innerHTML = `<p class="center">${esc(PH.micOff)}</p>`; onSkip(); return; }
    chunks = []; rec = new MediaRecorder(stream); rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => { blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' }); stream.getTracks().forEach(t => t.stop()); clearInterval(timer); dur = Math.max(1, Math.round((Date.now() - t0) / 1000)); draw('done'); };
    rec.start(); t0 = Date.now(); draw('on');
    timer = setInterval(() => { const s = Math.round((Date.now() - t0) / 1000); const el = $('#tm'); if (el) el.textContent = s + ' s'; if (s >= 150) stop(); }, 500);
  };
  const stop = () => { try { if (rec && rec.state !== 'inactive') rec.stop(); } catch (e) {} };
  draw('idle');
}
async function saveRecording(kind, q, blob, dur, extra) {
  await DB.addRec(Object.assign({ child, lesson: P.lesson.id, title: P.lesson.title, kind, q, ts: Date.now(), dur, mime: blob.type, blob }, extra || {}));
  P.run.recs++; save();
}
function recordStep(st, alive) {
  stage(st.show || [{ kind: 'title', text: 'Explique avec ta voix' }]);
  bubble(fill(st.text));
  P.repeat = () => speak(fill(st.say || st.text));
  (async () => { await speak(fill(st.say || st.text)); if (alive() && st.clip && await hasClip(st.clip)) { bubble('Un message pour toi…', 'maman'); await playClip(st.clip); if (alive()) bubble(fill(st.text)); } })();
  recorder(async (blob, dur) => { await saveRecording(st.kind || 'methode', st.text, blob, dur, st.story ? { story: st.story } : null); if (alive()) { P.i++; runStep(); } }, () => showNext());
  showNext(true, 'Passer');
}

/* ---------- lecture répétée (fluence) ---------- */
function passageHTML(sents, hl) { return `<div class="passage">${sents.map((s, i) => `<span class="${i === hl ? 'hl' : ''}">${esc(s)}</span>`).join(' ')}</div>`; }
function readingStep(st, alive) {
  const words = st.passage.join(' ').split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
  const listen = async () => {
    showNext(false); $('#answer').innerHTML = '';
    $('#stage').innerHTML = `<div class="v-title" style="font-size:1.6rem">${esc(st.title)}</div>` + passageHTML(st.passage, -1);
    bubble(PH.readListen); await speak(PH.readListen);
    for (let i = 0; i < st.passage.length; i++) {
      if (!alive()) return;
      $('#stage').querySelector('.passage').outerHTML = passageHTML(st.passage, i);
      const ok = await speakWhole(st.passage[i]); if (!ok) return; await sleep(250);
    }
    if (!alive()) return;
    $('#stage').querySelector('.passage').outerHTML = passageHTML(st.passage, -1);
    bubble(PH.readYourTurn); speak(PH.readYourTurn);
    recorder(async (blob, dur) => {
      await saveRecording('lecture', st.title, blob, dur, { passage: st.passage, words });
      if (alive()) { P.i++; runStep(); }
    }, () => showNext());
    showNext(true, 'Passer');
  };
  P.repeat = listen; listen();
}
/* ---------- histoire : écoute sans images ---------- */
function listenStep(st, alive) {
  const play = async () => {
    showNext(false);
    stage([{ kind: 'listen' }, { kind: 'title', text: st.title }]);
    bubble(PH.storyListen); await speak(PH.storyListen); if (!alive()) return;
    bubble('…', '');
    for (const s of st.sentences) { if (!alive()) return; const ok = await speakWhole(s); if (!ok) return; await sleep(350); }
    if (alive()) { bubble('Tu veux réécouter ? Appuie sur Répéter. Sinon, Suivant.'); showNext(); }
  };
  P.repeat = play; play();
}

/* ---------- fin de séance ---------- */
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
  $('#repeat').hidden = true;
  $('#stage').innerHTML = `<div class="v-title">Séance terminée</div><p class="muted" style="margin:0">${mins} minute${mins > 1 ? 's' : ''} de travail · ${P.fish + P.gold} réponse${P.fish + P.gold > 1 ? 's' : ''} trouvée${P.fish + P.gold > 1 ? 's' : ''}${P.gold ? `, dont ${P.gold} après une erreur` : ''}${P.run.drill ? ` · automatismes ${P.run.drill.score} sur ${P.run.drill.count}` : ''}</p><div class="fishes">${Array.from({ length: P.fish }, () => FISH(false)).join('')}${Array.from({ length: P.gold }, () => FISH(true)).join('')}</div>${mapHTML(child)}`;
  drawMap($('#stage'), child, P.fromF);
  bubble(`${mins} minute${mins > 1 ? 's' : ''} de travail · ${P.fish + P.gold} réponse${P.fish + P.gold > 1 ? 's' : ''} trouvée${P.fish + P.gold > 1 ? 's' : ''}${P.gold ? `, dont ${P.gold} après une erreur` : ''}. ${PH.mapMove}`, 'good');
  await speak(PH.endDone + (P.gold ? ' ' + PH.endGold : '') + ' ' + PH.mapMove);
  if (!alive()) return;
  if (journey(child).stamps.length > P.fromStamps && await hasClip('bravo_escale')) { bubble('Un message pour toi…', 'maman'); await playClip('bravo_escale'); if (!alive()) return; }
  await playClip(st.clip, (isMaman, txt) => bubble(isMaman ? 'Un message pour toi…' : txt, isMaman ? 'maman' : 'good'));
  if (!alive()) return;
  showNext(true, 'Terminer'); $('#next').onclick = () => screenChild(child);
}

/* ============================ espace parent ============================ */
function screenPin() {
  setChild(null); stopSpeech();
  let v = '';
  const draw = () => {
    app.innerHTML = `<div class="stack" style="max-width:420px;margin:0 auto">
    <div class="row" style="justify-content:space-between"><button class="btn ghost" id="back" style="--c:var(--river)">Retour</button><h2>Espace parent</h2></div>
    <p class="center muted">Tapez le code parent.</p><div class="pin">${[0, 1, 2, 3].map(k => `<span>${v[k] ? '•' : ''}</span>`).join('')}</div>
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
const RECIT = ['Les personnages (Bintou, la grand-mère, le pêcheur)', 'Le lieu (le marché, le fleuve)', 'Le problème (le panier tombe dans le fleuve)', 'Les étapes dans l\'ordre', 'La fin (merci, la mangue offerte)', 'Les émotions (la peur, puis la joie)'];
function measureLine(m) { return m.type === 'fluence' ? `Lecture : <b>${m.wcpm} mots par minute</b> (${m.read} lus, ${m.errors} erreur${m.errors > 1 ? 's' : ''}, ${m.secs} s) · cible fin CE1 : 70` : `Récit : <b>${m.score} sur ${RECIT.length}</b>`; }
async function screenParent(tab) {
  setChild(null); stopSpeech();
  const tabs = [['suivi', 'Suivi'], ['maman', 'Voix de Maman'], ['kono', 'Voix de Kono'], ['rapport', 'Rapport'], ['reglages', 'Réglages']];
  app.innerHTML = `<div class="stack"><div class="row" style="justify-content:space-between"><h2>Espace parent</h2><button class="btn ghost" id="out" style="--c:var(--river)">Sortir</button></div>
  <div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${k === tab ? 'on' : ''}" data-t="${k}">${l}</button>`).join('')}</div><div id="pane" class="stack"></div></div>`;
  $('#out').onclick = screenHome;
  app.querySelectorAll('[data-t]').forEach(b => b.onclick = () => screenParent(b.dataset.t));
  const pane = $('#pane');
  if (tab === 'suivi') {
    const recs = (await DB.recs()) || [];
    pane.innerHTML = ['bleu', 'orange'].map(c => {
      const pr = S.progress[c], runs = pr.runs.slice().reverse(), rr = recs.filter(r => r.child === c).sort((a, b) => b.ts - a.ts);
      const recsDrill = Object.entries(pr.records).map(([k, r]) => `${esc(k)} : ${r.best} (${r.secs} s, ${esc(r.date)})`).join(' · ');
      return `<div class="card stack"><h3 style="color:${c === 'bleu' ? 'var(--bleu)' : 'var(--orange)'}">${esc(kidLabel(c))}</h3>
      ${pr.measures.length ? `<div><h3 style="font-size:1rem">Mesures</h3>${pr.measures.slice().reverse().map(m => `<p class="small" style="margin:2px 0">${esc(m.date)} · ${measureLine(m)}</p>`).join('')}</div>` : ''}
      ${recsDrill ? `<p class="small" style="margin:0"><b>Records d'automatismes :</b> ${recsDrill}</p>` : ''}
      ${runs.length ? runs.map(r => `<div><p style="margin:0 0 4px"><b>${esc(r.title)}</b> · ${fmtDate(r.start)} · ${Math.max(1, Math.round(((r.end || r.start) - r.start) / 60000))} min ${r.done ? '' : '· <span class="pill shown">arrêtée avant la fin</span>'}${r.drill ? ` · automatismes ${r.drill.score}/${r.drill.count} en ${r.drill.secs} s` : ''}</p>
        <div class="table-wrap"><table class="t"><tr><th>Question</th><th>Réponses tapées</th><th>Résultat</th></tr>${r.items.map(it => `<tr><td>${esc(it.q)}</td><td>${esc(it.answers.join(' → ') || '—')}</td><td>${status(it)}</td></tr>`).join('')}</table></div></div>`).join('') : '<p class="muted">Pas encore de séance.</p>'}
      <h3 style="font-size:1rem">Enregistrements</h3>
      ${rr.length ? rr.map(r => `<div class="clip"><span class="txt"><b>${r.kind === 'lecture' ? 'Lecture' : r.kind === 'recit' ? 'Récit' : 'Méthode'}</b> · ${esc(r.title)} · ${fmtDate(r.ts)} · ${r.dur || '?'} s<br><span class="small muted">${esc(r.q)}</span></span><button class="btn soft sm" data-play="${r.id}">Écouter</button>${r.kind === 'lecture' ? `<button class="btn sm" data-measure="${r.id}" style="--c:var(--river)">Mesurer</button>` : r.kind === 'recit' ? `<button class="btn sm" data-grade="${r.id}" style="--c:var(--river)">Noter le récit</button>` : ''}<button class="link" data-del="${r.id}">Supprimer</button></div>`).join('') : '<p class="muted small">Aucun enregistrement.</p>'}
      <p class="small muted">À revoir automatiquement : ${pr.review.length} défi${pr.review.length > 1 ? 's' : ''} de leçon, ${Object.values(pr.drillMisses).reduce((a, b) => a + b.length, 0)} calcul${Object.values(pr.drillMisses).reduce((a, b) => a + b.length, 0) > 1 ? 's' : ''} d'automatismes.</p></div>`;
    }).join('');
    pane.querySelectorAll('[data-play]').forEach(b => b.onclick = () => { const r = recs.find(x => String(x.id) === b.dataset.play); if (r) { stopSpeech(); playFile(URL.createObjectURL(r.blob)); } });
    pane.querySelectorAll('[data-del]').forEach(b => { let armed = false; b.onclick = async () => { if (!armed) { armed = true; b.textContent = 'Confirmer la suppression'; return; } await DB.delRec(Number(b.dataset.del)); screenParent('suivi'); }; });
    pane.querySelectorAll('[data-measure]').forEach(b => b.onclick = () => screenMeasure(recs.find(x => String(x.id) === b.dataset.measure)));
    pane.querySelectorAll('[data-grade]').forEach(b => b.onclick = () => screenGrade(recs.find(x => String(x.id) === b.dataset.grade)));
  }
  if (tab === 'maman') {
    const keys = new Set((await DB.clipKeys()) || []);
    pane.innerHTML = `<div class="card"><p style="margin-top:0">Maman enregistre ces phrases une fois, avec ses mots à elle. Kono les fait entendre au bon moment. Une phrase non enregistrée est remplacée par une phrase neutre de Kono, qui ne se fait jamais passer pour Maman.</p>
      ${CLIPS.map(c => `<div class="clip" data-id="${c.id}"><span class="txt">${c.who ? `<span class="pill ${c.who === 'bleu' ? 'first' : 'after'}">${esc(kidLabel(c.who))}</span> ` : ''}${esc(c.maman.replace('[prénom]', c.who ? kidLabel(c.who) : '…'))}</span>
        <span class="state" style="color:${keys.has(c.id) ? 'var(--good)' : 'var(--muted)'}">${keys.has(c.id) ? 'Enregistrée' : 'À enregistrer'}</span>
        <button class="btn sm" data-rec style="--c:var(--maman)">${keys.has(c.id) ? 'Refaire' : 'Enregistrer'}</button>
        ${keys.has(c.id) ? `<button class="btn soft sm" data-play>Écouter</button><button class="link" data-del>Effacer</button>` : ''}</div>`).join('')}</div>`;
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
    <div class="card stack"><h3>Bloquer la tablette sur l'application</h3><p class="small" style="margin:0">Android : Paramètres › Sécurité › Épinglage d'écran. Ouvrez L'école de Kono, affichez les applications récentes, touchez l'icône de l'application puis « Épingler ».</p></div>
    <div class="card stack"><h3>Remettre le suivi à zéro</h3><p class="small muted" style="margin:0">Efface les séances, les records et les mesures (pas les enregistrements de Maman).</p><div class="row"><input type="text" id="conf" placeholder="Tapez EFFACER"><button class="btn ghost" id="wipe">Effacer le suivi</button></div></div>`;
    $('#setup').onclick = screenSetup;
    $('#wipe').onclick = () => { if ($('#conf').value.trim().toUpperCase() !== 'EFFACER') return; S.progress = blank().progress; save(); screenParent('suivi'); };
  }
}
/* Mesure de fluence : le parent écoute, touche les mots mal lus, et au besoin le dernier mot lu. */
function screenMeasure(r) {
  if (!r) return;
  const words = r.passage.join(' ').split(/\s+/);
  const isWord = w => /[\p{L}\p{N}]/u.test(w);
  const err = new Set(); let last = words.length - 1, mode = 'err', secs = r.dur || 60;
  const draw = () => {
    const read = words.slice(0, last + 1).filter(isWord).length, nErr = [...err].filter(k => k <= last).length;
    const wcpm = Math.round((read - nErr) * 60 / Math.max(1, secs));
    app.innerHTML = `<div class="stack"><div class="row" style="justify-content:space-between"><button class="btn ghost" id="back" style="--c:var(--river)">Retour</button><h2>Mesurer la lecture</h2></div>
    <div class="card stack"><div class="row"><button class="btn soft" id="play" style="--c:var(--river)">Écouter l'enregistrement</button><label class="f" style="flex-direction:row;align-items:center;gap:8px">Durée (s) <input type="tel" id="secs" value="${secs}" style="width:90px"></label></div>
    <div class="seg"><button data-m="err" class="${mode === 'err' ? 'on' : ''}">Toucher les mots mal lus</button><button data-m="last" class="${mode === 'last' ? 'on' : ''}">Toucher le dernier mot lu</button></div>
    <div class="measure">${words.map((w, k) => isWord(w) ? `<button class="mw ${err.has(k) ? 'err' : ''} ${k > last ? 'out' : ''} ${k === last ? 'last' : ''}" data-w="${k}">${esc(w)}</button>` : `<span class="mw p">${esc(w)}</span>`).join(' ')}</div>
    <p style="margin:0">Mots lus : <b>${read}</b> · erreurs : <b>${nErr}</b> · <b style="font-size:1.3rem">${wcpm} mots par minute</b> <span class="small muted">(cible fin CE1 : 70)</span></p>
    <div><button class="btn" id="save" style="--c:var(--river)">Enregistrer la mesure</button></div></div></div>`;
    $('#back').onclick = () => screenParent('suivi');
    $('#play').onclick = () => { stopSpeech(); playFile(URL.createObjectURL(r.blob)); };
    $('#secs').onchange = e => { secs = Math.max(1, Number(e.target.value) || secs); draw(); };
    app.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { mode = b.dataset.m; draw(); });
    app.querySelectorAll('[data-w]').forEach(b => b.onclick = () => { const k = Number(b.dataset.w); if (mode === 'last') last = k; else if (err.has(k)) err.delete(k); else err.add(k); draw(); });
    $('#save').onclick = () => { S.progress[r.child].measures.push({ type: 'fluence', date: today(), lesson: r.lesson, recId: r.id, read, errors: nErr, secs, wcpm }); save(); screenParent('suivi'); };
  };
  draw();
}
function screenGrade(r) {
  if (!r) return;
  const chk = new Set();
  const draw = () => {
    app.innerHTML = `<div class="stack"><div class="row" style="justify-content:space-between"><button class="btn ghost" id="back" style="--c:var(--river)">Retour</button><h2>Noter le récit</h2></div>
    <div class="card stack"><div><button class="btn soft" id="play" style="--c:var(--river)">Écouter le récit</button></div>
    <p class="small muted" style="margin:0">Cochez ce que l'enfant a dit, même avec ses mots à lui.</p>
    ${RECIT.map((t, k) => `<label class="row" style="gap:10px"><input type="checkbox" data-k="${k}" ${chk.has(k) ? 'checked' : ''} style="width:24px;height:24px"> ${esc(t)}</label>`).join('')}
    <p style="margin:0">Score : <b>${chk.size} sur ${RECIT.length}</b></p><div><button class="btn" id="save" style="--c:var(--river)">Enregistrer la note</button></div></div></div>`;
    $('#back').onclick = () => screenParent('suivi');
    $('#play').onclick = () => { stopSpeech(); playFile(URL.createObjectURL(r.blob)); };
    app.querySelectorAll('[data-k]').forEach(b => b.onchange = () => { const k = Number(b.dataset.k); if (b.checked) chk.add(k); else chk.delete(k); draw(); });
    $('#save').onclick = () => { S.progress[r.child].measures.push({ type: 'recit', date: today(), lesson: r.lesson, recId: r.id, score: chk.size, items: [...chk] }); save(); screenParent('suivi'); };
  };
  draw();
}
function report() {
  const L = [`Rapport L'école de Kono · ${today()} · v${VERSION}`];
  ['bleu', 'orange'].forEach(c => {
    const pr = S.progress[c];
    L.push('', `== ${c === 'bleu' ? 'BLEU (7 ans)' : 'ORANGE (5 ans ½)'} : ${kidLabel(c)} ==`);
    if (!pr.runs.length) L.push('Aucune séance.');
    pr.runs.forEach(r => {
      L.push(`- ${r.date} · ${r.title} · ${Math.max(1, Math.round(((r.end || r.start) - r.start) / 60000))} min · ${r.done ? 'terminée' : 'arrêtée avant la fin'} · enregistrements : ${r.recs || 0}${r.drill ? ` · automatismes ${r.drill.score}/${r.drill.count} en ${r.drill.secs} s${r.drill.record ? ' (record)' : ''}` : ''}`);
      r.items.forEach(it => L.push(`    ${it.ok ? (it.first ? 'OK 1er essai' : 'OK après erreur') : (it.answers.length ? 'MONTRÉE' : 'non fait')} | ${it.q} | réponses : ${it.answers.join(' → ') || '—'} | attendu : ${it.answer}`));
    });
    pr.measures.forEach(m => L.push(`Mesure ${m.date} : ${m.type === 'fluence' ? `lecture ${m.wcpm} mots/min (${m.read} lus, ${m.errors} erreurs, ${m.secs} s)` : `récit ${m.score}/${RECIT.length}`}`));
    const sk = Object.entries(pr.skills).map(([k, s]) => `${k} ${s.n - s.ko}/${s.n}`).join(', ');
    if (sk) L.push(`Automatismes par type : ${sk}`);
    L.push(`File de révision : ${pr.review.map(r => r.id).join(', ') || 'vide'}`);
  });
  return L.join('\n');
}

/* ============================ démarrage ============================ */
async function boot() {
  try { await loadAll(); } catch (e) { app.innerHTML = `<div class="card"><h2>Leçons introuvables</h2><p>Connectez la tablette à internet une fois pour télécharger les leçons, puis rouvrez l'application.</p></div>`; return; }
  if (!S.setup) screenSetup(); else screenHome();
}
if ('serviceWorker' in navigator && location.protocol === 'https:') { try { navigator.serviceWorker.register('sw.js').catch(() => {}); } catch (e) {} }
document.addEventListener('visibilitychange', () => { if (document.hidden) stopSpeech(); });
window.__kono = { keyOf, sentences, S, P: () => P, AUDIO: () => AUDIO };
boot();
})();
