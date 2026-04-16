# Nota de Validacion de Memoria Selectiva

## Estado

La fase principal de memoria selectiva quedó implementada, validada y desplegada en `main`.

## Qué se implementó

- derivación de `MemoryServiceScope` por servicio y para casos `general`
- filtrado selectivo de memorias en `flush`
- reranking y aislamiento de memorias en `retrieval`
- gobernanza por acción: `remember`, `suggest_only`, `never_automate`
- observabilidad detallada en `apps/web/logs/selective-memory.log`
- refuerzo del webhook de Telegram para resolver cuentas vinculadas con fallback y auto-repair
- manejo explícito de preferencias futuras para agenda
- robustecimiento del cierre de sesión en lenguaje natural
- saneamiento de respuestas HTML hacia Telegram para evitar listas crudas como `<ul><li>`

## Validación funcional realizada

Se validó comportamiento real en los scopes:

- `contacts`
- `github`
- `calendar`
- `general`

Resultados principales:

- `contacts` dejó de arrastrar memorias de `calendar`
- `github` dejó de caer en `general` y ya guarda/recupera preferencias propias
- las frases de preferencia futura ya no disparan acciones inmediatas en agenda y casos equivalentes validados
- una preferencia general como `prefiero respuestas breves` ya se guarda como `general`
- el `flush` ya reporta mejor sesiones mixtas mediante `detectedScope`, `dominantScope`, `userMessageScopes` y `keptScopes`
- las variantes naturales de cierre como `dejemoslo asi por ahora` ya disparan cierre y `flush`

## Limpieza operativa realizada

Antes del cierre de esta fase se eliminaron de la tabla `memories` dos remanentes viejos:

- una memoria híbrida que mezclaba `contacts` y `github`
- una memoria procedural derivada de directivas internas de `contacts_lookup`

La limpieza fue quirúrgica para conservar las memorias válidas recientes.

## Riesgos o temas pendientes

- todavía pueden existir memorias históricas antiguas no detectadas si en el futuro aparecen nuevos patrones híbridos
- `files` y `bash` no tuvieron una batería de validación tan profunda como `contacts`, `github` y `calendar`
- si el volumen de memorias crece mucho, podría valer la pena evolucionar de heurísticas a una estructura más explícita por servicio

## Commit de referencia

- `93f96d6 feat: implementar memoria selectiva por servicio`

