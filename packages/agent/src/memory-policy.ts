import type { Channel, MemoryType } from "@agents/types";
import type { MemorySearchResult } from "@agents/db";

export type MemoryServiceScope =
  | "calendar"
  | "contacts"
  | "scheduled_tasks"
  | "bash"
  | "files"
  | "github"
  | "general";

export type MemoryAction = "remember" | "suggest_only" | "never_automate";

export interface MemoryCandidatePolicy {
  action: MemoryAction;
  shouldStore: boolean;
  inferredScope: MemoryServiceScope;
  reason: string;
}

const EMAIL_ADDRESS_RE = /[\w.+-]+@[\w.-]+\.\w{2,}/i;
const COMMAND_LIKE_RE =
  /\b(cd|ls|dir|pwd|npm|pnpm|yarn|git|python|node|docker|curl|powershell|bash)\b/i;
const PATH_LIKE_RE =
  /\b([a-z]:\\|\/|\.\/|[a-z0-9._-]+\/[a-z0-9._/-]+|[a-z0-9._-]+\.[a-z0-9_-]+)\b/i;
const GITHUB_RESOURCE_RE =
  /\b(repo|repos|repositorio|repositorios|branch|branches|rama|ramas|issue|issues|pull request|pull requests|pr|commit|release)\b/i;
const CALENDAR_EVENT_RE =
  /\b(agenda|agendar|evento|reunion|reuniones|meeting|cita|asistente|participante|horario)\b/i;
const CONTACTS_RE = /\b(contacto|contactos|correo|email)\b/i;
const SCHEDULED_TASK_RE =
  /\b(tarea programada|tareas programadas|recordatorio|recordatorios|telegram|diario|semanal|mensual)\b/i;
const PREFERENCE_RE =
  /\b(prefiere|prefiero|preferencia|habitual|habitualmente|normalmente|suele|siempre|por defecto|formato|tono|estilo|duracion|duracion habitual|zona horaria|confirmacion|resumen|detalle|detallado|breve|lista numerada)\b/i;
const SUGGESTION_RE =
  /\b(habitual|habitualmente|recurrente|recurrentes|normalmente|suele|usualmente|por lo general)\b/i;
const TOOL_DERIVED_PROCEDURE_RE =
  /\b(contacts_lookup|calendar_[a-z_]+|create_scheduled_task|list_scheduled_tasks|cancel_scheduled_task|read_file|write_file|edit_file|tool|bash|usar datos del historial|fuera de flujo de agendamiento)\b/i;

function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function detectMemoryServiceScope(args: {
  text: string;
  channel?: Channel;
}): MemoryServiceScope {
  const text = normalizeText(args.text);

  if (
    args.channel === "scheduled" ||
    text.includes("[instruccion tarea programada") ||
    text.includes("[referencia tarea programada") ||
    text.includes("[ejecucion programada") ||
    text.includes("create_scheduled_task") ||
    text.includes("list_scheduled_tasks") ||
    text.includes("cancel_scheduled_task") ||
    SCHEDULED_TASK_RE.test(text)
  ) {
    return "scheduled_tasks";
  }

  if (
    text.includes("[continuacion bash") ||
    text.includes("tool bash") ||
    /\bterminal\b/.test(text) ||
    /\bcomando bash\b/.test(text)
  ) {
    return "bash";
  }

  if (
    text.includes("[instruccion archivos") ||
    text.includes("[continuacion archivos") ||
    text.includes("read_file") ||
    text.includes("write_file") ||
    text.includes("edit_file") ||
    /\barchivo\b/.test(text) ||
    /\bruta\b/.test(text)
  ) {
    return "files";
  }

  if (
    /\bgithub\b/.test(text) ||
    /\bpull request\b/.test(text) ||
    /\bpull requests\b/.test(text) ||
    /\brepo\b/.test(text) ||
    /\brepos\b/.test(text) ||
    /\brepositorio\b/.test(text) ||
    /\brepositorios\b/.test(text) ||
    /\bissue\b/.test(text) ||
    /\bissues\b/.test(text) ||
    /\bmis repos\b/.test(text) ||
    /\bpr\b/.test(text)
  ) {
    return "github";
  }

  const looksCalendar =
    text.includes("[agendamiento") ||
    text.includes("[continuacion de agendamiento") ||
    text.includes("calendar_create_event") ||
    text.includes("calendar_check_availability") ||
    text.includes("calendar_list_events") ||
    /\bdisponibilidad\b/.test(text) ||
    /\bmi agenda\b/.test(text) ||
    CALENDAR_EVENT_RE.test(text);

  if (looksCalendar) return "calendar";
  if (text.includes("contacts_lookup") || CONTACTS_RE.test(text)) return "contacts";
  return "general";
}

