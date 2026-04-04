import { NextResponse } from "next/server";
import {
  addMessage,
  approveToolCall,
  createServerClient,
  getToolCallById,
  rejectToolCall,
} from "@agents/db";
import { executeToolCallById } from "@agents/agent";
import { createClient } from "@/lib/supabase/server";
import { loadAgentRuntimeContext } from "@/lib/agent-runtime";

interface RequestBody {
  action?: "approve" | "reject";
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

    // Close ALL active web sessions for this user so the next message starts
    // with a clean context and cannot re-trigger the cancelled scheduling flow.
    await db
      .from("agent_sessions")
      .update({ status: "closed" })
      .eq("user_id", user.id)
      .eq("channel", "web")
      .eq("status", "active");

    return NextResponse.json({ ok: true, message: "Acción cancelada." });
  }

  const approvedToolCall = await approveToolCall(db, toolCallId);
  if (!approvedToolCall) {
    return NextResponse.json({ error: "Tool call already processed" }, { status: 409 });
  }

  try {
    const runtime = await loadAgentRuntimeContext(db, user.id);
    const execution = await executeToolCallById(
      {
        db,
        userId: user.id,
        sessionId: approvedToolCall.session_id,
        enabledTools: runtime.enabledTools,
        integrations: runtime.integrations,
        integrationSecrets: runtime.integrationSecrets,
      },
      toolCallId
    );

    await addMessage(db, approvedToolCall.session_id, "assistant", execution.result.message);
    return NextResponse.json({ ok: true, message: execution.result.message });
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo ejecutar la acción.";
    await addMessage(db, approvedToolCall.session_id, "assistant", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
