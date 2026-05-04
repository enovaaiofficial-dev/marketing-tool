export const IpcChannels = {
  ACCOUNT_ADD: "account:add",
  ACCOUNT_LIST: "account:list",
  ACCOUNT_VALIDATE: "account:validate",
  ACCOUNT_DELETE: "account:delete",
  ACCOUNT_EXPORT: "account:export",
  EXTRACTION_START: "extraction:start",
  EXTRACTION_STOP: "extraction:stop",
  EXTRACTION_PROGRESS: "extraction:progress",
  EXTRACTION_ERROR: "extraction:error",
  FACEBOOK_LOGIN: "facebook:login",
  CHAT_PARSE_FILE: "chat:parse-file",
  CHAT_START: "chat:start",
  CHAT_PAUSE: "chat:pause",
  CHAT_RESUME: "chat:resume",
  CHAT_STOP: "chat:stop",
  CHAT_LIST_RUNS: "chat:list-runs",
  CHAT_GET_RUN: "chat:get-run",
  CHAT_REPORT: "chat:report",
  CHAT_PROGRESS: "chat:progress",
  CHAT_LOG: "chat:log",
} as const;

export type IpcChannels = (typeof IpcChannels)[keyof typeof IpcChannels];
