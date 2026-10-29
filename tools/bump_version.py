"""Change le numéro de version des fichiers CSS et JS (ajouté aux adresses en ?v=...).

À lancer avant chaque publication : le navigateur télécharge alors les nouveaux
fichiers au lieu de réutiliser ceux qu'il a gardés en cache.
"""
import re, time, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
version = time.strftime('%Y%m%d%H%M%S')

html = root / 'index.html'
text = html.read_text(encoding='utf-8')
for pat in [r'(css/app\.css)(\?v=\w+)?', r'(js/app\.js)(\?v=\w+)?']:
    text, n = re.subn(pat, lambda m: m.group(1) + '?v=' + version, text)
    assert n == 1, pat
html.write_text(text, encoding='utf-8')

# Imports entre modules : from './store.js' -> from './store.js?v=...'
for js in (root / 'js').glob('*.js'):
    text = js.read_text(encoding='utf-8')
    text = re.sub(r"(from '\./[\w-]+\.js)(\?v=\w+)?'", lambda m: m.group(1) + '?v=' + version + "'", text)
    js.write_text(text, encoding='utf-8')
print('version', version)
