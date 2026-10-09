import { ipcMain, type WebContents } from "electron";
import { title } from "./format.js";
import { stamp } from "./util.js";

export interface Note { id: string; text: string }

export function saveNote(text: string): Note {
  return { id: String(stamp()), text: title(text) };
}

// A wrapper: the channel is a parameter, so the key comes from its callers.
function notify(win: WebContents, channel: string, payload: unknown) {
  win.send(channel, payload);
}

export function registerIpc(win: WebContents) {
  ipcMain.handle("notes:save", (_event, text: string) => saveNote(text));
  ipcMain.on("notes:clear", () => notify(win, "notes:cleared", { at: Date.now() }));
}
