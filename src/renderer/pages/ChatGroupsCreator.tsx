import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Account,
  ChatLogEntry,
  ChatProgress,
  ChatRun,
  ChatRunSettings,
} from "@shared/types";

interface ParseResult {
  total_rows: number;
  total_valid: number;
  total_invalid: number;
  unique_ids: string[];
  preview: string[];
  planned_groups: { groupIndex: number; groupName: string; size: number }[];
  warnings: string[];
}

const DEFAULT_SETTINGS: ChatRunSettings = {
  group_name_prefix: "Group",
  batch_size: 10,
  batch_delay_min_s: 30,
  batch_delay_max_s: 60,
  post_group_delay_s: 300,
  group_delay_min_s: 600,
  group_delay_max_s: 1200,
  greeting_message: null,
};

export default function ChatGroupsCreator() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);

  const [fileName, setFileName] = useState<string>("");
  const [fileText, setFileText] = useState<string>("");
  const [parsing, setParsing] = useState(false);
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);

  const [settings, setSettings] = useState<ChatRunSettings>(DEFAULT_SETTINGS);

  const [progress, setProgress] = useState<ChatProgress | null>(null);
  const [logs, setLogs] = useState<ChatLogEntry[]>([]);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const [runs, setRuns] = useState<ChatRun[]>([]);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const logScrollRef = useRef<HTMLDivElement>(null);

  // -------- data loading --------
  const loadAccounts = useCallback(async () => {
    try {
      const list = await window.api.accounts.list();
      setAccounts(list.filter((a) => a.status === "Valid"));
    } catch {
      // ignore
    }
  }, []);

  const loadRuns = useCallback(async () => {
    try {
      const list = await window.api.chat.listRuns();
      setRuns(list);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadAccounts();
    loadRuns();
  }, [loadAccounts, loadRuns]);

  // -------- subscriptions --------
  useEffect(() => {
    const unsubProgress = window.api.chat.onProgress((p) => {
      setProgress(p);
      setActiveRunId(p.run_id);
      if (
        p.status === "completed" ||
        p.status === "stopped" ||
        p.status === "failed" ||
        p.status === "paused"
      ) {
        loadRuns();
      }
    });
    const unsubLog = window.api.chat.onLog((entry) => {
      setLogs((prev) => {
        const next = prev.length > 500 ? prev.slice(prev.length - 500) : prev.slice();
        next.push(entry);
        return next;
      });
    });
    return () => {
      unsubProgress();
      unsubLog();
    };
  }, [loadRuns]);

  useEffect(() => {
    if (logScrollRef.current) {
      logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
    }
  }, [logs]);

  const showMessage = (text: string, type: "success" | "error") => {
    setMessage({ text, type });
    setTimeout(() => setMessage(null), 4000);
  };

  // -------- file parsing --------
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setFileName(file.name);
    setFileText(text);
    await parseUploaded(text, file.name);
  };

  const parseUploaded = useCallback(
    async (text: string, name: string) => {
      setParsing(true);
      setParseResult(null);
      try {
        const result = await window.api.chat.parseFile({
          rawContent: text,
          filePath: name,
          namePrefix: settings.group_name_prefix,
        });
        setParseResult(result);
        if (result.warnings.length > 0) {
          showMessage(result.warnings[0], "error");
        } else {
          showMessage(
            `Parsed ${result.total_valid} valid IDs into ${result.planned_groups.length} group(s).`,
            "success"
          );
        }
      } catch (err: any) {
        showMessage(err.message ?? "Parsing failed", "error");
      } finally {
        setParsing(false);
      }
    },
    [settings.group_name_prefix]
  );

  // Re-plan when prefix changes (cheap; uses cached file content)
  useEffect(() => {
    if (!fileText) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await window.api.chat.parseFile({
          rawContent: fileText,
          filePath: fileName,
          namePrefix: settings.group_name_prefix,
        });
        if (!cancelled) setParseResult(result);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settings.group_name_prefix, fileText, fileName]);

  // -------- start/stop/pause/resume --------
  const isRunning =
    progress?.status === "running";
  const isPaused = progress?.status === "paused";

  const handleStart = async () => {
    if (!parseResult) {
      showMessage("Upload an IDs file first.", "error");
      return;
    }
    if (!selectedAccountId) {
      showMessage("Select a source account.", "error");
      return;
    }
    if (parseResult.unique_ids.length === 0) {
      showMessage("No valid IDs to process.", "error");
      return;
    }

    try {
      const { runId } = await window.api.chat.start({
        accountId: selectedAccountId,
        memberIds: parseResult.unique_ids,
        totalUploaded: parseResult.total_rows + parseResult.total_invalid,
        totalInvalid: parseResult.total_invalid,
        settings,
      });
      setActiveRunId(runId);
      setLogs([]);
      setProgress({
        run_id: runId,
        status: "running",
        total_groups: parseResult.planned_groups.length,
        total_members: parseResult.unique_ids.length,
        current_group_index: 0,
        current_group_name: parseResult.planned_groups[0]?.groupName ?? null,
        current_thread_id: null,
        current_batch: 0,
        groups_completed: 0,
        members_added: 0,
        members_failed: 0,
        remaining_ids: parseResult.unique_ids.length,
        message: "Starting...",
      });
      showMessage(`Run #${runId} started.`, "success");
      loadRuns();
    } catch (err: any) {
      showMessage(err.message ?? "Failed to start run", "error");
    }
  };

  const handlePause = async () => {
    try {
      await window.api.chat.pause();
      showMessage("Pause requested.", "success");
    } catch (err: any) {
      showMessage(err.message, "error");
    }
  };

  const handleStop = async () => {
    try {
      await window.api.chat.stop();
      showMessage("Stop requested.", "success");
    } catch (err: any) {
      showMessage(err.message, "error");
    }
  };

  const handleResumeRun = async (runId: number) => {
    try {
      await window.api.chat.resume(runId);
      setActiveRunId(runId);
      showMessage(`Resuming run #${runId}.`, "success");
      loadRuns();
    } catch (err: any) {
      showMessage(err.message ?? "Resume failed", "error");
    }
  };

  // -------- report download --------
  const handleDownloadReport = async () => {
    if (!activeRunId) {
      showMessage("No active run to report on.", "error");
      return;
    }
    try {
      const data = await window.api.chat.report(activeRunId);
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `chat-run-${activeRunId}-report.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showMessage("Report downloaded.", "success");
    } catch (err: any) {
      showMessage(err.message ?? "Report failed", "error");
    }
  };

  // -------- derived values --------
  const totalGroups = parseResult?.planned_groups.length ?? 0;
  const progressPercent = useMemo(() => {
    if (!progress || progress.total_groups === 0) return 0;
    return Math.round((progress.groups_completed / progress.total_groups) * 100);
  }, [progress]);

  const resumableRuns = runs.filter(
    (r) => r.status === "paused" || r.status === "stopped" || r.status === "failed"
  );

  return (
    <div className="p-6 max-w-5xl">
      <h2 className="text-xl font-bold text-gray-900 mb-4">Facebook Chat Groups Creator</h2>

      {message && (
        <div
          className={`mb-4 px-4 py-2 rounded-md text-sm ${
            message.type === "success"
              ? "bg-green-50 text-green-700"
              : "bg-red-50 text-red-700"
          }`}
        >
          {message.text}
        </div>
      )}

      {/* ---------------- File upload + plan ---------------- */}
      <section className="bg-white border border-gray-200 rounded-lg p-4 mb-4 space-y-3">
        <h3 className="text-sm font-medium text-gray-700">1. Upload IDs file</h3>
        <p className="text-xs text-gray-500">
          Use the CSV exported by Group Members Extractor (must contain a{" "}
          <code className="bg-gray-100 px-1 py-0.5 rounded">member_id</code> column). .txt with one ID per row also works.
        </p>
        <div className="flex items-center gap-3">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isRunning || parsing}
            className="px-3 py-2 bg-gray-100 text-gray-700 text-sm rounded-md hover:bg-gray-200 disabled:opacity-50"
          >
            {parsing ? "Parsing..." : "Choose file"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.txt"
            className="hidden"
            onChange={handleFileChange}
          />
          {fileName && <span className="text-sm text-gray-600">{fileName}</span>}
        </div>

        {parseResult && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm pt-2">
            <Metric label="Total rows" value={parseResult.total_rows} />
            <Metric label="Valid IDs" value={parseResult.total_valid} accent="success" />
            <Metric label="Invalid" value={parseResult.total_invalid} accent="warn" />
            <Metric label="Groups" value={parseResult.planned_groups.length} accent="info" />
          </div>
        )}

        {parseResult && parseResult.planned_groups.length > 0 && (
          <details className="text-xs text-gray-600 mt-2">
            <summary className="cursor-pointer text-gray-500 hover:text-gray-700">
              Preview group plan
            </summary>
            <ul className="mt-2 max-h-40 overflow-y-auto space-y-1 font-mono">
              {parseResult.planned_groups.map((g) => (
                <li key={g.groupIndex}>
                  {g.groupName} — {g.size} members
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {/* ---------------- Account ---------------- */}
      <section className="bg-white border border-gray-200 rounded-lg p-4 mb-4 space-y-3">
        <h3 className="text-sm font-medium text-gray-700">2. Source account</h3>
        <select
          value={selectedAccountId ?? ""}
          onChange={(e) => setSelectedAccountId(Number(e.target.value) || null)}
          disabled={isRunning}
          className="w-full p-2 border border-gray-300 rounded-md text-sm"
        >
          <option value="">Select an account...</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.account_name ?? "Unknown"} ({a.token_preview})
            </option>
          ))}
        </select>
        {accounts.length === 0 && (
          <p className="text-xs text-gray-400">
            No valid accounts. Add and validate tokens in Account Manager first.
          </p>
        )}
      </section>

      {/* ---------------- Settings ---------------- */}
      <section className="bg-white border border-gray-200 rounded-lg p-4 mb-4 space-y-3">
        <h3 className="text-sm font-medium text-gray-700">3. Settings</h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Group name prefix">
            <input
              value={settings.group_name_prefix}
              onChange={(e) =>
                setSettings({ ...settings, group_name_prefix: e.target.value })
              }
              disabled={isRunning}
              placeholder="Group"
              className="w-full p-2 border border-gray-300 rounded-md text-sm"
            />
          </Field>
          <Field label="Batch size (members per add request)">
            <input
              type="number"
              min={1}
              max={50}
              value={settings.batch_size}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  batch_size: clamp(Number(e.target.value), 1, 50),
                })
              }
              disabled={isRunning}
              className="w-full p-2 border border-gray-300 rounded-md text-sm"
            />
          </Field>

          <DelayRange
            label="Delay between batches (sec)"
            min={settings.batch_delay_min_s}
            max={settings.batch_delay_max_s}
            disabled={isRunning}
            onChange={(min, max) =>
              setSettings({ ...settings, batch_delay_min_s: min, batch_delay_max_s: max })
            }
          />

          <Field label="Delay after group fills (sec)">
            <input
              type="number"
              min={0}
              value={settings.post_group_delay_s}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  post_group_delay_s: Math.max(0, Number(e.target.value) || 0),
                })
              }
              disabled={isRunning}
              className="w-full p-2 border border-gray-300 rounded-md text-sm"
            />
          </Field>

          <DelayRange
            label="Delay between groups (sec)"
            min={settings.group_delay_min_s}
            max={settings.group_delay_max_s}
            disabled={isRunning}
            onChange={(min, max) =>
              setSettings({ ...settings, group_delay_min_s: min, group_delay_max_s: max })
            }
          />

          <Field label="Greeting message (optional)">
            <input
              value={settings.greeting_message ?? ""}
              onChange={(e) =>
                setSettings({ ...settings, greeting_message: e.target.value || null })
              }
              disabled={isRunning}
              placeholder={`Welcome to ${settings.group_name_prefix} ...`}
              className="w-full p-2 border border-gray-300 rounded-md text-sm"
            />
          </Field>
        </div>
      </section>

      {/* ---------------- Action buttons ---------------- */}
      <section className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
        <div className="flex flex-wrap gap-2">
          <button
            onClick={handleStart}
            disabled={isRunning || isPaused || !parseResult || !selectedAccountId}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            Start
          </button>
          <button
            onClick={handlePause}
            disabled={!isRunning}
            className="px-4 py-2 bg-yellow-500 text-white text-sm rounded-md hover:bg-yellow-600 disabled:opacity-50"
          >
            Pause
          </button>
          <button
            onClick={() => activeRunId && handleResumeRun(activeRunId)}
            disabled={!activeRunId || isRunning}
            className="px-4 py-2 bg-green-600 text-white text-sm rounded-md hover:bg-green-700 disabled:opacity-50"
          >
            Resume
          </button>
          <button
            onClick={handleStop}
            disabled={!isRunning && !isPaused}
            className="px-4 py-2 bg-red-600 text-white text-sm rounded-md hover:bg-red-700 disabled:opacity-50"
          >
            Stop
          </button>
          <button
            onClick={handleDownloadReport}
            disabled={!activeRunId}
            className="px-4 py-2 bg-gray-200 text-gray-700 text-sm rounded-md hover:bg-gray-300 disabled:opacity-50"
          >
            Download Report
          </button>
        </div>
        <p className="mt-2 text-xs text-gray-500">
          Total planned: {totalGroups} group{totalGroups === 1 ? "" : "s"} ·{" "}
          {parseResult?.unique_ids.length ?? 0} members
        </p>
      </section>

      {/* ---------------- Live progress ---------------- */}
      {progress && (
        <section className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
          <h3 className="text-sm font-medium text-gray-700 mb-3">Live status</h3>
          <StatusBanner status={progress.status} message={progress.message} />

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm my-3">
            <Metric label="Status" value={progress.status} />
            <Metric
              label="Group"
              value={`${progress.current_group_index + 1} / ${progress.total_groups}`}
            />
            <Metric label="Batch" value={`#${progress.current_batch}`} />
            <Metric label="Added" value={progress.members_added} accent="success" />
            <Metric label="Failed" value={progress.members_failed} accent="warn" />
            <Metric label="Remaining IDs" value={progress.remaining_ids} />
            <Metric label="Groups done" value={progress.groups_completed} />
            <Metric label="Run ID" value={`#${progress.run_id}`} />
          </div>

          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className="bg-blue-600 h-2 rounded-full transition-all duration-300"
              style={{ width: progressPercent + "%" }}
            />
          </div>
          <p className="text-xs text-gray-400 mt-1">{progressPercent}%</p>

          {progress.current_group_name && (
            <p className="text-xs text-gray-600 mt-2">
              Working on: <span className="font-mono">{progress.current_group_name}</span>
              {progress.current_thread_id && (
                <>
                  {" "}
                  (thread{" "}
                  <span className="font-mono text-gray-500">{progress.current_thread_id}</span>)
                </>
              )}
            </p>
          )}
        </section>
      )}

      {/* ---------------- Logs ---------------- */}
      {logs.length > 0 && (
        <section className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
          <h3 className="text-sm font-medium text-gray-700 mb-2">
            Live log ({logs.length})
          </h3>
          <div
            ref={logScrollRef}
            className="max-h-56 overflow-y-auto bg-gray-50 rounded-md p-2 font-mono text-xs space-y-0.5"
          >
            {logs.map((entry, i) => (
              <div
                key={i}
                className={
                  entry.level === "error"
                    ? "text-red-600"
                    : entry.level === "warn"
                      ? "text-yellow-700"
                      : "text-gray-700"
                }
              >
                [{new Date(entry.timestamp).toLocaleTimeString()}] {entry.message}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ---------------- Resume previous runs ---------------- */}
      {resumableRuns.length > 0 && !isRunning && (
        <section className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
          <h3 className="text-sm font-medium text-gray-700 mb-3">Previous runs</h3>
          <div className="space-y-2">
            {resumableRuns.map((run) => (
              <div
                key={run.id}
                className="flex items-center justify-between p-3 bg-gray-50 rounded-md"
              >
                <div className="text-sm">
                  <span className="font-medium text-gray-800">Run #{run.id}</span>
                  <span className="text-gray-400 mx-2">·</span>
                  <span
                    className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${runStatusColor(
                      run.status
                    )}`}
                  >
                    {run.status}
                  </span>
                  <span className="text-gray-400 mx-2">·</span>
                  <span className="text-gray-600">
                    {run.groups_completed}/{run.total_groups} groups · {run.members_added} added
                    · {run.members_failed} failed
                  </span>
                  <span className="text-gray-400 mx-2">|</span>
                  <span className="text-gray-400 text-xs">
                    {new Date(run.started_at).toLocaleString()}
                  </span>
                </div>
                {run.status !== "completed" && (
                  <button
                    onClick={() => handleResumeRun(run.id)}
                    className="px-3 py-1 bg-green-600 text-white text-xs rounded hover:bg-green-700"
                  >
                    Resume
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// =====================================================================
// Small helpers
// =====================================================================

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs text-gray-600 mb-1">{label}</span>
      {children}
    </label>
  );
}

function Metric({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: "success" | "warn" | "info";
}) {
  const color =
    accent === "success"
      ? "text-green-700"
      : accent === "warn"
        ? "text-yellow-700"
        : accent === "info"
          ? "text-blue-700"
          : "text-gray-800";
  return (
    <div className="bg-gray-50 rounded-md px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`text-sm font-semibold ${color}`}>{value}</div>
    </div>
  );
}

function DelayRange({
  label,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (min: number, max: number) => void;
}) {
  return (
    <div>
      <span className="block text-xs text-gray-600 mb-1">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={0}
          value={min}
          disabled={disabled}
          onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0), max)}
          className="w-24 p-2 border border-gray-300 rounded-md text-sm"
        />
        <span className="text-xs text-gray-400">to</span>
        <input
          type="number"
          min={0}
          value={max}
          disabled={disabled}
          onChange={(e) => onChange(min, Math.max(min, Number(e.target.value) || 0))}
          className="w-24 p-2 border border-gray-300 rounded-md text-sm"
        />
      </div>
    </div>
  );
}

function StatusBanner({ status, message }: { status: string; message: string }) {
  const cls =
    status === "running"
      ? "bg-blue-50 text-blue-700"
      : status === "paused"
        ? "bg-yellow-50 text-yellow-700"
        : status === "completed"
          ? "bg-green-50 text-green-700"
          : status === "stopped"
            ? "bg-gray-100 text-gray-700"
            : "bg-red-50 text-red-700";
  return <div className={`mb-3 rounded-md px-3 py-2 text-sm ${cls}`}>{message || status}</div>;
}

function runStatusColor(status: string) {
  switch (status) {
    case "running":
      return "bg-blue-100 text-blue-800";
    case "paused":
      return "bg-yellow-100 text-yellow-800";
    case "completed":
      return "bg-green-100 text-green-800";
    case "stopped":
      return "bg-gray-100 text-gray-700";
    case "failed":
      return "bg-red-100 text-red-800";
    default:
      return "bg-gray-100 text-gray-700";
  }
}

function clamp(n: number, lo: number, hi: number) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
