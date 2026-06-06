// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Copyright (c) 2026 Amperes Electronics SDN BHD. All rights reserved.
// Part of nymphysics — licensed under PolyForm Shield 1.0.0 (see
// js/physics/LICENSE).

// Unified walk-mode collision aggregator (2026-06-05).
//
// THE single place that answers "does any placeable SOLID object block the
// avatar cylinder here?" — furniture, device racks, building structures (and
// whatever solid type comes next). scene.js's ThirdPersonController calls ONLY
// this; it must never re-implement a per-type blocker inline again.
//
// Why this exists: the same bug recurred three times (rack → furniture →
// structure) because each new solid type had to be remembered in an inline
// `a() || b()` chain in scene.js, and nothing failed when it was forgotten.
// Now every solid type is wired HERE, and tests/walk-collision-registry.test.mjs
// enumerates each type THROUGH this function — so a new type that isn't added
// fails CI before it can ship walk-through. Adding a solid type = one line here
// + one line in the registry test.
//
// Room walls/floor/ceiling are handled separately by the controller's mesh
// raycast (roomGroup); this aggregator covers the PLACED solids that don't live
// in roomGroup.
//
// Pure / Node-testable. No DOM, no Three.js.

import { furnitureBlocksCylinder } from './furniture-walk-collision.js';
import { rackBlocksCylinder } from './rack-walk-collision.js';
import { structureBlocksCylinder } from './structure-walk-collision.js';

/**
 * @param {object} p
 * @param {number} p.sx avatar centre, state x
 * @param {number} p.sy avatar centre, state y (depth)
 * @param {number} p.yMin bottom of avatar cylinder, state z (m)
 * @param {number} p.yMax top of avatar cylinder, state z (m)
 * @param {number} p.radius avatar collision radius (m)
 * @param {Array}  [p.furniture]
 * @param {Map}    [p.furnitureCatalogue]
 * @param {Array}  [p.racks]
 * @param {object} [p.rackCatalogue]
 * @param {Array}  [p.structures]
 * @param {object} [p.room]
 * @returns {boolean} true if ANY placed solid blocks the cylinder
 */
export function sceneBlocksCylinder({
  sx, sy, yMin, yMax, radius,
  furniture, furnitureCatalogue,
  racks, rackCatalogue,
  structures, room,
}) {
  // Each registered solid type. To add a type: import its blocker above and
  // add it to this list (and to the registry test's enumeration).
  return (
    furnitureBlocksCylinder(sx, sy, yMin, yMax, radius, furniture, furnitureCatalogue)
    || rackBlocksCylinder(sx, sy, yMin, yMax, radius, racks, rackCatalogue)
    || structureBlocksCylinder(sx, sy, yMin, yMax, radius, structures, room)
  );
}
