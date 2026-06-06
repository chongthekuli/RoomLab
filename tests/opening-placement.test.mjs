// Wall-opening non-overlap placement (2026-06-05).
//
// Bug: DEFAULT_DOOR and DEFAULT_WINDOW both spawned at x_m = 0.5, so a door and
// a window added to the same wall stacked on top of each other (physically
// impossible). placeOpeningX packs a new opening next to the existing ones.
//
// Run: node tests/opening-placement.test.mjs

import { placeOpeningX } from '../js/ui/opening-placement.js';

let failed = 0;
const ok = (c, l, e = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}  ${e}`); if (!c) failed++; };

const overlaps = (aL, aW, bL, bW) => aL < bL + bW && bL < aL + aW;

// 1. First opening on an empty wall → default position.
{
  const x = placeOpeningX([], 0.9, 6);
  ok(x === 0.5, 'first opening on empty wall lands at default x=0.5', `(${x})`);
}

// 2. Door then window on the same wall do NOT overlap (the reported bug).
{
  const door = { kind: 'door', x_m: 0.5, width_m: 0.9 };
  const winX = placeOpeningX([door], 1.5, 6);
  ok(!overlaps(door.x_m, door.width_m, winX, 1.5),
     'window placed after a door does not overlap it', `(door [0.5,1.4], window x=${winX})`);
  ok(winX >= door.x_m + door.width_m, 'window sits to the RIGHT of the door (next to it)', `(${winX} ≥ 1.4)`);
}

// 3. Window then door — door packs next to the window (symmetric).
{
  const win = { kind: 'window', x_m: 0.5, width_m: 1.5 };
  const doorX = placeOpeningX([win], 0.9, 6);
  ok(!overlaps(win.x_m, win.width_m, doorX, 0.9), 'door after a window does not overlap', `(door x=${doorX})`);
}

// 4. Three openings in sequence are mutually non-overlapping.
{
  const ops = [];
  const widths = [0.9, 1.5, 0.8];
  for (const w of widths) {
    const x = placeOpeningX(ops, w, 8);
    ops.push({ x_m: x, width_m: w });
  }
  let clean = true;
  for (let i = 0; i < ops.length; i++)
    for (let j = i + 1; j < ops.length; j++)
      if (overlaps(ops[i].x_m, ops[i].width_m, ops[j].x_m, ops[j].width_m)) clean = false;
  ok(clean, 'three sequential openings are all mutually non-overlapping',
     `(${ops.map(o => `[${o.x_m.toFixed(2)},${(o.x_m + o.width_m).toFixed(2)}]`).join(' ')})`);
}

// 5. Right edge full → fall into a left gap. Wall len 4; opening at [2.5,4.0];
//    add a 0.9 door → no room on the right, must fit in [0,2.5).
{
  const x = placeOpeningX([{ x_m: 2.5, width_m: 1.5 }], 0.9, 4);
  ok(x + 0.9 <= 2.5 + 1e-9 && x >= 0, 'when right edge is full, new opening fits the left gap', `(x=${x})`);
}

// 6. Stays on the wall (never negative; clamps within length when it can).
{
  const x = placeOpeningX([{ x_m: 0, width_m: 3.6 }], 0.9, 4);
  ok(x >= 0 && x + 0.9 <= 4 + 1e-9, 'opening clamps within the wall length', `(x=${x})`);
}

// 7. Unknown wall length (null) → still packs to the right of existing.
{
  const x = placeOpeningX([{ x_m: 0.5, width_m: 0.9 }], 1.5, null);
  ok(x >= 1.4, 'null wall length still packs to the right of existing', `(x=${x})`);
}

// 8. System openings (merge-cut markers) are ignored — they don't block.
{
  const x = placeOpeningX([{ x_m: 0.5, width_m: 0.9, system: true }], 1.5, 6);
  ok(x === 0.5, 'system openings are ignored (a real opening can take x=0.5)', `(${x})`);
}

console.log(failed === 0 ? '\nAll opening-placement tests PASSED' : `\n${failed} test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
