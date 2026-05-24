// Phase A4 (2026-05-24): WallTag schema unit test. Pins the round-trip
// format ↔ parse contract and the predicate semantics, so a future
// rename of the wallId string format is a single-file change with a
// fixture failure pointing at exactly the schema row that drifted.

const { formatWallId, parseWallId, isParentWall, isParentWallOrEdge, isOverheadRoof, isEnclosureWall } =
  await import('../js/physics/wall-id.js');

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`);
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

// Round-trip table — every legacy string format produced by wall-path.js
// MUST parse to a tag and format back to the same string.
const cases = [
  { str: 'parent_wall_north',         tag: { scope: 'parent', side: 'north', kind: 'wall' } },
  { str: 'parent_wall_south',         tag: { scope: 'parent', side: 'south', kind: 'wall' } },
  { str: 'parent_wall_east',          tag: { scope: 'parent', side: 'east',  kind: 'wall' } },
  { str: 'parent_wall_west',          tag: { scope: 'parent', side: 'west',  kind: 'wall' } },
  { str: 'parent_floor',              tag: { scope: 'parent', kind: 'floor' } },
  { str: 'parent_ceiling',            tag: { scope: 'parent', kind: 'ceiling' } },
  { str: 'parent_edge_0',             tag: { scope: 'parent', kind: 'edge', edgeIdx: 0 } },
  { str: 'parent_edge_7',             tag: { scope: 'parent', kind: 'edge', edgeIdx: 7 } },
  { str: 'enc0_edge_3',               tag: { scope: 'enclosure', enclosureIdx: 0, kind: 'edge', edgeIdx: 3 } },
  { str: 'enc2_floor',                tag: { scope: 'enclosure', enclosureIdx: 2, kind: 'floor' } },
  { str: 'enc2_ceiling',              tag: { scope: 'enclosure', enclosureIdx: 2, kind: 'ceiling' } },
  { str: 'arcade_roof_west_ceiling',  tag: { scope: 'arcade_roof',  side: 'west',  kind: 'ceiling' } },
  { str: 'arcade_roof_south_ceiling', tag: { scope: 'arcade_roof',  side: 'south', kind: 'ceiling' } },
  { str: 'arcade_roof_east_ceiling',  tag: { scope: 'arcade_roof',  side: 'east',  kind: 'ceiling' } },
  { str: 'arcade_roof_north_ceiling', tag: { scope: 'arcade_roof',  side: 'north', kind: 'ceiling' } },
  { str: 'portico_roof_south_ceiling', tag: { scope: 'portico_roof', side: 'south', kind: 'ceiling' } },
];

for (const { str, tag } of cases) {
  const formatted = formatWallId(tag);
  check(`format ${str.padEnd(30)}`, formatted === str, `got '${formatted}'`);
  const parsed = parseWallId(str);
  check(`parse  ${str.padEnd(30)}`,
    parsed
    && parsed.scope === tag.scope
    && parsed.kind === tag.kind
    && (tag.side === undefined || parsed.side === tag.side)
    && (tag.edgeIdx === undefined || parsed.edgeIdx === tag.edgeIdx)
    && (tag.enclosureIdx === undefined || parsed.enclosureIdx === tag.enclosureIdx),
    JSON.stringify(parsed));
}

// Predicate truth table.
check('isParentWall(parent_wall_north)',           isParentWall({ scope: 'parent', side: 'north', kind: 'wall' }));
check('!isParentWall(parent_edge_3)',              !isParentWall({ scope: 'parent', kind: 'edge', edgeIdx: 3 }));
check('!isParentWall(parent_floor)',               !isParentWall({ scope: 'parent', kind: 'floor' }));
check('!isParentWall(arcade)',                     !isParentWall({ scope: 'arcade_roof', side: 'west', kind: 'ceiling' }));
check('!isParentWall(null)',                       !isParentWall(null));
check('!isParentWall(undefined)',                  !isParentWall(undefined));
check('isParentWallOrEdge(wall)',                  isParentWallOrEdge({ scope: 'parent', side: 'north', kind: 'wall' }));
check('isParentWallOrEdge(edge)',                  isParentWallOrEdge({ scope: 'parent', kind: 'edge', edgeIdx: 1 }));
check('!isParentWallOrEdge(floor)',                !isParentWallOrEdge({ scope: 'parent', kind: 'floor' }));
check('isOverheadRoof(arcade)',                    isOverheadRoof({ scope: 'arcade_roof', side: 'west', kind: 'ceiling' }));
check('isOverheadRoof(portico)',                   isOverheadRoof({ scope: 'portico_roof', side: 'south', kind: 'ceiling' }));
check('!isOverheadRoof(parent_wall)',              !isOverheadRoof({ scope: 'parent', side: 'north', kind: 'wall' }));
check('isEnclosureWall(enc edge)',                 isEnclosureWall({ scope: 'enclosure', enclosureIdx: 0, kind: 'edge', edgeIdx: 1 }));
check('!isEnclosureWall(enc floor)',               !isEnclosureWall({ scope: 'enclosure', enclosureIdx: 0, kind: 'floor' }));

// Malformed inputs MUST round-trip to null / false instead of throwing.
check('parseWallId(garbage) → null',               parseWallId('not_a_wallid') === null);
check('parseWallId(\"\") → null',                  parseWallId('') === null);
check('parseWallId(null) → null',                  parseWallId(null) === null);
check('parseWallId(undefined) → null',             parseWallId(undefined) === null);
check('formatWallId({}) → null',                   formatWallId({}) === null);
check('formatWallId(null) → null',                 formatWallId(null) === null);
check('formatWallId({scope:parent, kind:wall, no side}) → null',
  formatWallId({ scope: 'parent', kind: 'wall' }) === null);
check('formatWallId({scope:enclosure, no idx}) → null',
  formatWallId({ scope: 'enclosure', kind: 'floor' }) === null);

// End-to-end smoke: every crossing emitted by wallsCrossedByPath on the
// surau preset MUST carry a non-null wallTag whose formatWallId(...)
// round-trips to crossing.wallId.
import { readFileSync } from 'node:fs';
globalThis.localStorage = (() => {
  const _s = {};
  return { getItem: (k) => _s[k] ?? null, setItem: (k, v) => { _s[k] = String(v); }, removeItem: (k) => { delete _s[k]; } };
})();
const { wallsCrossedByPath } = await import('../js/physics/wall-path.js');
const W = 18, D = 17.7, H = 4.5;
const room = {
  shape: 'rectangular', width_m: W, depth_m: D, height_m: H, enclosure: 'outdoor',
  surfaces: {
    floor: 'concrete-painted', ceiling: 'concrete-painted',
    wall_north: 'concrete-painted', wall_south: 'concrete-painted',
    wall_east:  'concrete-painted', wall_west:  'concrete-painted',
  },
  surauStructure: {
    arcade: { sides: ['south','east','west'], depth_m: 3, roof_height_m: 4.4 },
    materials: { arcade_roof: 'concrete-painted', podium_top: 'concrete-painted' },
    podium: { extension_m: 3 },
  },
};

const crossings = wallsCrossedByPath({ x: -1.2, y: 18.9, z: 7 }, { x: 1, y: -2, z: 1.7 }, room);
check('producer: returned ≥ 1 crossing for surau azan→south-arcade path', crossings.length >= 1, `got ${crossings.length} crossings`);

let allTagged = true;
let allRoundTrip = true;
for (const c of crossings) {
  if (!c.wallTag) { allTagged = false; console.log(`  missing tag for wallId='${c.wallId}'`); }
  else {
    const re = formatWallId(c.wallTag);
    if (re !== c.wallId) { allRoundTrip = false; console.log(`  round-trip mismatch: wallId='${c.wallId}' tag=${JSON.stringify(c.wallTag)} re='${re}'`); }
  }
}
check('producer: every crossing carries wallTag', allTagged);
check('producer: formatWallId(wallTag) === wallId for every crossing', allRoundTrip);

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}  ${failed === 0 ? 'all checks passed' : failed + ' failed'}`);
if (failed > 0) process.exit(1);
