# Build Plan — Marketing Automation Tool

Build order: scaffold → shared types → DB layer → Account Manager (backend → frontend) → Group Members Extractor (backend → frontend).

---

## Phase 0 — Project Scaffold

Goal: Electron + React + Tailwind boots with hot reload.

| # | Task | Details |
|---|------|---------|
| 0.1 | Init project | `npm init`, install `electron`, `typescript`, `electron-builder` as devDeps |
| 0.2 | TypeScript config | `tsconfig.json` with strict mode, `src/` root, separate configs for main vs renderer if needed |
| 0.3 | Electron main entry | `src/main/main.ts` — create BrowserWindow, load renderer, register IPC |
| 0.4 | React renderer entry | `src/renderer/index.html` + `src/renderer/App.tsx` + `src/renderer/main.tsx` |
| 0.5 | Tailwind setup | Install `tailwindcss`, `postcss`, `autoprefixer`; create `tailwind.config.js` with `src/renderer/**` content paths |
| 0.6 | Build pipeline | `electron-vite` or manual webpack/vite config — main process compiles TS, renderer bundles React+Tailwind |
| 0.7 | Dev script | `npm run dev` launches Electron with hot reload on both processes |
| 0.8 | Install runtime deps | `better-sqlite3`, `csv-writer`, `react`, `react-dom` |

**Verification**: `npm run dev` opens an Electron window showing a React page.

---

## Phase 1 — Shared Types & Constants

Goal: Define every type both processes need — no duplication.

**File: `src/shared/types.ts`**
- `TokenStatus` — `"Valid" | "Invalid" | "Expired" | "Blocked" | "Unchecked"`
- `Account` — `{ id: number, token_encrypted: string, token_preview: string, account_name: string | null, account_id: string | null, status: TokenStatus, last_check: string | null, created_at: string }`
- `ExtractionRun` — `{ id: number, group_ids: string[], source_account_id: number, status: "running" | "stopped" | "completed", started_at: string, output_path: string }`
- `ExtractedMember` — `{ member_id: string, member_name: string, profile_url: string, group_id: string, group_name: string, extracted_at: string, source_account: string }`
- `ExtractionProgress` — `{ current_group_id: string, current_group_index: number, total_groups: number, members_extracted: number, current_batch: number, status: string }`

**File: `src/shared/constants.ts`**
- `BATCH_SIZE = 10`
- `ENCRYPTION_ALGORITHM = "aes-256-cbc"`
- `CSV_FIELDS` — array of field names in order

**File: `src/shared/ipc-channels.ts`**
- Every IPC channel name as a typed constant, e.g. `ACCOUNT_ADD`, `ACCOUNT_VALIDATE`, `ACCOUNT_LIST`, `ACCOUNT_DELETE`, `ACCOUNT_EXPORT`, `EXTRACTION_START`, `EXTRACTION_STOP`, `EXTRACTION_PROGRESS`

**Verification**: `tsc --noEmit` passes.

---

## Phase 2 — Database Layer

Goal: SQLite schema + encryption + token CRUD — all in main process.

**File: `src/main/db/schema.ts`**
- `CREATE TABLE IF NOT EXISTS accounts (...)` — columns: `id INTEGER PK`, `token_encrypted TEXT NOT NULL`, `token_iv TEXT NOT NULL`, `account_name TEXT`, `account_id TEXT`, `status TEXT DEFAULT 'Unchecked'`, `last_check TEXT`, `created_at TEXT DEFAULT CURRENT_TIMESTAMP`
- `CREATE TABLE IF NOT EXISTS extraction_runs (...)`
- `CREATE TABLE IF NOT EXISTS extraction_members (...)` — for global dedup tracking
- `CREATE UNIQUE INDEX idx_accounts_token ON accounts(token_encrypted)` — prevents duplicate tokens
- `CREATE UNIQUE INDEX idx_members_id ON extraction_members(member_id, extraction_run_id)` — prevents duplicate members

**File: `src/main/db/connection.ts`**
- Singleton `getDB()` returning a `better-sqlite3` instance at a known path (`userData/marketing.db`)

**File: `src/main/crypto.ts`**
- `encryptToken(plain: string) → { encrypted: string, iv: string }` — AES-256-CBC, random IV per token
- `decryptToken(encrypted: string, iv: string) → string`
- `maskToken(token: string) → string` — first 8 chars + `****`
- Key sourced from `safeStorage` (Electron) or env var; document which.

