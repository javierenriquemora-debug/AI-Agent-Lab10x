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
    id: "read_file",
    name: "read_file",
    description:
      "Reads a text file inside the repository. Use it when you need to inspect an existing file before making decisions. It returns numbered lines and metadata about the slice that was read.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path or path relative to the repository root of the file to read",
        },
        offset: {
          type: "number",
          description: "Optional line offset. Positive values start at line 1; negative values count from the end",
        },
        limit: {
          type: "number",
          description: "Optional maximum number of lines to return",
        },
      },
      required: ["path"],
    },
  },
  {
    id: "write_file",
    name: "write_file",
    description:
      "Creates a new text file inside the repository. Use it only when the target file does not exist yet. It returns the created path plus the number of characters and bytes written, or a clear error if the file already exists or the parent folder is missing.",
    risk: "medium",
    parameters_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path or path relative to the repository root of the new file to create",
        },
        content: {
          type: "string",
          description: "Full text content that will be written into the new file",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    id: "edit_file",
    name: "edit_file",
    description:
      "Edits an existing text file by replacing one exact and unique string. Use it for precise changes when you know the current text to replace. It returns the edited path and number of replacements, or a clear error if the text is missing or ambiguous.",
    risk: "medium",
    parameters_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path or path relative to the repository root of the file to edit",
        },
        old_string: {
          type: "string",
          description: "Exact existing text to replace. It must appear exactly once in the file",
        },
        new_string: {
          type: "string",
          description: "Replacement text that will be written in place of old_string",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    id: "create_scheduled_task",
    name: "create_scheduled_task",
    description:
      "Creates a scheduled task that will re-run a natural-language prompt later through the agent. Use it for reminders, recurring follow-ups and deferred automations. It stores the prompt, first execution time, recurrence and delivery channel.",
    risk: "medium",
    parameters_schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Natural-language instruction that the agent must execute when the task becomes due",
        },
        schedule_type: {
          type: "string",
          enum: ["one_time", "recurring"],
          description: "Whether the task runs once or repeats",
        },
        run_at: {
          type: "string",
          description: "First execution datetime in ISO 8601 format with timezone offset",
        },
        recurrence: {
          type: "string",
          enum: ["daily", "weekly", "monthly"],
          description: "Required only when schedule_type is recurring",
        },
        timezone: {
          type: "string",
          description: "IANA timezone to interpret and describe the schedule. Defaults to America/Bogota",
        },
        channel: {
          type: "string",
          enum: ["telegram"],
          description: "Delivery channel for the scheduled execution. Defaults to telegram",
        },
      },
      required: ["prompt", "schedule_type", "run_at"],
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
          description:
            "Start of the first range in ISO 8601 format with timezone offset (e.g. 2026-04-08T08:00:00-05:00)",
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
