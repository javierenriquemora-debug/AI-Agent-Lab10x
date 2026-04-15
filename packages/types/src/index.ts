export type Channel = "web" | "telegram" | "scheduled";

export type ToolRisk = "low" | "medium" | "high";

export interface Profile {
  id: string;
  name: string;
  timezone: string;
  language: string;
  agent_name: string;
  agent_system_prompt: string;
  onboarding_completed: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserIntegration {
  id: string;
  user_id: string;
  provider: string;
  scopes: string[];
  status: "active" | "revoked" | "expired";
  created_at: string;
}

export interface UserToolSetting {
  id: string;
  user_id: string;
  tool_id: string;
  enabled: boolean;
  config_json: Record<string, unknown>;
}

export interface AgentSession {
  id: string;
  user_id: string;
  channel: Channel;
  status: "active" | "closed";
  budget_tokens_used: number;
  budget_tokens_limit: number;
  memory_flushed_at?: string | null;
  memory_last_processed_message_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type MessageRole = "user" | "assistant" | "tool" | "system";

export interface AgentMessage {
  id: string;
  session_id: string;
  role: MessageRole;
  content: string;
  tool_call_id?: string;
  structured_payload?: Record<string, unknown>;
  created_at: string;
}

export interface ToolCall {
  id: string;
  session_id: string;
  tool_name: string;
  arguments_json: Record<string, unknown>;
  result_json?: Record<string, unknown>;
  status: "pending_confirmation" | "approved" | "rejected" | "executed" | "failed";
  requires_confirmation: boolean;
  created_at: string;
  finished_at?: string;
}

export interface TelegramAccount {
  id: string;
  user_id: string;
  telegram_user_id: number;
  chat_id: number;
  linked_at: string;
}

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  risk: ToolRisk;
  requires_integration?: string;
  parameters_schema: Record<string, unknown>;
}

export type ScheduledTaskChannel = "telegram";
export type ScheduledTaskScheduleType = "one_time" | "recurring";
export type ScheduledTaskRecurrence = "daily" | "weekly" | "monthly";
export type ScheduledTaskStatus =
  | "active"
  | "processing"
  | "completed"
  | "failed"
  | "paused"
  | "cancelled";

export interface ScheduledTask {
  id: string;
  user_id: string;
  prompt: string;
  schedule_type: ScheduledTaskScheduleType;
  recurrence: ScheduledTaskRecurrence | null;
  run_at: string;
  next_run_at: string | null;
  timezone: string;
  channel: ScheduledTaskChannel;
  status: ScheduledTaskStatus;
  last_executed_at: string | null;
  last_error: string | null;
  created_via_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export type ScheduledTaskRunStatus = "running" | "succeeded" | "failed";

export interface ScheduledTaskRun {
  id: string;
  scheduled_task_id: string;
  user_id: string;
  status: ScheduledTaskRunStatus;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
  agent_session_id: string | null;
  response_excerpt: string | null;
  triggered_by: "cron" | "manual";
}

export type MemoryType = "episodic" | "semantic" | "procedural";

export interface MemoryRecord {
  id: string;
  user_id: string;
  type: MemoryType;
  content: string;
  retrieval_count: number;
  last_retrieved_at: string | null;
  source_session_id: string | null;
  source_message_start_at: string | null;
  source_message_end_at: string | null;
  dedupe_hash: string;
  created_at: string;
}