function isCalendarSuggestion(content: string): boolean {
  return (
    /\b(participante|participantes|asistente|asistentes)\b/i.test(content) ||
    /\b(horario|duracion)\b/i.test(content)
  ) && SUGGESTION_RE.test(content);
}

function isContactSuggestion(content: string): boolean {
  return /\b(elegiste|eliges|seleccionas|seleccionaste|usas)\b/i.test(content);
}

function isScheduledTaskSuggestion(content: string): boolean {
  return /\b(canal|telegram|estilo|frecuencia)\b/i.test(content) && SUGGESTION_RE.test(content);
}

function isGithubPresentationPreference(content: string): boolean {
  return PREFERENCE_RE.test(content) && /\b(repo|repos|repositorio|repositorios|issue|issues|pull request|pull requests|pr)\b/i.test(content);
}

function isBroadGeneralPreference(content: string): boolean {
  return (
    PREFERENCE_RE.test(content) &&
    !CALENDAR_EVENT_RE.test(content) &&
    !CONTACTS_RE.test(content) &&
    !SCHEDULED_TASK_RE.test(content) &&
    !GITHUB_RESOURCE_RE.test(content) &&
    !COMMAND_LIKE_RE.test(content) &&
    !PATH_LIKE_RE.test(content)
  );
}

