import { ipcMain } from "electron";
import {
  addTokens,
  getAccounts,
  getAccountsForValidation,
  updateAccountStatus,
  deleteAccounts,
} from "../db/accounts-repo";
import { decryptToken } from "../crypto";
import { validateToken } from "../api/platform-client";
import type { TokenStatus } from "@shared/types";

export function registerAccountHandlers() {
  ipcMain.handle("account:add", async (_event, tokens: string[]) => {
    return addTokens(tokens);
  });

  ipcMain.handle("account:list", async () => {
    return getAccounts();
  });

  ipcMain.handle("account:validate", async (_event, ids?: number[]) => {
    const accounts = getAccountsForValidation(ids);
    const results: { id: number; status: TokenStatus; name?: string; accountId?: string }[] = [];

    for (const account of accounts) {
      const token = decryptToken(account.token_encrypted, account.token_iv);
      const result = await validateToken(token);
      updateAccountStatus(account.id, result.status, result.name, result.id);
      results.push({
        id: account.id,
        status: result.status,
        name: result.name,
        accountId: result.id,
      });
    }

    return { results };
  });

  ipcMain.handle("account:delete", async (_event, ids: number[]) => {
    return { deleted: deleteAccounts(ids) };
  });

  ipcMain.handle("account:export", async () => {
    // TODO: implement CSV export via dialog
    return { path: "" };
  });
}
