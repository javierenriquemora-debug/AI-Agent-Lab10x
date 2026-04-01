const GITHUB_API_BASE_URL = "https://api.github.com";

export interface GitHubAuthContext {
  accessToken: string;
}

interface GitHubRepository {
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  description: string | null;
}

interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  html_url: string;
}

function getGithubHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "agents-agent",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

async function githubRequest<T>(path: string, init: RequestInit, token: string): Promise<T> {
  const response = await fetch(`${GITHUB_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...getGithubHeaders(token),
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API error (${response.status}): ${body}`);
  }

  return (await response.json()) as T;
}

export async function listGithubRepos(auth: GitHubAuthContext, perPage: number) {
  const repos = await githubRequest<GitHubRepository[]>(
    `/user/repos?sort=updated&direction=desc&per_page=${perPage}`,
    { method: "GET" },
    auth.accessToken
  );

  return {
    repos: repos.map((repo) => ({
      name: repo.name,
      full_name: repo.full_name,
      private: repo.private,
      url: repo.html_url,
      description: repo.description,
    })),
  };
}

export async function listGithubIssues(
  auth: GitHubAuthContext,
  owner: string,
  repo: string,
  state: "open" | "closed" | "all"
) {
  const issues = await githubRequest<GitHubIssue[]>(
    `/repos/${owner}/${repo}/issues?state=${state}`,
    { method: "GET" },
    auth.accessToken
  );

  return {
    issues: issues
      .filter((issue) => !("pull_request" in issue))
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        url: issue.html_url,
      })),
  };
}

export async function createGithubIssue(
  auth: GitHubAuthContext,
  owner: string,
  repo: string,
  title: string,
  body: string
) {
  const issue = await githubRequest<GitHubIssue>(
    `/repos/${owner}/${repo}/issues`,
    {
      method: "POST",
      body: JSON.stringify({ title, body }),
    },
    auth.accessToken
  );

  return {
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    state: issue.state,
  };
}

export async function createGithubRepository(
  auth: GitHubAuthContext,
  name: string,
  description: string,
  isPrivate: boolean
) {
  const repo = await githubRequest<GitHubRepository>(
    "/user/repos",
    {
      method: "POST",
      body: JSON.stringify({
        name,
        description,
        private: isPrivate,
      }),
    },
    auth.accessToken
  );

  return {
    name: repo.name,
    full_name: repo.full_name,
    private: repo.private,
    url: repo.html_url,
    description: repo.description,
  };
}
