const byId = id => document.getElementById(id);
const input = byId('review-input');
const status = byId('status');
let review;
let events = [];
let cursor = 0;

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}

const editor = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
const pendingRequests = new Map();
let nextRequest = 0;
if (editor) window.addEventListener('message', ({ data }) => {
  const waiting = pendingRequests.get(data?.id);
  if (!waiting) return;
  pendingRequests.delete(data.id);
  if (data.error) waiting.reject(new Error(data.error));
  else waiting.resolve(data.result);
});

async function request(path, body) {
  if (editor) return new Promise((resolve, reject) => {
    const id = ++nextRequest;
    pendingRequests.set(id, { resolve, reject });
    editor.postMessage({ id, path, body });
  });
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

function renderCodePane(hunk, side) {
  const before = side === 'base';
  const pane = element('div', undefined, 'code-pane');
  const bar = element('div', undefined, 'code-pane-bar');
  const copy = element('button', 'Copy', 'copy-code');
  copy.setAttribute('aria-label', before ? 'Copy before code' : 'Copy proposed code');
  bar.append(element('span', before ? 'Before' : 'Proposed'), copy);
  const text = element('div', undefined, 'code-lines');
  text.tabIndex = 0;
  text.setAttribute('role', 'region');
  text.setAttribute('aria-label', before ? 'Before code' : 'Proposed code');
  const omit = before ? '+' : '-';
  const lines = hunk.lines.filter(line => !line.startsWith(omit) && !line.startsWith('\\'));
  let number = before ? hunk.oldStart : hunk.newStart;
  for (const line of lines) {
    const prefix = line[0];
    const row = element('div', undefined, 'code-line' + (prefix === '+' ? ' added' : prefix === '-' ? ' removed' : ''));
    const gutter = element('span', String(number++), 'line-number');
    gutter.setAttribute('aria-hidden', 'true');
    row.append(gutter, element('code', line.slice(1) || ' '));
    text.append(row);
  }
  if (!lines.length) text.append(element('p', 'No lines on this side.', 'code-empty'));
  let feedbackTimer;
  copy.disabled = !lines.length;
  copy.onclick = async () => {
    clearTimeout(feedbackTimer);
    try {
      await navigator.clipboard.writeText(lines.map(line => line.slice(1)).join('\n'));
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Copy failed';
    }
    feedbackTimer = setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
  };
  pane.append(bar, text);
  return pane;
}

async function analyze() {
  const current = input.value;
  const result = await request('/api/review', editor ? undefined : JSON.parse(current));
  if (input.value !== current) return;
  review = result;
  byId('save-review').disabled = false;
  byId('requirement').querySelector('button').disabled = !review.hunks.length;
  status.textContent = 'Candidate ' + review.candidateDigest.slice(0, 12) + ' · ' + review.hunks.length + (review.hunks.length === 1 ? ' hunk' : ' hunks');
  status.title = review.candidateDigest;
  const diff = byId('diff');
  diff.replaceChildren();
  for (const hunk of review.hunks) {
    const card = element('article', undefined, 'hunk-card');
    const heading = element('div', undefined, 'hunk-heading');
    const file = element('div', undefined, 'hunk-file');
    file.append(element('strong', hunk.path), element('span', 'Lines ' + hunk.newStart + '–' + Math.max(hunk.newStart, hunk.newStart + hunk.newLines - 1)));
    heading.append(file, element('span', hunk.decision === 'pending' ? 'Pending' : hunk.decision === 'accepted' ? 'Accepted' : 'Rejected', 'decision ' + hunk.decision));
    const panes = element('div', undefined, 'code-panes');
    panes.append(renderCodePane(hunk, 'base'), renderCodePane(hunk, 'proposed'));

    const actions = element('div', undefined, 'hunk-actions');
    const selection = element('input');
    selection.type = 'checkbox';
    selection.dataset.hunk = hunk.id;
    const label = element('label', ' Link to requirement', 'link-hunk');
    label.prepend(selection);
    const choices = element('div', undefined, 'decision-actions');
    for (const [decision, title] of [['accepted', 'Accept hunk'], ['rejected', 'Reject hunk']]) {
      const button = element('button', title, decision === 'accepted' ? 'accept-action' : 'reject-action');
      button.setAttribute('aria-pressed', String(hunk.decision === decision));
      button.addEventListener('click', () => perform(status, async () => {
        if (hunk.decision === decision) return;
        if (editor) {
          await request('/api/decision', { key: review.proposalKey, id: hunk.id, decision });
          return analyze();
        }
        const value = JSON.parse(input.value);
        const rejected = new Set(value.rejected ?? []);
        if (decision === 'rejected') rejected.add(hunk.id);
        else rejected.delete(hunk.id);
        value.rejected = [...rejected];
        input.value = JSON.stringify(value, null, 2);
        await analyze();
      }));
      choices.append(button);
    }
    actions.append(label, choices);
    card.append(heading, panes, actions);
    diff.append(card);
  }
  if (!review.hunks.length) diff.append(element('p', 'No changes.'));
  const graph = byId('graph');
  graph.replaceChildren();
  byId('scope').textContent = review.impact.analysis +
    (review.impact.omitted.length ? '. Omitted: ' + review.impact.omitted.join(', ') : '');
  for (const [label, edges] of [['added', review.impact.added], ['removed', review.impact.removed]]) {
    for (const edge of edges) {
      const row = element('div', undefined, 'edge ' + label);
      row.append(element('span', edge.symbol), element('span', label + ' ' + edge.kind + ' →'), element('span', edge.target + (edge.definition ? ' · ' + edge.definition.path + ':' + edge.definition.line : '')));
      graph.append(row);
    }
  }
  if (!graph.children.length) graph.append(element('p', 'No dependency changes found.'));
  byId('checks').replaceChildren(
    ...review.checks.map(check => element('p', [check.name, check.source, check.status, check.match].join(' · '))),
    ...review.findings.map(finding => element('p', finding.name + ' · ' + finding.match +
      (finding.hunkIds.length ? ' · ' + finding.hunkIds.join(', ') : ''))),
  );
  byId('requirements').replaceChildren(
    ...review.requirements.map(requirement => element('p', requirement.text + ' · ' + requirement.hunkIds.join(', '))),
  );
}

async function perform(target, fn) {
  try {
    await fn();
  } catch (error) {
    target.textContent = error.message;
  }
}

byId('example').onclick = () => perform(status, async () => {
  input.value = JSON.stringify(await request('/api/example'), null, 2);
  await analyze();
});
byId('analyze').onclick = () => perform(status, analyze);
byId('review-file').onchange = event => perform(status, async () => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) throw new Error('File exceeds 4 MiB.');
  input.value = await file.text();
  await analyze();
});
byId('requirement').onsubmit = event => {
  event.preventDefault();
  void perform(status, async () => {
    const hunkIds = [...document.querySelectorAll('[data-hunk]:checked')].map(node => node.dataset.hunk);
    if (!hunkIds.length) throw new Error('Select at least one hunk.');
    const value = editor ? {} : JSON.parse(input.value);
    const text = byId('requirement-text').value.trim();
    if (!text) return;
    if (editor) {
      await request('/api/requirement', { key: review.proposalKey, text, hunkIds });
      byId('requirement-text').value = '';
      return analyze();
    }
    value.requirements = [...(value.requirements ?? []), { text, hunkIds }];
    input.value = JSON.stringify(value, null, 2);
    await analyze();
    byId('requirement-text').value = '';
  });
};
function showEvent() {
  byId('replay-status').textContent = events.length ? 'Event ' + (cursor + 1) + ' of ' + events.length : 'No events.';
  byId('event').textContent = events[cursor] ? JSON.stringify(events[cursor], null, 2) : '';
  byId('prev').disabled = cursor === 0;
  byId('next').disabled = cursor + 1 >= events.length;
}
byId('replay-file').onchange = event => perform(byId('replay-status'), async () => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) throw new Error('Replay file exceeds 3 MiB.');
  ({ records: events } = await request('/api/replay', { format: byId('format').value, text: await file.text() }));
  cursor = 0;
  showEvent();
});
byId('prev').onclick = () => { if (cursor > 0) cursor--; showEvent(); };
byId('next').onclick = () => { if (cursor + 1 < events.length) cursor++; showEvent(); };

