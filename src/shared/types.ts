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
