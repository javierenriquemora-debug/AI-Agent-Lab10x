# Memory by Service Guidelines

Guía práctica para definir qué memorias vale la pena guardar por servicio, cuáles no y cuáles solo deberían usarse como sugerencia.

## Principio general

La memoria larga debe privilegiar:

- preferencias estables del usuario
- restricciones durables
- hábitos explícitos
- patrones fuertes y repetidos

Debe evitar:

- hechos aislados o efímeros
- datos sensibles usados incidentalmente
- supuestos ambiguos
- automatizaciones silenciosas basadas solo en historial

## Tipos de memoria

- `semantic`: preferencias, restricciones, contexto durable, gustos, estilo deseado
- `procedural`: reglas operativas sobre cómo debe actuar el agente
- `episodic`: antecedentes concretos de una sesión que pueden ser útiles como referencia futura

## Agenda / Calendar

### Guardar

- preferencias de formato al listar agenda
- duración por defecto si el usuario la expresa varias veces
- zona horaria
- preferencias de confirmación antes de crear eventos

### No guardar

- asistentes de una sola reunión como regla permanente
- lugares o títulos aislados
- correos como memoria principal si la fuente real es `contacts_lookup`

### Usar solo como sugerencia

- participantes recurrentes por tema
- horarios habituales
- duración habitual

### Nunca automatizar sin confirmar

- invitar asistentes
- escoger correos
- crear eventos con defaults no explícitos

## Contactos

### Guardar

- preferencia por listas numeradas
- preferencia por ver todos los resultados vs uno solo

### No guardar

- correos como verdad persistente si ya pueden consultarse en fuente viva
- resultados aislados de búsqueda

### Usar solo como sugerencia

- la vez pasada elegiste este contacto entre varios

### Nunca automatizar sin confirmar

- seleccionar un contacto ambiguo
- asumir un correo solo por historial

## Tareas programadas

### Guardar

- canal preferido
- estilo deseado de recordatorios
- frecuencia preferida si es muy consistente

### No guardar

- contenido puntual de una tarea como preferencia global
- tareas ya vencidas como memoria durable

### Usar solo como sugerencia

- plantillas recurrentes de recordatorio

### Nunca automatizar sin confirmar

- programar una tarea nueva por analogía con otra vieja

## Bash

### Guardar

- preferencia por usar terminal por defecto
- nivel de detalle deseado al mostrar resultados

### No guardar

- comandos puntuales
- rutas temporales
- salidas del sistema

### Usar solo como sugerencia

- normalmente prefieres comandos simples primero

### Nunca automatizar sin confirmar

- ejecutar comandos riesgosos por costumbre

## Archivos

### Guardar

- preferencia por resúmenes breves o detallados
- preferencia por rutas relativas o por tipo de explicación

### No guardar

- rutas temporales específicas
- contenido exacto de archivos como memoria larga

### Usar solo como sugerencia

- formato favorito de resúmenes

### Nunca automatizar sin confirmar

- sobrescribir archivos
- asumir archivos destino por costumbre si hay ambigüedad

## GitHub

### Guardar

- estilo preferido de títulos de issues o PR
- nivel de detalle esperado en resúmenes

### No guardar

- nombres de ramas temporales
- repositorios o issues como supuestos permanentes si cambian mucho

### Usar solo como sugerencia

- plantillas de PR
- forma usual de redactar commits

### Nunca automatizar sin confirmar

- crear PR o issues en un repo ambiguo
- publicar cambios por patrón histórico

## Regla práctica para agendamiento

Si el usuario dice:

- `hazme un agendamiento`

la memoria larga puede ayudar a:

- sugerir formato
- recordar duración habitual
- sugerir candidatos probables si hay patrón fuerte

pero no debería:

- decidir sola con quién
- tomar un correo del pasado sin validación
- crear el evento con participantes asumidos

Ejemplo correcto:

- `¿Quieres que sea con Andrés Arenas? Lo has incluido antes en reuniones de indicadores.`

Ejemplo incorrecto:

- `Ya lo agendé con Andrés Arenas.`
