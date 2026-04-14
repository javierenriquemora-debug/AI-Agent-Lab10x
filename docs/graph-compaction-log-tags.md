# Etiquetas del Log de Compaction

Guía rápida para interpretar `apps/web/logs/graph-compaction.log`.

## Cómo leer el flujo

Orden típico de un ciclo:

1. `COMPACTION_CYCLE_START`
2. `COMPACTION_LLM_SKIPPED` o `COMPACTION_LLM_START`
3. Si hubo intento LLM: `COMPACTION_LLM_SUCCESS`, `COMPACTION_LLM_EMPTY_RESULT` o `COMPACTION_LLM_FAILURE`
4. Si se acumularon demasiados fallos previos: `COMPACTION_CIRCUIT_BREAKER`

## Tabla de etiquetas

| Etiqueta | Qué significa | Cuándo aparece | Qué interpretar |
| --- | --- | --- | --- |
| `COMPACTION_CYCLE_START` | Inició un ciclo de evaluación del nodo de compaction. | En cada pasada por el nodo. | El sistema calculó tamaño estimado, umbral, porcentaje de umbral y aplicó microcompact antes de decidir si llama al LLM. |
| `COMPACTION_LLM_SKIPPED` | No se intentó resumir con LLM. | Cuando `estimatedUsageChars < thresholdChars`. | El historial todavía no supera el umbral configurado. Solo se aplicó microcompact. |
| `COMPACTION_NO_COMPACTABLE_SLICE` | No había bloque antiguo útil para resumir. | Cuando se alcanzó la fase de evaluación para LLM, pero no quedó tramo viejo fuera del tail protegido. | No hubo resumen LLM. El sistema conservó el historial microcompactado. |
| `COMPACTION_LLM_START` | Se inició un intento real de resumen con el modelo de compactación. | Cuando el umbral se supera y sí existe un bloque compactable. | El sistema va a resumir mensajes antiguos. |
| `COMPACTION_LLM_SUCCESS` | El resumen fue generado e inyectado en el contexto. | Cuando el LLM respondió con un resumen útil. | Sí hubo compactación real del historial. |
| `COMPACTION_LLM_EMPTY_RESULT` | El modelo respondió, pero no devolvió un resumen útil. | Cuando el resultado del LLM queda vacío o inservible tras sanitizarlo. | No se compactó de verdad. Se conserva microcompact y aumenta el contador de fallos. |
| `COMPACTION_LLM_FAILURE` | Falló el intento de compactación por LLM. | Ante errores del proveedor, timeout, credenciales, modelo o respuesta inválida. | Se conserva microcompact y aumenta el contador de fallos. |
| `COMPACTION_CIRCUIT_BREAKER` | El sistema dejó de intentar LLM temporalmente. | Cuando `compactionFailureCount >= COMPACTION_MAX_FAILURES`. | El compactador entra en modo defensa y solo hace microcompact. |

## Campos útiles del log

- `timestampUtc`: momento exacto en UTC.
- `timestampLocal`: momento exacto en hora local `America/Bogota`.
- `estimatedUsageChars`: tamaño estimado del contexto después de microcompact.
- `thresholdChars`: umbral absoluto calculado en caracteres.
- `thresholdRatio`: porcentaje configurado del umbral, por ejemplo `50.00%`.
- `clearedToolResults`: cantidad de outputs viejos de tools reemplazados por `[tool result cleared]`.

## Lectura rápida para pruebas

- Si ves `COMPACTION_LLM_SKIPPED`, el umbral todavía está alto para ese caso.
- Si ves `COMPACTION_LLM_START` y luego `COMPACTION_LLM_SUCCESS`, sí hubo compactación por LLM.
- Si ves `COMPACTION_LLM_START` y luego `COMPACTION_LLM_FAILURE`, el intento falló pero la conversación siguió.
- Si ves `COMPACTION_CIRCUIT_BREAKER`, primero conviene corregir el fallo repetido antes de seguir ajustando umbrales.
