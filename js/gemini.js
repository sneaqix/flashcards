// Génération de cartes à partir d'un cours en PDF avec l'API Gemini de Google.
// La clé API reste sur l'appareil et n'est envoyée qu'à generativelanguage.googleapis.com.

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';
export const DEFAULT_MODEL = 'gemini-3.8-flash';
export const MODELS = [
  ['gemini-3.8-flash', 'Gemini 3.8 Flash (recommandé)'],
  ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite (plus rapide, moins précis)'],
];

export class GeminiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

const TYPE_LABELS = {
  classique: 'des cartes classiques question / réponse',
  qcm: 'des QCM avec 3 mauvaises réponses plausibles',
  trou: 'des textes à trous',
  saisie: 'des cartes à réponse à taper (réponse de 1 à 4 mots seulement)',
};
const FOCUS_LABELS = {
  definitions: 'les définitions et les énoncés de théorèmes, avec toutes leurs hypothèses',
  formules: 'les formules à connaître, avec les unités et les conditions de validité',
  methodes: 'les méthodes et raisonnements types (« comment montrer que… », étapes clés)',
  pieges: 'les pièges et erreurs classiques (signes, cas particuliers, confusions fréquentes)',
};

function buildPrompt({ count, types, focus, matiere, consignes }) {
  const n = count ? 'Génère exactement ' + count + ' cartes.' : 'Génère une carte par notion importante du cours (au maximum 60 cartes).';
  return [
    'Tu es un professeur de classe préparatoire TSI. À partir du cours en PDF joint (' + matiere + '), crée des flashcards pour qu\'un élève révise.',
    n,
    'Types de cartes autorisés : ' + types.map((t) => TYPE_LABELS[t]).join(' ; ') + '. Varie les types et choisis pour chaque notion le type le plus adapté.',
    'Concentre-toi sur : ' + focus.map((f) => FOCUS_LABELS[f]).join(' ; ') + '.',
    '',
    'Règles :',
    '- Reste strictement fidèle au cours : n\'invente ni résultat, ni notation, ni valeur numérique absente du cours.',
    '- Une seule notion par carte. Question précise et sans ambiguïté, réponse courte et complète.',
    '- Écris les formules en LaTeX : $...$ dans le texte, $$...$$ pour une formule centrée. Pas de HTML, pas de Markdown (ni gras, ni listes à puces).',
    '- Dans le JSON, chaque antislash du LaTeX doit être doublé (\\\\frac, \\\\omega…).',
    '- QCM : "attendu" contient la bonne réponse sous forme courte, "mauvaises_reponses" contient exactement 3 réponses fausses mais plausibles, de même forme que la bonne (pièges classiques : signe, facteur, inversion, hypothèse oubliée). "reponse" contient la bonne réponse avec une courte justification.',
    '- Texte à trous : "question" est une phrase ou un énoncé du cours où chaque élément à retrouver est écrit {{réponse::indice}}. L\'indice est facultatif et court. Un à trois trous par carte, jamais une formule entière dans un trou. "reponse" peut contenir une explication courte ou rester vide.',
    '- Réponse à taper : "attendu" contient la réponse exacte (1 à 4 mots). Plusieurs formulations acceptées séparées par " / ".',
    '- Carte classique : "attendu" contient une version très courte de la réponse (quelques mots ou une formule), utilisée pour les jeux d\'association.',
    '- Les cartes sont dans la langue du cours. Pour un cours d\'anglais, les questions peuvent être en français et les réponses en anglais, et les indices des textes à trous en français.',
    '- "titre" est un titre court pour le chapitre (par exemple « Développements limités »).',
    consignes ? '\nConsignes supplémentaires de l\'élève : ' + consignes : '',
  ].join('\n');
}

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    titre: { type: 'STRING' },
    cartes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          type: { type: 'STRING', enum: ['classique', 'qcm', 'trou', 'saisie'] },
          question: { type: 'STRING' },
          reponse: { type: 'STRING' },
          attendu: { type: 'STRING' },
          mauvaises_reponses: { type: 'ARRAY', items: { type: 'STRING' } },
        },
        required: ['type', 'question', 'reponse'],
      },
    },
  },
  required: ['titre', 'cartes'],
};

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error('Impossible de lire le fichier.'));
    r.readAsDataURL(file);
  });
}

