import { createHash } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { getRuntimePaths } from "../runtime/paths.js";
import { logger } from "../utils/logger.js";

/** Columns in each project conversation table */
export interface ConversationRow {
  id: number;
  datetime: string;
  project_name: string;
  message_content: string;
  reusable: number; // 0 = not reusable, 1 = reusable
}

/** Options for querying conversation history */
export interface ConversationQuery {
  keyword?: string;
  reusableOnly?: boolean;
  limit?: number;
  offset?: number;
}

let db: Database.Database | null = null;

/**
 * Returns the singleton SQLite database handle, creating it if necessary.
 * The database file is stored at `{appHome}/conversations.db`.
 */
/** SQL string quoting helper */
function quote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

function getDb(): Database.Database {
  if (!db) {
    const dbPath = path.join(getRuntimePaths().appHome, "conversations.db");
    logger.info(`[ConversationLog] Opening database at ${dbPath}`);
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("busy_timeout = 100");
  }
  return db;
}

/**
 * Derives a safe, unique table name from a worktree path.
 * Uses SHA-256 hash to guarantee uniqueness and avoid SQL injection.
 * Format: `conv_{first12charsOfHash}`
 */
function tableNameForWorktree(worktree: string): string {
  const hash = createHash("sha256").update(worktree).digest("hex").slice(0, 12);
  return `conv_${hash}`;
}

/**
 * Derives a display-friendly project name from a worktree path.
 * Uses the last directory component (basename).
 */
function projectNameFromWorktree(worktree: string): string {
  return path.basename(worktree);
}

/**
 * Ensures a conversation table exists for the given worktree path.
 * Table is created only once per project.
 */
function ensureTable(worktree: string): string {
  const database = getDb();
  const tableName = tableNameForWorktree(worktree);

  database.exec(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      datetime TEXT NOT NULL,
      project_name TEXT NOT NULL,
      message_content TEXT NOT NULL,
      reusable INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Register project in lookup registry
  database.exec(`
    CREATE TABLE IF NOT EXISTS conv_project_registry (
      worktree TEXT PRIMARY KEY,
      table_name TEXT NOT NULL,
      project_name TEXT NOT NULL,
      last_active TEXT NOT NULL DEFAULT ''
    )
  `);
  // Migrate old registry tables to add last_active column if missing
  try {
    database.exec(`ALTER TABLE conv_project_registry ADD COLUMN last_active TEXT NOT NULL DEFAULT ''`);
  } catch {
    // Column already exists — ignore
  }
  database.exec(`
    INSERT OR REPLACE INTO conv_project_registry (worktree, table_name, project_name, last_active)
    VALUES (${quote(worktree)}, ${quote(tableName)}, ${quote(projectNameFromWorktree(worktree))}, ${quote(new Date().toISOString())})
  `);

  // Create index on datetime for efficient queries
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_${tableName}_datetime
    ON ${tableName} (datetime)
  `);

  // Create index on reusable for filtering
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_${tableName}_reusable
    ON ${tableName} (reusable)
  `);

  // Migrate old tables: add reusable column if it doesn't exist
  try {
    database.exec(`
      ALTER TABLE ${tableName} ADD COLUMN reusable INTEGER NOT NULL DEFAULT 0
    `);
  } catch {
    // Column already exists — ignore
  }

  logger.debug(`[ConversationLog] Ensured table "${tableName}" for worktree "${worktree}"`);
  return tableName;
}

/**
 * Logs a user message to the project-specific conversation table.
 *
 * @param worktree - The project's working directory path (used to determine the table).
 * @param messageContent - The user's message text.
 */
export function logUserMessage(worktree: string, messageContent: string): void {
  if (!worktree || !messageContent) {
    return;
  }

  try {
    const database = getDb();
    const tableName = ensureTable(worktree);
    const projectName = projectNameFromWorktree(worktree);
    const now = new Date().toISOString();

    const stmt = database.prepare(`
      INSERT INTO ${tableName} (datetime, project_name, message_content)
      VALUES (?, ?, ?)
    `);

    stmt.run(now, projectName, messageContent);

    logger.debug(
      `[ConversationLog] Saved message for project "${projectName}" (table=${tableName})`,
    );
  } catch (err) {
    logger.error("[ConversationLog] Failed to log user message:", err);
  }
}

/**
 * Toggles the reusable flag on a specific conversation entry.
 *
 * @param worktree - The project's working directory path.
 * @param entryId - The ID of the conversation entry.
 * @param reusable - Whether to mark as reusable (true) or not (false).
 * @returns true if the entry was updated, false otherwise.
 */
export function setReusable(
  worktree: string,
  entryId: number,
  reusable: boolean,
): boolean {
  try {
    const database = getDb();
    const tableName = tableNameForWorktree(worktree);

    // Ensure table exists before updating
    const tableExists = database
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(tableName);
    if (!tableExists) {
      return false;
    }

    const val = reusable ? 1 : 0;

    const stmt = database.prepare(`
      UPDATE ${tableName} SET reusable = ? WHERE id = ?
    `);

    const result = stmt.run(val, entryId);
    return result.changes > 0;
  } catch (err) {
    logger.error("[ConversationLog] Failed to set reusable flag:", err);
    return false;
  }
}

