import { tool } from "@langchain/core/tools";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { DbClient } from "@agents/db";
import type {
  ScheduledTaskChannel,
  ScheduledTaskRecurrence,
  ToolCall,
  UserIntegration,
  UserToolSetting,
} from "@agents/types";
import { TOOL_CATALOG } from "./catalog";
import {
  cancelScheduledTaskById,
  createScheduledTask,
  createToolCall,
  getTelegramAccountByUserId,
  getToolCallById,
  listScheduledTasksForUser,
  updateToolCallStatus,
} from "@agents/db";
import {
  createGithubIssue,
  createGithubRepository,
  listGithubIssues,
  listGithubRepos,
  type GitHubAuthContext,
} from "./github-client";
import {
  checkCalendarAvailability,
  createCalendarEvent,
  listCalendarEvents,
  type GoogleCalendarAuthContext,
} from "./google-calendar-client";
import { searchContacts } from "./google-contacts-client";
import { executeTerminalCommand } from "./terminal-session-manager";

export interface PendingConfirmation {
  toolCallId: string;
  toolName: string;
  message: string;
  checkpointThreadId?: string;
}

interface ToolExecutionResult {
  message: string;
  [key: string]: unknown;
}

export interface PendingToolReview {
  toolName: string;
  input: Record<string, unknown>;
  message: string;
  allowedDecisions: Array<"approve" | "reject">;
}

export interface IntegrationSecrets {
  github?: GitHubAuthContext | null;
  google?: GoogleCalendarAuthContext | null;
}

export interface ToolContext {
  db: DbClient;
  userId: string;
  sessionId: string;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  integrationSecrets?: IntegrationSecrets;
}

const contactsLookupSchema = z.object({
  names: z.array(z.string()).min(1).describe("List of person names to search"),
});

const calendarCheckAvailabilitySchema = z.object({
  time_min: z.string().describe("Start of the first range in ISO 8601 format"),
  time_max: z.string().describe("End of the first range in ISO 8601 format"),
  extra_ranges: z
    .array(
      z.object({
        time_min: z.string(),
        time_max: z.string(),
      })
    )
    .optional()
    .default([])
    .describe("Additional time ranges to check in the same query"),
});

const calendarListEventsSchema = z.object({
  time_min: z.string(),
  time_max: z.string(),
  max_results: z.number().max(50).optional().default(20),
});

const calendarCreateEventSchema = z.object({
  summary: z.string(),
  start_date_time: z.string(),
  end_date_time: z.string(),
  description: z.string().optional().default(""),
  location: z.string().optional().default(""),
  time_zone: z.string().optional().default("UTC"),
  attendee_emails: z
    .array(z.string())
    .optional()
    .default([])
    .describe("List of attendee email addresses"),
});

const githubListReposSchema = z.object({
  per_page: z.number().max(30).optional().default(10),
});

const githubListIssuesSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  state: z.enum(["open", "closed", "all"]).optional().default("open"),
});

const githubCreateIssueSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  title: z.string(),
  body: z.string().optional().default(""),
});

const githubCreateRepoSchema = z.object({
  name: z.string(),
  description: z.string().optional().default(""),
  private: z.boolean().optional().default(true),
});

const bashToolSchema = z.object({
  terminal: z
    .string()
    .min(1)
    .default("default")
    .describe('Persistent terminal session name to reuse or create. If omitted, use "default".'),
  prompt: z.string().min(1).describe("Command text to execute inside the selected terminal"),
});

const filePathSchema = z
  .string()
  .min(1)
  .describe("Absolute path or path relative to the repository root");

const readFileToolSchema = z.object({
  path: filePathSchema,
  offset: z
    .number()
    .int()
    .refine((value) => value !== 0, "offset cannot be 0")
    .optional()
    .describe("Line offset to start reading from. Positive values are 1-indexed; negative values count from the end."),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of lines to return"),
});

const writeFileToolSchema = z.object({
  path: filePathSchema,
  content: z.string().describe("Full text content to write into the new file"),
});

const editFileToolSchema = z.object({
  path: filePathSchema,
  old_string: z.string().min(1).describe("Exact existing text to replace. It must be unique in the file."),
  new_string: z.string().describe("Replacement text"),
});

