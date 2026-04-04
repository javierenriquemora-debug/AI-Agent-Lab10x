import type { DbClient } from "@agents/db";
export { formatMessageToHtml as markdownToHtml } from "./format-message";

/**
 * Cancels ALL pending tool call confirmations for a session.
 * Returns the number of calls that were cancelled.
 */
export async function rejectAllPendingConfirmations(
  db: DbClient,
  sessionId: string
): Promise<number> {
  const { data: pendingCalls } = await db
    .from("tool_calls")
    .select("id")
    .eq("session_id", sessionId)
    .eq("status", "pending_confirmation");

  if (!pendingCalls || pendingCalls.length === 0) return 0;

  await db
    .from("tool_calls")
    .update({ status: "rejected", finished_at: new Date().toISOString() })
    .eq("session_id", sessionId)
    .eq("status", "pending_confirmation");

  return pendingCalls.length;
}

// ─── Regex constants ────────────────────────────────────────────────────────

export const SCHEDULE_INTENT_RE =
  /\b(agenda|agendar|programa|programar|crea(r)?\s+(un\s+)?(evento|reuni[oó]n|espacio|cita)|reuni[oó]n|meeting)\b/i;

export const HOUR_REF_RE =
  /\b(a las\s+\d|am\b|pm\b|\d{1,2}:\d{2}|\d{1,2}\s*(am|pm))/i;

export const DAY_REF_RE =
  /\b(ma[ñn]ana|hoy|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|pr[oó]ximo|siguiente|\d{1,2}\s+de\s+[a-z]+)/i;

export const EMAIL_RE = /[\w.+-]+@[\w.-]+\.\w{2,}/;

/** Requires a real name (≥2 chars per word) after "con/invita" — avoids "con el / para el" */
export const PERSON_NAME_RE =
  /\b(con|invita?)\s+[a-záéíóúñA-ZÁÉÍÓÚÑ]{2,}(\s+[a-záéíóúñA-ZÁÉÍÓÚÑ]{2,})?/i;

export const SUBJECT_MARKER_RE =
  /\b(asunto|tema|sobre|acerca|revisar|revisión|presentación|propuesta|seguimiento|discutir|entrevista|capacitación|call de|sync de)\b/i;

export const SCHEDULING_FLOW_RE =
  /Para agendar necesito|Fecha y hora de inicio|asunto de la reuni|¿Cuál es el asunto|¿A qué hora|¿Cuándo|¿Con quién|hora de la reuni|fecha prefieres|qué fecha|qué día|hora de inicio|¿Cuál es la fecha|proporcionarme el (email|correo)|completar el agendamiento|para agendar|para completar/i;

/**
 * Detects when the user is ASKING about a contact/email rather than providing one.
 * e.g. "cual es el correo de X", "sabes el email de Y", "qué correo tiene Z"
 */
export const CONTACT_QUESTION_RE =
  /\b(cu[aá]l\s+es|sabes|tienes|qu[eé]\s+correo|qu[eé]\s+email|cu[aá]l\s+es\s+el\s+(correo|email))\b/i;

/**
 * Detects when the assistant was presenting a list of contact options to choose from.
 * When this was the last assistant message, a user reply is selecting a contact — not scheduling.
 */
export const CONTACT_OPTIONS_RE =
  /He encontrado múltiples|¿Cuál deseas usar|cuál es el correo correcto|confirma cuál|múltiples contactos|múltiples correos/i;

/**
 * Detects clear rejection of a pending action.
 * Matches short negative answers and explicit cancellation phrases.
 */
export const REJECTION_RE =
  /^(no|nop|nope|nel)$|no\s+(quiero|proceder|crear|agendar|gracias)|cancelar?|cancela(r|do)?|olvida(r|lo)?|d[eé]jalo|no\s+lo\s+hagas|no\s+proceed/i;

// ─── Scheduling directive injection ──────────────────────────────────────────

/**
 * If the message contains scheduling intent + date/time + participant,
 * prepends an explicit directive so the model calls the right tools immediately.
 */
