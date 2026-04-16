import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient } from "@agents/db";
import { runAgent } from "@agents/agent";
import { loadAgentRuntimeContext } from "@/lib/agent-runtime";
import {
  closeActiveSessionsWithMemoryFlush,
  getOrCreateSessionWithMemoryFlush,
} from "@/lib/session-memory";
import {
  injectAgendaPreferenceDirective,
  injectBashContinuation,
  injectFileContinuation,
  injectScheduledTaskReferenceContinuation,
  injectScheduledTaskDirective,
  injectSchedulingDirective,
  injectSchedulingContinuation,
  injectDateContext,
  rejectAllPendingConfirmations,
  resolveDateReferences,
  REJECTION_RE,
  SESSION_CLOSE_RE,
} from "@/lib/message-preprocessing";

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { message } = await request.json();
    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Message required" }, { status: 400 });
    }

    const db = createServerClient();
    const runtime = await loadAgentRuntimeContext(db, user.id);

    // Use the service-role db client for all session operations so they always
    // succeed regardless of user-auth token state or RLS edge cases.
    const session = await getOrCreateSessionWithMemoryFlush(db, user.id, "web");
    if (!session) {
      return NextResponse.json({ error: "Failed to create session" }, { status: 500 });
    }

    // If the user is rejecting, check two cases:
    // 1. There is a pending tool call confirmation → cancel it.
    // 2. The last assistant message was proposing scheduling → treat as rejection.
    // In both cases close ALL active sessions so the LLM starts fresh.
    if (REJECTION_RE.test(message.trim())) {
      const cancelled = await rejectAllPendingConfirmations(db, session.id);

      const { data: lastMsg } = await db
        .from("agent_messages")
        .select("content")
        .eq("session_id", session.id)
        .eq("role", "assistant")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const lastContent = (lastMsg?.content as string) ?? "";
      const SCHEDULING_PROPOSAL_RE =
        /agendar|agenda|crear el evento|proceder|programar|¿deseas|deseas proceder|¿te gustaría/i;
      const wasSchedulingProposal = SCHEDULING_PROPOSAL_RE.test(lastContent);

      if (cancelled > 0 || wasSchedulingProposal) {
        await closeActiveSessionsWithMemoryFlush(db, user.id, "web");
        const reply = "Entendido, ¿en qué más puedo ayudarte?";
        return NextResponse.json({ response: reply });
      }
    }

    if (SESSION_CLOSE_RE.test(message.trim())) {
      await closeActiveSessionsWithMemoryFlush(db, user.id, "web");
      return NextResponse.json({ response: "Entendido, cierro esta conversación por ahora. Cuando quieras seguimos." });
    }

    // Preprocessing pipeline (order matters):
    // 1. Resolve day names to ISO dates (pure text, no DB)
    // 2. Scheduling continuation has highest priority — if it modifies the text,
    //    skip date-context and directive injection to avoid double directives.
    // 3. Only when NOT in an active scheduling flow: inject date context (for
    //    availability follow-ups) and the first-message scheduling directive.
    let processedMessage = injectAgendaPreferenceDirective(message);
    processedMessage = resolveDateReferences(processedMessage, runtime.timezone);
    const afterContinuation = await injectSchedulingContinuation(db, session.id, processedMessage);
    if (afterContinuation !== processedMessage) {
      // Active scheduling flow — continuation directive takes precedence
      processedMessage = afterContinuation;
    } else {
      const afterBashContinuation = await injectBashContinuation(db, session.id, processedMessage);
      if (afterBashContinuation !== processedMessage) {
        processedMessage = afterBashContinuation;
      } else {
        const afterFileContinuation = await injectFileContinuation(db, session.id, processedMessage);
        if (afterFileContinuation !== processedMessage) {
          processedMessage = afterFileContinuation;
        } else {
          const afterTaskReference = await injectScheduledTaskReferenceContinuation(
            db,
            session.id,
            processedMessage
          );
          if (afterTaskReference !== processedMessage) {
            processedMessage = afterTaskReference;
          } else {
            // No active special flow — apply availability date context then directive
            processedMessage = injectScheduledTaskDirective(processedMessage);
            processedMessage = await injectDateContext(db, session.id, processedMessage, runtime.timezone);
            processedMessage = injectSchedulingDirective(processedMessage);
          }
        }
      }
    }

    const result = await runAgent({
      message: processedMessage,
      userId: user.id,
      sessionId: session.id,
      systemPrompt: runtime.systemPrompt,
      db,
      enabledTools: runtime.enabledTools,
      integrations: runtime.integrations,
      integrationSecrets: runtime.integrationSecrets,
    });

    const normalizedResponse =
      typeof result.response === "string" && result.response.trim().length > 0
        ? result.response.trim()
        : "No pude completar la solicitud con suficiente claridad. Intenta reformularla con más detalle.";

    return NextResponse.json({
      response: normalizedResponse,
      pendingConfirmation: result.pendingConfirmation,
      toolCalls: result.toolCalls,
    });
  } catch (error) {
    console.error("Chat API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
