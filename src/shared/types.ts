export type TokenStatus = "Valid" | "Invalid" | "Expired" | "Blocked" | "Unchecked";

export interface Account {
  id: number;
  token_preview: string;
  account_name: string | null;
  account_id: string | null;
  status: TokenStatus;
  last_check: string | null;
  created_at: string;
}

export interface ExtractedMember {
  member_id: string;
  member_name: string;
  profile_url: string;
  group_id: string;
  group_name: string;
  extracted_at: string;
  source_account: string;
}

export interface ExtractionProgress {
  current_group_id: string;
  current_group_index: number;
  total_groups: number;
  members_extracted: number;
  current_batch: number;
  status: "running" | "stopped" | "completed" | "failed";
}

export interface ExtractionError {
  group_id: string;
  batch_number: number;
  error_message: string;
  timestamp: string;
}

// =====================================================================
// Facebook Chat Groups Creator
// =====================================================================

export type ChatRunStatus =
  | "running"
  | "paused"
  | "stopped"
  | "completed"
  | "failed";

export type ChatGroupStatus =
  | "pending"
  | "creating"
  | "filling"
  | "completed"
  | "failed";

export interface ChatRunSettings {
  /** User-supplied prefix; group N => `${prefix} ${N}`. */
  group_name_prefix: string;
  /** Members per chunk passed to gcmember add. Default 10. */
  batch_size: number;
  /** Random delay range between batches, in seconds. */
  batch_delay_min_s: number;
  batch_delay_max_s: number;
  /** Delay after a 250-member group completes, in seconds. */
  post_group_delay_s: number;
  /** Random delay range between groups, in seconds. */
  group_delay_min_s: number;
  group_delay_max_s: number;
  /** Optional opening message posted in each new chat group. */
  greeting_message?: string | null;
}

export interface ChatRun {
  id: number;
  source_account_id: number;
  source_account_name: string | null;
  settings: ChatRunSettings;
  status: ChatRunStatus;
  total_members: number;
  total_groups: number;
  groups_completed: number;
  members_added: number;
  members_failed: number;
  started_at: string;
  completed_at: string | null;
  output_path: string;
}

export interface ChatGroupRecord {
  id: number;
  run_id: number;
  group_index: number;
  thread_id: string | null;
  group_name: string;
  member_count: number;
  status: ChatGroupStatus;
  started_at: string | null;
  completed_at: string | null;
}

export interface ChatProgress {
  run_id: number;
  status: ChatRunStatus;
  total_groups: number;
  total_members: number;
  current_group_index: number; // 0-based
  current_group_name: string | null;
  current_thread_id: string | null;
  current_batch: number;
  groups_completed: number;
  members_added: number;
  members_failed: number;
  remaining_ids: number;
  /** Free-form latest log line shown in the live status panel. */
  message: string;
}

export interface ChatLogEntry {
  run_id: number;
  level: "info" | "warn" | "error";
  message: string;
  group_index: number | null;
  timestamp: string;
}

export interface ChatRunSummary {
  run_id: number;
  status: ChatRunStatus;
  total_uploaded_ids: number;
  total_valid_ids: number;
  total_invalid_ids: number;
  groups_created: number;
  members_added: number;
  members_failed: number;
  started_at: string;
  completed_at: string | null;
  duration_seconds: number;
  output_path: string;
}
