# Rack Outlook — Delta Spec for the 19" Open-Frame Render

**Sofia Calderón, Senior Art Director.** Stop the rack reading as scaffolding without closing it in. Spec is paste-ready against `js/graphics/rack-render.js`.

---

## 1. Reference scan

- **Middle Atlantic RFR Reference** ([legrandav.com](https://www.legrandav.com/products/racks/mobile/rfr_reference_furniture_rack)) — closed top plate + numbered rackrail. The top is a finished surface, not air.
- **Middle Atlantic SLIM-5 / 5-43** ([rackmountsolutions.net](https://www.rackmountsolutions.net/middle-atlantic-5-43-slim-5-rack-43u-4-post-rack/)) — deep front-to-rear top crossbars cap the frame. Posts read as a cage, not parallel sticks.
- **Penn Elcom Modular Open** ([penn-elcom.com](https://www.penn-elcom.com/us/19-inch-racking/cabinets-enclosures/open-tower-racks/modular-open-rack)) — rails are visibly distinct from posts: different inset, holes catch light.
- **APC NetShelter AR203A** ([apc.com](https://www.apc.com/us/en/product/AR203A/netshelter-4-post-open-frame-rack-44u-square-holes)) — every U labelled on the rail. The rack tells you what it is at a glance.
- **Caymon DPR942** ([caymon.eu](https://caymon.eu/products/d/dpr942---4-post-19inch-open-frame-rack---42-units---550~1015-mm-depth)) — RAL 9004 powder, square cage-nut holes, printed U-indicators. Reads as **two materials**, not one.

---

## 2. Diagnosis

1. **No 19" mounting rails.** Amps float — nothing physical connects them to the frame.
2. **Bottom is air.** Visible gap under U1; no base plate or L-bracket closing the foot.
3. **Top is air.** Frame ends in a 40 mm beam. No crown.
4. **Castors are bare cylinders.** No swivel bracket, no fork, no bolt-stem.
5. **One material everywhere.** Frame, beams, posts all `0x3a3d42`. Real racks contrast rails-vs-frame.
6. **No human-scale signals.** No U-numbers, no cage-nut hole pattern, no label plate.

---

## 3. Amendment spec — geometry to add

Dimensions in mm; convert to metres in code. Origin = base centre, +Z = rear.

### 3.1 19" mounting rails — **MUST**
- Two vertical Box meshes, **front pair** (rear pair optional).
- 25 mm × 6 mm × `(outerH − frameTop − frameBottom − castorH)` tall.
- Inset 18 mm behind front-post inner face; centre-to-centre 465 mm (inner edge = 482.6 mm rail standard).
- Material: frame steel (§4).
- **Cage-nut CanvasTexture** on front face only: 1U tile (25 × 44.45 mm) = 3 black rounded squares 9 × 9 mm on rail-coloured ground. `wrapT = RepeatWrapping`, `repeat.y = uCount`. Do NOT cut geometry.

### 3.2 Top crossbars (front-to-rear) — **MUST**
- Two Box meshes connecting front-post-top to rear-post-top.
- 30 × 30 × `(outerD − 2·postW)`.
- y = `outerH − frameTop/2`; x = ±(outerW/2 − postW/2). Frame steel.
- *Single highest-leverage cap-the-frame move.*

### 3.3 Top cap plate — **MUST**
- Box `outerW × 6 × outerD`, centred at y = `outerH − 3`.
- Frame steel; bump roughness to 0.6 (less specular than rails).

### 3.4 Bottom base plate — **MUST**
- Box `(outerW − 2·postW) × 4 × (outerD − 2·postW)`, sitting on the bottom beams (y = `castorH + 2`).
- Matte black (§4). Reads as the cable-tray base.

### 3.5 Castor brackets — **MUST**
- Box housing 60 × 40 × 60 mm wrapping each existing castor cylinder, top at y ≈ `castorH − 30`.
- Bolt-stem: Cylinder r=6, h=30, between bottom beam and bracket top. Frame steel.
- Bracket: matte black. Existing wheel cylinder stays.

### 3.6 Cable-management U at U1 — **MUST**
- Box `RAIL_INNER_W × U_HEIGHT × 12`, sitting between the two front rails at U1 centre.
- Matte black, with small CanvasTexture label "CABLE MGMT" 8 pt right-aligned.

### 3.7 U-numbering — **NICE-TO-HAVE**
- Bake into the same CanvasTexture as 3.1: 6 pt sans, `#9a9a9a`, every 5th U only (1, 5, 10, …).

### 3.8 Top branding plate — **NICE-TO-HAVE**
- Plane 80 × 16 mm on front face of top cap, centred, 8° forward tilt.
- CanvasTexture: "ROOMLAB" 9 pt, letter-spacing 0.08em, `#d4d4d8` on transparent. **Not Amperes** — rack vendor is generic.

---

## 4. Material discipline — two materials, two hex

| Slot | Hex | metalness | roughness | Used on |
|---|---|---|---|---|
| Brushed steel (frame) | `#52555b` | 0.78 | 0.42 | posts, beams, top cap, top crossbars, rails, castor stems |
| Matte black (powder) | `#15161a` | 0.10 | 0.78 | base plate, castor brackets, cable-mgmt panel, branding ground, wheels |

Current `#3a3d42` is too dark + too desaturated — flat slab in print. `#52555b` reads as steel. Black raised from `#0d0d0f` to `#15161a` so the silhouette doesn't punch a hole in greyscale. L\* values 36 vs 9 — clean separation desaturated.

---

## 5. Refuse

- No RGB / emissive on the frame. Green LEDs on amp faces are the only accent; a second accent kills the first.
- No gradient, "carbon fibre," or chrome. Metalness ≤ 0.78.
- No fake screws/rivets as geometry — bake into texture if anywhere.
- No glass door, no side panels. Open-frame stays open.
- No Amperes branding on the rack. Amperes goes on the amps.

---

## 6. One thing engineering must NOT cut

**§3.1 — the front 19" mounting rails with the cage-nut CanvasTexture.**

If the top cap, branding, U-numbers, and U1 cable panel all slip, the rack still reads as a rack — because the amps now visibly bolt to *something*. Without the rails, every other addition is decoration on scaffolding. Ship the rails first.

— *Sofia*
