#!/usr/bin/env node
// H4 — PostToolUse on Bash matching "git push*".
// Polls https://chongthekuli.github.io/RoomLab/ up to 5x (30s) until live v= ≥ local.
// Runs async so it doesn't block the model.

const fs = require('fs');
const https = require('https');

function out(systemMessage) {
  if (systemMessage) process.stdout.write(JSON.stringify({ systemMessage }));
  process.exit(0);
}

function fetch(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
  });
}

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', async () => {
  let parsed;
  try { parsed = JSON.parse(input); } catch (_) { return out(); }
  const cmd = (parsed.tool_input || {}).command || '';
  if (!/^\s*git\s+push\b/.test(cmd)) return out();
  // Only poll for pushes to main (origin main, or no remote = current branch which is main here).
  if (!/origin\s+main\b/.test(cmd) && !/^\s*git\s+push\s*$/.test(cmd)) return out();

  let localV = null;
  try {
    const local = fs.readFileSync('index.html', 'utf8');
    const m = local.match(/v=(\d+)/);
    if (m) localV = parseInt(m[1], 10);
  } catch (_) { return out(); }
  if (localV === null) return out();

  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 6000));
    try {
      const body = await fetch(`https://chongthekuli.github.io/RoomLab/index.html?cb=${Date.now()}`);
      const m = body.match(/v=(\d+)/);
      if (m && parseInt(m[1], 10) >= localV) {
        return out(`[deploy poll] live v=${m[1]} (≥ local v=${localV}) after ${(i+1)*6}s.`);
      }
    } catch (_) { /* keep polling */ }
  }
  out(`[deploy poll] live URL still not at v=${localV} after 30s — check https://github.com/chongthekuli/RoomLab/actions for the Pages build.`);
});