// Renvoie { titre, cartes: [{ type, question, reponse, attendu, mauvaises_reponses }] }.
export async function generateCards({ key, model, pdfBase64, count, types, focus, matiere, consignes, signal }) {
  let res;
  try {
    res = await fetch(ENDPOINT + encodeURIComponent(model || DEFAULT_MODEL) + ':generateContent', {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
            { text: buildPrompt({ count, types, focus, matiere, consignes }) },
          ],
        }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.4 },
      }),
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new GeminiError('Génération annulée.');
    throw new GeminiError('Impossible de joindre Gemini. Vérifie ta connexion.');
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* réponse vide */ }
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || '';
    if (res.status === 400 && /API key/i.test(msg)) throw new GeminiError('Clé API Gemini refusée. Vérifie-la dans les réglages.', 400);
    if (res.status === 403) throw new GeminiError('Clé API Gemini sans accès à ce modèle (' + msg + ').', 403);
    if (res.status === 404) throw new GeminiError('Modèle introuvable : choisis-en un autre dans les réglages.', 404);
    if (res.status === 429) throw new GeminiError('Limite gratuite de Gemini atteinte. Réessaie dans quelques minutes, ou demain.', 429);
    if (res.status === 413) throw new GeminiError('PDF trop volumineux pour Gemini. Découpe-le en plusieurs parties.', 413);
    throw new GeminiError('Erreur Gemini ' + res.status + (msg ? ' : ' + msg : '') + '.', res.status);
  }
  const cand = data && data.candidates && data.candidates[0];
  const text = cand && cand.content && (cand.content.parts || []).map((p) => p.text || '').join('');
  if (!text) {
    const why = cand && cand.finishReason ? ' (' + cand.finishReason + ')' : '';
    throw new GeminiError('Gemini n\'a renvoyé aucune carte' + why + '. Réessaie, éventuellement avec moins de cartes.');
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) {
    throw new GeminiError('Réponse de Gemini illisible (probablement coupée). Réessaie avec moins de cartes.');
  }
  if (!parsed || !Array.isArray(parsed.cartes)) throw new GeminiError('Réponse de Gemini inattendue.');
  return parsed;
}

// Répare les commandes LaTeX abîmées quand un antislash n'a pas été doublé dans le JSON :
// « \frac » devient un saut de page + « rac », « \theta » une tabulation + « heta », etc.
export function repairLatex(text) {
  return String(text || '')
    .replace(/\f/g, '\\f')
    .replace(/\u0008/g, '\\b')
    .replace(/\t(?=[a-zA-Z])/g, '\\t')
    .replace(/\r(?=[a-zA-Z])/g, '\\r')
    .replace(/\n(?=(?:eq|abla|ot|ewline|mid|subseteq|exists|parallel|eg|olimits|ormalsize)(?![a-zA-Z]))/g, '\\n');
}

// Convertit une carte générée au format des fichiers de chapitre.
export function toDeckCard(g, id) {
  const q = repairLatex(g.question).trim();
  const r = repairLatex(g.reponse).trim();
  const attendu = repairLatex(g.attendu).trim();
  const card = { id, q, r };
  if (g.type === 'qcm') {
    const wrong = (g.mauvaises_reponses || []).map((x) => repairLatex(x).trim()).filter((x) => x && x !== attendu);
    card.mode = 'qcm';
    if (attendu) card.attendu = attendu;
    if (wrong.length) card.choix = wrong.slice(0, 5);
  } else if (g.type === 'trou' && /\{\{.+?\}\}/.test(q)) {
    card.mode = 'trou';
  } else if (g.type === 'saisie' && attendu) {
    card.mode = 'saisie';
    card.attendu = attendu;
  } else if (attendu) {
    card.attendu = attendu;
  }
  if (!card.r && card.mode !== 'trou') card.r = attendu || '';
  return card;
}
