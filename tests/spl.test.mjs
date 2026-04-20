import {
  computeDirectSPL,
  localAngles,
  computeMultiSourceSPL,
  computeListenerBreakdown,
} from '../js/physics/spl-calculator.js';

const speaker = {
  acoustic: { sensitivity_db_1w_1m: 97 },
  directivity: {
    azimuth_deg: [-180, -90, 0, 90, 180],
    elevation_deg: [-90, 0, 90],
    attenuation_db: {
      "1000": [
        [-20, -20, -20, -20, -20],
        [ -6,  -3,   0,  -3,  -6],
        [-20, -20, -20, -20, -20],
      ],
    },
  },
};

const baseState = {
  position: { x: 0, y: 0, z: 0 },
  aim: { yaw: 0, pitch: 0, roll: 0 },
  power_watts: 1,
};

let failed = 0;
function assertClose(actual, expected, tol, label) {
  const ok = Math.abs(actual - expected) < tol;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  actual=${actual.toFixed(3)} expected=${expected.toFixed(3)}`);
  if (!ok) failed++;
}

// --- Single-source SPL tests ---
const t1 = computeDirectSPL({ speakerDef: speaker, speakerState: baseState, listenerPos: { x: 0, y: 1, z: 0 } });
assertClose(t1.spl_db, 97, 0.01, 'On-axis 1m 1W = sensitivity (97 dB)');

// Distance attenuation now includes ISO 9613-1 air absorption (~0.005 dB/m
// at 1 kHz), so expected values include the α·r term.
const t2 = computeDirectSPL({ speakerDef: speaker, speakerState: baseState, listenerPos: { x: 0, y: 2, z: 0 } });
assertClose(t2.spl_db, 97 - 20 * Math.log10(2) - 0.00487 * 2, 0.02, '2m: -6 dB from 1m (+ air abs)');

const t3 = computeDirectSPL({ speakerDef: speaker, speakerState: baseState, listenerPos: { x: 0, y: 4, z: 0 } });
assertClose(t3.spl_db, 97 - 20 * Math.log10(4) - 0.00487 * 4, 0.02, '4m: -12 dB from 1m (+ air abs)');

const s10 = { ...baseState, power_watts: 10 };
const t4 = computeDirectSPL({ speakerDef: speaker, speakerState: s10, listenerPos: { x: 0, y: 1, z: 0 } });
assertClose(t4.spl_db, 97 + 10, 0.01, '10W: +10 dB from 1W');

const t5 = computeDirectSPL({ speakerDef: speaker, speakerState: baseState, listenerPos: { x: 1, y: 0, z: 0 } });
assertClose(t5.spl_db, 97 - 3, 0.01, '90° off-axis: -3 dB directivity');

const a1 = localAngles({ x: 0, y: 0, z: 0 }, { yaw: 0, pitch: 0 }, { x: 0, y: 1, z: 0 });
assertClose(a1.azimuth_deg, 0, 0.01, 'localAngles on-axis azimuth=0');
assertClose(a1.elevation_deg, 0, 0.01, 'localAngles on-axis elevation=0');

const a2 = localAngles({ x: 0, y: 0, z: 0 }, { yaw: 0, pitch: 0 }, { x: 1, y: 0, z: 0 });
assertClose(a2.azimuth_deg, 90, 0.01, 'Listener at +X = azimuth 90°');

const a3 = localAngles({ x: 0, y: 0, z: 0 }, { yaw: 90, pitch: 0 }, { x: 1, y: 0, z: 0 });
assertClose(a3.azimuth_deg, 0, 0.01, 'Yaw=90° speaker: +X listener = on-axis');

const a4 = localAngles({ x: 0, y: 0, z: 0 }, { yaw: 0, pitch: 30 }, { x: 0, y: 3, z: 3 });
assertClose(a4.elevation_deg, 15, 0.01, 'Pitch up 30° on a 45° listener → local elev 15°');

// 3D rotation correctness: a listener 90° off-axis should have local elevation 0
// regardless of pitch, because they lie on the speaker's pitch rotation axis.
// The previous 2D approximation returned `global_elev − pitch` = 30° here, which
// was wrong because subtracting pitch from global elevation is only valid when
// the listener is directly forward. Reference: fix for wide-azimuth directivity lookup.
const a5 = localAngles({ x: 0, y: 0, z: 0 }, { yaw: 0, pitch: -30 }, { x: 1, y: 0, z: 0 });
assertClose(a5.azimuth_deg, 90, 0.01, '90° off-axis + pitch=-30°: azimuth still 90°');
assertClose(a5.elevation_deg, 0, 0.01, '90° off-axis + pitch=-30°: local elev 0° (on pitch rotation axis)');

// Diagonal case — listener forward-right, speaker pitched down 45°.
// Old 2D math: az=45°, el=45° (over-reports).
// New 3D math: az≈54.7°, el=30° (correct). Formula values below verified on paper.
const a6 = localAngles({ x: 0, y: 0, z: 0 }, { yaw: 0, pitch: -45 }, { x: 1, y: 1, z: 0 });
const expectedAz = Math.atan2(1, Math.sqrt(0.5)) * 180 / Math.PI; // ≈ 54.74°
const expectedEl = Math.atan2(Math.sqrt(0.5), Math.sqrt(1 + 0.5)) * 180 / Math.PI; // 30°
assertClose(a6.azimuth_deg, expectedAz, 0.01, 'Diagonal listener + pitch: azimuth from 3D rotation');
assertClose(a6.elevation_deg, expectedEl, 0.01, 'Diagonal listener + pitch: elevation from 3D rotation');

// Listener directly overhead: elevation should be +90° regardless of yaw.
const a7 = localAngles({ x: 0, y: 0, z: 0 }, { yaw: 120, pitch: 0 }, { x: 0, y: 0, z: 5 });
assertClose(a7.elevation_deg, 90, 0.01, 'Listener straight up: elevation = +90°');

// Yaw + pitch combined. Speaker yaw=90° aims +x; pitch=-45° tilts down.
// Listener 3 m along +X is along the pitched speaker's horizontal-but-tilted axis:
// local y = r·cos(pitch), local z = r·sin(-pitch) — listener sits 45° above aim.
const a8 = localAngles({ x: 0, y: 0, z: 0 }, { yaw: 90, pitch: -45 }, { x: 3, y: 0, z: 0 });
assertClose(a8.azimuth_deg, 0, 0.01, 'Yaw=90° aims +x, listener at +x: azimuth = 0');
assertClose(a8.elevation_deg, 45, 0.01, 'Yaw=90° pitch=-45°, listener at +x: elev = +45°');

// --- Multi-source SPL tests ---
const coLocated = [
  { modelUrl: 'x', position: { x: 0, y: 0, z: 0 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 },
  { modelUrl: 'x', position: { x: 0, y: 0, z: 0 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 },
];
const lookup = () => speaker;
const t6 = computeMultiSourceSPL({
  sources: coLocated, getSpeakerDef: lookup,
  listenerPos: { x: 0, y: 1, z: 0 },
});
assertClose(t6, 97 + 10 * Math.log10(2), 0.01, 'Two identical co-located sources = +3 dB');

const four = Array.from({ length: 4 }, () => ({
  modelUrl: 'x', position: { x: 0, y: 0, z: 0 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1,
}));
const t7 = computeMultiSourceSPL({
  sources: four, getSpeakerDef: lookup,
  listenerPos: { x: 0, y: 1, z: 0 },
});
assertClose(t7, 97 + 10 * Math.log10(4), 0.01, 'Four identical sources = +6 dB');

const t8 = computeMultiSourceSPL({
  sources: [], getSpeakerDef: lookup,
  listenerPos: { x: 0, y: 1, z: 0 },
});
const t8ok = t8 === -Infinity;
console.log(`${t8ok ? 'PASS' : 'FAIL'}  Empty sources returns -Infinity  actual=${t8}`);
if (!t8ok) failed++;

// --- Listener breakdown tests (no room) ---
const br1 = computeListenerBreakdown({
  sources: [{ modelUrl: 'x', position: { x: 0, y: 0, z: 0 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 }],
  getSpeakerDef: () => speaker,
  listenerPos: { x: 0, y: 1, z: 0 },
});
assertClose(br1.perSpeaker[0].spl_db, 97, 0.01, 'Breakdown single speaker SPL');
assertClose(br1.total_spl_db, 97, 0.01, 'Breakdown total with 1 source = single SPL');

const br2 = computeListenerBreakdown({
  sources: [
    { modelUrl: 'x', position: { x: 0, y: 0, z: 0 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 },
    { modelUrl: 'x', position: { x: 0, y: 0, z: 0 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 },
  ],
  getSpeakerDef: () => speaker,
  listenerPos: { x: 0, y: 1, z: 0 },
});
assertClose(br2.perSpeaker[0].spl_db, 97, 0.01, 'Breakdown speaker 1 of 2');
assertClose(br2.perSpeaker[1].spl_db, 97, 0.01, 'Breakdown speaker 2 of 2');
assertClose(br2.total_spl_db, 97 + 10 * Math.log10(2), 0.01, 'Breakdown total with 2 co-located = +3 dB');

// --- Wall transmission loss (bug fix) ---
const rectRoom = {
  shape: 'rectangular',
  width_m: 5, height_m: 3, depth_m: 5,
  surfaces: { floor: 'f', ceiling: 'c', wall_north: 'w', wall_south: 'w', wall_east: 'w', wall_west: 'w' },
};

// Both inside: no TL
const s_in = { position: { x: 2.5, y: 1, z: 1 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 };
const l_in = { x: 2.5, y: 2, z: 1 };
const t_both_in = computeDirectSPL({ speakerDef: speaker, speakerState: s_in, listenerPos: l_in, room: rectRoom });
assertClose(t_both_in.spl_db, 97, 0.01, 'Both inside: no TL');
const t_both_in_flag = t_both_in.through_wall === false;
console.log(`${t_both_in_flag ? 'PASS' : 'FAIL'}  through_wall=false when both inside`);
if (!t_both_in_flag) failed++;

// Speaker outside, listener inside: -30 dB applied
const s_out = { position: { x: 10, y: 1, z: 1 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 };
const t_out = computeDirectSPL({ speakerDef: speaker, speakerState: s_out, listenerPos: l_in, room: rectRoom });
const r_out = Math.sqrt(7.5 * 7.5 + 1 * 1);
const expectedFree = 97 - 20 * Math.log10(r_out);
const expectedAttn = -3 + (8 / 90) * 3;
// Air absorption at 1 kHz = 0.00487 dB/m (ISO 9613-1 @ 20 °C, 50 % RH).
const expectedAirAbs = 0.00487 * r_out;
const expectedOut = expectedFree + expectedAttn - expectedAirAbs - 30;
assertClose(t_out.spl_db, expectedOut, 0.05, 'Speaker outside → -30 dB TL');
const t_out_flag = t_out.through_wall === true;
console.log(`${t_out_flag ? 'PASS' : 'FAIL'}  through_wall=true when speaker outside`);
if (!t_out_flag) failed++;

// No room param: backward compat, no TL
const t_no_room = computeDirectSPL({ speakerDef: speaker, speakerState: s_out, listenerPos: l_in });
const t_no_tl_ok = Math.abs(t_no_room.spl_db - (expectedFree + expectedAttn - expectedAirAbs)) < 0.05;
console.log(`${t_no_tl_ok ? 'PASS' : 'FAIL'}  No room param: no TL (backward compat)  actual=${t_no_room.spl_db.toFixed(3)}`);
if (!t_no_tl_ok) failed++;

// Breakdown flags outside speakers
const br3 = computeListenerBreakdown({
  sources: [
    { modelUrl: 'x', position: { x: 2.5, y: 1, z: 1 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 },
    { modelUrl: 'x', position: { x: 10, y: 1, z: 1 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 },
  ],
  getSpeakerDef: () => speaker,
  listenerPos: { x: 2.5, y: 2, z: 1 },
  room: rectRoom,
});
const br3_ok = br3.perSpeaker[0].outsideRoom === false && br3.perSpeaker[1].outsideRoom === true;
console.log(`${br3_ok ? 'PASS' : 'FAIL'}  Breakdown outsideRoom flags correct`);
if (!br3_ok) failed++;

// --- Ceiling/floor containment (fixes P0 gap) ---
const ceilRoom = {
  shape: 'rectangular',
  width_m: 5, height_m: 3, depth_m: 5,
  ceiling_type: 'flat',
  surfaces: { floor: 'f', ceiling: 'c', wall_north: 'w', wall_south: 'w', wall_east: 'w', wall_west: 'w' },
};
// Speaker above ceiling (z=5 > height 3) but inside horizontal
const s_above = { position: { x: 2.5, y: 2.5, z: 5 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 };
const l_mid  = { x: 2.5, y: 2.5, z: 1.2 };
const t_above = computeDirectSPL({ speakerDef: speaker, speakerState: s_above, listenerPos: l_mid, room: ceilRoom });
const t_above_ok = t_above.through_wall === true;
console.log(`${t_above_ok ? 'PASS' : 'FAIL'}  Speaker above flat ceiling → TL applied (through_wall=true)`);
if (!t_above_ok) failed++;

// Speaker below floor (z=-1) — also outside
const s_below = { position: { x: 2.5, y: 2.5, z: -1 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 };
const t_below = computeDirectSPL({ speakerDef: speaker, speakerState: s_below, listenerPos: l_mid, room: ceilRoom });
const t_below_ok = t_below.through_wall === true;
console.log(`${t_below_ok ? 'PASS' : 'FAIL'}  Speaker below floor → TL applied`);
if (!t_below_ok) failed++;

// --- Zone SPL grid test ---
import { computeZoneSPLGrid } from '../js/physics/spl-calculator.js';

// Zone is a 2m square, speaker 1m above center at sensitivity
const zoneRoom = {
  shape: 'rectangular',
  width_m: 10, height_m: 5, depth_m: 10,
  ceiling_type: 'flat',
  surfaces: { floor: 'f', ceiling: 'c', wall_north: 'w', wall_south: 'w', wall_east: 'w', wall_west: 'w' },
};
const zone = {
  id: 'Z1', label: 'Test zone',
  vertices: [{ x: 4, y: 4 }, { x: 6, y: 4 }, { x: 6, y: 6 }, { x: 4, y: 6 }],
  elevation_m: 0,
};
const zSrc = { modelUrl: 'x', position: { x: 5, y: 5, z: 1.2 + 1 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 };
// Speaker directly above zone center at 1m above ear. On-axis listener at zone center: r=1, elev=-90.
// At elev=-90 with speaker aim pitch=0, my mock speaker has -20 attenuation.
const zg = computeZoneSPLGrid({
  zone, sources: [zSrc],
  getSpeakerDef: () => speaker,
  room: zoneRoom, gridSize: 5,
});
const zgok = zg && zg.id === 'Z1' && zg.grid.length === 5 && isFinite(zg.avgSPL_db);
console.log(`${zgok ? 'PASS' : 'FAIL'}  Zone SPL grid computed (avg=${zg.avgSPL_db.toFixed(1)} dB)`);
if (!zgok) failed++;

// --- Line-array expansion tests ---
import { expandLineArrayToElements, expandSources } from '../js/app-state.js';

{
  const la = {
    kind: 'line-array',
    modelUrl: 'x',
    origin: { x: 10, y: 10, z: 5 },
    baseYaw_deg: 0,
    topTilt_deg: -10,
    splayAnglesDeg: [2, 3, 5],
    elementSpacing_m: 0.4,
    power_watts_each: 500,
  };
  const elements = expandLineArrayToElements(la);
  const pitchOk = elements.length === 4
    && elements[0].aim.pitch === -10
    && elements[1].aim.pitch === -12
    && elements[2].aim.pitch === -15
    && elements[3].aim.pitch === -20;
  console.log(`${pitchOk ? 'PASS' : 'FAIL'}  Line-array cumulative pitch: [-10, -12, -15, -20]  actual=[${elements.map(e => e.aim.pitch).join(', ')}]`);
  if (!pitchOk) failed++;

  const positionsDescend = elements.every((e, i, arr) =>
    i === 0 || e.position.z <= arr[i - 1].position.z);
  console.log(`${positionsDescend ? 'PASS' : 'FAIL'}  Line-array element positions descend in z`);
  if (!positionsDescend) failed++;

  const powerOk = elements.every(e => e.power_watts === 500);
  console.log(`${powerOk ? 'PASS' : 'FAIL'}  Each element gets full rated power (500W) — not divided across array`);
  if (!powerOk) failed++;

  const idxOk = elements.every((e, i) => e.elementIndex === i);
  console.log(`${idxOk ? 'PASS' : 'FAIL'}  Element indices 0..N-1, element 0 is topmost`);
  if (!idxOk) failed++;
}

{
  const mixed = [
    { modelUrl: 'a', position: { x: 0, y: 0, z: 0 }, aim: { yaw: 0, pitch: 0 }, power_watts: 100 },
    { kind: 'line-array', modelUrl: 'b', origin: { x: 1, y: 1, z: 5 }, baseYaw_deg: 0, topTilt_deg: 0, splayAnglesDeg: [1], power_watts_each: 300 },
  ];
  const flat = expandSources(mixed);
  const ok = flat.length === 3 && flat[0].modelUrl === 'a' && flat[1].modelUrl === 'b' && flat[2].modelUrl === 'b';
  console.log(`${ok ? 'PASS' : 'FAIL'}  expandSources() mixes singles + arrays (expected 3, got ${flat.length})`);
  if (!ok) failed++;
}

// --- Back-pivot geometry: adjacent cabinets must share a back edge.
// Bottom-back corner of element i should equal top-back corner of element i+1
// for any splay pattern — that's what keeps real line-array cabinets from
// overlapping when the hang has progressive splay.
{
  const la = {
    kind: 'line-array',
    modelUrl: 'data/loudspeakers/line-array-element.json',
    origin: { x: 0, y: 0, z: 10 },
    baseYaw_deg: 0,
    topTilt_deg: 0,
    splayAnglesDeg: [5, 5],  // 3 elements, strong splay to make overlap obvious if math is wrong
    elementSpacing_m: 0.42,
    power_watts_each: 500,
  };
  const els = expandLineArrayToElements(la);
  // For element i, bottom-back corner = rig[i+1] by construction. Verify
  // that rig[i+1] is h=0.42 below rig[i] along element i's cabinet-down axis.
  const h = 0.42;
  let ok = true;
  for (let i = 0; i < els.length - 1; i++) {
    const p = els[i].aim.pitch * Math.PI / 180;
    const expectedNextX = els[i].rigPoint.x + h * 0 * Math.sin(p);   // yaw=0
    const expectedNextY = els[i].rigPoint.y + h * 1 * Math.sin(p);
    const expectedNextZ = els[i].rigPoint.z + h * (-Math.cos(p));
    const dx = Math.abs(els[i + 1].rigPoint.x - expectedNextX);
    const dy = Math.abs(els[i + 1].rigPoint.y - expectedNextY);
    const dz = Math.abs(els[i + 1].rigPoint.z - expectedNextZ);
    if (dx > 1e-6 || dy > 1e-6 || dz > 1e-6) { ok = false; break; }
  }
  console.log(`${ok ? 'PASS' : 'FAIL'}  Back-pivot: adjacent cabinets share their back edge (no overlap)`);
  if (!ok) failed++;
}

// --- Zone absorption integration ----------------------------------------
// Arena preset had 16 s RT60 at mid band because the bowl tiers + court
// zones weren't contributing to the RT60 budget. With zones included the
// same room drops to ~10 s (still high because empty concrete + carpet
// seating with no audience, but physically correct).
import { computeAllBands } from '../js/physics/rt60.js';
{
  const room = {
    shape: 'rectangular', width_m: 10, height_m: 4, depth_m: 10,
    ceiling_type: 'flat',
    surfaces: { floor: 'concrete', ceiling: 'concrete', walls: 'concrete',
                wall_north: 'concrete', wall_south: 'concrete',
                wall_east: 'concrete', wall_west: 'concrete' },
  };
  const mat = {
    frequency_bands_hz: [125, 250, 500, 1000, 2000, 4000],
    byId: {
      concrete: { absorption: [0.01, 0.02, 0.02, 0.02, 0.02, 0.03] },
      absorber: { absorption: [0.50, 0.70, 0.90, 0.90, 0.85, 0.80] },
    },
  };
  const zones = [{
    id: 'abs', label: 'Audience patch', material_id: 'absorber',
    elevation_m: 0.5, vertices: [
      { x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }, { x: 2, y: 8 },
    ],
  }];
  const without = computeAllBands({ room, materials: mat });
  const withZ = computeAllBands({ room, materials: mat, zones });
  const dropMid = without[3].sabine_s - withZ[3].sabine_s;
  console.log(`${dropMid > 1 ? 'PASS' : 'FAIL'}  Absorbing zone drops RT60 at 1 kHz (without=${without[3].sabine_s.toFixed(2)}s, with=${withZ[3].sabine_s.toFixed(2)}s)`);
  if (dropMid <= 1) failed++;
}

// --- Elevated zone carves floor (C2 fix, Dr. Chen audit) ------------------
// An elevated zone's 2D footprint must be subtracted from the base floor —
// physically, a sound wave traveling down only hits the topmost surface in
// that column, so the floor below a bowl tier / concourse cannot also be
// absorbing sound. Before the fix, only zones with |elev|<0.1 m carved the
// floor; bowl tiers at elev=3.25 m double-counted their footprint (both as
// wood floor and as raked carpet).
import { roomEffectiveSurfaces } from '../js/physics/room-shape.js';
{
  const room = {
    shape: 'rectangular', width_m: 10, height_m: 4, depth_m: 10,
    ceiling_type: 'flat',
    surfaces: { floor: 'wood', ceiling: 'concrete', walls: 'concrete',
                wall_north: 'concrete', wall_south: 'concrete',
                wall_east: 'concrete', wall_west: 'concrete' },
  };
  // 6×6 m mezzanine at elev=3 m — covers 36 m² of the 100 m² floor.
  const zones = [{
    id: 'mezz', material_id: 'concrete', elevation_m: 3,
    vertices: [{x:2,y:2},{x:8,y:2},{x:8,y:8},{x:2,y:8}],
  }];
  const surfaces = roomEffectiveSurfaces(room, zones);
  const floor = surfaces.find(s => s.id === 'floor');
  const zoneS = surfaces.find(s => s.id === 'zone_mezz');
  const okCarve = Math.abs(floor.area_m2 - 64) < 1e-6;
  const okZone  = Math.abs(zoneS.area_m2 - 36) < 1e-6;
  const total = surfaces.filter(s => s.id === 'floor' || s.id === 'zone_mezz')
                        .reduce((a, s) => a + s.area_m2, 0);
  const okTotal = Math.abs(total - 100) < 1e-6;  // never more than the raw footprint
  console.log(`${okCarve ? 'PASS' : 'FAIL'}  Elevated zone carves floor (floor=${floor.area_m2} m², expected 64)`);
  console.log(`${okZone ? 'PASS' : 'FAIL'}  Zone surface area preserved (${zoneS.area_m2} m², expected 36)`);
  console.log(`${okTotal ? 'PASS' : 'FAIL'}  Floor + zone area = footprint (${total} m², no double-count)`);
  if (!okCarve) failed++;
  if (!okZone)  failed++;
  if (!okTotal) failed++;
}

// --- Audience occupancy blending ----------------------------------------
// Seated audience α (ISO 3382-1) replaces a fraction of seating absorption
// equal to the occupancy percentage. Empty bowl (occ=0) → carpet α only.
// Full bowl (occ=100) → audience α only. 50% → midpoint blend.
{
  const room = {
    shape: 'rectangular', width_m: 20, height_m: 10, depth_m: 20,
    ceiling_type: 'flat',
    surfaces: { floor: 'concrete', ceiling: 'concrete', walls: 'concrete',
                wall_north: 'concrete', wall_south: 'concrete',
                wall_east: 'concrete', wall_west: 'concrete' },
  };
  const mat = {
    frequency_bands_hz: [125, 250, 500, 1000, 2000, 4000],
    byId: {
      concrete: { absorption: [0.01, 0.02, 0.02, 0.02, 0.02, 0.03] },
      carpet:   { absorption: [0.02, 0.06, 0.14, 0.37, 0.60, 0.65] },
      'audience-seated': { absorption: [0.46, 0.51, 0.56, 0.64, 0.71, 0.75] },
    },
  };
  const makeZone = (occ) => [{
    id: 'seats', label: 'Bowl', material_id: 'carpet',
    elevation_m: 2, occupancy_percent: occ,
    vertices: [{x:2,y:2},{x:18,y:2},{x:18,y:18},{x:2,y:18}],
  }];
  const empty = computeAllBands({ room, materials: mat, zones: makeZone(0) });
  const full  = computeAllBands({ room, materials: mat, zones: makeZone(100) });
  const half  = computeAllBands({ room, materials: mat, zones: makeZone(50) });
  // At 1 kHz, carpet α=0.37, audience α=0.64 → occupied room absorbs more,
  // so RT60 drops as occupancy rises.
  const okDirection = full[3].sabine_s < empty[3].sabine_s;
  console.log(`${okDirection ? 'PASS' : 'FAIL'}  Occupied bowl RT60 shorter than empty (empty=${empty[3].sabine_s.toFixed(2)}s, 50%=${half[3].sabine_s.toFixed(2)}s, full=${full[3].sabine_s.toFixed(2)}s @1kHz)`);
  if (!okDirection) failed++;
  // 50% should land between empty and full.
  const okMonotone = half[3].sabine_s < empty[3].sabine_s && half[3].sabine_s > full[3].sabine_s;
  console.log(`${okMonotone ? 'PASS' : 'FAIL'}  Occupancy blend monotone (50% lies between empty and full)`);
  if (!okMonotone) failed++;
  // Sanity: occupancy=0 must equal no-occupancy-field (backwards compat).
  const legacy = computeAllBands({ room, materials: mat, zones: [{
    id: 'seats', material_id: 'carpet', elevation_m: 2,
    vertices: [{x:2,y:2},{x:18,y:2},{x:18,y:18},{x:2,y:18}],
  }]});
  const okBackCompat = Math.abs(legacy[3].sabine_s - empty[3].sabine_s) < 1e-6;
  console.log(`${okBackCompat ? 'PASS' : 'FAIL'}  Zones without occupancy_percent behave as 0% (legacy preset safe)`);
  if (!okBackCompat) failed++;
}

// --- ISO 9613-1 air absorption -------------------------------------------
import { airAbsorptionAt, AIR_ABSORPTION_DB_PER_M, computeRoomConstant, speedOfSound, DEFAULT_TEMPERATURE_C } from '../js/physics/spl-calculator.js';
{
  const a1k = airAbsorptionAt(1000);
  const a4k = airAbsorptionAt(4000);
  const a_lerp = airAbsorptionAt(1500);  // between 1k and 2k
  const okTable = Math.abs(a1k - AIR_ABSORPTION_DB_PER_M[1000]) < 1e-9
    && Math.abs(a4k - AIR_ABSORPTION_DB_PER_M[4000]) < 1e-9
    && a_lerp > a1k && a_lerp < AIR_ABSORPTION_DB_PER_M[2000];
  console.log(`${okTable ? 'PASS' : 'FAIL'}  Air absorption table + log-interp monotonic (1k=${a1k}, 4k=${a4k}, 1.5k=${a_lerp.toFixed(5)})`);
  if (!okTable) failed++;

  // At 4 kHz over 30 m, ISO-9613 says ~1.13 dB. Sanity-check matches spec.
  const dropAt30m4k = a4k * 30;
  const ok30m = Math.abs(dropAt30m4k - 1.13) < 0.05;
  console.log(`${ok30m ? 'PASS' : 'FAIL'}  4 kHz air absorption over 30 m ≈ 1.13 dB (got ${dropAt30m4k.toFixed(3)})`);
  if (!ok30m) failed++;
}

// --- Speed of sound temperature dependence --------------------------------
{
  const c20 = speedOfSound(20);
  const c30 = speedOfSound(30);
  const ok = Math.abs(c20 - 343.2) < 0.2 && c30 > c20;
  console.log(`${ok ? 'PASS' : 'FAIL'}  Speed of sound: 20°C=${c20.toFixed(1)}m/s, 30°C=${c30.toFixed(1)}m/s (warmer → faster)`);
  if (!ok) failed++;
}

// --- Reverberant field via Hopkins-Stryker --------------------------------
{
  // 10×10×5 m room, gypsum walls/ceiling, wood floor. Use provided mock
  // materials so computeRoomConstant has something to read.
  const materials = {
    frequency_bands_hz: [125, 250, 500, 1000, 2000, 4000],
    byId: {
      'gypsum-board': { absorption: [0.1, 0.08, 0.05, 0.04, 0.07, 0.09] },
      'wood-floor':   { absorption: [0.15, 0.11, 0.10, 0.07, 0.06, 0.07] },
      'acoustic-tile':{ absorption: [0.20, 0.40, 0.55, 0.65, 0.70, 0.70] },
    },
  };
  const room = {
    shape: 'rectangular', width_m: 10, height_m: 5, depth_m: 10,
    ceiling_type: 'flat',
    surfaces: { floor: 'wood-floor', ceiling: 'acoustic-tile', walls: 'gypsum-board',
                wall_north: 'gypsum-board', wall_south: 'gypsum-board',
                wall_east: 'gypsum-board', wall_west: 'gypsum-board' },
  };
  const R = computeRoomConstant(room, materials, 1000);
  // S = 4*(10*5) + 2*(10*10) = 200 + 200 = 400 m².
  // α_bar ≈ (200*0.04 + 100*0.07 + 100*0.65)/400 = (8 + 7 + 65)/400 = 0.2
  // R = 400*0.2/0.8 = 100 m².
  const okR = Math.abs(R - 100) < 2;
  console.log(`${okR ? 'PASS' : 'FAIL'}  computeRoomConstant(10×10×5, mixed materials, 1kHz) ≈ 100 m² (got ${R.toFixed(2)})`);
  if (!okR) failed++;

  // With reverberant field enabled, total SPL at any point should be higher
  // than direct-only — and identical across positions (diffuse uniform).
  const srcA = { modelUrl: 'x', position: { x: 2, y: 2, z: 2 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 };
  const listenerNear = { x: 3, y: 3, z: 1.2 };
  const listenerFar  = { x: 8, y: 8, z: 1.2 };
  const dirNear = computeMultiSourceSPL({ sources: [srcA], getSpeakerDef: () => speaker, listenerPos: listenerNear, room });
  const totNear = computeMultiSourceSPL({ sources: [srcA], getSpeakerDef: () => speaker, listenerPos: listenerNear, room, roomConstantR: 100 });
  const totFar  = computeMultiSourceSPL({ sources: [srcA], getSpeakerDef: () => speaker, listenerPos: listenerFar,  room, roomConstantR: 100 });
  console.log(`${totNear > dirNear ? 'PASS' : 'FAIL'}  Reverberant contribution raises SPL (dir=${dirNear.toFixed(1)}, dir+rev=${totNear.toFixed(1)} dB)`);
  if (totNear <= dirNear) failed++;
  // Diffuse part should make far-field lift relatively larger than near-field lift.
  const nearLift = totNear - dirNear;
  const dirFar = computeMultiSourceSPL({ sources: [srcA], getSpeakerDef: () => speaker, listenerPos: listenerFar, room });
  const farLift = totFar - dirFar;
  console.log(`${farLift > nearLift ? 'PASS' : 'FAIL'}  Reverb field more important at far field (near lift=${nearLift.toFixed(2)} dB < far lift=${farLift.toFixed(2)} dB)`);
  if (farLift <= nearLift) failed++;
}

// --- Coherent summation: two co-located in-phase sources = +6 dB ----------
{
  const srcA = { modelUrl: 'x', position: { x: 0, y: 0, z: 0 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 };
  const srcB = { modelUrl: 'x', position: { x: 0, y: 0, z: 0 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 };
  const listener = { x: 0, y: 1, z: 0 };
  const inc = computeMultiSourceSPL({ sources: [srcA, srcB], getSpeakerDef: () => speaker, listenerPos: listener, coherent: false });
  const coh = computeMultiSourceSPL({ sources: [srcA, srcB], getSpeakerDef: () => speaker, listenerPos: listener, coherent: true });
  // Same position → same distance → same phase → amplitudes add linearly → +6 dB vs single.
  const single = computeMultiSourceSPL({ sources: [srcA], getSpeakerDef: () => speaker, listenerPos: listener });
  const incLift = inc - single, cohLift = coh - single;
  console.log(`${Math.abs(incLift - 3) < 0.1 ? 'PASS' : 'FAIL'}  Incoherent sum: 2 co-located identical = +3 dB (got +${incLift.toFixed(2)})`);
  if (Math.abs(incLift - 3) >= 0.1) failed++;
  console.log(`${Math.abs(cohLift - 6) < 0.1 ? 'PASS' : 'FAIL'}  Coherent sum: 2 co-located in-phase = +6 dB (got +${cohLift.toFixed(2)})`);
  if (Math.abs(cohLift - 6) >= 0.1) failed++;
}

// --- Power-change visibility with reverberant field -----------------------
// User-reported bug: dropping one source from 500 W to 5 W produced almost
// no change in audience SPL because the reverberant field was dominating
// (inflated by ignoring each source's directivity index in L_w). With DI
// correction, a ≥10 dB change at a listener in the source's on-axis path
// must be visible.
{
  const directiveSpeaker = {
    acoustic: { sensitivity_db_1w_1m: 100, directivity_index_db: 12 },
    directivity: speaker.directivity,
  };
  const materials = {
    frequency_bands_hz: [125, 250, 500, 1000, 2000, 4000],
    byId: {
      'gypsum-board': { absorption: [0.1, 0.08, 0.05, 0.04, 0.07, 0.09] },
      'wood-floor':   { absorption: [0.15, 0.11, 0.10, 0.07, 0.06, 0.07] },
    },
  };
  const room = {
    shape: 'rectangular', width_m: 60, height_m: 12, depth_m: 60,
    ceiling_type: 'flat',
    surfaces: { floor: 'wood-floor', ceiling: 'gypsum-board', walls: 'gypsum-board',
                wall_north: 'gypsum-board', wall_south: 'gypsum-board',
                wall_east: 'gypsum-board', wall_west: 'gypsum-board' },
  };
  const R = computeRoomConstant(room, materials, 1000);
  const listener = { x: 30, y: 45, z: 2 };  // on-axis of srcHigh
  const srcHigh = { modelUrl: 'la', position: { x: 30, y: 30, z: 10 }, aim: { yaw: 0, pitch: 0 }, power_watts: 500 };
  const srcLow  = { modelUrl: 'la', position: { x: 30, y: 30, z: 10 }, aim: { yaw: 0, pitch: 0 }, power_watts: 5 };
  const getDef = () => directiveSpeaker;
  const splHigh = computeMultiSourceSPL({ sources: [srcHigh], getSpeakerDef: getDef, listenerPos: listener, room, roomConstantR: R });
  const splLow  = computeMultiSourceSPL({ sources: [srcLow],  getSpeakerDef: getDef, listenerPos: listener, room, roomConstantR: R });
  const diff = splHigh - splLow;
  // 500 W → 5 W is 100× power = -20 dB on direct. With reverb the diffuse
  // term also drops 20 dB, so total should drop ~20 dB (plus or minus a
  // small non-linearity where one term dominates).
  console.log(`${diff > 10 ? 'PASS' : 'FAIL'}  100× power change visible at on-axis listener (splHigh−splLow = ${diff.toFixed(1)} dB, need > 10)`);
  if (diff <= 10) failed++;
}

// --- Master EQ (source-side pre-speaker gain) -----------------------------
// eqGainDb is a per-frequency scalar added to the direct SPL and to L_w for
// the reverb term. Bypass (gain=0) must produce identical numbers to pre-EQ.
import { eqGainAt } from '../js/app-state.js';
{
  const s = { ...baseState, power_watts: 1 };
  const listener = { x: 0, y: 2, z: 0 };
  const splBypass = computeDirectSPL({ speakerDef: speaker, speakerState: s, listenerPos: listener });
  const splPlus6  = computeDirectSPL({ speakerDef: speaker, speakerState: s, listenerPos: listener, eqGainDb: 6 });
  const splMinus6 = computeDirectSPL({ speakerDef: speaker, speakerState: s, listenerPos: listener, eqGainDb: -6 });
  assertClose(splPlus6.spl_db - splBypass.spl_db,  6, 0.01, 'EQ +6 dB raises direct SPL by 6 dB');
  assertClose(splMinus6.spl_db - splBypass.spl_db, -6, 0.01, 'EQ −6 dB drops direct SPL by 6 dB');
}
{
  const eq = {
    enabled: true,
    bands: [
      { freq_hz: 125,  gain_db:  0 },
      { freq_hz: 1000, gain_db:  6 },
      { freq_hz: 8000, gain_db: -6 },
    ],
  };
  assertClose(eqGainAt(eq, 125),   0, 0.001, 'eqGainAt at band edge returns band gain');
  assertClose(eqGainAt(eq, 1000),  6, 0.001, 'eqGainAt at 1 kHz returns +6');
  assertClose(eqGainAt(eq, 8000), -6, 0.001, 'eqGainAt at 8 kHz returns −6');
  // Halfway between 125 and 1000 on log-freq scale is ~354 Hz.
  const midDb = eqGainAt(eq, Math.sqrt(125 * 1000));
  assertClose(midDb, 3, 0.5, 'eqGainAt interpolates log-freq between bands');
  // Out-of-range: clamp to edge bands.
  assertClose(eqGainAt(eq, 50),     0, 0.001, 'eqGainAt below lowest band clamps to edge');
  assertClose(eqGainAt(eq, 20000), -6, 0.001, 'eqGainAt above highest band clamps to edge');
  // Bypass returns 0 regardless.
  const bypassed = { ...eq, enabled: false };
  assertClose(eqGainAt(bypassed, 1000), 0, 0.001, 'eqGainAt returns 0 when EQ bypassed');
}

if (failed > 0) { console.log(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log('\nAll SPL tests passed.');
