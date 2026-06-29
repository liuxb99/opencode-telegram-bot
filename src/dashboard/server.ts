import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../utils/logger.js";
import {
  getConversationHistory,
  getConversationCount,
  setReusable,
  deleteConversationEntry,
  listAllProjects,
} from "../conversation-log/store.js";

const DASHBOARD_PORT = 3000;
let server: http.Server | null = null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFrontendHtml(): string {
  const candidates = [
    path.join(__dirname, "frontend.html"),
    path.join(process.cwd(), "src", "dashboard", "frontend.html"),
  ];
  for (const p of candidates) {
    try { return fs.readFileSync(p, "utf-8"); } catch {}
  }
  return "<!DOCTYPE html><html><body><h1>Dashboard unavailable</h1></body></html>";
}
const frontendHtml = loadFrontendHtml();

// --- In-memory log ring buffer ---
const MAX_LOGS = 200;
const recentLogs: Array<{ time: string; level: string; msg: string }> = [];

export function pushLog(level: string, msg: string): void {
  const entry = { time: new Date().toISOString(), level, msg: msg.slice(0, 2000) };
  recentLogs.push(entry);
  if (recentLogs.length > MAX_LOGS) recentLogs.shift();
}

/** Safely stringify a value for log capture; never throws. */
function safeStringify(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack ?? String(arg);
  try { return JSON.stringify(arg); } catch { return String(arg); }
}

// Patch console.error / console.warn / console.log to capture into the buffer.
// CRITICAL: every patched function MUST use safeStringify to avoid crashing
// the process when circular references are logged (e.g. grammY Context objects).
const origConsoleError = console.error;
console.error = (...args: unknown[]): void => {
  origConsoleError(...args);
  pushLog("error", args.map(safeStringify).join(" "));
};
const origConsoleWarn = console.warn;
console.warn = (...args: unknown[]): void => {
  origConsoleWarn(...args);
  pushLog("warn", args.map(safeStringify).join(" "));
};
const origConsoleLog = console.log;
console.log = (...args: unknown[]): void => {
  origConsoleLog(...args);
  pushLog("info", args.map(safeStringify).join(" "));
};

process.on("uncaughtException", (err) => {
  pushLog("error", "UNCAUGHT: " + (err.stack ?? err.message));
});
process.on("unhandledRejection", (reason) => {
  pushLog("error", "UNHANDLED REJECTION: " + String(reason));
});
// ---

