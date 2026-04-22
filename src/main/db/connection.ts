import Database from "better-sqlite3";
import { app } from "electron";
import { join } from "path";
import { createTables } from "./schema";

let db: Database.Database | null = null;

export function initDB(): Database.Database {
  if (db) return db;

  const dbPath = join(app.getPath("userData"), "marketing.db");
  db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  createTables(db);
  return db;
}

export function getDB(): Database.Database {
  if (!db) throw new Error("Database not initialized. Call initDB() first.");
  return db;
}
