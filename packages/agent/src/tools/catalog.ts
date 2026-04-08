import type { ToolDefinition, ToolRisk } from "@agents/types";

export const TOOL_CATALOG: ToolDefinition[] = [
  {
    id: "get_user_preferences",
    name: "get_user_preferences",
    description: "Returns the current user preferences and agent configuration.",
    risk: "low",
    parameters_schema: { type: "object", properties: {}, required: [] },
  },
  {
    id: "list_enabled_tools",
    name: "list_enabled_tools",
    description: "Lists all tools the user has currently enabled.",
    risk: "low",
    parameters_schema: { type: "object", properties: {}, required: [] },
  },
  {
    id: "bash",
    name: "bash",
    description:
      'Executes system commands in a persistent terminal session identified by name and returns the terminal text output. If terminal is omitted, use "default". The real shell depends on the host OS.',
    risk: "high",
    parameters_schema: {
      type: "object",
      properties: {
        terminal: {
          type: "string",
          description: 'Persistent terminal session name to reuse or create. Defaults to "default"',
        },
        prompt: {
          type: "string",
          description: "Command text to execute inside the selected terminal session",
        },
      },
      required: ["prompt"],
    },
  },
  {
    id: "github_list_repos",
    name: "github_list_repos",
    description: "Lists the user's GitHub repositories.",
    risk: "low",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        per_page: { type: "number", description: "Results per page (max 30)" },
      },
      required: [],
    },
  },
  {
    id: "github_list_issues",
    name: "github_list_issues",
    description: "Lists issues for a given repository.",
    risk: "low",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        state: { type: "string", enum: ["open", "closed", "all"] },
      },
      required: ["owner", "repo"],
    },
  },
  {
    id: "github_create_issue",
    name: "github_create_issue",
    description: "Creates a new issue in a GitHub repository. Requires confirmation.",
    risk: "medium",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    id: "github_create_repo",
    name: "github_create_repo",
    description: "Creates a new GitHub repository. Requires confirmation.",
    risk: "medium",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        private: { type: "boolean" },
      },
      required: ["name"],
    },
  },
  {
    id: "contacts_lookup",
    name: "contacts_lookup",
    description:
      "Searches the user's Google Contacts by name to find email addresses. Use this before creating calendar events when attendee emails are not provided. Supports searching multiple names at once.",
    risk: "low",
    requires_integration: "google",
    parameters_schema: {
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          description: "List of person names to search for (one search per name)",
        },
      },
      required: ["names"],
    },
  },
  {
    id: "calendar_check_availability",
    name: "calendar_check_availability",
    description:
      "Checks the user's Google Calendar availability for one or more time ranges. Returns free and busy slots in local time. Use extra_ranges to check multiple windows in a single call (e.g. 8-12 and 14-18).",
    risk: "low",
    requires_integration: "google",
    parameters_schema: {
      type: "object",
      properties: {
        time_min: {
          type: "string",
          description: "Start of the first range in ISO 8601 format with timezone offset (e.g. 2026-04-08T08:00:00-05:00)",
        },
        time_max: {
          type: "string",
          description: "End of the first range in ISO 8601 format with timezone offset",
        },
        extra_ranges: {
          type: "array",
          description: "Additional time ranges to check in the same query",
          items: {
            type: "object",
            properties: {
              time_min: { type: "string" },
              time_max: { type: "string" },
            },
            required: ["time_min", "time_max"],
          },
        },
      },
      required: ["time_min", "time_max"],
    },
  },
  {
    id: "calendar_list_events",
    name: "calendar_list_events",
    description: "Lists upcoming events from the user's Google Calendar within a time range.",
    risk: "low",
    requires_integration: "google",
    parameters_schema: {
      type: "object",
      properties: {
        time_min: {
          type: "string",
          description: "Start of the range in ISO 8601 format",
        },
        time_max: {
          type: "string",
          description: "End of the range in ISO 8601 format",
        },
        max_results: {
          type: "number",
          description: "Maximum number of events to return (default 20)",
        },
      },
      required: ["time_min", "time_max"],
    },
  },
  {
    id: "calendar_create_event",
    name: "calendar_create_event",
    description:
      "Creates a new event in the user's Google Calendar. Requires confirmation.",
    risk: "medium",
    requires_integration: "google",
    parameters_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Event title" },
        start_date_time: {
          type: "string",
          description: "Start date/time in ISO 8601 format",
        },
        end_date_time: {
          type: "string",
          description: "End date/time in ISO 8601 format",
        },
        description: { type: "string", description: "Event description (optional)" },
        location: { type: "string", description: "Event location (optional)" },
        time_zone: {
          type: "string",
          description: "IANA timezone (e.g. America/Bogota). Defaults to UTC.",
        },
        attendee_emails: {
          type: "array",
          items: { type: "string" },
          description: "List of attendee email addresses to invite",
        },
      },
      required: ["summary", "start_date_time", "end_date_time"],
    },
  },
];

export function getToolRisk(toolId: string): ToolRisk {
  return TOOL_CATALOG.find((t) => t.id === toolId)?.risk ?? "high";
}

export function toolRequiresConfirmation(toolId: string): boolean {
  const risk = getToolRisk(toolId);
  return risk === "medium" || risk === "high";
}
