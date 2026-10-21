# Mi asistencia · Sapientia

Sitio publicado: https://mi-asistencia-64e.pages.dev/

Repositorio: https://github.com/jmacpe/mi-asistencia (privado).

App para consultar tus materias en el portal de alumnos de la Universidad Católica de Paraguay y calcular cuántas clases completas podés faltar manteniendo al menos 75% de asistencia. Incluye una versión local con Python y una versión para Cloudflare Pages.

## Primer uso

1. Tené instalado **Python 3.10 o posterior**, disponible como `python` en Windows.
2. Extraé el ZIP en una carpeta propia (no ejecutes los archivos desde dentro del ZIP).
3. Hacé doble clic en **iniciar.cmd**. Se abre http://127.0.0.1:8765.
4. Elegí **Iniciar sesión en Sapientia** e ingresá tu propio usuario y contraseña.

La app descubre tus materias y períodos lectivos. En una cuenta nueva elige el período más reciente; podés elegir otro con el selector de semestre. Al reconectar la misma cuenta mantiene el período que estabas viendo.

Si una materia todavía no tiene calendario o resumen de asistencia válido, se muestra sin cálculo; no se inventa un margen de faltas.

## Asistencias y planes

- En **Mi registro**, marcá Vine, Falté o No sé. Las marcas personales prevalecen sobre el portal. “Usar Sapientia” restaura el dato oficial.
- En **Planificar faltas**, seleccioná fechas o una combinación sugerida. El porcentaje y el número de clases se recalculan al instante.
- Una clase equivale a un encuentro de una materia. El cálculo respeta las diferentes duraciones de cada día. Las filas de combinaciones son alternativas máximas, no se suman entre sí.
- Al pasar de día, una clase sin registrar queda pendiente. Confirmá si viniste para ajustar el margen.
- Objetivo de esta app: **75% global**. Verificá si tu materia exige un porcentaje distinto o mínimos separados por tipo de clase.

## Semanas de parciales

Cada cuenta y semestre empieza con dos semanas sin definir. Elegí cualquier día de cada semana: la app aplica de lunes a domingo y, según esa configuración personal, cuenta sus clases como presentes. Esas fechas desaparecen de las faltas posibles. Podés cambiar o quitar la semana; los registros y planes originales se conservan. Configurá esta regla solo si corresponde al criterio de tus materias.

## Cuentas y sincronización

- Los registros, planes y parciales se guardan **por cuenta y semestre** en esta computadora.
- “Cambiar cuenta” requiere iniciar sesión con las credenciales de la otra persona; no hereda tus marcas. Al volver a tu cuenta recuperás tus datos.
- “Cerrar sesión” oculta el perfil activo y elimina la conexión en memoria. Los archivos locales se conservan.
- “Desconectar” detiene la consulta automática y mantiene visible tu copia local.
- El servidor consulta Sapientia cada 15 minutos mientras esté abierto y conectado. Tus marcas nunca se envían al portal.
- La contraseña no se guarda. Las cookies viven solo en memoria; al reiniciar necesitás reconectar para consultar datos nuevos.
- Si la sesión expira o falla la actualización, se pausa la sincronización. Las marcas guardadas se mantienen.

Es una app local para uso personal, no un servicio compartido en red. Otra persona con acceso a tu carpeta de Windows puede leer sus datos locales.

## Guardado, cierre y respaldo

**cerrar.cmd** detiene el servidor. Cerrar solo la pestaña no lo detiene.

La app conserva el perfil activo en `app/data/state.json` y copias por cuenta y período en `app/data/accounts/`. Para un respaldo completo, cerrá la app y copiá `app/data/`. Descargar respaldo exporta el perfil activo sin credenciales; para restaurarlo, cerrá la app y reemplazá `app/data/state.json` por la copia.

También se puede ejecutar `python app/server.py`, abrir la dirección local y cerrar con Ctrl+C. Los iniciadores incluidos son para Windows.

## Compartir

Compartí **mi-asistencia-compartir.zip**, generado con `python empaquetar.py`. El paquete usa una lista explícita de archivos de la app: no incluye datos, cuentas, semillas personales, respaldos, pruebas con datos privados ni credenciales. Cada destinatario empieza con una pantalla de inicio de sesión vacía.

No compartas tu carpeta de trabajo completa ni `app/data/`.

## Publicación en Cloudflare Pages

La versión web usa `cloudflare/worker.js` como API de Pages y conserva las marcas, parciales y planes en el **localStorage de cada navegador**, separados por cuenta y semestre. No requiere una base de datos. No sincroniza tus marcas entre dispositivos y no importa automáticamente los archivos de la versión Python. Descargar respaldo permite conservar una copia; borrar los datos del sitio borra las marcas de ese navegador.

Las credenciales se transmiten por HTTPS al Worker y a Sapientia, solo para iniciar sesión. No se guardan contraseñas ni asistencias en Cloudflare. La sesión del portal queda cifrada y autenticada con AES-GCM en una cookie Secure, HttpOnly y SameSite, con vencimiento de 8 horas. Cada visitante tiene su propia sesión. La actualización automática se realiza cada 15 minutos mientras la página está abierta. Cerrar sesión oculta el perfil, conservando las marcas locales para el próximo acceso. Desconectar elimina las cookies del portal y conserva el registro visible hasta que venza la sesión.

El servidor Python sigue siendo exclusivamente local y no debe exponerse como servidor público compartido.

Para publicar desde este repositorio (Node.js 22 o posterior):

```powershell
npm ci
npm test
npm run build
npx wrangler login
npx wrangler pages project create mi-asistencia --production-branch main --force
node scripts/set-session-key.mjs mi-asistencia
npm run deploy
```

`SESSION_KEY` es una clave aleatoria de 32 bytes, guardada como secreto de Pages, nunca en Git o JavaScript público. El script la genera y envía por stdin sin imprimirla ni guardarla en disco. Cambiar esta clave cierra todas las sesiones existentes; ejecutarlo solo para configurar o rotar la clave.

El proyecto publicado ya existe y tiene `SESSION_KEY`: para actualizarlo basta con `npm run deploy`. El `--force` de la creación inicial evita que Wrangler convierta el proyecto nuevo a Workers; no se usa para las publicaciones siguientes.

El build genera `dist/` desde una lista de archivos de código y agrega `_worker.js`. No subir la carpeta de trabajo completa. La primera publicación por CLI crea un proyecto Direct Upload; las siguientes se hacen con `npm run deploy`. No se configura despliegue automático desde GitHub. Como alternativa, al crear un proyecto desde GitHub en el panel de Pages, usar `npm run build` como comando, `dist` como salida y configurar `SESSION_KEY` antes de usar el sitio.

Los archivos privados, ZIP, datos reales, registros y semillas están excluidos de Git mediante una lista explícita de rutas permitidas. Las pruebas públicas usan datos ficticios.

Referencia oficial: https://developers.cloudflare.com/pages/functions/

## Verificación para desarrollo

```powershell
npm test
python -m unittest discover -s app/tests -p test_accounts.py
```

Las pruebas cubren el mínimo de 75%, combinaciones completas, parciales, persistencia, paginación, cambio de cuentas y semestres sin mezclar registros, y errores del portal.
