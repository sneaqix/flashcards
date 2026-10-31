// Notes de Mon Bureau Numérique : un navigateur (Playwright) se connecte avec EduConnect
// et lit la page « Évaluations », pour chaque période.
// Lancé par le workflow notes.yml du dépôt privé : node tools/notes.mjs <dossier du dépôt privé>
// Identifiants : secrets GitHub MBN_USER et MBN_PASS (jamais écrits dans le dépôt).
// Écrit edt/notes.json et edt/notes-history.json ; en cas d'échec, des captures dans edt/notes-debug/.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const dataDir = path.resolve(process.argv[2] || '.');
const outPath = path.join(dataDir, 'edt/notes.json');
const histPath = path.join(dataDir, 'edt/notes-history.json');
const debugDir = path.join(dataDir, 'edt/notes-debug');
const appDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const require = createRequire(path.join(process.env.PW_MODULES || process.cwd(), 'noop.js'));
const SITE = process.env.MBN_SITE || 'https://lyc-pascal-colmar.monbureaunumerique.fr';
const NOTES_URL = SITE + '/sg.do?PROC=CONSULTER_RELEVE&ACTION=AFFICHER_RELEVE_NOTES_ELEVE';

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const write = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1) + '\n'); };
const previous = readJson(outPath, {});
const user = process.env.MBN_USER, pass = process.env.MBN_PASS;

function fail(msg) {
  console.log('Erreur :', msg);
  write(outPath, { ...(previous.source === 'web' ? previous : { periods: [] }), source: 'web', error: msg, errorAt: Date.now() });
  process.exit(0);
}
if (!user || !pass) fail('Identifiants manquants : ajoute les secrets MBN_USER et MBN_PASS dans le dépôt privé.');

// Matière de l'appli correspondant à un intitulé de l'ENT (mêmes règles que l'emploi du temps).
const plain = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const RULES = [[/SPORT|\bEPS\b/, null], [/MATH/, 'maths'], [/CHIM/, 'chimie'], [/PHYS/, 'physique'], [/INDUS|INGENIEUR|^S\.?I\.?$/, 'si'], [/ANGL/, 'anglais'], [/FRANC|PHILO/, 'francais']];
function matiereOf(label) {
  const index = readJson(path.join(appDir, 'decks/index.json'), { matieres: [] });
  const t = plain(label);
  const own = index.matieres.find((m) => plain(m.nom) === t || plain(m.id) === t);
  if (own) return own.id;
  const r = RULES.find(([re, id]) => re.test(t) && (id === null || index.matieres.some((m) => m.id === id)));
  return r ? r[1] : '';
}
const num = (s) => { const m = String(s || '').replace(',', '.').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };

let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { fail('Playwright introuvable.'); }

const browser = await chromium.launch();
const page = await (await browser.newContext({ locale: 'fr-FR', timezoneId: 'Europe/Paris', viewport: { width: 1280, height: 900 } })).newPage();
let shot = 0;
async function snap(label) {
  try {
    fs.mkdirSync(debugDir, { recursive: true });
    await page.screenshot({ path: path.join(debugDir, String(++shot).padStart(2, '0') + '-' + label + '.png') });
  } catch (e) { /* rien */ }
}
const host = () => { try { return new URL(page.url()).host; } catch (e) { return ''; } };
async function clickText(re) {
  for (const sel of ['button', 'a', 'label', 'input[type=submit]', '[role=button]', 'div[onclick]', 'span']) {
    const loc = page.locator(sel).filter({ hasText: re });
    const n = await loc.count();
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      if (await el.isVisible().catch(() => false)) { await el.click().catch(() => {}); return true; }
    }
  }
  return false;
}

// ---------- Connexion : profil « Élève ou parent », puis EduConnect ----------
async function login() {
  await page.goto(NOTES_URL, { waitUntil: 'domcontentloaded' });
  for (let step = 0; step < 14; step++) {
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const h = host();
    if (h === new URL(SITE).host && !/login|connexion|authentification/i.test(page.url())) {
      if (await page.locator('text=/Évaluations|Relevé|Moy\\./').count()) return true;
    }
    if (/educonnect/i.test(h)) {
      // Choix du profil « Élève » puis formulaire identifiant / mot de passe.
      const pwd = page.locator('input[type=password]');
      if (!(await pwd.count()) || !(await pwd.first().isVisible().catch(() => false))) {
        if (!(await clickText(/^\s*Élève\s*$/i))) await clickText(/Élève/i);
        await page.waitForTimeout(800);
        continue;
      }
      const id = page.locator('#username, input[name=j_username], input[name=username], input[autocomplete=username], input[type=text]').first();
      await id.fill(user);
      await pwd.first().fill(pass);
      await snap('educonnect');
      const ok = page.locator('#bouton_valider, button[type=submit], input[type=submit]').first();
      if (await ok.count()) await ok.click(); else await pwd.first().press('Enter');
      await page.waitForTimeout(2500);
      if (/educonnect/i.test(host()) && await page.locator('text=/incorrect|invalide|erron/i').count()) {
        await snap('educonnect-refus');
        throw new Error('EduConnect refuse l\'identifiant ou le mot de passe.');
      }
      continue;
    }
    // Page de choix du profil de Mon Bureau Numérique.
    if (await clickText(/Élève ou parent/i)) {
      await page.waitForTimeout(600);
      if (!(await clickText(/EduConnect/i))) await clickText(/Valider|Continuer|Se connecter|Connexion/i);
      await page.waitForTimeout(1500);
      continue;
    }
    if (await clickText(/EduConnect/i)) { await page.waitForTimeout(1500); continue; }
    if (await clickText(/Se connecter|Connexion/i)) { await page.waitForTimeout(1500); continue; }
    await snap('etape-' + step);
    await page.waitForTimeout(1500);
  }
  return false;
}

