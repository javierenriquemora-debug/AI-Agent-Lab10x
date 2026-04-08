# Arquitectura Técnica — Agente Personal MVP

> Última actualización: abril 2026 — incluye Google Calendar, Google Contacts, Telegram con voz, y sistema de agendamiento multi-turno.

---

## Stack

| Capa                  | Tecnología                           | Paquete                              |
| --------------------- | ------------------------------------ | ------------------------------------ |
| Monorepo              | Turborepo + npm workspaces           | raíz                                 |
| Frontend / API routes | Next.js 16 (App Router, Turbopack)   | `apps/web`                           |
| Agente runtime        | LangGraph JS + LangChain core        | `packages/agent`                     |
| Base de datos + Auth  | Supabase (Postgres + Auth + RLS)     | `packages/db`                        |
| Tipos compartidos     | TypeScript                           | `packages/types`                     |
| Config compartida     | tsconfig                             | `packages/config`                    |
| Modelo LLM            | OpenRouter o Gemini (según env)      | vía `@langchain/openai`              |
| Transcripción de voz  | Google Gemini Flash (`gemini-2.5-flash`) | API REST directa                 |

---

## Estructura del monorepo

```
10x-builders-agent/
├── apps/
│   └── web/                        # Next.js — UI + API routes
│       └── src/
│           ├── app/
│           │   ├── login/           # Autenticación
│           │   ├── signup/
│           │   ├── onboarding/      # Wizard multi-paso
│           │   ├── chat/            # Interfaz de chat web
│           │   ├── settings/        # Ajustes post-onboarding
│           │   └── api/
│           │       ├── chat/              # POST → runAgent (web)
│           │       ├── auth/signout/      # POST → signout
│           │       ├── tool-calls/[id]/   # PATCH → aprobar/rechazar tool call
│           │       ├── integrations/
│           │       │   ├── google/        # OAuth Google (authorize/callback/disconnect)
│           │       │   └── github/        # OAuth GitHub (authorize/callback/disconnect)
│           │       └── telegram/
│           │           ├── webhook/       # POST → bot Telegram
│           │           └── setup/         # GET → registrar webhook
│           └── lib/
│               ├── supabase/        # Helpers SSR (client, server, middleware)
│               ├── agent-runtime.ts # System prompt + contexto de runtime
│               ├── message-preprocessing.ts  # Pipeline de enriquecimiento de mensajes
│               ├── format-message.ts         # Markdown → HTML para Telegram/web
│               ├── google-oauth.ts / google-integration.ts
│               └── github-oauth.ts / github-integration.ts
├── packages/
│   ├── agent/                       # LangGraph grafo + tools
│   │   └── src/
│   │       ├── graph.ts             # StateGraph: agent → tools → agent loop
│   │       ├── model.ts             # ChatOpenAI vía OpenRouter
│   │       └── tools/
│   │           ├── catalog.ts              # Definiciones (id, risk, schema Zod)
│   │           ├── adapters.ts             # Wrappers LangChain + lógica de negocio
│   │           ├── terminal-session-manager.ts # Sesiones persistentes de la tool bash
│   │           ├── google-calendar-client.ts  # freeBusy, listEvents, createEvent
│   │           ├── google-contacts-client.ts  # searchContacts (People API)
│   │           └── github-client.ts           # GitHub REST API
│   ├── db/                          # Supabase client + queries tipadas
│   │   └── src/queries/             # profiles, sessions, messages, tools, integrations, telegram, tool-calls
│   ├── types/                       # Interfaces compartidas
│   └── config/                      # tsconfig base/next
├── docs/
│   ├── brief.md
│   ├── architecture.md              # ← este archivo
│   └── plan.md
└── turbo.json
```

---

## Diagrama de componentes

```
┌──────────────┐    ┌──────────────────────────────┐
│  Next.js UI  │    │        Telegram Bot           │
│  (web chat)  │    │  texto + voz (Gemini Flash)   │
└──────┬───────┘    └──────────────┬───────────────┘
       │                           │
       ▼                           ▼
┌─────────────────────────────────────────────────┐
│              Supabase Auth (JWT)                │
└────────────────────────┬────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────┐
│          message-preprocessing.ts               │
│  resolveDateReferences → injectSchedulingCont.  │
│  → injectDateContext → injectSchedulingDirective│
└────────────────────────┬────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────┐
│         agent-runtime.ts (system prompt)        │
│   timezone · reglas de agendamiento · tools     │
└────────────────────────┬────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────┐
│         LangGraph Runtime (grafo)               │
│   ┌──────────┐        ┌─────────────────────┐   │
│   │  Agent   │───────▶│    Tool Execution    │   │
│   │  Node    │◀───────│  + Confirmation      │   │
│   └──────────┘        │    Policy            │   │
│                       └─────────────────────┘   │
└────────────────────────┬────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────┐
│         Supabase Postgres (RLS)                 │
│  profiles · sessions · messages · tool_calls    │
│  user_tool_settings · user_integrations         │
│  telegram_accounts · telegram_link_codes        │
└─────────────────────────────────────────────────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼              ▼
  Google Calendar  Google Contacts   GitHub API    Host Shell
```

