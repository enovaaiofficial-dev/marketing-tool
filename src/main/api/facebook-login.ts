import { BrowserWindow, session } from "electron";

interface FacebookAppResponse {
  id?: string;
  error?: { message: string };
}

interface SessionCookie {
  name: string;
  value: string;
  httponly?: boolean;
  secure?: boolean;
  path?: string;
  domain?: string;
}

interface FacebookSessionResponse {
  session_cookies?: SessionCookie[];
  error_msg?: string;
}

export async function getSessionCookies(
  accessToken: string
): Promise<SessionCookie[]> {
  const appResponse = await fetch(
    `https://graph.facebook.com/app?access_token=${accessToken}`
  );
  const appData: FacebookAppResponse = await appResponse.json();

  if (appData.error || !appData.id) {
    throw new Error(appData.error?.message ?? "Failed to get app ID");
  }

  const sessionResponse = await fetch(
    `https://api.facebook.com/method/auth.getSessionforApp?access_token=${accessToken}&format=json&generate_session_cookies=1&new_app_id=${appData.id}`
  );
  const sessionData: FacebookSessionResponse = await sessionResponse.json();

  if (sessionData.error_msg || !sessionData.session_cookies) {
    throw new Error(sessionData.error_msg ?? "No session cookies returned");
  }

  return sessionData.session_cookies;
}

export async function loginToFacebook(
  accessToken: string,
  parentWindow?: BrowserWindow
): Promise<{ success: boolean; error?: string }> {
  try {
    const cookies = await getSessionCookies(accessToken);

    const ses = parentWindow ? parentWindow.webContents.session : session.defaultSession;

    for (const cookie of cookies) {
      await ses.cookies.set({
        url: "https://www.facebook.com",
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain ?? ".facebook.com",
        path: cookie.path ?? "/",
        secure: cookie.secure ?? true,
        httpOnly: cookie.httponly ?? false,
      });
    }

    const fbWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      parent: parentWindow ?? undefined,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    await fbWindow.loadURL("https://www.facebook.com");

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message ?? String(err) };
  }
}
