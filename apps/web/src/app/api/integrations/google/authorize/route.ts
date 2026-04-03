import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getGoogleAuthorizeUrl } from "@/lib/google-oauth";
import { randomBytes } from "crypto";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const origin = new URL(request.url).origin;
  if (!user) {
    return NextResponse.redirect(`${origin}/login?error=google_auth_required`);
  }

  const state = randomBytes(16).toString("hex");
  const authorizeUrl = getGoogleAuthorizeUrl(request, state);

  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set("google_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });

  return response;
}
