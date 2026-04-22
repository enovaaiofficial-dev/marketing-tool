export const BATCH_SIZE = 10;
export const REQUEST_DELAY_MS = 2000;
export const ENCRYPTION_ALGORITHM = "aes-256-cbc";
export const CSV_FIELDS = [
  "member_id",
  "member_name",
  "profile_url",
  "group_id",
  "group_name",
  "extracted_at",
  "source_account",
] as const;
