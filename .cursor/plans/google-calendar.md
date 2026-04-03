# Plan: Integración Google Calendar

## Arquitectura general

```mermaid
flowchart TD
    subgraph web [Settings - web "una vez"]
        A[Usuario en /settings] --> B[Clic en Conectar Google]
        B --> C[GET /api/integrations/google/authorize]
        C --> D["Google OAuth consent screen"]
        D --> E[GET /api/integrations/google/callback]
        E --> F["Cifrar tokens y guardar en user_integrations"]
    end

    subgraph telegram [Telegram - uso diario]
        G[Mensaje de texto] --> H[Webhook POST]
        I[Mensaje de voz] --> H
        H --> J["Transcribir si es voz (Whisper)"]
        J --> K[runAgent con integrationSecrets.google]
        K --> L[calendar_check_availability]
        K --> M[calendar_list_events]
        K --> N["calendar_create_event (confirmación)"]
    end

    F --> K
```

---

## Archivos nuevos creados

- `apps/web/src/lib/google-oauth.ts` - URL authorize, exchange code, refresh token
- `apps/web/src/lib/google-integration.ts` - cifrado/descifrado tokens, auto-refresh, get secret
- `apps/web/src/app/api/integrations/google/authorize/route.ts`
- `apps/web/src/app/api/integrations/google/callback/route.ts`
- `apps/web/src/app/api/integrations/google/disconnect/route.ts`
- `packages/agent/src/tools/google-calendar-client.ts`

## Archivos modificados

- `apps/web/src/app/settings/page.tsx`
- `apps/web/src/app/settings/settings-form.tsx`
- `apps/web/src/lib/agent-runtime.ts`
- `packages/agent/src/tools/catalog.ts`
- `packages/agent/src/tools/adapters.ts`
- `packages/agent/src/index.ts`
- `apps/web/src/app/api/telegram/webhook/route.ts`
- `apps/web/src/app/onboarding/steps/step-tools.tsx`

---

## Detalles de implementación

### Google OAuth (diferencia clave vs GitHub)
Google emite `access_token` (expira en 1h) + `refresh_token` (permanente). El helper `getGoogleIntegrationSecret` hace auto-refresh si el token expira en menos de 5 minutos.

Scopes: `https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events`

### Herramientas de calendario
- `calendar_check_availability` (riesgo: `low`) - POST /calendars/primary/freebusy
- `calendar_list_events` (riesgo: `low`) - GET /calendars/primary/events
- `calendar_create_event` (riesgo: `medium`, requiere confirmación) - POST /calendars/primary/events

### Soporte de voz en Telegram
1. `getFile` de Telegram API para obtener file_path
2. Descargar audio .oga desde api.telegram.org/file/...
3. Enviar a OpenAI Whisper (modelo `whisper-1`)
4. Usar texto transcripto como input del agente

### Variables de entorno necesarias
```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
OPENAI_API_KEY=...   # para Whisper
```

### Prerequisito manual en Google Cloud Console
1. Crear proyecto y habilitar Google Calendar API
2. Crear credenciales OAuth 2.0 (Web application)
3. Agregar URI de redirección: `http://localhost:3000/api/integrations/google/callback`
4. Copiar Client ID y Client Secret al `.env.local`
