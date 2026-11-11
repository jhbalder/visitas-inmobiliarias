# Visitas Inmobiliarias

App para coordinar propiedades, visitas y ofertas entre brokers, asistentes y clientes.

## Cómo funcionan los usuarios

- **Superusuario**: entra con su cuenta de Google (su mail se configura en Netlify). Desde el panel **Brokers** invita brokers (cada uno recibe su ambiente) y puede **crear ambientes propios** con «Nuevo ambiente», donde actúa como broker. Entra a cualquier ambiente y cambia de rol (Broker, Asistente o Cliente) desde el menú de la cuenta. En cualquier ambiente puede invitar o asignar brokers.
- **Broker**: recibe un link del superusuario (se le crea su ambiente) o lo suman a un ambiente existente. Puede **crear más ambientes** (selector de ambiente → «Nuevo ambiente») y **sumar otros brokers** a cualquier ambiente donde es broker: Operación → **Brokers del ambiente** → «Invitar broker» (link) o «Asignar broker existente» (por mail, sin link). Un ambiente puede tener varios brokers, todos con los mismos permisos; se puede quitar a cualquiera menos al último.
- **Asistente**: solo lo crea el broker, con un link único. Puede haber varios asistentes por broker. Cada uno ve **solo las operaciones que el broker le asigna** (se cambian desde Operación → Asistentes). Si un asistente crea una operación, queda asignado a ella.
- **Broker solo en una operación**: un broker del ambiente puede sumar a otro broker a **una operación puntual** (Operación → Brokers solo en esta operación). Trabaja esa operación como broker (aprueba propiedades, confirma visitas, invita clientes), pero no ve el resto del ambiente, no crea operaciones ni maneja el equipo. Si ese broker tiene su propio ambiente, cambia entre los dos desde el selector de arriba. El superusuario también puede **asignar un broker existente** a una operación sin link: entra al ambiente, elige la operación y va a Operación → Brokers solo en esta operación → **Asignar a esta operación**.
- **Cliente**: lo invita el broker o un asistente, con un link para una operación. Ve solo esa búsqueda y solo las propiedades aprobadas (sin el teléfono del anunciante).
- **Cliente invitado por otro cliente**: un cliente puede invitar a otra persona (pareja, familiar) a **su misma búsqueda**, con los mismos permisos.

## Seguimiento de cada propiedad

Por aprobar → Nuevas → Leídas → Agendar visita → Por visitar → Oferta → En negociación → Reservada → Firma de escritura (y Descartadas aparte).

- **Por aprobar**: el broker todavía no la aprobó. En Operación → «Propiedades del asistente», el broker elige si las que carga el asistente esperan su aprobación o pasan directo al cliente.
- **Nuevas / Leídas**: el cliente la tiene para ver / la abrió pero no decidió.
- **Agendar visita**: el cliente tocó «Quiero verla». Recién ahí se puede agendar.
- **Por visitar**: tiene visita confirmada.
- **Oferta**: el cliente quiere ofertar, sin formalizar.
- **En negociación**: exige subir el **recibo del adelanto** (y se pueden sumar otros documentos de la oferta).
- **Reservada**: exige subir la **oferta final firmada** y el **recibo del dinero**.
- **Firma de escritura**: exige cargar **lugar** y **fecha** de la firma.

Los documentos (PDF, foto o Word, hasta 5 MB) se guardan en Netlify Blobs y solo los pueden abrir las personas con acceso a esa operación.

Cada link de invitación sirve para **una sola cuenta de Google** y vence en **14 días**. Se pueden anular antes.

## Qué hay en esta carpeta

- `index.html`: la app.
- `netlify/functions/api.mjs`: sesiones con Google, ambientes, invitaciones, operaciones, equipo, fotos y panel de superusuario.
- `netlify/functions/leer-aviso.mjs`: lee avisos de Zonaprop, RE/MAX, Argenprop y Mercado Libre.
- `netlify/lib/core.mjs`: reglas de permisos y utilidades compartidas.
- `netlify/lib/parsers.mjs`: lectores de avisos por portal (los usa el servidor y el favorito).
- `favorito/`: código del favorito «Enviar a Visitas» y su compilador.
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

### Opcional: direcciones con Google Maps

Al escribir una dirección a mano, la app sugiere direcciones. Con la variable `GOOGLE_MAPS_API_KEY` las sugerencias salen de Google Maps; sin ella, de OpenStreetMap.