export function evaluateMemoryCandidate(args: {
  content: string;
  type: MemoryType;
  scope?: MemoryServiceScope;
  channel?: Channel;
}): MemoryCandidatePolicy {
  const detectedFromContent = detectMemoryServiceScope({
    text: args.content,
    channel: args.channel,
  });
  const inferredScope =
    detectedFromContent !== "general" || !isBroadGeneralPreference(args.content)
      ? detectedFromContent !== "general"
        ? detectedFromContent
        : args.scope ?? detectedFromContent
      : "general";
  const content = normalizeText(args.content);

  if (args.type === "procedural" && TOOL_DERIVED_PROCEDURE_RE.test(content)) {
    return {
      inferredScope,
      action: "never_automate",
      shouldStore: false,
      reason: "regla procedimental derivada de directivas del sistema o tools",
    };
  }

  switch (inferredScope) {
    case "calendar": {
      if (EMAIL_ADDRESS_RE.test(content)) {
        return {
          inferredScope,
          action: "never_automate",
          shouldStore: false,
          reason: "correo puntual de agenda no se guarda como memoria durable",
        };
      }
      if (args.type === "episodic" && CALENDAR_EVENT_RE.test(content) && !PREFERENCE_RE.test(content)) {
        return {
          inferredScope,
          action: "never_automate",
          shouldStore: false,
          reason: "evento aislado de agenda no se convierte en recuerdo durable",
        };
      }
      if (isCalendarSuggestion(content)) {
        return {
          inferredScope,
          action: "suggest_only",
          shouldStore: true,
          reason: "patron de agenda util solo como sugerencia",
        };
      }
      return {
        inferredScope,
        action: "remember",
        shouldStore: true,
        reason: "preferencia o regla durable de agenda",
      };
    }
    case "contacts": {
      if (EMAIL_ADDRESS_RE.test(content)) {
        return {
          inferredScope,
          action: "never_automate",
          shouldStore: false,
          reason: "correo concreto debe venir de fuente viva",
        };
      }
      if (args.type === "episodic" && !PREFERENCE_RE.test(content) && !isContactSuggestion(content)) {
        return {
          inferredScope,
          action: "never_automate",
          shouldStore: false,
          reason: "hecho aislado de contactos no se guarda",
        };
      }
      if (isContactSuggestion(content)) {
        return {
          inferredScope,
          action: "suggest_only",
          shouldStore: true,
          reason: "seleccion previa de contacto solo sugiere",
        };
      }
      return {
        inferredScope,
        action: "remember",
        shouldStore: true,
        reason: "preferencia durable al consultar contactos",
      };
    }
    case "scheduled_tasks": {
      if (
        args.type === "episodic" &&
        !/\b(canal|telegram|estilo|frecuencia|diario|semanal|mensual)\b/i.test(content)
      ) {
        return {
          inferredScope,
          action: "never_automate",
          shouldStore: false,
          reason: "tarea puntual vieja no se guarda como preferencia",
        };
      }
      if (isScheduledTaskSuggestion(content)) {
        return {
          inferredScope,
          action: "suggest_only",
          shouldStore: true,
          reason: "patron recurrente de tareas solo sugiere",
        };
      }
      return {
        inferredScope,
        action: "remember",
        shouldStore: true,
        reason: "preferencia durable de tareas programadas",
      };
    }
    case "bash": {
      if (args.type === "episodic" || COMMAND_LIKE_RE.test(content) || PATH_LIKE_RE.test(content)) {
        return {
          inferredScope,
          action: "never_automate",
          shouldStore: false,
          reason: "comandos, rutas o salidas puntuales no se guardan",
        };
      }
      if (PREFERENCE_RE.test(content)) {
        return {
          inferredScope,
          action: "remember",
          shouldStore: true,
          reason: "preferencia durable de uso de bash",
        };
      }
      return {
        inferredScope,
        action: "suggest_only",
        shouldStore: true,
        reason: "preferencia debil de bash tratada como sugerencia",
      };
    }
    case "files": {
      if (args.type === "episodic" || PATH_LIKE_RE.test(content)) {
        return {
          inferredScope,
          action: "never_automate",
          shouldStore: false,
          reason: "rutas temporales o eventos puntuales de archivos no se guardan",
        };
      }
      if (/\b(contenido exacto|copia exacta)\b/i.test(content)) {
        return {
          inferredScope,
          action: "never_automate",
          shouldStore: false,
          reason: "contenido exacto de archivos no entra a memoria larga",
        };
      }
      return {
        inferredScope,
        action: "remember",
        shouldStore: true,
        reason: "preferencia durable de lectura o resumen de archivos",
      };
    }
    case "github": {
      if (isGithubPresentationPreference(content)) {
        return {
          inferredScope,
          action: "remember",
          shouldStore: true,
          reason: "preferencia durable de presentacion para github",
        };
      }
      if (args.type === "episodic") {
        return {
          inferredScope,
          action: "never_automate",
          shouldStore: false,
          reason: "hecho puntual de github no se guarda como memoria durable",
        };
      }
      if (GITHUB_RESOURCE_RE.test(content) && !PREFERENCE_RE.test(content)) {
        return {
          inferredScope,
          action: "never_automate",
          shouldStore: false,
          reason: "recursos concretos de github no se guardan como supuestos",
        };
      }
      return {
        inferredScope,
        action: "remember",
        shouldStore: true,
        reason: "preferencia durable de trabajo con github",
      };
    }
    default: {
      if (args.type === "episodic" && !PREFERENCE_RE.test(content)) {
        return {
          inferredScope,
          action: "never_automate",
          shouldStore: false,
          reason: "hecho episodico ambiguo fuera de scope claro",
        };
      }
      if (PREFERENCE_RE.test(content)) {
        return {
          inferredScope,
          action: "remember",
          shouldStore: true,
          reason: "preferencia durable general",
        };
      }
      return {
        inferredScope,
        action: "suggest_only",
        shouldStore: true,
        reason: "recuerdo general util solo como sugerencia",
      };
    }
  }
}

