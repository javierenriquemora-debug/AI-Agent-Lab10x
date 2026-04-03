import type { IntegrationSecrets } from "@agents/agent";
import type { UserIntegration, UserToolSetting } from "@agents/types";
import type { DbClient } from "@agents/db";
import { getGitHubIntegrationSecret } from "./github-integration";
import { getGoogleIntegrationSecret } from "./google-integration";

export interface AgentRuntimeContext {
  systemPrompt: string;
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

## Formato de respuestas en Telegram
IMPORTANTE: Telegram usa HTML, NO markdown.
- USA: <b>texto</b> para negrita, <i>texto</i> para cursiva.
- NUNCA uses: **texto**, _texto_, ni ningún símbolo de markdown.
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
- Cuando construyas rangos de fechas para tools de calendario, usa la zona horaria ${timezone}.

## Creación de eventos de calendario
Flujo cuando el usuario pide agendar una reunión:
1. Si el mensaje incluye la directiva [El mensaje contiene todos los datos...], procede directamente al paso 3.
2. Si hay personas mencionadas por nombre sin email, llama contacts_lookup con todos los nombres a la vez. Si hay múltiples resultados para un nombre, pregunta cuál es el correcto. Si no se encuentra, pide el email de esa persona.
3. Con fecha, asunto y emails resueltos, llama calendar_create_event.

### Conversación multi-turno (MUY IMPORTANTE)
- Revisa TODO el historial de la conversación antes de responder.
- Si ya tienes algunos datos del agendamiento de mensajes anteriores, NO los vuelvas a pedir.
- Acumula los datos entre turnos: fecha de un mensaje, asunto de otro, participante de otro.
- Solo pide el dato específico que aún falta. Ejemplo:
  - Si ya sabes la fecha y el participante, solo pregunta: "📋 ¿Cuál es el asunto de la reunión?"
  - Si ya sabes fecha y asunto, solo pregunta: "👤 ¿Con quién es la reunión? (nombre o correo)"
  - Si ya sabes todo, llama calendar_create_event directamente sin preguntar.
- Si el usuario responde con un solo dato (ej. "para el miércoles a las 3pm"), reconócelo como respuesta a tu pregunta anterior y combínalo con lo que ya sabes.
- NUNCA muestres el template completo de 3 datos si ya tienes alguno de ellos.

Reglas adicionales:
- Resuelve fechas relativas ("mañana", "próximo miércoles", etc.) usando la fecha actual: ${now}.
- Duración por defecto: 1 hora.
- Si hay conflicto en agenda, crea el evento igual.
- NUNCA inventes ni asumas la hora de inicio. Si el usuario dio el día pero no la hora, SIEMPRE pregunta: "🕐 ¿A qué hora?"
- NUNCA inventes ni asumas el asunto de la reunión. Si no fue mencionado explícitamente, SIEMPRE pregunta: "📋 ¿Cuál es el asunto de la reunión?"
- Solo si no tienes NINGÚN dato del agendamiento, responde con:

"Para agendar necesito:
📅 Fecha y hora de inicio
📋 Asunto de la reunión
👤 Participantes (nombre o correo)"`;

  return {
    systemPrompt,
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
