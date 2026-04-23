import { ipcMain, BrowserWindow } from "electron";
import { GroupExtractor } from "../extraction/extractor";
import { GroupScraper } from "../extraction/group-scraper";

let activeExtractor: GroupExtractor | GroupScraper | null = null;
let lastScraperRunId: number | null = null;

export function registerExtractionHandlers() {
  ipcMain.handle(
    "extraction:start",
    async (
      _event,
      groupIds: string[],
      accountId: number,
      useScraper: boolean = false,
      resumeRunId: number | null = null
    ) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error("No window available");

      if (useScraper || resumeRunId) {
        const scraper = new GroupScraper(win);
        activeExtractor = scraper;
        const outputPath = await scraper.start(groupIds, accountId, resumeRunId);
        lastScraperRunId = scraper.getRunId();
        activeExtractor = null;
        return { outputPath, method: "scraper", runId: lastScraperRunId };
      }

      try {
        activeExtractor = new GroupExtractor(win);
        const outputPath = await activeExtractor.start(groupIds, accountId);
        activeExtractor = null;
        return { outputPath, method: "api" };
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        const isPermissionError =
          msg.includes("(#100)") || msg.includes("nonexisting field") || msg.includes("members");

        if (isPermissionError) {
          const scraper = new GroupScraper(win);
          activeExtractor = scraper;
          const outputPath = await scraper.start(groupIds, accountId);
          lastScraperRunId = scraper.getRunId();
          activeExtractor = null;
          return { outputPath, method: "scraper", runId: lastScraperRunId };
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

  ipcMain.handle("extraction:resume-run", async (_event, runId: number) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("No window available");

    const scraper = new GroupScraper(win);
    activeExtractor = scraper;
    const outputPath = await scraper.start([], 0, runId);
    lastScraperRunId = scraper.getRunId();
    activeExtractor = null;
    return { outputPath, method: "scraper", runId: lastScraperRunId };
  });

  ipcMain.handle("extraction:stopped-runs", async () => {
    const { getDB } = require("../db/connection");
    const db = getDB();
    return db
      .prepare(
        "SELECT id, group_ids, members_extracted, current_group_index, current_batch, started_at, output_path FROM extraction_runs WHERE status = 'stopped' ORDER BY started_at DESC LIMIT 20"
      )
      .all();
  });
}