export function injectSchedulingDirective(text: string): string {
  const hasScheduleIntent = SCHEDULE_INTENT_RE.test(text);
  const hasEmail = EMAIL_RE.test(text);
  const hasPersonName = PERSON_NAME_RE.test(text);
  const hasHour = HOUR_REF_RE.test(text);
  const hasDay = DAY_REF_RE.test(text);

  if (hasScheduleIntent && hasDay && hasHour && (hasEmail || hasPersonName)) {
    if (hasEmail) {
      return `[AGENDAMIENTO COMPLETO: fecha/hora, asunto y email presentes. Llama calendar_create_event AHORA sin preguntas.]\n\n${text}`;
    }
    return `[AGENDAMIENTO con nombre de persona. Llama contacts_lookup con los nombres detectados, luego calendar_create_event.]\n\n${text}`;
  }

  if (hasScheduleIntent && (hasEmail || hasPersonName)) {
    return `[El usuario quiere agendar y ya mencionó participante(s). Pregunta SOLO la fecha, hora de inicio y el asunto. NO pidas participantes.]\n\n${text}`;
  }

  return text;
}

/**
 * Detects if the current message is a continuation of an active scheduling
 * conversation by reading the session's message history.
 * Injects an explicit directive so the model knows exactly what data it has
 * and what it still needs — regardless of channel (Telegram or web).
 */
/** Matches a cancellation reply saved by the system itself. */
const CANCELLED_REPLY_RE = /ha sido cancelada|solicitud cancelada/i;

