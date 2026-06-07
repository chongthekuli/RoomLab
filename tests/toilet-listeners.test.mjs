// Toilet round-listener + structure-designator guard (v=780, 2026-06-07).
//
// Covers two features shipped together:
//   FEATURE 1 — nextStructureId(type) returns a per-type, non-'S' designator
//               ('S' is reserved for speaker sources): toilet → WC#,
//               pillar → COL#, half_wall → HW#, partition → PRT#, beam → BM#,
//               platform → PLT#, unknown → BS#. Unique across ALL structure
//               ids. duplicateStructure uses the duplicated structure's type.
//   FEATURE 2 — syncToiletListeners auto-creates ONE round listener per
//               cubicle (shape:'round' + cubicleRef) snapped to the bowl
//               centre at seated ear height; cubicle-count change adds/removes;
//               toilet delete cascades; shape + cubicleRef round-trip through
//               serialize/deserialize.
//
// Run: node tests/toilet-listeners.test.mjs

import {
  state,
  nextStructureId, STRUCTURE_ID_PREFIX, structureIdPrefix, duplicateStructure,
  syncToiletListeners, removeToiletListeners, syncAllToiletListeners,
  earHeightFor, serializeProject, deserializeProject,
} from '../js/app-state.js';
import { expandToiletSurfaces } from '../js/physics/building-structures.js';

