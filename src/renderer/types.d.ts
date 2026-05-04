import type {
  TokenStatus,
  Account,
  ExtractionProgress,
  ExtractionError,
  ChatProgress,
  ChatLogEntry,
  ChatRun,
  ChatRunSettings,
  ChatGroupRecord,
} from "../shared/types";

export interface StoppedRun {
  id: number;
  group_ids: string;
  members_extracted: number;
  current_group_index: number;
  current_batch: number;
  started_at: string;
  output_path: string;
}

export interface ExtractionStartOptions {
  /** Maximum number of parallel scraper workers (1 per account). */
  concurrency?: number;
  /** Whether to show the scraper BrowserWindows. Default: false (headless). */
  showWindow?: boolean;
}

export interface ElectronAPI {
  accounts: {
    add: (tokens: string[]) => Promise<{ added: number; duplicates: number }>;
    list: () => Promise<Account[]>;
    validate: (ids?: number[]) => Promise<{ results: { id: number; status: TokenStatus; name?: string; accountId?: string }[] }>;
    delete: (ids: number[]) => Promise<{ deleted: number }>;
    export: () => Promise<{ path: string }>;
  };
  extraction: {
    start: (
      groupIds: string[],
      accountId: number,
      options?: ExtractionStartOptions
    ) => Promise<{ outputPath: string; method?: string; runId?: number | null }>;
    stop: () => Promise<{ stopped: boolean }>;
    resumeRun: (
      runId: number,
      options?: ExtractionStartOptions
    ) => Promise<{ outputPath: string; method?: string; runId?: number | null }>;
    stoppedRuns: () => Promise<StoppedRun[]>;
    onProgress: (callback: (progress: ExtractionProgress) => void) => () => void;
    onError: (callback: (error: ExtractionError) => void) => () => void;
  };
  facebook: {
    login: (accountId: number) => Promise<{ success: boolean; error?: string }>;
  };
  chat: {
    parseFile: (payload: {
      filePath?: string;
      rawContent?: string;
      namePrefix?: string;
    }) => Promise<{
      total_rows: number;
      total_valid: number;
      total_invalid: number;
      unique_ids: string[];
      preview: string[];
      planned_groups: { groupIndex: number; groupName: string; size: number }[];
      warnings: string[];
    }>;
    start: (args: {
      accountId: number;
      memberIds: string[];
      totalUploaded: number;
      totalInvalid: number;
      settings?: Partial<ChatRunSettings>;
    }) => Promise<{ runId: number; outputPath: string }>;
    pause: () => Promise<{ paused: boolean }>;
    resume: (runId: number) => Promise<{ runId: number }>;
    stop: () => Promise<{ stopped: boolean }>;
    listRuns: () => Promise<ChatRun[]>;
    getRun: (
      runId: number
    ) => Promise<
      | {
          run: ChatRun;
          memberIds: string[];
          groups: ChatGroupRecord[];
          errors: {
            group_index: number | null;
            attempt: number;
            error_message: string;
            timestamp: string;
          }[];
        }
      | null
    >;
    report: (runId: number) => Promise<{
      run: ChatRun;
      groups: ChatGroupRecord[];
      errors: {
        group_index: number | null;
        attempt: number;
        error_message: string;
        timestamp: string;
      }[];
      duration_seconds: number;
    }>;
    onProgress: (cb: (progress: ChatProgress) => void) => () => void;
    onLog: (cb: (entry: ChatLogEntry) => void) => () => void;
  };
}

declare global {
  interface Window {
    api: ElectronAPI;
  }
}
