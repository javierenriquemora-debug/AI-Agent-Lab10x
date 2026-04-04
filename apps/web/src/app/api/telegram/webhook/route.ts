import { NextResponse } from "next/server";
import {
  addMessage,
  approveToolCall,
  createServerClient,
  rejectToolCall,
} from "@agents/db";
import { executeToolCallById, runAgent } from "@agents/agent";
import { loadAgentRuntimeContext } from "@/lib/agent-runtime";
import {
  injectSchedulingDirective,
  injectSchedulingContinuation,
  rejectAllPendingConfirmations,
  markdownToHtml,
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


async function sendTelegramMessage(
  chatId: number,
  text: string,
  replyMarkup?: Record<string, unknown>
) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: markdownToHtml(text),
      parse_mode: "HTML",
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("Telegram sendMessage failed:", res.status, body);
  }
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
  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) {
    throw new Error("OPENAI_API_KEY is not configured for voice transcription.");
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
  const audioBlob = new Blob([audioBuffer], { type: "audio/ogg" });

  // Step 3: Transcribe with OpenAI Whisper
  const formData = new FormData();
  formData.append("file", audioBlob, "voice.ogg");
  formData.append("model", "whisper-1");

  const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${openaiApiKey}` },
    body: formData,
  });

  if (!whisperRes.ok) {
    const err = await whisperRes.text();
    throw new Error(`Whisper transcription failed: ${whisperRes.status} ${err}`);
  }

  const whisperData = (await whisperRes.json()) as { text?: string };
  return whisperData.text?.trim() ?? "";
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

      try {
        const runtime = await loadAgentRuntimeContext(db, telegramAccount.user_id);
        const execution = await executeToolCallById(
          {
            db,
            userId: telegramAccount.user_id,
            sessionId: approvedToolCall.session_id,
            enabledTools: runtime.enabledTools,
            integrations: runtime.integrations,
            integrationSecrets: runtime.integrationSecrets,
          },
          toolCallId
        );

        await addMessage(db, approvedToolCall.session_id, "assistant", execution.result.message);
        await sendTelegramMessage(cb.message.chat.id, execution.result.message);
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

      await addMessage(db, rejectedToolCall.session_id, "assistant", "Acción cancelada.");
      await answerCallbackQuery(cb.id, "Rechazado");
      await sendTelegramMessage(cb.message.chat.id, "Acción cancelada.");
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

  text = injectSchedulingDirective(text);

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

  // If we're in a scheduling conversation, enrich the message with context
  text = await injectSchedulingContinuation(db, session.id, text);

  const runtime = await loadAgentRuntimeContext(db, userId);

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
    }
  } catch (error) {
    console.error("Telegram agent error:", error);
    await sendTelegramMessage(chatId, "Hubo un error procesando tu mensaje. Intenta de nuevo.");
  }

  return NextResponse.json({ ok: true });
}
