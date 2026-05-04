import { contextBridge, ipcRenderer } from "electron";
import type { IpcChannels } from "@shared/ipc-channels";

export interface ExtractionStartOptions {
  concurrency?: number;
  showWindow?: boolean;
}

export interface ChatRunSettingsInput {
  group_name_prefix?: string;
  batch_size?: number;
  batch_delay_min_s?: number;
  batch_delay_max_s?: number;
  post_group_delay_s?: number;
  group_delay_min_s?: number;
  group_delay_max_s?: number;
  greeting_message?: string | null;
}

export interface ChatStartArgs {
  accountId: number;
  memberIds: string[];
  totalUploaded: number;
  totalInvalid: number;
  settings?: ChatRunSettingsInput;
}

const api = {
  accounts: {
    add: (tokens: string[]) => ipcRenderer.invoke("account:add", tokens),
    list: () => ipcRenderer.invoke("account:list"),
    validate: (ids?: number[]) => ipcRenderer.invoke("account:validate", ids),
    delete: (ids: number[]) => ipcRenderer.invoke("account:delete", ids),
    export: () => ipcRenderer.invoke("account:export"),
  },
  extraction: {
    start: (
      groupIds: string[],
      accountId: number,
      useScraper?: boolean,
      options?: ExtractionStartOptions
    ) => ipcRenderer.invoke("extraction:start", groupIds, accountId, useScraper, options ?? {}),
    stop: () => ipcRenderer.invoke("extraction:stop"),
    resumeRun: (runId: number, options?: ExtractionStartOptions) =>
      ipcRenderer.invoke("extraction:resume-run", runId, options ?? {}),
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
  chat: {
    parseFile: (payload: { filePath?: string; rawContent?: string; namePrefix?: string }) =>
      ipcRenderer.invoke("chat:parse-file", payload),
    start: (args: ChatStartArgs) => ipcRenderer.invoke("chat:start", args),
    pause: () => ipcRenderer.invoke("chat:pause"),
    resume: (runId: number) => ipcRenderer.invoke("chat:resume", runId),
    stop: () => ipcRenderer.invoke("chat:stop"),
    listRuns: () => ipcRenderer.invoke("chat:list-runs"),
    getRun: (runId: number) => ipcRenderer.invoke("chat:get-run", runId),
    report: (runId: number) => ipcRenderer.invoke("chat:report", runId),
    onProgress: (callback: (progress: any) => void) => {
      ipcRenderer.on("chat:progress", (_event, data) => callback(data));
      return () => ipcRenderer.removeAllListeners("chat:progress");
    },
    onLog: (callback: (entry: any) => void) => {
      ipcRenderer.on("chat:log", (_event, data) => callback(data));
      return () => ipcRenderer.removeAllListeners("chat:log");
    },
  },
};

contextBridge.exposeInMainWorld("api", api);
