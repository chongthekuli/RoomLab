#!/usr/bin/env node
// H3 — Stop hook. Nudges (non-blocking) when uncommitted changes touch
// js/css/html but ?v= in index.html is unchanged vs HEAD.

const { execSync } = require('child_process');
const fs = require('fs');

function out(systemMessage) {
  if (systemMessage) process.stdout.write(JSON.stringify({ systemMessage }));
  process.exit(0);
}

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  let changed = '';
  try { changed = execSync('git diff --name-only HEAD', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }); } catch (_) { return out(); }
  const files = changed.split(/\r?\n/).filter(Boolean);
  const relevant = files.filter(f => f.startsWith('js/') || f.startsWith('css/') || f === 'index.html');
  if (relevant.length === 0) return out();

  let workingV = null, headV = null;
  try {
    const w = fs.readFileSync('index.html', 'utf8');
    const m = w.match(/v=(\d+)/);
    if (m) workingV = parseInt(m[1], 10);
  } catch (_) { return out(); }
  try {
    const h = execSync('git show HEAD:index.html', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    const m = h.match(/v=(\d+)/);
    if (m) headV = parseInt(m[1], 10);
  } catch (_) { /* first commit */ }

  if (workingV !== null && headV !== null && workingV === headV) {
    out(`[cache nudge] ${relevant.length} file(s) modified under js/css/html — bump ?v= in index.html (currently ${workingV}) before committing.`);
  } else {
    out();
  }
});
