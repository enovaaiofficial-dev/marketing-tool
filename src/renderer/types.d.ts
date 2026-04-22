import type { TokenStatus, Account, ExtractionProgress, ExtractionError } from "../shared/types";

export interface ElectronAPI {
  accounts: {
    add: (tokens: string[]) => Promise<{ added: number; duplicates: number }>;
    list: () => Promise<Account[]>;
    validate: (ids?: number[]) => Promise<{ results: { id: number; status: TokenStatus; name?: string; accountId?: string }[] }>;
    delete: (ids: number[]) => Promise<{ deleted: number }>;
    export: () => Promise<{ path: string }>;
  };
  extraction: {
    start: (groupIds: string[], accountId: number) => Promise<{ outputPath: string }>;
    stop: () => Promise<{ stopped: boolean }>;
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
