import { NextResponse } from "next/server";
import {
  addMessage,
  approveToolCall,
  createServerClient,
  rejectToolCall,
} from "@agents/db";
import { executeToolCallById, runAgent } from "@agents/agent";
import { loadAgentRuntimeContext } from "@/lib/agent-runtime";
import type { DbClient } from "@agents/db";

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
      text,
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

const SCHEDULE_INTENT_RE = /\b(agenda|agendar|programa|programar|crea(r)?\s+(un\s+)?(evento|reuni[oó]n|espacio|cita)|reuni[oó]n|meeting)\b/i;
// Specific clock time (required to consider time "complete")
const HOUR_REF_RE = /\b(a las\s+\d|am\b|pm\b|\d{1,2}:\d{2}|\d{1,2}\s*(am|pm))/i;
// Day reference only (date without time)
const DAY_REF_RE = /\b(ma[ñn]ana|hoy|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|pr[oó]ximo|siguiente|\d{1,2}\s+de\s+[a-z]+)/i;
// Full datetime = has a day AND a clock time
const FULL_DATETIME_RE = new RegExp(`(${HOUR_REF_RE.source})`, "i");
const EMAIL_RE = /[\w.+-]+@[\w.-]+\.\w{2,}/;
// Requires a real name (2+ chars per word) after "con/invita/para" — avoids "para el"
const PERSON_NAME_RE = /\b(con|invita?)\s+[a-záéíóúñA-ZÁÉÍÓÚÑ]{2,}(\s+[a-záéíóúñA-ZÁÉÍÓÚÑ]{2,})?/i;
// Explicit email is also a participant signal
// Subject markers — words that clearly indicate a meeting subject
const SUBJECT_MARKER_RE = /\b(asunto|tema|sobre|acerca|revisar|revisión|presentación|propuesta|seguimiento|discutir|entrevista|capacitación|call de|sync de)\b/i;

// Patterns that indicate the assistant was collecting scheduling data
const SCHEDULING_FLOW_RE = /Para agendar necesito|Fecha y hora de inicio|asunto de la reuni|¿Cuál es el asunto|¿A qué hora|¿Cuándo|¿Con quién|hora de la reuni|fecha prefieres|qué fecha|qué día|hora de inicio|¿Cuál es la fecha/i;

/**
 * If the message contains scheduling intent + time + (email OR person name),
 * prepend an explicit directive so the model resolves contacts and creates the event.
 */
function injectSchedulingDirective(text: string): string {
  const hasScheduleIntent = SCHEDULE_INTENT_RE.test(text);
  const hasEmail = EMAIL_RE.test(text);
  const hasPersonName = PERSON_NAME_RE.test(text);
  const hasHour = HOUR_REF_RE.test(text);
  const hasDay = DAY_REF_RE.test(text);

  // Full data in one message (needs day + clock hour + participant/email)
  if (hasScheduleIntent && hasDay && hasHour && (hasEmail || hasPersonName)) {
    if (hasEmail) {
      return `[AGENDAMIENTO COMPLETO: fecha/hora, asunto y email presentes. Llama calendar_create_event AHORA sin preguntas.]\n\n${text}`;
    }
    return `[AGENDAMIENTO con nombre de persona. Llama contacts_lookup con los nombres detectados, luego calendar_create_event.]\n\n${text}`;
  }

  // Has intent + participant but no time → ask only for date/time and subject
  if (hasScheduleIntent && (hasEmail || hasPersonName)) {
    return `[El usuario quiere agendar y ya mencionó participante(s). Pregunta SOLO la fecha, hora de inicio y el asunto. NO pidas participantes.]\n\n${text}`;
  }

  return text;
}

/**
 * Detects if the current message is a continuation of a scheduling conversation.
 * Passes the full user message history so the LLM can extract data itself.
 */
async function injectSchedulingContinuation(
  db: DbClient,
  sessionId: string,
  text: string
): Promise<string> {
  // If this message already has scheduling intent, already handled above
  if (SCHEDULE_INTENT_RE.test(text)) return text;

  // Fetch last 10 messages to understand the conversation state
  const { data: messages } = await db
    .from("agent_messages")
    .select("role, content")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(10);

  if (!messages || messages.length === 0) return text;

  // Check if last assistant message was part of a scheduling data collection flow
  const lastAssistant = messages.find((m) => m.role === "assistant");
  const lastAssistantContent = (lastAssistant?.content as string) ?? "";
  if (!SCHEDULING_FLOW_RE.test(lastAssistantContent)) return text;

  // Find the START of the current scheduling flow by locating the most recent
  // user message that contains scheduling intent. Only use messages from that
  // point forward — this prevents data from previous conversations bleeding in.
  const chronological = [...messages].reverse(); // oldest first
  let flowStartIdx = -1;
  for (let i = chronological.length - 1; i >= 0; i--) {
    const m = chronological[i];
    const raw = (m.content as string).replace(/^\[[\s\S]*?\]\n\n/, "");
    if (m.role === "user" && SCHEDULE_INTENT_RE.test(raw)) {
      flowStartIdx = i;
      break;
    }
  }

  if (flowStartIdx === -1) return text; // no scheduling trigger found

  // Only messages from the current flow
  const flowMessages = chronological.slice(flowStartIdx);
  const flowUserContents = flowMessages
    .filter((m) => m.role === "user")
    .map((m) => (m.content as string).replace(/^\[[\s\S]*?\]\n\n/, ""));

  const prevUserSummary = flowUserContents
    .map((c, i) => `  ${i + 1}. "${c}"`)
    .join("\n");

  // What data exists in this flow + current message
  const flowContent = [...flowUserContents, text].join(" ");
  const hasParticipant = PERSON_NAME_RE.test(flowContent) || EMAIL_RE.test(flowContent);
  const hasDay = DAY_REF_RE.test(flowContent);
  const hasHour = HOUR_REF_RE.test(flowContent);

  // Subject: marked known if any message contains a subject keyword,
  // OR if the last agent message was specifically asking for subject
  const lastAgentWasAskingSubject = /asunto|tema|motivo|de qué (es|trata|será)/i.test(lastAssistantContent);
  const hasSubject = SUBJECT_MARKER_RE.test(flowContent) || lastAgentWasAskingSubject;

  const missing: string[] = [];
  if (!hasParticipant) missing.push("👤 Participantes (nombre o correo)");
  if (!hasDay) missing.push("📅 Fecha (día)");
  if (!hasHour) missing.push("🕐 Hora de inicio");
  if (!hasSubject) missing.push("📋 Asunto de la reunión");

  if (missing.length === 0) {
    return (
      `[CONTINUACIÓN DE AGENDAMIENTO.\n` +
      `Mensajes de este flujo:\n${prevUserSummary}\n` +
      `Mensaje actual: "${text}"\n` +
      `INSTRUCCIÓN: Ya tienes TODOS los datos (participante, día, hora y asunto). ` +
      `Llama contacts_lookup si hay nombres sin email, luego calendar_create_event AHORA.]\n\n${text}`
    );
  }

  return (
    `[CONTINUACIÓN DE AGENDAMIENTO.\n` +
    `Mensajes de este flujo:\n${prevUserSummary}\n` +
    `Mensaje actual: "${text}"\n` +
    `INSTRUCCIÓN: Usa SOLO los mensajes de este flujo. ` +
    `Falta recopilar: ${missing.join(", ")}. ` +
    `Pide SOLO el primer dato que falte. NO uses datos de conversaciones anteriores. NO listes servicios.]\n\n${text}`
  );
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
