#!/usr/bin/env node
// H5 — PreToolUse on Bash matching "git commit*".
// Reminds (non-blocking) if commit message looks like a bug fix but no tests/* file is staged.
// Per Theo (regression-curator) / CLAUDE.md §3 — same-PR regression-test rule.

const { execSync } = require('child_process');

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

  // Extract -m argument (quoted) and any HEREDOC body that follows.
  let msg = '';
  const mFlag = cmd.match(/-m\s+(?:"([^"]*)"|'([^']*)'|(\S+))/);
  if (mFlag) msg = mFlag[1] || mFlag[2] || mFlag[3] || '';
  const hd = cmd.match(/<<\s*'?EOF'?\s*\n([\s\S]*?)\n\s*EOF/);
  if (hd) msg += ' ' + hd[1];

  if (!msg || !/\b(fix(?:es|ed)?|regression|revert(?:s|ed)?|broken|hotfix)\b/i.test(msg)) return out();

  let staged = '';
  try { staged = execSync('git diff --cached --name-only', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }); } catch (_) { return out(); }
  const hasTest = staged.split(/\r?\n/).some(f => f.startsWith('tests/'));
  if (hasTest) return out();

  out(
    `[same-PR regression test reminder] Commit message looks like a bug fix but no file under tests/ is staged. ` +
    `Per Theo (CLAUDE.md §3): every fix lands with a regression test in the same commit. ` +
    `Either add a test, or document the gap explicitly in REGRESSION_INDEX.md as UNGUARDED.`
  );
});
