# Microcompactación vs Compactación LLM

Guía breve para entender cómo funciona la gestión de memoria conversacional en este proyecto.

## Idea general

El sistema aplica dos niveles de optimización del contexto:

1. `Microcompactación`
2. `Compactación con LLM`

La microcompactación es barata y mecánica. La compactación con LLM es más potente, pero más costosa y se usa solo cuando el historial crece lo suficiente.

## 1. Microcompactación

### Qué es

Es una limpieza ligera del historial antes de decidir si vale la pena resumir con un LLM.

### Qué hace en este proyecto

- Revisa solo mensajes de tipo `tool`
- Conserva los últimos mensajes recientes
- Conserva además los últimos resultados de herramientas
- Reemplaza resultados viejos de tools por el marcador:
  - `[tool result cleared]`

### Qué no hace

- No resume la conversación
- No modifica el `systemPrompt`
- No borra mensajes del usuario
- No borra respuestas del asistente
- No reordena el historial

### Configuración actual

Según `apps/web/.env.local`:

- `COMPACTION_KEEP_LAST_MESSAGES=12`
- `COMPACTION_KEEP_LAST_TOOL_RESULTS=5`

Interpretación:

- Los últimos `12` mensajes quedan protegidos
- Los últimos `5` resultados de tools también quedan protegidos
- Los `ToolMessage` más viejos y no protegidos se reemplazan por `[tool result cleared]`

## 2. Compactación con LLM

### Qué es

Es un resumen inteligente del bloque antiguo del historial cuando el contexto ya creció demasiado.

### Cuándo se activa

Primero se calcula el tamaño estimado del contexto después de microcompactación.

Si el tamaño supera el umbral configurado, se intenta resumir con el modelo de compactación.

### Configuración actual

Según `apps/web/.env.local`:

- `COMPACTION_CONTEXT_WINDOW_CHARS=48000`
- `COMPACTION_THRESHOLD_RATIO=0.5`

Interpretación:

- El sistema estima una ventana de `48000` caracteres
- El umbral operativo es `50%`
- Por tanto, intenta compactación LLM cuando el contexto supera aproximadamente `24000` caracteres

### Qué resume

Cuando toca compactar, el historial se divide en:

- `leadingSystem`: prompt del sistema que se preserva
- `previousSummary`: resumen anterior, si ya existe
- `compactable`: bloque antiguo que sí se puede resumir
- `recentTail`: cola reciente que se conserva sin resumir

### Resultado

Si el resumen sale bien, el sistema reemplaza el bloque antiguo por un nuevo mensaje de sistema con prefijo:

- `[RESUMEN COMPACTADO DEL CONTEXTO]`

Ese resumen pasa a formar parte del contexto futuro.

## 3. Orden real del proceso

En cada ciclo del nodo:

1. Se toma `state.messages`
2. Se aplica microcompactación
3. Se estima tamaño del contexto
4. Si no supera el umbral: termina ahí
5. Si supera el umbral: intenta compactación con LLM
6. Si el LLM responde bien: inserta un resumen nuevo
7. Si falla: conserva microcompact y aumenta contador de fallos

## 4. Diferencia práctica entre ambas

| Aspecto | Microcompactación | Compactación LLM |
| --- | --- | --- |
| Costo | Muy bajo | Más alto |
| Velocidad | Muy rápida | Más lenta |
| Tipo de cambio | Mecánico | Semántico |
| Qué toca | Outputs viejos de tools | Bloque antiguo del historial |
| Riesgo de pérdida de matiz | Bajo | Medio |
| Cuándo corre | Siempre en el nodo | Solo si supera umbral |

## 5. Qué memoria se preserva

En términos prácticos, el sistema mantiene:

- `systemPrompt` actual
- Cola reciente de mensajes
- Últimos resultados relevantes de tools
- Resumen acumulado del pasado, si ya hubo compactación LLM

## 6. Riesgo principal

El riesgo de la microcompactación es bajo porque solo limpia outputs viejos de tools.

El riesgo mayor está en la compactación con LLM, porque ahí sí se reemplaza historia detallada por un resumen. Si el umbral es demasiado agresivo, puede sentirse pérdida de contexto o matiz conversacional.

## 7. Regla mental simple

Puedes pensarlo así:

- `Microcompactación`: "adelgazar outputs viejos"
- `Compactación LLM`: "convertir historia vieja en resumen útil"

## 8. Cómo leer esto en el log

- Si ves `COMPACTION_LLM_SKIPPED`, solo hubo microcompactación
- Si ves `COMPACTION_LLM_START` y luego `COMPACTION_LLM_SUCCESS`, hubo compactación LLM real
- Si ves `clearedToolResults > 0`, la microcompactación sí limpió resultados viejos de herramientas
