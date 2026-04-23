import type Database from "better-sqlite3";

export function createTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_encrypted TEXT NOT NULL,
      token_iv TEXT NOT NULL,
      account_name TEXT,
      account_id TEXT,
      status TEXT NOT NULL DEFAULT 'Unchecked',
      last_check TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_token
      ON accounts(token_encrypted);

    CREATE TABLE IF NOT EXISTS extraction_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_ids TEXT NOT NULL,
      source_account_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      output_path TEXT NOT NULL,
      members_extracted INTEGER DEFAULT 0,
      current_group_index INTEGER DEFAULT 0,
      current_group_id TEXT,
      current_batch INTEGER DEFAULT 0,
      scroll_position INTEGER DEFAULT 0,
      last_account_id INTEGER,
      FOREIGN KEY (source_account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS extraction_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      member_id TEXT NOT NULL,
      member_name TEXT,
      profile_url TEXT,
      group_id TEXT NOT NULL,
      group_name TEXT,
      extracted_at TEXT DEFAULT (datetime('now')),
      source_account TEXT,
      FOREIGN KEY (run_id) REFERENCES extraction_runs(id) ON DELETE CASCADE,
      UNIQUE(member_id, run_id)
    );

    CREATE TABLE IF NOT EXISTS extraction_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      group_id TEXT NOT NULL,
      batch_number INTEGER NOT NULL,
      error_message TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES extraction_runs(id) ON DELETE CASCADE
    );
  `);
}
