const { contextBridge } = require("electron");

function argValue(prefix) {
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : "";
}

const root = argValue("--emperor-root=") || process.env.EMPEROR_AGENT_ROOT || "";
const webuiUrl = argValue("--emperor-webui-url=") || process.env.EMPEROR_WEBUI_URL || "http://127.0.0.1:8765";
const assetBaseUrl = argValue("--emperor-asset-base-url=");
const backendToken = argValue("--emperor-backend-token=") || process.env.EMPEROR_WEBUI_TOKEN || "";

contextBridge.exposeInMainWorld("emperorPet", {
  root,
  webuiUrl,
  assetBaseUrl,
  backendToken,
});
