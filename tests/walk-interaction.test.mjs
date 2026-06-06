// Walk-mode "Press E" interaction helpers (2026-06-05).
// Guards the pure nearest-pick + prompt copy used by the walk-mode
// open/close-door interaction. (The scene-graph scan + state toggle are
// Three.js-coupled and verified live.)

import { pickNearestInteractable, interactionPromptText, DEFAULT_REACH_M } from '../js/graphics/walk-interaction.js';

let failed = 0;
const ok = (c, l, e = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}  ${e}`); if (!c) failed++; };

// --- pickNearestInteractable -------------------------------------------
{
  const cands = [
    { id: 'far', wx: 5, wz: 0 },
    { id: 'near', wx: 0.5, wz: 0.5 },
    { id: 'mid', wx: 1.5, wz: 0 },
  ];
  const got = pickNearestInteractable(0, 0, cands);
  ok(got && got.id === 'near', 'picks the nearest candidate', `(${got?.id})`);
  ok(got && Number.isFinite(got.dist), 'returns a dist field', `(${got?.dist?.toFixed(2)})`);
}
{
  // Nothing within reach → null.
  const got = pickNearestInteractable(0, 0, [{ id: 'x', wx: 5, wz: 5 }]);
  ok(got === null, 'nothing within reach → null');
}
{
  // Exactly at reach boundary is included.
  const got = pickNearestInteractable(0, 0, [{ id: 'edge', wx: DEFAULT_REACH_M, wz: 0 }]);
  ok(got && got.id === 'edge', 'candidate exactly at reach is included');
}
{
  ok(pickNearestInteractable(0, 0, []) === null, 'empty candidate list → null');
  ok(pickNearestInteractable(0, 0, [{ wx: NaN, wz: 0 }]) === null, 'malformed candidate skipped');
}
{
  // Tighter reach excludes a candidate the default would include.
  const c = [{ id: 'a', wx: 1.5, wz: 0 }];
  ok(pickNearestInteractable(0, 0, c, 1.0) === null, 'custom reach excludes beyond it');
  ok(pickNearestInteractable(0, 0, c, 2.0)?.id === 'a', 'custom reach includes within it');
}

// --- interactionPromptText ---------------------------------------------
ok(interactionPromptText('opening', 'door', false) === 'Press E to open the door', 'closed door → open prompt');
ok(interactionPromptText('opening', 'door', true) === 'Press E to close the door', 'open door → close prompt');
ok(interactionPromptText('opening', 'window', false) === 'Press E to open the window', 'closed window → open prompt');
ok(interactionPromptText('opening', 'window', true) === 'Press E to close the window', 'open window → close prompt');
ok(interactionPromptText('rack', null, false) === 'Press E to open the rack door', 'closed rack → open prompt');
ok(interactionPromptText('rack', null, true) === 'Press E to close the rack door', 'open rack → close prompt');

console.log(failed === 0 ? '\nAll walk-interaction tests PASSED' : `\n${failed} test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
