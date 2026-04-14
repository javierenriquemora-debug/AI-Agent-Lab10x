import { NextResponse } from "next/server";
import {
  addMessage,
  approveToolCall,
  createServerClient,
  rejectToolCall,
} from "@agents/db";
import { resumeAgent, runAgent } from "@agents/agent";
import { loadAgentRuntimeContext } from "@/lib/agent-runtime";
import { sendTelegramMessage } from "@/lib/telegram-bot";
import {
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
} from "@/lib/message-preprocessing";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";

interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string };
    chat: { id: number };
    text?: string;
    voice?: TelegramVoice;
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message: { chat: { id: number }; message_id: number };
    data: string;
  };
}

function getCheckpointThreadId(args: Record<string, unknown> | null | undefined): string | undefined {
  const value = args?.__checkpoint_thread_id;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}


/** Telegram sends "/cmd@BotName args" when the user picks a command from the menu. */
function parseBotCommand(messageText: string): { command: string; args: string } {
  const trimmed = messageText.trim();
  const i = trimmed.indexOf(" ");
  const head = i === -1 ? trimmed : trimmed.slice(0, i);
  const tail = i === -1 ? "" : trimmed.slice(i + 1).trim();
  const at = head.indexOf("@");
  const command = (at === -1 ? head : head.slice(0, at)).toLowerCase();
  return { command, args: tail };
}

