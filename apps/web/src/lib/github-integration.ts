import type { DbClient } from "@agents/db";
import { decryptOAuthPayload, encryptOAuthPayload } from "./oauth-crypto";

export interface StoredGithubTokens {
  access_token: string;
  token_type: string;
  scope: string;
  github_login?: string;
  github_user_id?: number;
  created_at: string;
}

export interface GitHubIntegrationSecret {
  accessToken: string;
  tokenType: string;
  scopes: string[];
  login?: string;
  userId?: number;
}

export function encryptGithubTokens(tokens: StoredGithubTokens): string {
  return encryptOAuthPayload(tokens as unknown as Record<string, unknown>);
}

export function decryptGithubTokens(encryptedTokens: string): StoredGithubTokens {
  return decryptOAuthPayload<StoredGithubTokens>(encryptedTokens);
}

export async function getGitHubIntegrationSecret(
  db: DbClient,
  userId: string
): Promise<GitHubIntegrationSecret | null> {
  const { data, error } = await db
    .from("user_integrations")
    .select("encrypted_tokens, scopes, status")
    .eq("user_id", userId)
    .eq("provider", "github")
    .eq("status", "active")
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data?.encrypted_tokens) {
    return null;
  }

  const decrypted = decryptGithubTokens(data.encrypted_tokens);

  return {
    accessToken: decrypted.access_token,
    tokenType: decrypted.token_type,
    scopes: (data.scopes as string[] | null) ?? [],
    login: decrypted.github_login,
    userId: decrypted.github_user_id,
  };
}
