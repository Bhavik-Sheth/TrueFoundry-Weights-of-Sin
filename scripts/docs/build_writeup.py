"""Render the three-page competition write-up from docs/writeup.md.

Run python scripts/docs/build_writeup.py with Markdown and headless Chrome or Edge.
Use --appendix to render the extended README architecture as a separate PDF.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import markdown
from result_charts import main as build_result_charts

sys.path.insert(0, str(Path(__file__).parent))

ROOT = Path(__file__).resolve().parents[2]
PDF = ROOT / 'docs' / 'Contexo-writeup.pdf'
REPO_BLOB = 'https://github.com/Bhavik-Sheth/TrueFoundry-Weights-of-Sin/blob/foldr/'
BROWSERS = [
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'msedge', 'google-chrome', 'chromium',
]

CSS = """
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: 'Trebuchet MS', sans-serif; color: #1f2d3d; }
.page { width: 210mm; height: 297mm; position: relative; overflow: hidden; page-break-after: always;
  background: linear-gradient(135deg, #fafcfe 0%, #f4faff 58%, #daefff 86%, #9acafa 100%); }
.page:last-child { page-break-after: auto; }
.frame { position: absolute; border-radius: 14pt; }
.f1 { inset: 16pt; border: 0.8pt solid #c6d9ec; }
.f2 { inset: 20pt; border: 0.6pt solid #dce8f4; }
.head { position: absolute; top: 34pt; left: 40pt; right: 40pt; display: flex; justify-content: space-between;
  font: bold 8pt 'Courier New', monospace; color: #12385c; letter-spacing: 0.6pt; }
.foot { position: absolute; bottom: 30pt; left: 40pt; right: 40pt; border-top: 0.6pt solid #c6d9ec; padding-top: 8pt;
  display: flex; justify-content: space-between; font-size: 8pt; color: #12385c; }
.body { position: absolute; top: 56pt; left: 40pt; right: 40pt; bottom: 58pt; }
h1 { font: 32pt Baskerville, 'Baskerville Old Face', Georgia, serif; color: #12385c; margin: 0 0 6pt; font-weight: normal; }
h2 { font: 18pt Baskerville, 'Baskerville Old Face', Georgia, serif; color: #12385c; margin: 8pt 0 4pt; font-weight: normal; }
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
.submission h2 { font-size: 21pt; margin-top: 12pt; }
.submission p { font-size: 10.5pt; line-height: 1.43; margin-bottom: 8pt; }
.submission table { font-size: 8.6pt; line-height: 1.27; }
.submission td, .submission th { padding: 2.5pt 5pt; }
.submission th:first-child { width: 22%; }
.submission th:nth-child(2) { width: 22%; }
.score-page p { font-size: 10pt; line-height: 1.37; margin-bottom: 7pt; }
.submission .context-page { top: 53pt; }
.context-page h2 { font-size: 20pt; margin-top: 8pt; }
.context-page p { font-size: 9.9pt; line-height: 1.35; margin-bottom: 6pt; }
.context-page table { font-size: 8.65pt; line-height: 1.25; }
.context-page td, .context-page th { padding: 2.5pt 5pt; }
.context-page table:first-of-type th:first-child { width: 22%; }
.fig1 img { max-height: 285pt; }
.appendix .fig1 img { max-height: 615pt; }
.fig2 img { max-height: 300pt; }
.submission .result-chart img { width: 100%; max-height: 100pt; margin: 8pt auto 5pt; }
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


def submission_pages() -> list[tuple[str, str]]:
    text = (ROOT / 'docs/writeup.md').read_text(encoding='utf-8')
    sections = re.split(r'(?m)(?=^## )', text)[1:]
    titles = ('Team', 'Starting point', 'Architecture on TrueForge', 'How context is selected',
              'Model setup', 'Scorecard', 'Tools used', 'Known limitations')
    if [section.splitlines()[0] for section in sections] != [
        f'## {i}. {title}' for i, title in enumerate(titles, 1)
    ]:
        raise SystemExit('Expected all eight numbered competition headings in order.')
    return [
        ('Contexo', '\n'.join(sections[:3])),
        ('Context and inference', '\n'.join(sections[3:5])),
        ('Competition evidence', '\n'.join(sections[5:])),
    ]


def to_html(md: str, directory: Path) -> str:
    body = markdown.markdown(md, extensions=['tables'])
    def resolve(match: re.Match) -> str:
        attr, value = match.groups()
        if ':' in value or value.startswith('#'):
            return match[0]
        path, separator, fragment = value.partition('#')
        target = (directory / path).resolve()
        if attr == 'src':
            return f'src="{target.as_uri()}"'
        base = REPO_BLOB.replace('/blob/', '/tree/') if target.is_dir() else REPO_BLOB
        return f'href="{base}{target.relative_to(ROOT).as_posix()}{separator}{fragment}"'

    body = re.sub(r'(src|href)="([^"]+)"', resolve, body)
    if 'contexo-architecture.svg' in body:
        body = body.replace('<p><img', '<p class="fig1"><img', 1)
    elif 'context-pipeline.svg' in body:
        body = body.replace('<p><img', '<p class="fig2"><img', 1)
    return re.sub(r'(<p>)(<img[^>]+-results\.svg"[^>]*>)', r'<p class="result-chart">\2', body)


def build_html(pages: list[tuple[str, str]], appendix: bool) -> str:
    out = []
    layout = 'page appendix' if appendix else 'page submission'
    footer = 'Architecture notes' if appendix else '22 November 2026'
    for n, (title, md) in enumerate(pages, 1):
        heading = '' if appendix and n > 1 and pages[n - 2][0] == title else f'<h1>{title}</h1>'
        html_body = to_html(md, ROOT if appendix else ROOT / 'docs')
        if appendix and heading:
            html_body = re.sub(r'^\s*<h2>[^<]*</h2>', '', html_body)
        if not appendix and n == 1:
            heading += '<p style="font-size: 11pt">A reviewable coding agent inside VS Code</p>'
        section_class = {2: "body context-page", 3: "body score-page"}.get(n, "body") if not appendix else "body"
        out.append(f'''<section class="{layout}"><div class="frame f1"></div><div class="frame f2"></div>
<div class="head"><span>TRUEFORGE&nbsp;&nbsp;/&nbsp;&nbsp;FORGE-A-THON</span><span>WEIGHTS OF SIN</span></div>
<div class="{section_class}">{heading}{html_body}</div>
<div class="foot"><span>Contexo&nbsp;&nbsp;/&nbsp;&nbsp;{footer}</span><span>{n:02}&nbsp;&nbsp;/&nbsp;&nbsp;{len(pages):02}</span></div>
</section>''')
    return f'<!doctype html><html><head><meta charset="utf-8"><style>{CSS}</style></head><body>{"".join(out)}</body></html>'


def check_fit(html_path: Path, browser: str, tmp: Path) -> None:
    """Fails when a page's content runs past its body box (it would be clipped)."""
    probe = tmp / 'probe.html'
    script = ('<script>window.onload=()=>{const bad=[...document.querySelectorAll(".body")].map((b,i)=>'
              '[i+1,b.scrollHeight-b.clientHeight]).filter(x=>x[1]>1);document.title=JSON.stringify(bad);}</script>')
    probe.write_text(html_path.read_text(encoding='utf-8').replace('</head>', script + '</head>'), encoding='utf-8')
    dom = subprocess.run([browser, '--headless=new', '--disable-gpu', '--allow-file-access-from-files', f'--user-data-dir={tmp / "browser"}', '--dump-dom',
                          probe.as_uri()], capture_output=True, text=True, encoding='utf-8', timeout=120).stdout
    m = re.search(r'<title>(.*?)</title>', dom)
    overflow = m[1] if m else '?'
    if overflow != '[]':
        raise SystemExit(f'Write-up content overflows [page, px]: {overflow}')


def main() -> None:
    appendix = sys.argv[1:] == ['--appendix']
    if sys.argv[1:] and not appendix:
        raise SystemExit('Expected no arguments or --appendix.')
    if appendix:
        import diagrams
        diagrams.main()
    else:
        build_result_charts()
    pages = pages_from_readme() if appendix else submission_pages()
    output = PDF.with_name('Contexo-architecture-appendix.pdf') if appendix else PDF
    browser = find_browser()
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        html_path = tmp / 'writeup.html'
        html_path.write_text(build_html(pages, appendix), encoding='utf-8')
        check_fit(html_path, browser, tmp)
        rendered = tmp / 'writeup.pdf'
        subprocess.run([browser, '--headless=new', '--disable-gpu', '--allow-file-access-from-files',
                        f'--user-data-dir={tmp / "browser"}', '--no-pdf-header-footer',
                        f'--print-to-pdf={rendered}', html_path.as_uri()],
                       check=True, capture_output=True, timeout=120)
        shutil.copyfile(rendered, output)
    print(f'wrote {output.relative_to(ROOT)} with {len(pages)} pages')


if __name__ == '__main__':
    main()
