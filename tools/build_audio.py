# -*- coding: utf-8 -*-
"""Chaîne audio de L'école de Kono.

Ce que fait ce script, dans l'ordre :
  1. Relève chaque phrase que l'application peut dire (leçons + phrases.json), découpée exactement comme le moteur.
  2. Attribue un rôle : « conteur » (textes de lecture, histoires) ou « kono » (tout le reste).
  3. Tient un registre stable des numéros de phrases (voix/registre.json, on ajoute, on ne renumérote jamais).
  4. Écrit le script d'enregistrement : print/voix_a_enregistrer.md.
  5. Importe les enregistrements humains déposés dans voix/conteur/ et voix/kono/
     (fichier nommé par son numéro, ex. 012.m4a, ou par sa clé, ex. 3fa2c91b.m4a) -> app/audio/rec/<clé>.mp3
  6. Si la variable GOOGLE_TTS_API_KEY existe : génère les phrases manquantes avec une voix de synthèse
     haut de gamme (voix : KONO_VOICE, par défaut fr-FR-Neural2-A) -> app/audio/gen/<clé>.mp3
  7. Écrit app/audio/manifest.json (enregistrement humain prioritaire sur la synthèse).

Usage : python3 tools/build_audio.py
"""
import base64, json, os, pathlib, re, subprocess, sys, urllib.request, datetime

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP = ROOT / "app"
VOIX = ROOT / "voix"
AUDIO = APP / "audio"

# ---------- même découpage et même clé que app.js ----------
def norm(t): return str(t or "").replace("«", "").replace("»", "").replace("★", " étoile ")
def sentences(t): return [p.strip() for p in re.findall(r"[^.!?…]+[.!?…]*", norm(t)) if p.strip()]
def key_of(t):
    s = re.sub(r"\s+", " ", norm(t)).strip()
    h = 0x811c9dc5
    for x in s.encode("utf-8"):
        h ^= x; h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"

def variants(t):
    """{e} : les deux accords ; {prenom} : phrase exclue (dite par la tablette, car le prénom change)."""
    out = []
    for v in ([t.replace("{e}", ""), t.replace("{e}", "e")] if "{e}" in t else [t]):
        out.extend(s for s in sentences(v) if "{prenom}" not in s)
    return out

def collect():
    ph = json.loads((APP / "phrases.json").read_text())
    idx = json.loads((APP / "lessons" / "index.json").read_text())
    items = []  # (rôle, phrase, origine)
    def add(role, text, origin):
        if not text: return
        if role == "conteur":   # le conteur lit chaque phrase du texte d'un seul souffle : une unité = un élément du texte
            items.append((role, re.sub(r"\s+", " ", norm(text)).strip(), origin)); return
        for s in variants(text): items.append((role, re.sub(r"\s+", " ", s).strip(), origin))
    for k, v in ph.items():
        if k in ("_note", "clips"): continue
        for t in (v if isinstance(v, list) else [v]): add("kono", t, "moteur")
    for c in ph.get("clips", []): add("kono", c.get("kono"), "remplacement de Maman")
    def step(st, origin):
        t = st.get("type")
        spoken = st.get("say") or st.get("text")
        if t in ("say", "part", "number", "choice", "paper", "record", "drill"): add("kono", spoken, origin)
        if t in ("number", "choice"):
            for e in (st.get("errors") or {}).values(): add("kono", e, origin)
            for h in st.get("hints") or []: add("kono", h, origin)
            add("kono", st.get("sol"), origin)
        if t == "demo":
            for ln in st["lines"]: add("kono", ln.get("say") or ln.get("text"), origin)
        if t == "review":
            for f in st.get("fallback", []): step(f, origin)
        if t == "reading":
            for s in st["passage"]: add("conteur", s, origin)
        if t == "story":
            for s in st["sentences"]: add("conteur", s, origin)
            for v in st.get("vocab", []): add("kono", v["say"], origin)
            for q in st.get("questions", []): step(q, origin)
            add("kono", st.get("retell"), origin)
    for l in idx["lessons"]:
        L = json.loads((APP / "lessons" / f'{l["id"]}.json').read_text())
        for st in L["steps"]: step(st, L["title"])
        for lv in L.get("paper", {}).get("levels", []):
            for it in lv["items"]:
                for e in (it.get("errors") or {}).values(): add("kono", e, L["title"] + " (fiche)")
    seen, uniq = set(), []
    for role, s, o in items:
        k = key_of(s)
        if k in seen: continue
        seen.add(k); uniq.append({"key": k, "role": role, "text": s, "origin": o})
    return uniq

