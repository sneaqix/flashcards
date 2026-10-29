# flashcards

Appli web de flashcards pour réviser la prépa TSI, sur PC et téléphone : https://sneaqix.github.io/flashcards/

- Révision du jour planifiée par l'algorithme FSRS (comme Anki) : 4 boutons (À revoir, Difficile, Correct, Facile),
  étapes d'apprentissage dans la journée, intervalles qui grandissent jusqu'à l'intervalle maximum.
- Cartes inversées, réponses à taper et choix multiples, au choix pour chaque carte.
- Bachotage (cartes, QCM ou associations), sans toucher à la progression.
- Éditeur de cartes intégré (formules LaTeX, images), utilisable pendant la révision, avec recherche globale et filtres.
- Statistiques détaillées et réglages par matière.
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
