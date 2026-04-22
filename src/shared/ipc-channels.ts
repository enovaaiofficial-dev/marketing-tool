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
} as const;

export type IpcChannels = (typeof IpcChannels)[keyof typeof IpcChannels];
