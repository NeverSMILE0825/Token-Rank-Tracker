const { app, BrowserWindow, dialog, ipcMain, session, shell } = require("electron");
const path = require("path");
const { CHAINS } = require("../lib/chains");
const { setProxyUrl } = require("../lib/screener");
const { createSession, run } = require("../lib/tracker");

let mainWindow = null;
let rankSession = null;

function docsFile(...parts) {
  return path.join(__dirname, "..", "docs", ...parts);
}

function post(contents, message) {
  if (!contents || contents.isDestroyed()) return;
  contents.send("find-rank", message);
}

function proxyFromResolution(result) {
  const parts = String(result || "").split(";").map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    const match = part.match(/^(PROXY|HTTPS)\s+(\S+)/i);
    if (!match) continue;
    const host = match[2];
    if (/^https?:\/\//i.test(host)) return host;
    return `${match[1].toUpperCase() === "HTTPS" ? "https" : "http"}://${host}`;
  }
  return "";
}

function openWindow() {
  const window = new BrowserWindow({
    width: 1180,
    height: 920,
    minWidth: 860,
    minHeight: 640,
    backgroundColor: "#0e0f0c",
    autoHideMenuBar: true,
    title: "Find Rank",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = window;
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("did-fail-load", (_event, _code, description) => {
    dialog.showErrorBox("Find Rank", `The window could not open.\n\n${description}`);
  });
  window.loadFile(docsFile("index.html"));
  return window;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  ipcMain.handle("chains", () => CHAINS);

  ipcMain.on("find-rank", (event, message) => {
    if (!message || typeof message !== "object") return;
    if (message.type === "stop") {
      rankSession?.stop();
      rankSession = null;
      post(event.sender, { type: "idle" });
      return;
    }
    if (message.type !== "track") return;
    rankSession?.stop();
    const bridge = {
      readyState: 1,
      send(data) {
        post(event.sender, JSON.parse(data));
      },
    };
    try {
      rankSession = createSession(bridge, message);
    } catch (error) {
      rankSession = null;
      post(event.sender, { type: "error", error: error.message });
      return;
    }
    run(rankSession).catch((error) => {
      if (error?.message === "aborted") return;
      post(event.sender, { type: "error", error: "The tracker stopped unexpectedly." });
    });
  });

  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    try {
      const resolved = await session.defaultSession.resolveProxy("https://io.dexscreener.com");
      setProxyUrl(proxyFromResolution(resolved));
    } catch {
      setProxyUrl("");
    }
    openWindow();
  }).catch((error) => {
    dialog.showErrorBox("Find Rank", error.message || "Find Rank could not start.");
    app.quit();
  });

  app.on("window-all-closed", () => {
    rankSession?.stop();
    app.quit();
  });
}
