import { createRequire } from "node:module";
import { BrowserWindow, app, dialog, ipcMain, session } from "electron";
import { dirname, join, resolve } from "path";
import Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "fs";
// -- CommonJS Shims --
import __cjs_mod__ from "node:module";
import.meta.filename;
const __dirname = import.meta.dirname;
__cjs_mod__.createRequire(import.meta.url);
//#region \0rolldown/runtime.js
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
var __require = /* @__PURE__ */ createRequire(import.meta.url);
//#endregion
//#region src/main/db/schema.ts
function createTables(db) {
	db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_encrypted TEXT NOT NULL,
      token_iv TEXT NOT NULL,
      account_name TEXT,
      account_id TEXT,
      status TEXT NOT NULL DEFAULT 'Unchecked',
      last_check TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_token
      ON accounts(token_encrypted);

    CREATE TABLE IF NOT EXISTS extraction_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_ids TEXT NOT NULL,
      source_account_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      output_path TEXT NOT NULL,
      members_extracted INTEGER DEFAULT 0,
      FOREIGN KEY (source_account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS extraction_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      member_id TEXT NOT NULL,
      member_name TEXT,
      profile_url TEXT,
      group_id TEXT NOT NULL,
      group_name TEXT,
      extracted_at TEXT DEFAULT (datetime('now')),
      source_account TEXT,
      FOREIGN KEY (run_id) REFERENCES extraction_runs(id) ON DELETE CASCADE,
      UNIQUE(member_id, run_id)
    );

    CREATE TABLE IF NOT EXISTS extraction_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      group_id TEXT NOT NULL,
      batch_number INTEGER NOT NULL,
      error_message TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES extraction_runs(id) ON DELETE CASCADE
    );
  `);
}
//#endregion
//#region src/main/db/connection.ts
var db = null;
function initDB() {
	if (db) return db;
	db = new Database(join(app.getPath("userData"), "marketing.db"));
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	createTables(db);
	return db;
}
function getDB() {
	if (!db) throw new Error("Database not initialized. Call initDB() first.");
	return db;
}
//#endregion
//#region src/shared/constants.ts
var REQUEST_DELAY_MS = 2e3;
var ENCRYPTION_ALGORITHM = "aes-256-cbc";
var CSV_FIELDS = [
	"member_id",
	"member_name",
	"profile_url",
	"group_id",
	"group_name",
	"extracted_at",
	"source_account"
];
//#endregion
//#region src/main/crypto.ts
var ENCRYPTION_KEY = getEncryptionKey();
function getEncryptionKey() {
	const envKey = process.env.ENCRYPTION_KEY;
	if (envKey) return Buffer.from(envKey, "hex");
	return Buffer.from("default-dev-key-do-not-use-in-production!", "utf8").subarray(0, 32);
}
function encryptToken(plain) {
	const iv = randomBytes(16);
	const cipher = createCipheriv(ENCRYPTION_ALGORITHM, ENCRYPTION_KEY, iv);
	return {
		encrypted: Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString("hex"),
		iv: iv.toString("hex")
	};
}
function decryptToken(encrypted, iv) {
	const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, ENCRYPTION_KEY, Buffer.from(iv, "hex"));
	return Buffer.concat([decipher.update(Buffer.from(encrypted, "hex")), decipher.final()]).toString("utf8");
}
function maskToken(token) {
	if (token.length <= 8) return token + "****";
	return token.slice(0, 8) + "****";
}
//#endregion
//#region src/main/db/accounts-repo.ts
function addTokens(rawTokens) {
	const insert = getDB().prepare("INSERT INTO accounts (token_encrypted, token_iv, status) VALUES (?, ?, 'Unchecked')");
	let added = 0;
	let duplicates = 0;
	const seen = /* @__PURE__ */ new Set();
	for (const raw of rawTokens) {
		const token = raw.trim();
		if (!token || seen.has(token)) {
			if (token) duplicates++;
			continue;
		}
		seen.add(token);
		const { encrypted, iv } = encryptToken(token);
		try {
			insert.run(encrypted, iv);
			added++;
		} catch (err) {
			if (err.message?.includes("UNIQUE constraint")) duplicates++;
			else throw err;
		}
	}
	return {
		added,
		duplicates
	};
}
function getAccounts() {
	return getDB().prepare(`SELECT id, token_encrypted, token_iv, account_name, account_id, status, last_check, created_at
       FROM accounts ORDER BY created_at DESC`).all().map((row) => ({
		id: row.id,
		token_preview: maskToken(decryptToken(row.token_encrypted, row.token_iv)),
		account_name: row.account_name,
		account_id: row.account_id,
		status: row.status,
		last_check: row.last_check,
		created_at: row.created_at
	}));
}
function updateAccountStatus(id, status, name, accountId) {
	getDB().prepare(`UPDATE accounts SET status = ?, account_name = COALESCE(?, account_name), account_id = COALESCE(?, account_id), last_check = datetime('now') WHERE id = ?`).run(status, name ?? null, accountId ?? null, id);
}
function deleteAccounts(ids) {
	const db = getDB();
	const placeholders = ids.map(() => "?").join(",");
	const deleteErrors = db.prepare(`DELETE FROM extraction_errors WHERE run_id IN (SELECT id FROM extraction_runs WHERE source_account_id IN (${placeholders}))`);
	const deleteMembers = db.prepare(`DELETE FROM extraction_members WHERE run_id IN (SELECT id FROM extraction_runs WHERE source_account_id IN (${placeholders}))`);
	const deleteRuns = db.prepare(`DELETE FROM extraction_runs WHERE source_account_id IN (${placeholders})`);
	const deleteAccounts = db.prepare(`DELETE FROM accounts WHERE id IN (${placeholders})`);
	return db.transaction(() => {
		deleteErrors.run(...ids);
		deleteMembers.run(...ids);
		deleteRuns.run(...ids);
		return deleteAccounts.run(...ids).changes;
	})();
}
function getDecryptedToken(id) {
	const row = getDB().prepare("SELECT token_encrypted, token_iv, account_name FROM accounts WHERE id = ?").get(id);
	if (!row) throw new Error(`Account ${id} not found`);
	return {
		token: decryptToken(row.token_encrypted, row.token_iv),
		name: row.account_name ?? "Unknown"
	};
}
function getAccountsForValidation(ids) {
	const db = getDB();
	if (ids && ids.length > 0) {
		const placeholders = ids.map(() => "?").join(",");
		return db.prepare(`SELECT id, token_encrypted, token_iv FROM accounts WHERE id IN (${placeholders})`).all(...ids);
	}
	return db.prepare("SELECT id, token_encrypted, token_iv FROM accounts").all();
}
//#endregion
//#region src/main/api/platform-client.ts
var GRAPH_API = "https://graph.facebook.com/v21.0";
function buildMemberPage(data, paging) {
	const members = (data ?? []).map((m) => ({
		id: m.id,
		name: m.name ?? "",
		link: m.link ?? `https://www.facebook.com/${m.id}`
	}));
	const nextPageLink = paging?.next ?? null;
	const nextCursor = paging?.cursors?.after ?? null;
	const hasMore = !!nextPageLink || !!nextCursor;
	return {
		members,
		hasMore,
		nextCursor: hasMore ? nextCursor : null,
		nextPageUrl: hasMore ? nextPageLink : null
	};
}
function shouldRetryWithMembersField(error) {
	if (!error || error.code !== 100) return false;
	const msg = error.message?.toLowerCase() ?? "";
	return msg.includes("nonexisting field") && msg.includes("members");
}
function extractAfterCursor(url) {
	if (!url) return null;
	try {
		return new URL(url).searchParams.get("after");
	} catch {
		return null;
	}
}
function buildMembersFieldUrl(token, groupId, limit, afterCursor) {
	const fields = afterCursor ? `members.after(${afterCursor}).limit(${limit}){id,name,link}` : `members.limit(${limit}){id,name,link}`;
	return `${GRAPH_API}/${encodeURIComponent(groupId)}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(token)}`;
}
function classifyStatus(error) {
	if (error.error_subcode === 463 || error.error_subcode === 467) return "Expired";
	if (error.code === 190 && (error.message?.toLowerCase().includes("checkpoint") || error.message?.toLowerCase().includes("logged-in"))) return "Blocked";
	if (error.code === 10 || error.code === 100 || error.code === 190) return "Invalid";
	if (error.error_subcode === 368 || error.code === 368 || error.message?.toLowerCase().includes("blocked")) return "Blocked";
	return "Invalid";
}
function formatGraphError(error, context, groupId) {
	if (context === "group-members" && error.code === 10) return `Token is valid for login, but Facebook denied access to members of group ${groupId} (code 10). The selected account does not have permission to read this group's member list.`;
	if (context === "group-members" && error.code === 190) return `Facebook rejected the token while reading members for group ${groupId} (code 190). Re-login, pass any checkpoint, then validate the token again.`;
	if (context === "group-members" && error.code === 100) return `Facebook does not allow the requested members endpoint for group ${groupId} (code 100). The token or app context cannot access this group's member list.`;
	if (context === "group-info" && error.code === 10) return `Facebook denied access to group ${groupId} metadata (code 10). The selected account may not be allowed to access this group.`;
	return `[${error.code}] ${error.message}`;
}
async function validateToken(token) {
	try {
		const data = await (await fetch(`${GRAPH_API}/me?fields=id,name&access_token=${encodeURIComponent(token)}`)).json();
		if (data.error) return {
			valid: false,
			status: classifyStatus(data.error)
		};
		return {
			valid: true,
			status: "Valid",
			name: data.name ?? void 0,
			id: data.id ?? void 0
		};
	} catch {
		return {
			valid: false,
			status: "Invalid"
		};
	}
}
async function fetchGroupInfo(token, groupId) {
	try {
		const data = await (await fetch(`${GRAPH_API}/${encodeURIComponent(groupId)}?fields=name&access_token=${encodeURIComponent(token)}`)).json();
		if (data.error) throw new Error(formatGraphError(data.error, "group-info", groupId));
		if (!data.name) return null;
		return { name: data.name };
	} catch {
		return null;
	}
}
async function fetchGroupMembers(token, groupId, afterCursor, limit = 10, nextPageUrl) {
	let url = nextPageUrl ?? "";
	if (!url) {
		url = `${GRAPH_API}/${encodeURIComponent(groupId)}/members?fields=id,name,link&limit=${limit}&access_token=${encodeURIComponent(token)}`;
		if (afterCursor) url += `&after=${encodeURIComponent(afterCursor)}`;
	}
	const data = await (await fetch(url)).json();
	if (data.error) {
		if (shouldRetryWithMembersField(data.error)) {
			const fallbackUrl = buildMembersFieldUrl(token, groupId, limit, afterCursor ?? extractAfterCursor(nextPageUrl));
			const fallbackData = await (await fetch(fallbackUrl)).json();
			if (fallbackData.error) throw new Error(formatGraphError(fallbackData.error, "group-members", groupId));
			return buildMemberPage(fallbackData.members?.data ?? [], fallbackData.members?.paging);
		}
		throw new Error(formatGraphError(data.error, "group-members", groupId));
	}
	return buildMemberPage(data.data ?? [], data.paging);
}
//#endregion
//#region src/main/ipc/accounts.ts
function registerAccountHandlers() {
	ipcMain.handle("account:add", async (_event, tokens) => {
		return addTokens(tokens);
	});
	ipcMain.handle("account:list", async () => {
		return getAccounts();
	});
	ipcMain.handle("account:validate", async (_event, ids) => {
		const accounts = getAccountsForValidation(ids);
		const results = [];
		for (const account of accounts) {
			const result = await validateToken(decryptToken(account.token_encrypted, account.token_iv));
			updateAccountStatus(account.id, result.status, result.name, result.id);
			results.push({
				id: account.id,
				status: result.status,
				name: result.name,
				accountId: result.id
			});
		}
		return { results };
	});
	ipcMain.handle("account:delete", async (_event, ids) => {
		return { deleted: deleteAccounts(ids) };
	});
	ipcMain.handle("account:export", async () => {
		return { path: "" };
	});
}
//#endregion
//#region node_modules/csv-writer/dist/lib/csv-stringifiers/abstract.js
var require_abstract = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var DEFAULT_RECORD_DELIMITER = "\n";
	var VALID_RECORD_DELIMITERS = [DEFAULT_RECORD_DELIMITER, "\r\n"];
	exports.CsvStringifier = function() {
		function CsvStringifier(fieldStringifier, recordDelimiter) {
			if (recordDelimiter === void 0) recordDelimiter = DEFAULT_RECORD_DELIMITER;
			this.fieldStringifier = fieldStringifier;
			this.recordDelimiter = recordDelimiter;
			_validateRecordDelimiter(recordDelimiter);
		}
		CsvStringifier.prototype.getHeaderString = function() {
			var headerRecord = this.getHeaderRecord();
			return headerRecord ? this.joinRecords([this.getCsvLine(headerRecord)]) : null;
		};
		CsvStringifier.prototype.stringifyRecords = function(records) {
			var _this = this;
			var csvLines = Array.from(records, function(record) {
				return _this.getCsvLine(_this.getRecordAsArray(record));
			});
			return this.joinRecords(csvLines);
		};
		CsvStringifier.prototype.getCsvLine = function(record) {
			var _this = this;
			return record.map(function(fieldValue) {
				return _this.fieldStringifier.stringify(fieldValue);
			}).join(this.fieldStringifier.fieldDelimiter);
		};
		CsvStringifier.prototype.joinRecords = function(records) {
			return records.join(this.recordDelimiter) + this.recordDelimiter;
		};
		return CsvStringifier;
	}();
	function _validateRecordDelimiter(delimiter) {
		if (VALID_RECORD_DELIMITERS.indexOf(delimiter) === -1) throw new Error("Invalid record delimiter `" + delimiter + "` is specified");
	}
}));
//#endregion
//#region node_modules/csv-writer/dist/lib/csv-stringifiers/array.js
var require_array = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __extends = exports && exports.__extends || (function() {
		var extendStatics = function(d, b) {
			extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d, b) {
				d.__proto__ = b;
			} || function(d, b) {
				for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
			};
			return extendStatics(d, b);
		};
		return function(d, b) {
			extendStatics(d, b);
			function __() {
				this.constructor = d;
			}
			d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
		};
	})();
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ArrayCsvStringifier = function(_super) {
		__extends(ArrayCsvStringifier, _super);
		function ArrayCsvStringifier(fieldStringifier, recordDelimiter, header) {
			var _this = _super.call(this, fieldStringifier, recordDelimiter) || this;
			_this.header = header;
			return _this;
		}
		ArrayCsvStringifier.prototype.getHeaderRecord = function() {
			return this.header;
		};
		ArrayCsvStringifier.prototype.getRecordAsArray = function(record) {
			return record;
		};
		return ArrayCsvStringifier;
	}(require_abstract().CsvStringifier);
}));
//#endregion
//#region node_modules/csv-writer/dist/lib/field-stringifier.js
var require_field_stringifier = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __extends = exports && exports.__extends || (function() {
		var extendStatics = function(d, b) {
			extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d, b) {
				d.__proto__ = b;
			} || function(d, b) {
				for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
			};
			return extendStatics(d, b);
		};
		return function(d, b) {
			extendStatics(d, b);
			function __() {
				this.constructor = d;
			}
			d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
		};
	})();
	Object.defineProperty(exports, "__esModule", { value: true });
	var DEFAULT_FIELD_DELIMITER = ",";
	var VALID_FIELD_DELIMITERS = [DEFAULT_FIELD_DELIMITER, ";"];
	var FieldStringifier = function() {
		function FieldStringifier(fieldDelimiter) {
			this.fieldDelimiter = fieldDelimiter;
		}
		FieldStringifier.prototype.isEmpty = function(value) {
			return typeof value === "undefined" || value === null || value === "";
		};
		FieldStringifier.prototype.quoteField = function(field) {
			return "\"" + field.replace(/"/g, "\"\"") + "\"";
		};
		return FieldStringifier;
	}();
	exports.FieldStringifier = FieldStringifier;
	var DefaultFieldStringifier = function(_super) {
		__extends(DefaultFieldStringifier, _super);
		function DefaultFieldStringifier() {
			return _super !== null && _super.apply(this, arguments) || this;
		}
		DefaultFieldStringifier.prototype.stringify = function(value) {
			if (this.isEmpty(value)) return "";
			var str = String(value);
			return this.needsQuote(str) ? this.quoteField(str) : str;
		};
		DefaultFieldStringifier.prototype.needsQuote = function(str) {
			return str.includes(this.fieldDelimiter) || str.includes("\n") || str.includes("\"");
		};
		return DefaultFieldStringifier;
	}(FieldStringifier);
	var ForceQuoteFieldStringifier = function(_super) {
		__extends(ForceQuoteFieldStringifier, _super);
		function ForceQuoteFieldStringifier() {
			return _super !== null && _super.apply(this, arguments) || this;
		}
		ForceQuoteFieldStringifier.prototype.stringify = function(value) {
			return this.isEmpty(value) ? "" : this.quoteField(String(value));
		};
		return ForceQuoteFieldStringifier;
	}(FieldStringifier);
	function createFieldStringifier(fieldDelimiter, alwaysQuote) {
		if (fieldDelimiter === void 0) fieldDelimiter = DEFAULT_FIELD_DELIMITER;
		if (alwaysQuote === void 0) alwaysQuote = false;
		_validateFieldDelimiter(fieldDelimiter);
		return alwaysQuote ? new ForceQuoteFieldStringifier(fieldDelimiter) : new DefaultFieldStringifier(fieldDelimiter);
	}
	exports.createFieldStringifier = createFieldStringifier;
	function _validateFieldDelimiter(delimiter) {
		if (VALID_FIELD_DELIMITERS.indexOf(delimiter) === -1) throw new Error("Invalid field delimiter `" + delimiter + "` is specified");
	}
}));
//#endregion
//#region node_modules/csv-writer/dist/lib/lang/object.js
var require_object$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.isObject = function(value) {
		return Object.prototype.toString.call(value) === "[object Object]";
	};
}));
//#endregion
//#region node_modules/csv-writer/dist/lib/csv-stringifiers/object.js
var require_object = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __extends = exports && exports.__extends || (function() {
		var extendStatics = function(d, b) {
			extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d, b) {
				d.__proto__ = b;
			} || function(d, b) {
				for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
			};
			return extendStatics(d, b);
		};
		return function(d, b) {
			extendStatics(d, b);
			function __() {
				this.constructor = d;
			}
			d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
		};
	})();
	Object.defineProperty(exports, "__esModule", { value: true });
	var abstract_1 = require_abstract();
	var object_1 = require_object$1();
	exports.ObjectCsvStringifier = function(_super) {
		__extends(ObjectCsvStringifier, _super);
		function ObjectCsvStringifier(fieldStringifier, header, recordDelimiter, headerIdDelimiter) {
			var _this = _super.call(this, fieldStringifier, recordDelimiter) || this;
			_this.header = header;
			_this.headerIdDelimiter = headerIdDelimiter;
			return _this;
		}
		ObjectCsvStringifier.prototype.getHeaderRecord = function() {
			if (!this.isObjectHeader) return null;
			return this.header.map(function(field) {
				return field.title;
			});
		};
		ObjectCsvStringifier.prototype.getRecordAsArray = function(record) {
			var _this = this;
			return this.fieldIds.map(function(fieldId) {
				return _this.getNestedValue(record, fieldId);
			});
		};
		ObjectCsvStringifier.prototype.getNestedValue = function(obj, key) {
			if (!this.headerIdDelimiter) return obj[key];
			return key.split(this.headerIdDelimiter).reduce(function(subObj, keyPart) {
				return (subObj || {})[keyPart];
			}, obj);
		};
		Object.defineProperty(ObjectCsvStringifier.prototype, "fieldIds", {
			get: function() {
				return this.isObjectHeader ? this.header.map(function(column) {
					return column.id;
				}) : this.header;
			},
			enumerable: true,
			configurable: true
		});
		Object.defineProperty(ObjectCsvStringifier.prototype, "isObjectHeader", {
			get: function() {
				return object_1.isObject(this.header && this.header[0]);
			},
			enumerable: true,
			configurable: true
		});
		return ObjectCsvStringifier;
	}(abstract_1.CsvStringifier);
}));
//#endregion
//#region node_modules/csv-writer/dist/lib/csv-stringifier-factory.js
var require_csv_stringifier_factory = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var array_1 = require_array();
	var field_stringifier_1 = require_field_stringifier();
	var object_1 = require_object();
	exports.CsvStringifierFactory = function() {
		function CsvStringifierFactory() {}
		CsvStringifierFactory.prototype.createArrayCsvStringifier = function(params) {
			var fieldStringifier = field_stringifier_1.createFieldStringifier(params.fieldDelimiter, params.alwaysQuote);
			return new array_1.ArrayCsvStringifier(fieldStringifier, params.recordDelimiter, params.header);
		};
		CsvStringifierFactory.prototype.createObjectCsvStringifier = function(params) {
			var fieldStringifier = field_stringifier_1.createFieldStringifier(params.fieldDelimiter, params.alwaysQuote);
			return new object_1.ObjectCsvStringifier(fieldStringifier, params.header, params.recordDelimiter, params.headerIdDelimiter);
		};
		return CsvStringifierFactory;
	}();
}));
//#endregion
//#region node_modules/csv-writer/dist/lib/lang/promise.js
var require_promise = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __spreadArrays = exports && exports.__spreadArrays || function() {
		for (var s = 0, i = 0, il = arguments.length; i < il; i++) s += arguments[i].length;
		for (var r = Array(s), k = 0, i = 0; i < il; i++) for (var a = arguments[i], j = 0, jl = a.length; j < jl; j++, k++) r[k] = a[j];
		return r;
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	function promisify(fn) {
		return function() {
			var args = [];
			for (var _i = 0; _i < arguments.length; _i++) args[_i] = arguments[_i];
			return new Promise(function(resolve, reject) {
				var nodeCallback = function(err, result) {
					if (err) reject(err);
					else resolve(result);
				};
				fn.apply(null, __spreadArrays(args, [nodeCallback]));
			});
		};
	}
	exports.promisify = promisify;
}));
//#endregion
//#region node_modules/csv-writer/dist/lib/file-writer.js
var require_file_writer = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __awaiter = exports && exports.__awaiter || function(thisArg, _arguments, P, generator) {
		function adopt(value) {
			return value instanceof P ? value : new P(function(resolve) {
				resolve(value);
			});
		}
		return new (P || (P = Promise))(function(resolve, reject) {
			function fulfilled(value) {
				try {
					step(generator.next(value));
				} catch (e) {
					reject(e);
				}
			}
			function rejected(value) {
				try {
					step(generator["throw"](value));
				} catch (e) {
					reject(e);
				}
			}
			function step(result) {
				result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
			}
			step((generator = generator.apply(thisArg, _arguments || [])).next());
		});
	};
	var __generator = exports && exports.__generator || function(thisArg, body) {
		var _ = {
			label: 0,
			sent: function() {
				if (t[0] & 1) throw t[1];
				return t[1];
			},
			trys: [],
			ops: []
		}, f, y, t, g;
		return g = {
			next: verb(0),
			"throw": verb(1),
			"return": verb(2)
		}, typeof Symbol === "function" && (g[Symbol.iterator] = function() {
			return this;
		}), g;
		function verb(n) {
			return function(v) {
				return step([n, v]);
			};
		}
		function step(op) {
			if (f) throw new TypeError("Generator is already executing.");
			while (_) try {
				if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
				if (y = 0, t) op = [op[0] & 2, t.value];
				switch (op[0]) {
					case 0:
					case 1:
						t = op;
						break;
					case 4:
						_.label++;
						return {
							value: op[1],
							done: false
						};
					case 5:
						_.label++;
						y = op[1];
						op = [0];
						continue;
					case 7:
						op = _.ops.pop();
						_.trys.pop();
						continue;
					default:
						if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) {
							_ = 0;
							continue;
						}
						if (op[0] === 3 && (!t || op[1] > t[0] && op[1] < t[3])) {
							_.label = op[1];
							break;
						}
						if (op[0] === 6 && _.label < t[1]) {
							_.label = t[1];
							t = op;
							break;
						}
						if (t && _.label < t[2]) {
							_.label = t[2];
							_.ops.push(op);
							break;
						}
						if (t[2]) _.ops.pop();
						_.trys.pop();
						continue;
				}
				op = body.call(thisArg, _);
			} catch (e) {
				op = [6, e];
				y = 0;
			} finally {
				f = t = 0;
			}
			if (op[0] & 5) throw op[1];
			return {
				value: op[0] ? op[1] : void 0,
				done: true
			};
		}
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	var promise_1 = require_promise();
	var fs_1 = __require("fs");
	var writeFilePromise = promise_1.promisify(fs_1.writeFile);
	var DEFAULT_ENCODING = "utf8";
	exports.FileWriter = function() {
		function FileWriter(path, append, encoding) {
			if (encoding === void 0) encoding = DEFAULT_ENCODING;
			this.path = path;
			this.append = append;
			this.encoding = encoding;
		}
		FileWriter.prototype.write = function(string) {
			return __awaiter(this, void 0, void 0, function() {
				return __generator(this, function(_a) {
					switch (_a.label) {
						case 0: return [4, writeFilePromise(this.path, string, this.getWriteOption())];
						case 1:
							_a.sent();
							this.append = true;
							return [2];
					}
				});
			});
		};
		FileWriter.prototype.getWriteOption = function() {
			return {
				encoding: this.encoding,
				flag: this.append ? "a" : "w"
			};
		};
		return FileWriter;
	}();
}));
//#endregion
//#region node_modules/csv-writer/dist/lib/csv-writer.js
var require_csv_writer = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __awaiter = exports && exports.__awaiter || function(thisArg, _arguments, P, generator) {
		function adopt(value) {
			return value instanceof P ? value : new P(function(resolve) {
				resolve(value);
			});
		}
		return new (P || (P = Promise))(function(resolve, reject) {
			function fulfilled(value) {
				try {
					step(generator.next(value));
				} catch (e) {
					reject(e);
				}
			}
			function rejected(value) {
				try {
					step(generator["throw"](value));
				} catch (e) {
					reject(e);
				}
			}
			function step(result) {
				result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
			}
			step((generator = generator.apply(thisArg, _arguments || [])).next());
		});
	};
	var __generator = exports && exports.__generator || function(thisArg, body) {
		var _ = {
			label: 0,
			sent: function() {
				if (t[0] & 1) throw t[1];
				return t[1];
			},
			trys: [],
			ops: []
		}, f, y, t, g;
		return g = {
			next: verb(0),
			"throw": verb(1),
			"return": verb(2)
		}, typeof Symbol === "function" && (g[Symbol.iterator] = function() {
			return this;
		}), g;
		function verb(n) {
			return function(v) {
				return step([n, v]);
			};
		}
		function step(op) {
			if (f) throw new TypeError("Generator is already executing.");
			while (_) try {
				if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
				if (y = 0, t) op = [op[0] & 2, t.value];
				switch (op[0]) {
					case 0:
					case 1:
						t = op;
						break;
					case 4:
						_.label++;
						return {
							value: op[1],
							done: false
						};
					case 5:
						_.label++;
						y = op[1];
						op = [0];
						continue;
					case 7:
						op = _.ops.pop();
						_.trys.pop();
						continue;
					default:
						if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) {
							_ = 0;
							continue;
						}
						if (op[0] === 3 && (!t || op[1] > t[0] && op[1] < t[3])) {
							_.label = op[1];
							break;
						}
						if (op[0] === 6 && _.label < t[1]) {
							_.label = t[1];
							t = op;
							break;
						}
						if (t && _.label < t[2]) {
							_.label = t[2];
							_.ops.push(op);
							break;
						}
						if (t[2]) _.ops.pop();
						_.trys.pop();
						continue;
				}
				op = body.call(thisArg, _);
			} catch (e) {
				op = [6, e];
				y = 0;
			} finally {
				f = t = 0;
			}
			if (op[0] & 5) throw op[1];
			return {
				value: op[0] ? op[1] : void 0,
				done: true
			};
		}
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	var file_writer_1 = require_file_writer();
	var DEFAULT_INITIAL_APPEND_FLAG = false;
	exports.CsvWriter = function() {
		function CsvWriter(csvStringifier, path, encoding, append) {
			if (append === void 0) append = DEFAULT_INITIAL_APPEND_FLAG;
			this.csvStringifier = csvStringifier;
			this.append = append;
			this.fileWriter = new file_writer_1.FileWriter(path, this.append, encoding);
		}
		CsvWriter.prototype.writeRecords = function(records) {
			return __awaiter(this, void 0, void 0, function() {
				var recordsString, writeString;
				return __generator(this, function(_a) {
					switch (_a.label) {
						case 0:
							recordsString = this.csvStringifier.stringifyRecords(records);
							writeString = this.headerString + recordsString;
							return [4, this.fileWriter.write(writeString)];
						case 1:
							_a.sent();
							this.append = true;
							return [2];
					}
				});
			});
		};
		Object.defineProperty(CsvWriter.prototype, "headerString", {
			get: function() {
				return !this.append && this.csvStringifier.getHeaderString() || "";
			},
			enumerable: true,
			configurable: true
		});
		return CsvWriter;
	}();
}));
//#endregion
//#region node_modules/csv-writer/dist/lib/csv-writer-factory.js
var require_csv_writer_factory = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var csv_writer_1 = require_csv_writer();
	exports.CsvWriterFactory = function() {
		function CsvWriterFactory(csvStringifierFactory) {
			this.csvStringifierFactory = csvStringifierFactory;
		}
		CsvWriterFactory.prototype.createArrayCsvWriter = function(params) {
			var csvStringifier = this.csvStringifierFactory.createArrayCsvStringifier({
				header: params.header,
				fieldDelimiter: params.fieldDelimiter,
				recordDelimiter: params.recordDelimiter,
				alwaysQuote: params.alwaysQuote
			});
			return new csv_writer_1.CsvWriter(csvStringifier, params.path, params.encoding, params.append);
		};
		CsvWriterFactory.prototype.createObjectCsvWriter = function(params) {
			var csvStringifier = this.csvStringifierFactory.createObjectCsvStringifier({
				header: params.header,
				fieldDelimiter: params.fieldDelimiter,
				recordDelimiter: params.recordDelimiter,
				headerIdDelimiter: params.headerIdDelimiter,
				alwaysQuote: params.alwaysQuote
			});
			return new csv_writer_1.CsvWriter(csvStringifier, params.path, params.encoding, params.append);
		};
		return CsvWriterFactory;
	}();
}));
//#endregion
//#region src/main/extraction/extractor.ts
var import_dist = (/* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var csv_stringifier_factory_1 = require_csv_stringifier_factory();
	var csv_writer_factory_1 = require_csv_writer_factory();
	var csvStringifierFactory = new csv_stringifier_factory_1.CsvStringifierFactory();
	new csv_writer_factory_1.CsvWriterFactory(csvStringifierFactory);
	exports.createObjectCsvStringifier = function(params) {
		return csvStringifierFactory.createObjectCsvStringifier(params);
	};
})))();
var GroupExtractor = class {
	mainWin;
	abortFlag = false;
	failedFlag = false;
	seenMemberIds = /* @__PURE__ */ new Set();
	runId = null;
	totalExtracted = 0;
	constructor(win) {
		this.mainWin = win;
	}
	async start(groupIds, accountId) {
		this.abortFlag = false;
		this.failedFlag = false;
		this.seenMemberIds.clear();
		this.totalExtracted = 0;
		const db = getDB();
		const { filePath: outputPath } = await dialog.showSaveDialog(this.mainWin, {
			defaultPath: join(app.getPath("documents"), `extraction-${Date.now()}.csv`),
			filters: [{
				name: "CSV",
				extensions: ["csv"]
			}]
		});
		if (!outputPath) throw new Error("No output path selected");
		const result = db.prepare(`INSERT INTO extraction_runs (group_ids, source_account_id, output_path) VALUES (?, ?, ?)`).run(JSON.stringify(groupIds), accountId, outputPath);
		this.runId = result.lastInsertRowid;
		const { token, name: sourceAccount } = getDecryptedToken(accountId);
		const validation = await validateToken(token);
		updateAccountStatus(accountId, validation.status, validation.name, validation.id);
		if (!validation.valid) {
			if (validation.status === "Blocked") throw new Error("Selected account is blocked by a login checkpoint (code 190). Re-login and pass the checkpoint, then validate the token again.");
			if (validation.status === "Expired") throw new Error("Selected account token is expired. Please refresh and validate it again.");
			throw new Error("Selected account token is invalid. Please refresh and validate it again.");
		}
		this.initializeCsv(outputPath);
		for (let index = 0; index < groupIds.length; index++) {
			if (this.abortFlag) break;
			const groupId = groupIds[index];
			const groupName = (await fetchGroupInfo(token, groupId))?.name ?? groupId;
			this.emitProgress({
				current_group_id: groupId,
				current_group_index: index,
				total_groups: groupIds.length,
				members_extracted: this.totalExtracted,
				current_batch: 0,
				status: "running"
			});
			await this.processGroup({
				outputPath,
				token,
				sourceAccount,
				groupId,
				groupName,
				groupIndex: index,
				totalGroups: groupIds.length
			});
			if (this.failedFlag) break;
		}
		const finalStatus = this.abortFlag ? "stopped" : this.failedFlag ? "failed" : "completed";
		if (this.runId) db.prepare(`UPDATE extraction_runs
         SET status = ?, completed_at = datetime('now'), members_extracted = ?
         WHERE id = ?`).run(finalStatus, this.totalExtracted, this.runId);
		this.emitProgress({
			current_group_id: groupIds[Math.max(0, groupIds.length - 1)] ?? "",
			current_group_index: Math.max(0, groupIds.length - 1),
			total_groups: groupIds.length,
			members_extracted: this.totalExtracted,
			current_batch: 0,
			status: finalStatus
		});
		return outputPath;
	}
	stop() {
		this.abortFlag = true;
	}
	initializeCsv(outputPath) {
		writeFileSync(outputPath, (0, import_dist.createObjectCsvStringifier)({ header: CSV_FIELDS.map((field) => ({
			id: field,
			title: field
		})) }).getHeaderString() ?? "", "utf8");
	}
	async processGroup(params) {
		const { outputPath, token, sourceAccount, groupId, groupName, groupIndex, totalGroups } = params;
		const db = getDB();
		const insertMember = db.prepare(`INSERT OR IGNORE INTO extraction_members
       (run_id, member_id, member_name, profile_url, group_id, group_name, extracted_at, source_account)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
		let currentBatch = 0;
		let afterCursor = null;
		let nextPageUrl = null;
		let lastPageMarker = null;
		while (!this.abortFlag) {
			currentBatch += 1;
			try {
				const page = await fetchGroupMembers(token, groupId, afterCursor, 10, nextPageUrl);
				const batchMembers = page.members.filter((member) => !this.seenMemberIds.has(member.id)).map((member) => {
					this.seenMemberIds.add(member.id);
					return {
						member_id: member.id,
						member_name: member.name,
						profile_url: member.link,
						group_id: groupId,
						group_name: groupName,
						extracted_at: (/* @__PURE__ */ new Date()).toISOString(),
						source_account: sourceAccount
					};
				});
				if (batchMembers.length > 0) {
					if (!this.runId) throw new Error("Extraction run not initialized");
					db.transaction((members) => {
						for (const member of members) insertMember.run(this.runId, member.member_id, member.member_name, member.profile_url, member.group_id, member.group_name, member.extracted_at, member.source_account);
					})(batchMembers);
					this.appendBatchToCsv(outputPath, batchMembers);
					this.totalExtracted += batchMembers.length;
				}
				this.emitProgress({
					current_group_id: groupId,
					current_group_index: groupIndex,
					total_groups: totalGroups,
					members_extracted: this.totalExtracted,
					current_batch: currentBatch,
					status: "running"
				});
				if (!page.hasMore) break;
				const pageMarker = page.nextPageUrl ?? (page.nextCursor ? `cursor:${page.nextCursor}` : null);
				if (!pageMarker || pageMarker === lastPageMarker) {
					this.recordError(groupId, currentBatch, /* @__PURE__ */ new Error("Pagination stalled before all pages were fetched"));
					break;
				}
				lastPageMarker = pageMarker;
				nextPageUrl = page.nextPageUrl;
				afterCursor = page.nextPageUrl ? null : page.nextCursor;
				await this.delay(REQUEST_DELAY_MS);
			} catch (error) {
				this.recordError(groupId, currentBatch, error);
				this.failedFlag = true;
				break;
			}
		}
	}
	appendBatchToCsv(outputPath, members) {
		appendFileSync(outputPath, (0, import_dist.createObjectCsvStringifier)({ header: CSV_FIELDS.map((field) => ({
			id: field,
			title: field
		})) }).stringifyRecords(members), "utf8");
	}
	recordError(groupId, batchNumber, error) {
		const payload = {
			group_id: groupId,
			batch_number: batchNumber,
			error_message: error instanceof Error ? error.message : String(error),
			timestamp: (/* @__PURE__ */ new Date()).toISOString()
		};
		if (this.runId) getDB().prepare(`INSERT INTO extraction_errors (run_id, group_id, batch_number, error_message, timestamp)
           VALUES (?, ?, ?, ?, ?)`).run(this.runId, payload.group_id, payload.batch_number, payload.error_message, payload.timestamp);
		if (this.mainWin && !this.mainWin.isDestroyed()) this.mainWin.webContents.send("extraction:error", payload);
	}
	delay(ms) {
		return new Promise((resolve) => {
			if (this.abortFlag) {
				resolve();
				return;
			}
			setTimeout(resolve, ms);
		});
	}
	emitProgress(progress) {
		if (this.mainWin && !this.mainWin.isDestroyed()) this.mainWin.webContents.send("extraction:progress", progress);
	}
};
//#endregion
//#region src/main/api/facebook-login.ts
async function getSessionCookies(accessToken) {
	const appData = await (await fetch(`https://graph.facebook.com/app?access_token=${accessToken}`)).json();
	if (appData.error || !appData.id) throw new Error(appData.error?.message ?? "Failed to get app ID");
	const sessionData = await (await fetch(`https://api.facebook.com/method/auth.getSessionforApp?access_token=${accessToken}&format=json&generate_session_cookies=1&new_app_id=${appData.id}`)).json();
	if (sessionData.error_msg || !sessionData.session_cookies) throw new Error(sessionData.error_msg ?? "No session cookies returned");
	return sessionData.session_cookies;
}
async function loginToFacebook(accessToken, parentWindow) {
	try {
		const cookies = await getSessionCookies(accessToken);
		const ses = parentWindow ? parentWindow.webContents.session : session.defaultSession;
		for (const cookie of cookies) await ses.cookies.set({
			url: "https://www.facebook.com",
			name: cookie.name,
			value: cookie.value,
			domain: cookie.domain ?? ".facebook.com",
			path: cookie.path ?? "/",
			secure: cookie.secure ?? true,
			httpOnly: cookie.httponly ?? false
		});
		await new BrowserWindow({
			width: 1200,
			height: 800,
			parent: parentWindow ?? void 0,
			webPreferences: {
				nodeIntegration: false,
				contextIsolation: true
			}
		}).loadURL("https://www.facebook.com");
		return { success: true };
	} catch (err) {
		return {
			success: false,
			error: err.message ?? String(err)
		};
	}
}
//#endregion
//#region src/main/extraction/group-scraper.ts
var FB_EXCLUDE_PATHS = [
	"groups",
	"watch",
	"reel",
	"reels",
	"marketplace",
	"gaming",
	"events",
	"feeds",
	"feed",
	"stories",
	"jobs",
	"ads",
	"pages",
	"developers",
	"help",
	"settings",
	"support",
	"notifications",
	"messages",
	"friends",
	"account",
	"login",
	"signup",
	"recover",
	"policy",
	"terms",
	"photo",
	"photos",
	"posts",
	"videos",
	"music",
	"books",
	"likes",
	"about",
	"overview",
	"members",
	"admins",
	"moderators",
	"pending",
	"blocked",
	"invite",
	"discussion",
	"media",
	"files",
	"userguides",
	"discovery",
	"suggested",
	"invitees",
	"membership",
	"pending_members",
	"hashtag",
	"search",
	"directory"
];
var SCRAPER_JS = [
	"(function scrapeMembers() {",
	"  var results = [];",
	"  var seen = new Set();",
	"",
	"  function extractProfile(href) {",
	"    if (!href) return null;",
	"    var url = href;",
	"    if (url.charAt(0) === '/') url = 'https://www.facebook.com' + url;",
	"",
	"    var groupUserMatch = url.match(/facebook\\.com\\/groups\\/\\d+\\/user\\/(\\d+)/);",
	"    if (groupUserMatch) {",
	"      return { id: groupUserMatch[1], url: 'https://www.facebook.com/profile.php?id=' + groupUserMatch[1] };",
	"    }",
	"",
	"    var profileIdMatch = url.match(/facebook\\.com\\/profile\\.php[^?]*[?&]id=(\\d+)/);",
	"    if (profileIdMatch) {",
	"      return { id: profileIdMatch[1], url: 'https://www.facebook.com/profile.php?id=' + profileIdMatch[1] };",
	"    }",
	"",
	"    var cleanUrl = url.split('?')[0].split('#')[0].replace(/\\/+$/, '');",
	"    var parts = cleanUrl.replace('https://www.facebook.com/', '').split('/');",
	"    if (parts.length >= 1 && parts[0]) {",
	"      var username = parts[0];",
	"      if (/^[a-zA-Z0-9.]{5,50}$/.test(username) && window.__fbExclude.indexOf(username) === -1) {",
	"        return { id: username, url: 'https://www.facebook.com/' + username };",
	"      }",
	"    }",
	"    return null;",
	"  }",
	"",
	"  var allLinks = document.querySelectorAll('a[href]');",
	"  for (var i = 0; i < allLinks.length; i++) {",
	"    var a = allLinks[i];",
	"    var profile = extractProfile(a.getAttribute('href'));",
	"    if (!profile) continue;",
	"    if (seen.has(profile.id)) continue;",
	"",
	"    var name = '';",
	"    var img = a.querySelector('img');",
	"    if (img) name = img.getAttribute('alt') || '';",
	"    if (!name) {",
	"      var spans = a.querySelectorAll('span');",
	"      for (var j = 0; j < spans.length; j++) {",
	"        var t = spans[j].textContent.trim();",
	"        if (t.length >= 2 && t.length <= 100 && t.indexOf('\\n') === -1) { name = t; break; }",
	"      }",
	"    }",
	"    if (!name) name = a.textContent.trim().split('\\n')[0].trim();",
	"    if (name.length < 2) continue;",
	"",
	"    seen.add(profile.id);",
	"    results.push({ id: profile.id, name: name, profileUrl: profile.url });",
	"  }",
	"  return results;",
	"})();"
].join("\n");
var DEBUG_JS = [
	"(function() {",
	"  return {",
	"    url: window.location.href,",
	"    title: document.title,",
	"    bodyLength: document.body ? document.body.innerHTML.length : 0,",
	"    linkCount: document.querySelectorAll('a[href]').length,",
	"    sampleLinks: Array.from(document.querySelectorAll('a[href]')).slice(0, 30).map(function(a) {",
	"      return { href: a.getAttribute('href'), text: (a.textContent || '').trim().substring(0, 80) };",
	"    }),",
	"    hasLogin: !!document.querySelector('form[action*=\"login\"]'),",
	"    bodySnippet: document.body ? document.body.innerHTML.substring(0, 5000) : ''",
	"  };",
	"})();"
].join("\n");
var GroupScraper = class {
	mainWin;
	abortFlag = false;
	seenMemberIds = /* @__PURE__ */ new Set();
	runId = null;
	totalExtracted = 0;
	scraperWindow = null;
	constructor(win) {
		this.mainWin = win;
	}
	async start(groupIds, accountId) {
		this.abortFlag = false;
		this.seenMemberIds.clear();
		this.totalExtracted = 0;
		const db = getDB();
		const { filePath: outputPath } = await dialog.showSaveDialog(this.mainWin, {
			defaultPath: join(app.getPath("documents"), "extraction-" + Date.now() + ".csv"),
			filters: [{
				name: "CSV",
				extensions: ["csv"]
			}]
		});
		if (!outputPath) throw new Error("No output path selected");
		const result = db.prepare("INSERT INTO extraction_runs (group_ids, source_account_id, output_path) VALUES (?, ?, ?)").run(JSON.stringify(groupIds), accountId, outputPath);
		this.runId = result.lastInsertRowid;
		const { token, name: sourceAccount } = getDecryptedToken(accountId);
		this.initializeCsv(outputPath);
		const ses = session.fromPartition("persist:scraper");
		const cookies = await getSessionCookies(token);
		for (const cookie of cookies) await ses.cookies.set({
			url: "https://www.facebook.com",
			name: cookie.name,
			value: cookie.value,
			domain: cookie.domain ?? ".facebook.com",
			path: cookie.path ?? "/",
			secure: cookie.secure ?? true,
			httpOnly: cookie.httponly ?? false
		});
		this.scraperWindow = new BrowserWindow({
			width: 1280,
			height: 900,
			show: true,
			webPreferences: {
				session: ses,
				nodeIntegration: false,
				contextIsolation: true
			}
		});
		this.scraperWindow.webContents.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
		try {
			for (let index = 0; index < groupIds.length; index++) {
				if (this.abortFlag) break;
				const groupId = groupIds[index];
				this.emitProgress({
					current_group_id: groupId,
					current_group_index: index,
					total_groups: groupIds.length,
					members_extracted: this.totalExtracted,
					current_batch: 0,
					status: "running"
				});
				await this.scrapeGroup({
					outputPath,
					sourceAccount,
					groupId,
					groupIndex: index,
					totalGroups: groupIds.length
				});
			}
		} finally {
			if (this.scraperWindow && !this.scraperWindow.isDestroyed()) {
				this.scraperWindow.destroy();
				this.scraperWindow = null;
			}
		}
		const finalStatus = this.abortFlag ? "stopped" : "completed";
		if (this.runId) db.prepare("UPDATE extraction_runs SET status = ?, completed_at = datetime('now'), members_extracted = ? WHERE id = ?").run(finalStatus, this.totalExtracted, this.runId);
		this.emitProgress({
			current_group_id: groupIds[Math.max(0, groupIds.length - 1)] ?? "",
			current_group_index: Math.max(0, groupIds.length - 1),
			total_groups: groupIds.length,
			members_extracted: this.totalExtracted,
			current_batch: 0,
			status: finalStatus
		});
		return outputPath;
	}
	stop() {
		this.abortFlag = true;
	}
	initializeCsv(outputPath) {
		writeFileSync(outputPath, (0, import_dist.createObjectCsvStringifier)({ header: CSV_FIELDS.map((field) => ({
			id: field,
			title: field
		})) }).getHeaderString() ?? "", "utf8");
	}
	async scrapeGroup(params) {
		const { outputPath, sourceAccount, groupId, groupIndex, totalGroups } = params;
		const db = getDB();
		const insertMember = db.prepare("INSERT OR IGNORE INTO extraction_members (run_id, member_id, member_name, profile_url, group_id, group_name, extracted_at, source_account) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
		const scraper = this.scraperWindow;
		const groupUrl = "https://www.facebook.com/groups/" + encodeURIComponent(groupId) + "/members";
		await scraper.loadURL(groupUrl);
		await this.delay(5e3);
		await scraper.webContents.executeJavaScript("window.__fbExclude = " + JSON.stringify(FB_EXCLUDE_PATHS) + ";");
		const debug = await scraper.webContents.executeJavaScript(DEBUG_JS);
		const debugDir = join(dirname(outputPath), "scraper-debug");
		mkdirSync(debugDir, { recursive: true });
		writeFileSync(join(debugDir, "debug-" + groupId + ".json"), JSON.stringify(debug, null, 2), "utf8");
		if (debug.hasLogin || debug.url.includes("login")) throw new Error("Facebook login page detected — session cookies may be invalid or expired. Try logging in again first.");
		let currentBatch = 0;
		let noNewCount = 0;
		const MAX_NO_NEW = 5;
		while (!this.abortFlag) {
			currentBatch += 1;
			try {
				const scraped = await scraper.webContents.executeJavaScript(SCRAPER_JS);
				const newMembers = [];
				for (const m of scraped) {
					if (this.seenMemberIds.has(m.id)) continue;
					this.seenMemberIds.add(m.id);
					newMembers.push({
						member_id: m.id,
						member_name: m.name,
						profile_url: m.profileUrl,
						group_id: groupId,
						group_name: groupId,
						extracted_at: (/* @__PURE__ */ new Date()).toISOString(),
						source_account: sourceAccount
					});
				}
				if (newMembers.length > 0) {
					noNewCount = 0;
					if (!this.runId) throw new Error("Extraction run not initialized");
					db.transaction((members) => {
						for (const member of members) insertMember.run(this.runId, member.member_id, member.member_name, member.profile_url, member.group_id, member.group_name, member.extracted_at, member.source_account);
					})(newMembers);
					this.appendBatchToCsv(outputPath, newMembers);
					this.totalExtracted += newMembers.length;
				} else noNewCount++;
				this.emitProgress({
					current_group_id: groupId,
					current_group_index: groupIndex,
					total_groups: totalGroups,
					members_extracted: this.totalExtracted,
					current_batch: currentBatch,
					status: "running"
				});
				if (noNewCount >= MAX_NO_NEW) break;
				await this.scrollPage(scraper);
				await this.delay(REQUEST_DELAY_MS);
			} catch (error) {
				this.recordError(groupId, currentBatch, error);
				break;
			}
		}
	}
	async scrollPage(win) {
		await win.webContents.executeJavaScript("window.scrollBy({ top: 1200, behavior: 'smooth' });");
		await this.delay(2e3);
	}
	appendBatchToCsv(outputPath, members) {
		appendFileSync(outputPath, (0, import_dist.createObjectCsvStringifier)({ header: CSV_FIELDS.map((field) => ({
			id: field,
			title: field
		})) }).stringifyRecords(members), "utf8");
	}
	recordError(groupId, batchNumber, error) {
		const payload = {
			group_id: groupId,
			batch_number: batchNumber,
			error_message: error instanceof Error ? error.message : String(error),
			timestamp: (/* @__PURE__ */ new Date()).toISOString()
		};
		if (this.runId) getDB().prepare("INSERT INTO extraction_errors (run_id, group_id, batch_number, error_message, timestamp) VALUES (?, ?, ?, ?, ?)").run(this.runId, payload.group_id, payload.batch_number, payload.error_message, payload.timestamp);
		if (this.mainWin && !this.mainWin.isDestroyed()) this.mainWin.webContents.send("extraction:error", payload);
	}
	delay(ms) {
		return new Promise((resolve) => {
			if (this.abortFlag) {
				resolve();
				return;
			}
			setTimeout(resolve, ms);
		});
	}
	emitProgress(progress) {
		if (this.mainWin && !this.mainWin.isDestroyed()) this.mainWin.webContents.send("extraction:progress", progress);
	}
};
//#endregion
//#region src/main/ipc/extraction.ts
var activeExtractor = null;
function registerExtractionHandlers() {
	ipcMain.handle("extraction:start", async (_event, groupIds, accountId, useScraper = false) => {
		const win = BrowserWindow.getAllWindows()[0];
		if (!win) throw new Error("No window available");
		if (useScraper) activeExtractor = new GroupScraper(win);
		else activeExtractor = new GroupExtractor(win);
		try {
			const outputPath = await activeExtractor.start(groupIds, accountId);
			activeExtractor = null;
			return {
				outputPath,
				method: useScraper ? "scraper" : "api"
			};
		} catch (err) {
			const msg = err?.message ?? String(err);
			const isPermissionError = msg.includes("(#100)") || msg.includes("nonexisting field") || msg.includes("members");
			if (!useScraper && isPermissionError) {
				activeExtractor = new GroupScraper(win);
				const outputPath = await activeExtractor.start(groupIds, accountId);
				activeExtractor = null;
				return {
					outputPath,
					method: "scraper"
				};
			}
			activeExtractor = null;
			throw err;
		}
	});
	ipcMain.handle("extraction:stop", async () => {
		if (activeExtractor) activeExtractor.stop();
		return { stopped: true };
	});
}
//#endregion
//#region src/main/ipc/facebook.ts
function registerFacebookHandlers() {
	ipcMain.handle("facebook:login", async (_event, accountId) => {
		const { token } = getDecryptedToken(accountId);
		return loginToFacebook(token, BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]);
	});
}
//#endregion
//#region src/main/main.ts
if (process.env.NODE_ENV !== "production") {
	app.commandLine.appendSwitch("no-sandbox");
	app.commandLine.appendSwitch("disable-gpu-sandbox");
}
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-dev-shm-usage");
var mainWindow = null;
function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1200,
		height: 800,
		webPreferences: {
			preload: resolve(__dirname, "../preload/index.cjs"),
			contextIsolation: true,
			nodeIntegration: false
		}
	});
	if (process.env.ELECTRON_RENDERER_URL) mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL).catch(() => {
		if (mainWindow) mainWindow.loadFile(resolve(__dirname, "../renderer/index.html"));
	});
	else mainWindow.loadFile(resolve(__dirname, "../renderer/index.html"));
}
app.whenReady().then(() => {
	initDB();
	registerAccountHandlers();
	registerExtractionHandlers();
	registerFacebookHandlers();
	createWindow();
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});
app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
//#endregion
export {};
