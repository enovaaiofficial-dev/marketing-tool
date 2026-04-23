import { ipcMain, BrowserWindow } from "electron";
import { GroupExtractor } from "../extraction/extractor";
import { GroupScraper } from "../extraction/group-scraper";

let activeExtractor: GroupExtractor | GroupScraper | null = null;

export function registerExtractionHandlers() {
  ipcMain.handle(
    "extraction:start",
    async (_event, groupIds: string[], accountId: number, useScraper: boolean = false) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error("No window available");

      if (useScraper) {
        activeExtractor = new GroupScraper(win);
      } else {
        activeExtractor = new GroupExtractor(win);
      }

      try {
        const outputPath = await activeExtractor.start(groupIds, accountId);
        activeExtractor = null;
        return { outputPath, method: useScraper ? "scraper" : "api" };
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        const isPermissionError =
          msg.includes("(#100)") || msg.includes("nonexisting field") || msg.includes("members");

        if (!useScraper && isPermissionError) {
          activeExtractor = new GroupScraper(win);
          const outputPath = await activeExtractor.start(groupIds, accountId);
          activeExtractor = null;
          return { outputPath, method: "scraper" };
        }

        activeExtractor = null;
        throw err;
      }
    }
  );

  ipcMain.handle("extraction:stop", async () => {
    if (activeExtractor) {
      activeExtractor.stop();
    }
    return { stopped: true };
  });
}
