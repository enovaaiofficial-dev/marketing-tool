import { useState, useEffect, useCallback, useRef } from "react";
import type { Account, ExtractionProgress, ExtractionError } from "@shared/types";

export default function GroupExtractor() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [groupIdInput, setGroupIdInput] = useState("");
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [progress, setProgress] = useState<ExtractionProgress | null>(null);
  const [errors, setErrors] = useState<ExtractionError[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const errorLogRef = useRef<HTMLDivElement>(null);

  const loadAccounts = useCallback(async () => {
    try {
      const list = await window.api.accounts.list();
      setAccounts(list.filter((a) => a.status === "Valid"));
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    const unsubProgress = window.api.extraction.onProgress((p) => {
      setProgress(p);
      if (p.status === "completed" || p.status === "stopped") {
        setIsRunning(false);
      }
    });

    const unsubError = window.api.extraction.onError((e) => {
      setErrors((prev) => [...prev, e]);
    });

    return () => {
      unsubProgress();
      unsubError();
    };
  }, []);

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
    setProgress(null);

    showMessage("Extraction started", "success");
    window.api.extraction
      .start(groupIds, selectedAccountId)
      .then(({ outputPath }) => {
        showMessage(`Extraction finished: ${outputPath}`, "success");
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
    setTimeout(() => setMessage(null), 3000);
  };

  const progressPercent =
    progress && progress.total_groups > 0
      ? Math.round(((progress.current_group_index + 1) / progress.total_groups) * 100)
      : 0;

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
          {accounts.length === 0 && (
            <p className="mt-1 text-xs text-gray-400">
              No valid accounts. Add and validate tokens in Account Manager first.
            </p>
          )}
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

      {progress && (
        <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
          <h3 className="text-sm font-medium text-gray-700 mb-3">Progress</h3>

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
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <p className="text-xs text-gray-400 mt-1">{progressPercent}%</p>
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