async function answerCallbackQuery(callbackQueryId: string, text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

async function transcribeVoice(fileId: string): Promise<string> {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not configured for voice transcription.");
  }

  // Step 1: Get the file path from Telegram
  const fileRes = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`
  );
  const fileData = (await fileRes.json()) as { ok: boolean; result?: { file_path?: string } };

  if (!fileData.ok || !fileData.result?.file_path) {
    throw new Error("Failed to get file path from Telegram.");
  }

  // Step 2: Download the audio file
  const audioRes = await fetch(
    `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileData.result.file_path}`
  );
  if (!audioRes.ok) {
    throw new Error("Failed to download voice file from Telegram.");
  }

  const audioBuffer = await audioRes.arrayBuffer();
  const audioBase64 = Buffer.from(audioBuffer).toString("base64");

  // Step 3: Transcribe with Gemini Flash (multimodal)
  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                inline_data: {
                  mime_type: "audio/ogg",
                  data: audioBase64,
                },
              },
              {
                text: "Transcribe exactamente lo que dice este audio. Devuelve solo el texto transcrito, sin explicaciones ni comentarios adicionales.",
              },
            ],
          },
        ],
      }),
    }
  );

  if (!geminiRes.ok) {
    const err = await geminiRes.text();
    throw new Error(`Gemini transcription failed: ${geminiRes.status} ${err}`);
  }

  const geminiData = (await geminiRes.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };

  const transcript = geminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
  return transcript;
}


export async function POST(request: Request) {
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const update: TelegramUpdate = await request.json();
  const db = createServerClient();

  // Handle callback queries (confirmation buttons)
  if (update.callback_query) {
    const cb = update.callback_query;
    const [action, toolCallId] = cb.data.split(":");

    const { data: telegramAccount } = await db
      .from("telegram_accounts")
      .select("*")
      .eq("telegram_user_id", cb.from.id)
      .single();

    if (!telegramAccount) {
      await answerCallbackQuery(cb.id, "No autorizado");
      return NextResponse.json({ ok: true });
    }

    if (action === "approve" && toolCallId) {
      const approvedToolCall = await approveToolCall(db, toolCallId);
      if (!approvedToolCall) {
        await answerCallbackQuery(cb.id, "Esta acción ya fue procesada.");
        return NextResponse.json({ ok: true });
      }

      await answerCallbackQuery(cb.id, "Aprobado");
      await sendTelegramMessage(
        cb.message.chat.id,
        approvedToolCall.tool_name === "bash"
          ? "Ejecutando el comando aprobado..."
          : "Procesando la acción aprobada..."
      );

      try {
        const runtime = await loadAgentRuntimeContext(db, telegramAccount.user_id);
        const result = await resumeAgent(
          {
            message: "",
            db,
            userId: telegramAccount.user_id,
            sessionId: approvedToolCall.session_id,
            checkpointThreadId: getCheckpointThreadId(approvedToolCall.arguments_json),
            systemPrompt: runtime.systemPrompt,
            enabledTools: runtime.enabledTools,
            integrations: runtime.integrations,
            integrationSecrets: runtime.integrationSecrets,
          },
          { type: "approve", toolCallId }
        );

        if (result.pendingConfirmation) {
          await sendTelegramMessage(cb.message.chat.id, result.pendingConfirmation.message, {
            inline_keyboard: [[
              { text: "Aprobar", callback_data: `approve:${result.pendingConfirmation.toolCallId}` },
              { text: "Cancelar", callback_data: `reject:${result.pendingConfirmation.toolCallId}` },
            ]],
          });
        } else if (result.response) {
          await sendTelegramMessage(cb.message.chat.id, result.response);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "No se pudo ejecutar la acción.";
        await addMessage(db, approvedToolCall.session_id, "assistant", message);
        await sendTelegramMessage(cb.message.chat.id, message);
      }
    } else if (action === "reject" && toolCallId) {
      const rejectedToolCall = await rejectToolCall(db, toolCallId);
      if (!rejectedToolCall) {
        await answerCallbackQuery(cb.id, "Esta acción ya fue procesada.");
        return NextResponse.json({ ok: true });
      }

      await answerCallbackQuery(cb.id, "Rechazado");
      try {
        const runtime = await loadAgentRuntimeContext(db, telegramAccount.user_id);
        const result = await resumeAgent(
          {
            message: "",
            db,
            userId: telegramAccount.user_id,
            sessionId: rejectedToolCall.session_id,
            checkpointThreadId: getCheckpointThreadId(rejectedToolCall.arguments_json),
            systemPrompt: runtime.systemPrompt,
            enabledTools: runtime.enabledTools,
            integrations: runtime.integrations,
            integrationSecrets: runtime.integrationSecrets,
          },
          { type: "reject", message: "Acción cancelada por el usuario." }
        );

        if (result.pendingConfirmation) {
          await sendTelegramMessage(cb.message.chat.id, result.pendingConfirmation.message, {
            inline_keyboard: [[
              { text: "Aprobar", callback_data: `approve:${result.pendingConfirmation.toolCallId}` },
              { text: "Cancelar", callback_data: `reject:${result.pendingConfirmation.toolCallId}` },
            ]],
          });
        } else {
          await sendTelegramMessage(cb.message.chat.id, result.response ?? "Acción cancelada.");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "No se pudo procesar la acción.";
        await addMessage(db, rejectedToolCall.session_id, "assistant", message);
        await sendTelegramMessage(cb.message.chat.id, message);
      }
    }

    return NextResponse.json({ ok: true });
  }

  const message = update.message;
  if (!message?.text && !message?.voice) {
    return NextResponse.json({ ok: true });
  }

  const telegramUserId = message.from.id;
  const chatId = message.chat.id;

  let text: string;

  if (message.voice) {
    try {
      text = await transcribeVoice(message.voice.file_id);
      if (!text) {
        await sendTelegramMessage(chatId, "No pude transcribir tu mensaje de voz. Intenta de nuevo.");
        return NextResponse.json({ ok: true });
      }
      await sendTelegramMessage(chatId, `🎤 <i>${text}</i>`);
    } catch (err) {
      console.error("Voice transcription error:", err);
      await sendTelegramMessage(chatId, "Hubo un error transcribiendo tu voz. Intenta de nuevo.");
      return NextResponse.json({ ok: true });
    }
  } else {
    text = message.text!.trim();
  }

  const { command, args } = parseBotCommand(text);


  // Handle /start (/start@BotName optional)
  if (command === "/start") {
    await sendTelegramMessage(
      chatId,
      "¡Hola! Soy tu agente personal.\n\nSi ya tienes cuenta web, ve a Ajustes → Telegram en la web, genera un código de vinculación y envíamelo así:\n/link TU_CODIGO"
    );
    return NextResponse.json({ ok: true });
  }

  // Handle /link CODE (/link@BotName CODE when chosen from the command list)
  if (command === "/link") {
    const code = args.trim().toUpperCase();
    if (!code) {
      await sendTelegramMessage(
        chatId,
        "Indica el código que generaste en la web, por ejemplo:\n/link ABC123"
      );
      return NextResponse.json({ ok: true });
    }

    const { data: linkRecord } = await db
      .from("telegram_link_codes")
      .select("*")
      .eq("code", code)
      .eq("used", false)
      .gt("expires_at", new Date().toISOString())
      .single();

    if (!linkRecord) {
      await sendTelegramMessage(chatId, "Código inválido o expirado. Genera uno nuevo desde la web.");
      return NextResponse.json({ ok: true });
    }

    await db.from("telegram_accounts").upsert(
      {
        user_id: linkRecord.user_id,
        telegram_user_id: telegramUserId,
        chat_id: chatId,
        linked_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

    await db
      .from("telegram_link_codes")
      .update({ used: true })
      .eq("id", linkRecord.id);

    await sendTelegramMessage(chatId, "¡Cuenta vinculada correctamente! Ya puedes chatear conmigo.");
    return NextResponse.json({ ok: true });
  }

  // Resolve user from telegram_user_id
  const { data: telegramAccount } = await db
    .from("telegram_accounts")
    .select("*")
    .eq("telegram_user_id", telegramUserId)
    .single();

  if (!telegramAccount) {
    await sendTelegramMessage(
      chatId,
      "No tienes una cuenta vinculada. Usa /link TU_CODIGO (código desde Ajustes en la web)."
    );
    return NextResponse.json({ ok: true });
  }

  const userId = telegramAccount.user_id;

  // Get or create session
  let session = await db
    .from("agent_sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("channel", "telegram")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
    .then((r) => r.data);

  if (!session) {
    const { data } = await db
      .from("agent_sessions")
      .insert({
        user_id: userId,
        channel: "telegram",
        status: "active",
        budget_tokens_used: 0,
        budget_tokens_limit: 100000,
      })
      .select()
      .single();
    session = data;
  }

  if (!session) {
    await sendTelegramMessage(chatId, "Error interno creando sesión.");
    return NextResponse.json({ ok: true });
  }

  // If the user is rejecting, check two cases:
  // 1. There is a pending tool call confirmation → cancel it.
  // 2. The last assistant message was proposing scheduling → treat as rejection.
  // In both cases close ALL active sessions so the LLM starts fresh.
  if (REJECTION_RE.test(text.trim())) {
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
      await db
        .from("agent_sessions")
        .update({ status: "closed" })
        .eq("user_id", telegramAccount.user_id)
        .eq("channel", "telegram")
        .eq("status", "active");
      const reply = "Entendido, ¿en qué más puedo ayudarte?";
      await sendTelegramMessage(chatId, reply);
      return NextResponse.json({ ok: true });
    }
  }

  const runtime = await loadAgentRuntimeContext(db, userId);

  // Preprocessing pipeline — same order as web chat route:
  // 1. Resolve day names to ISO dates (pure text, no DB)
  // 2. Scheduling continuation has highest priority — if it modifies the text,
  //    skip date-context and directive injection to avoid double directives.
  // 3. Only when NOT in an active scheduling flow: inject date context (for
  //    availability follow-ups) and the first-message scheduling directive.
  text = resolveDateReferences(text, runtime.timezone);
  const afterContinuation = await injectSchedulingContinuation(db, session.id, text);
  if (afterContinuation !== text) {
    text = afterContinuation;
  } else {
    const afterBashContinuation = await injectBashContinuation(db, session.id, text);
    if (afterBashContinuation !== text) {
      text = afterBashContinuation;
    } else {
      const afterFileContinuation = await injectFileContinuation(db, session.id, text);
      if (afterFileContinuation !== text) {
        text = afterFileContinuation;
      } else {
        const afterTaskReference = await injectScheduledTaskReferenceContinuation(
          db,
          session.id,
          text
        );
        if (afterTaskReference !== text) {
          text = afterTaskReference;
        } else {
          text = injectScheduledTaskDirective(text);
          text = await injectDateContext(db, session.id, text, runtime.timezone);
          text = injectSchedulingDirective(text);
        }
      }
    }
  }

  try {
    const result = await runAgent({
      message: text,
      userId,
      sessionId: session.id,
      systemPrompt: runtime.systemPrompt,
      db,
      enabledTools: runtime.enabledTools,
      integrations: runtime.integrations,
      integrationSecrets: runtime.integrationSecrets,
    });

    if (result.pendingConfirmation) {
      await sendTelegramMessage(chatId, result.pendingConfirmation.message, {
        inline_keyboard: [
          [
            {
              text: "Aprobar",
              callback_data: `approve:${result.pendingConfirmation.toolCallId}`,
            },
            {
              text: "Cancelar",
              callback_data: `reject:${result.pendingConfirmation.toolCallId}`,
            },
          ],
        ],
      });
    } else if (result.response) {
      await sendTelegramMessage(chatId, result.response);
    } else {
      await sendTelegramMessage(
        chatId,
        "No pude completar la solicitud con suficiente claridad. Intenta reformularla con más detalle."
      );
    }
  } catch (error) {
    console.error("Telegram agent error:", error);
    await sendTelegramMessage(chatId, "Hubo un error procesando tu mensaje. Intenta de nuevo.");
  }

  return NextResponse.json({ ok: true });
}
