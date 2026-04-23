import { contextBridge, ipcRenderer } from "electron";
import type { IpcChannels } from "@shared/ipc-channels";

const api = {
  accounts: {
    add: (tokens: string[]) => ipcRenderer.invoke("account:add", tokens),
    list: () => ipcRenderer.invoke("account:list"),
    validate: (ids?: number[]) => ipcRenderer.invoke("account:validate", ids),
    delete: (ids: number[]) => ipcRenderer.invoke("account:delete", ids),
    export: () => ipcRenderer.invoke("account:export"),
  },
  extraction: {
    start: (groupIds: string[], accountId: number, useScraper?: boolean) =>
      ipcRenderer.invoke("extraction:start", groupIds, accountId, useScraper),
    stop: () => ipcRenderer.invoke("extraction:stop"),
    resumeRun: (runId: number) => ipcRenderer.invoke("extraction:resume-run", runId),
    stoppedRuns: () => ipcRenderer.invoke("extraction:stopped-runs"),
    onProgress: (callback: (progress: any) => void) => {
      ipcRenderer.on("extraction:progress", (_event, data) => callback(data));
      return () => ipcRenderer.removeAllListeners("extraction:progress");
    },
    onError: (callback: (error: any) => void) => {
      ipcRenderer.on("extraction:error", (_event, data) => callback(data));
      return () => ipcRenderer.removeAllListeners("extraction:error");
    },
  },
  facebook: {
    login: (accountId: number) => ipcRenderer.invoke("facebook:login", accountId),
  },
};

contextBridge.exposeInMainWorld("api", api);
