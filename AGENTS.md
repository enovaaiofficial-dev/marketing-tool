# AGENTS.md — Marketing Automation Tool

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Shell | **Electron** | Cross-platform desktop app, all TypeScript |
| Frontend | **React + Tailwind CSS** | Runs in Electron renderer process |
| Backend/Logic | **Node.js (Electron main process)** | Direct `fs`, `crypto`, HTTP access — no separate server |
| Database | **SQLite via better-sqlite3** | Synchronous, local, no server process |
| File export | **csv-writer** | Used for incremental CSV writes during extraction |
| Token encryption | **Node `crypto` (AES-256)** | Built-in, no extra deps |

All code is TypeScript. The backend lives in the Electron main process — there is no separate API server.

## Project Structure (convention)

```
src/
  main/           Electron main process (DB, file I/O, HTTP, IPC handlers)
  renderer/        React frontend (components, pages, hooks)
  shared/          Types, constants, and utilities shared between processes
```

IPC is the only bridge between renderer and main. Never access `fs`, `crypto`, or SQLite directly from renderer code.

## Modules

### Account Manager
- Upload access tokens (single, multiple, or from TXT/CSV file).
- Validate tokens against the platform API; store per-token status: `Valid | Invalid | Expired | Blocked | Unchecked`.
- Store **last_check_timestamp** per token.
- Tokens are **AES-256 encrypted at rest** in SQLite; never displayed in full in the UI (mask after first 8 chars).
- Prevent duplicate token uploads (compare before insert).
- Bulk operations: bulk validate, delete, export, refresh status.

### Group Members Extractor
- Accepts one or more Group IDs plus a source account (selected from Account Manager).
- Extracts members in batches of **10 per request**.
- **Writes to CSV incrementally in real time** — do not buffer until completion.
- Moves to the next group automatically when the current one finishes.
- Supports manual stop/cancel mid-extraction.
- Deduplication must work **across all processed groups**, not just within one group (check `member_id` globally).

### Data Fields (extraction output)
`member_id`, `member_name`, `profile_url`, `group_id`, `group_name`, `extracted_at`, `source_account`

## Hard Constraints

- **Token security**: Always encrypt with AES-256 before storing. Always mask in UI. Never log raw token values.
- **Incremental writes**: CSV export must flush to disk after every batch, not at the end.
- **Global dedup**: Member deduplication spans all groups in a single extraction run.
- **Batch size**: Fixed at 10 members per extraction request — do not change without updating this doc.
- **Error logging**: All extraction errors must be logged with enough context (group_id, batch number, error message) to support future resume/retry.

## MVP Scope (build this first)

**Account Manager MVP**: Upload tokens → display table → bulk validate → show name + ID + status.

**Group Members Extractor MVP**: Enter Group ID(s) → select account → extract 10/batch → incremental CSV → show live status/count.

## Workflow (end-to-end)

1. Upload & validate accounts in Account Manager.
2. Go to Group Members Extractor, enter Group ID(s), select source account.
3. Start extraction — results stream to CSV in real time.
4. Download final file after completion.

## Nice-to-Have (do not build until MVP is done)

- Retry mechanism for failed batches
- Resume from last successful batch
- Downloadable logs
- Filtering accounts by status / search by name or ID
- Completion notifications
- Downloadable final report
