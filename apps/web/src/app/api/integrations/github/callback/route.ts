import { NextRequest, NextResponse } from "next/server";
import { createServerClient, upsertIntegration } from "@agents/db";
import { createClient } from "@/lib/supabase/server";
import {
  exchangeGithubCode,
  getGithubUser,
  parseGithubScopes,
} from "@/lib/github-oauth";
import { encryptGithubTokens } from "@/lib/github-integration";

const GITHUB_STATE_COOKIE = "github_oauth_state";

function redirectToSettings(request: Request, status: string) {
  const url = new URL("/settings", request.url);
  url.searchParams.set("github", status);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const response = redirectToSettings(request, "error");
  response.cookies.delete(GITHUB_STATE_COOKIE);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return redirectToSettings(request, "auth_required");
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const storedState = request.cookies.get(GITHUB_STATE_COOKIE)?.value;

  if (!code || !state || !storedState || state !== storedState) {
    return response;
  }

  try {
    const token = await exchangeGithubCode(request, code);
    const githubUser = await getGithubUser(token.access_token);
    const scopes = parseGithubScopes(token.scope);
    const db = createServerClient();

    await upsertIntegration(
      db,
      user.id,
      "github",
      scopes,
      encryptGithubTokens({
        access_token: token.access_token,
        token_type: token.token_type,
        scope: token.scope ?? "",
        github_login: githubUser.login,
        github_user_id: githubUser.id,
        created_at: new Date().toISOString(),
      })
    );

    const successResponse = redirectToSettings(request, "connected");
    successResponse.cookies.delete(GITHUB_STATE_COOKIE);
    return successResponse;
  } catch (error) {
    console.error("GitHub OAuth callback failed:", error);
    return response;
  }
}
