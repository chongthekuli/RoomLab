# Architecture

RoomLAB is a Single Page Application built with vanilla ES6 modules. No build
step required — it runs directly from static hosting (GitHub Pages).

## Folder tree

```
RoomLab/
├── index.html           SPA entry point
├── css/                 Layout + theme tokens
├── js/
│   ├── main.js          Bootstrap + module wiring
│   ├── app-state.js     Central state store
│   ├── physics/         Pure-function acoustic math (no DOM)
│   ├── graphics/        Three.js scene + visuals
│   └── ui/              DOM panels + pub/sub events
├── data/
│   ├── materials.json   Absorption coefficient library
│   └── loudspeakers/    JSON "virtual GLL" files
├── docs/                Documentation (you are here)
└── assets/              Icons, images
```

## Module boundaries

- **physics/** never touches the DOM. Can be unit-tested headless. Its
  public API is the **nymphysics** engine — import from
  [`js/physics/nymphysics.js`](../js/physics/nymphysics.js); derivations in
  [`docs/NYMPHYSICS.md`](./NYMPHYSICS.md).
- **graphics/** reads `app-state`, renders Three.js. Can be swapped out.
- **ui/** dispatches changes to `app-state` via `events.js` pub/sub.
- **main.js** is the only place that imports from all three.
