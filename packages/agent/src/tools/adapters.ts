import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { DbClient } from "@agents/db";
import type { ToolCall, UserIntegration, UserToolSetting } from "@agents/types";
import { TOOL_CATALOG } from "./catalog";
import { createToolCall, getToolCallById, updateToolCallStatus } from "@agents/db";
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
  attendee_emails: z.array(z.string()).optional().default([]).describe("List of attendee email addresses"),
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

function isToolAvailable(
  toolId: string,
  ctx: ToolContext
): boolean {
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
        return { name: r.query, found: false, emails: [] as string[], resolvedEmail: null as string | null, multiple: false, contacts: [] as { name: string; email: string }[] };
      }
      if (r.totalFound === 1) {
        return { name: r.found[0].name, found: true, multiple: false, emails: r.found[0].emails, resolvedEmail: r.found[0].emails[0], contacts: [{ name: r.found[0].name, email: r.found[0].emails[0] }] };
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
        // Multiple results — list all of them. The system prompt rules decide whether
        // to ask the user to pick one (scheduling flow) or just display all (informational).
        const list = s.contacts.map((c, i) => `${i + 1}. ${c.name} - ${c.email}`).join("\n");
        message += `Múltiples resultados para "${s.name}":\n${list}\n`;
      }
    }

    const resolvedEmails = summary.filter((s) => s.resolvedEmail).map((s) => s.resolvedEmail);
    if (resolvedEmails.length > 0) {
      message += `\nIMPORTANTE: Al crear el evento incluye TODOS los emails resueltos: ${resolvedEmails.join(", ")}`;
    }

    return { message: message.trim(), contacts: summary };
  }

  if (toolName === "calendar_check_availability") {
    const input = calendarCheckAvailabilitySchema.parse(rawInput);

    // Normalize an ISO string to the user's local timezone while preserving the
    // actual requested time (not expanding to full day). This corrects off-by-hours
    // errors when the LLM sends UTC times, while still respecting time windows like "2pm-6pm".
    const getLocalOffset = (tz: string): string => {
      const offsetRaw = new Date().toLocaleString("en-US", { timeZone: tz, timeZoneName: "shortOffset" })
        .match(/GMT([+-]\d+(?::\d+)?)/)?.[1] ?? "-5";
      const sign = offsetRaw.startsWith("-") ? "-" : "+";
      const [h, m = "0"] = offsetRaw.replace(/[+-]/, "").split(":");
      return `${sign}${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
    };

    const normalizeToLocalTime = (isoStr: string, tz: string): string => {
      const offset = getLocalOffset(tz);
      // Date-only strings (YYYY-MM-DD) must be treated as midnight local, not UTC midnight.
      if (/^\d{4}-\d{2}-\d{2}$/.test(isoStr)) return `${isoStr}T00:00:00${offset}`;
      const date = new Date(isoStr);
      const localDate = date.toLocaleDateString("en-CA", { timeZone: tz }); // "YYYY-MM-DD"
      const [hh, mm, ss] = date.toLocaleTimeString("en-US", {
        timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
      }).split(":").map((v) => v.padStart(2, "0"));
      return `${localDate}T${hh}:${mm}:${ss}${offset}`;
    };

    const normalizedMin = normalizeToLocalTime(input.time_min, google.timeZone);
    const normalizedMax = normalizeToLocalTime(input.time_max, google.timeZone);
    const extraRanges = (input.extra_ranges ?? []).map((r) => ({
      time_min: normalizeToLocalTime(r.time_min, google.timeZone),
      time_max: normalizeToLocalTime(r.time_max, google.timeZone),
    }));

    const allRanges = [
      { time_min: normalizedMin, time_max: normalizedMax },
      ...extraRanges,
    ];

    const results = await Promise.all(
      allRanges.map((r) => checkCalendarAvailability(google, r.time_min, r.time_max, ["primary"]))
    );

    const combined = results.map((r, i) => ({
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
    const result = await listCalendarEvents(google, input.time_min, input.time_max, input.max_results);
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
      parsed.prompt.length > 160
        ? `${parsed.prompt.slice(0, 160)}...`
        : parsed.prompt;
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

  return {
    toolName,
    input,
    message: `Confirma si deseas ejecutar la acción "${toolName}".`,
    allowedDecisions: ["approve", "reject"],
  };
}

export async function createPendingToolCallRecord(
  ctx: ToolContext,
  review: PendingToolReview
): Promise<PendingConfirmation> {
  const record = await createToolCall(ctx.db, ctx.sessionId, review.toolName, review.input, true);
  return {
    toolCallId: record.id,
    toolName: review.toolName,
    message: review.message,
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
      tool(
        async (input) => executeImmediateTool("bash", input, ctx),
        {
          name: "bash",
          description:
            "Executes system commands in a persistent terminal session identified by name and returns the terminal text output. The real shell depends on the host OS.",
          schema: bashToolSchema,
        }
      )
    );
  }

  if (isToolAvailable("get_user_preferences", ctx)) {
    tools.push(
      tool(
        async () => {
          const { getProfile } = await import("@agents/db");
          const profile = await getProfile(ctx.db, ctx.userId);
          return JSON.stringify({
            name: profile.name,
            timezone: profile.timezone,
            language: profile.language,
            agent_name: profile.agent_name,
          });
        },
        {
          name: "get_user_preferences",
          description: "Returns the current user preferences and agent configuration.",
          schema: z.object({}),
        }
      )
    );
  }

  if (isToolAvailable("list_enabled_tools", ctx)) {
    tools.push(
      tool(
        async () => {
          const enabled = ctx.enabledTools
            .filter((t) => t.enabled)
            .map((t) => t.tool_id);
          return JSON.stringify(enabled);
        },
        {
          name: "list_enabled_tools",
          description: "Lists all tools the user has currently enabled.",
          schema: z.object({}),
        }
      )
    );
  }

  if (isToolAvailable("github_list_repos", ctx)) {
    tools.push(
      tool(
        async (input) => executeImmediateTool("github_list_repos", input, ctx),
        {
          name: "github_list_repos",
          description: "Lists the user's GitHub repositories.",
          schema: githubListReposSchema,
        }
      )
    );
  }

  if (isToolAvailable("github_list_issues", ctx)) {
    tools.push(
      tool(
        async (input) => executeImmediateTool("github_list_issues", input, ctx),
        {
          name: "github_list_issues",
          description: "Lists issues for a given repository.",
          schema: githubListIssuesSchema,
        }
      )
    );
  }

  if (isToolAvailable("github_create_issue", ctx)) {
    tools.push(
      tool(
        async (input) => executeImmediateTool("github_create_issue", input, ctx),
        {
          name: "github_create_issue",
          description: "Creates a new issue in a GitHub repository. Requires confirmation.",
          schema: githubCreateIssueSchema,
        }
      )
    );
  }

  if (isToolAvailable("github_create_repo", ctx)) {
    tools.push(
      tool(
        async (input) => executeImmediateTool("github_create_repo", input, ctx),
        {
          name: "github_create_repo",
          description: "Creates a new GitHub repository. Requires confirmation.",
          schema: githubCreateRepoSchema,
        }
      )
    );
  }

  if (isToolAvailable("contacts_lookup", ctx)) {
    tools.push(
      tool(
        async (input) => executeImmediateTool("contacts_lookup", input, ctx),
        {
          name: "contacts_lookup",
          description:
            "Searches Google Contacts by name to find email addresses. Use before creating calendar events when attendee emails are not provided.",
          schema: contactsLookupSchema,
        }
      )
    );
  }

  if (isToolAvailable("calendar_check_availability", ctx)) {
    tools.push(
      tool(
        async (input) => executeImmediateTool("calendar_check_availability", input, ctx),
        {
          name: "calendar_check_availability",
          description:
            "Checks the user's Google Calendar availability for a given time range. Returns busy periods.",
          schema: calendarCheckAvailabilitySchema,
        }
      )
    );
  }

  if (isToolAvailable("calendar_list_events", ctx)) {
    tools.push(
      tool(
        async (input) => executeImmediateTool("calendar_list_events", input, ctx),
        {
          name: "calendar_list_events",
          description: "Lists upcoming events from the user's Google Calendar within a time range.",
          schema: calendarListEventsSchema,
        }
      )
    );
  }

  if (isToolAvailable("calendar_create_event", ctx)) {
    tools.push(
      tool(
        async (input) => executeImmediateTool("calendar_create_event", input, ctx),
        {
          name: "calendar_create_event",
          description:
            "Creates a new event in the user's Google Calendar. Requires confirmation.",
          schema: calendarCreateEventSchema,
        }
      )
    );
  }

  return tools;
}
