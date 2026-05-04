// Wrapper around biar-fca that:
//   1. derives an appState from a stored Graph access token, and
//   2. exposes a small typed surface (createGroup, addMembers,
//      renameGroup, sendMessage, logout) used by GroupCreator.
//
// biar-fca itself is loaded via createRequire so we can keep the
// project ESM while consuming a CommonJS dependency. The package
// is auto-externalized by electron-vite so it stays a runtime require
// rather than getting bundled into dist/main.

import { createRequire } from "module";
import { getSessionCookies } from "./facebook-login";

const requireCJS = createRequire(import.meta.url);

/* eslint-disable @typescript-eslint/no-explicit-any */
type FcaApi = {
  getCurrentUserID(): string;
  /** create-group when threadID is an array of user IDs. */
  sendMessage: (
    msg: string | { body?: string },
    threadID: string | string[],
    replyToMessage?: string | null,
    isSingleUser?: boolean
  ) => Promise<{ threadID: string; messageID: string; timestamp: string }>;
  /** alias used in the typings; falls back to sendMessage when present. */
  sendMessageMqtt?: (...args: any[]) => any;
  gcmember: (
    action: "add" | "remove",
    userIDs: string | string[],
    threadID: string,
    callback?: (err: any, data: any) => void
  ) => Promise<{ type?: string; error?: string; userIDs?: string[] }>;
  gcname: (
    newName: string,
    threadID: string,
    callback?: (err: any, data: any) => void
  ) => Promise<any>;
  logout: (callback?: (err: any) => void) => Promise<void>;
  listenMqtt?: (callback: (err: any, event: any) => void) => unknown;
  ctx?: { mqttClient?: unknown };
  setOptions?: (opts: Record<string, any>) => void;
};

export interface FcaSession {
  api: FcaApi;
  userId: string;
  /** Stop MQTT/network activity and clear listeners. Safe to call twice. */
  close(): Promise<void>;
}

interface SessionCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httponly?: boolean;
}

/**
 * Convert raw cookies returned by `auth.getSessionforApp` into the
 * shape biar-fca's loginHelper expects (`{ key, value, domain, path,
 * hostOnly, expires, secure, httpOnly }`). biar-fca already accepts
 * `name` as an alias for `key` (loginHelper.js:36) so we keep the
 * conversion minimal but complete.
 */
function toAppState(cookies: SessionCookie[]) {
  return cookies.map((c) => ({
    key: c.name,
    value: c.value,
    domain: c.domain ?? ".facebook.com",
    path: c.path ?? "/",
    hostOnly: false,
    creation: new Date().toISOString(),
    lastAccessed: new Date().toISOString(),
    secure: c.secure ?? true,
    httpOnly: c.httponly ?? false,
  }));
}

/**
 * Login to biar-fca using an appState derived from a Graph access
 * token. Resolves once login + MQTT handshake are ready, with a hard
 * timeout to avoid hanging forever when Facebook silently blocks.
 */
export async function loginWithAccessToken(
  accessToken: string,
  options: { timeoutMs?: number } = {}
): Promise<FcaSession> {
  const cookies = await getSessionCookies(accessToken);
  const appState = toAppState(cookies);

  // biar-fca is CommonJS; load it lazily so that any environments
  // missing the optional native deps don't break unrelated modules.
  const fca = requireCJS("biar-fca") as { login: any };

  const timeoutMs = options.timeoutMs ?? 60_000;
  const api = await new Promise<FcaApi>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`biar-fca login timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      fca.login(
        { appState },
        {
          online: true,
          updatePresence: true,
          selfListen: false,
          autoMarkDelivery: false,
          autoMarkRead: false,
          listenEvents: false,
          autoReconnect: true,
        },
        (err: any, apiInstance: FcaApi) => {
          clearTimeout(timer);
          if (err) {
            const message =
              typeof err === "string"
                ? err
                : err?.error ?? err?.message ?? JSON.stringify(err);
            reject(new Error(`biar-fca login failed: ${message}`));
            return;
          }
          if (!apiInstance) {
            reject(new Error("biar-fca login produced no API instance"));
            return;
          }
          resolve(apiInstance);
        }
      );
    } catch (err: any) {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });

  // Required for gcmember to work (it publishes to MQTT). The library
  // initializes MQTT lazily on listenMqtt, so we kick it off and just
  // let it run in the background. We swallow events since we don't
  // need them for group creation.
  if (typeof api.listenMqtt === "function") {
    try {
      api.listenMqtt(() => {
        /* ignore: we only need the MQTT connection, not the events */
      });
    } catch {
      // best-effort; gcmember will report a clear error if MQTT failed
    }
  }

  // Wait briefly for MQTT to actually connect, otherwise the very first
  // gcmember call returns "Not connected to MQTT" and we incorrectly
  // mark the group as failed.
  await waitForMqtt(api, 15_000);

  const userId = api.getCurrentUserID();

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await new Promise<void>((resolve) => {
        try {
          api.logout(() => resolve());
        } catch {
          resolve();
        }
        // logout shouldn't take more than a couple seconds; safety net:
        setTimeout(() => resolve(), 5000);
      });
    } catch {
      // ignore
    }
  };

  return { api, userId, close };
}

async function waitForMqtt(api: FcaApi, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (api.ctx?.mqttClient) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  // Don't throw: gcmember will surface a clear error if MQTT is still
  // not ready by the time the first add runs.
}

/**
 * Tag biar-fca errors with a short reason code that callers can use
 * to decide whether to retry, skip, or abort the run.
 *
 * Known Facebook error codes seen during group creation:
 *   1545012 — "Bot is not part of the conversation"  (permission)
 *   1545041 — "This person is currently unavailable" (invalid_user)
 *   2853003 — "Invalid recipient"                    (invalid_user)
 *   1357031 — checkpoint / blocked                   (blocked)
 */
export function classifyFcaError(message: string): {
  reason:
    | "blocked"
    | "rate_limit"
    | "invalid_user"
    | "already_member"
    | "permission"
    | "transient"
    | "unknown";
} {
  const m = message.toLowerCase();
  if (
    m.includes("checkpoint") ||
    m.includes("login_approvals") ||
    m.includes("1357031")
  ) {
    return { reason: "blocked" };
  }
  if (m.includes("spam") || m.includes("too many") || m.includes("rate")) {
    return { reason: "rate_limit" };
  }
  if (
    m.includes("1545041") || // person currently unavailable
    m.includes("2853003") || // invalid recipient
    m.includes("invalid recipient") ||
    m.includes("currently unavailable") ||
    m.includes("not in this group") ||
    m.includes("user with id")
  ) {
    return { reason: "invalid_user" };
  }
  if (m.includes("already in the group")) {
    return { reason: "already_member" };
  }
  if (m.includes("1545012") || m.includes("not part of the conversation")) {
    return { reason: "permission" };
  }
  if (m.includes("transient") || m.includes("temporary")) {
    return { reason: "transient" };
  }
  return { reason: "unknown" };
}
