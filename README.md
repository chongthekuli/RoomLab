# RoomLAB

Web-based acoustic room simulation and prediction, inspired by EASE.
Built as a Single Page Application using HTML5 + ES6 modules, with Three.js
for 3D visualization. Loudspeaker data uses an open JSON schema (no GLL).

## Run locally

Serve the project root with any static file server:

```
npx serve .
# or
python -m http.server 8000
```

Then open http://localhost:8000.

## Structure

See [docs/architecture.md](docs/architecture.md).

## Phase 1 status

Scaffold only. Phase 2 begins with RT60 (Sabine/Eyring) on a shoebox room.
