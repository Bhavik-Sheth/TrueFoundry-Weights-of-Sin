"""Builds the two architecture figures as standalone SVG files.

    python scripts/docs/diagrams.py

Writes docs/architecture/contexo-architecture.svg and docs/architecture/context-pipeline.svg.
Text is wrapped with real font metrics (Trebuchet MS via Pillow) so boxes never overflow; the script
fails loudly if a box is too small for its text.
"""
from __future__ import annotations

import html
import os
import re
from pathlib import Path

from PIL import ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs' / 'architecture'
FONTS = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts'
FAMILY = "'Trebuchet MS', 'Segoe UI', Helvetica, Arial, sans-serif"
SERIF = "'Baskerville Old Face', Baskerville, Georgia, serif"
SLACK = 1.06  # other fonts (GitHub viewers without Trebuchet) run slightly wider

SIZE = 12.5
LEAD = 15.6
TITLE = 14.5

OVERFLOWS: list[str] = []
_fonts: dict[tuple[bool, float], ImageFont.FreeTypeFont] = {}


def font(bold: bool, size: float) -> ImageFont.FreeTypeFont:
    key = (bold, size)
    if key not in _fonts:
        _fonts[key] = ImageFont.truetype(str(FONTS / ('trebucbd.ttf' if bold else 'trebuc.ttf')), size=int(size * 4))
    return _fonts[key]


def width(text: str, bold: bool = False, size: float = SIZE) -> float:
    return font(bold, size).getlength(text) / 4 * SLACK


THEMES = {
    'entry': ('#eaf3fb', '#095f9e', '#095f9e'),
    'run': ('#ffffff', '#12385c', '#12385c'),
    'fail': ('#fdf1f0', '#b0413e', '#9c2f2c'),
    'review': ('#fff7e8', '#b7791f', '#7a4f0e'),
    'mcp': ('#eef4fb', '#215879', '#215879'),
    'ctx': ('#ecf6f0', '#25785c', '#1d6149'),
    'tf': ('#ffffff', '#5b4a9e', '#4a3b8a'),
    'store': ('#f4f5f7', '#4b5563', '#374151'),
    'band': ('#f7fafd', '#12385c', '#12385c'),
}


def runs_of(spec: str) -> list[tuple[str, bool]]:
    """'**bold** plain' -> [(word, bold, glued), ...]; glued words follow the previous one without a space."""
    out: list[tuple[str, bool, bool]] = []
    prev_space = True
    for i, part in enumerate(re.split(r'\*\*', spec)):
        for j, word in enumerate(part.split(' ')):
            if word:
                out.append((word, i % 2 == 1, j == 0 and not prev_space))
        if part:
            prev_space = part.endswith(' ')
    return out


def wrap(spec: str, max_w: float, size: float = SIZE) -> list[tuple[float, list[tuple[str, bool, bool]]]]:
    """Greedy wrap. A leading '• ' or 'N ' marker gets a hanging indent. Returns [(indent, words)]."""
    words = runs_of(spec)
    hang = 0.0
    m = re.match(r'^(•|\d+|[①-⑩])\s', spec)
    if m:
        hang = width(words[0][0] + ' ', words[0][1], size)
    lines: list[tuple[float, list[tuple[str, bool, bool]]]] = []
    cur: list[tuple[str, bool, bool]] = []
    cur_w = 0.0
    indent = 0.0
    space = width(' ', False, size)
    for word, bold, glued in words:
        w = width(word, bold, size)
        need = w if not cur else cur_w + (0 if glued else space) + w
        if cur and indent + need > max_w and not glued:
            lines.append((indent, cur))
            cur, cur_w, indent = [(word, bold, False)], w, hang
        else:
            cur.append((word, bold, glued))
            cur_w = need
    if cur:
        lines.append((indent, cur))
    return lines


def esc(s: str) -> str:
    return html.escape(s, quote=False)


