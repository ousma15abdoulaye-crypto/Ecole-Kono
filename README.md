# L'école de Kono

Séances guidées par une voix, pour les parcours Bleu (7 ans, CE1) et Orange (5 ans ½, grande section).
Kono, un oiseau du fleuve, emmène l'enfant en voyage sur le Niger, de Bamako à Gao : chaque séance fait avancer la pinasse sur la carte.

Chaque séance a quatre temps, toujours dans le même ordre :

1. **Automatismes** : calcul express chronométré contre soi-même. Les types de calcul où l'enfant se trompe reviennent plus souvent ; les calculs ratés reviennent au début de la séance suivante.
2. **Leçon explicite** : Kono montre, on fait ensemble, l'enfant fait sa fiche papier et tape ses réponses. Chaque erreur typique reçoit son explication.
3. **Lecture** (Bleu) : le texte est lu d'abord par une voix, phrase surlignée ; puis l'enfant lit et s'enregistre. Le parent mesure les mots lus par minute.
   **Histoire** (Orange), à la manière de Narramus : écoute sans images, mots nouveaux mimés, questions sur les personnages, puis l'enfant raconte avec les images et s'enregistre.
4. **Méthode** : l'enfant explique comment il a fait.

Maman enregistre elle-même quelques phrases que Kono fait entendre au bon moment. Aucune voix n'imite une personne réelle.

**Principe d'architecture : une seule source, deux supports.** Chaque leçon est un fichier `app/lessons/*.json`.
L'application tablette le lit ; `tools/build_print.py` en tire les fiches à imprimer et la carte Maman.
Le papier et la tablette ne peuvent donc pas se contredire.

## Contenu du dossier

| Chemin | Rôle |
|---|---|
| `app/` | L'application à mettre en ligne (site statique, fonctionne hors ligne une fois installée) |
| `app/lessons/index.json` | Liste des leçons publiées |
| `app/lessons/<id>.json` | Une séance : voix, étapes, exercices, erreurs typiques, fiche papier |
| `app/phrases.json` | Les phrases que le moteur dit lui-même, et les phrases de Maman |
| `app/audio/` | Les voix enregistrées (`rec/`) ou générées (`gen/`), et leur manifeste |
| `tools/build_audio.py` | Liste les phrases à enregistrer, importe les enregistrements, génère la voix de Kono, écrit le manifeste |
| `voix/` | Dépôt des enregistrements humains (`conteur/`, `kono/`) et registre des numéros de phrases |
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
| `part` | Annonce un des quatre temps (`n`, `title`, `text`). L'en-tête de la séance montre le temps en cours. |
| `drill` | Automatismes : `count` questions en `seconds` secondes, `kinds` pondérés (`complement10`, `complement-next-ten`, `through10`, `double`, `table`, `tf-complement`, `count-tf`, `decomp`), `input` = `keypad` ou `choice`. Record gardé par enfant. |
| `reading` | Lecture répétée : `passage` = liste de phrases. Écoute surlignée, puis enregistrement de l'enfant. |
| `story` | Histoire : `sentences`, `vocab` (mot + explication à mimer), `questions` (étapes `choice`), `scenes` (images), `retell` (consigne pour raconter). |
| `end` | Bilan de la séance et phrase de fin de Maman. |

Dessins disponibles dans `show` : `title`, `expr`, `text`, `numberline` (from, to, marks, jumps), `split` (whole, parts), `tenframe` (filled, highlightEmpty), `fingers` (up).
Jetons de texte : `{prenom}` (prénom de l'enfant), `{e}` (accord au féminin).

## 5. Les voix

`python3 tools/build_audio.py` écrit `print/voix_a_enregistrer.md` : chaque phrase avec son numéro, son rôle (conteur ou Kono) et son statut.

- **Voix humaines** : enregistrer une phrase par fichier, nommé par son numéro (`012.m4a`), dans `voix/conteur/` ou `voix/kono/`, puis relancer le script. Il égalise le volume, coupe les silences et convertit en mp3.
- **Voix de synthèse haut de gamme pour Kono** : définir `GOOGLE_TTS_API_KEY` (et, si on veut, `KONO_VOICE`, par défaut `fr-FR-Neural2-A`), puis relancer le script. Seules les phrases sans audio sont générées. Cette partie n'a pas pu être testée sans clé.
- Un enregistrement humain passe toujours avant une voix générée ; sans l'un ni l'autre, c'est la voix de la tablette.
- Les numéros de phrases ne changent jamais (`voix/registre.json`) : on peut enregistrer en plusieurs fois.
- Les phrases qui contiennent le prénom de l'enfant restent dites par la tablette.

## Limites connues (version 0.2)

- Tant qu'aucune voix n'est enregistrée ou générée, c'est la synthèse d'Android qui parle ; sa qualité dépend de la tablette.
- Les images des histoires sont des dessins simples, en attendant un illustrateur.
- Pas de reconnaissance vocale : la lecture à voix haute est enregistrée, un adulte l'écoute.
- Le suivi est propre à chaque tablette. Si la tablette est réinitialisée, le suivi et les enregistrements sont perdus.
- Tester localement : `python3 -m http.server 8765 --directory app`, puis `http://localhost:8765/#test` (le mode `#test` accélère la voix pour les tests).
