"""Generate the side-panel and options pages used by test/panel-harness.html.

They are copies of the real pages with test/chrome-bus.js (a chrome.* test double) loaded
first. The generated files are git-ignored. Usage, from the repository root:

    python test/make_harness.py
    python -m http.server 8765
    # open http://localhost:8765/test/panel-harness.html?lecture&demo
"""
import pathlib
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
TAG = '<script src="../src/shared.js"></script>'
BUS = f'<script src="../test/chrome-bus.js?v={int(time.time())}"></script>\n  {TAG}'

for page in ('sidepanel/sidepanel.html', 'options/options.html'):
    src = ROOT / page
    html = src.read_text(encoding='utf-8')
    assert TAG in html, f'{page}: shared.js tag not found'
    out = src.with_name('_harness.html')
    out.write_text(html.replace(TAG, BUS, 1), encoding='utf-8')
    print('wrote', out.relative_to(ROOT))
