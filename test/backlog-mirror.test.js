// docs/backlog-view.html is a mirror of docs/BACKLOG.md, written in the same commit. The markdown
// is the source of truth (its own header says so). This fails the suite -- and therefore the deploy,
// which runs `node --test test/` first -- whenever the two drift: a row in one and not the other, a
// different order, a row that is not five cells, or a cell whose text differs.
//
// "Differs" is judged after the view's house style is undone: the view has no backticks and uses
// curly quotes where the markdown uses straight ones. Anything beyond that is drift.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const md = readFileSync(join(root, 'docs', 'BACKLOG.md'), 'utf8');
const html = readFileSync(join(root, 'docs', 'backlog-view.html'), 'utf8');

// Every `| Bn | item | source | status | notes |` line, tagged with the `## section` above it.
function markdownRows() {
  const rows = [];
  let section = null;
  for (const line of md.split('\n')) {
    const head = line.match(/^## (.+)$/);
    if (head) { section = head[1].trim(); continue; }
    if (!/^\| B\d+ \|/.test(line)) continue;
    const cells = line.split('|');
    assert.equal(cells[0], '', `${line.slice(0, 12)}: a row starts with a pipe`);
    assert.equal(cells[cells.length - 1], '', `${line.slice(0, 12)}: a row ends with a pipe`);
    assert.equal(cells.length, 7, `${line.slice(0, 12)}: a row is exactly five cells (a bare | inside a cell splits it)`);
    rows.push({ section, cells: cells.slice(1, -1).map((c) => c.trim()) });
  }
  return rows;
}

// The view keeps its rows in `const ROWS = [ [section, [[id, item, source, status, notes], ...]], ... ];`
function viewRows() {
  const start = html.indexOf('const ROWS = [');
  assert.ok(start >= 0, 'the view has a ROWS literal');
  const end = html.indexOf('\n];', start);
  assert.ok(end > start, 'the ROWS literal closes with a line that is just ];');
  const literal = html.slice(start + 'const ROWS = '.length, end + 2);
  const ROWS = new Function(`return (${literal});`)();   // the literal is plain data, no code
  const rows = [];
  for (const [section, list] of ROWS) for (const cells of list) rows.push({ section, cells });
  return rows;
}

// The view's house style, undone: no backticks, straight quotes.
const plain = (t) => String(t).replace(/`/g, '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

test('backlog: the view mirrors the markdown row for row, in the same order', () => {
  const a = markdownRows();
  const b = viewRows();
  assert.deepEqual(b.map((r) => r.cells[0]), a.map((r) => r.cells[0]),
    'same ids in the same order (the markdown is the source of truth)');
  for (let i = 0; i < a.length; i++) {
    const m = a[i], v = b[i];
    assert.equal(v.cells.length, 5, `${m.cells[0]}: five cells in the view`);
    assert.equal(v.section, m.section, `${m.cells[0]}: same section`);
    for (let c = 0; c < 5; c++) {
      assert.equal(plain(v.cells[c]), plain(m.cells[c]), `${m.cells[0]}: cell ${c} differs between markdown and view`);
    }
  }
});

test('backlog: ids are unique and the status vocabulary is the documented one', () => {
  const rows = markdownRows();
  const ids = rows.map((r) => r.cells[0]);
  assert.equal(new Set(ids).size, ids.length, 'no id appears twice');
  for (const r of rows) {
    assert.match(r.cells[3], /^(proposed|approved|parked|rejected( \d{4}-\d{2}-\d{2})?|shipped \(v\d+\.\d+\.\d+\))$/,
      `${r.cells[0]}: status "${r.cells[3]}" is not in the file's own vocabulary`);
  }
});
