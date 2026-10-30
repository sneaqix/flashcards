K=['paper','grid','card','ink','muted','line','accent','accent-ink','accent-soft','mark','good','again','hard','shadow']
def v(vals): return dict(zip(K,vals.split()))
SYS='-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui, sans-serif'
T=[
('cahier', {'font-display':'"Bricolage Grotesque", "Segoe UI", system-ui, sans-serif','font-body':'"Source Sans 3", "Segoe UI", system-ui, sans-serif'},
 v('#f3f5fa #e1e6f2 #ffffff #18203a #5d6680 #d4dae8 #2443b8 #ffffff #e3e8fb #ffe066 #1f8a55 #c4422f #b26a00 rgba(24,32,58,0.08)'),
 v('#11141d #1a1f2c #1b2030 #e8ebf5 #98a1ba #2c3347 #8ea2ff #0f1424 #252d4a #6b5a12 #4cc08a #f07a66 #f0a640 rgba(0,0,0,0.35)'), {}),
('tableau', {'font-display':'Kalam, "Segoe Print", cursive','font-body':'"Source Sans 3", system-ui, sans-serif'},
 v('#f7f7f3 transparent #ffffff #1d2a3a #5b6878 #d9dde3 #1565c0 #ffffff #e3eefb #ffef8a #2e7d32 #c62828 #a35f00 rgba(29,42,58,0.08)'),
 v('#24352c rgba(255,255,255,0.03) #2e4337 #eef2ea #a9bcae #4a6354 #f4e27a #1f2e26 #3b5345 rgba(244,226,122,0.35) #8fdc9a #ff9a8a #ffc56b rgba(0,0,0,0.3)'), {'r1':'6px','r2':'8px','r3':'10px'}),
('epure', {'font-display':SYS,'font-body':SYS},
 v('#f2f2f7 transparent #ffffff #1c1c1e #6e6e73 #e5e5ea #007aff #ffffff #e5f0ff #fff3a3 #248a3d #d70015 #b25000 rgba(0,0,0,0.06)'),
 v('#000000 transparent #141414 #f2f2f2 #8e8e93 #2c2c2e #b69cff #14092e #251c3d #4a3a7a #30d158 #ff6961 #ffb340 rgba(0,0,0,0.6)'), {'r1':'10px','r2':'14px','r3':'16px'}),
('biblio', {'font-display':'Fraunces, Georgia, serif','font-body':'Literata, Georgia, serif'},
 v('#f2e9d4 transparent #fbf6e9 #3b2a1a #75604a #dccdab #8b3a1e #fbf6e9 #f0dfcf #ecd27a #4d7a2a #a8321f #8f5300 rgba(59,42,26,0.1)'),
 v('#1e1812 transparent #2a221a #efe4cf #b3a185 #44382a #e0a26f #1e1812 #3d2e20 #6b5520 #9ccc7a #f08a70 #e8b060 rgba(0,0,0,0.4)'), {'r1':'4px','r2':'6px','r3':'8px'}),
('brutal', {'font-display':'"Space Grotesk", system-ui, sans-serif','font-body':'"Space Grotesk", system-ui, sans-serif'},
 v('#fff1c9 transparent #ffffff #000000 #3a3a3a #000000 #ff5c39 #000000 #ffd9cc #9ef0c3 #0a7a3f #c42508 #8f4a00 rgba(0,0,0,0)'),
 v('#151515 transparent #222222 #ffffff #cfcfcf #f5f5f5 #ff7a5c #000000 #4a2a22 #1f6b4a #5fe39a #ff8a70 #ffbf5c rgba(0,0,0,0)'), {'r1':'4px','r2':'4px','r3':'6px'}),
('pastel', {'font-display':'Nunito, system-ui, sans-serif','font-body':'Nunito, system-ui, sans-serif'},
 v('#f4eeff transparent #ffffff #2d2440 #6a6080 #e4dcf5 #7c55d6 #ffffff #ece4ff #ffd6e7 #2a8a60 #c93a60 #a8680a rgba(124,85,214,0.1)'),
 v('#1c1726 transparent #262036 #ece6fa #a99fc2 #3a3150 #c4adff #1c1726 #352a52 #6b3a55 #7fdcae #ff8fae #ffc47a rgba(0,0,0,0.35)'), {'r1':'14px','r2':'20px','r3':'22px'}),
('terminal', {'font-display':'"JetBrains Mono", ui-monospace, Menlo, monospace','font-body':'"JetBrains Mono", ui-monospace, Menlo, monospace'},
 v('#f4f1e6 #e9e5d6 #fffdf5 #1b3d1f #4e7151 #c5d6be #1d7a2e #ffffff #dcefd9 #c8f0b8 #1d7a2e #b3261e #8a5a00 rgba(27,61,31,0.08)'),
 v('#0b120b rgba(57,255,106,0.04) #0f1b10 #b8f7b0 #6fb86a #1f5c26 #39ff6a #0b120b #15331a #1f5c26 #39ff6a #ff5f56 #ffbd2e rgba(0,0,0,0.5)'), {'r1':'2px','r2':'2px','r3':'3px'}),
]
def block(sel, vals, extra, scheme):
    lines=[f'  --{k}: {x};' for k,x in vals.items()]+[f'  --{k}: {x};' for k,x in extra.items()]+[f'  color-scheme: {scheme};']
    return sel+' {\n'+'\n'.join(lines)+'\n}\n'
