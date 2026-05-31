// Regression: walk-mode avatar must spawn INSIDE the room footprint.
//
// Bug (user report 2026-05-31): for certain custom-drawn rooms, entering Walk
// mode spawned the avatar OUTSIDE the polygon, over the void → free-fall.
// Root cause: scene.js placeAvatarAtDefault spawned at (width_m/2, depth_m/2).
// Custom polygons store their vertices wherever the user drew them (NOT
// anchored to a width×depth box at the origin), so that box-centre can be
// outside the polygon — no floor mesh beneath the avatar → free-fall (and the
// void-fall respawn reused the same bad point).
//
// Fix: placeAvatarAtDefault now spawns at defaultInsidePosition(room), which
// reads the actual vertices (centroid, with a concave-polygon inward-walk
// fallback). This test locks defaultInsidePosition for the failing cases and
// grep-guards that scene.js uses it (a Node test can't drive the Three.js
// walk controller directly).
//
// Run: node tests/walk-spawn-custom-room.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { defaultInsidePosition, isInsideRoom } from '../js/physics/room-shape.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let failed = 0;
function assert(cond, label) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed++; }
const inside = (p, room) => isInsideRoom(p.x, p.y, room);

// 1. The exact failure shape: a small polygon drawn in the corner of a large
//    coordinate space. (width/2, depth/2) is plainly OUTSIDE → was free-fall.
{
  const room = { shape: 'custom', width_m: 30, depth_m: 30,
    custom_vertices: [{ x: 1, y: 1 }, { x: 6, y: 1 }, { x: 6, y: 6 }, { x: 1, y: 6 }] };
  assert(!inside({ x: 15, y: 15 }, room), 'box-centre (w/2,d/2)=(15,15) is OUTSIDE the offset polygon (the bug condition)');
  const spawn = defaultInsidePosition(room);
  assert(inside(spawn, room), `defaultInsidePosition ${JSON.stringify(spawn)} is INSIDE the offset polygon`);
}

// 2. Offset convex polygon (house-shape, like the user's screenshot). Centroid
//    is inside → returned directly.
{
  const room = { shape: 'custom', width_m: 16, depth_m: 9,
    custom_vertices: [{ x: 2, y: 1 }, { x: 14, y: 2 }, { x: 15, y: 6 }, { x: 9, y: 8 }, { x: 3, y: 7 }, { x: 1.5, y: 4 }] };
  assert(inside(defaultInsidePosition(room), room), 'convex offset custom polygon → spawn inside');
}

// 3. Concave (L-shaped) polygon — centroid falls in the notch (outside). The
//    inward-walk fallback must still return an interior point.
{
  const room = { shape: 'custom', width_m: 10, depth_m: 10,
    custom_vertices: [
      { x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 8 }, { x: 0, y: 8 },
    ] };
  const spawn = defaultInsidePosition(room);
  assert(inside(spawn, room), `concave L-room → spawn ${JSON.stringify(spawn)} inside (not in the notch)`);
}

// 4. No regression for the standard shapes — still (width/2, depth/2).
{
  const rect = { shape: 'rectangular', width_m: 20, depth_m: 12 };
  const p = defaultInsidePosition(rect);
  assert(p.x === 10 && p.y === 6, 'rectangular room spawn unchanged = (width/2, depth/2)');
}

// 5. scene.js placeAvatarAtDefault uses defaultInsidePosition, NOT the old
//    (width_m/2, depth_m/2) box assumption.
{
  const sceneSrc = readFileSync(join(__dirname, '..', 'js', 'graphics', 'scene.js'), 'utf8');
  const fn = sceneSrc.slice(sceneSrc.indexOf('function placeAvatarAtDefault'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert(/defaultInsidePosition\s*\(\s*room\s*\)/.test(body),
    'placeAvatarAtDefault spawns at defaultInsidePosition(room)');
  assert(!/\(room\.width_m\s*\?\?\s*20\)\s*\/\s*2/.test(body),
    'placeAvatarAtDefault no longer uses the (width_m/2, depth_m/2) box-centre');
}

if (failed) { console.log(`\n${failed} test(s) FAILED.`); process.exit(1); }
console.log('\nAll walk-spawn-custom-room tests passed.');
