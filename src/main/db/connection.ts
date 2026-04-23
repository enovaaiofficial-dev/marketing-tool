import Database from "better-sqlite3";
import { app } from "electron";
import { join } from "path";
import { createTables } from "./schema";

let db: Database.Database | null = null;

function runMigrations(db: Database.Database) {
  const columns = (db.pragma("table_info(extraction_runs)") as any[]).map(
    (col) => col.name as string
  );

  const migrations: Record<string, string> = {
    current_group_index: "ALTER TABLE extraction_runs ADD COLUMN current_group_index INTEGER DEFAULT 0",
    current_group_id: "ALTER TABLE extraction_runs ADD COLUMN current_group_id TEXT",
    current_batch: "ALTER TABLE extraction_runs ADD COLUMN current_batch INTEGER DEFAULT 0",
    scroll_position: "ALTER TABLE extraction_runs ADD COLUMN scroll_position INTEGER DEFAULT 0",
    last_account_id: "ALTER TABLE extraction_runs ADD COLUMN last_account_id INTEGER",
  };

  for (const [col, sql] of Object.entries(migrations)) {
    if (!columns.includes(col)) {
      db.exec(sql);
    }
  }
}

export function initDB(): Database.Database {
  if (db) return db;

  const dbPath = join(app.getPath("userData"), "marketing.db");
  db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  createTables(db);
  runMigrations(db);
  return db;
}

export function getDB(): Database.Database {
  if (!db) throw new Error("Database not initialized. Call initDB() first.");
  return db;
}
