import { ipcMain, BrowserWindow } from "electron";
import {
  GroupScraper,
  getActiveScraper,
  type ScraperStartOptions,
} from "../extraction/group-scraper";

let activeScraper: GroupScraper | null = null;

interface ExtractionStartOptions extends ScraperStartOptions {
  resumeRunId?: number | null;
}

export function registerExtractionHandlers() {
  ipcMain.handle(
    "extraction:start",
    async (
      _event,
      groupIds: string[],
      accountId: number,
      options: ExtractionStartOptions = {}
    ) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error("No window available");

      const scraperOpts: ScraperStartOptions = {
        concurrency: options.concurrency,
        showWindow: options.showWindow,
      };
      const resumeRunId = options.resumeRunId ?? null;

      const scraper = new GroupScraper(win);
      activeScraper = scraper;
      try {
        const outputPath = await scraper.start(groupIds, accountId, resumeRunId, scraperOpts);
        return { outputPath, method: "scraper", runId: scraper.getRunId() };
      } finally {
        activeScraper = null;
      }
    }
  );

  ipcMain.handle("extraction:stop", async () => {
    if (activeScraper) {
      activeScraper.stop();
    }
    return { stopped: true };
  });

  ipcMain.handle(
    "extraction:resume-run",
    async (_event, runId: number, options?: ScraperStartOptions) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error("No window available");

      const scraper = new GroupScraper(win);
      activeScraper = scraper;
      try {
        const outputPath = await scraper.start([], 0, runId, options ?? {});
        return { outputPath, method: "scraper", runId: scraper.getRunId() };
      } finally {
        activeScraper = null;
      }
    }
  );

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

export function saveActiveExtraction() {
  const scraper = getActiveScraper();
  if (scraper && scraper.isRunning()) {
    scraper.forceSave();
  }
  if (activeScraper) {
    activeScraper.stop();
  }
}