const createScheduledTaskSchema = z
  .object({
    prompt: z
      .string()
      .min(1)
      .describe("Natural-language instruction that the agent should execute when the task becomes due"),
    schedule_type: z.enum(["one_time", "recurring"]),
    run_at: z
      .string()
      .min(1)
      .describe("First execution datetime in ISO 8601 format with timezone offset"),
    recurrence: z
      .enum(["daily", "weekly", "monthly"])
      .optional()
      .describe("Required only when schedule_type is recurring"),
    timezone: z
      .string()
      .min(1)
      .optional()
      .default("America/Bogota")
      .describe("IANA timezone for the scheduled task"),
    channel: z
      .enum(["telegram"])
      .optional()
      .default("telegram")
      .describe("Delivery channel for the scheduled task"),
  })
  .superRefine((input, ctx) => {
    const parsedDate = new Date(input.run_at);
    if (Number.isNaN(parsedDate.getTime())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["run_at"],
        message: "run_at must be a valid ISO 8601 datetime",
      });
    }

    if (input.schedule_type === "recurring" && !input.recurrence) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recurrence"],
        message: "recurrence is required when schedule_type is recurring",
      });
    }

    if (input.schedule_type === "one_time" && input.recurrence) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recurrence"],
        message: "recurrence must be omitted when schedule_type is one_time",
      });
    }
  });

const listScheduledTasksSchema = z.object({
  status: z
    .enum(["active", "processing", "completed", "failed", "paused", "cancelled", "all"])
    .optional()
    .default("active")
    .describe("Optional status filter. Defaults to active."),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .default(20)
    .describe("Maximum number of tasks to return"),
});

const cancelScheduledTaskSchema = z.object({
  task_id: z.string().uuid().describe("The exact scheduled task id to cancel"),
});

function getRepoRoot(): string {
  const candidates = [
    process.cwd(),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "../.."),
  ];

  return (
    candidates.find((candidate) => {
      return (
        existsSync(path.join(candidate, "package.json")) &&
        existsSync(path.join(candidate, "apps")) &&
        existsSync(path.join(candidate, "packages"))
      );
    }) ?? process.cwd()
  );
}

const REPO_ROOT = getRepoRoot();

function resolveRepoPath(inputPath: string): string {
  const resolved = path.isAbsolute(inputPath)
    ? path.normalize(inputPath)
    : path.resolve(REPO_ROOT, inputPath);
  const relative = path.relative(REPO_ROOT, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `La ruta "${inputPath}" está fuera del repositorio. Usa una ruta dentro de ${REPO_ROOT}.`
    );
  }

  return resolved;
}

function countOccurrences(content: string, search: string): number {
  return content.split(search).length - 1;
}

function splitFileLines(content: string): string[] {
  if (content.length === 0) return [];
  return content.split(/\r?\n/);
}

function formatNumberedLines(lines: string[], startLineNumber: number): string {
  return lines.map((line, index) => `${startLineNumber + index}|${line}`).join("\n");
}

function computeNextRunAt(
  runAtIso: string,
  scheduleType: "one_time" | "recurring",
  recurrence?: ScheduledTaskRecurrence
): string {
  const current = new Date(runAtIso);
  if (Number.isNaN(current.getTime())) {
    throw new Error(`No se pudo programar la tarea: run_at "${runAtIso}" no es válido.`);
  }

  if (scheduleType === "one_time") {
    return current.toISOString();
  }

  if (!recurrence) {
    throw new Error("No se pudo programar la tarea: recurrence es obligatoria para tareas recurrentes.");
  }

  return current.toISOString();
}

function formatScheduledTaskDateLabel(
  isoDate: string | null,
  timezone: string
): string | null {
  if (!isoDate) return null;

  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) return isoDate;

  return parsed.toLocaleString("es-CO", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  });
}

async function executeReadFileTool(
  rawInput: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const input = readFileToolSchema.parse(rawInput);
  const resolvedPath = resolveRepoPath(input.path);

  let content: string;
  try {
    content = await fs.readFile(resolvedPath, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(`No se pudo leer "${input.path}": el archivo no existe.`);
    }
    throw new Error(
      `No se pudo leer "${input.path}": ${err.message ?? "error de lectura desconocido"}.`
    );
  }

  const lines = splitFileLines(content);
  const totalLines = lines.length;

  if (totalLines === 0) {
    return {
      message: `Archivo leído correctamente: ${input.path}. El archivo está vacío.`,
      path: resolvedPath,
      totalLines: 0,
      returnedLines: 0,
      content: "",
    };
  }

  let startIndex = 0;
  if (typeof input.offset === "number") {
    if (input.offset > 0) {
      if (input.offset > totalLines) {
        throw new Error(
          `No se pudo leer "${input.path}": offset ${input.offset} excede el total de líneas (${totalLines}).`
        );
      }
      startIndex = input.offset - 1;
    } else {
      if (Math.abs(input.offset) > totalLines) {
        throw new Error(
          `No se pudo leer "${input.path}": offset ${input.offset} excede el total de líneas (${totalLines}).`
        );
      }
      startIndex = totalLines + input.offset;
    }
  }

  const selectedLines =
    typeof input.limit === "number"
      ? lines.slice(startIndex, startIndex + input.limit)
      : lines.slice(startIndex);

  return {
    message: `Archivo leído correctamente: ${input.path}.`,
    path: resolvedPath,
    totalLines,
    returnedLines: selectedLines.length,
    offsetApplied: input.offset ?? 1,
    limitApplied: input.limit ?? null,
    content: formatNumberedLines(selectedLines, startIndex + 1),
  };
}

