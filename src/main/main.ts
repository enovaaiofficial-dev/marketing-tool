import { app, BrowserWindow } from "electron";
import { resolve } from "path";
import { registerAccountHandlers } from "./ipc/accounts";
import { registerExtractionHandlers } from "./ipc/extraction";
import { registerFacebookHandlers } from "./ipc/facebook";
import { initDB } from "./db/connection";

if (process.env.NODE_ENV !== "production") {
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
}
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-dev-shm-usage");

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: resolve(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL).catch(() => {
      if (mainWindow) mainWindow.loadFile(resolve(__dirname, "../renderer/index.html"));
    });
  } else {
    mainWindow.loadFile(resolve(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  initDB();
  registerAccountHandlers();
  registerExtractionHandlers();
  registerFacebookHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
