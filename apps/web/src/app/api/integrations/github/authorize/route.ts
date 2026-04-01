import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getGithubAuthorizeUrl } from "@/lib/github-oauth";

const GITHUB_STATE_COOKIE = "github_oauth_state";

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const origin = new URL(request.url).origin;
  if (!user) {
    return NextResponse.redirect(`${origin}/login?error=github_auth_required`);
  }

  const state = randomUUID();
  const redirectUrl = getGithubAuthorizeUrl(request, state);
  const response = NextResponse.redirect(redirectUrl);

  response.cookies.set(GITHUB_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 10,
    path: "/",
  });

  return response;
}
