import type { TokenStatus, Account, ExtractionProgress, ExtractionError } from "../shared/types";

export interface StoppedRun {
  id: number;
  group_ids: string;
  members_extracted: number;
  current_group_index: number;
  current_batch: number;
  started_at: string;
  output_path: string;
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
    start: (groupIds: string[], accountId: number, useScraper?: boolean) => Promise<{ outputPath: string; method?: string; runId?: number | null }>;
    stop: () => Promise<{ stopped: boolean }>;
    resumeRun: (runId: number) => Promise<{ outputPath: string; method?: string; runId?: number | null }>;
    stoppedRuns: () => Promise<StoppedRun[]>;
    onProgress: (callback: (progress: ExtractionProgress) => void) => () => void;
    onError: (callback: (error: ExtractionError) => void) => () => void;
  };
  facebook: {
    login: (accountId: number) => Promise<{ success: boolean; error?: string }>;
  };
}

declare global {
  interface Window {
    api: ElectronAPI;
  }
}
