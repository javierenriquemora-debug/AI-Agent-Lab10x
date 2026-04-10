# Plan Para Tools De Gestion De Tareas Programadas

## Estado Actual
- El feature de scheduling ya está operativo sobre [packages/db/src/queries/scheduled-tasks.ts](packages/db/src/queries/scheduled-tasks.ts), [packages/agent/src/tools/catalog.ts](packages/agent/src/tools/catalog.ts), [packages/agent/src/tools/adapters.ts](packages/agent/src/tools/adapters.ts) y el dispatcher en [apps/web/src/app/api/cron/scheduled-tasks/route.ts](apps/web/src/app/api/cron/scheduled-tasks/route.ts).
- Hoy existe `create_scheduled_task`, pero no hay tools para listar ni cancelar tareas desde chat.
- El árbol actual del repo sigue con cambios sin commit; cuando salgamos de planificación, el primer paso operativo debe ser revisar `git status`/`git diff`, hacer commit y luego push.

## Alcance Propuesto
- Crear `list_scheduled_tasks` con riesgo `low`.
- Crear `cancel_scheduled_task` con riesgo `high`.
- Mantener la experiencia actual de confirmaciones genéricas para web/Telegram, reutilizando el flujo HITL existente.
- No incluir por ahora edición, pausa o reactivación de tareas.

## Cambios Principales
- En [packages/db/src/queries/scheduled-tasks.ts](packages/db/src/queries/scheduled-tasks.ts):
  - agregar una query de listado por usuario, con filtros opcionales como `status` y `limit`
  - agregar una query de cancelación por `task_id`, actualizando `status = 'cancelled'` y `updated_at`
- En [packages/db/src/index.ts](packages/db/src/index.ts):
  - exportar cualquier query nueva que haga falta
- En [packages/agent/src/tools/catalog.ts](packages/agent/src/tools/catalog.ts):
  - registrar `list_scheduled_tasks` como `low`
  - registrar `cancel_scheduled_task` como `high`
- En [packages/agent/src/tools/adapters.ts](packages/agent/src/tools/adapters.ts):
  - agregar schemas Zod para ambas tools
  - agregar ejecución en `routeToolExecution`
  - agregar definición en `buildLangChainTools`
  - agregar mensaje específico en `buildPendingToolReview` para la cancelación
- En [apps/web/src/app/settings/settings-form.tsx](apps/web/src/app/settings/settings-form.tsx):
  - añadir ambos `tool_id` para que se puedan habilitar en settings
- En [apps/web/src/lib/agent-runtime.ts](apps/web/src/lib/agent-runtime.ts):
  - reforzar reglas de uso para que el agente sepa cuándo listar tareas y cuándo cancelar una específica

## Decisiones De Implementacion
- `list_scheduled_tasks` debe devolver datos legibles para chat, no solo crudos:
  - `id`
  - `status`
  - `schedule_type`
  - `recurrence`
  - `run_at`
  - `next_run_at`
  - un `prompt` truncado o resumido para no exponer demasiado texto
- `cancel_scheduled_task` debe operar por `task_id` explícito para evitar ambigüedad.
- La cancelación debe aceptar principalmente tareas en `active` o `paused`; si la tarea ya está `completed` o `cancelled`, debe devolver un mensaje claro.
- La confirmación de cancelación debe mostrar contexto mínimo útil: `task_id`, próxima ejecución y resumen corto del `prompt`.

## Validacion
- Probar `list_scheduled_tasks` desde chat y Telegram con varias tareas activas.
- Probar `cancel_scheduled_task` sobre una tarea activa y verificar que deje de ser tomada por el cron.
- Verificar que una cancelación rechazada por HITL no cambie el estado.
- Verificar que las tools aparezcan en settings y se respeten los toggles de habilitación.

## Paso Posterior
- Al salir de modo planificación: hacer commit y push del estado actual del feature antes de implementar estas dos tools nuevas, para separar claramente el historial de cambios.
