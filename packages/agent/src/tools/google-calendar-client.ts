const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

export interface GoogleCalendarAuthContext {
  accessToken: string;
  timeZone: string;
}

export interface CalendarAttendee {
  email: string;
  displayName?: string;
  responseStatus?: "accepted" | "declined" | "tentative" | "needsAction";
  self?: boolean;
}

export interface CalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  location?: string;
  htmlLink?: string;
  attendees?: CalendarAttendee[];
  conferenceData?: { entryPoints?: Array<{ entryPointType: string; uri: string }> };
}

export interface TimePeriod {
  start: string;
  end: string;
}

export interface CheckAvailabilityResult {
  date: string;
  queryRange: { start: string; end: string };
  busy: TimePeriod[];
  free: TimePeriod[];
  hasFreeTime: boolean;
}

export interface ListEventsResult {
  events: CalendarEvent[];
  count: number;
}

export interface CreateEventResult {
  event: CalendarEvent;
  htmlLink: string;
}

function authHeaders(auth: GoogleCalendarAuthContext): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    "Content-Type": "application/json",
  };
}

function formatLocalTime(utcString: string, timeZone: string): string {
  return new Date(utcString).toLocaleTimeString("es-CO", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatLocalDate(utcString: string, timeZone: string): string {
  return new Date(utcString).toLocaleDateString("es-CO", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function computeFreeSlots(
  rangeStartMs: number,
  rangeEndMs: number,
  busyMs: Array<{ start: number; end: number }>
): Array<{ start: number; end: number }> {
  const sorted = [...busyMs].sort((a, b) => a.start - b.start);
  const free: Array<{ start: number; end: number }> = [];
  let cursor = rangeStartMs;

  for (const block of sorted) {
    if (block.start > cursor) {
      free.push({ start: cursor, end: block.start });
    }
    cursor = Math.max(cursor, block.end);
  }

  if (cursor < rangeEndMs) {
    free.push({ start: cursor, end: rangeEndMs });
  }

  return free;
}

export async function checkCalendarAvailability(
  auth: GoogleCalendarAuthContext,
  timeMin: string,
  timeMax: string
): Promise<CheckAvailabilityResult> {
  const response = await fetch(`${CALENDAR_API_BASE}/freeBusy`, {
    method: "POST",
    headers: authHeaders(auth),
    body: JSON.stringify({
      timeMin,
      timeMax,
      timeZone: auth.timeZone,
      items: [{ id: "primary" }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Google Calendar freeBusy failed: ${response.status} ${err}`);
  }

  const data = (await response.json()) as {
    calendars: { primary?: { busy?: Array<{ start: string; end: string }> } };
  };

  const rawBusy = data.calendars?.primary?.busy ?? [];
  const tz = auth.timeZone;

  const busyMs = rawBusy.map((b) => ({
    start: new Date(b.start).getTime(),
    end: new Date(b.end).getTime(),
  }));

  const rangeStartMs = new Date(timeMin).getTime();
  const rangeEndMs = new Date(timeMax).getTime();
  const freeMs = computeFreeSlots(rangeStartMs, rangeEndMs, busyMs);

  const busy = rawBusy.map((b) => ({
    start: formatLocalTime(b.start, tz),
    end: formatLocalTime(b.end, tz),
  }));

  const free = freeMs.map((f) => ({
    start: formatLocalTime(new Date(f.start).toISOString(), tz),
    end: formatLocalTime(new Date(f.end).toISOString(), tz),
  }));

  return {
    date: formatLocalDate(timeMin, tz),
    queryRange: {
      start: formatLocalTime(timeMin, tz),
      end: formatLocalTime(timeMax, tz),
    },
    busy,
    free,
    hasFreeTime: free.length > 0,
  };
}

export async function listCalendarEvents(
  auth: GoogleCalendarAuthContext,
  timeMin: string,
  timeMax: string,
  maxResults = 20
): Promise<ListEventsResult> {
  const params = new URLSearchParams({
    calendarId: "primary",
    timeMin,
    timeMax,
    maxResults: String(maxResults),
    singleEvents: "true",
    orderBy: "startTime",
    timeZone: auth.timeZone,
  });

  const response = await fetch(
    `${CALENDAR_API_BASE}/calendars/primary/events?${params.toString()}`,
    { headers: authHeaders(auth) }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Google Calendar listEvents failed: ${response.status} ${err}`);
  }

  const data = (await response.json()) as { items?: CalendarEvent[] };
  const events = data.items ?? [];

  return { events, count: events.length };
}

export async function createCalendarEvent(
  auth: GoogleCalendarAuthContext,
  summary: string,
  startDateTime: string,
  endDateTime: string,
  description?: string,
  location?: string,
  timeZone?: string,
  attendeeEmails?: string[]
): Promise<CreateEventResult> {
  const tz = timeZone ?? auth.timeZone ?? "UTC";
  const body: Record<string, unknown> = {
    summary,
    start: { dateTime: startDateTime, timeZone: tz },
    end: { dateTime: endDateTime, timeZone: tz },
  };

  if (description) body.description = description;
  if (location) body.location = location;
  if (attendeeEmails?.length) {
    body.attendees = attendeeEmails.map((email) => ({ email: email.trim() }));
  }

  const response = await fetch(`${CALENDAR_API_BASE}/calendars/primary/events`, {
    method: "POST",
    headers: authHeaders(auth),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Google Calendar createEvent failed: ${response.status} ${err}`);
  }

  const event = (await response.json()) as CalendarEvent;

  return {
    event,
    htmlLink: event.htmlLink ?? "",
  };
}