**File: `src/main/db/accounts-repo.ts`**
- `addToken(db, encrypted, iv) → Account`
- `addTokensFromText(db, rawText) → { added: number, duplicates: number }` — parse lines, encrypt each, skip dups
- `getAccounts(db) → Account[]` — return with masked token, decrypted only for API calls
- `updateAccountStatus(db, id, status, name?, accountId?) → void`
- `deleteAccount(db, id) → void`
- `getAccountForExtraction(db, id) → { decrypted_token, account_name }` — only place that returns raw token

**Verification**: Write a quick Node script that creates DB, inserts a token, reads it back, confirms encryption round-trip.

---

## Phase 3 — Account Manager IPC Handlers

Goal: Wire main-process logic so the renderer can manage accounts.

**File: `src/main/ipc/accounts.ts`**

| Channel | Input | Output | Logic |
|---------|-------|--------|-------|
| `ACCOUNT_ADD` | `{ tokens: string[] }` | `{ added: number, duplicates: number }` | Encrypt each token, insert, skip dups |
| `ACCOUNT_LIST` | — | `Account[]` | Return all accounts with masked tokens |
| `ACCOUNT_VALIDATE` | `{ accountIds: number[] }` or `{ all: true }` | `{ results: { id, status, name?, accountId? }[] }` | For each: decrypt token → call platform API → update status + name + ID + last_check |
| `ACCOUNT_DELETE` | `{ ids: number[] }` | `{ deleted: number }` | Delete by IDs |
| `ACCOUNT_EXPORT` | — | `{ path: string }` | Write CSV of all accounts to user-chosen path (dialog) |

**Platform API client** (`src/main/api/platform-client.ts`):
- `validateToken(token: string) → { valid: boolean, status: TokenStatus, name?: string, id?: string }`
- Placeholder HTTP call — swap real endpoint in later; mock for dev
- Rate limit: 1 request per second per token to avoid blocks

**Verification**: Use Electron devtools console to invoke IPC channels manually.

---

## Phase 4 — Account Manager Frontend

Goal: Full working Account Manager page.

**File: `src/renderer/pages/AccountManager.tsx`**

Layout:
```
┌─────────────────────────────────────────────┐
│  Account Manager                            │
├─────────────────────────────────────────────┤
│  [Upload Tokens]  [Bulk Check]  [Export]    │
│                                             │
│  ┌─ Upload Modal (on click) ──────────────┐ │
│  │  Textarea for manual entry             │ │
│  │  OR file picker (.txt / .csv)          │ │
│  │  [Submit]  [Cancel]                    │ │
│  └────────────────────────────────────────┘ │
│                                             │
│  ┌─ Accounts Table ───────────────────────┐ │
│  │ Token (masked) | Name | ID | Status    │ │
│  │ abcdefgh****   | ...  | .. | Valid     │ │
│  │ ─ checkbox row for bulk select ─       │ │
│  └────────────────────────────────────────┘ │
│                                             │
│  [Delete Selected]  [Refresh Status]        │
└─────────────────────────────────────────────┘
```

Components:
- `src/renderer/components/AccountTable.tsx` — table with row selection, status badges, masked tokens
- `src/renderer/components/UploadModal.tsx` — textarea + file upload
- `src/renderer/hooks/useAccounts.ts` — wraps IPC calls in React state

IPC bridge (`src/preload/index.ts`):
- Expose `window.api.accounts.add()`, `.list()`, `.validate()`, `.delete()`, `.export()` via `contextBridge`

**Verification**: Upload tokens → see table → bulk validate → statuses update → export CSV.

---

## Phase 5 — Group Members Extractor Backend

Goal: Extraction engine with incremental CSV, global dedup, stop/cancel.

**File: `src/main/extraction/extractor.ts`**

Core class/module:
```
class GroupExtractor {
  private db, csvWriter, seenMemberIds: Set<string>, abortController

  async start(groupIds: string[], accountId: number, outputPath: string)
  stop()
  private async processGroup(groupId: string)
  private async fetchBatch(groupId: string, offset: number) → ExtractedMember[]
  private writeBatch(members: ExtractedMember[]) → void
  private emitProgress(payload: ExtractionProgress) → void
}
```

Key behaviors:
- `start()` initializes csv-writer with headers, creates a `Set<string>` for global dedup, then iterates groups sequentially.
- `processGroup()` loops fetching batches of 10, checks each `member_id` against the `seenMemberIds` set, writes non-dupes to CSV immediately.
- `csv-writer` flushes after every batch call — no buffering.
- `stop()` sets abort flag; loop checks it between batches.
- `emitProgress()` sends IPC event to renderer with current group, count, batch number.
- Errors are caught per-batch and logged to `extraction_errors` table with `{ group_id, batch_number, error_message, timestamp }`.

**File: `src/main/api/platform-client.ts`** (extend)
- `fetchGroupMembers(token: string, groupId: string, offset: number, limit: number) → ExtractedMember[]`
- Placeholder — returns mock data for dev

