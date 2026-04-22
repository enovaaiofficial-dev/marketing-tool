import { useState, useEffect, useCallback } from "react";
import type { Account, TokenStatus } from "@shared/types";

export default function AccountManager() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [showUpload, setShowUpload] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  const loadAccounts = useCallback(async () => {
    try {
      const list = await window.api.accounts.list();
      setAccounts(list);
    } catch (err: any) {
      showMessage(err.message, "error");
    }
  }, []);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  const showMessage = (text: string, type: "success" | "error") => {
    setMessage({ text, type });
    setTimeout(() => setMessage(null), 3000);
  };

  const handleUpload = async () => {
    const tokens = tokenInput
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean);
    if (tokens.length === 0) return;

    setLoading(true);
    try {
      const result = await window.api.accounts.add(tokens);
      showMessage(`Added ${result.added} token(s). ${result.duplicates} duplicate(s) skipped.`, "success");
      setTokenInput("");
      setShowUpload(false);
      await loadAccounts();
    } catch (err: any) {
      showMessage(err.message, "error");
    }
    setLoading(false);
  };

  const handleValidate = async () => {
    setLoading(true);
    try {
      const ids = selectedIds.size > 0 ? Array.from(selectedIds) : undefined;
      await window.api.accounts.validate(ids);
      showMessage("Validation complete", "success");
      await loadAccounts();
    } catch (err: any) {
      showMessage(err.message, "error");
    }
    setLoading(false);
  };

  const handleDelete = async () => {
    if (selectedIds.size === 0) return;
    setLoading(true);
    try {
      await window.api.accounts.delete(Array.from(selectedIds));
      setSelectedIds(new Set());
      showMessage("Deleted successfully", "success");
      await loadAccounts();
    } catch (err: any) {
      showMessage(err.message, "error");
    }
    setLoading(false);
  };

  const [loginLoading, setLoginLoading] = useState<number | null>(null);

  const handleFacebookLogin = async (accountId: number) => {
    setLoginLoading(accountId);
    try {
      const result = await window.api.facebook.login(accountId);
      if (!result.success) {
        showMessage(result.error ?? "Login failed", "error");
      }
    } catch (err: any) {
      showMessage(err.message, "error");
    }
    setLoginLoading(null);
  };

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size === accounts.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(accounts.map((a) => a.id)));
    }
  };

  const statusColor = (status: TokenStatus) => {
    switch (status) {
      case "Valid":
        return "bg-green-100 text-green-800";
      case "Invalid":
        return "bg-red-100 text-red-800";
      case "Expired":
        return "bg-yellow-100 text-yellow-800";
      case "Blocked":
        return "bg-red-100 text-red-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  return (
    <div className="p-6 max-w-5xl">
      <h2 className="text-xl font-bold text-gray-900 mb-4">Account Manager</h2>

      {message && (
        <div
          className={`mb-4 px-4 py-2 rounded-md text-sm ${
            message.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setShowUpload(true)}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700"
        >
          Upload Tokens
        </button>
        <button
          onClick={handleValidate}
          disabled={loading}
          className="px-4 py-2 bg-green-600 text-white text-sm rounded-md hover:bg-green-700 disabled:opacity-50"
        >
          {loading ? "Checking..." : "Bulk Check"}
        </button>
        <button
          onClick={handleDelete}
          disabled={selectedIds.size === 0}
          className="px-4 py-2 bg-red-600 text-white text-sm rounded-md hover:bg-red-700 disabled:opacity-50"
        >
          Delete Selected ({selectedIds.size})
        </button>
        <button
          onClick={loadAccounts}
          className="px-4 py-2 bg-gray-200 text-gray-700 text-sm rounded-md hover:bg-gray-300"
        >
          Refresh
        </button>
      </div>

      {showUpload && (
        <div className="mb-4 p-4 bg-white border border-gray-200 rounded-lg">
          <h3 className="text-sm font-medium text-gray-700 mb-2">Upload Access Tokens</h3>
          <textarea
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="Paste tokens, one per line..."
            className="w-full h-32 p-2 border border-gray-300 rounded-md text-sm font-mono resize-y"
          />
          <div className="flex gap-2 mt-2">
            <button
              onClick={handleUpload}
              disabled={loading}
              className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              Submit
            </button>
            <button
              onClick={() => {
                setShowUpload(false);
                setTokenInput("");
              }}
              className="px-4 py-2 bg-gray-200 text-gray-700 text-sm rounded-md hover:bg-gray-300"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-3 text-left">
                <input
                  type="checkbox"
                  checked={accounts.length > 0 && selectedIds.size === accounts.length}
                  onChange={toggleAll}
                  className="rounded"
                />
              </th>
              <th className="px-4 py-3 text-left text-gray-600 font-medium">Token</th>
              <th className="px-4 py-3 text-left text-gray-600 font-medium">Name</th>
              <th className="px-4 py-3 text-left text-gray-600 font-medium">Account ID</th>
              <th className="px-4 py-3 text-left text-gray-600 font-medium">Status</th>
              <th className="px-4 py-3 text-left text-gray-600 font-medium">Last Check</th>
              <th className="px-4 py-3 text-left text-gray-600 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {accounts.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                  No accounts yet. Upload tokens to get started.
                </td>
              </tr>
            ) : (
              accounts.map((account) => (
                <tr key={account.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(account.id)}
                      onChange={() => toggleSelect(account.id)}
                      className="rounded"
                    />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">{account.token_preview}</td>
                  <td className="px-4 py-3 text-gray-900">{account.account_name ?? "—"}</td>
                  <td className="px-4 py-3 text-gray-600">{account.account_id ?? "—"}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${statusColor(account.status)}`}>
                      {account.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{account.last_check ?? "Never"}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleFacebookLogin(account.id)}
                      disabled={loginLoading === account.id}
                      className="px-2 py-1 bg-indigo-600 text-white text-xs rounded hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {loginLoading === account.id ? "Opening..." : "FB Login"}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
