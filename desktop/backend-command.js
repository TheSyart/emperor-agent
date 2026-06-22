const fs = require("fs");
const path = require("path");

function defaultFileExists(p) {
  return fs.existsSync(p);
}

// Build the argv used to spawn the aiohttp backend. The trailing flags map
// directly onto agent/webui.py's argparse (--host / --port / --no-open).
function buildBackendCommand({ config, env = {}, fileExists = defaultFileExists } = {}) {
  const tailArgs = ["web", "--host", config.host, "--port", String(config.port), "--no-open"];

  const override = typeof env.EMPEROR_BACKEND_CMD === "string" ? env.EMPEROR_BACKEND_CMD.trim() : "";
  if (override) {
    const [command, ...baseArgs] = override.split(/\s+/);
    return { command, args: [...baseArgs, ...tailArgs] };
  }

  const venvBinary = path.join(config.root, ".venv", "bin", "emperor-agent");
  if (fileExists(venvBinary)) {
    return { command: venvBinary, args: tailArgs };
  }

  return { command: "emperor-agent", args: tailArgs };
}

module.exports = { buildBackendCommand };
