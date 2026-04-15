import path from "node:path";
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
export const AGENDA_QUERY_RE =
  /\b(c[oó]mo\s+estoy\s+de\s+agenda|mi\s+agenda|qu[eé]\s+tengo\s+en\s+la\s+agenda|qu[eé]\s+tengo\s+ma[ñn]ana|revis[ae]\s+mi\s+agenda|m[ué]strame\s+mi\s+agenda|disponibilidad|espacios\s+disponibles|eventos?\s+de)\b/i;

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
  /Para agendar necesito|Fecha y hora de inicio|asunto de la reuni|¿Cuál es el asunto|¿A qué hora|¿Cuándo|¿Con quién|hora de la reuni|fecha prefieres|qué fecha|qué día|hora de inicio|¿Cuál es la fecha|proporcionarme el (email|correo)|completar el agendamiento|para agendar|para completar|Confirma si deseas|deseas crear el evento|crear el evento|¿Deseas proceder|deseas agendar/i;

/**
 * Detects when the user is ASKING about a contact/email rather than providing one.
 * e.g. "cual es el correo de X", "sabes el email de Y", "qué correo tiene Z",
 *      "y el de X?", "el contacto de X", "dame el correo de X"
 */
export const CONTACT_QUESTION_RE =
  /\b(cu[aá]l\s+es|sabes|tienes|qu[eé]\s+correo|qu[eé]\s+email|cu[aá]l\s+es\s+el\s+(correo|email)|el\s+correo\s+de|el\s+email\s+de|el\s+contacto\s+de|dame\s+el\s+(correo|email)|y\s+el\s+de|y\s+la\s+de)\b/i;

/**
 * Detects when the assistant was presenting a list of contact options to choose from.
 * When this was the last assistant message, a user reply is selecting a contact — not scheduling.
 */
export const CONTACT_OPTIONS_RE =
  /He encontrado múltiples|¿Cuál deseas usar|cuál es el correo correcto|confirma cuál|múltiples contactos|múltiples correos/i;
const CONTACT_SELECTION_REPLY_RE =
  /^(?:\d{1,2}|el primero|la primera|el segundo|la segunda|el tercero|la tercera|ese|esa|la de kikes|la de incusan|la de hotmail)$/i;

/**
 * Detects clear rejection of a pending action.
 * Matches short negative answers and explicit cancellation phrases.
 */
export const REJECTION_RE =
  /^(no|nop|nope|nel)$|no\s+(quiero|proceder|crear|agendar|gracias)|cancelar?|cancela(r|do)?|olvida(r|lo)?|d[eé]jalo|no\s+lo\s+hagas|no\s+proceed/i;

/**
 * Detects explicit, natural-language intent to end the current conversation
 * without relying on ambiguous courtesy-only replies like "gracias" or "listo".
 */
export const SESSION_CLOSE_RE =
  /\b(dej[eé]moslo\s+hasta\s+aqu[ií]|por\s+ahora\s+dej[eé]moslo\s+as[ií]|con\s+esto\s+terminamos|eso\s+es\s+todo\s+por\s+ahora|hasta\s+aqu[ií]\s+llegamos|terminemos\s+aqu[ií]|cerramos\s+por\s+ahora|lo\s+dejamos\s+hasta\s+aqu[ií]|no\s+necesito\s+nada\s+m[aá]s\s+por\s+ahora|con\s+eso\s+basta\s+por\s+ahora|listo,\s*paramos\s+aqu[ií]|ok,\s*dej[eé]moslo\s+ah[ií]|bueno,\s*con\s+eso\s+quedamos|vale,\s*hasta\s+aqu[ií]|perfecto,\s*lo\s+dejamos\s+as[ií]\s+por\s+ahora)\b/i;

function hasSchedulingCreationIntent(text: string): boolean {
  return SCHEDULE_INTENT_RE.test(text) && !AGENDA_QUERY_RE.test(text);
}

// ─── Date reference resolver ─────────────────────────────────────────────────

const DAY_DOW: Record<string, number> = {
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6,
};

