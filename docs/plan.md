# Plan de Implementación — Agente Personal MVP

Construir un agente que permita a un usuario **gestionar tareas y ejecutar acciones útiles** desde chat: consultar calendario y correo, buscar documentos, disparar workflows internos, operar GitHub en casos acotados. El sistema debe priorizar **control, trazabilidad, seguridad y costos predecibles** por encima de “autonomía máxima”.

## Estado actual — Tareas programadas

### Ya implementado

- `[x]` Tool `create_scheduled_task` en `packages/agent/src/tools/catalog.ts`
- `[x]` Validación, confirmación y ejecución en `packages/agent/src/tools/adapters.ts`
- `[x]` Prompt del runtime con reglas para usar tareas programadas
- `[x]` Migración `00002_scheduled_tasks.sql`
- `[x]` Tablas `scheduled_tasks` y `scheduled_task_runs`
- `[x]` Queries en `packages/db/src/queries/scheduled-tasks.ts`
- `[x]` Endpoint cron `apps/web/src/app/api/cron/scheduled-tasks/route.ts`
- `[x]` Reingreso al agente usando una sesión dedicada `scheduled`
- `[x]` Notificación por Telegram para ejecuciones programadas
- `[x]` Apertura del endpoint cron en el middleware

### Pendiente operativo

- `[ ]` Configurar la variable `SCHEDULED_TASKS_CRON_SECRET`
- `[ ]` Crear el job en Supabase Cron para llamar `/api/cron/scheduled-tasks` cada minuto
- `[ ]` Verificar que la tool `create_scheduled_task` esté habilitada para el usuario de prueba
- `[ ]` Verificar que Telegram esté vinculado para el usuario de prueba
- `[ ]` Ejecutar prueba end-to-end de tarea `one_time`
- `[ ]` Ejecutar prueba end-to-end de tarea `recurring`
- `[ ]` Confirmar comportamiento cuando no existe cuenta de Telegram vinculada

### Paso a paso recomendado

1. Configurar `SCHEDULED_TASKS_CRON_SECRET` en el entorno donde corre `apps/web`.
2. Reiniciar o desplegar la aplicación para que tomen efecto la nueva tool y el endpoint cron.
3. Habilitar `create_scheduled_task` en la pantalla de settings del usuario con el que se va a probar.
4. Confirmar que ese usuario tenga cuenta de Telegram vinculada.
5. Crear en Supabase Cron un job que haga `POST` a `/api/cron/scheduled-tasks` cada minuto con el header `Authorization: Bearer <SCHEDULED_TASKS_CRON_SECRET>`.
6. Crear una tarea de prueba `one_time` para 2 o 3 minutos después.
7. Verificar en base de datos que aparezca en `scheduled_tasks`.
8. Esperar a la ejecución y revisar que se inserte un registro en `scheduled_task_runs`.
9. Confirmar que llegue el mensaje a Telegram.
10. Repetir la prueba con una tarea `recurring` y validar que `next_run_at` cambie después de la ejecución.

### Nota

- El checklist histórico de este documento sigue abajo, pero no refleja con precisión el estado actual del feature de tareas programadas.

## Fases y estado

### Fase 1: Fundaciones

- '[ ]' Monorepo Turborepo con npm workspaces
- '[ ]' `apps/web` — Next.js con App Router + Tailwind
- '[ ]' `packages/agent` — LangGraph JS + tools
- '[ ]' `packages/db` — cliente Supabase + queries tipadas
- '[ ]' `packages/types` — interfaces compartidas
- '[ ]' `packages/config` — tsconfig compartido
- '[ ]' `.env.example` con variables necesarias
- '[ ]' Migración SQL con RLS (`00001_initial_schema.sql`)

### Fase 2: Core agente

- '[ ]' Grafo LangGraph: `agent → tools → agent` con máx 6 iteraciones
- '[ ]' Modelo vía OpenRouter (ChatOpenAI con baseURL)
- '[ ]' Catálogo de tools con risk levels
- '[ ]' Adapters LangChain `tool()` con policy (allowlist + integración)
- '[ ]' Persistencia de mensajes en `agent_messages`
- '[ ]' API route `/api/chat` que orquesta todo

### Fase 3: Onboarding y UI

- '[ ]' Login y signup con Supabase Auth
- '[ ]' Middleware de protección de rutas
- '[ ]' Wizard onboarding multi-paso (perfil → agente → tools → revisión)
- '[ ]' Página de chat con interfaz de mensajes
- '[ ]' Página de ajustes (editar perfil, agente, tools, vincular Telegram)
- '[ ]' Redirect inteligente: `/` → `/onboarding` (si no completado) → `/chat`

### Fase 4: Tools con confirmación

- '[ ]' Tools internas: `get_user_preferences`, `list_enabled_tools`
- '[ ]' Tools GitHub (stub): `github_list_repos`, `github_list_issues`, `github_create_issue, github_create_repo`
- '[ ]' `github_create_issue` con riesgo "medium" → genera `pending_confirmation`
- '[ ]' Tabla `tool_calls` para tracking de estado

### Fase 5: Telegram

- '[ ]' Webhook en `/api/telegram/webhook`
- '[ ]' Comando `/start` con instrucciones
- '[ ]' Comando `/link CODE` para vincular cuenta
- '[ ]' Tabla `telegram_link_codes` con expiración
- '[ ]' Mismo `runAgent()` que web
- '[ ]' Confirmaciones con botones inline (aprobar/rechazar)
- '[ ]' Setup endpoint `/api/telegram/setup` para registrar webhook

### Fase 6: Documentación

- '[ ]' `docs/architecture.md` — arquitectura técnica viva
- '[ ]' `docs/plan.md`
