const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_SCOPES = ["repo"];

export interface GitHubTokenResponse {
  access_token: string;
  scope?: string;
  token_type: string;
}

export interface GitHubUser {
  id: number;
  login: string;
}

function requireGithubEnv() {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing GitHub OAuth environment variables");
  }

  return { clientId, clientSecret };
}

export function getGithubRedirectUri(request: Request): string {
  const configured = process.env.GITHUB_REDIRECT_URI?.trim();
  if (configured) {
    return configured;
  }

  const url = new URL(request.url);
  return `${url.origin}/api/integrations/github/callback`;
}

export function getGithubAuthorizeUrl(request: Request, state: string): string {
  const { clientId } = requireGithubEnv();
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", getGithubRedirectUri(request));
  url.searchParams.set("scope", GITHUB_SCOPES.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

export function parseGithubScopes(scopeValue: string | undefined): string[] {
  if (!scopeValue) {
    return [];
  }

  return scopeValue
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

export async function exchangeGithubCode(
  request: Request,
  code: string
): Promise<GitHubTokenResponse> {
  const { clientId, clientSecret } = requireGithubEnv();

  const response = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "agents-web",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: getGithubRedirectUri(request),
    }),
  });

  const data = (await response.json()) as GitHubTokenResponse & {
    error?: string;
    error_description?: string;
  };

  if (!response.ok || data.error || !data.access_token) {
    throw new Error(data.error_description || data.error || "GitHub token exchange failed");
  }

  return data;
}

export async function getGithubUser(token: string): Promise<GitHubUser> {
  const response = await fetch(`${GITHUB_API_BASE_URL}/user`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "agents-web",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error("Failed to fetch GitHub user profile");
  }

  return (await response.json()) as GitHubUser;
}
