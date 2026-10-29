"""Change le numéro de version des fichiers CSS et JS (ajouté aux adresses en ?v=...).

À lancer avant chaque publication : le navigateur télécharge alors les nouveaux
fichiers au lieu de réutiliser ceux qu'il a gardés en cache.
"""
import re, time, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
version = time.strftime('%Y%m%d%H%M%S')
targets = {
    root / 'index.html': [r'(css/app\.css)(\?v=\w+)?', r'(js/app\.js)(\?v=\w+)?'],
    root / 'js' / 'app.js': [r"(\./github\.js)(\?v=\w+)?", r"(\./store\.js)(\?v=\w+)?"],
}
for path, patterns in targets.items():
    text = path.read_text(encoding='utf-8')
    for pat in patterns:
        text, n = re.subn(pat, lambda m: m.group(1) + '?v=' + version, text)
        assert n >= 1, (path, pat)
    path.write_text(text, encoding='utf-8')
print('version', version)
