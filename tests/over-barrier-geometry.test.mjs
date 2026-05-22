// Over-barrier path-difference regression guard (WallLAB Phase 4 demo).
//
// overBarrierPathDifference() is the 2D geometry feeding maekawaIL() in the
// WallLAB "over-wall diffraction" demo. The load-bearing behaviour: a source
// mounted ABOVE a wall has a clear sightline over the top → SIGNED δ negative
// (lit) → ~no insertion loss → sound "leaks over". This is the surau azan-horn
// insight; if a refactor flips the sign convention the demo would falsely show
// a high wall blocking a high source, so lock it.

import assert from 'node:assert';
import { overBarrierPathDifference, maekawaIL } from '../js/physics/diffraction.js';

let passed = 0;
function check(name, cond) { assert.ok(cond, `FAIL: ${name}`); console.log(`PASS  ${name}`); passed++; }

// --- The surau case: source 7 m, wall 4.5 m, receiver 1.5 m behind ----------
// Sightline from 7 m down to 1.5 m clears the 4.5 m top when the receiver is
// close behind → LIT → δ < 0 → negligible loss. The wall does NOT block it.
{
  const d = overBarrierPathDifference({
    sourceH: 7, barrierH: 4.5, sourceToBarrier: 2, barrierToReceiver: 3, receiverH: 1.5,
  });
  // Sightline height at the screen (2 m of 5 m): 7 + (1.5−7)·(2/5) = 4.8 m > 4.5 → LIT.
  // δ ≈ −0.013 m — near-grazing, so maekawaIL returns its small graze-handoff
  // value (~3.5 dB), NOT a blocking-wall loss. This IS the surau insight: a
  // high source barely clears the top, so the wall hardly attenuates it.
  check('high source over a lower wall → δ < 0 (lit, leaks over)', d < 0);
  check('lit/near-grazing → maekawaIL small (<5 dB), wall barely attenuates',
    maekawaIL(d, 343 / 1000) < 5);
}

// --- A genuinely shadowing barrier: low source, tall wall -------------------
{
  const d = overBarrierPathDifference({
    sourceH: 1.5, barrierH: 4.5, sourceToBarrier: 3, barrierToReceiver: 3, receiverH: 1.5,
  });
  check('low source behind a tall wall → δ > 0 (shadow)', d > 0);
  check('shadow geometry → maekawaIL gives real insertion loss (>5 dB @1kHz)',
    maekawaIL(d, 343 / 1000) > 5);
}

// --- A taller barrier → deeper shadow → larger δ → more loss ----------------
// (Robustly monotonic: raising the screen between fixed S and R always
// lengthens the over-top detour. Receiver-distance monotonicity is NOT
// universal — with a low near source, δ can shrink as the receiver recedes.)
{
  const lowWall  = overBarrierPathDifference({ sourceH: 1.5, barrierH: 3, sourceToBarrier: 3, barrierToReceiver: 4, receiverH: 1.5 });
  const highWall = overBarrierPathDifference({ sourceH: 1.5, barrierH: 6, sourceToBarrier: 3, barrierToReceiver: 4, receiverH: 1.5 });
  check('taller barrier → larger δ (deeper shadow), both positive', highWall > lowWall && lowWall > 0);
  check('taller barrier → at least as much insertion loss',
    maekawaIL(highWall, 343 / 1000) >= maekawaIL(lowWall, 343 / 1000));
}

// --- Grazing: sightline exactly at the top → δ ≈ 0 --------------------------
{
  // Source 3 m, receiver 3 m, equal distances → sightline at screen = 3 m.
  // Barrier exactly 3 m → grazing.
  const d = overBarrierPathDifference({ sourceH: 3, barrierH: 3, sourceToBarrier: 4, barrierToReceiver: 4, receiverH: 3 });
  check('grazing sightline (barrier at sightline height) → |δ| ≈ 0', Math.abs(d) < 1e-6);
}

console.log(`\nOK  ${passed} assertions passed`);
