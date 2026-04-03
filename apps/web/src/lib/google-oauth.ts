const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/contacts.readonly",
];

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

export interface GoogleRefreshResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

function requireGoogleEnv() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing Google OAuth environment variables");
  }

  return { clientId, clientSecret };
}

export function getGoogleRedirectUri(request: Request): string {
  const configured = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (configured) {
    return configured;
  }

  const url = new URL(request.url);
  return `${url.origin}/api/integrations/google/callback`;
}

export function getGoogleAuthorizeUrl(request: Request, state: string): string {
  const { clientId } = requireGoogleEnv();
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", getGoogleRedirectUri(request));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export async function exchangeGoogleCode(
  request: Request,
  code: string
): Promise<GoogleTokenResponse> {
  const { clientId, clientSecret } = requireGoogleEnv();

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: getGoogleRedirectUri(request),
      grant_type: "authorization_code",
    }),
  });

  const data = (await response.json()) as GoogleTokenResponse & {
    error?: string;
    error_description?: string;
  };

  if (!response.ok || data.error || !data.access_token) {
    throw new Error(data.error_description ?? data.error ?? "Google token exchange failed");
  }

  return data;
}

export async function refreshGoogleToken(refreshToken: string): Promise<GoogleRefreshResponse> {
  const { clientId, clientSecret } = requireGoogleEnv();

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });

  const data = (await response.json()) as GoogleRefreshResponse & {
    error?: string;
    error_description?: string;
  };

  if (!response.ok || data.error || !data.access_token) {
    throw new Error(data.error_description ?? data.error ?? "Google token refresh failed");
  }

  return data;
}