async function executeWriteFileTool(
  rawInput: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const input = writeFileToolSchema.parse(rawInput);
  const resolvedPath = resolveRepoPath(input.path);
  const parentDirectory = path.dirname(resolvedPath);

  try {
    await fs.access(resolvedPath);
    throw new Error(`No se pudo crear "${input.path}": el archivo ya existe.`);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (!(err instanceof Error) || err.message.startsWith("No se pudo crear")) {
      throw error;
    }
    if (err.code !== "ENOENT") {
      throw new Error(
        `No se pudo validar "${input.path}": ${err.message ?? "error desconocido"}.`
      );
    }
  }

  try {
    const stats = await fs.stat(parentDirectory);
    if (!stats.isDirectory()) {
      throw new Error(`No se pudo crear "${input.path}": la carpeta padre no es válida.`);
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err instanceof Error && err.message.startsWith("No se pudo crear")) {
      throw error;
    }
    if (err.code === "ENOENT") {
      throw new Error(
        `No se pudo crear "${input.path}": la carpeta padre "${path.relative(REPO_ROOT, parentDirectory) || "."}" no existe.`
      );
    }
    throw new Error(
      `No se pudo validar la carpeta padre de "${input.path}": ${err.message ?? "error desconocido"}.`
    );
  }

  try {
    await fs.writeFile(resolvedPath, input.content, { flag: "wx" });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "EEXIST") {
      throw new Error(`No se pudo crear "${input.path}": el archivo ya existe.`);
    }
    throw new Error(
      `No se pudo crear "${input.path}": ${err.message ?? "error de escritura desconocido"}.`
    );
  }

  return {
    message: `Archivo creado correctamente: ${input.path}.`,
    path: resolvedPath,
    charsWritten: input.content.length,
    bytesWritten: Buffer.byteLength(input.content, "utf8"),
  };
}

