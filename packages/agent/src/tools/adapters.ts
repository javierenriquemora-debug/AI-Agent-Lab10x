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
}

export interface ToolContext {
  db: DbClient;
  userId: string;
  sessionId: string;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  integrationSecrets?: IntegrationSecrets;
}

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

async function executeImmediateTool(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const record = await createToolCall(ctx.db, ctx.sessionId, toolName, input, false);

  try {
    const result = await executeGithubTool(toolName, input, ctx);
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
    const result = await executeGithubTool(toolCall.tool_name, toolCall.arguments_json, ctx);
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

  return tools;
}
