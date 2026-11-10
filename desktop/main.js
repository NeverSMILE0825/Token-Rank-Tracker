const { app, BrowserWindow } = require("electron");
const { startServer } = require("../server");

let serverHandle = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(async () => {
    serverHandle = await startServer(0);
    const window = new BrowserWindow({
      width: 1180,
      height: 920,
      minWidth: 860,
      minHeight: 640,
      backgroundColor: "#0e0f0c",
      autoHideMenuBar: true,
      title: "Find Rank",
    });
    window.loadURL(serverHandle.url);
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", () => {
    serverHandle?.close();
  });
}
