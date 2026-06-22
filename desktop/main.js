const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const { resolveConfig } = require("./config.js");
const { buildBackendCommand } = require("./backend-command.js");
const { probeBackend, waitForBackend } = require("./health.js");
const { planStartup, planShutdown } = require("./lifecycle.js");
const { readBounds, pickBounds } = require("./window-bounds.js");

const config = resolveConfig({ argv: process.argv.slice(2), env: process.env });
const boundsPath = path.join(config.root, "memory", "desktop", "window.json");

let backendChild = null; // the process we spawned (null if we attached)
let ownsBackend = false; // whether we are responsible for reclaiming it
let backendReady = false; // flips true once waitForBackend resolves
let mainWindow = null;
let didLoadRetry = false;

function fail(title, message) {
  dialog.showErrorBox(title, message);
  reclaimBackend();
  app.quit();
}

function reclaimBackend() {
  const { shouldKill } = planShutdown({ ownsBackend, child: backendChild });
  if (!shouldKill) return;
  const child = backendChild;
  backendChild = null;
  try {
    child.kill("SIGTERM");
    // Hard-stop fallback if SIGTERM is ignored within the grace period.
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Process already gone; nothing to reclaim.
      }
    }, 2000);
  } catch {
    // If killing fails the OS will reap the child when we exit anyway.
  }
}

function spawnBackend() {
  const { command, args } = buildBackendCommand({ config, env: process.env });
  const child = spawn(command, args, {
    cwd: config.root,
    stdio: "inherit",
    env: process.env,
  });

  child.on("error", (err) => {
    if (err && err.code === "ENOENT") {
      fail(
        "无法启动后端",
        "未找到 emperor-agent 命令。请先在仓库根目录执行 `pip install -e .`，或设置环境变量 EMPEROR_BACKEND_CMD 指向可用的启动命令。",
      );
    } else {
      fail("无法启动后端", `启动后端进程失败：${err && err.message ? err.message : String(err)}`);
    }
  });

  child.on("exit", (code) => {
    // An exit before readiness means startup failed; after readiness it means
    // the user/OS stopped the backend and the shell should follow.
    if (!backendReady && code !== 0 && code !== null) {
      fail("后端进程退出", `后端在就绪前以退出码 ${code} 结束。请检查 emperor-agent web 是否能在仓库根目录正常运行。`);
    }
  });

  return child;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    ...readBounds(boundsPath, { readFile: (p) => fs.readFileSync(p, "utf8") }),
    title: "Emperor Agent",
    backgroundColor: "#1a1410",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error(`did-fail-load: ${errorCode} ${errorDescription}`);
    if (!didLoadRetry) {
      didLoadRetry = true;
      mainWindow.loadURL(config.backendBaseUrl);
    } else {
      fail("页面加载失败", `无法加载 ${config.backendBaseUrl}（${errorDescription}）。`);
    }
  });

  mainWindow.on("close", () => {
    try {
      fs.mkdirSync(path.dirname(boundsPath), { recursive: true });
      const payload = pickBounds(mainWindow.getBounds());
      fs.writeFileSync(boundsPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    } catch {
      // Best-effort persistence; never block window close on disk errors.
    }
  });

  mainWindow.loadURL(config.backendBaseUrl);
}

async function startup() {
  const alreadyHealthy = await probeBackend(config.backendBaseUrl);
  const plan = planStartup({ alreadyHealthy });
  ownsBackend = plan.ownsBackend;

  if (plan.action === "spawn") {
    backendChild = spawnBackend();
  }

  try {
    await waitForBackend(config.backendBaseUrl);
  } catch (err) {
    fail("后端未就绪", err && err.message ? err.message : String(err));
    return;
  }
  backendReady = true;

  createWindow();
}

app.whenReady().then(startup);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && backendReady) createWindow();
});

app.on("window-all-closed", () => {
  reclaimBackend();
  app.quit();
});

app.on("before-quit", reclaimBackend);
