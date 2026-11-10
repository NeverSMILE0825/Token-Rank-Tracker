const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("findRank", {
  chains() {
    return ipcRenderer.invoke("chains");
  },
  send(message) {
    ipcRenderer.send("find-rank", message);
  },
  onMessage(handler) {
    ipcRenderer.on("find-rank", (_event, message) => handler(message));
  },
});
