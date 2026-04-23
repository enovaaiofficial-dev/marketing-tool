import type Database from "better-sqlite3";
import { getDB } from "./connection";
import { encryptToken, decryptToken, maskToken } from "../crypto";
import type { Account, TokenStatus } from "@shared/types";

export function addTokens(rawTokens: string[]): { added: number; duplicates: number } {
  const db = getDB();
  const insert = db.prepare(
    "INSERT INTO accounts (token_encrypted, token_iv, status) VALUES (?, ?, 'Unchecked')"
  );
  let added = 0;
  let duplicates = 0;

  const seen = new Set<string>();
  for (const raw of rawTokens) {
    const token = raw.trim();
    if (!token || seen.has(token)) {
      if (token) duplicates++;
      continue;
    }
    seen.add(token);

    const { encrypted, iv } = encryptToken(token);
    try {
      insert.run(encrypted, iv);
      added++;
    } catch (err: any) {
      if (err.message?.includes("UNIQUE constraint")) {
        duplicates++;
      } else {
        throw err;
      }
    }
  }
  return { added, duplicates };
}

export function getAccounts(): Account[] {
  const db = getDB();
  const rows = db
    .prepare(
      `SELECT id, token_encrypted, token_iv, account_name, account_id, status, last_check, created_at
       FROM accounts ORDER BY created_at DESC`
    )
    .all() as any[];

  return rows.map((row) => ({
    id: row.id,
    token_preview: maskToken(decryptToken(row.token_encrypted, row.token_iv)),
    account_name: row.account_name,
    account_id: row.account_id,
    status: row.status as TokenStatus,
    last_check: row.last_check,
    created_at: row.created_at,
  }));
}

export function updateAccountStatus(
  id: number,
  status: TokenStatus,
  name?: string,
  accountId?: string
): void {
  const db = getDB();
  db.prepare(
    `UPDATE accounts SET status = ?, account_name = COALESCE(?, account_name), account_id = COALESCE(?, account_id), last_check = datetime('now') WHERE id = ?`
  ).run(status, name ?? null, accountId ?? null, id);
}

export function deleteAccounts(ids: number[]): number {
  const db = getDB();
  const placeholders = ids.map(() => "?").join(",");
  const deleteErrors = db.prepare(
    `DELETE FROM extraction_errors WHERE run_id IN (SELECT id FROM extraction_runs WHERE source_account_id IN (${placeholders}))`
  );
  const deleteMembers = db.prepare(
    `DELETE FROM extraction_members WHERE run_id IN (SELECT id FROM extraction_runs WHERE source_account_id IN (${placeholders}))`
  );
  const deleteRuns = db.prepare(
    `DELETE FROM extraction_runs WHERE source_account_id IN (${placeholders})`
  );
  const deleteAccounts = db.prepare(
    `DELETE FROM accounts WHERE id IN (${placeholders})`
  );

  const transaction = db.transaction(() => {
    deleteErrors.run(...ids);
    deleteMembers.run(...ids);
    deleteRuns.run(...ids);
    const result = deleteAccounts.run(...ids);
    return result.changes;
  });

  return transaction();
}

export function getDecryptedToken(id: number): { token: string; name: string } {
  const db = getDB();
  const row = db
    .prepare("SELECT token_encrypted, token_iv, account_name FROM accounts WHERE id = ?")
    .get(id) as any;
  if (!row) throw new Error(`Account ${id} not found`);
  return {
    token: decryptToken(row.token_encrypted, row.token_iv),
    name: row.account_name ?? "Unknown",
  };
}

export function getAccountsForValidation(ids?: number[]): any[] {
  const db = getDB();
  if (ids && ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    return db
      .prepare(`SELECT id, token_encrypted, token_iv FROM accounts WHERE id IN (${placeholders})`)
      .all(...ids);
  }
  return db.prepare("SELECT id, token_encrypted, token_iv FROM accounts").all();
}

export function getValidAccountIds(): number[] {
  const db = getDB();
  const rows = db.prepare("SELECT id FROM accounts WHERE status = 'Valid' ORDER BY id").all() as any[];
  return rows.map((r) => r.id);
}
