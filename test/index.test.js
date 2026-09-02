// Directory entry: `node --test test/` runs this file; it pulls in every *.test.js.
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(process.argv[1] ?? '');
let isDirEntry = false;
try { isDirEntry = statSync(entry).isDirectory(); } catch {}
if (isDirEntry) {
  for (const f of readdirSync(here).sort()) {
    if (f.endsWith('.test.js') && f !== 'index.test.js') await import('./' + f);
  }
}
