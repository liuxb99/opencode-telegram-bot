import { CommandContext, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { getCurrentProject, setCurrentProject } from "../../settings/manager.js";
import { getGitWorktreeContext } from "../../git/worktree.js";
import { getProjects, getProjectByWorktree } from "../../project/manager.js";
import { syncSessionDirectoryCache, upsertSessionDirectory } from "../../session/cache-manager.js";

import {
  appendInlineMenuCancelButton,
  ensureActiveInlineMenu,
  replyWithInlineMenu,
} from "../handlers/inline-menu.js";
import { switchToProject } from "../utils/switch-project.js";
import { clearAllInteractionState } from "../../interaction/cleanup.js";
import { interactionManager } from "../../interaction/manager.js";
import { isForegroundBusy, replyBusyBlocked } from "../utils/busy-guard.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { config } from "../../config.js";
import { ProjectInfo } from "../../settings/manager.js";

const MAX_INLINE_BUTTON_LABEL_LENGTH = 64;
const PROJECT_PAGE_CALLBACK_PREFIX = "projects:page:";
const PROJECT_INPUT_PATH_CALLBACK = "project:input-path";

interface ProjectSelectDeps {
  ensureEventSubscription?: (directory: string) => Promise<void>;
}

interface ProjectsPaginationRange {
  page: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
}

function formatProjectButtonLabel(label: string, isActive: boolean): string {
  const prefix = isActive ? "✅ " : "";
  const availableLength = MAX_INLINE_BUTTON_LABEL_LENGTH - prefix.length;

  if (label.length <= availableLength) {
    return `${prefix}${label}`;
  }

  return `${prefix}${label.slice(0, Math.max(0, availableLength - 3))}...`;
}

export function getProjectFolderName(worktree: string): string {
  const normalized = worktree.replace(/[\\/]+$/g, "");

  if (!normalized) {
    return worktree;
  }

  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? normalized;
}

export function buildProjectButtonLabel(index: number, worktree: string): string {
  const folderName = getProjectFolderName(worktree);
  return `${index + 1}. ${folderName} [${worktree}]`;
}

export function parseProjectPageCallback(data: string): number | null {
  if (!data.startsWith(PROJECT_PAGE_CALLBACK_PREFIX)) {
    return null;
  }

  const rawPage = data.slice(PROJECT_PAGE_CALLBACK_PREFIX.length);
  if (!/^\d+$/.test(rawPage)) {
    return null;
  }

  return Number.parseInt(rawPage, 10);
}

export function calculateProjectsPaginationRange(
  totalProjects: number,
  page: number,
  pageSize: number,
): ProjectsPaginationRange {
  const safePageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(totalProjects / safePageSize));
  const normalizedPage = Math.min(Math.max(0, page), totalPages - 1);
  const startIndex = normalizedPage * safePageSize;
  const endIndex = Math.min(startIndex + safePageSize, totalProjects);

  return {
    page: normalizedPage,
    totalPages,
    startIndex,
    endIndex,
  };
}

function buildProjectsMenuText(
  currentProjectName: string | null,
  page: number,
  totalPages: number,
): string {
  const baseText = currentProjectName
    ? t("projects.select_with_current", {
        project: currentProjectName,
      })
    : t("projects.select");

  if (totalPages <= 1) {
    return baseText;
  }

  return `${baseText}\n\n${t("projects.page_indicator", {
    current: String(page + 1),
    total: String(totalPages),
  })}`;
}

function worktreeKey(worktree: string): string {
  return process.platform === "win32" ? worktree.toLowerCase() : worktree;
}

async function getActiveProjectWorktree(): Promise<string | null> {
  const currentProject = getCurrentProject();
  if (!currentProject) {
    return null;
  }

  try {
    const worktreeContext = await getGitWorktreeContext(currentProject.worktree);
    if (worktreeContext) {
      return worktreeContext.mainProjectPath;
    }
  } catch (error) {
    logger.debug("[Projects] Could not resolve active git worktree metadata:", error);
  }

  return currentProject.worktree;
}

async function buildProjectsKeyboard(
  projects: ProjectInfo[],
  page: number,
): Promise<InlineKeyboard> {
  const keyboard = new InlineKeyboard();
  const currentProject = getCurrentProject();
  const activeProjectWorktree = await getActiveProjectWorktree();
  const pageSize = config.bot.projectsListLimit;
  const {
    page: normalizedPage,
    totalPages,
    startIndex,
    endIndex,
  } = calculateProjectsPaginationRange(projects.length, page, pageSize);

  projects.slice(startIndex, endIndex).forEach((project, index) => {
    const isActive =
      currentProject &&
      (project.id === currentProject.id ||
        project.worktree === currentProject.worktree ||
        (activeProjectWorktree !== null &&
          worktreeKey(project.worktree) === worktreeKey(activeProjectWorktree)));
    const label = buildProjectButtonLabel(startIndex + index, project.worktree);
    const labelWithCheck = formatProjectButtonLabel(label, Boolean(isActive));
    keyboard.text(labelWithCheck, `project:${project.id}`).row();
  });

  if (totalPages > 1) {
    if (normalizedPage > 0) {
      keyboard.text(
        t("projects.prev_page"),
        `${PROJECT_PAGE_CALLBACK_PREFIX}${normalizedPage - 1}`,
      );
    }

    if (normalizedPage < totalPages - 1) {
      keyboard.text(
        t("projects.next_page"),
        `${PROJECT_PAGE_CALLBACK_PREFIX}${normalizedPage + 1}`,
      );
    }
  }

  keyboard.row();
  keyboard.text(t("projects.input_path"), PROJECT_INPUT_PATH_CALLBACK);

  return keyboard;
}

