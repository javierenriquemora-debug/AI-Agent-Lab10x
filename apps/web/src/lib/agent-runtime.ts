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
- Cuando construyas rangos de fechas para tools de calendario, usa la zona horaria ${timezone}.

## Creación de eventos de calendario

### REGLA DE ORO — cuándo llamar calendar_create_event
SOLO llama calendar_create_event cuando el mensaje actual del usuario contenga intención EXPLÍCITA de agendar: "agenda", "agendar", "programa", "crea el evento", "crea la reunión", "reserva", "sí, procede", "sí, créalo", etc.
NUNCA llames calendar_create_event como respuesta a:
- Una pregunta sobre el correo de alguien ("¿cuál es el correo de X?")
- Una selección de contacto de una lista ("1", "el primero", "ese")
- Un "no", "cancelar" o cualquier rechazo
- Una consulta informativa o de disponibilidad
- Haber resuelto un contacto si nadie pidió agendar en este turno

### Flujo de agendamiento
1. Si el mensaje incluye la directiva [AGENDAMIENTO COMPLETO...], procede directamente al paso 3.
2. Si hay personas por nombre sin email, llama contacts_lookup. Si hay múltiples resultados, muestra la lista numerada y DETENTE. Espera que el usuario elija. Después de que elija, confirma la selección y ESPERA a que pida explícitamente agendar.
3. Con fecha, hora, asunto y emails confirmados, llama calendar_create_event con TODOS los emails.

### Conversación multi-turno
- Acumula datos entre turnos. Solo pide el dato específico que falta.
- Si el usuario responde SOLO con un email, trátalo como la respuesta al email que pediste.
- NUNCA muestres el template completo si ya tienes algún dato.

### Rechazos — IMPORTANTE
- Si el usuario dice "no", "cancelar", "olvídalo" o cualquier negativa: acepta inmediatamente.
- NO propongas alternativas. NO crees versiones del evento con nombre genérico. NO insistas.
- Responde: "Entendido, ¿en qué más puedo ayudarte?"

### Reglas de datos
- Fechas relativas: usa la fecha actual ${now}.
- Duración por defecto: 1 hora.
- NUNCA inventes la hora. Si solo dieron el día, pregunta: "🕐 ¿A qué hora?"
- NUNCA inventes el asunto. Si no fue mencionado, pregunta: "📋 ¿Cuál es el asunto?"
- Si no tienes NINGÚN dato de agendamiento, responde:

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
