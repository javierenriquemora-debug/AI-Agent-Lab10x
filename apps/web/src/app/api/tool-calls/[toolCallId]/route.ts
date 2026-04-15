import { NextResponse } from "next/server";
import {
  addMessage,
  approveToolCall,
  createServerClient,
  getToolCallById,
  rejectToolCall,
} from "@agents/db";
import { resumeAgent } from "@agents/agent";
import { createClient } from "@/lib/supabase/server";
import { loadAgentRuntimeContext } from "@/lib/agent-runtime";
import {
  closeActiveSessionsWithMemoryFlush,
  closeSessionWithMemoryFlush,
} from "@/lib/session-memory";

interface RequestBody {
  action?: "approve" | "reject";
}

function getCheckpointThreadId(args: Record<string, unknown> | null | undefined): string | undefined {
  const value = args?.__checkpoint_thread_id;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ toolCallId: string }> }
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { toolCallId } = await context.params;
  const { action } = (await request.json()) as RequestBody;
  if (action !== "approve" && action !== "reject") {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  const db = createServerClient();
  const toolCall = await getToolCallById(db, toolCallId);

  if (!toolCall) {
    return NextResponse.json({ error: "Tool call not found" }, { status: 404 });
  }

  const { data: session } = await db
    .from("agent_sessions")
    .select("id")
    .eq("id", toolCall.session_id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (action === "reject") {
    const rejectedToolCall = await rejectToolCall(db, toolCallId);
    if (!rejectedToolCall) {
      return NextResponse.json({ error: "Tool call already processed" }, { status: 409 });
    }

    try {
      const runtime = await loadAgentRuntimeContext(db, user.id);
      const result = await resumeAgent(
        {
          message: "",
          db,
          userId: user.id,
          sessionId: rejectedToolCall.session_id,
          checkpointThreadId: getCheckpointThreadId(rejectedToolCall.arguments_json),
          systemPrompt: runtime.systemPrompt,
          enabledTools: runtime.enabledTools,
          integrations: runtime.integrations,
          integrationSecrets: runtime.integrationSecrets,
        },
        { type: "reject", message: "Acción cancelada por el usuario." }
      );

      if (toolCall.tool_name === "calendar_create_event") {
        await closeActiveSessionsWithMemoryFlush(db, user.id, "web");
      }

      return NextResponse.json({
        ok: true,
        message: result.response ?? "Acción cancelada.",
        pendingConfirmation: result.pendingConfirmation,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo procesar la acción.";
      await addMessage(db, rejectedToolCall.session_id, "assistant", message);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  const approvedToolCall = await approveToolCall(db, toolCallId);
  if (!approvedToolCall) {
    return NextResponse.json({ error: "Tool call already processed" }, { status: 409 });
  }

  try {
    const runtime = await loadAgentRuntimeContext(db, user.id);
    const result = await resumeAgent(
      {
        message: "",
        db,
        userId: user.id,
        sessionId: approvedToolCall.session_id,
        checkpointThreadId: getCheckpointThreadId(approvedToolCall.arguments_json),
        systemPrompt: runtime.systemPrompt,
        enabledTools: runtime.enabledTools,
        integrations: runtime.integrations,
        integrationSecrets: runtime.integrationSecrets,
      },
      { type: "approve", toolCallId }
    );
    if (toolCall.tool_name === "calendar_create_event" && !result.pendingConfirmation) {
      await closeSessionWithMemoryFlush(db, approvedToolCall.session_id);
    }
    return NextResponse.json({
      ok: true,
      message: result.response,
      pendingConfirmation: result.pendingConfirmation,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo ejecutar la acción.";
    await addMessage(db, approvedToolCall.session_id, "assistant", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