async function buildProjectsMenuView(
  projects: ProjectInfo[],
  page: number,
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const currentProject = getCurrentProject();
  const pageSize = config.bot.projectsListLimit;
  const { page: normalizedPage, totalPages } = calculateProjectsPaginationRange(
    projects.length,
    page,
    pageSize,
  );
  const currentProjectName = currentProject?.name || currentProject?.worktree || null;

  return {
    text: buildProjectsMenuText(currentProjectName, normalizedPage, totalPages),
    keyboard: await buildProjectsKeyboard(projects, normalizedPage),
  };
}

export async function projectsCommand(ctx: CommandContext<Context>) {
  try {
    if (isForegroundBusy()) {
      await replyBusyBlocked(ctx);
      return;
    }

    await syncSessionDirectoryCache();
    const projects = await getProjects();

    if (projects.length === 0) {
      await ctx.reply(t("projects.empty"));
      return;
    }

    const { text, keyboard } = await buildProjectsMenuView(projects, 0);

    await replyWithInlineMenu(ctx, {
      menuKind: "project",
      text,
      keyboard,
    });
  } catch (error) {
    logger.error("[Bot] Error fetching projects:", error);
    await ctx.reply(t("projects.fetch_error"));
  }
}

export async function handleProjectSelect(
  ctx: Context,
  deps: ProjectSelectDeps = {},
): Promise<boolean> {
  const callbackQuery = ctx.callbackQuery;
  if (!callbackQuery?.data) {
    return false;
  }

  const page = parseProjectPageCallback(callbackQuery.data);
  const isProjectSelection = callbackQuery.data.startsWith("project:");

  if (page === null && !isProjectSelection) {
    return false;
  }

  if (isForegroundBusy()) {
    await replyBusyBlocked(ctx);
    return true;
  }

  if (page !== null) {
    const isActiveMenu = await ensureActiveInlineMenu(ctx, "project");
    if (!isActiveMenu) {
      return true;
    }

    try {
      const projects = await getProjects();
      if (projects.length === 0) {
        await ctx.answerCallbackQuery();
        await ctx.reply(t("projects.empty"));
        return true;
      }

      const { text, keyboard } = await buildProjectsMenuView(projects, page);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(text, {
        reply_markup: appendInlineMenuCancelButton(keyboard, "project"),
      });
    } catch (error) {
      logger.error("[Bot] Error switching projects page:", error);
      await ctx.answerCallbackQuery({ text: t("projects.page_load_error") });
    }

    return true;
  }

  // Handle manual path input button
  if (callbackQuery.data === PROJECT_INPUT_PATH_CALLBACK) {
    const isActiveMenu = await ensureActiveInlineMenu(ctx, "project");
    if (!isActiveMenu) {
      return true;
    }

    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => {});

    interactionManager.start({
      kind: "custom",
      expectedInput: "text",
      metadata: {
        flow: "project-input-path",
        stage: "input",
      },
    });

    await ctx.reply(t("projects.input_path_prompt"));
    return true;
  }

  const projectId = callbackQuery.data.replace("project:", "");

  const isActiveMenu = await ensureActiveInlineMenu(ctx, "project");
  if (!isActiveMenu) {
    return true;
  }

  try {
    const projects = await getProjects();
    const selectedProject = projects.find((p) => p.id === projectId);

    if (!selectedProject) {
      throw new Error(`Project with id ${projectId} not found`);
    }

    const projectName = selectedProject.name || selectedProject.worktree;

    logger.info(`[Bot] Project selected: ${projectName} (id: ${projectId})`);

    const keyboard = deps.ensureEventSubscription
      ? await switchToProject(ctx, selectedProject, "project_switched", {
          ensureEventSubscription: deps.ensureEventSubscription,
        })
      : await switchToProject(ctx, selectedProject, "project_switched");

    await ctx.answerCallbackQuery();
    await ctx.reply(t("projects.selected", { project: projectName }), {
      reply_markup: keyboard,
    });

    await ctx.deleteMessage();
  } catch (error) {
    clearAllInteractionState("project_select_error");
    logger.error("[Bot] Error selecting project:", error);
    await ctx.answerCallbackQuery();
    await ctx.reply(t("projects.select_error"));
  }

  return true;
}

/**
 * Handle text input for manual project path entry.
 * Expects an active custom interaction with flow "project-input-path".
 */
export async function handleProjectPathInput(ctx: Context): Promise<boolean> {
  const state = interactionManager.getSnapshot();
  if (
    !state ||
    state.kind !== "custom" ||
    state.metadata.flow !== "project-input-path"
  ) {
    return false;
  }

  const text = ctx.message?.text?.trim();
  if (!text) {
    return false;
  }

  interactionManager.clear("project_path_input");

  try {
    const resolvedPath = path.resolve(text);
    const folderName = resolvedPath.split(/[\\/]/).filter(Boolean).at(-1) ?? resolvedPath;
    const id = `dir_${createHash("md5").update(resolvedPath).digest("hex").slice(0, 14)}`;

    // Create directory if it doesn't exist
    await mkdir(resolvedPath, { recursive: true });

    // Try to find existing project by path, or create a new one
    let project: ProjectInfo;
    try {
      project = await getProjectByWorktree(resolvedPath);
    } catch {
      project = { id, worktree: resolvedPath, name: folderName };
    }

    await upsertSessionDirectory(resolvedPath, Date.now());
    await switchToProject(ctx, project, "project_path_input");
    await ctx.reply(t("projects.input_path_done", { path: resolvedPath }));
    return true;
  } catch (err) {
    logger.error("[Projects] Error switching to path:", err);
    await ctx.reply(t("projects.input_path_error", { path: text }));
    return true;
  }
}
