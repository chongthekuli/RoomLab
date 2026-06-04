// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Copyright (c) 2026 Chong Ching Yong (chongthekuli). All rights reserved.
// Part of nymphysics — licensed under PolyForm Shield 1.0.0 (see
// js/physics/LICENSE): read / study / adapt for any NON-competing use; you
// may NOT use it to provide a product that competes with AuraLAB.

// js/physics/wall-id.js
//
// WallTag — a tagged-object schema for the (scope, side, kind, edgeIdx)
// quadruple that wallsCrossedByPath emits per crossing. Replaces the
// stringly-typed `wallId` regex/startsWith protocol that Martina's
// 2026-05-24 code audit flagged as a refactor-safety hazard (audit §1.9,
// §2.A). The bug class it prevents: a future rename in the producer
// (e.g. `parent_wall_north` → `wall_north_parent`) silently changes
// every diffraction / reradiation / porch consumer's regex match
// result — no error, just a dimmer heatmap.
//
// **Strategy.** Producer (`wall-path.js`) emits `crossing.wallTag` next
// to the legacy `crossing.wallId` string. Consumers prefer the tag
// (`crossing.wallTag?.scope === 'parent'`) over `wallId.startsWith(...)`.
// The string `wallId` stays for debug logs, tests, and any consumer
// not yet migrated. The two forms are kept in sync via formatWallId /
// parseWallId helpers in this module.
//
// **Schema.**
//   {
//     scope:        'parent' | 'enclosure' | 'arcade_roof' | 'portico_roof',
//     enclosureIdx: number (only when scope === 'enclosure'),
//     side:         'north' | 'south' | 'east' | 'west' (parent walls, arcade/portico roofs),
//     kind:         'wall' | 'edge' | 'floor' | 'ceiling',
//     edgeIdx:      number (only when kind === 'edge'),
//   }
//
// **Examples.**
//   parent_wall_north           → { scope: 'parent', side: 'north', kind: 'wall' }
//   parent_wall_south           → { scope: 'parent', side: 'south', kind: 'wall' }
//   parent_floor                → { scope: 'parent', kind: 'floor' }
//   parent_ceiling              → { scope: 'parent', kind: 'ceiling' }
//   parent_edge_3               → { scope: 'parent', kind: 'edge', edgeIdx: 3 }
//   enc0_edge_5                 → { scope: 'enclosure', enclosureIdx: 0, kind: 'edge', edgeIdx: 5 }
//   enc0_floor                  → { scope: 'enclosure', enclosureIdx: 0, kind: 'floor' }
//   enc0_ceiling                → { scope: 'enclosure', enclosureIdx: 0, kind: 'ceiling' }
//   arcade_roof_west_ceiling    → { scope: 'arcade_roof', side: 'west', kind: 'ceiling' }
//   portico_roof_south_ceiling  → { scope: 'portico_roof', side: 'south', kind: 'ceiling' }

const SIDE_MAP = { north: 'north', south: 'south', east: 'east', west: 'west' };

// ---------------------------------------------------------------------------
// formatWallId(tag) — tag → canonical string. Mirrors the format used by
// wall-path.js's idPrefix logic so old string consumers keep working.
// ---------------------------------------------------------------------------
export function formatWallId(tag) {
  if (!tag || typeof tag !== 'object') return null;
  const { scope, enclosureIdx, side, kind, edgeIdx } = tag;
  if (!scope || !kind) return null;
  let prefix;
  if (scope === 'parent') prefix = 'parent';
  else if (scope === 'enclosure') {
    if (!Number.isFinite(enclosureIdx)) return null;
    prefix = `enc${enclosureIdx}`;
  } else if (scope === 'arcade_roof' || scope === 'portico_roof') {
    if (!SIDE_MAP[side]) return null;
    prefix = `${scope}_${side}`;
  } else {
    return null;
  }
  if (kind === 'wall') {
    if (!SIDE_MAP[side]) return null;
    return `${prefix}_wall_${side}`;
  }
  if (kind === 'edge') {
    if (!Number.isFinite(edgeIdx)) return null;
    return `${prefix}_edge_${edgeIdx}`;
  }
  if (kind === 'floor' || kind === 'ceiling') {
    return `${prefix}_${kind}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// parseWallId(str) — canonical string → tag. Returns null when the string
// doesn't match the expected schema. Useful for migrating older callers
// that still consume the string form (e.g. tests, debug helpers).
// ---------------------------------------------------------------------------
export function parseWallId(str) {
  if (typeof str !== 'string') return null;

  // arcade_roof_<side>_ceiling | portico_roof_<side>_ceiling
  let m = /^(arcade_roof|portico_roof)_(north|south|east|west)_(floor|ceiling)$/.exec(str);
  if (m) return { scope: m[1], side: m[2], kind: m[3] };

  // parent_wall_<side>
  m = /^parent_wall_(north|south|east|west)$/.exec(str);
  if (m) return { scope: 'parent', side: m[1], kind: 'wall' };

  // parent_edge_<i>
  m = /^parent_edge_(\d+)$/.exec(str);
  if (m) return { scope: 'parent', kind: 'edge', edgeIdx: Number(m[1]) };

  // parent_floor | parent_ceiling
  m = /^parent_(floor|ceiling)$/.exec(str);
  if (m) return { scope: 'parent', kind: m[1] };

  // enc<i>_wall_<side> (unused today but reserved for rectangular enclosures)
  m = /^enc(\d+)_wall_(north|south|east|west)$/.exec(str);
  if (m) return { scope: 'enclosure', enclosureIdx: Number(m[1]), side: m[2], kind: 'wall' };

  // enc<i>_edge_<j>
  m = /^enc(\d+)_edge_(\d+)$/.exec(str);
  if (m) return { scope: 'enclosure', enclosureIdx: Number(m[1]), kind: 'edge', edgeIdx: Number(m[2]) };

  // enc<i>_floor | enc<i>_ceiling
  m = /^enc(\d+)_(floor|ceiling)$/.exec(str);
  if (m) return { scope: 'enclosure', enclosureIdx: Number(m[1]), kind: m[2] };

  return null;
}

// ---------------------------------------------------------------------------
// Shorthand predicates — read better at call sites than `tag?.scope === 'X'`.
// All are null-safe: a missing/malformed tag returns false.
// ---------------------------------------------------------------------------
export function isParentWall(tag) {
  return tag?.scope === 'parent' && tag?.kind === 'wall';
}
export function isParentWallOrEdge(tag) {
  return tag?.scope === 'parent' && (tag?.kind === 'wall' || tag?.kind === 'edge');
}
export function isOverheadRoof(tag) {
  return tag?.scope === 'arcade_roof' || tag?.scope === 'portico_roof';
}
export function isEnclosureWall(tag) {
  return tag?.scope === 'enclosure' && (tag?.kind === 'wall' || tag?.kind === 'edge');
}