---

## Flujo de un request

### Web (`POST /api/chat`)
1. Usuario envía mensaje.
2. Se autentica vía JWT (Supabase).
3. Se carga o crea `agent_session` activa.
4. Se ejecuta el pipeline de preprocesamiento (`message-preprocessing.ts`).
5. Se carga contexto de runtime (`agent-runtime.ts`): timezone, system prompt, tools habilitadas.
6. Se invoca `runAgent()` → LangGraph ejecuta el grafo.
7. Se persisten mensajes en `agent_messages`.
8. Se devuelve respuesta al cliente.

### Telegram (`POST /api/telegram/webhook`)
1. Llega update (texto, voz, callback_query, o `/link CODE`).
2. **Voz**: se descarga el archivo de audio y se transcribe con Gemini Flash. Se envía eco `🎤 <transcripción>` al usuario antes de procesar.
3. Se autentica via `telegram_accounts` → `user_id`.
4. Se ejecuta el mismo pipeline de preprocesamiento que en web.
5. Se invoca `runAgent()`.
6. La respuesta se formatea con `formatMessageToHtml` (Markdown → HTML con soporte de Telegram).
7. Si hay `pending_confirmation`: se envían botones inline (Aprobar / Cancelar).

---

## Pipeline de preprocesamiento de mensajes

Módulo: `apps/web/src/lib/message-preprocessing.ts`

Orden de ejecución (igual en web y Telegram):

```
1. resolveDateReferences()
   └─ Reemplaza "próximo jueves" → "próximo jueves (jueves, 10 de abril de 2026 / 2026-04-10)"
      Evita que el LLM calcule fechas (fuente de errores).

2. injectSchedulingContinuation()   [prioridad más alta]
   └─ Detecta si estamos en un flujo de agendamiento activo leyendo el historial.
      Inyecta directiva con los datos ya recopilados y lo que falta.
      También maneja: pending_confirmation, contact-selection, post-cancellation.

3. injectDateContext()              [solo si (2) no modificó el mensaje]
   └─ En mensajes de seguimiento sin fecha explícita, busca la última ISO date
      en el historial e inyecta contexto para evitar que el LLM use fechas viejas.

4. injectSchedulingDirective()      [solo si (2) no modificó el mensaje]
   └─ Si hay intención de agendar en el mensaje actual, pide UN SOLO dato
      faltante a la vez (fecha → hora → asunto).
```

**Regex clave:**
- `SCHEDULE_INTENT_RE` — detecta intención de agendar
- `SCHEDULING_FLOW_RE` — detecta si el último mensaje del asistente era parte de un flujo activo
- `CONTACT_QUESTION_RE` — detecta preguntas sobre correos/contactos (incluye "y el de X")
- `CONTACT_OPTIONS_RE` — detecta si el asistente presentó una lista de opciones de contacto
- `AVAILABILITY_RESULT_RE` — detecta resultados de disponibilidad (requiere espacios: `HH:MM - HH:MM`)
- `REJECTION_RE` — detecta cancelaciones ("no", "cancela", "olvídalo")

---

## Herramientas disponibles (Tools)

Definidas en `packages/agent/src/tools/catalog.ts`, implementadas en `adapters.ts`.

| Tool ID                      | Riesgo | Descripción |
| ---------------------------- | ------ | ----------- |
| `bash`                       | alto   | Ejecuta comandos del sistema en una sesión persistente por nombre. Usa el shell real del host y siempre requiere confirmación. |
| `calendar_check_availability`| bajo   | Consulta `freeBusy` del calendario primario. Filtra slots < 30 min. |
| `calendar_list_events`       | bajo   | Lista eventos próximos con asistentes, links y ubicación. |
| `calendar_create_event`      | medio  | Crea evento (requiere confirmación). Pide Aprobar/Cancelar. |
| `contacts_lookup`            | bajo   | Busca contactos por nombre (Google People API). Devuelve todos los resultados. |
| `github_list_repos`          | bajo   | Lista repositorios del usuario. |
| `github_list_issues`         | bajo   | Lista issues de un repositorio. |
| `github_create_issue`        | medio  | Crea issue (requiere confirmación). |
| `github_create_repo`         | alto   | Crea repositorio (requiere confirmación). |

### Flujo de `contacts_lookup`
- Siempre hace una búsqueda fresca (el LLM no usa historial).
- **1 resultado**: muestra directamente el correo.
- **Múltiples resultados**:
  - *Fuera de flujo de agenda*: lista todos sin pedir confirmación.
  - *Dentro de flujo de agenda*: lista numerados y espera que el usuario elija.