async function executeEditFileTool(
  rawInput: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const input = editFileToolSchema.parse(rawInput);
  const resolvedPath = resolveRepoPath(input.path);

  let content: string;
  try {
    content = await fs.readFile(resolvedPath, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(`No se pudo editar "${input.path}": el archivo no existe.`);
    }
    throw new Error(
      `No se pudo leer "${input.path}" para editarlo: ${err.message ?? "error desconocido"}.`
    );
  }

  const occurrences = countOccurrences(content, input.old_string);
  if (occurrences === 0) {
    throw new Error(
      `No se pudo editar "${input.path}": old_string no aparece en el archivo.`
    );
  }
  if (occurrences > 1) {
    throw new Error(
      `No se pudo editar "${input.path}": old_string aparece ${occurrences} veces. Usa un texto más específico para evitar ambigüedad.`
    );
  }

  const updatedContent = content.replace(input.old_string, input.new_string);

  try {
    await fs.writeFile(resolvedPath, updatedContent, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    throw new Error(
      `No se pudo guardar "${input.path}": ${err.message ?? "error de escritura desconocido"}.`
    );
  }

  return {
    message: `Archivo editado correctamente: ${input.path}.`,
    path: resolvedPath,
    replacements: 1,
  };
}

async function executeCreateScheduledTaskTool(
  rawInput: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolExecutionResult> {
  const input = createScheduledTaskSchema.parse(rawInput);

  if (input.channel === "telegram") {
    const telegramAccount = await getTelegramAccountByUserId(ctx.db, ctx.userId);
    if (!telegramAccount) {
      throw new Error(
        "No se pudo crear la tarea programada: el usuario no tiene Telegram vinculado y ese es el canal por defecto."
      );
    }
  }

  const nextRunAt = computeNextRunAt(input.run_at, input.schedule_type, input.recurrence);
  const task = await createScheduledTask(ctx.db, {
    userId: ctx.userId,
    prompt: input.prompt,
    scheduleType: input.schedule_type,
    recurrence: input.recurrence ?? null,
    runAt: new Date(input.run_at).toISOString(),
    nextRunAt,
    timezone: input.timezone,
    channel: input.channel as ScheduledTaskChannel,
    createdViaSessionId: ctx.sessionId,
  });

  const runAtLabel = formatScheduledTaskDateLabel(input.run_at, input.timezone);
  const nextRunAtLabel = formatScheduledTaskDateLabel(nextRunAt, input.timezone);

  return {
    message:
      input.schedule_type === "one_time"
        ? `Tarea programada creada para ejecutarse una vez el ${runAtLabel ?? input.run_at}.`
        : `Tarea programada recurrente creada. Primera ejecución: ${runAtLabel ?? input.run_at}. Frecuencia: ${input.recurrence}.`,
    task: {
      ...task,
      run_at_label: runAtLabel,
      next_run_at_label: nextRunAtLabel,
    },
  };
}

async function executeListScheduledTasksTool(
  rawInput: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolExecutionResult> {
  const input = listScheduledTasksSchema.parse(rawInput);
  const tasks = await listScheduledTasksForUser(ctx.db, {
    userId: ctx.userId,
    status: input.status,
    limit: input.limit,
  });

  const summarizedTasks = tasks.map((task, index) => ({
    reference_number: index + 1,
    id: task.id,
    status: task.status,
    schedule_type: task.schedule_type,
    recurrence: task.recurrence,
    run_at: task.run_at,
    run_at_label: formatScheduledTaskDateLabel(task.run_at, task.timezone),
    next_run_at: task.next_run_at,
    next_run_at_label: formatScheduledTaskDateLabel(task.next_run_at, task.timezone),
    timezone: task.timezone,
    channel: task.channel,
    prompt_preview:
      task.prompt.length > 140 ? `${task.prompt.slice(0, 140)}...` : task.prompt,
  }));

  return {
    message:
      summarizedTasks.length > 0
        ? `Se encontraron ${summarizedTasks.length} tarea(s) programada(s).`
        : "No se encontraron tareas programadas con ese filtro.",
    tasks: summarizedTasks,
    count: summarizedTasks.length,
    statusFilter: input.status,
  };
}

async function executeCancelScheduledTaskTool(
  rawInput: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolExecutionResult> {
  const input = cancelScheduledTaskSchema.parse(rawInput);
  const task = await cancelScheduledTaskById(ctx.db, ctx.userId, input.task_id);

  return {
    message: `La tarea programada "${input.task_id}" fue cancelada correctamente.`,
    task: {
      id: task.id,
      status: task.status,
      schedule_type: task.schedule_type,
      recurrence: task.recurrence,
      next_run_at: task.next_run_at,
      next_run_at_label: formatScheduledTaskDateLabel(task.next_run_at, task.timezone),
      prompt_preview: task.prompt.length > 140 ? `${task.prompt.slice(0, 140)}...` : task.prompt,
    },
  };
}

function isToolAvailable(toolId: string, ctx: ToolContext): boolean {
  const setting = ctx.enabledTools.find((t) => t.tool_id === toolId);
  if (!setting?.enabled) return false;

  const def = TOOL_CATALOG.find((t) => t.id === toolId);
  if (def?.requires_integration) {
    const hasIntegration = ctx.integrations.some(
      (i) => i.provider === def.requires_integration && i.status === "active"
    );
    if (!hasIntegration) return false;
  }
  return true;
}

function getGithubAuth(ctx: ToolContext): GitHubAuthContext {
  const github = ctx.integrationSecrets?.github;
  if (!github?.accessToken) {
    throw new Error("GitHub integration is not available for this user.");
  }
  return github;
}

function getGoogleAuth(ctx: ToolContext): GoogleCalendarAuthContext {
  const google = ctx.integrationSecrets?.google;
  if (!google?.accessToken) {
    throw new Error("Google Calendar integration is not available for this user.");
  }
  return google;
}

async function executeGithubTool(
  toolName: string,
  rawInput: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolExecutionResult> {
  const github = getGithubAuth(ctx);

  if (toolName === "github_list_repos") {
    const input = githubListReposSchema.parse(rawInput);
    const result = await listGithubRepos(github, input.per_page);
    return {
      message: `Se encontraron ${result.repos.length} repositorios en GitHub.`,
      repos: result.repos,
    };
  }

  if (toolName === "github_list_issues") {
    const input = githubListIssuesSchema.parse(rawInput);
    const result = await listGithubIssues(github, input.owner, input.repo, input.state);
    return {
      message: `Se encontraron ${result.issues.length} issues en ${input.owner}/${input.repo}.`,
      issues: result.issues,
    };
  }

  if (toolName === "github_create_issue") {
    const input = githubCreateIssueSchema.parse(rawInput);
    const issue = await createGithubIssue(
      github,
      input.owner,
      input.repo,
      input.title,
      input.body
    );
    return {
      message: `Issue creado correctamente en ${input.owner}/${input.repo}.`,
      issue,
    };
  }

  if (toolName === "github_create_repo") {
    const input = githubCreateRepoSchema.parse(rawInput);
    const repository = await createGithubRepository(
      github,
      input.name,
      input.description,
      input.private
    );
    return {
      message: `Repositorio creado correctamente: ${repository.url}`,
      repository,
    };
  }

  throw new Error(`Unsupported tool execution for ${toolName}`);
}

async function executeGoogleCalendarTool(
  toolName: string,
  rawInput: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolExecutionResult> {
  const google = getGoogleAuth(ctx);

  if (toolName === "contacts_lookup") {
    const input = contactsLookupSchema.parse(rawInput);
    const results = await Promise.all(
      input.names.map((name) => searchContacts(google.accessToken, name))
    );

    const summary = results.map((r) => {
      if (r.totalFound === 0) {
        return {
          name: r.query,
          found: false,
          emails: [] as string[],
          resolvedEmail: null as string | null,
          multiple: false,
          contacts: [] as { name: string; email: string }[],
        };
      }
      if (r.totalFound === 1) {
        return {
          name: r.found[0].name,
          found: true,
          multiple: false,
          emails: r.found[0].emails,
          resolvedEmail: r.found[0].emails[0],
          contacts: [{ name: r.found[0].name, email: r.found[0].emails[0] }],
        };
      }
      return {
        name: r.query,
        found: true,
        multiple: true,
        emails: r.found.flatMap((c) => c.emails),
        resolvedEmail: null as string | null,
        contacts: r.found.map((c) => ({ name: c.name, email: c.emails[0] })),
      };
    });

    let message = "";

    for (const s of summary) {
      if (!s.found) {
        message += `No se encontró "${s.name}" en los contactos. Pide su email al usuario.\n`;
      } else if (!s.multiple) {
        message += `${s.name}: ${s.resolvedEmail}\n`;
      } else {
        const list = s.contacts.map((c, i) => `${i + 1}. ${c.name} - ${c.email}`).join("\n");
        message += `Múltiples resultados para "${s.name}":\n${list}\n`;
      }
    }

    const resolvedEmails = summary
      .filter((s) => s.resolvedEmail)
      .map((s) => s.resolvedEmail);
    if (resolvedEmails.length > 0) {
      message += `\nIMPORTANTE: Al crear el evento incluye TODOS los emails resueltos: ${resolvedEmails.join(", ")}`;
    }

    return { message: message.trim(), contacts: summary };
  }

  if (toolName === "calendar_check_availability") {
    const input = calendarCheckAvailabilitySchema.parse(rawInput);

    const getLocalOffset = (tz: string): string => {
      const offsetRaw = new Date()
        .toLocaleString("en-US", { timeZone: tz, timeZoneName: "shortOffset" })
        .match(/GMT([+-]\d+(?::\d+)?)/)?.[1] ?? "-5";
      const sign = offsetRaw.startsWith("-") ? "-" : "+";
      const [h, m = "0"] = offsetRaw.replace(/[+-]/, "").split(":");
      return `${sign}${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
    };

    const normalizeToLocalTime = (isoStr: string, tz: string): string => {
      const offset = getLocalOffset(tz);
      if (/^\d{4}-\d{2}-\d{2}$/.test(isoStr)) return `${isoStr}T00:00:00${offset}`;
      const date = new Date(isoStr);
      const localDate = date.toLocaleDateString("en-CA", { timeZone: tz });
      const [hh, mm, ss] = date
        .toLocaleTimeString("en-US", {
          timeZone: tz,
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
        .split(":")
        .map((v) => v.padStart(2, "0"));
      return `${localDate}T${hh}:${mm}:${ss}${offset}`;
    };

    const normalizedMin = normalizeToLocalTime(input.time_min, google.timeZone);
    const normalizedMax = normalizeToLocalTime(input.time_max, google.timeZone);
    const extraRanges = (input.extra_ranges ?? []).map((r) => ({
      time_min: normalizeToLocalTime(r.time_min, google.timeZone),
      time_max: normalizeToLocalTime(r.time_max, google.timeZone),
    }));

    const allRanges = [{ time_min: normalizedMin, time_max: normalizedMax }, ...extraRanges];

    const results = await Promise.all(
      allRanges.map((r) =>
        checkCalendarAvailability(google, r.time_min, r.time_max, ["primary"])
      )
    );

    const combined = results.map((r) => ({
      range: `${r.queryRange.start} - ${r.queryRange.end}`,
      date: r.date,
      free: r.free,
      busy: r.busy,
      hasFreeTime: r.hasFreeTime,
    }));

    const totalFree = results.reduce((acc, r) => acc + r.free.length, 0);
    const message =
      totalFree > 0
        ? `Se encontraron ${totalFree} espacio(s) libre(s) en los rangos consultados.`
        : "No hay espacios libres en los rangos consultados.";

    return { message, ranges: combined };
  }

  if (toolName === "calendar_list_events") {
    const input = calendarListEventsSchema.parse(rawInput);
    const result = await listCalendarEvents(
      google,
      input.time_min,
      input.time_max,
      input.max_results
    );
    return {
      message: `Se encontraron ${result.count} evento(s) en tu agenda.`,
      events: result.events,
    };
  }

  if (toolName === "calendar_create_event") {
    const input = calendarCreateEventSchema.parse(rawInput);
    const result = await createCalendarEvent(
      google,
      input.summary,
      input.start_date_time,
      input.end_date_time,
      input.description,
      input.location,
      input.time_zone,
      input.attendee_emails
    );
    return {
      message: `Evento "${input.summary}" creado correctamente: ${result.htmlLink}`,
      event: result.event,
    };
  }

  throw new Error(`Unsupported calendar tool: ${toolName}`);
}

async function executeBashTool(
  rawInput: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolExecutionResult> {
  const input = bashToolSchema.parse(rawInput);
  const result = await executeTerminalCommand(ctx.userId, input.terminal, input.prompt);

  return {
    message: result.timedOut
      ? `El comando en el terminal "${result.terminal}" excedió el tiempo límite.`
      : `Comando ejecutado en el terminal "${result.terminal}".`,
    terminal: result.terminal,
    shell: result.shell,
    prompt: result.prompt,
    output: result.output,
    timedOut: result.timedOut,
    truncated: result.truncated,
    exitCode: result.exitCode,
  };
}

function routeToolExecution(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolExecutionResult> {
  if (toolName === "bash") {
    return executeBashTool(input, ctx);
  }
  if (toolName === "create_scheduled_task") {
    return executeCreateScheduledTaskTool(input, ctx);
  }
  if (toolName === "list_scheduled_tasks") {
    return executeListScheduledTasksTool(input, ctx);
  }
  if (toolName === "cancel_scheduled_task") {
    return executeCancelScheduledTaskTool(input, ctx);
  }
  if (toolName === "read_file") {
    return executeReadFileTool(input);
  }
  if (toolName === "write_file") {
    return executeWriteFileTool(input);
  }
  if (toolName === "edit_file") {
    return executeEditFileTool(input);
  }
  if (toolName.startsWith("calendar_") || toolName === "contacts_lookup") {
    return executeGoogleCalendarTool(toolName, input, ctx);
  }
  return executeGithubTool(toolName, input, ctx);
}

async function executeImmediateTool(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const record = await createToolCall(ctx.db, ctx.sessionId, toolName, input, false);

  try {
    const result = await routeToolExecution(toolName, input, ctx);
    await updateToolCallStatus(ctx.db, record.id, "executed", result);
    return JSON.stringify(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown tool execution error";
    await updateToolCallStatus(ctx.db, record.id, "failed", { message });
    throw error;
  }
}

export function buildPendingToolReview(
  toolName: string,
  input: Record<string, unknown>
): PendingToolReview {
  if (toolName === "github_create_issue") {
    const parsed = githubCreateIssueSchema.parse(input);
    return {
      toolName,
      input,
      message: `Confirma si deseas crear el issue "${parsed.title}" en ${parsed.owner}/${parsed.repo}.`,
      allowedDecisions: ["approve", "reject"],
    };
  }

  if (toolName === "github_create_repo") {
    const parsed = githubCreateRepoSchema.parse(input);
    return {
      toolName,
      input,
      message: `Confirma si deseas crear el repositorio "${parsed.name}".`,
      allowedDecisions: ["approve", "reject"],
    };
  }

  if (toolName === "calendar_create_event") {
    const parsed = calendarCreateEventSchema.parse(input);
    return {
      toolName,
      input,
      message: `Confirma si deseas crear el evento "${parsed.summary}" el ${parsed.start_date_time}.`,
      allowedDecisions: ["approve", "reject"],
    };
  }

  if (toolName === "calendar_list_events") {
    const parsed = calendarListEventsSchema.parse(input);
    return {
      toolName,
      input,
      message: `Confirma si deseas consultar los eventos entre ${parsed.time_min} y ${parsed.time_max}.`,
      allowedDecisions: ["approve", "reject"],
    };
  }

  if (toolName === "calendar_check_availability") {
    const parsed = calendarCheckAvailabilitySchema.parse(input);
    return {
      toolName,
      input,
      message: `Confirma si deseas consultar la disponibilidad entre ${parsed.time_min} y ${parsed.time_max}.`,
      allowedDecisions: ["approve", "reject"],
    };
  }

  if (toolName === "bash") {
    const parsed = bashToolSchema.parse(input);
    const promptPreview =
      parsed.prompt.length > 160 ? `${parsed.prompt.slice(0, 160)}...` : parsed.prompt;
    const terminalMessage =
      parsed.terminal === "default"
        ? "Confirma si deseas ejecutar este comando."
        : `Confirma si deseas ejecutar el comando en el terminal "${parsed.terminal}".`;
    return {
      toolName,
      input,
      message: `${terminalMessage} Comando: ${promptPreview}`,
      allowedDecisions: ["approve", "reject"],
    };
  }

  if (toolName === "write_file") {
    const parsed = writeFileToolSchema.parse(input);
    return {
      toolName,
      input,
      message: `Confirma si deseas crear el archivo "${parsed.path}".`,
      allowedDecisions: ["approve", "reject"],
    };
  }

  if (toolName === "edit_file") {
    const parsed = editFileToolSchema.parse(input);
    return {
      toolName,
      input,
      message: `Confirma si deseas editar el archivo "${parsed.path}".`,
      allowedDecisions: ["approve", "reject"],
    };
  }

  if (toolName === "create_scheduled_task") {
    const parsed = createScheduledTaskSchema.parse(input);
    const recurrenceText =
      parsed.schedule_type === "recurring" ? ` con frecuencia ${parsed.recurrence}` : "";
    const runAtLabel = formatScheduledTaskDateLabel(parsed.run_at, parsed.timezone);
    return {
      toolName,
      input,
      message:
        `Confirma si deseas crear una tarea programada para ${runAtLabel ?? parsed.run_at}${recurrenceText}. ` +
        `Canal: ${parsed.channel}. Prompt: ${parsed.prompt.slice(0, 160)}${parsed.prompt.length > 160 ? "..." : ""}`,
      allowedDecisions: ["approve", "reject"],
    };
  }

  if (toolName === "cancel_scheduled_task") {
    const parsed = cancelScheduledTaskSchema.parse(input);
    return {
      toolName,
      input,
      message:
        `Confirma si deseas cancelar la tarea programada con id "${parsed.task_id}". ` +
        `No volverá a ejecutarse mientras permanezca cancelada.`,
      allowedDecisions: ["approve", "reject"],
    };
  }

  return {
    toolName,
    input,
    message: `Confirma si deseas ejecutar la acción "${toolName}".`,
    allowedDecisions: ["approve", "reject"],
  };
}

export async function createPendingToolCallRecord(
  ctx: ToolContext,
  review: PendingToolReview,
  checkpointThreadId?: string
): Promise<PendingConfirmation> {
  const record = await createToolCall(
    ctx.db,
    ctx.sessionId,
    review.toolName,
    checkpointThreadId
      ? { ...review.input, __checkpoint_thread_id: checkpointThreadId }
      : review.input,
    true
  );
  return {
    toolCallId: record.id,
    toolName: review.toolName,
    message: review.message,
    checkpointThreadId,
  };
}

export async function executeToolCallById(
  ctx: ToolContext,
  toolCallId: string,
  inputOverride?: Record<string, unknown>
): Promise<{ toolCall: ToolCall; result: ToolExecutionResult }> {
  const toolCall = await getToolCallById(ctx.db, toolCallId);
  if (!toolCall) {
    throw new Error("Tool call not found.");
  }

  if (toolCall.status !== "approved") {
    throw new Error("Tool call is not approved for execution.");
  }

  try {
    const result = await routeToolExecution(
      toolCall.tool_name,
      inputOverride ?? toolCall.arguments_json,
      ctx
    );
    await updateToolCallStatus(ctx.db, toolCall.id, "executed", result);
    return { toolCall, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown tool execution error";
    await updateToolCallStatus(ctx.db, toolCall.id, "failed", { message });
    throw error;
  }
}

export function buildLangChainTools(ctx: ToolContext) {
  const tools = [];

  if (isToolAvailable("bash", ctx)) {
    tools.push(
      tool(async (input) => executeImmediateTool("bash", input, ctx), {
        name: "bash",
        description:
          "Executes system commands in a persistent terminal session identified by name and returns the terminal text output. The real shell depends on the host OS.",
        schema: bashToolSchema,
      })
    );
  }

  if (isToolAvailable("create_scheduled_task", ctx)) {
    tools.push(
      tool(async (input) => executeImmediateTool("create_scheduled_task", input, ctx), {
        name: "create_scheduled_task",
        description:
          "Creates a scheduled task that will re-run a natural-language prompt later through the agent. Use it for reminders, recurring follow-ups and deferred automations. Defaults to Telegram delivery.",
        schema: createScheduledTaskSchema,
      })
    );
  }

  if (isToolAvailable("list_scheduled_tasks", ctx)) {
    tools.push(
      tool(async (input) => executeImmediateTool("list_scheduled_tasks", input, ctx), {
        name: "list_scheduled_tasks",
        description:
          "Lists the user's scheduled tasks. Returns ids, status, schedule type, recurrence, next execution time and a short prompt preview.",
        schema: listScheduledTasksSchema,
      })
    );
  }

  if (isToolAvailable("cancel_scheduled_task", ctx)) {
    tools.push(
      tool(async (input) => executeImmediateTool("cancel_scheduled_task", input, ctx), {
        name: "cancel_scheduled_task",
        description:
          "Cancels a scheduled task so it stops running in the future. Use only when you already know the exact task_id.",
        schema: cancelScheduledTaskSchema,
      })
    );
  }

  if (isToolAvailable("read_file", ctx)) {
    tools.push(
      tool(async (input) => executeImmediateTool("read_file", input, ctx), {
        name: "read_file",
        description:
          "Reads a text file from the repository. Use it to inspect existing files. Returns numbered lines and metadata about the slice returned.",
        schema: readFileToolSchema,
      })
    );
  }

  if (isToolAvailable("write_file", ctx)) {
    tools.push(
      tool(async (input) => executeImmediateTool("write_file", input, ctx), {
        name: "write_file",
        description:
          "Creates a new text file inside the repository. Use it only when the target file does not exist yet. Returns the created path and bytes written.",
        schema: writeFileToolSchema,
      })
    );
  }

  if (isToolAvailable("edit_file", ctx)) {
    tools.push(
      tool(async (input) => executeImmediateTool("edit_file", input, ctx), {
        name: "edit_file",
        description:
          "Edits an existing text file by replacing one unique exact string. Use it for precise updates when you know the current text to replace.",
        schema: editFileToolSchema,
      })
    );
  }

  if (isToolAvailable("get_user_preferences", ctx)) {
    tools.push(
      tool(async () => {
        const { getProfile } = await import("@agents/db");
        const profile = await getProfile(ctx.db, ctx.userId);
        return JSON.stringify({
          name: profile.name,
          timezone: profile.timezone,
          language: profile.language,
          agent_name: profile.agent_name,
        });
      }, {
        name: "get_user_preferences",
        description: "Returns the current user preferences and agent configuration.",
        schema: z.object({}),
      })
    );
  }

  if (isToolAvailable("list_enabled_tools", ctx)) {
    tools.push(
      tool(async () => {
        const enabled = ctx.enabledTools.filter((t) => t.enabled).map((t) => t.tool_id);
        return JSON.stringify(enabled);
      }, {
        name: "list_enabled_tools",
        description: "Lists all tools the user has currently enabled.",
        schema: z.object({}),
      })
    );
  }

  if (isToolAvailable("github_list_repos", ctx)) {
    tools.push(
      tool(async (input) => executeImmediateTool("github_list_repos", input, ctx), {
        name: "github_list_repos",
        description: "Lists the user's GitHub repositories.",
        schema: githubListReposSchema,
      })
    );
  }

  if (isToolAvailable("github_list_issues", ctx)) {
    tools.push(
      tool(async (input) => executeImmediateTool("github_list_issues", input, ctx), {
        name: "github_list_issues",
        description: "Lists issues for a given repository.",
        schema: githubListIssuesSchema,
      })
    );
  }

  if (isToolAvailable("github_create_issue", ctx)) {
    tools.push(
      tool(async (input) => executeImmediateTool("github_create_issue", input, ctx), {
        name: "github_create_issue",
        description: "Creates a new issue in a GitHub repository. Requires confirmation.",
        schema: githubCreateIssueSchema,
      })
    );
  }

  if (isToolAvailable("github_create_repo", ctx)) {
    tools.push(
      tool(async (input) => executeImmediateTool("github_create_repo", input, ctx), {
        name: "github_create_repo",
        description: "Creates a new GitHub repository. Requires confirmation.",
        schema: githubCreateRepoSchema,
      })
    );
  }

  if (isToolAvailable("contacts_lookup", ctx)) {
    tools.push(
      tool(async (input) => executeImmediateTool("contacts_lookup", input, ctx), {
        name: "contacts_lookup",
        description:
          "Searches Google Contacts by name to find email addresses. Use before creating calendar events when attendee emails are not provided.",
        schema: contactsLookupSchema,
      })
    );
  }

  if (isToolAvailable("calendar_check_availability", ctx)) {
    tools.push(
      tool(async (input) => executeImmediateTool("calendar_check_availability", input, ctx), {
        name: "calendar_check_availability",
        description:
          "Checks the user's Google Calendar availability for a given time range. Returns busy periods.",
        schema: calendarCheckAvailabilitySchema,
      })
    );
  }

  if (isToolAvailable("calendar_list_events", ctx)) {
    tools.push(
      tool(async (input) => executeImmediateTool("calendar_list_events", input, ctx), {
        name: "calendar_list_events",
        description: "Lists upcoming events from the user's Google Calendar within a time range.",
        schema: calendarListEventsSchema,
      })
    );
  }

  if (isToolAvailable("calendar_create_event", ctx)) {
    tools.push(
      tool(async (input) => executeImmediateTool("calendar_create_event", input, ctx), {
        name: "calendar_create_event",
        description: "Creates a new event in the user's Google Calendar. Requires confirmation.",
        schema: calendarCreateEventSchema,
      })
    );
  }

  return tools;
}