import type { IntegrationSecrets } from "@agents/agent";
import type { UserIntegration, UserToolSetting } from "@agents/types";
import type { DbClient } from "@agents/db";
import { getGitHubIntegrationSecret } from "./github-integration";
import { getGoogleIntegrationSecret } from "./google-integration";

export interface AgentRuntimeContext {
  systemPrompt: string;
  timezone: string;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  integrationSecrets: IntegrationSecrets;
}

export async function loadAgentRuntimeContext(
  db: DbClient,
  userId: string
): Promise<AgentRuntimeContext> {
  const { data: profile } = await db
    .from("profiles")
    .select("agent_system_prompt, timezone, name")
    .eq("id", userId)
    .single();

  const { data: toolSettings } = await db
    .from("user_tool_settings")
    .select("*")
    .eq("user_id", userId);

  const { data: integrations } = await db
    .from("user_integrations")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active");

  const timezone = (profile?.timezone as string | null) ?? "America/Bogota";
  const now = new Date().toLocaleString("es-CO", { timeZone: timezone, dateStyle: "full", timeStyle: "short" });

  // Build an explicit calendar of the next 14 days so the LLM never has to compute dates.
  const todayLocal = new Date().toLocaleDateString("en-CA", { timeZone: timezone }); // YYYY-MM-DD
  const upcomingDays = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(`${todayLocal}T12:00:00`); // noon to avoid DST edge cases
    d.setDate(d.getDate() + i);
    const label = d.toLocaleDateString("es-CO", { timeZone: timezone, weekday: "long", day: "numeric", month: "long" });
    const iso = d.toLocaleDateString("en-CA", { timeZone: timezone }); // YYYY-MM-DD
    return `  ${label} → ${iso}`;
  }).join("\n");

  // Compute the UTC offset string for the user's timezone (e.g. "-05:00")
  const tzOffsetMatch = new Date().toLocaleString("en-US", { timeZone: timezone, timeZoneName: "shortOffset" })
    .match(/GMT([+-]\d+(?::\d+)?)/);
  const rawOffset = tzOffsetMatch?.[1] ?? "-5";
  const [offsetH, offsetM = "00"] = rawOffset.replace(/[+-]/, "").split(":");
  const offsetSign = rawOffset.startsWith("-") ? "-" : "+";
  const tzOffset = `${offsetSign}${offsetH.padStart(2, "0")}:${offsetM.padStart(2, "0")}`;
  console.log("[agent-runtime] now:", now, "timezone:", timezone, "tzOffset:", tzOffset);
  console.log("[agent-runtime] upcomingDays:\n", upcomingDays);

  const [github, google] = await Promise.all([
    getGitHubIntegrationSecret(db, userId),
    getGoogleIntegrationSecret(db, userId, timezone),
  ]);

  const baseSystemPrompt = profile?.agent_system_prompt?.trim()
    ? profile.agent_system_prompt
    : "Eres un asistente útil.";

  const systemPrompt = `${baseSystemPrompt}

## Contexto del usuario
- Zona horaria: ${timezone}
- Fecha y hora actual: ${now}
- Próximos 14 días — OBLIGATORIO: usa EXACTAMENTE estas fechas. NUNCA calcules fechas por tu cuenta:
${upcomingDays}
  → Para "próximo lunes" busca "lunes" en la lista de arriba y usa esa fecha ISO.
  → Para "próximo jueves" busca "jueves" en la lista y usa esa fecha ISO. NO uses fechas de tu memoria.

## Formato de respuestas en Telegram
IMPORTANTE: Telegram usa HTML, NO markdown. Esto es obligatorio.
- USA: <b>texto</b> para negrita, <i>texto</i> para cursiva.
- NUNCA uses: **texto**, __texto__, _texto_, ni ningún símbolo de markdown en tus respuestas.
- Si ves asteriscos en tu respuesta anterior, corrígelos en la siguiente.
- Usa emojis como marcadores visuales.
- Al listar eventos de calendario usa este formato:
  📅 <b>Nombre del evento</b>
  🕐 HH:MM - HH:MM
  📍 Sala/Ubicación (solo si aplica)
  👥 Asistentes: Nombre1, Nombre2 (solo si hay asistentes)
- Para disponibilidad: ✅ espacios libres, 🔴 bloques ocupados.
- No incluyas URLs largas de Google Calendar.
- Si hay muchos eventos, agrúpalos por día: 📆 <b>Día, fecha</b>
- Sé conciso. Evita introducciones largas.
- Cuando construyas rangos de fechas para tools de calendario, usa SIEMPRE el offset local (${tzOffset}).
  Formato CORRECTO: 2026-04-09T00:00:00${tzOffset}
  Formato INCORRECTO: 2026-04-09T00:00:00Z  ← NUNCA uses Z (UTC)
  Para consultar un día completo: timeMin = FECHAT00:00:00${tzOffset}, timeMax = FECHAT23:59:59${tzOffset}

## Creación de eventos de calendario

### REGLA DE ORO — cuándo llamar calendar_create_event
SOLO llama calendar_create_event cuando el mensaje actual del usuario contenga intención EXPLÍCITA de agendar: "agenda", "agendar", "programa", "crea el evento", "crea la reunión", "reserva", "sí, procede", "sí, créalo", etc.
NUNCA llames calendar_create_event como respuesta a:
- Una pregunta sobre el correo de alguien ("¿cuál es el correo de X?")
- Una selección de contacto de una lista ("1", "el primero", "ese")
- Un "no", "cancelar" o cualquier rechazo
- Una consulta informativa o de disponibilidad
- Haber resuelto un contacto si nadie pidió agendar en este turno

### Uso de contacts_lookup
- SIEMPRE llama contacts_lookup cuando el usuario pregunte por el correo o contacto de alguien. NUNCA respondas desde el historial de conversación — los datos de contacto pueden cambiar y debes consultarlos frescos cada vez.
- DENTRO de un flujo de agendamiento: si hay múltiples resultados, muestra la lista numerada y DETENTE esperando que el usuario elija. Después de que elija, confirma la selección y ESPERA a que pida explícitamente agendar.
- FUERA de un flujo de agendamiento (consulta informativa, ej. "¿cuál es el correo de X?"): muestra SIEMPRE TODOS los resultados encontrados, incluso si hay varios. NUNCA elijas solo uno en silencio. Si hay 1 resultado: "El correo de [nombre] es: email". Si hay varios: "Encontré X correos para [nombre]: 1. nombre1 - email1, 2. nombre2 - email2, ...". NO pidas confirmación ni preguntes cuál usar.

### Flujo de agendamiento
1. Si el mensaje incluye la directiva [AGENDAMIENTO COMPLETO...] o [CONTINUACIÓN DE AGENDAMIENTO...], sigue las instrucciones de la directiva directamente.
2. Si hay personas por nombre sin email, llama contacts_lookup. Aplica las reglas de "Resultados de contacts_lookup" según el contexto.
3. Con fecha, hora, asunto y emails confirmados, llama calendar_create_event con TODOS los emails. La herramienta misma pedirá confirmación al usuario — NO pidas confirmación verbal antes de llamarla.

### Conversación multi-turno
- Acumula datos entre turnos. Pide SOLO UN dato por mensaje — el primero que falte.
- Orden de prioridad para preguntar: 1) fecha, 2) hora, 3) asunto. Los participantes nunca se vuelven a pedir si ya fueron mencionados.
- Si el usuario responde SOLO con un email, trátalo como la respuesta al email que pediste.
- NUNCA muestres el template completo si ya tienes algún dato.
- NUNCA hagas dos preguntas en el mismo mensaje.

### Uso de bash
- Usa la tool \`bash\` cuando el usuario quiera ejecutar un comando del sistema.
- Si el usuario NO especifica una terminal, usa SIEMPRE \`terminal="default"\`. NO preguntes por la terminal en ese caso.
- Si acabas de pedir el comando y el usuario responde solo con algo como \`ls\`, \`pwd\`, \`Get-Location\` o similar, trátalo como el \`prompt\`.
- Si acabas de pedir la terminal y el usuario responde \`default\`, \`main\`, \`test\` o similar, trátalo como el nombre de la terminal para el comando pendiente.
- Para pruebas simples, prefiere \`terminal="default"\` a menos que el usuario pida otra sesión explícitamente.

### Rechazos — IMPORTANTE
- Si el usuario dice "no", "cancelar", "olvídalo" o cualquier negativa: acepta inmediatamente.
- NO propongas alternativas. NO crees versiones del evento con nombre genérico. NO insistas.
- Responde: "Entendido, ¿en qué más puedo ayudarte?"

### Reglas de datos
- Fechas relativas: usa la fecha actual ${now}.
- Duración por defecto: 1 hora.
- NUNCA inventes la hora. Si solo dieron el día, pregunta: "🕐 ¿A qué hora?"
- NUNCA inventes el asunto. Si no fue mencionado, pregunta: "📋 ¿Cuál es el asunto?"
- NUNCA inventes ni adivines un correo electrónico. Si contacts_lookup no encontró al contacto o devuelve "No encontrado", pregunta al usuario: "No encontré a [nombre] en tus contactos. ¿Cuál es su correo?" NO uses dominios como @example.com, @gmail.com ni ningún correo inventado.
- Si no tienes NINGÚN dato de agendamiento, responde:

"Para agendar necesito:
📅 Fecha y hora de inicio
📋 Asunto de la reunión
👤 Participantes (nombre o correo)"`;

  return {
    systemPrompt,
    timezone,
    enabledTools: (toolSettings ?? []).map((t: Record<string, unknown>) => ({
      id: t.id as string,
      user_id: t.user_id as string,
      tool_id: t.tool_id as string,
      enabled: t.enabled as boolean,
      config_json: (t.config_json as Record<string, unknown>) ?? {},
    })),
    integrations: (integrations ?? []).map((i: Record<string, unknown>) => ({
      id: i.id as string,
      user_id: i.user_id as string,
      provider: i.provider as string,
      scopes: (i.scopes as string[]) ?? [],
      status: i.status as "active" | "revoked" | "expired",
      created_at: i.created_at as string,
    })),
    integrationSecrets: {
      github,
      google,
    },
  };
}
