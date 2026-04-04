import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { DbClient } from "@agents/db";
import type { ToolCall, UserIntegration, UserToolSetting } from "@agents/types";
import { TOOL_CATALOG, toolRequiresConfirmation } from "./catalog";
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

export interface PendingConfirmation {
  toolCallId: string;
  toolName: string;
  message: string;
}

interface ToolExecutionResult {
  message: string;
  [key: string]: unknown;
}

interface PendingToolExecutionResult {
  __type: "pending_confirmation";
  pendingConfirmation: PendingConfirmation;
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

function toPendingToolResult(pendingConfirmation: PendingConfirmation): string {
  return JSON.stringify({
    __type: "pending_confirmation",
    pendingConfirmation,
  } satisfies PendingToolExecutionResult);
}

export function getPendingConfirmationFromToolResult(result: unknown): PendingConfirmation | null {
  if (typeof result !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(result) as PendingToolExecutionResult;
    if (parsed.__type === "pending_confirmation" && parsed.pendingConfirmation?.toolCallId) {
      return parsed.pendingConfirmation;
    }
  } catch {
    return null;
  }

  return null;
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
        return { name: r.query, found: false, emails: [] as string[], resolvedEmail: null as string | null, message: `No se encontro "${r.query}" en los contactos.` };
      }
      if (r.totalFound === 1) {
        return { name: r.found[0].name, found: true, emails: r.found[0].emails, resolvedEmail: r.found[0].emails[0], message: `${r.found[0].name}: ${r.found[0].emails[0]}` };
      }
      return {
        name: r.query,
        found: true,
        multiple: true,
        emails: r.found.flatMap((c) => c.emails),
        resolvedEmail: null as string | null,
        contacts: r.found.map((c) => ({ name: c.name, email: c.emails[0] })),
        message: `Multiples resultados para "${r.query}": ${r.found.map((c) => `${c.name} (${c.emails[0]})`).join(", ")}. Confirma cual es el correcto.`,
      };
    });

    const resolved = summary.filter((s) => s.found && s.resolvedEmail).map((s) => `${s.name}: ${s.resolvedEmail}`);
    const notFound = summary.filter((s) => !s.found).map((s) => s.name);
    const needsConfirm = summary.filter((s) => s.found && !s.resolvedEmail).map((s) => s.message);

    let message = "";
    if (resolved.length > 0) message += `Emails resueltos:\n${resolved.map((r) => `- ${r}`).join("\n")}\n`;
    if (needsConfirm.length > 0) message += `\nAmbiguos (pide confirmacion):\n${needsConfirm.join("\n")}\n`;
    if (notFound.length > 0) message += `\nNo encontrados: ${notFound.join(", ")}. Pide su email al usuario.\n`;
    message += `\nIMPORTANTE: Al crear el evento incluye TODOS los emails resueltos: ${summary.filter((s) => s.resolvedEmail).map((s) => s.resolvedEmail).join(", ")}`;

    return { message: message.trim(), contacts: summary };
  }

  if (toolName === "calendar_check_availability") {
    const input = calendarCheckAvailabilitySchema.parse(rawInput);

    const allRanges = [
      { time_min: input.time_min, time_max: input.time_max },
      ...(input.extra_ranges ?? []),
    ];

    const results = await Promise.all(
      allRanges.map((r) => checkCalendarAvailability(google, r.time_min, r.time_max))
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

function routeToolExecution(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolExecutionResult> {
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

async function createPendingConfirmation(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const record = await createToolCall(ctx.db, ctx.sessionId, toolName, input, true);

  if (toolName === "github_create_issue") {
    const parsed = githubCreateIssueSchema.parse(input);
    return toPendingToolResult({
      toolCallId: record.id,
      toolName,
      message: `Confirma si deseas crear el issue "${parsed.title}" en ${parsed.owner}/${parsed.repo}.`,
    });
  }

  if (toolName === "github_create_repo") {
    const parsed = githubCreateRepoSchema.parse(input);
    return toPendingToolResult({
      toolCallId: record.id,
      toolName,
      message: `Confirma si deseas crear el repositorio "${parsed.name}".`,
    });
  }

  if (toolName === "calendar_create_event") {
    const parsed = calendarCreateEventSchema.parse(input);
    return toPendingToolResult({
      toolCallId: record.id,
      toolName,
      message: `Confirma si deseas crear el evento "${parsed.summary}" el ${parsed.start_date_time}.`,
    });
  }

  throw new Error(`Pending confirmation is not supported for ${toolName}`);
}

export async function executeToolCallById(
  ctx: ToolContext,
  toolCallId: string
): Promise<{ toolCall: ToolCall; result: ToolExecutionResult }> {
  const toolCall = await getToolCallById(ctx.db, toolCallId);
  if (!toolCall) {
    throw new Error("Tool call not found.");
  }

  if (toolCall.status !== "approved") {
    throw new Error("Tool call is not approved for execution.");
  }

  try {
    const result = await routeToolExecution(toolCall.tool_name, toolCall.arguments_json, ctx);
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
        async (input) => {
          const needsConfirm = toolRequiresConfirmation("github_create_issue");
          if (needsConfirm) {
            return createPendingConfirmation("github_create_issue", input, ctx);
          }
          return executeImmediateTool("github_create_issue", input, ctx);
        },
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
        async (input) => {
          const needsConfirm = toolRequiresConfirmation("github_create_repo");
          if (needsConfirm) {
            return createPendingConfirmation("github_create_repo", input, ctx);
          }
          return executeImmediateTool("github_create_repo", input, ctx);
        },
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
        async (input) => {
          const needsConfirm = toolRequiresConfirmation("calendar_create_event");
          if (needsConfirm) {
            return createPendingConfirmation("calendar_create_event", input, ctx);
          }
          return executeImmediateTool("calendar_create_event", input, ctx);
        },
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