class Svg:
    def __init__(self, w: int, h: int):
        self.w, self.h = w, h
        self.parts: list[str] = []

    def add(self, s: str) -> None:
        self.parts.append(s)

    def text_line(self, x: float, y: float, words: list[tuple[str, bool, bool]], color: str, size: float = SIZE) -> None:
        spans = []
        for i, (word, bold, glued) in enumerate(words):
            sep = ' ' if i and not glued else ''
            weight = ' font-weight="700"' if bold else ''
            spans.append(f'<tspan{weight}>{esc(sep + word)}</tspan>')
        self.add(f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" fill="{color}" xml:space="preserve">{"".join(spans)}</text>')

    def label(self, x: float, y: float, text: str, color: str = '#12385c', size: float = 11.5, bold: bool = True,
              anchor: str = 'start', spacing: float = 1.2, family: str = FAMILY) -> None:
        weight = ' font-weight="700"' if bold else ''
        self.add(f'<text x="{x}" y="{y}" font-size="{size}" fill="{color}"{weight} text-anchor="{anchor}" '
                 f'letter-spacing="{spacing}" font-family="{family}">{esc(text)}</text>')

    def container(self, x: float, y: float, w: float, h: float, title: str, stroke: str, fill: str, note: str = '') -> None:
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="{fill}" stroke="{stroke}" '
                 f'stroke-width="1.4" stroke-dasharray="7 5"/>')
        self.label(x + 14, y + 19, title, stroke, 11.5)
        if note:
            self.label(x + w - 14, y + 19, note, stroke, 11, False, anchor='end', spacing=0.3)

    def box(self, x: float, y: float, w: float, h: float, title: str, lines: list[str], theme: str,
            cols: int = 1, tag: str | None = None) -> None:
        fill, stroke, tcolor = THEMES[theme]
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="9" fill="{fill}" stroke="{stroke}" stroke-width="1.3"/>')
        self.add(f'<rect x="{x}" y="{y}" width="5" height="{h}" rx="2" fill="{stroke}"/>')
        self.add(f'<text x="{x + 16}" y="{y + 22}" font-size="{TITLE}" font-weight="700" fill="{tcolor}">{esc(title)}</text>')
        if tag:
            tw = width(tag, True, 10.5) + 14
            self.add(f'<rect x="{x + w - tw - 10}" y="{y + 9}" width="{tw}" height="18" rx="9" fill="{stroke}"/>')
            self.add(f'<text x="{x + w - tw / 2 - 10}" y="{y + 22}" font-size="10.5" font-weight="700" fill="#fff" '
                     f'text-anchor="middle">{esc(tag)}</text>')
        gap = 18
        col_w = (w - 30 - gap * (cols - 1)) / cols
        per = -(-len(lines) // cols)
        for c in range(cols):
            yy = y + 42
            cx = x + 16 + c * (col_w + gap)
            for spec in lines[c * per:(c + 1) * per]:
                if spec == '':
                    yy += LEAD * 0.45
                    continue
                for indent, words in wrap(spec, col_w):
                    self.text_line(cx + indent, yy, words, '#1f2d3d')
                    yy += LEAD
                yy += 2.5
            if yy - LEAD + 10 > y + h:
                OVERFLOWS.append(f'box "{title}" needs {yy - LEAD + 10 - y:.0f}px, has {h}px')

    def arrow(self, pts: list[tuple[float, float]], color: str, dashed: bool = False, both: bool = False,
              width_: float = 1.8) -> None:
        d = 'M ' + ' L '.join(f'{px} {py}' for px, py in pts)
        dash = ' stroke-dasharray="6 4"' if dashed else ''
        self.add(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{width_}"{dash}/>')
        self.head(pts[-2], pts[-1], color)
        if both:
            self.head(pts[1], pts[0], color)

    def head(self, a: tuple[float, float], b: tuple[float, float], color: str) -> None:
        import math
        ang = math.atan2(b[1] - a[1], b[0] - a[0])
        L, W = 9, 4.5
        p1 = (b[0] - L * math.cos(ang) + W * math.sin(ang), b[1] - L * math.sin(ang) - W * math.cos(ang))
        p2 = (b[0] - L * math.cos(ang) - W * math.sin(ang), b[1] - L * math.sin(ang) + W * math.cos(ang))
        self.add(f'<polygon points="{b[0]},{b[1]} {p1[0]:.1f},{p1[1]:.1f} {p2[0]:.1f},{p2[1]:.1f}" fill="{color}"/>')

    def badge(self, x: float, y: float, n: str, color: str) -> None:
        self.add(f'<circle cx="{x}" cy="{y}" r="9.5" fill="{color}" stroke="#fff" stroke-width="1.5"/>')
        n = str('①②③④⑤⑥⑦⑧⑨'.index(n) + 1) if n in '①②③④⑤⑥⑦⑧⑨' else n
        self.add(f'<text x="{x}" y="{y + 4.2}" font-size="11" font-weight="700" fill="#fff" text-anchor="middle">{n}</text>')

    def render(self) -> str:
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" width="{self.w}" height="{self.h}" '
                f'font-family="{FAMILY}">\n<rect width="{self.w}" height="{self.h}" fill="#ffffff"/>\n'
                + '\n'.join(self.parts) + '\n</svg>\n')


NAVY, BLUE, VIOLET, AMBER, RED, GREY, GREEN = '#12385c', '#095f9e', '#5b4a9e', '#b7791f', '#b0413e', '#4b5563', '#25785c'


def legend(s: Svg, x: float, y: float, items: list[tuple[str, str, bool]]) -> None:
    for color, text, dashed in items:
        s.arrow([(x, y), (x + 34, y)], color, dashed)
        s.label(x + 42, y + 4, text, '#1f2d3d', 11, False, spacing=0)
        x += 50 + width(text, False, 11)


def architecture() -> str:
    s = Svg(1200, 1860)
    s.add(f'<text x="20" y="44" font-family="{SERIF}" font-size="31" fill="{NAVY}">Contexo · end-to-end architecture</text>')
    s.label(20, 66, 'One request from the editor to an applied, reviewed change. Numbers follow the request lifecycle at the bottom.',
            '#41566b', 12.5, False, spacing=0)
    legend(s, 700, 30, [(NAVY, 'request / stream', False), (VIOLET, 'tool calls', False), (AMBER, 'approval & write', False)])
    legend(s, 700, 54, [(RED, 'failure / stop', True), (GREY, 'persistence', True), (GREEN, 'context', False)])

    s.label(20, 92, '1 · ENTRY SURFACES', BLUE)
    s.box(20, 100, 275, 155, 'Inline edit', [
        '**Ctrl+K E** or right-click; needs a non-empty selection inside the active workspace root',
        'Sends **[INLINE EDIT]**: path, line range, whole-file baseHash, instruction, selected code, “stay inside the selection”',
    ], 'entry')
    s.box(315, 100, 275, 155, 'Assistant (agent mode)', [
        'Sidebar **Chat**, **Ask Assistant**, **@contexo** chat participant',
        'Request + hint: assemble_context first, batch code/tests/docs, test after apply. Follow-ups reuse the session',
    ], 'entry')
    s.box(610, 100, 275, 155, 'Terminal CLI', [
        '**ask · inline · commits · review · replay · doctor**',
        'Drives the same TrueForge agents with its own loopback MCP listener and session; y/N per hunk and command; non-TTY denies; --check tests first',
    ], 'entry')
    s.box(905, 100, 275, 155, 'Standalone review (:18792)', [
        'Review JSON, run replay (native / ACP / OTLP), Python impact graph',
        'Reads evidence and computes candidates; **never writes files or runs commands**',
    ], 'entry')

    s.container(20, 272, 780, 1112, '2 · EXTENSION HOST', NAVY, '#f7fafd', 'VS Code · Node · loopback only · never calls a model provider')
    s.container(820, 272, 360, 1112, '3 · TRUEFORGE', VIOLET, '#f5f2fb', 'local agent harness · :8790')

    s.box(36, 300, 748, 158, 'Run manager — exactly one active run', [
        '**States** streaming → awaiting-review → done · cancelled · failed. A new run is refused while one streams or awaits review',
        '**First-event timer** 20 s (contexo.firstEventTimeoutMs); any model.* or tool.* event disarms it',
        '**Streams** text deltas, tool cards (deferred marker), approvals; deltas merged so tool arguments arrive whole',
        '**Approval queue**, one at a time: propose_write → review engine · run_command → modal Allow / Deny · any other tool → denied',
        '**Stream ends without turn.done** → re-reads the turn state from TrueForge and records the reconciliation',
        '**Every event** is journaled with run, session and turn ids (text deltas excepted)',
    ], 'run', cols=2)

    s.box(36, 474, 364, 312, 'Failure router', [
        '**TrueForge unreachable**: network error thrown before any model activity → run fails, “TrueForge not reachable” (fallback cannot help)',
        '**Model failure**: HTTP 401/403/404/408/429/5xx, connection reset/refused/timeouts after activity, SDK timeout, first-event timeout, turn error naming provider, key, model, endpoint, quota or rate limit',
        '**Never fallback**: MCP or tool errors, user cancellation',
        '**Fallback guard**: fallback agent ≠ primary · not yet used in this run · no write approved · not stopped',
        '**Takeover**: seal primary session · drop pending proposal · new session on contexo-fallback · banner · replay first message + “continue from the start”',
        '**Both fail** → “Both models failed … No files were changed.”',
    ], 'fail')

    s.box(36, 802, 364, 160, 'Stop', [
        '**Synchronous, before any await**: state cancelled, session sealed, stream aborted, approval queue cleared, open review discarded (nothing written), command process trees killed',
        '**Then** TrueForge cancel. Late events are dropped; tools answer RUN_NOT_AUTHORIZED',
    ], 'fail')

    s.box(36, 978, 364, 390, 'Review engine — staging, review, apply', [
        '**Staging checks in order** (first failure denies the call with a code the agent retries on, ≤3 tries):',
        '1 one proposal at a time → ANOTHER_PROPOSAL_UNDER_REVIEW',
        '2 live text hash = baseHash → STALE_BASE; “new” only for absent files → FILE_EXISTS / FILE_NOT_FOUND; one baseHash per file',
        '3 oldText matches exactly once, line endings kept → OLD_TEXT_NOT_FOUND / AMBIGUOUS_MATCH',
        '4 net change → NO_CHANGE · 5 Tree-sitter check of new calls → MISSING_SYMBOL',
        '6 inline only: hunks outside the selection flagged red (still acceptable)',
        '**Review**: native diff per file, Accept / Reject CodeLens per hunk; each decision checkpointed',
        '**Apply**: same root · turn still paused on this approval · every file re-hashed (stale → reject all) · apply intent saved · one WorkspaceEdit + save · undo record · intent cleared',
        '**Undo / redo** per hunk via reverse patch; refused if the file changed there',
    ], 'review')

    s.box(420, 474, 364, 140, 'Per-run connector route', [
        'Each session gets **contexo-run-‹24 hex›** with its own 32-byte token at /mcp/‹connector›',
        'Agent manifest cloned with the editor connector swapped; the previous route is revoked and deleted',
        'Route saved in secret storage so a pending review can reattach after reload',
    ], 'mcp')

    s.box(420, 630, 364, 172, 'Editor MCP server', [
        '**127.0.0.1:8791** (contexo.mcpPort), stateless Streamable HTTP, POST only (else 405)',
        'X-Contexo-Token compared in constant time (401); unknown path 404',
        '**Tool guard**: route owns the active run · session not sealed · run streaming or awaiting review, else RUN_NOT_AUTHORIZED',
        '**Paths** workspace-relative; no absolute, “..” or .git',
    ], 'mcp')

    s.box(420, 818, 364, 240, 'Six editor tools', [
        '**search_workspace** · preloaded · ripgrep + symbol names, ≤30 hits',
        '**read_file** · preloaded · unsaved buffer first; returns hash = baseHash; 16,000 chars',
        '**assemble_context** · preloaded · budgeted packet (Figure 2)',
        '**list_symbols** · deferred · ≤200 symbols to verify names',
        '**propose_write** · preloaded · approval · stages hunks, never writes',
        '**run_command** · deferred · approval · allowlist python, pytest, flask; argv, no shell; no absolute or “..” args; scoped env + .venv; 120 s (max 180)',
    ], 'mcp')

    s.box(420, 1074, 364, 294, 'Context engine', [
        '**Index**: Tree-sitter Python symbols with calls, decorators, imports; .rst / .md heading sections; TS, JS, Go, Rust, Java via editor symbol providers',
        'Files from ripgrep honouring .gitignore (skips node_modules, .venv); 20-file chunks; re-index on save',
        '**Anchors** (selection, @file, @symbol) are mandatory',
        '**Five ranked lists**: corpus vectors, BM25 code, BM25 docs, symbol names, ripgrep',
        '**One-hop graph**: calls, callers, CLI registration, tests, docs',
        '**RRF k = 60** then budgeted packing (8,000 est. tokens) with reasons and an omission ledger',
        '**22,000-char** response guard under the runtime’s tool limit',
    ], 'ctx', tag='Figure 2')

    s.box(836, 300, 328, 158, 'Sessions, turns, events', [
        'model.message(.delta), tool.response, tool.approval_required → turn.update paused, turn.done',
        'Resume: subscribeToTurn(afterEventId) + user.tool_approval allow / deny',
        'Owns inference, turn state and tool dispatch',
    ], 'tf')

    s.box(836, 474, 328, 312, 'Agents: contexo · contexo-fallback', [
        '**Same instructions and tools**, different models (default primary inception/mercury-3)',
        'temperature 0.2 · iteration limit 40 · compaction on · dynamic sub-agents on',
        '**Preloaded**: search_workspace, read_file, assemble_context, propose_write',
        '**Deferred** (discovered via call_tool): list_symbols, run_command',
        '**Approval required**: propose_write, run_command → turn pauses',
        '**Instructions**: assemble_context first; never invent names; read_file before editing; respect rejected hunks',
    ], 'tf')

    s.box(836, 802, 328, 236, 'Setup and lifecycle', [
        'Ping; if down, localhost, Node ≥ 22.14 and autoStart → npx @truefoundry/trueforge --port, OUTBOUND_URL_ALLOWED_HOSTS=["127.0.0.1"], wait ≤120 s',
        'Already running → reused, never stopped. Exit: stop only if Contexo started it (default)',
        'Provider key sent once to TrueForge; never kept by Contexo',
        'Registers connector + both agents; reports each resource',
    ], 'tf')

    s.box(836, 1054, 328, 140, 'Models and resilience test', [
        '**Only TrueForge calls providers**; npm run check scans the bundle for provider SDKs and URLs',
        '**Simulate failure**: primary re-registered on contexo-broken → 127.0.0.1:9; fallback untouched; banner persists',
    ], 'tf')

    s.box(836, 1210, 328, 158, 'Session inspector (panel tabs)', [
        '**Session**: turns, status, timing, tokens, tool calls with server, deferred marker, args, results, approvals',
        '**Context**: excerpts, omissions, graph · **Changes**: hunks, undo',
    ], 'tf')

    s.label(20, 1408, '4 · PERSISTENCE, RECOVERY AND EVIDENCE', GREY)
    s.box(20, 1416, 373, 124, 'Workspace files', [
        '**Written only by** Apply, Undo / Redo and apply recovery, never by a tool call',
        'Read by read_file (open buffers first) and the indexer',
        'Inline edits refuse selections outside the active root',
    ], 'store')
    s.box(413, 1416, 374, 124, 'Workspace state and secret storage', [
        '**review.pending.v1**: run, proposal, decisions, turn id, root, TrueForge URL',
        '**review.apply.v1**: apply intent (accepted hunks, base hash and target per file)',
        '**Secrets**: MCP token, run route, CI credentials',
    ], 'store')
    s.box(807, 1416, 373, 124, 'Run journal (JSONL per run)', [
        'Mode 0600, fsync per record, sequence numbers; requests, sessions, states, tool events and outputs, proposals with base hashes, undo / redo, checks, requirement links, impact, imports, reconciliation',
    ], 'store')
    s.box(20, 1556, 373, 124, 'Recovery after reload', [
        '**Apply intent**: file at target → skip · at base → finish · otherwise pause',
        '**Pending review**: same root and TrueForge URL; turn still paused with exactly one matching approval; connector still points to this port',
    ], 'store')
    s.box(413, 1556, 374, 124, 'Candidate test before apply', [
        'Temp copy of tracked + untracked non-ignored files (no symlinks), accepted hunks only, bases re-hashed',
        'python -m pytest -q, copied src first on PYTHONPATH, 120 s; copy deleted; result journaled',
    ], 'store')
    s.box(807, 1556, 373, 124, 'External evidence and replay', [
        '**SARIF 2.1.0** matched to hunks by path, side, line and file SHA-256',
        '**Jenkins, GitHub PR, BuildKit**: HTTPS, no credentials in URL, ≤8 MiB, 15 s, digest check',
        '**Replay**: native, ACP, OTLP, ≤16 MiB, read-only',
    ], 'store')

    s.box(20, 1696, 1160, 150, 'Request lifecycle', [
        '① Request enters: inline template or agent text + hint',
        '② Session created with a per-run connector; turn streams; 20 s timer armed',
        '③ Model calls editor tools over loopback MCP; every call checked against route and Stop',
        '④ assemble_context returns the packet; search, read and list fill gaps',
        '⑤ propose_write / run_command pause the turn (approval_required)',
        '⑥ Review engine stages hunks, or denies with a retryable code',
        '⑦ The tool call waits while hunks are accepted, rejected or tested',
        '⑧ user.tool_approval resumes the turn from the last event id',
        '⑨ Apply is the only workspace writer; failure before an approved write → fallback replays ① once',
    ], 'band', cols=3)

    # arrows
    for x in (270, 330):
        s.arrow([(x, 255), (x, 300)], NAVY)
        s.badge(x + 16, 278, '①', NAVY)
    s.arrow([(810, 255), (810, 312), (836, 312)], NAVY)
    s.arrow([(784, 340), (836, 340)], NAVY)
    s.badge(810, 328, '②', NAVY)
    s.arrow([(836, 378), (784, 378)], VIOLET)
    s.badge(810, 366, '⑤', VIOLET)
    s.arrow([(784, 422), (836, 422)], AMBER)
    s.badge(810, 410, '⑧', AMBER)
    s.arrow([(836, 716), (784, 716)], VIOLET)
    s.badge(810, 704, '③', VIOLET)
    s.arrow([(602, 1058), (602, 1074)], GREEN)
    s.badge(624, 1066, '④', GREEN)
    s.arrow([(36, 440), (27, 440), (27, 1030), (36, 1030)], AMBER)
    s.badge(27, 940, '⑥', AMBER)
    s.arrow([(420, 1010), (400, 1010)], AMBER, both=True)
    s.badge(410, 992, '⑦', AMBER)
    s.arrow([(360, 1368), (360, 1416)], AMBER, width_=2.4)
    s.badge(376, 1392, '⑨', AMBER)
    s.label(390, 1396, 'only writer', AMBER, 10.5, True, spacing=0)
    s.arrow([(400, 540), (418, 540)], RED, dashed=True)
    s.arrow([(600, 1368), (600, 1416)], GREY, dashed=True)
    s.arrow([(990, 1368), (990, 1416)], GREY, dashed=True)
    return s.render()


def pipeline() -> str:
    s = Svg(1200, 845)
    s.add(f'<text x="20" y="44" font-family="{SERIF}" font-size="31" fill="{NAVY}">How assemble_context builds a context packet</text>')
    s.label(20, 66, 'Deterministic and local: no model call, no embedding service. Every excerpt carries the reasons that selected it.',
            '#41566b', 12.5, False, spacing=0)
    W, X = 370, (20, 415, 810)
    rows = (88, 333, 588)
    H = (215, 225, 240)

    s.box(X[0], rows[0], W, H[0], '0 · Index', [
        '**Python** via Tree-sitter: functions, classes, methods, tests, with calls, decorators and imports (≤6,000 chars each)',
        '**Docs**: .rst and .md split into heading sections',
        '**TS, JS, Go, Rust, Java** through the editor’s symbol providers',
        'File list from ripgrep, honouring .gitignore; node_modules and .venv skipped; 20-file chunks; re-indexed on save',
        'search_workspace works before the index is ready',
    ], 'ctx')
    s.box(X[1], rows[0], W, H[0], '1 · Anchors (mandatory, packed first)', [
        '**Selection** → its smallest enclosing symbol, or the raw lines',
        '**@path** → the file’s top-level symbols if they fit in 30 % of the budget, else the 3 that best match the request terms',
        '**@name** → symbols with that name; code beats docs; an ambiguous name gets half weight',
        'A symbol anchored twice becomes one excerpt with merged reasons',
    ], 'run')
    s.box(X[2], rows[0], W, H[0], '2 · Query terms', [
        '**Weights**: quoted text and “flask X” ×4 · CONSTANTS and snake_ / camelCase ×3 · plain words ×1 · synonyms ×0.5',
        'Stopwords and request filler removed (implement, ensure, prints …); at most 30 terms',
        '**Synonyms**: command → click, add_command, cli · docs → rst · tests → test_',
        '**Non-discriminating terms** found in more than 30 % of code symbols are dropped (for example “flask” inside Flask)',
    ], 'run')

    s.box(X[0], rows[1], W, H[1], '3 · Five ranked lists (≤30 each)', [
        '**Corpus vectors ×0.35**: TF-IDF centroid of symbols containing each rare term; neighbours with cosine > 0.12. Finds related code without shared words',
        '**BM25 code ×1**: k1 1.2, b 0.75; name counted twice, plus path, decorators, body',
        '**BM25 docs ×1**',
        '**Symbol name ×1**: exact, or prefix for terms ≥5 chars',
        '**Ripgrep ×1**: ≤4 terms present in ≤8 % of symbols; hits mapped to the enclosing symbol',
    ], 'ctx')
    s.box(X[1], rows[1], W, H[1], '4 · First fusion and one-hop expansion', [
        '**RRF** over the five lists → top 10 implementation symbols (tests and docs excluded as seeds)',
        '**calls ×0.5**: only unambiguous targets',
        '**called-by ×0.5**: only when ≤5 callers',
        '**registers ×0.8**: CLI-decorated siblings, add_command(…) sites',
        '**tests ×0.5**: tests naming a distinctive symbol (≤3), term-matching tests in test_‹module›.py (≤3)',
        '**documents ×0.5**: doc sections naming the symbol or its CLI name (≤3)',
    ], 'ctx')
    s.box(X[2], rows[1], W, H[1], '5 · Final fusion', [
        '**score = Σ weight ÷ (60 + rank)** over primary and expansion lists',
        'A candidate found by several lists climbs; reasons from every list are merged',
        'No calibration between BM25, cosine and graph scores is needed',
        'Inferred lists (vectors, graph) carry lower weights, so they add recall without outranking direct evidence',
    ], 'ctx')

    s.box(X[0], rows[2], W, H[2], '6 · Packing (8,000 est. tokens)', [
        '1 Mandatory anchors',
        '2 Coverage quota: best test and best doc candidate from the whole list',
        '3 Greedy by score ÷ tokens over the top 40 scoring ≥50 % of the best; token floor 400',
        '• ≥3 excerpts already from a file → score halved',
        '• Overlap → omitted as duplicate',
        '• >30 % of budget → trimmed to decorators, signature, docstring, term lines',
        '• No room → over-budget · below the cut → lower-rank (15 listed)',
    ], 'review')
    s.box(X[1], rows[2], W, H[2], '7 · Serialised for the model', [
        'Header: request and “used / budget tokens (≈ estimated)”',
        'Each excerpt: path:lines · category · reasons · ≈tokens, then code',
        '**## Omitted** with reason and size',
        '**22,000-char guard** counts JSON escaping, under the runtime’s 24,000-char tool limit; overflow says “use read_file”',
        'Token counts: cl100k estimate cached by content hash; the agent may request 500–32,000',
    ], 'mcp')
    s.box(X[2], rows[2], W, H[2], '8 · Outputs and feedback loop', [
        '**Agent**: reads the packet, then read_file for exact text and hash before propose_write',
        '**Gaps**: re-call assemble_context with new anchors, or search_workspace / list_symbols',
        '**Context tab**: excerpts, omissions, graph request → term → file → symbol (inferred edges flagged)',
        '**Runtime**: TrueForge compaction summarises long turns; deferred tools stay out of the prompt until needed',
    ], 'tf')

    for r, h in zip(rows, H):
        mid = r + h / 2
        s.arrow([(X[0] + W, mid), (X[1], mid)], GREEN)
        s.arrow([(X[1] + W, mid), (X[2], mid)], GREEN)
    for top, h, nxt in ((rows[0], H[0], rows[1]), (rows[1], H[1], rows[2])):
        y = top + h + (nxt - top - h) / 2
        s.arrow([(X[2] + W / 2, top + h), (X[2] + W / 2, y), (X[0] + W / 2, y), (X[0] + W / 2, nxt)], GREEN)
    return s.render()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'contexo-architecture.svg').write_text(architecture(), encoding='utf-8')
    (OUT / 'context-pipeline.svg').write_text(pipeline(), encoding='utf-8')
    if OVERFLOWS:
        raise SystemExit('\n'.join(OVERFLOWS))
    print('wrote', OUT)


if __name__ == '__main__':
    main()
