import { ipcMain, BrowserWindow } from "electron";
import { GroupExtractor } from "../extraction/extractor";

let activeExtractor: GroupExtractor | null = null;

export function registerExtractionHandlers() {
  ipcMain.handle(
    "extraction:start",
    async (_event, groupIds: string[], accountId: number) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error("No window available");

      activeExtractor = new GroupExtractor(win);
      const outputPath = await activeExtractor.start(groupIds, accountId);
      activeExtractor = null;
      return { outputPath };
    }
  );

  ipcMain.handle("extraction:stop", async () => {
    if (activeExtractor) {
      activeExtractor.stop();
    }
    return { stopped: true };
  });
}
