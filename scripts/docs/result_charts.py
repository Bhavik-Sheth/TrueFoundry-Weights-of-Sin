"""Render the competition result figures from recorded benchmark values."""
import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/architecture'
EVIDENCE = ROOT / 'docs/verification/2026-11-21'
BLUE = '#095f9e'
SLATE = '#567388'
INK = '#12385c'


def chart(file, title, description, maximum, rows, ticks):
    width, height = 690, 64 + 35 * len(rows)
    left, span = 238, 368
    nodes = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" role="img" aria-labelledby="title desc">',
        f'<title id="title">{html.escape(title)}</title><desc id="desc">{html.escape(description)}</desc>',
        f'<rect x="1" y="1" width="{width - 2}" height="{height - 2}" rx="12" fill="#f7fbff" stroke="#c6d9ec"/>',
        f'<g fill="{INK}" font-family="Trebuchet MS, Segoe UI, Arial, sans-serif">',
        f'<text x="18" y="26" font-size="18" font-weight="700">{html.escape(title)}</text>',
    ]
    for tick in ticks:
        x = left + span * tick / maximum
        nodes.append(f'<path d="M{x:.2f} 38 V{height - 27}" stroke="#d2e1ec" stroke-width="1"/>')
        nodes.append(f'<text x="{x:.2f}" y="{height - 11}" text-anchor="middle" font-size="12">{tick:,}</text>')
    for position, (label, value, annotation, color) in enumerate(rows):
        y = 48 + 35 * position
        bar = span * value / maximum
        nodes.extend([
            f'<text x="18" y="{y + 12}" font-size="15">{html.escape(label)}</text>',
            f'<rect x="{left}" y="{y}" width="{bar:.2f}" height="15" rx="4" fill="{color}"/>',
            f'<text x="{left + bar + 9:.2f}" y="{y + 12}" font-size="14" font-weight="700">{html.escape(annotation)}</text>',
        ])
    nodes.extend(['</g>', '</svg>'])
    (OUT / file).write_text('\n'.join(nodes) + '\n', encoding='utf-8')


def main():
    # Medians from the pinned LMCache microbenchmark in AGENT_BRIDGE.md.
    chart('context-cache-results.svg', 'Median context assembly time (ms)',
          'Twelve forced misses and twelve warm lookups over the same 24,952-symbol LMCache index.',
          4000, [('Rebuilt ranking snapshot', 3736, '3,736 ms', SLATE),
                 ('Warm reuse', 118, '118 ms', BLUE)], [0, 1000, 2000, 3000, 4000])

    metrics = json.loads((EVIDENCE / 'model-comparison/results.json').read_text())['runs']
    mercury = metrics['mercury-repair']['behavior_oracle']
    baseline = metrics['bonsai']['behavior_oracle']
    chart('httpx-model-results.svg', 'Independent HTTPX behavior checks passed',
          'Mercury after feedback passed all 15 checks. Native Bonsai made no changes and matched baseline.',
          mercury['total'], [('Mercury 3 after repair', mercury['passed'], f'{mercury["passed"]} / {mercury["total"]}', BLUE),
                             ('Native Bonsai / baseline', baseline['passed'], f'{baseline["passed"]} / {baseline["total"]}', SLATE)],
          [0, 5, 10, 15])


if __name__ == '__main__':
    main()
