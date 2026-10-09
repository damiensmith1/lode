import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("notes", {
  save: (text: string) => ipcRenderer.invoke("notes:save", text),
  clear: () => ipcRenderer.send("notes:clear"),
  onCleared: (cb: () => void) => ipcRenderer.on("notes:cleared", () => cb()),
});
