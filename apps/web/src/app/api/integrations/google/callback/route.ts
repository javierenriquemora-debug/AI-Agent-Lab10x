import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient } from "@agents/db";
import { exchangeGoogleCode } from "@/lib/google-oauth";
import { encryptGoogleTokens } from "@/lib/google-integration";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  const origin = new URL(request.url).origin;
  const storedState = request.cookies.get("google_oauth_state")?.value;

  if (error) {
    return NextResponse.redirect(`${origin}/settings?error=google_denied`);
  }

  if (!code || !state || !storedState || state !== storedState) {
    return NextResponse.redirect(`${origin}/settings?error=google_state_mismatch`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(`${origin}/login`);
  }

  const db = createServerClient();

  let tokens;
  try {
    tokens = await exchangeGoogleCode(request, code);
  } catch {
    return NextResponse.redirect(`${origin}/settings?error=google_token_exchange`);
  }

  if (!tokens.refresh_token) {
    return NextResponse.redirect(`${origin}/settings?error=google_no_refresh_token`);
  }

  const storedTokens = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
    token_type: tokens.token_type,
    scope: tokens.scope ?? "",
  };

  const encryptedTokens = encryptGoogleTokens(storedTokens);
  const scopes = storedTokens.scope.split(/\s+/).filter(Boolean);

  await db.from("user_integrations").upsert(
    {
      user_id: user.id,
      provider: "google",
      status: "active",
      encrypted_tokens: encryptedTokens,
      scopes,
    },
    { onConflict: "user_id,provider" }
  );

  const response = NextResponse.redirect(`${origin}/settings?connected=google`);
  response.cookies.delete("google_oauth_state");
  return response;
}
