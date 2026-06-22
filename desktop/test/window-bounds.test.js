const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeBounds,
  readBounds,
  pickBounds,
  DEFAULT_BOUNDS,
  MIN_BOUNDS,
} = require("../window-bounds.js");

test("normalizeBounds returns the default size with no position when given nothing", () => {
  assert.deepEqual(normalizeBounds({}), { ...DEFAULT_BOUNDS });
});

test("normalizeBounds raises sub-minimum sizes to the minimum", () => {
  const b = normalizeBounds({ width: 100, height: 100 });
  assert.equal(b.width, MIN_BOUNDS.width);
  assert.equal(b.height, MIN_BOUNDS.height);
});

test("normalizeBounds preserves a valid position", () => {
  assert.deepEqual(normalizeBounds({ width: 1400, height: 900, x: 10, y: 20 }), {
    width: 1400,
    height: 900,
    x: 10,
    y: 20,
  });
});

test("normalizeBounds drops a partial/invalid position", () => {
  const b = normalizeBounds({ width: 1400, height: 900, x: NaN, y: 20 });
  assert.equal("x" in b, false);
  assert.equal("y" in b, false);
});

test("readBounds falls back to defaults when the file cannot be read", () => {
  const readFile = () => {
    throw new Error("ENOENT");
  };
  assert.deepEqual(readBounds("/nope/window.json", { readFile }), { ...DEFAULT_BOUNDS });
});

test("readBounds normalizes a stored payload", () => {
  const readFile = () => JSON.stringify({ width: 100, height: 100, x: 5, y: 6 });
  const b = readBounds("/x/window.json", { readFile });
  assert.equal(b.width, MIN_BOUNDS.width);
  assert.equal(b.x, 5);
});

test("pickBounds keeps only geometry fields", () => {
  assert.deepEqual(pickBounds({ x: 1, y: 2, width: 3, height: 4, extra: "drop" }), {
    x: 1,
    y: 2,
    width: 3,
    height: 4,
  });
});
