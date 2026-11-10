# Visitas Inmobiliarias

App para coordinar propiedades, visitas y ofertas entre brokers, asistentes y clientes.

## Cómo funcionan los usuarios

- **Superusuario**: entra con su cuenta de Google (su mail se configura en Netlify). Administra la lista de brokers, los invita, entra a cualquier ambiente y puede cambiar de rol para ver la app como Broker, Asistente o Cliente.
- **Broker**: recibe un link único del superusuario. Al ingresar con Google se crea **su ambiente**, donde es el administrador. Crea operaciones, aprueba propiedades y confirma visitas.
- **Asistente**: solo lo crea el broker, con un link único. Puede haber varios asistentes por broker. Cada uno ve **solo las operaciones que el broker le asigna** (se cambian desde Operación → Asistentes). Si un asistente crea una operación, queda asignado a ella.
- **Cliente**: lo invita el broker o un asistente, con un link para una operación. Ve solo esa búsqueda y solo las propiedades aprobadas (sin el teléfono del anunciante).
- **Cliente invitado por otro cliente**: un cliente puede invitar a otra persona (pareja, familiar) a **su misma búsqueda**, con los mismos permisos.

Cada link de invitación sirve para **una sola cuenta de Google** y vence en **14 días**. Se pueden anular antes.

## Qué hay en esta carpeta

- `index.html`: la app.
- `netlify/functions/api.mjs`: sesiones con Google, ambientes, invitaciones, operaciones, equipo, fotos y panel de superusuario.
- `netlify/functions/leer-aviso.mjs`: lee avisos de Zonaprop, RE/MAX, Argenprop y Mercado Libre.
- `netlify/lib/core.mjs`: reglas de permisos y utilidades compartidas.
- `netlify.toml` y `package.json`: configuración. Los datos se guardan en **Netlify Blobs** (incluido en Netlify, no hace falta otra cuenta).

## 1. Crear el acceso de Google (una sola vez)

1. Entrá a https://console.cloud.google.com y creá un proyecto (por ejemplo "Visitas Inmobiliarias").
2. **APIs y servicios → Pantalla de consentimiento de OAuth** (Google Auth Platform → Branding): tipo **Externo**, nombre de la app, tu mail de soporte. Guardá.
3. En **Público (Audience)** tocá **Publicar app** para que pueda entrar cualquier cuenta de Google. Como solo pide nombre y mail, no requiere verificación de Google.
4. **Credenciales → Crear credenciales → ID de cliente de OAuth** → tipo **Aplicación web**.
5. En **Orígenes de JavaScript autorizados** agregá la dirección de tu sitio, por ejemplo `https://visitas-inmobiliarias.netlify.app` (sin barra al final). Si después usás un dominio propio, agregalo también.
6. Copiá el **ID de cliente** (termina en `.apps.googleusercontent.com`).

## 2. Publicar en Netlify

Subí esta carpeta a un repositorio de GitHub (con la carpeta `netlify` incluida) y en Netlify: **Add new project → Import an existing project → GitHub**. Dejá los valores que propone. No uses "Netlify Drop" (arrastrar la carpeta): no publica las funciones.

## 3. Variables de entorno (obligatorias)

En Netlify: **Project configuration → Environment variables**:

| Variable | Valor |
|---|---|
| `GOOGLE_CLIENT_ID` | El ID de cliente del paso 1. |
| `AUTH_SECRET` | Una frase larga al azar (40 caracteres o más). Firma las sesiones. Si la cambiás, todos tienen que volver a ingresar. |
| `SUPERUSER_EMAILS` | Tu mail de Google. Si son varios superusuarios, separalos con coma. |

Opcionales para la lectura de avisos: `ML_CLIENT_ID`, `ML_CLIENT_SECRET` (Mercado Libre) y `SCRAPINGBEE_API_KEY` (portales que bloquean, como Zonaprop).

Después de cargarlas: **Deploys → Trigger deploy → Deploy project**.

## 4. Primer uso

1. Abrí tu sitio y tocá **Continuar con Google** con el mail de superusuario. Entrás al panel **Brokers**.
2. **Invitar broker** → nombre y nombre de la inmobiliaria → copiá el link o mandalo por WhatsApp.
3. El broker abre el link, entra con Google y crea su primera operación.
4. Desde **Operación**, el broker invita asistentes (eligiendo qué operaciones ven) y clientes.

Para revisar la configuración: `https://TU-SITIO.netlify.app/api/config` tiene que mostrar `"google":true,"secret":true,"superuser":true`.

## Guardado y trabajo en equipo

- Los cambios se guardan solos en el servidor (arriba aparece "Guardado").
- La app trae los cambios de los demás cada 20 segundos y al volver a la pestaña.
- Si dos personas editan la misma operación a la vez, gana el primero que guarda y al segundo se le actualiza la pantalla con aviso.
- Las fotos se suben al servidor. Las fotos que vienen de los portales se guardan como link al portal.

## Prueba sin servidor

Abriendo `index.html` directo en el navegador (o la versión de prueba en Claude), la app funciona en **modo de prueba**: guarda en ese navegador y deja cambiar de rol libremente.