export async function injectSchedulingContinuation(
  db: DbClient,
  sessionId: string,
  text: string
): Promise<string> {
  if (SCHEDULE_INTENT_RE.test(text)) return text;

  // ── 1. Pending confirmation (highest priority) ────────────────────────────
  const { data: pendingCalls } = await db
    .from("tool_calls")
    .select("id, tool_name")
    .eq("session_id", sessionId)
    .eq("status", "pending_confirmation")
    .limit(1);

  if (pendingCalls && pendingCalls.length > 0) {
    const instruction = CONTACT_QUESTION_RE.test(text)
      ? `El usuario pregunta sobre un contacto: "${text}". Respóndela con contacts_lookup. NO llames calendar_create_event.`
      : `El usuario escribió: "${text}". Responde su mensaje. NO llames calendar_create_event de nuevo.`;
    return (
      `[CONFIRMACIÓN PENDIENTE para "${pendingCalls[0].tool_name}". ` +
      `${instruction} ` +
      `Al terminar, recuérdale que tiene una confirmación pendiente.]\n\n${text}`
    );
  }

  // ── 2. Read message history (needed for all remaining checks) ─────────────
  const { data: messages } = await db
    .from("agent_messages")
    .select("role, content")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(10);

  if (!messages || messages.length === 0) return text;

  const lastAssistant = messages.find((m) => m.role === "assistant");
  const lastAssistantContent = (lastAssistant?.content as string) ?? "";

  // ── 3. Contact-selection guard ───────────────────────────────────────────
  // If the last assistant message was presenting contact options, the user is
  // selecting a contact — NOT requesting an event. Inject an explicit block so
  // the LLM confirms the selection without calling calendar_create_event.
  if (CONTACT_OPTIONS_RE.test(lastAssistantContent)) {
    return (
      `[El usuario está eligiendo un contacto de la lista presentada. ` +
      `Confirma cuál eligió y pregunta si desea hacer algo más. ` +
      `NO llames calendar_create_event a menos que el usuario lo pida explícitamente ahora.]\n\n${text}`
    );
  }

  // ── 4. Post-cancellation guard ───────────────────────────────────────────
  // If the last assistant message was our own cancellation reply, the scheduling
  // flow is closed. Inject a clear "no active flow" directive so the LLM does
  // NOT use the stale scheduling context still present in the conversation history.
  if (CANCELLED_REPLY_RE.test(lastAssistantContent)) {
    if (CONTACT_QUESTION_RE.test(text)) {
      return (
        `[NO hay flujo de agendamiento activo (fue cancelado). ` +
        `El usuario hace una pregunta sobre un contacto. Respóndela con contacts_lookup. ` +
        `NO llames calendar_create_event.]\n\n${text}`
      );
    }
    // For any other message after cancellation, explicitly close the flow
    return `[NO hay flujo de agendamiento activo (fue cancelado). Responde normalmente.]\n\n${text}`;
  }

  // ── 5. Not in a scheduling flow → safe to pass through ───────────────────
  if (!SCHEDULING_FLOW_RE.test(lastAssistantContent)) {
    // Contact question outside any flow — no directive needed
    if (CONTACT_QUESTION_RE.test(text)) return text;
    return text;
  }

  // ── 6. Active scheduling flow ────────────────────────────────────────────
  // Contact question inside an active flow: answer it but don't create the event
  if (CONTACT_QUESTION_RE.test(text)) {
    return (
      `[FLUJO DE AGENDAMIENTO ACTIVO. El usuario hace una pregunta sobre un contacto: "${text}". ` +
      `Respóndela usando contacts_lookup. NO llames calendar_create_event todavía.]\n\n${text}`
    );
  }

  // Find the start of the current scheduling flow
  const chronological = [...messages].reverse();
  let flowStartIdx = -1;
  for (let i = chronological.length - 1; i >= 0; i--) {
    const m = chronological[i];
    const raw = (m.content as string).replace(/^\[[\s\S]*?\]\n\n/, "");
    if (m.role === "user" && SCHEDULE_INTENT_RE.test(raw)) {
      flowStartIdx = i;
      break;
    }
  }

  if (flowStartIdx === -1) return text;

  const flowMessages = chronological.slice(flowStartIdx);
  const flowUserContents = flowMessages
    .filter((m) => m.role === "user")
    .map((m) => (m.content as string).replace(/^\[[\s\S]*?\]\n\n/, ""));

  const prevUserSummary = flowUserContents
    .map((c, i) => `  ${i + 1}. "${c}"`)
    .join("\n");

  const flowAssistantContents = flowMessages
    .filter((m) => m.role === "assistant")
    .map((m) => m.content as string);

  const allFlowEmails = new Set<string>();
  const emailExtractRE = /[\w.+-]+@[\w.-]+\.\w{2,}/g;
  for (const content of [...flowUserContents, text, ...flowAssistantContents]) {
    const found = content.match(emailExtractRE) ?? [];
    found.forEach((e) => allFlowEmails.add(e));
  }

  const flowContent = [...flowUserContents, text].join(" ");
  const hasParticipant = PERSON_NAME_RE.test(flowContent) || allFlowEmails.size > 0;
  const hasDay = DAY_REF_RE.test(flowContent);
  const hasHour = HOUR_REF_RE.test(flowContent);

  const lastAgentWasAskingSubject =
    /asunto|tema|motivo|de qué (es|trata|será)/i.test(lastAssistantContent);
  const currentIsEmail = EMAIL_RE.test(text);
  const currentIsDateTime = DAY_REF_RE.test(text) || HOUR_REF_RE.test(text);
  const hasSubject =
    SUBJECT_MARKER_RE.test(flowContent) ||
    (lastAgentWasAskingSubject && !currentIsEmail && !currentIsDateTime);

  const missing: string[] = [];
  if (!hasParticipant) missing.push("👤 Participantes (nombre o correo)");
  if (!hasDay) missing.push("📅 Fecha (día)");
  if (!hasHour) missing.push("🕐 Hora de inicio");
  if (!hasSubject) missing.push("📋 Asunto de la reunión");

  if (missing.length === 0) {
    const emailsList = [...allFlowEmails].join(", ");
    return (
      `[CONTINUACIÓN DE AGENDAMIENTO.\n` +
      `Mensajes de este flujo:\n${prevUserSummary}\n` +
      `Mensaje actual: "${text}"\n` +
      `Emails confirmados: ${emailsList}\n` +
      `INSTRUCCIÓN: Ya tienes TODOS los datos. NO llames contacts_lookup de nuevo. ` +
      `Llama calendar_create_event AHORA usando EXACTAMENTE estos emails: [${emailsList}]]\n\n${text}`
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
