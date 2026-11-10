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
const PHOTO_HOSTS = /(zonapropcdn|zonaprop|argenprop|sosiva451|remax|mlstatic|cloudfront|redremax|imgix|amazonaws)/i;
const MAX_PHOTOS = 15;

import { requireUser, HttpError } from "../lib/core.mjs";

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
    if (!result) result = await fromHtml(t.href);
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
    blocked = !r.ok || /cf-chl|challenge-platform|Just a moment|captcha/i.test(html.slice(0, 5000));
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

export function parseHtml(html, href) {
  const fields = {};
  // 1) Datos estructurados (JSON-LD)
  for (const block of matchAll(html, /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data; try { data = JSON.parse(block.trim()); } catch { continue; }
    for (const node of flatten(data)) readJsonLd(node, fields);
  }
  // 2) Metadatos Open Graph
  const meta = (prop) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, "i");
    const m = html.match(re); return m ? decode(m[1] || m[2]) : null;
  };
  if (!fields.title) fields.title = meta("og:title") || (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || null;
  if (fields.title) fields.title = decode(fields.title).replace(/\s*[-|–]\s*(Zonaprop|Argenprop|RE\/MAX|Remax|Mercado Libre).*$/i, "").trim();
  const desc = meta("og:description") || meta("description") || "";

  // 3) Fotos
  const photos = [];
  const add = (src) => {
    if (!src) return;
    src = decode(src).replace(/\\u002F/g, "/").replace(/\\\//g, "/");
    if (src.startsWith("//")) src = "https:" + src;
    if (!/^https?:\/\//.test(src)) return;
    if (!PHOTO_HOSTS.test(src) || /logo|icon|avatar|sprite|placeholder|banner|isotipo|marker/i.test(src)) return;
    const key = src.replace(/\/(?:\d{2,4}x\d{2,4}|resize\/[^/]+)\//, "/").replace(/\?.*$/, "");
    if (photos.some(p => p.key === key)) return;
    photos.push({ key, src });
  };
  for (const img of [].concat(fields._images || [])) add(typeof img === "string" ? img : img?.url);
  for (const m of matchAll(html, /<meta[^>]+property=["']og:image(?::url)?["'][^>]*content=["']([^"']+)["']/gi)) add(m);
  for (const m of matchAll(html, /(?:https?:)?\/\/[^"'\s)<>\\]+?\.(?:jpe?g|webp)(?:\?[^"'\s)<>\\]*)?/gi)) add(m);
  delete fields._images;

  // 4) Texto plano para completar lo que falte
  const text = [fields.title, desc, htmlToText(html)].filter(Boolean).join("\n").slice(0, 40000);

  return { source: "pagina", fields: clean(fields), photos: photos.slice(0, MAX_PHOTOS).map(p => p.src), text };
}

function readJsonLd(n, f) {
  if (!n || typeof n !== "object") return;
  if (n.name && !f.title && /(departamento|casa|ph|ambiente|venta|alquiler|propiedad|dpto|depto)/i.test(n.name)) f.title = n.name;
  const offer = Array.isArray(n.offers) ? n.offers[0] : n.offers;
  if (offer && offer.price && !f.price) {
    const cur = (offer.priceCurrency || "").toUpperCase();
    if (cur === "USD") f.price = num(offer.price); else { f.priceOther = num(offer.price); f.currency = cur; }
  }
  if (n.floorSize && !f.m2) f.m2 = num(n.floorSize.value ?? n.floorSize);
  if (n.numberOfRooms && !f.amb) f.amb = num(n.numberOfRooms);
  if ((n.numberOfBathroomsTotal || n.numberOfFullBathrooms) && !f.banos) f.banos = num(n.numberOfBathroomsTotal || n.numberOfFullBathrooms);
  const a = n.address;
  if (a && typeof a === "object") {
    if (a.streetAddress && !f.address) f.address = a.streetAddress;
    if ((a.addressLocality || a.addressRegion) && !f.barrio) f.barrio = a.addressLocality || null;
  }
  if (n.telephone && !f.phone) f.phone = n.telephone;
  if (n.image) f._images = [].concat(f._images || [], n.image);
}

/* ---------------- utilidades ---------------- */
function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", ...extra } });
}
function matchAll(s, re) { const out = []; let m; while ((m = re.exec(s))) out.push(m[1] ?? m[0]); return out; }
function flatten(d) { if (Array.isArray(d)) return d.flatMap(flatten); if (d && d["@graph"]) return [d, ...flatten(d["@graph"])]; return [d]; }
function num(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Math.round(v);
  let t = String(v).replace(/[^\d.,]/g, "");
  if (/^\d{1,3}([.,]\d{3})+$/.test(t)) return Number(t.replace(/[.,]/g, ""));
  const n = parseFloat(t.replace(",", ".")); return isNaN(n) ? null : Math.round(n);
}
function numOrText(v) { const n = num(v); return n ?? v; }
function clean(o) { const r = {}; for (const [k, v] of Object.entries(o)) if (v != null && v !== "" && !Number.isNaN(v)) r[k] = v; return r; }
function decode(s) {
  return String(s || "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&sup2;/g, "²").replace(/&deg;/g, "°")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z])(acute|tilde);/gi, (_, l, k) => (l + (k === "acute" ? "́" : "̃")).normalize("NFC"));
}
function htmlToText(html) {
  return decode(
    html
      .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr|\/dt|\/dd)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .split("\n").map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}