export function getMemoryExtractionPolicy(scope: MemoryServiceScope): string {
  switch (scope) {
    case "calendar":
      return [
        "Guarda preferencias durables de agenda como formato, duracion habitual, zona horaria o necesidad de confirmacion.",
        "No guardes correos puntuales ni asistentes de una sola reunion como verdad permanente.",
        "Si detectas participantes u horarios recurrentes, solo se pueden guardar como sugerencias historicas.",
      ].join("\n");
    case "contacts":
      return [
        "Guarda preferencias de presentacion al mostrar contactos o correos.",
        "No guardes emails concretos como memoria durable si pueden consultarse de nuevo.",
        "Elecciones previas de contacto solo pueden guardarse como sugerencia.",
      ].join("\n");
    case "scheduled_tasks":
      return [
        "Guarda canal preferido, estilo de recordatorio y frecuencias consistentes.",
        "No guardes el contenido puntual de una tarea vieja como preferencia global.",
        "Las plantillas recurrentes solo pueden recordarse como sugerencia.",
      ].join("\n");
    case "bash":
      return [
        "Guarda solo preferencias de interaccion como nivel de detalle o uso de terminal por defecto.",
        "No guardes comandos concretos, salidas del sistema ni rutas temporales.",
      ].join("\n");
    case "files":
      return [
        "Guarda solo preferencias de resumen, explicacion o estilo de respuesta sobre archivos.",
        "No guardes rutas temporales ni contenido exacto de archivos como memoria larga.",
      ].join("\n");
    case "github":
      return [
        "Guarda solo preferencias de estilo para issues, PRs o resumentes.",
        "No guardes ramas, repositorios o recursos concretos como supuestos permanentes.",
      ].join("\n");
    default:
      return [
        "Prioriza preferencias durables y restricciones estables del usuario.",
        "Descarta hechos aislados, efimeros o ambiguos.",
      ].join("\n");
  }
}

function getScopeScore(targetScope: MemoryServiceScope, memoryScope: MemoryServiceScope): number {
  if (targetScope === memoryScope) return 30;
  if (memoryScope === "general") return 8;
  if (targetScope === "general") return 4;
  return -18;
}

function getTypeScore(type: MemoryType): number {
  if (type === "semantic") return 18;
  if (type === "procedural") return 8;
  return -6;
}

function getActionScore(action: MemoryAction): number {
  if (action === "remember") return 12;
  if (action === "suggest_only") return 3;
  return -100;
}

export interface RankedMemory {
  memory: MemorySearchResult;
  inferredScope: MemoryServiceScope;
  action: MemoryAction;
  score: number;
}

export function rankMemoriesForScope(
  memories: MemorySearchResult[],
  targetScope: MemoryServiceScope
): RankedMemory[] {
  return memories
    .map((memory) => {
      const policy = evaluateMemoryCandidate({
        content: memory.content,
        type: memory.type,
      });
      const score =
        memory.similarity * 100 +
        getScopeScore(targetScope, policy.inferredScope) +
        getTypeScore(memory.type) +
        getActionScore(policy.action);

      return {
        memory,
        inferredScope: policy.inferredScope,
        action: policy.action,
        score,
      };
    })
    .filter((item) => {
      if (item.action === "never_automate" || item.score <= 0) return false;
      if (targetScope === "general") return item.inferredScope === "general";
      return item.inferredScope === targetScope || item.inferredScope === "general";
    })
    .sort((a, b) => b.score - a.score);
}
