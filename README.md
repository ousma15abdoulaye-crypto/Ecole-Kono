# L'école de Kono

Leçons guidées par une voix, pour les parcours Bleu (7 ans, CE1) et Orange (5 ans ½, grande section).
Kono, un oiseau du fleuve, explique, montre un exemple pas à pas, fait pratiquer, puis envoie l'enfant sur sa fiche papier et vérifie ses réponses.
Maman enregistre elle-même quelques phrases que Kono fait entendre au bon moment.

**Principe d'architecture : une seule source, deux supports.** Chaque leçon est un fichier `app/lessons/*.json`.
L'application tablette le lit ; `tools/build_print.py` en tire les fiches à imprimer et la carte Maman.
Le papier et la tablette ne peuvent donc pas se contredire.

## Contenu du dossier

| Chemin | Rôle |
|---|---|
| `app/` | L'application à mettre en ligne (site statique, fonctionne hors ligne une fois installée) |
| `app/lessons/index.json` | Liste des leçons publiées |
| `app/lessons/<id>.json` | Une leçon : voix, étapes, exercices, erreurs typiques, fiche papier |
| `tools/build_print.py` | Génère `print/Fiches_<semaine>.pdf` depuis les leçons |
| `print/` | Fiches et cartes Maman prêtes à imprimer |

## 1. Mettre l'application en ligne (une fois, environ 10 minutes)

Le plus simple : GitHub Pages (gratuit, en https, ce qui est obligatoire pour le micro et le mode hors ligne).

1. Créer un dépôt GitHub, par exemple `ecole-kono`.
2. Y déposer le **contenu** du dossier `app/` à la racine du dépôt (index.html doit être à la racine).
3. Settings › Pages › Source : « Deploy from a branch », branche `main`, dossier `/ (root)`.
4. L'adresse sera du type `https://<compte>.github.io/ecole-kono/`.

Aucune donnée d'enfant ne part sur GitHub : les prénoms, le suivi, les enregistrements et la voix de Maman restent **sur la tablette**.
Le dépôt ne contient que les leçons. Si le dépôt est public, les leçons sont lisibles par tous, rien d'autre.

## 2. Installer sur chaque tablette Android

1. Ouvrir l'adresse dans **Chrome**, avec internet.
2. Menu ⋮ › **Installer l'application** (ou « Ajouter à l'écran d'accueil »). L'icône Kono apparaît.
3. Ouvrir l'application une première fois avec internet : les leçons sont gardées pour le hors ligne.
4. **Voix française hors ligne** : Paramètres › Gestion globale (ou Accessibilité) › Synthèse vocale › Moteur Google › Installer les données vocales › Français (France). Puis dans l'application : Espace parent › Voix de Kono › choisir une voix marquée « hors ligne » › Écouter Kono.
5. Premier lancement : prénoms, garçon ou fille (pour accorder les phrases), code parent à 4 chiffres.
6. **Voix de Maman** : Espace parent › Voix de Maman › 8 phrases à enregistrer, avec ses mots à elle.
7. **Bloquer la tablette sur l'application** : Paramètres › Sécurité › Épinglage d'écran. Ouvrir Kono › applications récentes › icône de Kono › Épingler.

## 3. Le cycle de chaque semaine

1. Du lundi au jeudi : une séance par jour. L'enfant ouvre Kono, suit la séance, fait sa fiche, tape ses réponses, enregistre son explication.
2. Le soir : un parent écoute l'explication (Espace parent › Suivi).
3. **Dimanche** : Espace parent › Rapport › Copier, sur chaque tablette. Coller le rapport dans la conversation avec Claude.
4. Claude produit les leçons de la semaine suivante (fichiers JSON) et le PDF des fiches, réglés sur les erreurs réelles.
5. Déposer les nouveaux fichiers dans `lessons/` et mettre à jour `lessons/index.json`. Les tablettes les reçoivent à la prochaine ouverture avec internet.
6. Imprimer les fiches : `python3 tools/build_print.py S1` (ou utiliser le PDF fourni).

Les défis ratés reviennent automatiquement au début des séances suivantes (file de révision).

## 4. Format d'une leçon (pour Claude Code ou Codex)

Étapes possibles, dans l'ordre de l'enseignement explicite :

| `type` | Ce que fait la tablette |
|---|---|
| `maman` | Joue la phrase enregistrée par Maman (`clip`). Sinon, Kono dit une phrase neutre. |
| `say` | Kono parle (`say` pour la voix, `text` pour la bulle) et affiche `show`. |
| `review` | Rejoue jusqu'à 2 défis ratés les jours précédents, sinon `fallback`. |
| `demo` | « Je te montre » : une suite de `lines`, chacune avec sa voix et son dessin. |
| `number` / `choice` | Question avec clavier ou choix. `errors` = explication propre à chaque mauvaise réponse typique ; `hints` = indices ; `sol` = solution expliquée ; `after` = dessin affiché une fois trouvé. |
| `paper` | Envoie l'enfant sur sa fiche, puis vérifie les réponses tapées. Les exercices viennent de la section `paper` du même fichier. |
| `record` | L'enfant s'enregistre pour expliquer sa méthode. Le parent écoute le soir. |
| `end` | Bilan de la séance et phrase de fin de Maman. |

Dessins disponibles dans `show` : `title`, `expr`, `text`, `numberline` (from, to, marks, jumps), `split` (whole, parts), `tenframe` (filled, highlightEmpty), `fingers` (up).
Jetons de texte : `{prenom}` (prénom de l'enfant), `{e}` (accord au féminin).

## Limites connues (version 0.1)

- La qualité de la voix dépend de la tablette : c'est le moteur de synthèse d'Android qui parle.
- Pas de reconnaissance vocale : la lecture à voix haute est enregistrée, un adulte l'écoute.
- Le suivi est propre à chaque tablette. Si la tablette est réinitialisée, le suivi et les enregistrements sont perdus.
- Tester localement : `python3 -m http.server 8765 --directory app`, puis `http://localhost:8765/#test` (le mode `#test` accélère la voix pour les tests).
