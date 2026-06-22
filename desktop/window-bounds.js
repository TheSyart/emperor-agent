const fs = require("fs");

// Full-workbench window sizing (deliberately larger than the desktop-pet floater).
const DEFAULT_BOUNDS = { width: 1280, height: 832 };
const MIN_BOUNDS = { width: 960, height: 640 };

function defaultReadFile(p) {
  return fs.readFileSync(p, "utf8");
}

function clampSize(value, fallback, min) {
  const n = Number(value);
  const base = Number.isFinite(n) ? n : fallback;
  return Math.max(Math.round(base), min);
}

// Produce Electron-ready bounds. Width/height are always present and never
// below MIN_BOUNDS; x/y are included only when both are finite numbers,
// otherwise omitted so Electron centers the window.
function normalizeBounds(raw = {}) {
  const bounds = {
    width: clampSize(raw.width, DEFAULT_BOUNDS.width, MIN_BOUNDS.width),
    height: clampSize(raw.height, DEFAULT_BOUNDS.height, MIN_BOUNDS.height),
  };
  if (Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
    bounds.x = Math.round(raw.x);
    bounds.y = Math.round(raw.y);
  }
  return bounds;
}

// Read persisted bounds; any read/parse failure yields the default size so the
// window always opens.
function readBounds(boundsPath, { readFile = defaultReadFile } = {}) {
  try {
    return normalizeBounds(JSON.parse(readFile(boundsPath)));
  } catch {
    return { ...DEFAULT_BOUNDS };
  }
}

// Keep only the geometry fields from an Electron getBounds() result before
// writing to disk.
function pickBounds(boundsLike = {}) {
  const { x, y, width, height } = boundsLike;
  return { x, y, width, height };
}

module.exports = {
  normalizeBounds,
  readBounds,
  pickBounds,
  DEFAULT_BOUNDS,
  MIN_BOUNDS,
};
