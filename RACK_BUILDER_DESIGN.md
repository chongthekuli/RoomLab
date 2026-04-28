# PA Rack Builder — System Specification

**Author:** Felix Brandt, senior PA system integrator
**Status:** architecture, ready for engineering
**Convention:** bottom-up, U1 = floor, U-count grows upward. Imperial 19" inner, metric outer.

Build spec for RoomLAB's rack-builder. The user picks a rack size, drops Amperes amplifiers into slots, sees a live 3D rendering, then places the populated rack into the active preset. Round-trips via the existing `formatVersion: 1` schema — no version bump.

---

## 1. Rack catalogue — `data/racks/catalogue.json`

Open-frame 4-post racks only. No doors, no side panels. Outer width 600 mm (standard 19" + frame). 1 U = 44.45 mm. Frame top + bottom adds ~80 mm; castors add 100 mm.

```json
{
  "open-frame-12u":  { "u": 12, "outer_w_mm": 600, "outer_d_mm": 600,  "outer_h_mm": 714,  "weight_kg": 22, "castors": true },
  "open-frame-18u":  { "u": 18, "outer_w_mm": 600, "outer_d_mm": 800,  "outer_h_mm": 981,  "weight_kg": 28, "castors": true },
  "open-frame-24u":  { "u": 24, "outer_w_mm": 600, "outer_d_mm": 800,  "outer_h_mm": 1248, "weight_kg": 34, "castors": true },
  "open-frame-33u":  { "u": 33, "outer_w_mm": 600, "outer_d_mm": 1000, "outer_h_mm": 1648, "weight_kg": 46, "castors": true },
  "open-frame-42u":  { "u": 42, "outer_w_mm": 600, "outer_d_mm": 1000, "outer_h_mm": 2049, "weight_kg": 58, "castors": false }
}
```

Inner 19" rail mounting width is fixed 482.6 mm; mountable depth = outer_d − 100 mm. Each entry also carries `post_section_mm: 40`, `frame_top_mm: 40`, `frame_bottom_mm: 40`, `castor_h_mm: 100` for the renderer.

---

## 2. State shape

Add ONE new key to `state` — `rackSystem`. Lives alongside `sources`, round-trips via the existing schema-v1 (new optional fields are a permitted superset, no version bump).

```js
state.rackSystem = {
  racks: [
    {
      id: 'R1',
      label: 'Main rack',
      rackModelKey: 'open-frame-24u',
      position: { x: 0, y: 0, z: 0 },     // metres, foot-centre on floor
      yaw_deg: 0,                          // facing direction (front face normal)
      slots: [
        {
          uStart: 2,                       // 1-indexed from bottom
          uHeight: 2,
          amplifierId: 'amperes-pa1240',
          label: 'Zone A — front fills',
          channelAssignments: [
            { ch: 1, zoneId: 'Z1', tap_w: 60 },
            { ch: 2, zoneId: 'Z1', tap_w: 60 },
            { ch: 3, zoneId: 'Z2', tap_w: 60 },
            { ch: 4, zoneId: null, tap_w: 0 }
          ]
        }
      ]
    }
  ]
};
```

Serialiser: extend `serializeProject` to emit `rackSystem` (deep-cloned). `deserializeProject` accepts the key as optional — if absent, defaults to `{ racks: [] }`. `applyPresetToState` resets `state.rackSystem.racks = []` then overlays preset defaults (§8). On any preset/template swap, emit `scene:reset` as already wired.

`tests/project.test.mjs` gets ONE new case: round-trip a 33U rack populated with 4 amps, verify byte-equal after deserialise.

---

## 3. New viewport tab

`index.html`:

```html
<button class="vp-tab" data-view="rack" title="PA Rack — assemble amplifier rack and place in room — shortcut 5">PA Rack</button>
<div id="view-rack" class="viewport-view" hidden>
  <div class="rack-builder">
    <aside class="rack-col-left">  <!-- catalogues --> </aside>
    <section class="rack-col-mid"> <!-- 3D preview canvas --> </section>
    <aside class="rack-col-right"> <!-- selected slot details --> </aside>
  </div>
</div>
```

CSS grid `300px 1fr 320px`. Left column has two stacked cards: "Rack frames" (5 thumbnails) and "Amplifiers" (filterable by category: ducked-line, mixer-amp, multi-channel, DSP). Centre is its own Three.js scene — dark background `#1a1d22`, OrbitControls, brushed-aluminium PBR. Right column shows slot detail OR a summary card when nothing is selected (total power W, total weight kg, U used / total, heat dissipation W).

Mount file: `js/ui/panel-rack.js`. Uses the same panel-mount pattern as `panel-room.js` — innerHTML template, event delegation, subscribes to `scene:reset` for full rebuild and `rack:changed` for incremental. Three.js scene lives in `js/graphics/rack-scene.js` (parallel to `scene.js` but isolated — no shared groups, own dispose lifecycle).

---

## 4. Interaction flow

a. Click rack thumbnail → centre scene rebuilds, empty frame.
b. Drag amp tile from left column into a slot. Touch fallback: tap empty slot (highlights green), tap amp tile (places). Both paths use the same `placeAmplifier(rackId, uStart, ampId)` reducer.
c. Snap-to-U: vertical cursor position quantises to integer U. Reject (red flash + tooltip "needs N U free, has M") if `uHeight > free`.
d. Right column shows per-channel dropdown: zone target, tap power (70/100 V) or low-Z, label. Auto-populates from `state.zones`.
e. Validation banner across the top of the centre column — recomputed on every state mutation:
   - `N zones unassigned` (zones with no driving channel)
   - `N amp channels unused` (channels with `zoneId: null`)
   - `Thermal budget exceeded — N W dissipation in M U rack, recommend N free U for airflow`
   - `Class-AB amp in voice-alarm rack` — hard-block if any rack contains an amp tagged `compliance: 'voice-alarm'` paired with a Class-AB amp.
f. Bottom bar: **Place in room** (primary) and **Discard rack**. Place writes to `state.rackSystem.racks`, emits `scene:reset`, switches viewport to 3D.

---

## 5. 3D rendering — amplifier

Per amp: `BoxGeometry(0.4826, 0.04445 * uHeight, depth_m)`. Depth from amp spec, default 0.42 m. Group origin at slot centre.

Front-panel children:
- **Brand wordmark** — reuse `getAmperesTextTexture()` from `scene.js:3957`. Plane on front face, height 18 mm.
- **Model label** — new CanvasTexture per amp model (cached in a `Map`, same pattern as `_shopBrandTexCache`). White-on-dark, 14 mm high.
- **LEDs** — 2–4 emissive `SphereGeometry(0.003)` dots, colour from amp state (green = on, amber = signal, red = clip). Default green-only at idle.
- **Channel knobs** — `CylinderGeometry(0.012, 0.012, 0.008)` count = amp channel count, evenly spaced bottom edge of front panel.
- **Vents** — repeating dark stripes via material AO, no geometry.

Body colour by category — `MeshStandardMaterial`:
- multi-channel install: `#1f2125` (matte charcoal)
- mixer-amp: `#2a2a32`
- DSP: `#1a1a20` with subtle blue accent strip
- monitor amp (studio): `#101013`

Class-AB amps (if Carmen's catalogue contains any) render with a small amber warning badge on the right of the front panel — they will not be placed by default racking but the user can override.

## 6. 3D rendering — rack frame

Open frame, four 40 × 40 mm vertical posts at the four outer corners. Material: brushed aluminium — `MeshStandardMaterial` with `metalness: 0.85, roughness: 0.5`, base `#3a3d42`. Top and bottom horizontal beams 40 × 40 mm. U-marked side rails: short 2 mm-wide etch dashes every U on the inner face of the front posts (visual cue, not interactive).

Castors at base: four `CylinderGeometry(0.05, 0.05, 0.04)` rotated to roll-axis horizontal, body matte black `#0d0d0f`. Castor height (100 mm) is part of outer height — speakers/cabinets sit ABOVE the bottom beam, the castors raise the whole assembly off the floor.

No door, no side panels. Cable-management U slot reserved at U1 (renders as an empty crosshatched panel — visual only). Empty slots show a faint outline so the user can see what's available.

## 7. Room integration

When the user clicks **Place in room**:

1. Append rack record to `state.rackSystem.racks` with default `position` = front-corner 0.6 m off the side wall, 0.6 m off the rear wall. Sensible because that's where AV racks go in real rooms.
2. Emit `scene:reset` — main `scene.js` rebuilds and the new `racksGroup` (added next to `sourcesGroup`) renders the populated rack.
3. Switch viewport tab to 3D.
4. Repositioning: 2D plan view drag (in `view-2d`) — the rack appears as a shaded rectangle the user can pull. Discouraged in 3D because clicks already mean source-aim. Snap to 0.1 m grid.
5. Auto-wiring: when an amp channel has `zoneId` set and that zone has speakers, draw a thin grey line in 3D from rack to zone centroid (off by default, behind a "show wiring" toggle). For the Pavilion 88-ceiling-speaker case, evenly partition the 88 across the assigned channels' zones.
6. Print report: extend `print-report.js` with a new section **Equipment racks** — one table per rack, columns U / Model / Channels / Power / Zones driven / Heat (W).

## 8. Default racking per preset

Sized to actual coverage SPL + 10 dB headroom. No future-proofing oversize. Class-D throughout. Pavilion has pooled redundancy (one spare amp covering any failed zone) because mall = life-safety territory under MS IEC 60849.

| Preset | Rack | Default content |
|---|---|---|
| **auditorium** (sports arena) | 33U | 4× `<TBD: 4-ch 1200 W Class-D, low-Z>` for line-array hangs, 1× `<TBD: 2-ch 800 W>` front-fills, 1× DSP processor, 1U network monitor, 4U cable mgmt + free for airflow |
| **pavilion** (mall, 88 ceiling spkrs / 8 zones) | 33U | 6× `<TBD: 4-ch 70 V 240 W Class-D>` (24 channels, 11 spkrs/ch avg, 8 zones + 16 spare ch for pooled redundancy), 1× `<TBD: 8-in 16-out DSP>`, 1U Dante monitor, 1U PDU, 4U free |
| **hifi** | 12U | 1× `<TBD: 2-ch 80 W Class-D low-Z>`, 1U source/streamer, 4U free |
| **studio** | 12U | 1× `<TBD: 2-ch monitor amp>`, 1× audio interface 1U, 1× patchbay 1U, 6U free |
| **livevenue** | 24U | 4× `<TBD: 2-ch 600 W Class-D>` (FOH L/R, subs, monitor mix), 1× DSP, 1U PDU, 4U free |
| **classroom** | 18U | 1× `<TBD: 4-ch 60 W mixer-amp 100 V>`, 1U source, 6U free |
| **recitalhall** | 18U | 2× `<TBD: 2-ch 250 W Class-D low-Z>`, 1× DSP, 5U free |
| **chamber** | 18U | 2× `<TBD: 2-ch 150 W Class-D low-Z>`, 1× DSP, 6U free |
| **octagon** | 18U | 2× `<TBD: 4-ch 240 W 70 V Class-D>` (8 zones around the perimeter), 1× DSP, 4U free |
| **rotunda** | 18U | 2× `<TBD: 4-ch 240 W 70 V Class-D>`, 1× DSP, 4U free |

Implementing engineer fills `<TBD>` model numbers from Carmen's catalogue once it lands. Until then the slots render with the placeholder text on the front panel — installers hate guessing, users see exactly what's missing.

---

## 9. Implementation order

- **C1 — data + state + tests.** Add `data/racks/catalogue.json`. Wire `state.rackSystem`. Extend `serializeProject` / `deserializeProject` / `applyPresetToState` (reset to `[]`). Extend `tests/project.test.mjs` with the 33U-with-4-amps round-trip case. No UI yet.
- **C2 — 3D rendering only.** New `js/graphics/rack-scene.js` (isolated scene) + extend `js/graphics/scene.js` to render `state.rackSystem.racks` inside a new `racksGroup`. Inject test rack via state mutation, verify both views render.
- **C3 — PA Rack viewport tab.** New `view-rack` view, `js/ui/panel-rack.js`, three-column layout, left-column catalogues populated from the data files, centre 3D preview reusing rack-scene, right-column summary. No drag yet.
- **C4 — drag/drop + slot wiring + validation.** Snap-to-U placement, channel-to-zone dropdowns, validation banner, hard-block on Class-AB-in-voice-alarm.
- **C5 — Place in room + print BOM + default racking.** "Place in room" reducer, 2D plan drag-repositioning, print-report Equipment racks section, default racks per preset (§8).

---

## 10. The one thing engineering must NOT cut

**Channel-to-zone validation.**

Without it the user assembles a rack, places it in a room, and the system can't tell them whether their zones are driven. That's the difference between a PA system and a box of expensive amps wired to nothing. Every other feature in this spec — 3D preview, drag-drop, print BOM — is presentation. Cut the LED dots, cut the wiring lines, cut the cable-management slot, but keep the red validation banner. Without it we ship furniture, not a tool.

— Felix Brandt
