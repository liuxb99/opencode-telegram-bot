import { InlineKeyboard } from "grammy";
import type { Bot, Context } from "grammy";
import { getCurrentProject } from "../../settings/manager.js";
import {
  getConversationEntry,
  getConversationHistory,
  getConversationCount,
  setReusable,
  type ConversationQuery,
  type ConversationRow,
} from "../../conversation-log/store.js";
import { logger } from "../../utils/logger.js";

const HISTORY_CALLBACK_PREFIX = "hist:";
const HISTORY_TOGGLE_PREFIX = HISTORY_CALLBACK_PREFIX + "toggle:";
const HISTORY_PAGE_PREFIX = HISTORY_CALLBACK_PREFIX + "page:";
const HISTORY_FILTER_REUSABLE = HISTORY_CALLBACK_PREFIX + "filter_reuse";
const HISTORY_FILTER_ALL = HISTORY_CALLBACK_PREFIX + "filter_all";
const HISTORY_SEARCH = HISTORY_CALLBACK_PREFIX + "search";
const HISTORY_REFRESH = HISTORY_CALLBACK_PREFIX + "refresh";
const HISTORY_CLOSE = HISTORY_CALLBACK_PREFIX + "close";

const PAGE_SIZE = 10;
const MAX_PREVIEW_LENGTH = 80;

function parseToggleEntryId(data: string): number | null {
  const suffix = data.replace(HISTORY_TOGGLE_PREFIX, "");
  const id = parseInt(suffix, 10);
  return Number.isNaN(id) ? null : id;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3).trimEnd() + "...";
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const month = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  const hours = d.getHours().toString().padStart(2, "0");
  const mins = d.getMinutes().toString().padStart(2, "0");
  return month + "/" + day + " " + hours + ":" + mins;
}

function buildHistoryMessage(rows: ConversationRow[], page: number, totalCount: number, keyword: string | undefined, reusableOnly: boolean): { text: string; keyboard: InlineKeyboard } {
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const projName = rows[0]?.project_name ?? "";
  const textLines = [];
  if (keyword) {
    textLines.push("[Search]: " + truncate(keyword, 30));
  } else if (reusableOnly) {
    textLines.push("[Reusable Only]");
  } else {
    textLines.push("[Conversation History]");
  }
  if (projName) textLines.push("Project: " + projName);
  textLines.push("Total: " + totalCount + " | Page " + (page + 1) + "/" + totalPages);
  textLines.push("");
  if (rows.length === 0) {
    textLines.push("No entries found.");
  } else {
    for (const row of rows) {
      const time = formatDateTime(row.datetime);
      const preview = truncate(row.message_content, MAX_PREVIEW_LENGTH);
      const reuseIcon = row.reusable === 1 ? "[R]" : "[_]";
      textLines.push("#" + row.id + " [" + time + "] " + reuseIcon, "  " + preview, "");
    }
  }
  const keyboard = new InlineKeyboard();
  if (rows.length > 0) {
    const toggleRow = rows.map((row) =>
      InlineKeyboard.text(
        (row.reusable === 1 ? "R" : "_") + row.id,
        HISTORY_TOGGLE_PREFIX + row.id,
      ),
    );
    for (let i = 0; i < toggleRow.length; i += 5) {
      keyboard.row(...toggleRow.slice(i, i + 5));
    }
  }
  const pageRow = [];
  if (page > 0) pageRow.push(InlineKeyboard.text("<", HISTORY_PAGE_PREFIX + (page - 1)));
  pageRow.push(InlineKeyboard.text("Refresh", HISTORY_REFRESH));
  if (page < totalPages - 1) pageRow.push(InlineKeyboard.text(">", HISTORY_PAGE_PREFIX + (page + 1)));
  keyboard.row(...pageRow);
  const filterRow = [];
  if (reusableOnly) {
    filterRow.push(InlineKeyboard.text("Show All", HISTORY_FILTER_ALL));
  } else {
    filterRow.push(InlineKeyboard.text("Reusable", HISTORY_FILTER_REUSABLE));
  }
  filterRow.push(InlineKeyboard.text("Search", HISTORY_SEARCH));
  keyboard.row(...filterRow);
  keyboard.row(InlineKeyboard.text("Close", HISTORY_CLOSE));
  return { text: textLines.join("\n"), keyboard };
}
async function renderHistoryList(ctx: Context, page: number, keyword?: string, reusableOnly?: boolean): Promise<void> {
  const project = getCurrentProject();
  if (!project) {
    await ctx.reply("Please select a project first using /projects.");
    return;
  }
  const query = { keyword, reusableOnly, limit: PAGE_SIZE, offset: page * PAGE_SIZE };
  const [rows, totalCount] = await Promise.all([
    getConversationHistory(project.worktree, query),
    getConversationCount(project.worktree, query),
  ]);
  const result = buildHistoryMessage(rows, page, totalCount, keyword, reusableOnly ?? false);
  const replyMsg = await ctx.reply(result.text, {
    parse_mode: "HTML",
    reply_markup: result.keyboard,
  });
  const messageId = replyMsg.message_id;
  const chatId = ctx.chat?.id;
  if (chatId) {
    const key = chatId + ":" + messageId;
    // Clean up stale entries for this chat
    for (const [k] of historyState) {
      if (k.startsWith(chatId + ":") && k !== key) historyState.delete(k);
    }
    historyState.set(key, { page, keyword, reusableOnly: reusableOnly ?? false, messageId });
  }
}

