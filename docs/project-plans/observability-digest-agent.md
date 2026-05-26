# Observabilidad: cuándo y cómo “digerir” Langfuse / Sentry (y memoria)

Plan de reflexión — **sin implementación obligatoria**. Resume lo acordado en conversación para temas futuros.

## Problema

Langfuse y Sentry generan **mucho volumen** de información; intentar “entender todo el panel” cada día no escala. La pregunta útil es: **¿qué decisiones queremos tomar con esa data y con qué frecuencia?**

## Mental model (complementarios)

| Herramienta | Enfoque típico |
|-------------|----------------|
| **Sentry** | Incidentes, regresiones, errores 5xx, latencias anómalas → **alertas** y triage. |
| **Langfuse** | Calidad del agente: herramientas, coste, latencia LLM, prompts → **mejora continua** y evaluación. |

## Opciones de diseño (cuándo construir “agentes” u otra cosa)

1. **Primero (base sostenible)**  
   Vistas guardadas, umbrales, **alertas** y revisión periódica corta (p. ej. semanal). Muchos equipos se quedan aquí con buen ROI.

2. **Herramientas acotadas en el agente de producto**  
   Ej.: “resume los últimos N issues con tag X”, “lista traces fallidos de hoy”.  
   - Útil si el uso es **poco** y el **scope** está muy definido.  
   - Riesgo: mezclar operación con el agente conversacional.

3. **Job / agente analista independiente** (cron, n8n, script diario)  
   Genera un **informe** (Slack, email, archivo).  
   - Suele ser **más limpio** que meter el análisis en el agente de usuario.  
   - Mantiene políticas de acceso y scheduling fuera del chat.

## Riesgos si se usa LLM para resumir observabilidad

- **PII y secretos**: stack traces, payloads y logs no deben ir al modelo sin **filtrado**, minimización y política clara.  
- **Coste y ruido**: “leer todo” es caro y repetitivo.  
- **Mantenimiento**: el analista también evoluciona (APIs, dashboards).

## Compactación e inyección de memoria

La necesidad es más **gobernanza y depuración** que “más UI” cruda.

- Aprovechar **logs estructurados** ya existentes (flush, scopes, políticas).  
- Objetivo operativo: vistas del tipo “último flush por usuario”, “memorias por scope”, “rechazos por política”.  
- **Checks simples** antes de un segundo agente: p. ej. alertar si durante N días no hubo memorias persistidas cuando se esperaba actividad.

Un agente que “entienda” memoria puede tener sentido **después** de tener **métricas y consultas** auditables (SQL, admin), porque son más baratas y trazables.

## Orden recomendado (de menor a mayor complejidad)

1. Alertas + **dashboard mínimo** (pocas métricas que importen).  
2. **Script o job semanal** de resumen (opcionalmente sin LLM al principio).  
3. **Opcional**: agente o pipeline de resumen con **política de privacidad** y límites de contexto.

## Decisiones pendientes (cuando se retome)

- Caso de uso principal: ¿errores de prod, coste LLM, calidad de respuestas, o todo ponderado?  
- ¿Informes solo para el equipo interno o también exponer algo al usuario final?  
- Revisar impacto en memoria selectiva si el “digest” guardara conclusiones en producción (`memory-policy`, `memory-flush`, `memory-retrieval`, `message-preprocessing`) — solo si se cruza con preferencias de usuario.
