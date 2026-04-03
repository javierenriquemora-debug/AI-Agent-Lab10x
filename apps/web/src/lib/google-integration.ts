import type { DbClient } from "@agents/db";
import { decryptOAuthPayload, encryptOAuthPayload } from "./oauth-crypto";
import { refreshGoogleToken } from "./google-oauth";

export interface StoredGoogleTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp in ms
  token_type: string;
  scope: string;
}

export interface GoogleIntegrationSecret {
  accessToken: string;
  tokenType: string;
  scopes: string[];
  timeZone: string;
}

export function encryptGoogleTokens(tokens: StoredGoogleTokens): string {
  return encryptOAuthPayload(tokens as unknown as Record<string, unknown>);
}

export function decryptGoogleTokens(encryptedTokens: string): StoredGoogleTokens {
  return decryptOAuthPayload<StoredGoogleTokens>(encryptedTokens);
}

/** Returns a valid access token, refreshing automatically if it expires within 5 minutes. */
export async function getGoogleIntegrationSecret(
  db: DbClient,
  userId: string,
  timeZone = "America/Bogota"
): Promise<GoogleIntegrationSecret | null> {
  const { data, error } = await db
    .from("user_integrations")
    .select("id, encrypted_tokens, scopes, status")
    .eq("user_id", userId)
    .eq("provider", "google")
    .eq("status", "active")
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data?.encrypted_tokens) {
    return null;
  }

  let tokens = decryptGoogleTokens(data.encrypted_tokens);

  const fiveMinutesMs = 5 * 60 * 1000;
  const isExpiringSoon = tokens.expires_at - Date.now() < fiveMinutesMs;

  if (isExpiringSoon) {
    const refreshed = await refreshGoogleToken(tokens.refresh_token);
    tokens = {
      ...tokens,
      access_token: refreshed.access_token,
      expires_at: Date.now() + refreshed.expires_in * 1000,
    };

    await db
      .from("user_integrations")
      .update({ encrypted_tokens: encryptGoogleTokens(tokens) })
      .eq("id", data.id);
  }

  return {
    accessToken: tokens.access_token,
    tokenType: tokens.token_type,
    scopes: (data.scopes as string[] | null) ?? [],
    timeZone,
  };
}
