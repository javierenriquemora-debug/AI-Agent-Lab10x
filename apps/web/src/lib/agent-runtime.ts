import type { IntegrationSecrets } from "@agents/agent";
import type { UserIntegration, UserToolSetting } from "@agents/types";
import type { DbClient } from "@agents/db";
import { getGitHubIntegrationSecret } from "./github-integration";

export interface AgentRuntimeContext {
  systemPrompt: string;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  integrationSecrets: IntegrationSecrets;
}

export async function loadAgentRuntimeContext(
  db: DbClient,
  userId: string
): Promise<AgentRuntimeContext> {
  const { data: profile } = await db
    .from("profiles")
    .select("agent_system_prompt")
    .eq("id", userId)
    .single();

  const { data: toolSettings } = await db
    .from("user_tool_settings")
    .select("*")
    .eq("user_id", userId);

  const { data: integrations } = await db
    .from("user_integrations")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active");

  const github = await getGitHubIntegrationSecret(db, userId);

  return {
    systemPrompt: profile?.agent_system_prompt ?? "Eres un asistente útil.",
    enabledTools: (toolSettings ?? []).map((t: Record<string, unknown>) => ({
      id: t.id as string,
      user_id: t.user_id as string,
      tool_id: t.tool_id as string,
      enabled: t.enabled as boolean,
      config_json: (t.config_json as Record<string, unknown>) ?? {},
    })),
    integrations: (integrations ?? []).map((i: Record<string, unknown>) => ({
      id: i.id as string,
      user_id: i.user_id as string,
      provider: i.provider as string,
      scopes: (i.scopes as string[]) ?? [],
      status: i.status as "active" | "revoked" | "expired",
      created_at: i.created_at as string,
    })),
    integrationSecrets: {
      github,
    },
  };
}