// ---------- Lecture du tableau d'une période ----------
async function readTable() {
  return page.evaluate(() => {
    const txt = (el) => (el ? el.innerText.replace(/ /g, ' ').trim() : '');
    const rows = [...document.querySelectorAll('tr')].filter((tr) => tr.querySelectorAll('td').length >= 4);
    const out = { subjects: [], general: null, classGeneral: null };
    rows.forEach((tr) => {
      const tds = [...tr.querySelectorAll('td')];
      const first = txt(tds[0]).split('\n').map((x) => x.trim()).filter(Boolean);
      if (!first.length) return;
      if (/MOYENNE\s+G[ÉE]N[ÉE]RALE/i.test(first[0])) {
        out.general = txt(tds[1]);
        out.classGeneral = txt(tds[2]);
        return;
      }
      const last = tds[tds.length - 1];
      // Notes : chaque case affiche la note puis le barème (« 11 » puis « / 20 »).
      const BOX = /^(\S*)\s*\/\s*(\d+(?:[.,]\d+)?)$/;
      const flat = (el) => el.innerText.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      // Une case = le plus grand élément qui contient « note / barème » (sans enfant au texte identique),
      // sans compter les éléments déjà inclus dans une autre case.
      let boxes = [last, ...last.querySelectorAll('*')].filter((el) => BOX.test(flat(el)) && ![...el.children].some((c) => flat(c) === flat(el)));
      boxes = boxes.filter((el) => !boxes.some((o) => o !== el && o.contains(el)));
      let marks = boxes.map((el) => { const m = flat(el).match(BOX); return { raw: m[1], scale: m[2], el }; });
      if (!marks.length) {
        const re = /(\d+(?:[.,]\d+)?|[A-Za-z][A-Za-z.]*)?\s*\/\s*(\d+(?:[.,]\d+)?)/g;
        let m;
        while ((m = re.exec(flat(last)))) marks.push({ raw: m[1] || '', scale: m[2] });
      }
      // Détails éventuels (infobulles) des cases de notes.
      const tipOf = (el) => {
        for (let x = el; x && x !== last; x = x.parentElement) {
          const t = x.getAttribute('title') || x.getAttribute('data-original-title') || x.getAttribute('aria-label');
          if (t) return t;
        }
        return null;
      };
      const tips = marks.map((m) => (m.el ? tipOf(m.el) : null));
      marks = marks.map(({ raw, scale }) => ({ raw, scale }));
      out.subjects.push({
        label: first[0], teacher: first.slice(1).join(' '),
        average: txt(tds[1]), classAverage: txt(tds[2]), min: txt(tds[3]), max: txt(tds[4] && tds[4] !== last ? tds[4] : null),
        marks, tips,
      });
    });
    return out;
  });
}

try {
  if (!(await login())) { await snap('connexion-echec'); throw new Error('Connexion à Mon Bureau Numérique impossible (étape inattendue).'); }
  if (!page.url().includes('AFFICHER_RELEVE_NOTES_ELEVE')) await page.goto(NOTES_URL, { waitUntil: 'networkidle' });
  await snap('releve');
  fs.mkdirSync(debugDir, { recursive: true });
  fs.writeFileSync(path.join(debugDir, 'releve.html'), await page.content());
  // Périodes : la liste déroulante « Période ».
  const select = page.locator('select').filter({ has: page.locator('option', { hasText: /semestre|trimestre|ann[ée]e/i }) }).first();
  let periods = [];
  if (await select.count()) periods = await select.locator('option').evaluateAll((os) => os.map((o) => ({ value: o.value, label: o.textContent.trim(), selected: o.selected })));
  if (!periods.length) periods = [{ value: null, label: 'Période en cours', selected: true }];
  const result = [];
  for (const per of periods) {
    if (per.value !== null && !per.selected) {
      await Promise.all([page.waitForLoadState('networkidle').catch(() => {}), select.selectOption(per.value)]);
      await page.waitForTimeout(1500);
    }
    const t = await readTable();
    result.push({
      id: per.value || 'p', label: per.label, current: !!per.selected,
      general: num(t.general), classGeneral: num(t.classGeneral),
      subjects: t.subjects.map((s) => ({
        label: s.label, teacher: s.teacher, mat: matiereOf(s.label),
        average: num(s.average), classAverage: num(s.classAverage), min: num(s.min), max: num(s.max),
        evaluations: s.marks.map((m, i) => ({ mark: num(m.raw), raw: m.raw, scale: num(m.scale), info: s.tips[i] || null })),
      })),
    });
  }
  await browser.close();
  if (!result.some((p) => p.subjects.length)) throw new Error('Page des évaluations lue, mais aucun tableau de notes trouvé.');
  write(outPath, { source: 'web', updated: Date.now(), periods: result });
  // Historique de la moyenne générale (une valeur par jour et par période).
  const hist = readJson(histPath, { points: [] });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
  result.forEach((p) => {
    if (p.general === null) return;
    hist.points = hist.points.filter((x) => !(x.date === today && x.period === p.label));
    hist.points.push({ date: today, period: p.label, general: p.general, classGeneral: p.classGeneral });
  });
  write(histPath, hist);
  fs.rmSync(debugDir, { recursive: true, force: true }); // tout s'est bien passé : pas besoin des captures
  console.log('Notes :', result.map((p) => p.label + ' ' + p.subjects.length + ' matières').join(', '));
} catch (e) {
  await snap('erreur');
  await browser.close().catch(() => {});
  fail(e.message);
}
