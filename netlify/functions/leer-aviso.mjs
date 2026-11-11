// Lee un aviso de Zonaprop, RE/MAX, Argenprop o Mercado Libre y devuelve sus datos.
// GET /api/leer-aviso?url=<link del aviso>
// Respuesta: { portal, url, source, fields: {...}, photos: [...], text }
//   fields: title, price, currency, expensas, m2, amb, banos, cocheras, piso, pisos, address, barrio, phone
//   text: texto plano del aviso; la app lo usa para completar lo que falte.
//
// Variables de entorno opcionales (Netlify > Site configuration > Environment variables):
//   ML_CLIENT_ID, ML_CLIENT_SECRET  Credenciales de una app de Mercado Libre (developers.mercadolibre.com.ar).
//                                   Sin ellas se intenta leer la página pública del aviso.
//   SCRAPINGBEE_API_KEY             Servicio pago para los portales que bloquean la lectura directa (Zonaprop).

const PORTALS = [
  { domain: "zonaprop.com.ar", name: "Zonaprop" },
  { domain: "remax.com.ar", name: "RE/MAX" },
  { domain: "argenprop.com", name: "Argenprop" },
  { domain: "mercadolibre.com.ar", name: "Mercado Libre" }
];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

import { requireUser, HttpError } from "../lib/core.mjs";
import { PHOTO_HOSTS, MAX_PHOTOS, REMAX_CDN, parseHtml, mapRemaxApi, parseRemax, parseArgenprop, parseZonaprop, parseMercadoLibre, num, numOrText, clean } from "../lib/parsers.mjs";
export { parseHtml, mapRemaxApi, parseRemax, parseArgenprop, parseZonaprop, parseMercadoLibre };

export const config = { path: "/api/leer-aviso" };

export default async (req) => {
  // Solo usuarios con sesión pueden usar la lectura de avisos.
  try { await requireUser(req); }
  catch (e) { return json({ error: e.code || "sesion", message: e.message }, e.status || 401); }
  const u = new URL(req.url);
  let target = (u.searchParams.get("url") || "").trim();
  if (!target) return json({ error: "falta_link", message: "Falta el link del aviso." }, 400);
  if (!/^https?:\/\//i.test(target)) target = "https://" + target;

  let t;
  try { t = new URL(target); } catch { return json({ error: "link_invalido", message: "El link no es válido." }, 400); }
  const host = t.hostname.replace(/^www\./, "").toLowerCase();
  const portal = PORTALS.find(p => host === p.domain || host.endsWith("." + p.domain));
  if (!portal) return json({ error: "portal_no_soportado", message: "Por ahora se leen avisos de Zonaprop, RE/MAX, Argenprop y Mercado Libre." }, 400);

  try {
    let result = null;
    if (portal.domain === "mercadolibre.com.ar") result = await fromMercadoLibreApi(t.href);
    else if (portal.domain === "remax.com.ar") result = await fromRemax(t.href);
    else if (portal.domain === "argenprop.com") result = await fromArgenprop(t.href);
    else if (portal.domain === "zonaprop.com.ar") result = parseZonaprop(await fetchHtml(t.href), t.href);
    if (!result && portal.domain === "mercadolibre.com.ar") result = parseMercadoLibre(await fetchHtml(t.href), t.href);
    if (!result) result = await fromHtml(t.href);
    // Teléfono: solo si parece un número real (8 dígitos o más)
    if (result.fields && result.fields.phone && String(result.fields.phone).replace(/\D/g, "").length < 8) delete result.fields.phone;
    result.portal = portal.name;
    result.url = t.href;
    return json(result, 200, { "cache-control": "public, max-age=900" });
  } catch (e) {
    return json({ error: e.code || "error", message: e.message || "No se pudo leer el aviso.", portal: portal.name }, e.status || 502);
  }
};

/* ---------------- Mercado Libre (API oficial) ---------------- */
let mlToken = null, mlTokenExp = 0;
async function getMlToken() {
  const id = process.env.ML_CLIENT_ID, secret = process.env.ML_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (mlToken && Date.now() < mlTokenExp) return mlToken;
  const r = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
    signal: AbortSignal.timeout(5000)
  });
  if (!r.ok) return null;
  const j = await r.json();
  mlToken = j.access_token; mlTokenExp = Date.now() + ((j.expires_in || 3600) - 120) * 1000;
  return mlToken;
}

async function fromMercadoLibreApi(href) {
  const m = href.match(/MLA-?(\d{6,})/i);
  if (!m) return null;
  const id = "MLA" + m[1];
  const token = await getMlToken().catch(() => null);
  const headers = { accept: "application/json", ...(token ? { authorization: "Bearer " + token } : {}) };
  const r = await fetch(`https://api.mercadolibre.com/items/${id}`, { headers, signal: AbortSignal.timeout(6000) }).catch(() => null);
  if (!r || !r.ok) return null; // sin acceso a la API: se intenta con la página pública
  const it = await r.json();
  const attr = {};
  for (const a of it.attributes || []) attr[a.id] = a.value_struct?.number ?? numOrText(a.value_name);
  let text = "";
  const d = await fetch(`https://api.mercadolibre.com/items/${id}/description`, { headers, signal: AbortSignal.timeout(4000) }).catch(() => null);
  if (d && d.ok) { const dj = await d.json(); text = dj.plain_text || ""; }
  const loc = it.location || {};
  const fields = clean({
    title: it.title,
    price: it.currency_id === "USD" ? it.price : null,
    currency: it.currency_id,
    priceOther: it.currency_id !== "USD" ? it.price : null,
    expensas: num(attr.MAINTENANCE_FEE),
    m2: num(attr.TOTAL_AREA) ?? num(attr.COVERED_AREA),
    amb: num(attr.ROOMS),
    banos: num(attr.FULL_BATHROOMS),
    cocheras: num(attr.PARKING_LOTS),
    piso: attr.UNIT_FLOOR ?? null,
    pisos: num(attr.FLOORS),
    address: loc.address_line || null,
    barrio: loc.neighborhood?.name || null
  });
  const photos = (it.pictures || []).map(p => p.secure_url || p.url).filter(Boolean).slice(0, MAX_PHOTOS);
  return { source: "api_mercadolibre", fields, photos, text: [it.title, text].filter(Boolean).join("\n") };
}