function normalizeDayName(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Replaces natural-language day references ("próximo jueves", "el lunes")
 * with the explicit ISO date so the LLM never has to compute dates itself.
 *
 * e.g. "próximo jueves" → "próximo jueves (jueves, 9 de abril de 2026 / 2026-04-09)"
 */
export function resolveDateReferences(text: string, timezone: string): string {
  const todayIso = new Date().toLocaleDateString("en-CA", { timeZone: timezone }); // YYYY-MM-DD
  const todayDate = new Date(`${todayIso}T12:00:00`);
  const todayDow = todayDate.getDay();

  return text.replace(
    /(?:(?:el|para el|el pr[oó]ximo|pr[oó]ximo|este)\s+)?(domingo|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado)/gi,
    (match, dayName) => {
      const key = normalizeDayName(dayName);
      const targetDow = DAY_DOW[key];
      if (targetDow === undefined) return match;

      let daysAhead = targetDow - todayDow;
      if (daysAhead <= 0) daysAhead += 7; // always look forward

      const target = new Date(`${todayIso}T12:00:00`);
      target.setDate(target.getDate() + daysAhead);
      const isoDate = target.toLocaleDateString("en-CA", { timeZone: timezone });
      const label = target.toLocaleDateString("es-CO", {
        timeZone: timezone, weekday: "long", day: "numeric", month: "long", year: "numeric",
      });

      return `${match} (${label} / ${isoDate})`;
    }
  );
}

// ─── Date context injection (for follow-up messages without explicit date) ───

const TIME_ONLY_RE = /\b(\d{1,2}\s*(am|pm|a\.m\.|p\.m\.)|a las\s+\d|\d{1,2}:\d{2})\b/i;
const DATE_ISO_RE = /\b(\d{4}-\d{2}-\d{2})\b/;

/**
 * Detects if the last assistant message was an availability result
 * (contains time ranges like "08:00 - 09:00").
 * Requires spaces around the dash to avoid false-positives with ISO
 * datetime offsets like "08:00:00-05:00".
 */
const AVAILABILITY_RESULT_RE = /\d{2}:\d{2}\s+-\s+\d{2}:\d{2}/;
const BASH_COMMAND_REQUEST_RE = /[¿?]Qu[eé]\s+comando\s+bash/i;
const BASH_TERMINAL_REQUEST_RE = /[¿?]En\s+qu[eé]\s+terminal\s+te\s+gustar[ií]a\s+ejecutar\s+el\s+comando\s+(.+?)\??$/i;
const FILE_NAME_REQUEST_RE =
  /(nombre del nuevo archivo|c[oó]mo quieres llamarlo|como quieres llamarlo|ruta del nuevo archivo|en qu[eé] ruta quieres crear|d[oó]nde quieres crear(?:lo| el archivo))/i;
const FILE_CREATE_RE =
  /\b(crea|crear|genera|escribe|guarda|haz)\b.*\b(archivo|copia)\b/i;
const FILE_SUMMARY_SOURCE_RE =
  /\b(resumen anterior|este resumen|con el resumen|usando el resumen|a partir del resumen|versi[oó]n resumida)\b/i;
const FILE_EXACT_COPY_RE =
  /\b(copia exacta|copia fiel|duplicado exacto|igual al original|mismo contenido|exactamente igual)\b/i;
const FILE_PATH_RE =
  /([A-Za-z0-9._/-]+(?:\\[A-Za-z0-9._-]+)*(?:\/[A-Za-z0-9._-]+)*\.[A-Za-z0-9._-]+)/g;
const SCHEDULED_TASK_INTENT_RE =
  /\b(tarea(s)? programada(s)?|recu[eé]rdame|recu[eé]rdame|av[ií]same|notif[ií]came|recordarme|recordatorio|cada\s+(d[ií]a|semana|mes)|todos?\s+los\s+d[ií]as|semanal|mensual)\b/i;
const SCHEDULED_TASK_LIST_RE =
  /\b(mu[eé]strame|mostrar|dame|lista|listar|cu[aá]les|cu[aá]l(es)?\s+tengo|ver)\b[\s\S]*\b(tarea(s)? programada(s)?|recordatorio(s)?)\b/i;
const SCHEDULED_TASK_CANCEL_BY_ID_RE =
  /\b(cancela|cancelar|elimina|eliminar|desprograma|desprogramar|borra|borrar|quita|quitar)\b[\s\S]*?\b([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/i;
const EXACT_MESSAGE_RE =
  /(?:mensaje|texto)\s*:?\s*["“]([^"”]+)["”]|env[ií]ame exactamente(?:\s+por telegram)?\s+este mensaje\s*:?\s*["“]([^"”]+)["”]/i;
const SCHEDULED_TASK_NUMBER_ACTION_RE =
  /\b(cancela|cancelar|elimina|eliminar|desprograma|desprogramar|borra|borrar|quita|quitar)\b[\s\S]*?\b(?:tarea\s+)?(?:n[uú]mero\s+)?#?(\d{1,2})\b/i;

/**
 * When a follow-up message has no explicit date/day but either:
 *  a) contains time-of-day references ("entre 2pm y 6pm"), or
 *  b) follows an availability result from the assistant ("muéstrame solo los disponibles"),
 * extract the most recently used ISO date from session history and inject it.
 * This prevents the LLM from recalculating and getting the wrong date.
 */
export async function injectDateContext(
  db: DbClient,
  sessionId: string,
  text: string,
  timezone: string
): Promise<string> {
  if (DAY_REF_RE.test(text)) return text; // already has an explicit date reference

  const hasTimeRef = TIME_ONLY_RE.test(text);

  // Look in recent messages for context
  const { data: messages } = await db
    .from("agent_messages")
    .select("role, content")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(6);

  if (!messages || messages.length === 0) return text;

  // Check if last assistant message was an availability result (has HH:MM - HH:MM ranges)
  const lastAssistant = messages.find((m) => m.role === "assistant");
  const lastAssistantIsAvailability = AVAILABILITY_RESULT_RE.test(
    (lastAssistant?.content as string) ?? ""
  );

  // Only inject if we have a time reference OR we're following an availability response
  if (!hasTimeRef && !lastAssistantIsAvailability) return text;

  // Compute local timezone offset (e.g. "-05:00")
  const offsetRaw = new Date().toLocaleString("en-US", { timeZone: timezone, timeZoneName: "shortOffset" })
    .match(/GMT([+-]\d+(?::\d+)?)/)?.[1] ?? "-5";
  const offsetSign = offsetRaw.startsWith("-") ? "-" : "+";
  const [offsetH, offsetM = "0"] = offsetRaw.replace(/[+-]/, "").split(":");
  const tzOffset = `${offsetSign}${offsetH.padStart(2, "0")}:${offsetM.padStart(2, "0")}`;

  // Find the most recently resolved ISO date in session history
  for (const msg of messages) {
    const content = msg.content as string;
    const match = DATE_ISO_RE.exec(content);
    if (match) {
      const isoDate = match[1];
      const label = new Date(`${isoDate}T12:00:00`).toLocaleDateString("es-CO", {
        timeZone: timezone, weekday: "long", day: "numeric", month: "long", year: "numeric",
      });

      // When following an availability result without a time window, force a fresh tool call
      // so the LLM doesn't recycle stale data from the conversation history.
      if (lastAssistantIsAvailability && !hasTimeRef) {
        return (
          `[INSTRUCCIÓN: El usuario quiere ver SOLO los espacios disponibles para ${label} (${isoDate}). ` +
          `DEBES llamar calendar_check_availability con time_min="${isoDate}T00:00:00${tzOffset}" ` +
          `y time_max="${isoDate}T23:59:59${tzOffset}". ` +
          `NO uses datos de respuestas anteriores del historial.]\n\n${text}`
        );
      }

      return `[Fecha de contexto: ${label} / ${isoDate}. Usa esta fecha para construir los rangos de tiempo.]\n\n${text}`;
    }
  }

  return text;
}

function stripInjectedDirective(text: string): string {
  return text.replace(/^\[[\s\S]*?\]\n\n/, "");
}

function normalizeRepoRelativePath(rawPath: string): string {
  return rawPath.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/{2,}/g, "/");
}

function extractLikelyFilePath(text: string): string | null {
  const matches = text.match(FILE_PATH_RE) ?? [];
  if (matches.length === 0) return null;
  return normalizeRepoRelativePath(matches[matches.length - 1]);
}

function buildDestinationPathFromReply(replyText: string, sourcePath: string | null): string {
  const normalizedReply = normalizeRepoRelativePath(replyText);
  if (normalizedReply.includes("/")) return normalizedReply;
  if (!sourcePath) return normalizedReply;

  const sourceDir = path.posix.dirname(normalizeRepoRelativePath(sourcePath));
  if (!sourceDir || sourceDir === ".") return normalizedReply;
  return path.posix.join(sourceDir, normalizedReply);
}

export async function injectBashContinuation(
  db: DbClient,
  sessionId: string,
  text: string
): Promise<string> {
  const { data: messages } = await db
    .from("agent_messages")
    .select("role, content")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(6);

  if (!messages || messages.length === 0) return text;

  const lastAssistant = messages.find((m) => m.role === "assistant");
  const lastAssistantContent = stripInjectedDirective((lastAssistant?.content as string) ?? "").trim();
  if (!lastAssistantContent) return text;

  if (BASH_COMMAND_REQUEST_RE.test(lastAssistantContent)) {
    return (
      `[CONTINUACIÓN BASH. El usuario ya proporcionó el comando: "${text}". ` +
      `Si no indicó terminal explícita, usa terminal="default" sin preguntarlo. ` +
      `Llama la tool bash con prompt="${text}" y terminal="default".]\n\n${text}`
    );
  }

  const terminalMatch = lastAssistantContent.match(BASH_TERMINAL_REQUEST_RE);
  if (terminalMatch) {
    const previousPrompt = terminalMatch[1].trim().replace(/^["']|["']$/g, "");
    const terminalName = text.trim();
    return (
      `[CONTINUACIÓN BASH. El usuario ya proporcionó el nombre de terminal: "${terminalName}". ` +
      `El comando pendiente es: "${previousPrompt}". ` +
      `Llama la tool bash con prompt="${previousPrompt}" y terminal="${terminalName}".]\n\n${text}`
    );
  }

  return text;
}

export async function injectFileContinuation(
  db: DbClient,
  sessionId: string,
  text: string
): Promise<string> {
  const { data: messages } = await db
    .from("agent_messages")
    .select("role, content")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(10);

  if (!messages || messages.length === 0) return text;

  const normalizedText = text.trim();
  const latestAssistant = messages.find((m) => m.role === "assistant");
  const lastAssistantContent = stripInjectedDirective((latestAssistant?.content as string) ?? "").trim();
  const previousUserContent = stripInjectedDirective(
    ((messages.find((m) => m.role === "user")?.content as string) ?? "")
  ).trim();
  const previousAssistantSummary = stripInjectedDirective(
    ((messages.find(
      (m) =>
        m.role === "assistant" &&
        m.content !== latestAssistant?.content &&
        /resumen del archivo|aqu[ií]\s+tienes un resumen/i.test(String(m.content))
    )?.content as string) ?? "")
  ).trim();

  const sourcePath =
    extractLikelyFilePath(previousAssistantSummary) ||
    extractLikelyFilePath(lastAssistantContent) ||
    extractLikelyFilePath(previousUserContent);

  if (FILE_NAME_REQUEST_RE.test(lastAssistantContent)) {
    const destinationPath = buildDestinationPathFromReply(normalizedText, sourcePath);

    if (FILE_EXACT_COPY_RE.test(previousUserContent) && sourcePath) {
      return (
        `[CONTINUACIÓN ARCHIVOS. El usuario ya proporcionó la ruta destino: "${destinationPath}". ` +
        `La solicitud pendiente es crear una copia exacta del archivo "${sourcePath}". ` +
        `Primero llama read_file con path="${sourcePath}", luego llama write_file con path="${destinationPath}" usando exactamente el contenido leído. ` +
        `No pidas más datos.]\n\n${text}`
      );
    }

    if (FILE_SUMMARY_SOURCE_RE.test(previousUserContent) && previousAssistantSummary) {
      return (
        `[CONTINUACIÓN ARCHIVOS. El usuario ya proporcionó la ruta destino: "${destinationPath}". ` +
        `La solicitud pendiente es crear un archivo nuevo usando como contenido el resumen anterior. ` +
        `Llama write_file con path="${destinationPath}" y con content basado en tu respuesta anterior de resumen. ` +
        `No pidas más datos.]\n\n${text}`
      );
    }
  }

  if (FILE_CREATE_RE.test(normalizedText)) {
    const destinationPath = extractLikelyFilePath(normalizedText);

    if (destinationPath && FILE_EXACT_COPY_RE.test(normalizedText) && sourcePath) {
      return (
        `[INSTRUCCIÓN ARCHIVOS. El usuario quiere crear una copia exacta de "${sourcePath}" en "${destinationPath}". ` +
        `Primero llama read_file con path="${sourcePath}", luego llama write_file con path="${destinationPath}" usando exactamente el contenido leído.]\n\n${text}`
      );
    }

    if (destinationPath && FILE_SUMMARY_SOURCE_RE.test(normalizedText) && previousAssistantSummary) {
      return (
        `[INSTRUCCIÓN ARCHIVOS. El usuario quiere crear un archivo nuevo en "${destinationPath}" usando como contenido el resumen anterior. ` +
        `Llama write_file con path="${destinationPath}" y con content basado en tu respuesta anterior de resumen. ` +
        `No vuelvas a pedir el nombre del archivo ni el contenido.]\n\n${text}`
      );
    }
  }

  return text;
}

// ─── Scheduled task directives ───────────────────────────────────────────────

export function injectScheduledTaskDirective(text: string): string {
  const cancelByIdMatch = text.match(SCHEDULED_TASK_CANCEL_BY_ID_RE);
  if (cancelByIdMatch) {
    const taskId = cancelByIdMatch[2];
    return (
      `[INSTRUCCIÓN GESTIÓN TAREA PROGRAMADA. El usuario quiere cancelar una tarea programada específica. ` +
      `Llama cancel_scheduled_task AHORA con task_id="${taskId}". No pidas el UUID de nuevo.]\n\n${text}`
    );
  }

  if (SCHEDULED_TASK_LIST_RE.test(text)) {
    return (
      `[INSTRUCCIÓN GESTIÓN TAREA PROGRAMADA. El usuario quiere ver su lista de tareas programadas. ` +
      `Llama list_scheduled_tasks AHORA. Si el usuario no especifica estado, usa el filtro por defecto de tareas activas.]\n\n${text}`
    );
  }

  if (!SCHEDULED_TASK_INTENT_RE.test(text)) return text;

  const exactMessageMatch = text.match(EXACT_MESSAGE_RE);
  const exactMessage =
    exactMessageMatch?.[1]?.trim() || exactMessageMatch?.[2]?.trim() || null;

  const promptHint = exactMessage
    ? `Si el usuario ya dio un mensaje exacto, NO guardes solo "${exactMessage}". ` +
      `Guarda un prompt autosuficiente como: "Envía exactamente por Telegram este mensaje: \\"${exactMessage}\\". No hagas preguntas adicionales."`
    : "El campo prompt de create_scheduled_task debe ser una instrucción autosuficiente que el agente pueda ejecutar después sin pedir contexto adicional.";

  return (
    `[INSTRUCCIÓN TAREA PROGRAMADA. El usuario quiere crear una tarea programada, NO un evento de calendario. ` +
    `Si ya están claros qué hacer y cuándo, llama create_scheduled_task. ` +
    `${promptHint} ` +
    `Si falta información, pide SOLO el primer dato faltante.]\n\n${text}`
  );
}

export function buildScheduledExecutionMessage(prompt: string): string {
  return (
    `[EJECUCIÓN PROGRAMADA. Esta instrucción viene de una tarea ya creada y vencida. ` +
    `NO vuelvas a programar create_scheduled_task. ` +
    `NO preguntes fecha, hora ni qué debe recordarse. ` +
    `Ejecuta directamente la instrucción guardada. ` +
    `Si la instrucción consiste en enviar un mensaje, envíalo sin pedir aclaraciones. ` +
    `Solo haz una pregunta si la instrucción es realmente imposible de ejecutar tal como está escrita.]\n\n${prompt}`
  );
}

export async function injectScheduledTaskReferenceContinuation(
  db: DbClient,
  sessionId: string,
  text: string
): Promise<string> {
  const match = text.match(SCHEDULED_TASK_NUMBER_ACTION_RE);
  if (!match) return text;

  const requestedIndex = Number(match[2]);
  if (!Number.isInteger(requestedIndex) || requestedIndex <= 0) return text;

  const { data: latestListCall } = await db
    .from("tool_calls")
    .select("result_json")
    .eq("session_id", sessionId)
    .eq("tool_name", "list_scheduled_tasks")
    .eq("status", "executed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const tasks = (((latestListCall?.result_json as Record<string, unknown> | null) ?? {})
    .tasks ?? []) as Array<Record<string, unknown>>;

  if (tasks.length === 0) {
    return (
      `[REFERENCIA TAREA PROGRAMADA. El usuario quiere actuar sobre la tarea número ${requestedIndex}, ` +
      `pero no hay una lista reciente confiable en esta sesión. ` +
      `Primero llama list_scheduled_tasks para mostrar las tareas activas y luego pídele que elija de nuevo.]\n\n${text}`
    );
  }

  const selectedTask = tasks.find(
    (task) => Number(task.reference_number ?? 0) === requestedIndex
  );

  if (!selectedTask || typeof selectedTask.id !== "string") {
    return (
      `[REFERENCIA TAREA PROGRAMADA. El usuario se refiere a la tarea número ${requestedIndex}, ` +
      `pero esa posición no existe en la última lista mostrada. ` +
      `Explícale que elija un número válido de la lista más reciente o vuelve a mostrarla con list_scheduled_tasks.]\n\n${text}`
    );
  }

  return (
    `[REFERENCIA TAREA PROGRAMADA. El usuario se refiere a la tarea número ${requestedIndex} ` +
    `de la última lista mostrada. Esa tarea corresponde a task_id="${selectedTask.id}". ` +
    `El usuario quiere cancelarla o desprogramarla. ` +
    `Llama cancel_scheduled_task con task_id="${selectedTask.id}" sin pedir el UUID nuevamente.]\n\n${text}`
  );
}

// ─── Scheduling directive injection ──────────────────────────────────────────

/**
 * If the message contains scheduling intent + date/time + participant,
 * prepends an explicit directive so the model calls the right tools immediately.
 */
export function injectSchedulingDirective(text: string): string {
  const hasScheduleIntent = hasSchedulingCreationIntent(text);
  const hasEmail = EMAIL_RE.test(text);
  const hasPersonName = PERSON_NAME_RE.test(text);
  const hasHour = HOUR_REF_RE.test(text);
  const hasDay = DAY_REF_RE.test(text);
  const hasSubject = SUBJECT_MARKER_RE.test(text);

  if (!hasScheduleIntent) return text;

  // All data present — proceed immediately
  if (hasDay && hasHour && (hasEmail || hasPersonName)) {
    if (hasEmail) {
      return `[AGENDAMIENTO COMPLETO: fecha/hora, asunto y email presentes. Llama calendar_create_event AHORA sin preguntas.]\n\n${text}`;
    }
    return `[AGENDAMIENTO con nombre de persona. Llama contacts_lookup con los nombres detectados, luego calendar_create_event.]\n\n${text}`;
  }

  // Has participant — ask for the FIRST missing piece only (one question at a time)
  if (hasEmail || hasPersonName) {
    if (!hasDay) {
      return `[El usuario quiere agendar con participante(s) ya mencionado(s). Pregunta ÚNICAMENTE: "¿Para qué fecha?" NO pidas hora ni asunto todavía.]\n\n${text}`;
    }
    if (!hasHour) {
      return `[El usuario quiere agendar el ${hasDay ? "día mencionado" : "día indicado"} con participante(s) ya mencionado(s). Pregunta ÚNICAMENTE: "¿A qué hora?" NO pidas asunto todavía.]\n\n${text}`;
    }
    if (!hasSubject) {
      return `[El usuario quiere agendar con participante(s), fecha y hora ya mencionados. Pregunta ÚNICAMENTE: "¿Cuál es el asunto?" NO pidas más datos.]\n\n${text}`;
    }
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
  if (hasSchedulingCreationIntent(text)) return text;

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
  const normalizedText = text.trim();

  const chronological = [...messages].reverse();
  let flowStartIdx = -1;
  for (let i = chronological.length - 1; i >= 0; i--) {
    const m = chronological[i];
    const raw = (m.content as string).replace(/^\[[\s\S]*?\]\n\n/, "");
    if (m.role === "user" && hasSchedulingCreationIntent(raw)) {
      flowStartIdx = i;
      break;
    }
  }

  const hasRecentSchedulingFlow = flowStartIdx !== -1;

  // ── 3. Contact-selection guard ───────────────────────────────────────────
  // If the last assistant message was presenting contact options, the user is
  // selecting a contact — NOT requesting an event. Inject an explicit block so
  // the LLM confirms the selection without calling calendar_create_event.
  if (
    CONTACT_OPTIONS_RE.test(lastAssistantContent) &&
    CONTACT_SELECTION_REPLY_RE.test(normalizedText)
  ) {
    // Extract the numbered options from the last assistant message so the LLM
    // knows exactly which contact each number refers to (avoids old-context confusion).
    const optionLines = lastAssistantContent.match(/\d+\.\s+[^\n]+/g) ?? [];
    const optionsText =
      optionLines.length > 0
        ? `Las opciones presentadas fueron:\n${optionLines.map((l) => `  ${l}`).join("\n")}\n`
        : "";
    return (
      `[El usuario está eligiendo un contacto de la lista presentada. ` +
      `${optionsText}` +
      `Confirma cuál eligió (el número que escribió corresponde EXACTAMENTE a esa lista, ignora cualquier contacto de conversaciones anteriores) ` +
      `y pregunta si desea hacer algo más. ` +
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
  if (!SCHEDULING_FLOW_RE.test(lastAssistantContent) && !hasRecentSchedulingFlow) {
    // Contact question outside any flow — force a fresh tool call, never use history
    if (CONTACT_QUESTION_RE.test(text)) {
      return (
        `[CONSULTA DE CONTACTO INFORMATIVA (fuera de flujo de agendamiento). ` +
        `Llama contacts_lookup AHORA. NUNCA uses datos del historial — busca siempre fresco. ` +
        `Si hay UN resultado: muéstralo directamente. ` +
        `Si hay MÚLTIPLES resultados: listarlos TODOS numerados y NO pidas confirmación ni preguntes cuál usar.]\n\n${text}`
      );
    }
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

    // If we have all scheduling data but no confirmed email yet, resolve the contact first.
    if (allFlowEmails.size === 0) {
      // Extract person names mentioned after "con" or "invita" in the flow
      const nameMatches = flowContent.match(/\b(?:con|invita?)\s+([a-záéíóúñA-ZÁÉÍÓÚÑ]{2,}(?:\s+[a-záéíóúñA-ZÁÉÍÓÚÑ]{2,})?)/gi) ?? [];
      const names = nameMatches.map((m) => m.replace(/^(?:con|invita?)\s+/i, "").trim()).join(", ");
      return (
        `[CONTINUACIÓN DE AGENDAMIENTO.\n` +
        `Mensajes de este flujo:\n${prevUserSummary}\n` +
        `Mensaje actual: "${text}"\n` +
        `INSTRUCCIÓN: Ya tienes fecha, hora y asunto. FALTA el email del participante. ` +
        `LLAMA contacts_lookup para buscar: ${names || "el participante mencionado"}. ` +
        `Una vez tengas el email, llama calendar_create_event con todos los datos.]\n\n${text}`
      );
    }

    return (
      `[CONTINUACIÓN DE AGENDAMIENTO.\n` +
      `Mensajes de este flujo:\n${prevUserSummary}\n` +
      `Mensaje actual: "${text}"\n` +
      `Emails confirmados: ${emailsList}\n` +
      `INSTRUCCIÓN: Ya tienes TODOS los datos incluyendo email. NO llames contacts_lookup de nuevo. ` +
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
