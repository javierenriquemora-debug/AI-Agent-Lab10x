# Plan Corregido: Long-Term Memory

## Hallazgos Consolidados

### Pieza 1: mensaje base para retrieval
- El nodo de recuperación debe usar el ultimo `HumanMessage` del turno actual, no el primero.
- Base técnica: `packages/agent/src/graph.ts` arma `messages` como `SystemMessage + priorMessages + HumanMessage(actual)`.
- Riesgo que corrige: búsquedas vectoriales con el mensaje equivocado y recuerdos irrelevantes.

### Pieza 2: dónde inyectar la memoria
- No basta con actualizar `state.systemPrompt`; el modelo hoy responde con `state.messages`.
- La memoria debe entrar en el primer `SystemMessage` efectivo que ve el LLM, no en un campo del estado que luego no se consume.
- Opción recomendada de menor impacto: enriquecer el prompt antes de construir `new SystemMessage(...)` en `packages/agent/src/graph.ts`, o centralizarlo en `apps/web/src/lib/agent-runtime.ts` y seguir inyectándolo en el primer `SystemMessage`.
- Evitar un segundo `SystemMessage` separado para memoria, porque `packages/agent/src/nodes/compaction-node.ts` solo preserva el primer `SystemMessage` como `leadingSystem`.

### Pieza 3: cuándo hacer flush
- Hacer `flushSessionMemory()` al final de `chat/route.ts` no es post-sesión; es post-mensaje.
- El flush debe dispararse cuando la sesión realmente se cierre, o mediante procesamiento incremental con watermark.
- Base técnica: hoy hay cierres en múltiples puntos, no solo en web chat: `apps/web/src/app/api/chat/route.ts`, `apps/web/src/app/api/telegram/webhook/route.ts`, `apps/web/src/app/api/cron/scheduled-tasks/route.ts` y rotación de sesiones en `packages/db/src/queries/sessions.ts`.

## Gaps Consolidados

### Gap 1: definición de sesión cerrada
- Adoptar estrategia híbrida:
- `status = closed` como señal explícita cuando ya existe.
- timeout de inactividad como regla complementaria para sesiones activas que nadie cerró explícitamente.
- watermark por sesión para evitar reprocesar el mismo tramo histórico.

### Gap 2: deduplicación / repetición
- Agregar deduplicación mínima en memoria persistida.
- Usar hash normalizado por `user_id + type + content_normalized` o verificación previa por contenido exacto.
- Guardar metadatos de origen (`source_session_id`, `source_message_range` o `last_flushed_message_id`) para no extraer lo mismo dos veces.

### Gap 3: presupuesto de memoria inyectada
- Limitar recuperación a `topK` pequeño (`5-8`) y además un presupuesto de caracteres/tokens para el bloque `[MEMORIA DEL USUARIO]`.
- Si el resultado excede el presupuesto, truncar por score/relevancia antes de anexarlo al prompt.
- Esto evita reintroducir `Context Rot` por memoria larga.

## Arquitectura Corregida

```mermaid
flowchart TD
    subgraph runtime [Per Turn Runtime]
        startNode[Start] --> retrieveNode[RetrieveRelevantMemories]
        retrieveNode --> buildPrompt[BuildFirstSystemMessage]
        buildPrompt --> compactionNode[CompactionNode]
        compactionNode --> agentNode[AgentNode]
        agentNode --> toolsNode[ToolsNode]
        toolsNode --> compactionNode
    end

    subgraph closeFlow [Post Session Or Incremental Flush]
        sessionClose[SessionClosedOrInactive] --> flushNode[FlushSessionMemory]
        flushNode --> extractNode[ExtractMemoriesLLM]
        extractNode --> embedNode[GenerateEmbeddings]
        embedNode --> saveNode[SaveDedupedMemories]
    end
```

## Decisiones de Implementación

### Retrieval / injection
- Crear búsqueda vectorial y recuperación por `userId` en `packages/db/src/queries/memories.ts`.
- Crear embeddings en `packages/agent/src/embeddings.ts` con proveedor configurable, no atado rígidamente a OpenRouter.
- Integrar recuperación antes de armar el `SystemMessage` efectivo del turno en `packages/agent/src/graph.ts` o en `apps/web/src/lib/agent-runtime.ts`.
- Inyectar como bloque textual único `[MEMORIA DEL USUARIO]` dentro del mismo prompt base.

### Flush / extraction
- Crear `flushSessionMemory()` en `packages/agent/src/memory-flush.ts`.
- No dispararlo desde un único route handler.
- Centralizar el disparo donde la sesión pase a `closed`, o crear un job de barrido de sesiones inactivas que:
  - marque sesiones vencidas como `closed`
  - haga flush solo de sesiones no procesadas
- Guardar watermark por sesión para soportar reintentos e idempotencia.

### DB / schema
- Crear migración para tabla `memories` y soporte `pgvector`.
- Añadir estrategia de búsqueda vectorial completa: tabla + índice + función SQL/RPC para similarity search.
- Añadir campos mínimos de control: `retrieval_count`, `last_retrieved_at`, `source_session_id`, `dedupe_hash` y/o marcador de progreso por sesión.

### Compatibilidad con compaction
- No tocar la lógica base de `packages/agent/src/nodes/compaction-node.ts`.
- Asegurar que la memoria inyectada quede dentro del primer `SystemMessage`, para que `leadingSystem` la preserve naturalmente.
- Evitar múltiples bloques de sistema paralelos que luego puedan perderse o duplicarse.

## Validación
- Probar recuperación cross-session usando el mismo `userId` con una sesión nueva.
- Verificar que la memoria inyectada sí aparezca en el `SystemMessage` efectivo y no solo en un campo del estado.
- Verificar que un mismo recuerdo no se guarde repetidamente tras varios flushes.
- Verificar que Telegram, web y `scheduled` puedan detonar flush indirectamente cuando corresponda.
- Medir el tamaño agregado del bloque `[MEMORIA DEL USUARIO]` frente al umbral de compactación actual.
