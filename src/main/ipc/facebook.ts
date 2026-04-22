import { ipcMain, BrowserWindow } from "electron";
import { loginToFacebook } from "../api/facebook-login";
import { getDecryptedToken } from "../db/accounts-repo";

export function registerFacebookHandlers() {
  ipcMain.handle("facebook:login", async (_event, accountId: number) => {
    const { token } = getDecryptedToken(accountId);
    const parentWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    return loginToFacebook(token, parentWindow);
  });
}
