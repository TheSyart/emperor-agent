const { contextBridge } = require("electron");

// Minimal, read-only surface. The WebUI is served same-origin from the backend
// and does not depend on this bridge; it only exposes desktop metadata for a
// future "about" panel. No Node APIs are exposed to the renderer.
contextBridge.exposeInMainWorld("emperorDesktop", {
  version: "0.1.0",
  platform: process.platform,
});
