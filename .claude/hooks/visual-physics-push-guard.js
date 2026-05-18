#!/usr/bin/env node
// H2 — PreToolUse on Bash matching "git push*".
// Prompts (permissionDecision: ask) if HEAD touched visual-physics paths.
// Per feedback_visual_physics_local_first — confirm user said "push it" first.

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
  if (!/^\s*git\s+push\b/.test(cmd)) return allow();

  let files = '';
  try { files = execSync('git diff-tree --no-commit-id --name-only -r HEAD', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }); } catch (_) { return allow(); }
  const changed = files.split(/\r?\n/).filter(Boolean);
  const hits = changed.filter(f =>
    f.startsWith('js/graphics/') ||
    f.startsWith('js/physics/precision/') ||
    f.startsWith('js/audio/') ||
    f === 'js/ui/print-heatmap.js' ||
    f === 'js/ui/print-plan-svg.js' ||
    f.includes('heatmap-shader')
  );
  if (hits.length === 0) return allow();

  ask(
    `Visual-physics push guard (feedback_visual_physics_local_first).\n` +
    `HEAD touches: ${hits.slice(0, 6).join(', ')}${hits.length > 6 ? ` (+${hits.length-6} more)` : ''}.\n` +
    `Confirm the user has HARD-REFRESHED their browser locally and explicitly said "push it" before approving.`
  );
});