### Flujo de `calendar_check_availability`
- Solo consulta el calendario `primary` del usuario.
- Preserva el rango horario solicitado (no expande a día completo).
- Filtra eventos de todo el día (duración ≥ 23 h).
- Filtra slots libres menores a **30 minutos**.

### Flujo de `bash`
- La sesión se identifica por `terminal` y se mantiene en memoria mientras viva el servidor.
- Si el usuario no envía `terminal`, se usa `default` automáticamente.
- Si la sesión no existe, se crea; si existe, se reutiliza.
- La ejecución real depende del host actual. En este entorno corre sobre `powershell.exe`.
- La salida de `stdout`/`stderr` se devuelve truncada cuando supera el límite configurado.
- Si el comando excede el timeout, la sesión se recicla para evitar contaminar ejecuciones posteriores.

---

## LangGraph: grafo

- **StateGraph** con dos nodos: `agent` (invoca modelo con tools) y `tools` (ejecuta tool calls).
- **Arista condicional** desde `agent`: si hay tool calls → `tools` → `agent`; si no → `__end__`.
- **MemorySaver** como checkpointer (`thread_id = session_id`).
- Máximo 6 iteraciones de tool para evitar loops.
- Tools de riesgo medio/alto → devuelven `pending_confirmation` en lugar de ejecutar.
- `bash` reutiliza el mismo flujo `interrupt + resume` usado por el resto de tools con confirmación.

---

## System prompt (`agent-runtime.ts`)

Generado dinámicamente en cada request. Incluye:
- Fecha y hora actual con timezone del usuario (`America/Bogota`, offset `-05:00`).
- Días de la semana próximos con fechas ISO (evita alucinaciones de fechas).
- Reglas de agendamiento multi-turno: un solo dato por mensaje, orden (fecha → hora → asunto).
- Reglas de `contacts_lookup`: siempre llamar la herramienta, nunca usar historial.
- Reglas de `calendar_create_event`: no pedir confirmación verbal, la herramienta lo hace.
- Reglas de rechazo: aceptar "no" inmediatamente sin alternativas.

---

## Modelo de datos

Ver migración en `packages/db/supabase/migrations/00001_initial_schema.sql`.

| Tabla                  | Descripción |
| ---------------------- | ----------- |
| `profiles`             | Datos del usuario (timezone, nombre) |
| `user_integrations`    | Tokens OAuth cifrados por integración (Google, GitHub) |
| `user_tool_settings`   | Tools habilitadas/deshabilitadas por usuario |
| `agent_sessions`       | Sesiones por canal (`web`, `telegram`). Estados: `active`, `closed` |
| `agent_messages`       | Historial de mensajes (role: user/assistant) |
| `tool_calls`           | Registro de llamadas a tools. Estados: `pending_confirmation`, `approved`, `rejected` |
| `telegram_accounts`    | Vinculación `telegram_id` ↔ `user_id` |
| `telegram_link_codes`  | Códigos de un solo uso para `/link CODE` |

---

## Seguridad

- **RLS** en todas las tablas con datos de usuario.
- **Allowlist de tools**: solo se montan las que el usuario habilitó Y tiene integración activa.
- **Confirmación humana**: tools de riesgo medio/alto generan `pending_confirmation`. Web: prompt UI. Telegram: botones inline.
- **Tool `bash`**: registra siempre el comando exacto en `tool_calls.arguments_json`, impone timeout y trunca salidas largas.
- **Tokens OAuth**: campo `encrypted_tokens` en `user_integrations` (cifrado AES con `OAUTH_ENCRYPTION_KEY`).
- **Webhook Telegram**: validado con `X-Telegram-Bot-Api-Secret-Token`.

---

## Canales

| Canal    | Entrada           | Formato respuesta        | Confirmaciones          |
| -------- | ----------------- | ------------------------ | ----------------------- |
| Web      | POST `/api/chat`  | Markdown renderizado     | Botones en UI           |
| Telegram | Webhook POST      | HTML (parse_mode=HTML)   | Inline keyboard buttons |
| Voz (TG) | Audio → Gemini Flash → texto | Mismo que texto | Mismo que texto |

---

## Variables de entorno requeridas

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# LLM
OPENROUTER_API_KEY=

# Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
TELEGRAM_WEBHOOK_BASE_URL=   # URL pública HTTPS (ej. ngrok). Puerto fijo: 3000

# Google OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# GitHub OAuth
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# Cifrado tokens OAuth
OAUTH_ENCRYPTION_KEY=        # 64 hex chars

# Transcripción de voz
GEMINI_API_KEY=
```

> **Nota**: El servidor corre en el puerto **3000**. Si se cambia el puerto, hay que actualizar el túnel ngrok y re-registrar el webhook de Telegram.
