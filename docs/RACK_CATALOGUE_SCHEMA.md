# Rack catalogue schema

Canonical reference for `data/racks/catalogue.json`. Read when adding a rack row, when writing a loader, or when computing the rack's acoustic contribution.

Current schema: **2.0** (bumped 2026-05-27 for the enclosed-cabinet family).

## File shape

```
{
  "schema_version": "2.0",
  "_notes": "<free-form provenance string>",
  "racks": {
    "<row-key>": { <row object> },
    ...
  }
}
```

The row key is a stable identifier persisted in user-saved scenes (`rackModelKey`). Never rename a key once shipped — existing projects pin to it. Add new rows; deprecate old ones via the `legacy` flag.

## Row fields

All fields are required on every row unless marked optional.

### Identity and dimensions

| Field | Type | Unit | Description |
|---|---|---|---|
| `label` | string | — | Human-readable picker label, e.g. "24U enclosed (mesh-glass door)". Shown verbatim in the DeviceLAB rack dropdown. |
| `u` | integer | rack units | Mounting height in U. 1 U = 44.45 mm (EIA-310-D). |
| `outer_w_mm` | number | mm | External width including side posts / panels. 600 mm is the canonical 19" rack width (482.6 mm rails + 40 mm post each side + 18.4 mm panel allowance). |
| `outer_d_mm` | number | mm | External depth front-to-rear including doors. Typical: 600 mm short, 800 mm standard, 1000 mm deep. |
| `outer_h_mm` | number | mm | External height including castors and door frame, excluding any roof-mounted fan tray. |
| `weight_kg` | number | kg | Empty cabinet mass. Excludes mounted equipment. Used by FurnitureLAB load-bearing checks. |

### Frame geometry

| Field | Type | Unit | Description |
|---|---|---|---|
| `post_section_mm` | number | mm | Cross-section of the corner posts (square section assumed). Drives 3D mesh extrusion in slice 2. |
| `frame_top_mm` | number | mm | Vertical extent of the top frame band above the topmost U. |
| `frame_bottom_mm` | number | mm | Vertical extent of the bottom frame band below the lowermost U. |
| `castor_h_mm` | number | mm | Castor height. Zero when `castors: false`. Otherwise typically 100 mm. |
| `castors` | bool | — | True if the row ships on castors. |

### Enclosure (schema 2.0)

| Field | Type | Description |
|---|---|---|
| `style` | "enclosed" \| "open-frame" | Whether the row is a closed cabinet or a 4-post frame. Drives 3D mesh family selection (slice 2) and acoustic-treatment defaults (slice 4). |
| `front_door` | object | See "Door object" below. Open-frame rows use `{type: "none", ...}`. |
| `rear_door` | object | See "Door object" below. Open-frame rows use `{type: "none", ...}`. |
| `side_panels` | bool | True = full steel side panels (enclosed). False = open sides (open-frame). |
| `vent_top_pct` | number 0–100 | Percentage of the top plate that is open vent. Open-frame = 100 (no plate). Enclosed cabinets typically 30–50 (vent strip with fan provisions). |
| `vent_bottom_pct` | number 0–100 | Percentage of the bottom plate that is open vent. Open-frame = 100. Most enclosed cabinets = 0 (solid bottom, top-exhaust convention). |
| `legacy` | bool | True ONLY for rows kept for backward compatibility with saved scenes. The DeviceLAB picker filters `legacy: true` out of the new-rack dropdown but loaders still resolve them so old projects open without breaking. New enclosed rows omit or set false. |

### Door object

Used for both `front_door` and `rear_door`.

| Field | Type | Description |
|---|---|---|
| `type` | "mesh-glass" \| "perforated-steel" \| "solid-steel" \| "none" | Door construction. "none" means no door fitted (open frame, or rear access via cable cutout only). |
| `perforation_pct` | number 0–100 | Open-area percentage. Drives Dr. Chen's Maa micro-perforation absorber model (slice 4) and Viktor's transparency / occlusion treatment (slice 2). Conventions: solid-steel = 0, perforated-steel ~ 50, mesh-glass ~ 63, none = 100 (treated as fully open). |
| `glass` | bool | True if the door incorporates a glass panel (visual cue for the 3D mesh; not an acoustic input — `perforation_pct` carries the acoustic signal). |

## Cross-cutting consumers

- **DeviceLAB picker** (slice 3, `js/labs/devicelab/panel-rack.js`) — filters `legacy: true` out of the new-rack dropdown. Loaders for existing scenes still resolve legacy keys.
- **3D mesh** (slice 2, Viktor) — reads `style`, both door objects, `side_panels`, `vent_*_pct`, `glass` to pick the mesh family and material set.
- **Acoustic contribution** (slice 4, Dr. Chen) — reads `front_door.perforation_pct`, `rear_door.perforation_pct`, `side_panels`, `vent_top_pct`, `vent_bottom_pct` to compute the rack's effective absorption and re-radiation. Side panels likely add a hard-reflector surface; perforated doors feed the Maa micro-perforation model.
- **Print report** — uses `label` and `style` for the equipment schedule.

## Provenance

The enclosed family in schema 2.0 follows the StarTech RK4236BKB cabinet line (front mesh-glass door, perforated-steel rear, full steel side panels, four castors). Datasheet: <https://docs.rs-online.com/7587/A700000013628008.pdf>. Where the datasheet PDF was not parseable at write time, dimensions follow generic 19" enclosed-cabinet conventions (600 mm wide, 800 mm deep at 12–24 U, 1000 mm deep at 33–42 U, +27 mm height for the door frame on top of the per-U math).

## Changelog

- **2.0 (2026-05-27)** — added enclosed-cabinet fields (`style`, `front_door`, `rear_door`, `side_panels`, `vent_top_pct`, `vent_bottom_pct`, `legacy`). Added five enclosed rows (`enclosed-12u/18u/24u/33u/42u`). All five original open-frame rows tagged `legacy: true` with `style: "open-frame"` and vent fields set to 100; their pre-existing dimensions are unchanged.
- **1.0** — initial open-frame catalogue per Felix Brandt's spec (RACK_BUILDER_DESIGN.md §1). Five rows: `open-frame-12u/18u/24u/33u/42u`.
