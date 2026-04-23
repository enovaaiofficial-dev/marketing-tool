let electron = require("electron");
//#region src/preload/index.ts
electron.contextBridge.exposeInMainWorld("api", {
	accounts: {
		add: (tokens) => electron.ipcRenderer.invoke("account:add", tokens),
		list: () => electron.ipcRenderer.invoke("account:list"),
		validate: (ids) => electron.ipcRenderer.invoke("account:validate", ids),
		delete: (ids) => electron.ipcRenderer.invoke("account:delete", ids),
		export: () => electron.ipcRenderer.invoke("account:export")
	},
	extraction: {
		start: (groupIds, accountId, useScraper) => electron.ipcRenderer.invoke("extraction:start", groupIds, accountId, useScraper),
		stop: () => electron.ipcRenderer.invoke("extraction:stop"),
		onProgress: (callback) => {
			electron.ipcRenderer.on("extraction:progress", (_event, data) => callback(data));
			return () => electron.ipcRenderer.removeAllListeners("extraction:progress");
		},
		onError: (callback) => {
			electron.ipcRenderer.on("extraction:error", (_event, data) => callback(data));
			return () => electron.ipcRenderer.removeAllListeners("extraction:error");
		}
	},
	facebook: { login: (accountId) => electron.ipcRenderer.invoke("facebook:login", accountId) }
});
//#endregion
