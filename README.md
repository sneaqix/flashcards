# flashcards

Appli web de flashcards pour réviser la prépa TSI, sur PC et téléphone : https://sneaqix.github.io/flashcards/

- Révision du jour planifiée par l'algorithme FSRS (comme Anki) : 4 boutons (À revoir, Difficile, Correct, Facile),
  étapes d'apprentissage dans la journée, intervalles qui grandissent jusqu'à l'intervalle maximum.
- Cartes inversées, réponses à taper et choix multiples, au choix pour chaque carte.
- Bachotage (cartes, QCM ou associations), sans toucher à la progression.
- Éditeur de cartes intégré (formules LaTeX, images), utilisable pendant la révision, avec recherche globale et filtres.
- Import d'un cours en PDF : Gemini génère des cartes (classiques, QCM, textes à trous, à taper) à relire avant ajout.
- Classeur : cours, TD et DS en PDF rangés par chapitre (dépôt privé), lecteur intégré avec surlignage,
  notes, dessin à main levée et création de cartes depuis un passage surligné.
- Calendrier (vue Semaine, inspiré de Rappels) : devoirs, DS, colles et tâches avec matière, chapitres, heure,
  priorité, drapeau, étapes et notes ; bachotage des chapitres d'un DS ou d'une colle.
- Carnets de français-philo (thème « Les arcanes de la création ») : citations par œuvre (page, citation,
  contexte, justification, triées par page) et résumés des chapitres, un onglet par œuvre.
- Statistiques détaillées (depuis les Réglages) et réglages par matière.
- Progression synchronisée dans un dépôt privé GitHub.

## Organisation

```
index.html            page de l'appli
css/app.css           styles
js/app.js             point d'entrée et navigation
js/scheduler.js       algorithme de planification (FSRS + étapes d'apprentissage)
js/store.js           progression, journal quotidien, fusion entre appareils, file du jour
js/review.js          accueil et session de révision
js/editor.js          onglet Cartes : recherche, filtres, éditeur
js/practice.js        bachotage et associations
js/stats.js           statistiques
js/settings.js        réglages
js/sync.js            synchronisation et chargement des cartes
js/github.js          accès à l'API GitHub
js/gemini.js          génération de cartes depuis un PDF (API Gemini)
js/importer.js        écran d'import et de relecture
js/classeur.js        onglet Classeur : liste, ajout, modification des documents
js/viewer.js          lecteur PDF (PDF.js) et annotations
js/carnets.js         carnets de citations et de résumés (carnets/*.json du dépôt privé)
js/agenda.js          onglet Calendrier (stocké dans agenda.json du dépôt privé)
tools/bump_version.py numéro de version anti-cache, à lancer avant chaque publication
decks/index.json      liste des matières et de leurs chapitres
decks/<matière>/*.json  un fichier par chapitre
images/               images ajoutées aux cartes
```

## Format d'un chapitre

```json
{
  "id": "maths-dl",
  "nom": "Développements limités",
  "cartes": [
    { "id": "exp", "q": "DL de $e^x$ en $0$", "r": "$$e^x = \\sum_{k=0}^{n} \\frac{x^k}{k!} + o(x^n)$$", "img_r": "images/exemple.jpg" }
  ]
}
```

`q` est la question, `r` la réponse, `img_q` et `img_r` des images facultatives.
Champs facultatifs : `inverse: true` (crée aussi la carte réponse → question), `mode: "saisie"` ou `"qcm"`,
`attendu` (réponse courte attendue, par défaut la première ligne de `r`, alternatives séparées par `/`),
`choix` (liste de mauvaises réponses pour le QCM, sinon tirées des autres cartes du chapitre). Les formules s'écrivent entre `$...$` (dans le texte) ou `$$...$$` (centrées).

## Synchronisation

1. Créer un dépôt **privé** vide, par exemple `flashcards-data`, avec un README.
2. Créer un jeton *fine-grained* (GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens) limité aux dépôts `flashcards` et `flashcards-data`, avec la permission **Contents : Read and write**.
3. Dans l'appli, onglet Réglages : coller le jeton et les deux noms de dépôts, puis « Enregistrer et synchroniser ». À refaire une fois sur chaque appareil.

La progression est stockée dans `progress.json` du dépôt privé. Le jeton reste dans le navigateur de l'appareil.

## Import de cours (Gemini)

1. Créer une clé API gratuite sur https://aistudio.google.com/apikey.
2. Dans l'appli, onglet Réglages, section « Import de cours » : coller la clé (une fois par appareil).
3. Onglet Cartes, « Importer un cours (PDF) » : choisir le PDF, la destination, le nombre et les types de cartes, puis relire.

La clé reste dans le navigateur de l'appareil. Avec l'offre gratuite, Google peut utiliser les documents envoyés pour améliorer ses modèles.

## Classeur

Les PDF sont stockés dans le dépôt privé de sauvegarde :

```
classeur/index.json          liste des documents (nom, type, chapitre…)
classeur/files/<id>.pdf      les PDF
classeur/notes/<id>.json     surlignages, notes et dessins de chaque document
```

Chaque cours importé pour générer des cartes y est rangé automatiquement, dans le chapitre de ses cartes.