/**
 * Retrieves conversation entries for a given worktree path with optional filtering.
 *
 * @param worktree - The project's working directory path.
 * @param query - Optional filter options (keyword, reusableOnly, limit, offset).
 * @returns Array of conversation rows, newest first.
 */
export function getConversationHistory(
  worktree: string,
  query: ConversationQuery = {},
): ConversationRow[] {
  try {
    const database = getDb();
    const tableName = tableNameForWorktree(worktree);

    // Check if table exists
    const tableExists = database
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(tableName);

    if (!tableExists) {
      return [];
    }

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.reusableOnly) {
      conditions.push("reusable = 1");
    }

    if (query.keyword) {
      conditions.push("message_content LIKE ?");
      params.push(`%${query.keyword}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const stmt = database.prepare(`
      SELECT id, datetime, project_name, message_content, reusable
      FROM ${tableName}
      ${whereClause}
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `);

    return stmt.all(limit, offset) as ConversationRow[];
  } catch (err) {
    logger.error("[ConversationLog] Failed to query conversation history:", err);
    return [];
  }
}

/**
 * Gets total count of conversation entries matching filters.
 */
export function getConversationCount(
  worktree: string,
  query: ConversationQuery = {},
): number {
  try {
    const database = getDb();
    const tableName = tableNameForWorktree(worktree);

    const tableExists = database
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(tableName);

    if (!tableExists) {
      return 0;
    }

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.reusableOnly) {
      conditions.push("reusable = 1");
    }

    if (query.keyword) {
      conditions.push("message_content LIKE ?");
      params.push(`%${query.keyword}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const row = database
      .prepare(`SELECT COUNT(*) AS cnt FROM ${tableName} ${whereClause}`)
      .get(...params) as { cnt: number } | undefined;

    return row?.cnt ?? 0;
  } catch (err) {
    logger.error("[ConversationLog] Failed to count conversations:", err);
    return 0;
  }
}

/**
 * Closes the database connection gracefully.
 */

/**
 * Lists all project worktrees that have conversation tables.
 * Queries the sqlite_master for tables with prefix "conv_".
 */
export interface ProjectInfo {
  worktree: string;
  tableName: string;
  projectName: string;
  messageCount: number;
}

/**
 * Lists all projects that have conversation tables.
 * Returns worktree path, table name, project name, and message count.
 */
export function listAllProjects(offset = 0, limit = 10): { projects: ProjectInfo[]; total: number } {
  try {
    const database = getDb();
    // Ensure registry exists
    database.exec(`CREATE TABLE IF NOT EXISTS conv_project_registry (
      worktree TEXT PRIMARY KEY,
      table_name TEXT NOT NULL,
      project_name TEXT NOT NULL,
      last_active TEXT NOT NULL DEFAULT ''
    )`);
    // Migrate old registry tables to add last_active column if missing
    try {
      database.exec(`ALTER TABLE conv_project_registry ADD COLUMN last_active TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists — ignore
    }

    // Get total count
    const countRow = database
      .prepare("SELECT COUNT(*) AS cnt FROM conv_project_registry")
      .get() as { cnt: number } | undefined;
    const total = countRow?.cnt ?? 0;

    const rows = database
      .prepare("SELECT worktree, table_name, project_name FROM conv_project_registry ORDER BY last_active DESC, project_name ASC LIMIT ? OFFSET ?")
      .all(limit, offset) as Array<{ worktree: string; table_name: string; project_name: string }>;

    const result: ProjectInfo[] = [];
    for (const row of rows) {
      try {
        const countRow = database
          .prepare("SELECT COUNT(*) AS cnt FROM " + row.table_name)
          .get() as { cnt: number } | undefined;
        result.push({
          worktree: row.worktree,
          tableName: row.table_name,
          projectName: row.project_name,
          messageCount: countRow?.cnt ?? 0,
        });
      } catch { /* skip */ }
    }
    return { projects: result, total };
  } catch (err) {
    logger.error("[ConversationLog] Failed to list projects:", err);
    return { projects: [], total: 0 };
  }
}

/**
 * Retrieves a single conversation entry by ID (searches all project tables).
 */
export function getConversationEntry(
  worktree: string,
  entryId: number,
): ConversationRow | undefined {
  try {
    const database = getDb();
    const tableName = tableNameForWorktree(worktree);
    const row = database
      .prepare("SELECT id, datetime, project_name, message_content, reusable FROM " + tableName + " WHERE id = ?")
      .get(entryId) as ConversationRow | undefined;
    return row;
  } catch (err) {
    logger.error("[ConversationLog] Failed to get entry:", err);
    return undefined;
  }
}

/**
 * Deletes a single conversation entry.
 */
export function deleteConversationEntry(worktree: string, entryId: number): boolean {
  try {
    const database = getDb();
    const tableName = tableNameForWorktree(worktree);
    const result = database
      .prepare("DELETE FROM " + tableName + " WHERE id = ?")
      .run(entryId);
    return result.changes > 0;
  } catch (err) {
    logger.error("[ConversationLog] Failed to delete entry:", err);
    return false;
  }
}

/**
 * Closes the database connection gracefully.
 */

export function initializeStore(): void {
  getDb();
}

export function logBotResponse(worktree: string, messageContent: string): void {
  logUserMessage(worktree, messageContent);
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    logger.info("[ConversationLog] Database closed");
  }
}