interface HistoryPageState {
  page: number;
  keyword?: string;
  reusableOnly: boolean;
  messageId: number;
}

/** Tracks whether a chat is currently awaiting a search keyword */
const searchPendingByChat = new Map<number, boolean>();

const historyState = new Map<string, HistoryPageState>();

export async function historyCommand(ctx: Context): Promise<void> {
  const project = getCurrentProject();
  if (!project) {
    await ctx.reply("Please select a project first using /projects.");
    return;
  }
  let keyword;
  if ("message" in ctx.update && ctx.update.message) {
    const text = "text" in ctx.update.message ? ctx.update.message.text : undefined;
    if (typeof text === "string") {
      const parts = text.split(/\s+/);
      if (parts.length > 1) keyword = parts.slice(1).join(" ");
    }
  }
  await renderHistoryList(ctx, 0, keyword, false);
}

export async function handleHistoryCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith(HISTORY_CALLBACK_PREFIX)) return false;
  const project = getCurrentProject();
  if (!project) {
    await ctx.answerCallbackQuery({ text: "Please select a project first." });
    return true;
  }
  const chatId = ctx.chat?.id;
  const msgId = ctx.callbackQuery?.message?.message_id;
  if (!chatId || !msgId) return true;
  const key = chatId + ":" + msgId;
  let state = historyState.get(key);
  if (!state) state = { page: 0, keyword: undefined, reusableOnly: false, messageId: msgId };
  try {
    if (data.startsWith(HISTORY_TOGGLE_PREFIX)) {
      const entryId = parseToggleEntryId(data);
      if (entryId !== null) {
        const row = getConversationEntry(project.worktree, entryId);
        const newValue = row ? row.reusable === 0 : true;
        const success = setReusable(project.worktree, entryId, newValue);
        if (success) {
          await ctx.answerCallbackQuery({
            text: newValue ? "Marked as reusable" : "Unmarked reusable",
          });
        } else {
          await ctx.answerCallbackQuery({ text: "Update failed." });
        }
      }
      await renderHistoryList(ctx, state.page, state.keyword, state.reusableOnly);
      try { await ctx.deleteMessage(); } catch (e) {}
      return true;
    }
    if (data.startsWith(HISTORY_PAGE_PREFIX)) {
      const newPage = parseInt(data.replace(HISTORY_PAGE_PREFIX, ""), 10);
      if (!Number.isNaN(newPage)) {
        state.page = newPage;
        historyState.set(key, state);
        await renderHistoryList(ctx, newPage, state.keyword, state.reusableOnly);
        try { await ctx.deleteMessage(); } catch (e) {}
        await ctx.answerCallbackQuery();
      }
      return true;
    }
    if (data === HISTORY_FILTER_REUSABLE) {
      state.reusableOnly = true; state.page = 0;
      historyState.set(key, state);
      await renderHistoryList(ctx, 0, state.keyword, true);
      try { await ctx.deleteMessage(); } catch (e) {}
      await ctx.answerCallbackQuery();
      return true;
    }
    if (data === HISTORY_FILTER_ALL) {
      state.reusableOnly = false; state.page = 0;
      historyState.set(key, state);
      await renderHistoryList(ctx, 0, state.keyword, false);
      try { await ctx.deleteMessage(); } catch (e) {}
      await ctx.answerCallbackQuery();
      return true;
    }
    if (data === HISTORY_REFRESH) {
      await renderHistoryList(ctx, state.page, state.keyword, state.reusableOnly);
      try { await ctx.deleteMessage(); } catch (e) {}
      await ctx.answerCallbackQuery();
      return true;
    }
    if (data === HISTORY_SEARCH) {
      searchPendingByChat.set(chatId, true);
      await ctx.answerCallbackQuery({ text: "Type your search keyword..." });
      await ctx.reply("Please type the keyword you want to search for:", {
        reply_markup: new InlineKeyboard().text("Cancel", HISTORY_CALLBACK_PREFIX + "cancel_search"),
      });
      return true;
    }
    if (data === HISTORY_CALLBACK_PREFIX + "cancel_search") {
      searchPendingByChat.delete(chatId);
      try { await ctx.deleteMessage(); } catch (e) {}
      await ctx.answerCallbackQuery();
      return true;
    }
    if (data === HISTORY_CLOSE) {
      try { await ctx.deleteMessage(); } catch (e) {}
      historyState.delete(key);
      await ctx.answerCallbackQuery();
      return true;
    }
  } catch (err) {
    logger.error("[History] Error handling callback:", err);
    await ctx.answerCallbackQuery({ text: "Processing error." });
  }
  return true;
}

export async function handleHistorySearchInput(ctx: Context, text: string): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (!chatId || !searchPendingByChat.get(chatId)) return false;
  searchPendingByChat.delete(chatId);
  // Find the most recent history state for this chat
  let targetState: HistoryPageState | undefined;
  let targetKey: string | undefined;
  for (const [key, state] of historyState.entries()) {
    if (key.startsWith(chatId + ":")) {
      if (!targetState || state.messageId > targetState.messageId) {
        targetState = state;
        targetKey = key;
      }
    }
  }
  if (!targetState || !targetKey) return false;
  historyState.delete(targetKey);
  await renderHistoryList(ctx, 0, text, targetState.reusableOnly);
  try { await ctx.deleteMessage(); } catch (e) {}
  return true;
}

