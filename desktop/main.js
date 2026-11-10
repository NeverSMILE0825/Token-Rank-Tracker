const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const path = require("path");
const { CHAINS } = require("../lib/chains");
const { createSession, run } = require("../lib/tracker");

let mainWindow = null;
let session = null;

function docsFile(...parts) {
  return path.join(__dirname, "..", "docs", ...parts);
}

function post(contents, message) {
  if (!contents || contents.isDestroyed()) return;
  contents.send("find-rank", message);
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
      session?.stop();
      session = null;
      post(event.sender, { type: "idle" });
      return;
    }
    if (message.type !== "track") return;
    session?.stop();
    const bridge = {
      readyState: 1,
      send(data) {
        post(event.sender, JSON.parse(data));
      },
    };
    try {
      session = createSession(bridge, message);
    } catch (error) {
      session = null;
      post(event.sender, { type: "error", error: error.message });
      return;
    }
    run(session).catch((error) => {
      if (error?.message === "aborted") return;
      post(event.sender, { type: "error", error: "The tracker stopped unexpectedly." });
    });
  });

  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(openWindow).catch((error) => {
    dialog.showErrorBox("Find Rank", error.message || "Find Rank could not start.");
    app.quit();
  });

  app.on("window-all-closed", () => {
    session?.stop();
    app.quit();
  });
}
