import { useState, useEffect, useCallback, useRef } from "react";
import type { Account, ExtractionProgress, ExtractionError } from "@shared/types";
import type { StoppedRun } from "../types";

const MAX_CONCURRENCY = 5;

export default function GroupExtractor() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [groupIdInput, setGroupIdInput] = useState("");
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [progress, setProgress] = useState<ExtractionProgress | null>(null);
  const [errors, setErrors] = useState<ExtractionError[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [showScraperWindow, setShowScraperWindow] = useState(false);
  const [concurrency, setConcurrency] = useState<number>(1);
  const [stoppedRuns, setStoppedRuns] = useState<StoppedRun[]>([]);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const errorLogRef = useRef<HTMLDivElement>(null);

  const effectiveConcurrencyMax = Math.max(1, Math.min(accounts.length, MAX_CONCURRENCY));

  const loadAccounts = useCallback(async () => {
    try {
      const list = await window.api.accounts.list();
      setAccounts(list.filter((a) => a.status === "Valid"));
    } catch {}
  }, []);

  const loadStoppedRuns = useCallback(async () => {
    try {
      const runs = await window.api.extraction.stoppedRuns();
      setStoppedRuns(runs);
    } catch {}
  }, []);

  useEffect(() => {
    loadAccounts();
    loadStoppedRuns();
  }, [loadAccounts, loadStoppedRuns]);

  // Default the concurrency input to the number of valid accounts (capped),
  // so users with multiple accounts get parallel workers automatically.
  useEffect(() => {
    if (accounts.length === 0) return;
    setConcurrency((prev) => {
      const target = Math.min(accounts.length, MAX_CONCURRENCY);
      // Only auto-update if the user hasn't manually picked a value within range.
      return prev === 1 || prev > target ? target : prev;
    });
  }, [accounts.length]);

  useEffect(() => {
    const unsubProgress = window.api.extraction.onProgress((p) => {
      setProgress(p);
      if (p.status === "completed" || p.status === "stopped" || p.status === "failed") {
        setIsRunning(false);
        loadStoppedRuns();
      }
    });

    const unsubError = window.api.extraction.onError((e) => {
      setErrors((prev) => [...prev, e]);
    });

    return () => {
      unsubProgress();
      unsubError();
    };
  }, [loadStoppedRuns]);

  useEffect(() => {
    if (errorLogRef.current) {
      errorLogRef.current.scrollTop = errorLogRef.current.scrollHeight;
    }
  }, [errors]);

  const handleStart = async () => {
    const groupIds = groupIdInput
      .split(/[\n,]+/)
      .map((g) => g.trim())
      .filter(Boolean);

    if (groupIds.length === 0) {
      showMessage("Enter at least one Group ID", "error");
      return;
    }
    if (!selectedAccountId) {
      showMessage("Select an account", "error");
      return;
    }

    setIsRunning(true);
    setErrors([]);
    setProgress({
      current_group_id: groupIds[0] ?? "",
      current_group_index: 0,
      total_groups: groupIds.length,
      members_extracted: 0,
      current_batch: 0,
      status: "running",
    });

    const clampedConcurrency = Math.max(1, Math.min(concurrency, effectiveConcurrencyMax));
    showMessage("Extraction started", "success");
    window.api.extraction
      .start(groupIds, selectedAccountId, {
        concurrency: clampedConcurrency,
        showWindow: showScraperWindow,
      })
      .then(({ outputPath }) => {
        showMessage("Extraction finished: " + outputPath, "success");
      })
      .catch((err: any) => {
        showMessage(err.message, "error");
        setIsRunning(false);
      });
  };

  const handleResume = async (run: StoppedRun) => {
    setIsRunning(true);
    setErrors([]);
    const clampedConcurrency = Math.max(1, Math.min(concurrency, effectiveConcurrencyMax));
    showMessage("Resuming extraction...", "success");
    window.api.extraction
      .resumeRun(run.id, {
        concurrency: clampedConcurrency,
        showWindow: showScraperWindow,
      })
      .then(({ outputPath }) => {
        showMessage("Extraction resumed and finished: " + outputPath, "success");
      })
      .catch((err: any) => {
        showMessage(err.message, "error");
        setIsRunning(false);
      });
  };

  const handleStop = async () => {
    await window.api.extraction.stop();
    setIsRunning(false);
  };

  const showMessage = (text: string, type: "success" | "error") => {
    setMessage({ text, type });
    setTimeout(() => setMessage(null), 4000);
  };

  const progressPercent =
    progress && progress.total_groups > 0
      ? Math.round(((progress.current_group_index + 1) / progress.total_groups) * 100)
      : 0;
  const hasExtractedMembers = (progress?.members_extracted ?? 0) > 0;

  return (
    <div className="p-6 max-w-5xl">
      <h2 className="text-xl font-bold text-gray-900 mb-4">Group Members Extractor</h2>

      {message && (
        <div
          className={`mb-4 px-4 py-2 rounded-md text-sm ${
            message.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Group IDs</label>
          <textarea
            value={groupIdInput}
            onChange={(e) => setGroupIdInput(e.target.value)}
            placeholder="Enter Group IDs, one per line or comma-separated..."
            className="w-full h-24 p-2 border border-gray-300 rounded-md text-sm font-mono resize-y"
            disabled={isRunning}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Source Account</label>
          <select
            value={selectedAccountId ?? ""}
            onChange={(e) => setSelectedAccountId(Number(e.target.value) || null)}
            className="w-full p-2 border border-gray-300 rounded-md text-sm"
            disabled={isRunning}
          >
            <option value="">Select an account...</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.account_name ?? "Unknown"} ({a.token_preview})
              </option>
            ))}
          </select>
          {accounts.length > 1 && (
            <p className="mt-1 text-xs text-blue-600">
              {accounts.length} valid accounts available — extraction runs up to {effectiveConcurrencyMax} groups in parallel (one per account)
            </p>
          )}
          {accounts.length === 0 && (
            <p className="mt-1 text-xs text-gray-400">
              No valid accounts. Add and validate tokens in Account Manager first.
            </p>
          )}
        </div>

        <div className="border-t border-gray-100 pt-4 space-y-3">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Extraction options
          </p>

          <div className="flex items-center gap-3">
            <label htmlFor="concurrency" className="text-sm text-gray-700 min-w-[120px]">
              Parallel workers
            </label>
            <input
              id="concurrency"
              type="number"
              min={1}
              max={effectiveConcurrencyMax}
              value={concurrency}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v > 0) {
                  setConcurrency(Math.min(Math.max(1, Math.floor(v)), effectiveConcurrencyMax));
                }
              }}
              disabled={isRunning || accounts.length <= 1}
              className="w-20 p-1.5 border border-gray-300 rounded-md text-sm"
            />
            <span className="text-xs text-gray-500">
              {accounts.length <= 1
                ? "(need 2+ valid accounts to parallelize)"
                : `1 worker per account · max ${effectiveConcurrencyMax}`}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="showScraperWindow"
              checked={showScraperWindow}
              onChange={(e) => setShowScraperWindow(e.target.checked)}
              disabled={isRunning}
              className="h-4 w-4 rounded border-gray-300 text-blue-600"
            />
            <label htmlFor="showScraperWindow" className="text-sm text-gray-700">
              Show scraper windows (debug — slower)
            </label>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleStart}
            disabled={isRunning || accounts.length === 0}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            Start Extraction
          </button>
          <button
            onClick={handleStop}
            disabled={!isRunning}
            className="px-4 py-2 bg-red-600 text-white text-sm rounded-md hover:bg-red-700 disabled:opacity-50"
          >
            Stop Extraction
          </button>
        </div>
      </div>

      {stoppedRuns.length > 0 && !isRunning && (
        <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
          <h3 className="text-sm font-medium text-gray-700 mb-3">Resume Previous Runs</h3>
          <div className="space-y-2">
            {stoppedRuns.map((run) => (
              <div key={run.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-md">
                <div className="text-sm">
                  <span className="font-medium text-gray-800">Run #{run.id}</span>
                  <span className="text-gray-500 mx-2">—</span>
                  <span className="text-gray-600">
                    {JSON.parse(run.group_ids).length} group(s),
                    {" "}{run.members_extracted} extracted,
                    {" "}batch #{run.current_batch}
                  </span>
                  <span className="text-gray-400 mx-2">|</span>
                  <span className="text-gray-400 text-xs">{new Date(run.started_at).toLocaleString()}</span>
                </div>
                <button
                  onClick={() => handleResume(run)}
                  className="px-3 py-1 bg-green-600 text-white text-xs rounded hover:bg-green-700"
                >
                  Resume
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {progress && (
        <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
          <h3 className="text-sm font-medium text-gray-700 mb-3">Progress</h3>

          <div
            className={`mb-3 rounded-md px-3 py-2 text-sm ${
              progress.status === "running"
                ? "bg-blue-50 text-blue-700"
                : progress.status === "failed"
                  ? "bg-red-50 text-red-700"
                : hasExtractedMembers
                  ? "bg-green-50 text-green-700"
                  : errors.length > 0
                    ? "bg-red-50 text-red-700"
                    : "bg-yellow-50 text-yellow-700"
            }`}
          >
            {progress.status === "running" &&
              "Extracting group " + (progress.current_group_index + 1) + " of " + progress.total_groups + "..."}
            {progress.status === "failed" &&
              "Extraction failed. Facebook denied access or another extraction error occurred."}
            {progress.status === "completed" &&
              (hasExtractedMembers
                ? "Extraction completed. Extracted " + progress.members_extracted + " member" + (progress.members_extracted === 1 ? "" : "s") + "."
                : "Extraction completed, but no members were extracted.")}
            {progress.status === "stopped" &&
              "Extraction stopped. Extracted " + progress.members_extracted + " member" + (progress.members_extracted === 1 ? "" : "s") + ". Use Resume to continue."}
          </div>

          <div className="grid grid-cols-2 gap-2 text-sm mb-3">
            <div>
              <span className="text-gray-500">Status:</span>{" "}
              <span className="font-medium">{progress.status}</span>
            </div>
            <div>
              <span className="text-gray-500">Group:</span>{" "}
              <span className="font-medium">
                {progress.current_group_index + 1} / {progress.total_groups}
              </span>
            </div>
            <div>
              <span className="text-gray-500">Members:</span>{" "}
              <span className="font-medium">{progress.members_extracted}</span>
            </div>
            <div>
              <span className="text-gray-500">Last Batch:</span>{" "}
              <span className="font-medium">#{progress.current_batch}</span>
            </div>
          </div>

          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className="bg-blue-600 h-2 rounded-full transition-all duration-300"
              style={{ width: progressPercent + "%" }}
            />
          </div>
          <p className="text-xs text-gray-400 mt-1">{progressPercent}%</p>

          {progress.status !== "running" && progress.status !== "failed" && !hasExtractedMembers && (
            <p className="text-xs text-gray-500 mt-2">
              No member rows were written to the CSV for this run.
            </p>
          )}
        </div>
      )}

      {errors.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h3 className="text-sm font-medium text-red-700 mb-2">Error Log ({errors.length})</h3>
          <div ref={errorLogRef} className="max-h-40 overflow-y-auto space-y-1">
            {errors.map((err, i) => (
              <div key={i} className="text-xs font-mono text-red-600">
                [{err.group_id}] Batch {err.batch_number}: {err.error_message}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