function jsonResponse(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function errorResponse(res: http.ServerResponse, msg: string, status = 400): void {
  jsonResponse(res, { error: msg }, status);
}

function runHandler(handler: () => Promise<void>): void {
  handler().catch((err) => {
    logger.error("[Dashboard] Async handler error:", err);
  });
}

async function handleApiLogs(res: http.ServerResponse, url: URL): Promise<void> {
  const level = url.searchParams.get("level") || "all";
  const since = url.searchParams.get("since") || "";
  const filtered = level === "all"
    ? recentLogs
    : recentLogs.filter((e) => e.level === level);
  const sinceFiltered = since ? filtered.filter((e) => e.time > since) : filtered;
  jsonResponse(res, sinceFiltered.slice(-50));
}

async function handleApiProjects(res: http.ServerResponse, url?: URL): Promise<void> {
  try {
    const offset = parseInt(url?.searchParams.get("offset") || "0", 10);
    const limit = parseInt(url?.searchParams.get("limit") || "10", 10);
    jsonResponse(res, listAllProjects(offset, limit));
  } catch (err) {
    logger.error("[Dashboard] Error listing projects:", err);
    errorResponse(res, "Failed to list projects", 500);
  }
}

async function handleApiMessages(res: http.ServerResponse, url: URL): Promise<void> {
  const worktree = url.searchParams.get("worktree");
  if (!worktree) { errorResponse(res, "Missing worktree parameter"); return; }
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const keyword = url.searchParams.get("keyword") || undefined;
  const reusableOnly = url.searchParams.get("reusable") === "1";
  const limit = parseInt(url.searchParams.get("limit") || "20", 10);
  try {
    const query = { keyword, reusableOnly, limit, offset: (page - 1) * limit };
    const [rows, total] = await Promise.all([
      getConversationHistory(worktree, query),
      getConversationCount(worktree, query),
    ]);
    jsonResponse(res, { rows, total, page, limit });
  } catch (err) {
    logger.error("[Dashboard] Error querying messages:", err);
    errorResponse(res, "Failed to query messages", 500);
  }
}

async function handleApiToggleReusable(res: http.ServerResponse, url: URL): Promise<void> {
  const worktree = url.searchParams.get("worktree");
  const idStr = url.searchParams.get("id");
  if (!worktree || !idStr) { errorResponse(res, "Missing worktree or id"); return; }
  const id = parseInt(idStr, 10);
  if (Number.isNaN(id)) { errorResponse(res, "Invalid id"); return; }
  const val = url.pathname.includes("unmark") ? false : true;
  try { jsonResponse(res, { success: setReusable(worktree, id, val) }); }
  catch (err) {
    logger.error("[Dashboard] Error toggling reusable:", err);
    errorResponse(res, "Failed", 500);
  }
}

async function handleApiDelete(res: http.ServerResponse, url: URL): Promise<void> {
  const worktree = url.searchParams.get("worktree");
  const idStr = url.searchParams.get("id");
  if (!worktree || !idStr) { errorResponse(res, "Missing worktree or id"); return; }
  const id = parseInt(idStr, 10);
  if (Number.isNaN(id)) { errorResponse(res, "Invalid id"); return; }
  try { jsonResponse(res, { success: deleteConversationEntry(worktree, id) }); }
  catch (err) {
    logger.error("[Dashboard] Error deleting entry:", err);
    errorResponse(res, "Failed to delete", 500);
  }
}

async function handleApiExport(res: http.ServerResponse, url: URL): Promise<void> {
  const worktree = url.searchParams.get("worktree");
  const format = url.searchParams.get("format") || "json";
  if (!worktree) { errorResponse(res, "Missing worktree parameter"); return; }
  try {
    const rows = getConversationHistory(worktree, { limit: 10000 });
    if (format === "csv") {
      const header = "id,datetime,project_name,message_content,reusable";
      const csvLines = [header];
      for (const row of rows) {
        const escaped = row.message_content.replace(/"/g, '""');
        csvLines.push(
          row.id + ',"' + row.datetime + '","' + row.project_name.replace(/"/g, '""') + '","' + escaped + '",' + row.reusable,
        );
      }
      res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="conversations.csv"' });
      res.end(csvLines.join("\n"));
    } else {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": 'attachment; filename="conversations.json"' });
      res.end(JSON.stringify(rows, null, 2));
    }
  } catch (err) {
    logger.error("[Dashboard] Error exporting:", err);
    errorResponse(res, "Failed to export", 500);
  }
}

function serveFrontend(res: http.ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(frontendHtml);
}

export async function startDashboard(port = DASHBOARD_PORT): Promise<number> {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      try {
        const url = new URL(req.url || "/", "http://localhost:" + port);
        if (url.pathname === "/api/logs") { runHandler(() => handleApiLogs(res, url)); }
        else if (url.pathname === "/api/projects") { runHandler(() => handleApiProjects(res, url)); }
        else if (url.pathname === "/api/messages") { runHandler(() => handleApiMessages(res, url)); }
        else if (url.pathname === "/api/toggle-reusable" || url.pathname === "/api/unmark-reusable") { runHandler(() => handleApiToggleReusable(res, url)); }
        else if (url.pathname === "/api/delete") { runHandler(() => handleApiDelete(res, url)); }
        else if (url.pathname === "/api/export") { runHandler(() => handleApiExport(res, url)); }
        else if (url.pathname === "/api/health") { jsonResponse(res, { status: "ok", uptime: process.uptime() }); }
        else { serveFrontend(res); }
      } catch (err) {
        logger.error("[Dashboard] Unhandled error:", err);
        errorResponse(res, "Internal server error", 500);
      }
    });
    server.listen(port, () => {
      logger.info("[Dashboard] Web dashboard started at http://localhost:" + port);
      resolve(port);
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        logger.warn("[Dashboard] Port " + port + " in use, trying " + (port + 1));
        server?.close();
        void startDashboard(port + 1).then(resolve).catch(reject);
      } else { reject(err); }
    });
  });
}

export function stopDashboard(): void {
  if (server) { server.close(); server = null; logger.info("[Dashboard] Web dashboard stopped"); }
}

export function getRecentLogs(): Array<{ time: string; level: string; msg: string }> {
  return recentLogs.slice();
}