out=['/* Chartes graphiques. Chaque charte a une version claire et une version sombre ;\n   data-mode : light, dark ou auto (suit le réglage du système). Généré par tools/gen_themes.py (ne pas modifier à la main). */\n']
dark=[]
for name,fonts,light,dk,radii in T:
    out.append(block(f'[data-theme="{name}"]', light, {**fonts, **{k:v for k,v in radii.items()}}, 'light'))
    out.append(block(f'[data-theme="{name}"][data-mode="dark"]', dk, {}, 'dark'))
    dark.append(block(f'  [data-theme="{name}"][data-mode="auto"]', dk, {}, 'dark').replace('\n  --','\n    --').replace('\n  color','\n    color').replace('\n}','\n  }'))
out.append('@media (prefers-color-scheme: dark) {\n'+''.join(dark)+'}\n')
out.append('''
/* Particularités de certaines chartes */
html[data-theme="brutal"] .panel, html[data-theme="brutal"] .card, html[data-theme="brutal"] .tile, html[data-theme="brutal"] .ag-cal,
html[data-theme="brutal"] .ag-day, html[data-theme="brutal"] .cn-card, html[data-theme="brutal"] .ir { border-width: 2px; box-shadow: 4px 4px 0 var(--line); }
html[data-theme="brutal"] button.primary, html[data-theme="brutal"] .button.primary { border: 2px solid var(--line); box-shadow: 3px 3px 0 var(--line); }
html[data-theme="brutal"] button.primary:active { transform: translate(2px, 2px); box-shadow: 1px 1px 0 var(--line); }
html[data-theme="brutal"] .ghost, html[data-theme="brutal"] input, html[data-theme="brutal"] select, html[data-theme="brutal"] textarea { border-width: 2px; }
html[data-theme="brutal"] h1 .hl { background: var(--accent); color: var(--accent-ink); padding: 0 6px; }
html[data-theme="pastel"] .panel, html[data-theme="pastel"] .card { border-color: transparent; box-shadow: 0 6px 22px var(--shadow); }
html[data-theme="epure"] .panel, html[data-theme="epure"] .card, html[data-theme="epure"] .tile { border-color: transparent; }
html[data-theme="epure"][data-mode="dark"] .panel, html[data-theme="epure"][data-mode="dark"] .card { border-color: var(--line); }
html[data-theme="tableau"] h1, html[data-theme="tableau"] h2 { letter-spacing: 0; }
html[data-theme="tableau"] h1 .hl { background: none; border-bottom: 3px solid var(--accent); }
html[data-theme="terminal"] body { font-size: 15px; }
html[data-theme="terminal"] h1::before { content: "> "; color: var(--accent); }
html[data-theme="terminal"] h1 .hl { background: none; color: var(--accent); }
html[data-theme="biblio"] h1 { font-weight: 600; }
''')
open(__import__('os').path.join(__import__('os').path.dirname(__file__), '..', 'css', 'themes.css'),'w').write(''.join(out))
