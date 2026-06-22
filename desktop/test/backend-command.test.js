const test = require("node:test");
const assert = require("node:assert/strict");

const { buildBackendCommand } = require("../backend-command.js");

const config = { root: "/repo", host: "127.0.0.1", port: 8765 };
const tailArgs = ["web", "--host", "127.0.0.1", "--port", "8765", "--no-open"];

test("uses the venv emperor-agent binary when present", () => {
  const fileExists = (p) => p === "/repo/.venv/bin/emperor-agent";
  const { command, args } = buildBackendCommand({ config, env: {}, fileExists });
  assert.equal(command, "/repo/.venv/bin/emperor-agent");
  assert.deepEqual(args, tailArgs);
});

test("falls back to PATH emperor-agent when no venv binary exists", () => {
  const { command, args } = buildBackendCommand({ config, env: {}, fileExists: () => false });
  assert.equal(command, "emperor-agent");
  assert.deepEqual(args, tailArgs);
});

test("EMPEROR_BACKEND_CMD overrides the binary and prepends its base args", () => {
  const { command, args } = buildBackendCommand({
    config,
    env: { EMPEROR_BACKEND_CMD: "python -m agent.webui" },
    fileExists: () => true,
  });
  assert.equal(command, "python");
  assert.deepEqual(args, ["-m", "agent.webui", ...tailArgs]);
});

test("a blank EMPEROR_BACKEND_CMD is ignored", () => {
  const { command } = buildBackendCommand({
    config,
    env: { EMPEROR_BACKEND_CMD: "   " },
    fileExists: () => false,
  });
  assert.equal(command, "emperor-agent");
});
