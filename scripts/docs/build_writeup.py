"""Regenerates the architecture figures and appends them to the write-up PDF.

    python scripts/docs/build_writeup.py

The three original pages of docs/Contexo-writeup.pdf are kept as they are. Appendix pages are built
from the README section between <!-- architecture:start --> and <!-- architecture:end -->, one page per
<!-- pdf:page title="..." --> marker. They are printed with headless Edge or Chrome and appended.
Needs Python packages markdown and pymupdf, and Windows fonts (Trebuchet MS, Baskerville Old Face).
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import fitz
import markdown

sys.path.insert(0, str(Path(__file__).parent))
import diagrams  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
PDF = ROOT / 'docs' / 'Contexo-writeup.pdf'
ORIGINAL_PAGES = 3
REPO_BLOB = 'https://github.com/Bhavik-Sheth/TrueFoundry-Weights-of-Sin/blob/codex/run-recovery-and-review/'
BROWSERS = [
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'msedge', 'google-chrome', 'chromium',
]

CSS = """
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: 'Trebuchet MS', sans-serif; color: #1f2d3d; }
.page { width: 210mm; height: 297mm; position: relative; overflow: hidden; page-break-after: always;
  background: radial-gradient(ellipse 60% 45% at 100% 100%, #a9cff3 0%, rgba(169,207,243,0) 70%),
              linear-gradient(160deg, #f2f8fd 0%, #ffffff 45%, #f4f9fe 100%); }
.page:last-child { page-break-after: auto; }
.frame { position: absolute; border-radius: 14pt; }
.f1 { inset: 16pt; border: 0.8pt solid #c6d9ec; }
.f2 { inset: 20pt; border: 0.6pt solid #dce8f4; }
.head { position: absolute; top: 34pt; left: 40pt; right: 40pt; display: flex; justify-content: space-between;
  font: bold 8pt 'Courier New', monospace; color: #12385c; letter-spacing: 0.6pt; }
.foot { position: absolute; bottom: 30pt; left: 40pt; right: 40pt; border-top: 0.6pt solid #c6d9ec; padding-top: 8pt;
  display: flex; justify-content: space-between; font-size: 8pt; color: #12385c; }
.body { position: absolute; top: 56pt; left: 40pt; right: 40pt; bottom: 58pt; }
h1 { font: 30pt 'Baskerville Old Face', Baskerville, Georgia, serif; color: #12385c; margin: 0 0 6pt; font-weight: normal; }
h2 { font: 18pt 'Baskerville Old Face', Baskerville, Georgia, serif; color: #12385c; margin: 8pt 0 4pt; font-weight: normal; }
h3 { font: 13.5pt 'Baskerville Old Face', Baskerville, Georgia, serif; color: #12385c; margin: 8pt 0 3pt; font-weight: normal; }
p, li { font-size: 8.6pt; line-height: 1.38; margin: 0 0 5pt; }
ul { margin: 0 0 5pt; padding-left: 14pt; }
li { margin: 0 0 2pt; }
a { color: #095f9e; }
code { font-family: Consolas, monospace; font-size: 0.92em; color: #15344e; }
em { color: #41566b; font-size: 8pt; }
table { width: 100%; border-collapse: collapse; margin: 3pt 0 7pt; font-size: 7.3pt; line-height: 1.28; }
th { background: #15344e; color: #fff; text-align: left; padding: 3pt 5pt; font-weight: bold; }
td { padding: 2.3pt 5pt; vertical-align: top; border-bottom: 0.5pt solid #d7e3ef; }
tr:nth-child(even) td { background: rgba(232, 241, 250, 0.75); }
td:first-child { font-weight: bold; color: #15344e; }
img { display: block; margin: 4pt auto 3pt; max-width: 100%; }
.fig1 img { max-height: 615pt; }
.fig2 img { max-height: 300pt; }
"""


def find_browser() -> str:
    for candidate in BROWSERS:
        path = shutil.which(candidate) or (candidate if os.path.exists(candidate) else None)
        if path:
            return path
    raise SystemExit('Edge or Chrome is required to print the appendix.')


def pages_from_readme() -> list[tuple[str, str]]:
    text = (ROOT / 'README.md').read_text(encoding='utf-8')
    section = text.split('<!-- architecture:start -->', 1)[1].split('<!-- architecture:end -->', 1)[0]
    chunks = re.split(r'<!-- pdf:page title="([^"]+)" -->', section)[1:]
    return [(chunks[i], chunks[i + 1]) for i in range(0, len(chunks), 2)]


def to_html(md: str) -> str:
    body = markdown.markdown(md, extensions=['tables'])
    # Images load from disk; links point at the repository, as on the original pages.
    body = re.sub(r'src="(docs/|scripts/)', lambda m: f'src="{(ROOT / m[1]).as_uri()}/', body)
    body = re.sub(r'href="(docs/|scripts/|extension/)', lambda m: f'href="{REPO_BLOB}{m[1]}', body)
    body = body.replace('<p><img', '<p class="fig"><img')
    if 'contexo-architecture.svg' in body:
        body = body.replace('class="fig"', 'class="fig1"', 1)
    elif 'context-pipeline.svg' in body:
        body = body.replace('class="fig"', 'class="fig2"', 1)
    return body


def build_html(pages: list[tuple[str, str]]) -> str:
    total = len(pages)
    out = []
    for n, (title, md) in enumerate(pages, 1):
        heading = '' if n > 1 and pages[n - 2][0] == title else f'<h1>{title}</h1>'
        html_body = to_html(md)
        if heading:  # the page title replaces the README's own section heading
            html_body = re.sub(r'^\s*<h2>[^<]*</h2>', '', html_body)
        out.append(f'''<section class="page"><div class="frame f1"></div><div class="frame f2"></div>
<div class="head"><span>TRUEFORGE&nbsp;&nbsp;/&nbsp;&nbsp;FORGE-A-THON</span><span>WEIGHTS OF SIN</span></div>
<div class="body">{heading}{html_body}</div>
<div class="foot"><span>Contexo&nbsp;&nbsp;/&nbsp;&nbsp;Appendix&nbsp;&nbsp;/&nbsp;&nbsp;architecture and context</span><span>A{n}&nbsp;&nbsp;/&nbsp;&nbsp;A{total}</span></div>
</section>''')
    return f'<!doctype html><html><head><meta charset="utf-8"><style>{CSS}</style></head><body>{"".join(out)}</body></html>'


def check_fit(html_path: Path, browser: str, tmp: Path) -> None:
    """Fails when a page's content runs past its body box (it would be clipped)."""
    probe = tmp / 'probe.html'
    script = ('<script>window.onload=()=>{const bad=[...document.querySelectorAll(".body")].map((b,i)=>'
              '[i+1,b.scrollHeight-b.clientHeight]).filter(x=>x[1]>1);document.title=JSON.stringify(bad);}</script>')
    probe.write_text(html_path.read_text(encoding='utf-8').replace('</head>', script + '</head>'), encoding='utf-8')
    dom = subprocess.run([browser, '--headless=new', '--disable-gpu', '--allow-file-access-from-files', '--dump-dom',
                          probe.as_uri()], capture_output=True, text=True, encoding='utf-8', timeout=120).stdout
    m = re.search(r'<title>(.*?)</title>', dom)
    overflow = m[1] if m else '?'
    if overflow != '[]':
        raise SystemExit(f'Appendix content overflows [page, px]: {overflow}')


def main() -> None:
    diagrams.main()
    pages = pages_from_readme()
    browser = find_browser()
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        html_path = tmp / 'appendix.html'
        html_path.write_text(build_html(pages), encoding='utf-8')
        check_fit(html_path, browser, tmp)
        appendix = tmp / 'appendix.pdf'
        subprocess.run([browser, '--headless=new', '--disable-gpu', '--allow-file-access-from-files',
                        '--no-pdf-header-footer', f'--print-to-pdf={appendix}', html_path.as_uri()],
                       check=True, capture_output=True, timeout=120)
        doc = fitz.open(PDF)
        if doc.page_count > ORIGINAL_PAGES:
            doc.delete_pages(range(ORIGINAL_PAGES, doc.page_count))
        extra = fitz.open(appendix)
        doc.insert_pdf(extra)
        extra.close()
        out = tmp / 'writeup.pdf'
        doc.save(out, garbage=3, deflate=True)
        doc.close()
        shutil.copyfile(out, PDF)
    print(f'wrote {PDF.relative_to(ROOT)}: {ORIGINAL_PAGES} original pages + {len(pages)} appendix pages')


if __name__ == '__main__':
    main()
