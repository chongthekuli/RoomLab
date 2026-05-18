#!/usr/bin/env node
// H1 — PreToolUse on Bash matching "git commit*".
// Warns (non-blocking) if js/css/index.html are staged but ?v= integer didn't bump vs origin/main.

const { execSync } = require('child_process');
const fs = require('fs');

function out(systemMessage) {
  if (systemMessage) process.stdout.write(JSON.stringify({ systemMessage }));
  process.exit(0);
}

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  let cmd = '';
  try { cmd = (JSON.parse(input).tool_input || {}).command || ''; } catch (_) {}
  if (!/^\s*git\s+commit\b/.test(cmd)) return out();

  let staged = '';
  try { staged = execSync('git diff --cached --name-only', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }); } catch (_) { return out(); }
  const files = staged.split(/\r?\n/).filter(Boolean);
  const relevant = files.filter(f => f.startsWith('js/') || f.startsWith('css/') || f === 'index.html');
  if (relevant.length === 0) return out();

  let localV = null, originV = null;
  try {
    const local = fs.readFileSync('index.html', 'utf8');
    const m = local.match(/v=(\d+)/);
    if (m) localV = parseInt(m[1], 10);
  } catch (_) { return out(); }
  try {
    const origin = execSync('git show origin/main:index.html', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    const m = origin.match(/v=(\d+)/);
    if (m) originV = parseInt(m[1], 10);
  } catch (_) { /* origin/main may not exist locally */ }

  if (localV !== null && originV !== null && localV <= originV) {
    return out(
      `[cache-bump guard] js/css/html staged but ?v= in index.html is still ${localV} (origin/main is ${originV}). ` +
      `Bump the integer before committing or browsers will serve stale modules.`
    );
  }
  out();
});
