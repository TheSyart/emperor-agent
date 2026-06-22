const test = require("node:test");
const assert = require("node:assert/strict");

const pkg = require("../package.json");

test("package.json declares the desktop shell metadata", () => {
  assert.equal(pkg.name, "emperor-agent-desktop");
  assert.equal(pkg.main, "main.js");
  assert.equal(pkg.type, "commonjs");
});

test("package.json wires the node:test runner and electron start", () => {
  assert.ok(pkg.scripts, "scripts block is required");
  assert.match(pkg.scripts.test, /node --test/);
  assert.equal(pkg.scripts.start, "electron .");
});

test("package.json depends on electron", () => {
  assert.ok(pkg.dependencies && pkg.dependencies.electron, "electron dependency is required");
});
