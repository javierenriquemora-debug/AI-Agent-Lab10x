# Observabilidad con Langfuse Cloud (agente en Railway / otros hosts)

El código del monorepo ya incluye:

- `apps/web/src/instrumentation.ts` — arranca OTEL con `LangfuseSpanProcessor` (`@langfuse/otel`).
- `packages/agent/src/graph.ts` + `packages/agent/src/langfuse-graph.ts` — `CallbackHandler` de `@langfuse/langchain` en la invocación del grafo.
- Variables leídas por el SDK: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`.

No hace falta cambiar código para pasar de Langfuse local a Cloud; solo **variables de entorno** en el entorno donde corre el agente.

## 1. Langfuse Cloud

1. Entrar en [Langfuse Cloud](https://cloud.langfuse.com) (o la URL/región que corresponda al crear el proyecto).
2. Crear (o seleccionar) un **proyecto**.
3. **Settings → API keys** (Project API keys): copiar **Public key** (`pk-lf-...`) y **Secret key** (`sk-lf-...`).
4. Anotar la **base URL** del tenant/región (p. ej. `https://cloud.langfuse.com` si aplica a tu cuenta).

## 2. Variables en el despliegue del agente

En el servicio que ejecuta Next.js (`@agents/web`), definir:

| Variable | Valor |
|----------|--------|
| `LANGFUSE_BASE_URL` | URL base de Langfuse Cloud (**no** `http://localhost:...`) |
| `LANGFUSE_PUBLIC_KEY` | `pk-lf-...` |
| `LANGFUSE_SECRET_KEY` | `sk-lf-...` |

Opcional recomendado en serverless / rutas cortas:

| Variable | Valor |
|----------|--------|
| `LANGCHAIN_CALLBACKS_BACKGROUND` | `false` |

Tras cambiar variables: **redeploy** o **restart** del servicio.

## 3. Local (`apps/web/.env.local`)

Para probar contra Cloud desde tu máquina, usar las **mismas** tres variables (`LANGFUSE_BASE_URL` + keys de Cloud). Para Langfuse **solo en local**, usar `LANGFUSE_BASE_URL=http://localhost:3001` (u otro puerto mapeado).

## 4. Recordatorio importante

- **`localhost` en Railway/GCP/etc.** apunta al **contenedor/servidor**, no a tu PC. Las trazas del agente desplegado **no** llegarán a un Langfuse que solo corre en tu máquina.
- El agente en **Telegram** suele hablar con el backend **desplegado**; ahí las variables deben ser Cloud (o un Langfuse **público** self-hosted).

## 5. Railway: template Langfuse v3 en la nube

El template oficial puede requerir **varios volúmenes**; en planes con límite de volúmenes por proyecto puede fallar el deploy one-click. En ese caso, **Langfuse Cloud** suele ser el camino más simple para observabilidad sin operar el stack completo.

## Referencias útiles

- Integración LangChain / Langfuse (callbacks + OTEL): [Langfuse — LangChain](https://langfuse.com/integrations/frameworks/langchain)
- Langfuse self-host (alternativa a Cloud): [Self-hosting](https://langfuse.com/self-hosting)

---

## Si el agente corre en GCP en lugar de Railway

El **mejor escenario habitual** para “activar observabilidad” con poca fricción sigue siendo:

1. **Langfuse Cloud** + las mismas tres variables en el runtime del agente en GCP (Cloud Run, GKE, VM, etc.), siempre que el servicio tenga **salida HTTPS** a Internet hacia la URL de Cloud.

Ventajas: sin montar ClickHouse/Redis/MinIO/Postgres de Langfuse en GCP.

Si por **compliance, datos o política** no puedes usar SaaS:

2. **Self-host Langfuse en GCP** (p. ej. GKE con Helm, o VM + Docker Compose adaptado), exponiendo una **URL HTTPS** estable y configurando en el agente `LANGFUSE_BASE_URL` hacia ese host + keys del proyecto self-hosted.

En ambos casos la clave es: **el proceso del agente debe poder alcanzar `LANGFUSE_BASE_URL` por red**; no usar `localhost` salvo que Langfuse corra en el mismo host/red explícita.
