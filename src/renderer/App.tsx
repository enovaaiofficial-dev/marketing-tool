import { useState } from "react";
import AccountManager from "./pages/AccountManager";
import GroupExtractor from "./pages/GroupExtractor";

type Page = "accounts" | "extractor";

export default function App() {
  const [page, setPage] = useState<Page>("accounts");

  return (
    <div className="flex h-screen bg-gray-50">
      <nav className="w-56 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-4 border-b border-gray-200">
          <h1 className="text-lg font-bold text-gray-900">Marketing Tool</h1>
        </div>
        <div className="flex flex-col p-2 gap-1">
          <button
            onClick={() => setPage("accounts")}
            className={`text-left px-3 py-2 rounded-md text-sm font-medium transition-colors ${
              page === "accounts"
                ? "bg-blue-50 text-blue-700"
                : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            Account Manager
          </button>
          <button
            onClick={() => setPage("extractor")}
            className={`text-left px-3 py-2 rounded-md text-sm font-medium transition-colors ${
              page === "extractor"
                ? "bg-blue-50 text-blue-700"
                : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            Group Extractor
          </button>
        </div>
      </nav>
      <main className="flex-1 overflow-auto">
        {page === "accounts" && <AccountManager />}
        {page === "extractor" && <GroupExtractor />}
      </main>
    </div>
  );
}