byId('save-review').onclick = () => perform(status, async () => {
  const data = JSON.stringify(JSON.parse(input.value), null, 2);
  await request('/api/review', JSON.parse(data));
  const href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  const link = element('a');
  link.href = href;
  link.download = 'contexo-review.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
});

const laneColors = ['#49a2ff', '#28d4ad', '#f9b94a', '#bb99ff', '#ff879a', '#71dbed'];
const rowHeight = 57;
const laneWidth = 15;

function layoutCommits(commits) {
  let lanes = [];
  let nextColor = 0;
  const rows = [];
  const edges = [];
  let columns = 1;
  for (const [row, commit] of commits.entries()) {
    let lane = lanes.findIndex(entry => entry?.id === commit.id);
    if (lane < 0) {
      lane = lanes.indexOf(null);
      if (lane < 0) lane = lanes.length;
      lanes[lane] = { id: commit.id, color: nextColor++ };
    }
    const current = lanes[lane];
    rows.push({ lane, color: current.color, commit });
    const next = [...lanes];
    next[lane] = null;
    for (const [index, parent] of commit.parents.entries()) {
      let target = next.findIndex(entry => entry?.id === parent);
      if (target < 0) {
        target = index === 0 ? lane : next.indexOf(null);
        if (target < 0) target = next.length;
        next[target] = { id: parent, color: index === 0 ? current.color : nextColor++ };
      }
      edges.push({ row, from: lane, to: target, color: next[target].color });
    }
    for (const [index, entry] of lanes.entries()) {
      if (entry && index !== lane) edges.push({ row, from: index, to: index, color: entry.color });
    }
    columns = Math.max(columns, lanes.length, next.length);
    while (next.length && next.at(-1) === null) next.pop();
    lanes = next;
  }
  return { rows, edges, columns };
}