/* ---------------- Página del aviso (HTML) ---------------- */
async function fetchHtml(href) {
  let html = "", status = 0, blocked = false;
  try {
    const r = await fetch(href, {
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml", "accept-language": "es-AR,es;q=0.9" },
      redirect: "follow",
      signal: AbortSignal.timeout(7000)
    });
    status = r.status;
    html = await r.text();
    // Solo se considera bloqueo una página de verificación real (Cloudflare / "Just a moment"), no la mención de reCAPTCHA en el código.
    blocked = !r.ok || /<title>\s*(Just a moment|Attention Required|Un momento)|cf-chl-|challenge-platform|cf-turnstile/i.test(html.slice(0, 20000)) || html.length < 2000;
  } catch {
    blocked = true;
  }
  if (!blocked) return html;

  const key = process.env.SCRAPINGBEE_API_KEY;
  if (key) {
    const q = new URLSearchParams({ api_key: key, url: href, country_code: "ar", render_js: "false", premium_proxy: "true" });
    const r = await fetch("https://app.scrapingbee.com/api/v1/?" + q, { signal: AbortSignal.timeout(9000) }).catch(() => null);
    if (r && r.ok) return await r.text();
  }
  const err = new Error("El portal bloqueó la lectura automática. Pegá el texto del aviso en la app.");
  err.code = status === 404 ? "no_encontrado" : "bloqueado";
  err.status = status === 404 ? 404 : 502;
  if (status === 404) err.message = "El aviso no existe o fue dado de baja.";
  throw err;
}

export async function fromHtml(href) {
  const html = await fetchHtml(href);
  return parseHtml(html, href);
}



/* ---------------- utilidades ---------------- */
function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", ...extra } });
}


/* ---------------- RE/MAX Argentina (lectura específica) ----------------
   - El precio aparece como "225.000 USD" (número antes de la moneda).
   - Las características vienen como lista "etiqueta: valor" (superficie total, ambientes, baños, expensas...).
   - Las fotos están como rutas internas "listings/<id>/<foto>.jpg" servidas desde su CDN.
   - La página es Angular con estado del servidor embebido; si está, se usa también. */

export async function fromRemax(href) {
  const slug = (href.match(/\/listings\/([^/?#]+)/) || [])[1];
  if (slug) {
    const r = await fetch(`https://api-ar.redremax.com/remaxweb-ar/api/listings/findBySlug/${encodeURIComponent(slug)}`, {
      headers: { accept: "application/json", "user-agent": UA, origin: "https://www.remax.com.ar", referer: href },
      signal: AbortSignal.timeout(7000)
    }).catch(() => null);
    if (r && r.ok) {
      const j = await r.json().catch(() => null);
      if (j && j.data && j.data.id) return mapRemaxApi(j.data);
    }
  }
  const html = await fetchHtml(href);   // plan B: la página
  return parseRemax(html, href);
}




/* ---------------- Argenprop (lectura específica) ----------------
   Precio en <p class="titlebar__price">, características en lista "Etiqueta: <strong>valor</strong>",
   dirección en .titlebar__address y .location-label, fotos en static-content/<carpeta del aviso>/.
   La página también trae precios y fotos de avisos similares: se ignoran. */
export async function fromArgenprop(href) {
  const html = await fetchHtml(href);
  const r = parseArgenprop(html, href);
  // La página trae solo 5 fotos; la galería completa viene de /aviso/gallerypartial
  const id = (href.match(/--(\d{5,})/) || [])[1];
  const folder = (r.photos[0] || "").match(/static-content\/([^/]+)\//)?.[1];
  if (id) {
    const g = await fetch(`https://www.argenprop.com/aviso/gallerypartial?idAviso=${id}&tipo=fotos`, { headers: { "user-agent": UA, referer: href, "x-requested-with": "XMLHttpRequest" }, signal: AbortSignal.timeout(6000) }).catch(() => null);
    if (g && g.ok) {
      const t = await g.text();
      const seen = new Set(), all = [];
      for (const m of t.matchAll(/static-content\/([^/"'\s)]+)\/([0-9a-f-]{20,})(?:_[a-z_]+)?\.(jpe?g|webp|png)/gi)) {
        if (folder && m[1] !== folder) continue;
        if (seen.has(m[2])) continue; seen.add(m[2]);
        all.push(`https://www.argenprop.com/static-content/${m[1]}/${m[2]}_u_large.${m[3].toLowerCase()}`);
      }
      if (all.length > r.photos.length) r.photos = all.slice(0, MAX_PHOTOS);
    }
  }
  return r;
}


/* ---------------- Zonaprop (lectura específica) ----------------
   Los datos vienen en variables del script de la página: mainFeatures, pricesData, expenses,
   address, location, postingTitle, description, pictures y whatsApp. */