def registry(entries):
    path = VOIX / "registre.json"; VOIX.mkdir(exist_ok=True)
    reg = json.loads(path.read_text()) if path.exists() else {}
    n = max([int(v) for v in reg.values()] or [0])
    for e in entries:
        if e["key"] not in reg: n += 1; reg[e["key"]] = n
        e["n"] = reg[e["key"]]
    path.write_text(json.dumps(reg, indent=1, sort_keys=True))
    return reg

def import_recordings(entries):
    by_n = {e["n"]: e["key"] for e in entries}; keys = {e["key"] for e in entries}
    (AUDIO / "rec").mkdir(parents=True, exist_ok=True); done = 0
    for role in ("conteur", "kono"):
        d = VOIX / role
        if not d.exists(): continue
        for f in sorted(d.iterdir()):
            if not f.is_file(): continue
            stem = f.stem.lower()
            key = stem if stem in keys else by_n.get(int(stem)) if stem.isdigit() else None
            if not key: print("  ignoré (nom non reconnu) :", f.name); continue
            out = AUDIO / "rec" / f"{key}.mp3"
            if out.exists() and out.stat().st_mtime >= f.stat().st_mtime: continue
            filt = "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,loudnorm=I=-16:TP=-1.5"
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(f), "-ac", "1", "-ar", "44100", "-af", filt, "-b:a", "64k", str(out)], check=True)
            done += 1
    return done

def generate(entries):
    api = os.environ.get("GOOGLE_TTS_API_KEY")
    if not api: return 0, "pas de clé GOOGLE_TTS_API_KEY : génération sautée"
    voice = os.environ.get("KONO_VOICE", "fr-FR-Neural2-A")
    (AUDIO / "gen").mkdir(parents=True, exist_ok=True); n = 0
    for e in entries:
        out = AUDIO / "gen" / f'{e["key"]}.mp3'
        if out.exists() or (AUDIO / "rec" / f'{e["key"]}.mp3').exists(): continue
        body = json.dumps({"input": {"text": e["text"]}, "voice": {"languageCode": "fr-FR", "name": voice},
                           "audioConfig": {"audioEncoding": "MP3", "speakingRate": 0.93 if e["role"] == "kono" else 0.88}}).encode()
        req = urllib.request.Request(f"https://texttospeech.googleapis.com/v1/text:synthesize?key={api}", data=body, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            out.write_bytes(base64.b64decode(json.loads(r.read())["audioContent"]))
        n += 1
    return n, f"voix {voice}"

def main():
    entries = collect(); registry(entries)
    nrec = import_recordings(entries)
    ngen, note = generate(entries)
    files = {}
    for e in entries:
        if (AUDIO / "rec" / f'{e["key"]}.mp3').exists(): files[e["key"]] = f'rec/{e["key"]}.mp3'
        elif (AUDIO / "gen" / f'{e["key"]}.mp3').exists(): files[e["key"]] = f'gen/{e["key"]}.mp3'
    (AUDIO / "manifest.json").write_text(json.dumps({"version": datetime.datetime.now().isoformat(timespec="seconds"), "files": files}, indent=1, sort_keys=True))
    # script d'enregistrement
    lines = ["# Phrases à enregistrer · L'école de Kono", "",
             "Enregistrer une phrase par fichier, nommé par son numéro (ex. `012.m4a`), dans `voix/conteur/` ou `voix/kono/`.",
             "Pièce calme ; téléphone à 20 cm ; lire lentement, avec l'intonation d'un conte pour le rôle conteur.", ""]
    for role, titre in (("conteur", "Rôle conteur (voix humaine expressive)"), ("kono", "Rôle Kono (voix humaine, ou synthèse si une clé est fournie)")):
        rows = sorted([e for e in entries if e["role"] == role], key=lambda e: e["n"])
        lines += [f"## {titre}", "", "| N° | Texte | Séance | Statut |", "| --- | --- | --- | --- |"]
        for e in rows:
            st = "enregistrée" if files.get(e["key"], "").startswith("rec/") else "générée" if e["key"] in files else "à faire"
            lines.append(f'| {e["n"]:03d} | {e["text"]} | {e["origin"]} | {st} |')
        lines.append("")
    (ROOT / "print").mkdir(exist_ok=True)
    (ROOT / "print" / "voix_a_enregistrer.md").write_text("\n".join(lines), encoding="utf-8")
    nk = sum(1 for e in entries if e["role"] == "kono"); nc = len(entries) - nk
    print(f"{len(entries)} phrases ({nk} Kono, {nc} conteur) · {len(files)} ont un audio · importés : {nrec} · générés : {ngen} ({note})")

if __name__ == "__main__":
    main()