**File: `src/main/ipc/extraction.ts`**

| Channel | Input | Output |
|---------|-------|--------|
| `EXTRACTION_START` | `{ groupIds: string[], accountId: number }` | `{ outputPath: string }` — shows save dialog first |
| `EXTRACTION_STOP` | — | `{ stopped: true }` |
| `EXTRACTION_PROGRESS` | (main→renderer event) | `ExtractionProgress` |

**Verification**: Invoke `EXTRACTION_START` with mock API → CSV file appears on disk with incremental rows → progress events fire.

---

## Phase 6 — Group Members Extractor Frontend

Goal: Full working Extractor page with live progress.

**File: `src/renderer/pages/GroupExtractor.tsx`**

Layout:
```
┌─────────────────────────────────────────────┐
│  Group Members Extractor                    │
├─────────────────────────────────────────────┤
│  Group IDs: [____________] (comma or line)  │
│  Account:   [dropdown of valid accounts ▼]  │
│  Output:    [auto-generated path]           │
│                                             │
│  [Start Extraction]  [Stop Extraction]      │
│                                             │
│  ┌─ Progress Panel ───────────────────────┐ │
│  │ Status: Running                        │ │
│  │ Group: 3/5 (group_id_abc)              │ │
│  │ Members extracted: 147                 │ │
│  │ Last batch: #14                        │ │
│  │ ████████████░░░░░░  ~60%              │ │
│  └────────────────────────────────────────┘ │
│                                             │
│  ┌─ Error Log ────────────────────────────┐ │
│  │ [group_id_abc] Batch 7: Rate limited   │ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

Components:
- `src/renderer/components/ExtractionForm.tsx` — group ID input (textarea, one per line), account dropdown, output path
- `src/renderer/components/ProgressPanel.tsx` — live stats + progress bar
- `src/renderer/components/ErrorLog.tsx` — scrollable error list
- `src/renderer/hooks/useExtraction.ts` — wraps IPC, listens for progress events

**Account dropdown**: Only show accounts with status `Valid`. Show account name + masked token.

**Verification**: Enter group IDs → select account → start → watch progress update live → CSV grows on disk → stop mid-way → file has rows up to stop point.

---

## Phase 7 — Navigation & Polish

Goal: Wire both pages into a single app shell.

- `src/renderer/App.tsx` — tab/sidebar nav between Account Manager and Group Members Extractor
- `src/renderer/components/Sidebar.tsx` or tab bar
- Loading states, error toasts, empty states
- Confirm `npm run build` produces a packaged Electron app
- Run through full workflow: upload → validate → extract → download

---

## File Tree (final)

```
src/
  main/
    main.ts                    # Electron entry, window creation
    preload.ts                 # contextBridge exposing IPC
    db/
      connection.ts            # SQLite singleton
      schema.ts                # CREATE TABLE statements
      accounts-repo.ts         # Account CRUD
    crypto.ts                  # AES-256 encrypt/decrypt/mask
    api/
      platform-client.ts       # Platform API calls (validate, fetchMembers)
    ipc/
      accounts.ts              # Account IPC handlers
      extraction.ts            # Extraction IPC handlers
    extraction/
      extractor.ts             # Core extraction engine
  renderer/
    index.html
    main.tsx                   # React entry
    App.tsx                    # Root with navigation
    pages/
      AccountManager.tsx
      GroupExtractor.tsx
    components/
      AccountTable.tsx
      UploadModal.tsx
      ExtractionForm.tsx
      ProgressPanel.tsx
      ErrorLog.tsx
    hooks/
      useAccounts.ts
      useExtraction.ts
  shared/
    types.ts
    constants.ts
    ipc-channels.ts
```

---

## Dependency Install Command

```bash
npm install electron typescript --save-dev
npm install react react-dom better-sqlite3 csv-writer
npm install tailwindcss postcss autoprefixer --save-dev
npm install @types/react @types/react-dom @types/better-sqlite3 --save-dev
```

---

## Build Order Summary

| Phase | What | Depends on |
|-------|------|-----------|
| 0 | Scaffold + dev pipeline | Nothing |
| 1 | Shared types, constants, IPC channels | 0 |
| 2 | DB schema, encryption, accounts repo | 1 |
| 3 | Account Manager IPC handlers | 2 |
| 4 | Account Manager UI | 3 |
| 5 | Extractor engine + IPC | 2, 3 |
| 6 | Extractor UI | 5 |
| 7 | Navigation + integration test | 4, 6 |

Phases 3-4 and 5-6 can be partially parallelized — backend first, then frontend for each module.