let failed = 0;
const ok = (cond, label, info = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}  ${info}`);
  if (!cond) failed++;
};
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// Reset the scene arrays we touch (avoid cross-test pollution in-process).
function resetScene() {
  state.structures = [];
  state.listeners = [];
  state.selectedStructureId = null;
  state.selectedListenerId = null;
  state.room = { width_m: 10, depth_m: 10, height_m: 3, shape: 'rectangular' };
}

function toiletAt(over = {}) {
  return {
    id: 'WC1', type: 'toilet', label: 'Toilet block 1',
    position: { x: 5, y: 5 }, rotation_deg: 0,
    materialId: 'gypsum-board', elev_m: 0,
    cubicles: 3, pitch_m: 0.95, clearWidth_m: 0.90, clearDepth_m: 1.50, partitionThickness_m: 0.05,
    backToBack: false, topType: 'open', openTopBoardH_m: 2.00, scuffGap_m: 0.15, doorClearH_m: 2.10,
    doorSide: '+y', hingeSide: 'left', frontLatchGap_m: 0.010, hingeReveal_m: 0.010, doorThk_m: 0.04,
    undercut_m: 0.30, doorsOpen: [false, false, false], showBowls: true, seatHeight_m: 0.42,
    ...over,
  };
}

// =====================================================================
// FEATURE 1 — per-type designator, no 'S' collision with sources.
// =====================================================================
{
  resetScene();
  ok(nextStructureId('toilet') === 'WC1', "nextStructureId('toilet') = WC1 (NOT S1)", `(${nextStructureId('toilet')})`);
  ok(nextStructureId('pillar') === 'COL1', "nextStructureId('pillar') = COL1");
  ok(nextStructureId('half_wall') === 'HW1', "nextStructureId('half_wall') = HW1");
  ok(nextStructureId('partition') === 'PRT1', "nextStructureId('partition') = PRT1");
  ok(nextStructureId('beam') === 'BM1', "nextStructureId('beam') = BM1");
  ok(nextStructureId('platform') === 'PLT1', "nextStructureId('platform') = PLT1");
  ok(nextStructureId('mystery') === 'BS1', "unknown type → BS1 fallback");
  ok(structureIdPrefix('toilet') === 'WC' && STRUCTURE_ID_PREFIX.toilet === 'WC', 'prefix map exported + toilet → WC');
  ok(!Object.values(STRUCTURE_ID_PREFIX).includes('S'), "no structure prefix is 'S' (reserved for sources)");
}

// Uniqueness across ALL ids (not just same-prefix) + next free integer.
{
  resetScene();
  state.structures = [
    { id: 'WC1', type: 'toilet' }, { id: 'WC2', type: 'toilet' }, { id: 'COL1', type: 'pillar' },
  ];
  ok(nextStructureId('toilet') === 'WC3', 'next free WC after WC1,WC2 = WC3', `(${nextStructureId('toilet')})`);
  ok(nextStructureId('pillar') === 'COL2', 'next free COL after COL1 = COL2');
}

// duplicateStructure uses the DUPLICATED structure's type → right prefix.
{
  resetScene();
  state.structures = [{ id: 'COL1', type: 'pillar', label: 'Pillar 1', position: { x: 1, y: 1 }, materialId: 'concrete-painted' }];
  const dupId = duplicateStructure('COL1');
  ok(dupId === 'COL2', 'duplicate pillar → COL2 (per-type prefix)', `(${dupId})`);

  resetScene();
  state.structures = [toiletAt()];
  const dupT = duplicateStructure('WC1');
  ok(dupT === 'WC2', 'duplicate toilet → WC2 (per-type prefix)', `(${dupT})`);
}

// =====================================================================
// FEATURE 2 — syncToiletListeners auto-create at bowls + tracking.
// =====================================================================
{
  resetScene();
  const t = toiletAt();
  state.structures = [t];
  const changed = syncToiletListeners(t);
  ok(changed === true, 'syncToiletListeners reports a change on first sync');

  const round = state.listeners.filter(l => l.cubicleRef && l.cubicleRef.toiletId === 'WC1');
  ok(round.length === 3, 'one round listener per cubicle (3)', `(${round.length})`);
  ok(round.every(l => l.shape === 'round'), 'every cubicle listener tagged shape:round');
  ok(round.every(l => /^L\d+$/.test(l.id)), 'cubicle listeners keep the L# id scheme');

  // Positions snap to the pure bowl centres.
  const bowls = expandToiletSurfaces(t, state.room).bowls;
  let snapped = true;
  for (let i = 0; i < 3; i++) {
    const lst = round.find(l => l.cubicleRef.cubicleIndex === i);
    const b = bowls.find(x => x.cubicleIndex === i);
    if (!lst || !approx(lst.position.x, b.center.x) || !approx(lst.position.y, b.center.y)) snapped = false;
  }
  ok(snapped, 'each cubicle listener sits on its bowl centre (state coords)');

  // Seated ear height ~1.15 m via sitting_chair posture.
  ok(round.every(l => approx(earHeightFor(l), 1.15)), 'seated ear height resolves to 1.15 m');

  // Labels tie to toilet + cubicle.
  ok(round.some(l => l.label === 'Toilet block 1 · Cubicle 2'), 'label = "<toilet> · Cubicle N"',
     `(${round.find(l => l.cubicleRef.cubicleIndex === 1)?.label})`);

  // Idempotent re-sync (no spurious additions).
  syncToiletListeners(t);
  ok(state.listeners.filter(l => l.cubicleRef).length === 3, 're-sync is idempotent (still 3)');
}

// Cubicle COUNT change → add / remove + re-snap.
{
  resetScene();
  const t = toiletAt({ cubicles: 3, doorsOpen: [false, false, false] });
  state.structures = [t];
  syncToiletListeners(t);
  ok(state.listeners.filter(l => l.cubicleRef).length === 3, 'start with 3');

  // Grow to 5.
  t.cubicles = 5;
  t.doorsOpen = [false, false, false, false, false];
  syncToiletListeners(t);
  let refs = state.listeners.filter(l => l.cubicleRef).map(l => l.cubicleRef.cubicleIndex).sort((a, b) => a - b);
  ok(refs.join(',') === '0,1,2,3,4', 'growing cubicles adds listeners (0..4)', `(${refs.join(',')})`);

  // Shrink to 2.
  t.cubicles = 2;
  t.doorsOpen = [false, false];
  syncToiletListeners(t);
  refs = state.listeners.filter(l => l.cubicleRef).map(l => l.cubicleRef.cubicleIndex).sort((a, b) => a - b);
  ok(refs.join(',') === '0,1', 'shrinking cubicles removes orphaned listeners (0,1)', `(${refs.join(',')})`);
}

// MOVE → listeners follow (re-snap to new bowl centres).
{
  resetScene();
  const t = toiletAt();
  state.structures = [t];
  syncToiletListeners(t);
  const before = state.listeners.find(l => l.cubicleRef?.cubicleIndex === 0).position.x;
  t.position.x += 2.0;
  syncToiletListeners(t);
  const after = state.listeners.find(l => l.cubicleRef?.cubicleIndex === 0).position.x;
  ok(approx(after - before, 2.0), 'listeners follow the toilet on move (+2 m on x)', `(Δ=${(after - before).toFixed(3)})`);
}

// DELETE cascade — removeToiletListeners drops all linked listeners.
{
  resetScene();
  const t = toiletAt();
  state.structures = [t];
  // A normal (non-cubicle) listener must SURVIVE the cascade.
  state.listeners.push({ id: 'L99', label: 'Normal', position: { x: 1, y: 1 }, posture: 'standing', custom_ear_height_m: null });
  syncToiletListeners(t);
  ok(state.listeners.filter(l => l.cubicleRef).length === 3, 'pre-delete: 3 cubicle listeners');
  const removed = removeToiletListeners('WC1');
  ok(removed === true, 'removeToiletListeners reports removal');
  ok(state.listeners.filter(l => l.cubicleRef).length === 0, 'cascade removed all cubicle listeners');
  ok(state.listeners.some(l => l.id === 'L99'), 'normal listener survives cascade');
}

// syncAllToiletListeners reconciles every toilet (preset / load path).
{
  resetScene();
  state.structures = [toiletAt({ id: 'WC1', position: { x: 3, y: 3 } }), toiletAt({ id: 'WC2', position: { x: 7, y: 7 } })];
  syncAllToiletListeners();
  ok(state.listeners.filter(l => l.cubicleRef?.toiletId === 'WC1').length === 3, 'WC1 got 3 listeners');
  ok(state.listeners.filter(l => l.cubicleRef?.toiletId === 'WC2').length === 3, 'WC2 got 3 listeners');
}

// =====================================================================
// FEATURE 2c — shape + cubicleRef round-trip through serialize/deserialize.
// =====================================================================
{
  resetScene();
  const t = toiletAt();
  state.structures = [t];
  syncToiletListeners(t);
  const json = JSON.parse(JSON.stringify(serializeProject(state)));
  const sround = json.listeners.filter(l => l.cubicleRef);
  ok(sround.length === 3, 'serialize emits the 3 round listeners');
  ok(sround.every(l => l.shape === 'round'), 'serialize preserves shape:round');
  ok(sround.every(l => l.cubicleRef && l.cubicleRef.toiletId === 'WC1' && typeof l.cubicleRef.cubicleIndex === 'number'),
     'serialize preserves cubicleRef {toiletId, cubicleIndex}');

  // Wipe + restore. deserialize re-syncs (idempotent) — count stays 3 with fields intact.
  state.listeners = [];
  state.structures = [];
  deserializeProject(json);
  const dround = state.listeners.filter(l => l.cubicleRef);
  ok(dround.length === 3, 'deserialize restores 3 round listeners', `(${dround.length})`);
  ok(dround.every(l => l.shape === 'round'), 'deserialize preserves shape:round');
  ok(dround.every(l => l.cubicleRef?.toiletId === 'WC1'), 'deserialize preserves cubicleRef.toiletId');
}

// Pre-v780 file: a toilet with NO round listeners → deserialize auto-creates them.
{
  resetScene();
  const t = toiletAt();
  const legacy = JSON.parse(JSON.stringify(serializeProject({
    ...state,
    structures: [t],
    listeners: [],   // legacy file had no cubicle listeners
  })));
  ok((legacy.listeners ?? []).filter(l => l.cubicleRef).length === 0, 'legacy file has no cubicle listeners');
  deserializeProject(legacy);
  ok(state.listeners.filter(l => l.cubicleRef).length === 3, 'deserialize auto-creates listeners for a legacy toilet', `(${state.listeners.filter(l => l.cubicleRef).length})`);
}

console.log(failed === 0 ? '\nAll toilet-listener tests PASSED' : `\n${failed} test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
