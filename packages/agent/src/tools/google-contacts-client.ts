const PEOPLE_API_BASE = "https://people.googleapis.com/v1";

export interface ContactResult {
  name: string;
  emails: string[];
}

export interface ContactLookupResult {
  query: string;
  found: ContactResult[];
  totalFound: number;
}

export async function searchContacts(
  accessToken: string,
  query: string,
  maxResults = 5
): Promise<ContactLookupResult> {
  const params = new URLSearchParams({
    query,
    pageSize: String(maxResults),
    readMask: "names,emailAddresses",
  });

  const response = await fetch(
    `${PEOPLE_API_BASE}/people:searchContacts?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Google Contacts search failed: ${response.status} ${err}`);
  }

  const data = (await response.json()) as {
    results?: Array<{
      person?: {
        names?: Array<{ displayName?: string }>;
        emailAddresses?: Array<{ value?: string }>;
      };
    }>;
  };

  const found: ContactResult[] = (data.results ?? [])
    .map((r) => {
      const name = r.person?.names?.[0]?.displayName ?? "";
      const emails = (r.person?.emailAddresses ?? [])
        .map((e) => e.value ?? "")
        .filter(Boolean);
      return { name, emails };
    })
    .filter((c) => c.emails.length > 0);

  return {
    query,
    found,
    totalFound: found.length,
  };
}
