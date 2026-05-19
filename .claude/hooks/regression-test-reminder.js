#!/usr/bin/env node
// H5 — PreToolUse on Bash matching "git commit*".
// BLOCKING (permissionDecision: ask) if commit message looks like a bug fix but no tests/* file is staged.
// Per Theo (regression-curator) / CLAUDE.md §3 — same-PR regression-test rule.
// Promoted from advisory → blocking 2026-05-19 (Hannes audit action #3).
// Silent allow on non-matching commits; only interrupts when a fix-keyword + no test is detected.

const { execSync } = require('child_process');

function ask(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    }
  }));
  process.exit(0);
}
function allow() { process.exit(0); }

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  let cmd = '';
  try { cmd = (JSON.parse(input).tool_input || {}).command || ''; } catch (_) {}
  if (!/^\s*git\s+commit\b/.test(cmd)) return allow();

  // Extract -m argument (quoted) and any HEREDOC body that follows.
  let msg = '';
  const mFlag = cmd.match(/-m\s+(?:"([^"]*)"|'([^']*)'|(\S+))/);
  if (mFlag) msg = mFlag[1] || mFlag[2] || mFlag[3] || '';
  const hd = cmd.match(/<<\s*'?EOF'?\s*\n([\s\S]*?)\n\s*EOF/);
  if (hd) msg += ' ' + hd[1];

  if (!msg || !/\b(fix(?:es|ed)?|regression|revert(?:s|ed)?|broken|hotfix)\b/i.test(msg)) return allow();

  let staged = '';
  try { staged = execSync('git diff --cached --name-only', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }); } catch (_) { return allow(); }
  const hasTest = staged.split(/\r?\n/).some(f => f.startsWith('tests/'));
  if (hasTest) return allow();

  ask(
    `Same-PR regression-test rule (CLAUDE.md §3, Theo / regression-curator).\n` +
    `Commit message looks like a bug fix (matched: fix|regression|revert|broken|hotfix) but NO file under tests/ is staged.\n` +
    `Every fix must land with a regression test in the SAME commit. Compliance is ~12% (May 2026) — actively underwater.\n` +
    `\n` +
    `Options:\n` +
    `  1. Add a regression test that would have failed BEFORE this fix, stage it, retry the commit.\n` +
    `  2. If the fix is genuinely untestable (e.g. pure CSS, docs, deploy plumbing), approve this prompt and ` +
    `append an UNGUARDED row to docs/REGRESSION_INDEX.md naming the gap + reason.\n` +
    `\n` +
    `Approve only if you've consciously accepted option 2. "I'll add the test next sprint" is how the bug came back the second time.`
  );
});
