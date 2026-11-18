import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = join(dirname(fileURLToPath(import.meta.url)), '../src');
const files: string[] = [];
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.ts')) files.push(p);
  }
})(src);

test('every shared module imports in plain Node (no DOM, no bundler)', async () => {
  assert.equal(typeof document, 'undefined');
  assert.equal(typeof window, 'undefined');
  for (const f of files) await import(f);
  assert.ok(files.length >= 15, `expected many modules, found ${files.length}`);
});

test('shared source has no DOM globals, no node: imports, no wall clocks, no Math.random', () => {
  // render(ctx) methods take the canvas context as a PARAMETER; that is fine. Globals are not.
  const banned = [/\bdocument\./, /\bwindow\./, /\blocalStorage\b/, /from 'node:/, /\brequire\(/, /\bprocess\./, /Date\.now\(/, /performance\.now\(/, /Math\.random\(/];
  const offenders: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8').split('\n');
    text.forEach((line, i) => {
      if (/^\s*(\*|\/\*)/.test(line)) return; // block comments
      const code = line.replace(/\/\/.*$/, '').replace(/'[^']*'/g, "''"); // ignore comments and string literals
      for (const re of banned) if (re.test(code)) offenders.push(`${f.slice(src.length)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});
