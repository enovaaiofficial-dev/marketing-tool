"use strict";
const electron = require("electron");
const api = {
  accounts: {
    add: (tokens) => electron.ipcRenderer.invoke("account:add", tokens),
    list: () => electron.ipcRenderer.invoke("account:list"),
    validate: (ids) => electron.ipcRenderer.invoke("account:validate", ids),
    delete: (ids) => electron.ipcRenderer.invoke("account:delete", ids),
    export: () => electron.ipcRenderer.invoke("account:export")
  },
  extraction: {
    start: (groupIds, accountId, useScraper, options) => electron.ipcRenderer.invoke("extraction:start", groupIds, accountId, useScraper, options ?? {}),
    stop: () => electron.ipcRenderer.invoke("extraction:stop"),
    resumeRun: (runId, options) => electron.ipcRenderer.invoke("extraction:resume-run", runId, options ?? {}),
    stoppedRuns: () => electron.ipcRenderer.invoke("extraction:stopped-runs"),
    onProgress: (callback) => {
      electron.ipcRenderer.on("extraction:progress", (_event, data) => callback(data));
      return () => electron.ipcRenderer.removeAllListeners("extraction:progress");
    },
    onError: (callback) => {
      electron.ipcRenderer.on("extraction:error", (_event, data) => callback(data));
      return () => electron.ipcRenderer.removeAllListeners("extraction:error");
    }
  },
  facebook: {
    login: (accountId) => electron.ipcRenderer.invoke("facebook:login", accountId)
  },
  chat: {
    parseFile: (payload) => electron.ipcRenderer.invoke("chat:parse-file", payload),
    start: (args) => electron.ipcRenderer.invoke("chat:start", args),
    pause: () => electron.ipcRenderer.invoke("chat:pause"),
    resume: (runId) => electron.ipcRenderer.invoke("chat:resume", runId),
    stop: () => electron.ipcRenderer.invoke("chat:stop"),
    listRuns: () => electron.ipcRenderer.invoke("chat:list-runs"),
    getRun: (runId) => electron.ipcRenderer.invoke("chat:get-run", runId),
    report: (runId) => electron.ipcRenderer.invoke("chat:report", runId),
    onProgress: (callback) => {
      electron.ipcRenderer.on("chat:progress", (_event, data) => callback(data));
      return () => electron.ipcRenderer.removeAllListeners("chat:progress");
    },
    onLog: (callback) => {
      electron.ipcRenderer.on("chat:log", (_event, data) => callback(data));
      return () => electron.ipcRenderer.removeAllListeners("chat:log");
    }
  }
};
electron.contextBridge.exposeInMainWorld("api", api);