function svgElement(tag, attributes) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

async function loadHistory() {
  const status = byId('history-status');
  const refresh = byId('refresh-history');
  refresh.disabled = true;
  status.textContent = 'Loading Git history…';
  try {
    const { commits, truncated } = await request('/api/commits');
    const workspace = byId('history-workspace');
    workspace.hidden = !commits.length;
    status.textContent = commits.length
      ? (truncated ? 'Latest ' : '') + commits.length + ' ' + (commits.length === 1 ? 'commit' : 'commits') + ' · Local and remote refs'
      : 'This checkout has no commits.';
    if (!commits.length) return;
    const { rows, edges, columns } = layoutCommits(commits);
    const height = rows.length * rowHeight;
    const width = columns * laneWidth + 17;
    const svg = svgElement('svg', { width, height, viewBox: '0 0 ' + width + ' ' + height });
    const x = lane => 16 + lane * laneWidth;
    const y = row => row * rowHeight + rowHeight / 2;
    const color = index => laneColors[index % laneColors.length];
    for (const edge of edges) {
      const bottom = Math.min(height, y(edge.row + 1));
      const middle = (y(edge.row) + bottom) / 2;
      svg.append(svgElement('path', {
        d: 'M ' + x(edge.from) + ' ' + y(edge.row) + ' C ' + x(edge.from) + ' ' + middle + ', ' +
          x(edge.to) + ' ' + middle + ', ' + x(edge.to) + ' ' + bottom,
        stroke: color(edge.color), 'stroke-width': 2, 'stroke-opacity': .83, fill: 'none',
      }));
    }
    const list = byId('commit-list');
    list.replaceChildren();
    const detail = byId('commit-detail');
    function select(index, scroll = false) {
      const { commit } = rows[index];
      [...list.children].forEach((button, position) => button.setAttribute('aria-pressed', position === index ? 'true' : 'false'));
      for (const [position, dot] of dots.entries()) {
        dot.setAttribute('r', position === index ? '5.5' : '4');
        dot.setAttribute('stroke', position === index ? '#e8faff' : '#102a37');
      }
      detail.replaceChildren(element('p', 'Selected commit', 'commit-caption'),
        element('h3', commit.subject || '(No subject)'),
        element('code', commit.id, 'full-commit-id'),
        element('p', commit.author + ' · ' + new Date(commit.date).toLocaleString(), 'commit-byline'));
      if (commit.parents.length) detail.append(element('p', 'Parents ' + commit.parents.map(id => id.slice(0, 8)).join(' · '), 'commit-byline'));
      if (commit.body.trim()) detail.append(element('pre', commit.body.trim()));
      if (scroll) list.children[index].focus();
    }
    const dots = rows.map(({ lane, color: index }, row) => {
      const dot = svgElement('circle', { cx: x(lane), cy: y(row), r: 4, fill: color(index), 'stroke-width': 1.5 });
      svg.append(dot);
      return dot;
    });
    for (const [index, { commit }] of rows.entries()) {
      const button = element('button', undefined, 'commit-row');
      const label = element('span', undefined, 'commit-label');
      label.append(element('span', commit.subject || '(No subject)', 'commit-subject'));
      if (commit.refs.length) {
        const refs = element('span', undefined, 'commit-refs');
        for (const ref of commit.refs) refs.append(element('span', ref, 'commit-ref'));
        label.append(refs);
      }
      button.append(label, element('code', commit.shortId));
      button.title = commit.author + ' · ' + new Date(commit.date).toLocaleString();
      button.onclick = () => select(index);
      button.onkeydown = event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        const next = index + (event.key === 'ArrowDown' ? 1 : -1);
        if (next < 0 || next >= rows.length) return;
        event.preventDefault();
        select(next, true);
      };
      list.append(button);
    }
    byId('commit-lanes').replaceChildren(svg);
    select(0);
  } finally {
    refresh.disabled = false;
  }
}

byId('refresh-history').onclick = () => perform(byId('history-status'), loadHistory);
void perform(byId('history-status'), loadHistory);

if (editor) {
  byId('review-file').parentElement.hidden = true;
  byId('input-panel').hidden = true;
  byId('example').textContent = 'Refresh active review';
  byId('example').onclick = () => perform(status, analyze);
  const apply = byId('save-review');
  apply.textContent = 'Apply accepted hunks';
  apply.onclick = () => perform(status, async () => {
    const result = await request('/api/apply', review.proposalKey);
    status.textContent = 'Proposal ' + result.status;
    apply.disabled = true;
    byId('diff').querySelectorAll('button, input').forEach(el => { el.disabled = true; });
  });
  const replay = element('button', 'Load active run');
  replay.onclick = () => perform(byId('replay-status'), async () => {
    ({ records: events } = await request('/api/current-replay'));
    cursor = 0;
    showEvent();
  });
  document.querySelector('.replay-actions').prepend(replay);
  void perform(status, analyze);
}
