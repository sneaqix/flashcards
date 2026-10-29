# flashcards

Appli web de flashcards pour réviser la prépa TSI, sur PC et téléphone : https://sneaqix.github.io/flashcards/

- Révision du jour par boîtes de Leitner, avec des cartes mélangées entre les chapitres actifs.
- Bachotage : chapitres au choix, ordre aléatoire, sans toucher à la progression.
- Éditeur de cartes intégré (formules LaTeX, images), qui enregistre directement dans ce dépôt.
- Statistiques et réglages (nouvelles cartes et révisions par jour, chapitres actifs).
- Progression synchronisée dans un dépôt privé GitHub.

## Organisation

```
index.html            page de l'appli
css/app.css           styles
js/app.js             interface
js/store.js           progression, fusion entre appareils, logique Leitner
js/github.js          accès à l'API GitHub
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

`q` est la question, `r` la réponse, `img_q` et `img_r` des images facultatives. Les formules s'écrivent entre `$...$` (dans le texte) ou `$$...$$` (centrées).

## Synchronisation

1. Créer un dépôt **privé** vide, par exemple `flashcards-data`, avec un README.
2. Créer un jeton *fine-grained* (GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens) limité aux dépôts `flashcards` et `flashcards-data`, avec la permission **Contents : Read and write**.
3. Dans l'appli, onglet Réglages : coller le jeton et les deux noms de dépôts, puis « Enregistrer et synchroniser ». À refaire une fois sur chaque appareil.

La progression est stockée dans `progress.json` du dépôt privé. Le jeton reste dans le navigateur de l'appareil.
