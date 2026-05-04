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

    -- Per-group state for parallel scraper workers. A run has many groups;
    -- each group is processed by exactly one worker at a time. Used as the
    -- queue source on (re)start and for resume after stop.
    CREATE TABLE IF NOT EXISTS extraction_run_groups (
      run_id INTEGER NOT NULL,
      group_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      members_count INTEGER NOT NULL DEFAULT 0,
      worker_index INTEGER,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (run_id, group_id),
      FOREIGN KEY (run_id) REFERENCES extraction_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_extraction_run_groups_status
      ON extraction_run_groups(run_id, status);

    CREATE INDEX IF NOT EXISTS idx_extraction_members_run
      ON extraction_members(run_id);

    -- ===========================================================
    -- Facebook Chat Groups Creator
    -- ===========================================================

    -- One row per "create chat groups" job. Holds settings, status,
    -- the source-of-truth ID list, and aggregate counts. Used both
    -- live (running) and after completion (reports + resume).
    CREATE TABLE IF NOT EXISTS chat_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_account_id INTEGER NOT NULL,
      settings_json TEXT NOT NULL,
      member_ids_json TEXT NOT NULL,
      total_uploaded_ids INTEGER NOT NULL DEFAULT 0,
      total_valid_ids INTEGER NOT NULL DEFAULT 0,
      total_invalid_ids INTEGER NOT NULL DEFAULT 0,
      total_groups INTEGER NOT NULL DEFAULT 0,
      groups_completed INTEGER NOT NULL DEFAULT 0,
      members_added INTEGER NOT NULL DEFAULT 0,
      members_failed INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'running',
      output_path TEXT NOT NULL,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY (source_account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    -- One row per chat group created (or attempted) within a run.
    -- group_index is 0-based and identifies which slice of the ID
    -- list belongs to this group. thread_id is null until creation
    -- succeeds; status drives resume/retry decisions.
    CREATE TABLE IF NOT EXISTS chat_groups_created (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      group_index INTEGER NOT NULL,
      thread_id TEXT,
      group_name TEXT NOT NULL,
      member_ids_json TEXT NOT NULL,
      member_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT,
      completed_at TEXT,
      UNIQUE(run_id, group_index),
      FOREIGN KEY (run_id) REFERENCES chat_runs(id) ON DELETE CASCADE
    );

    -- Per-batch errors and skipped IDs. Lets the UI render an error
    -- log and lets the report enumerate failures.
    CREATE TABLE IF NOT EXISTS chat_creation_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      group_index INTEGER,
      attempt INTEGER NOT NULL DEFAULT 1,
      member_ids_json TEXT,
      error_message TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES chat_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chat_groups_created_run
      ON chat_groups_created(run_id, group_index);

    CREATE INDEX IF NOT EXISTS idx_chat_creation_errors_run
      ON chat_creation_errors(run_id);
  `);
}
