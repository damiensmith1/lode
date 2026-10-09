import { contextBridge, ipcRenderer } from "electron";
import { stamp } from "./util.js";

contextBridge.exposeInMainWorld("notes", {
  save: (text: string) => ipcRenderer.invoke("notes:save", text),
  clear: () => ipcRenderer.send("notes:clear", stamp()),
  onCleared: (cb: () => void) => ipcRenderer.on("notes:cleared", () => cb()),
});