1. En [Google Cloud Console](https://console.cloud.google.com/), en el mismo proyecto del acceso con Google: **APIs y servicios → Biblioteca → Places API (New) → Habilitar** (pide tener la facturación activada; el uso de una inmobiliaria suele entrar en el crédito gratuito mensual).
2. **APIs y servicios → Credenciales → Crear credenciales → Clave de API**. En «Restricciones de API» elegí solo **Places API (New)**.
3. En Netlify: **Site configuration → Environment variables → Add a variable**: `GOOGLE_MAPS_API_KEY` con esa clave. Después **Deploys → Trigger deploy**.

## 4. Primer uso

1. Abrí tu sitio y tocá **Continuar con Google** con el mail de superusuario. Entrás al panel **Brokers**.
2. Para trabajar vos como broker: **Nuevo ambiente** → nombre → creá la primera operación. Después, en Operación → Brokers del ambiente, invitá o asigná otros brokers.
3. Para darle a un broker su propio ambiente: **Invitar broker** → nombre y nombre de la inmobiliaria → copiá el link o mandalo por WhatsApp. El broker abre el link, entra con Google y crea su primera operación.
4. Desde **Operación**, el broker invita asistentes (eligiendo qué operaciones ven) y clientes.

Para revisar la configuración: `https://TU-SITIO.netlify.app/api/config` tiene que mostrar `"google":true,"secret":true,"superuser":true`.

## Lectura de avisos por portal

Cada portal tiene su propia lectura (`netlify/functions/leer-aviso.mjs`):

- **Mercado Libre**: API oficial (con `ML_CLIENT_ID`/`ML_CLIENT_SECRET`) o la página pública. Título, precio, expensas, m² totales y cubiertos, ambientes, baños, cocheras, piso, pisos, balcón, dirección («Zapiola 2100, Capital Federal») y localidad («Belgrano R, Capital Federal»).
- **RE/MAX**: API pública del sitio (`api-ar.redremax.com/.../listings/findBySlug`). Precio, expensas, m² totales y cubiertos, ambientes, baños, cocheras, piso (de la descripción), pisos, balcón, dirección, localidad, teléfono del agente y fotos. Las fotos de RE/MAX solo cargan sin encabezado «Referer», por eso todas las imágenes de la app usan `referrerpolicy="no-referrer"`.
- **Argenprop**: título («Quesada 2800 Venta en Belgrano, CABA»), dirección completa, localidad, precio, expensas, características («Cant. Ambientes», «Sup. Total», «Sup. Cubierta», «Tipo de Balcón», «Cant. Pisos») y la galería completa (`/aviso/gallerypartial`).
- **Zonaprop y otras inmobiliarias**: no se leen. Se guarda solo el link y, al tocar la tarjeta, se abre el aviso original en una pestaña nueva. Se pueden completar datos a mano (y con el favorito, desde el navegador, Zonaprop todavía se puede traer).

Si un aviso no se lee bien, en la app tocá **¿Faltan datos? Copiar diagnóstico** y pasáselo a quien mantenga la app.

## Favorito «Enviar a Visitas»

Sirve para traer un aviso desde el navegador de la persona, aunque el portal bloquee la lectura desde el servidor (típico de Zonaprop). Funciona con Zonaprop, Argenprop, RE/MAX y Mercado Libre, en computadora.

- **Instalar:** en la app, **Operación → Favorito «Enviar a Visitas» → Instalar el favorito** (o desde "Agregar propiedad"). Se arrastra el botón verde a la barra de favoritos. Cada persona lo instala una vez en cada navegador.
- **Usar:** abrir la página del aviso en el portal y tocar el favorito. Se abre Visitas con el formulario completo (datos y fotos), se elige la operación y se guarda.
- Los datos viajan en la dirección de la app después del `#`, que no se envía a ningún servidor.
- El favorito queda atado a la dirección desde donde se instaló. Si cambiás el dominio del sitio, hay que reinstalarlo.

**Para modificar el favorito** (solo si cambian los lectores en `netlify/lib/parsers.mjs` o `favorito/enviar-a-visitas.src.mjs`):
```
npm install --no-save esbuild@0.24.2
node favorito/build.mjs
```
Esto regenera `favorito/enviar-a-visitas.min.js` y lo inserta en `index.html`. Después hay que reinstalar el favorito en los navegadores.

## Guardado y trabajo en equipo

- Los cambios se guardan solos en el servidor (arriba aparece "Guardado").
- La app trae los cambios de los demás cada 20 segundos y al volver a la pestaña.
- Si dos personas editan la misma operación a la vez, gana el primero que guarda y al segundo se le actualiza la pantalla con aviso.
- Las fotos se suben al servidor. Las fotos que vienen de los portales se guardan como link al portal.

## Prueba sin servidor

Abriendo `index.html` directo en el navegador (o la versión de prueba en Claude), la app funciona en **modo de prueba**: guarda en ese navegador y deja cambiar de rol libremente.
