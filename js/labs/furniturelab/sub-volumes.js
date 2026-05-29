// sub-volumes — MOVED to js/physics/furniture-sub-volumes.js.
//
// This is pure acoustic geometry (catalogue row → axis-aligned sub-bounding
// boxes for the precision tracer), consumed only by the engine, so it now
// lives on the engine side. This stub re-exports it so existing FurnitureLAB
// / test imports keep working unchanged.
export * from '../../physics/furniture-sub-volumes.js';
