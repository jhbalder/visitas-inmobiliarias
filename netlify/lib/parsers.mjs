// Lectores de avisos por portal. Código puro (sin dependencias de Node):
// lo usan la función del servidor (netlify/functions/leer-aviso.mjs) y el favorito "Enviar a Visitas".
export const PHOTO_HOSTS = /(zonapropcdn|zonaprop|argenprop|sosiva451|remax|mlstatic|cloudfront|redremax|imgix|amazonaws)/i;

export const MAX_PHOTOS = 20;

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

export function readJsonLd(n, f) {
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

export function matchAll(s, re) { const out = []; let m; while ((m = re.exec(s))) out.push(m[1] ?? m[0]); return out; }

export function flatten(d) { if (Array.isArray(d)) return d.flatMap(flatten); if (d && d["@graph"]) return [d, ...flatten(d["@graph"])]; return [d]; }

export function num(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Math.round(v);
  let t = String(v).replace(/[^\d.,]/g, "");
  if (/^\d{1,3}([.,]\d{3})+$/.test(t)) return Number(t.replace(/[.,]/g, ""));
  const n = parseFloat(t.replace(",", ".")); return isNaN(n) ? null : Math.round(n);
}

export function numOrText(v) { const n = num(v); return n ?? v; }

export function clean(o) { const r = {}; for (const [k, v] of Object.entries(o)) if (v != null && v !== "" && !Number.isNaN(v)) r[k] = v; return r; }

export function decode(s) {
  return String(s || "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&sup2;/g, "²").replace(/&deg;/g, "°")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z])(acute|tilde);/gi, (_, l, k) => (l + (k === "acute" ? "́" : "̃")).normalize("NFC"));
}

export function htmlToText(html) {
  return decode(
    html
      .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr|\/dt|\/dd)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .split("\n").map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

export const REMAX_CDN = "https://d1acdg20u0pmxj.cloudfront.net";

export function mapRemaxApi(d) {
  const cur = d.currency && (d.currency.value || d.currency);
  const usd = /USD/i.test(String(cur || ""));
  const desc = String(d.description || "");
  const pisoM = desc.match(/(\d{1,2})\s*(?:°|º|\.º|\.°|er\.?|do\.?|to\.?|vo\.?|no\.?)\s*piso\b/i);
  const phone = ((d.associate && d.associate.phones) || []).find((p) => p && p.value) || null;
  const geoLabel = d.geo && (d.geo.neighborhood || d.geo.label);
  const fields = clean({
    title: d.title,
    price: usd && d.priceExposure !== false ? num(d.price) : null,
    priceOther: !usd ? num(d.price) : null,
    currency: cur || null,
    expensas: num(d.expensesPrice) || null,
    m2: num(d.dimensionTotalBuilt) || num(d.dimensionCovered) || num(d.dimensionLand) || null,
    amb: num(d.totalRooms) || (num(d.bedrooms) != null ? num(d.bedrooms) + 1 : null),
    banos: num(d.bathrooms),
    cocheras: num(d.parkingSpaces),
    pisos: num(d.floors) || null,
    piso: pisoM ? num(pisoM[1]) : (/planta baja/i.test(desc) ? "PB" : null),
    address: d.displayAddress || null,
    barrio: geoLabel ? titleCase(String(geoLabel).split(",")[0]) : null,
    phone: phone ? phone.value.replace(/[()]/g, " ").replace(/\s+/g, " ").trim() : null
  });
  const photos = (d.photos || []).filter((p) => p && !p.is360).sort((a, b) => (a.position || 0) - (b.position || 0))
    .map((p) => String(p.value || p.rawValue + ".jpg").replace(/^listings\/([^/]+)\/([^/]+)$/, `${REMAX_CDN}/listings/$1/1080xAUTO/$2`))
    .filter((u) => /^https:/.test(u)).slice(0, MAX_PHOTOS);
  return { source: "api_remax", fields, photos, text: [d.title, desc].filter(Boolean).join("\n") };
}

export const titleCase = (s) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

export function parseRemax(html, href) {
  const base = parseHtml(html, href);           // título, og:image, texto plano
  const raw = unescapeNg(html);
  const text = htmlToText(raw);
  const T = text.replace(/ /g, " ");
  const f = {};
  const n = (v) => num(v);
  const grab = (re) => { const m = T.match(re); return m ? m[1] : null; };

  // Precio: "225.000 USD" o "USD 225.000"; se ignora si está en pesos (alquileres).
  const noExp = T.replace(/expensas[^\n]*/gi, "");
  let m = noExp.match(/(\d{1,3}(?:[.,]\d{3})+|\d{4,})\s*(USD|U\$S|US\$)(?![a-z])/i) || noExp.match(/(USD|U\$S|US\$)\s*(\d{1,3}(?:[.,]\d{3})+|\d{4,})/i)
       || noExp.match(/(\d{1,3}(?:[.,]\d{3})+|\d{4,})\s*(ARS|\$)(?![a-z])/i);
  if (m) {
    const [amount, cur] = /\d/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
    if (/USD|U\$S|US\$/i.test(cur)) f.price = n(amount); else { f.priceOther = n(amount); f.currency = "ARS"; }
  }
  f.expensas = n(grab(/expensas\s*:?\s*\$?\s*(\d[\d.,]*)/i));
  f.m2 = n(grab(/superficie total\s*:?\s*(\d[\d.,]*)\s*m/i)) ?? n(grab(/(\d[\d.,]*)\s*m²\s*totales/i)) ?? n(grab(/superficie cubierta\s*:?\s*(\d[\d.,]*)\s*m/i));
  f.amb = n(grab(/\bambientes\s*:\s*(\d{1,2})/i)) ?? n(grab(/(\d{1,2})\s*ambientes/i));
  if (f.amb == null) { const d = n(grab(/dormitorios\s*:?\s*(\d{1,2})/i)); if (d != null) f.amb = d + 1; }
  f.banos = n(grab(/\bbaños\s*:?\s*(\d{1,2})/i)) ?? n(grab(/(\d{1,2})\s*baños?/i));
  f.cocheras = n(grab(/\b(?:cocheras?|estacionamientos?|garages?)\s*:?\s*(\d{1,2})/i));
  f.pisos = n(grab(/pisos de la propiedad\s*:?\s*(\d{1,3})/i)) ?? n(grab(/cantidad de pisos\s*:?\s*(\d{1,3})/i));
  const piso = grab(/(\d{1,2})\s*(?:°|º|\.º|\.°|er\.?|do\.?|to\.?|vo\.?|no\.?)\s*piso\b/i) || (/planta baja/i.test(T) ? "PB" : null);
  if (piso != null) f.piso = piso === "PB" ? "PB" : n(piso);

  // Dirección y barrio: palabras clave del sitio o línea "Calle 1234, Barrio, Ciudad"
  const kw = (raw.match(/<meta[^>]+name=["']keywords["'][^>]*content=["']([^"']+)["']/i) || [])[1] || "";
  const addrLine = (kw + "\n" + T).split(/\n|,(?=\s*[A-ZÁÉÍÓÚ])/).map(x => x.trim()).find(x => /^[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.'\s]{2,40}\s\d{2,5}$/.test(x));
  if (addrLine) f.address = addrLine;
  const loc = T.match(/\n([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.\s]{2,30}),\s*(Capital Federal|CABA|Buenos Aires|G\.B\.A\.[^\n]*|Córdoba|Rosario|Santa Fe|Mendoza)/);
  if (loc) f.barrio = loc[1].trim();

  // Estado de Angular embebido (si existe): completa lo que falte
  const st = fromNgState(raw, href);
  for (const [k, v] of Object.entries(st.fields)) if (f[k] == null && v != null) f[k] = v;

  // Fotos: rutas internas -> URL del CDN en tamaño grande
  const photos = [];
  const seen = new Set();
  const addKey = (key) => {
    const mm = String(key).match(/listings\/([0-9a-f-]{36})\/(?:[0-9A-Za-z]+x[0-9A-Za-z]+\/)?([0-9a-f-]{36}\.(?:jpe?g|png|webp))/i);
    if (!mm) return;
    const id = mm[1] + "/" + mm[2];
    if (seen.has(id)) return; seen.add(id);
    photos.push(`${REMAX_CDN}/listings/${mm[1]}/1080xAUTO/${mm[2]}`);
  };
  for (const k of st.photos) addKey(k);
  for (const mm of raw.matchAll(/listings\/[0-9a-f-]{36}\/(?:[0-9A-Za-z]+x[0-9A-Za-z]+\/)?[0-9a-f-]{36}\.(?:jpe?g|png|webp)/gi)) addKey(mm[0]);
  for (const p of base.photos) { const before = photos.length; addKey(p); if (photos.length === before && !/cloudfront/i.test(p) && !photos.includes(p)) photos.push(p); }

  const fields = clean({ ...base.fields, ...clean(f) });
  if (fields.title) fields.title = fields.title.replace(/\s+/g, " ").trim();
  return { source: "pagina_remax", fields, photos: photos.slice(0, MAX_PHOTOS), text: [fields.title, text].filter(Boolean).join("\n").slice(0, 40000) };
}

// Angular TransferState: <script id="ng-state"> (JSON plano) o "serverApp-state" (con &q; etc.)

export function unescapeNg(s) { return s.replace(/&q;/g, '"').replace(/&s;/g, "'").replace(/&l;/g, "<").replace(/&g;/g, ">").replace(/&a;/g, "&"); }

export function fromNgState(html, href) {
  const out = { fields: {}, photos: [] };
  const m = html.match(/<script[^>]+id=["'](?:ng-state|serverApp-state|[\w-]*-state)["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return out;
  let data; try { data = JSON.parse(unescapeNg(m[1])); } catch { return out; }
  const slug = (href.match(/\/listings\/([^/?#]+)/) || [])[1] || "";
  // Busca el objeto del aviso: el que tiene el slug de la URL, o el que tenga precio y fotos.
  let best = null;
  const walk = (o, depth) => {
    if (!o || typeof o !== "object" || depth > 12) return;
    if (!Array.isArray(o)) {
      const keys = Object.keys(o);
      const hasPrice = keys.some(k => /^price$/i.test(k));
      const hasPhotos = keys.some(k => /photo|image|picture/i.test(k));
      if ((slug && o.slug === slug) || (hasPrice && hasPhotos && !best)) best = o;
    }
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(data, 0);
  if (!best) return out;
  const pick = (re) => { for (const [k, v] of Object.entries(best)) if (re.test(k) && v != null && typeof v !== "object") return v; return null; };
  const cur = best.currency && typeof best.currency === "object" ? (best.currency.value || best.currency.name) : best.currency;
  const price = num(pick(/^price$/i));
  if (price != null) { if (!cur || /USD|U\$S/i.test(cur)) out.fields.price = price; else { out.fields.priceOther = price; out.fields.currency = String(cur); } }
  out.fields.expensas = num(pick(/^expenses?$/i));
  out.fields.m2 = num(pick(/total.*(surface|built|dimension)|dimension.*total/i)) ?? num(pick(/covered|cubiert/i));
  out.fields.amb = num(pick(/^total ?rooms$|^rooms$|ambientes/i));
  out.fields.banos = num(pick(/^bathrooms$|baños/i));
  out.fields.cocheras = num(pick(/parking|garage|cochera/i));
  out.fields.pisos = num(pick(/^floors$|floorsCount/i));
  out.fields.address = pick(/displayAddress|^address$/i);
  out.fields.title = pick(/^title$/i);
  for (const [k, v] of Object.entries(best)) if (/photo|image|picture/i.test(k) && Array.isArray(v)) for (const ph of v) out.photos.push(typeof ph === "string" ? ph : (ph && (ph.value || ph.url || ph.path || ph.key || ph.rawValue)) || "");
  out.fields = clean(out.fields);
  return out;
}

export function parseArgenprop(html, href) {
  const f = {};
  const strip = (x) => decode(String(x || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  const one = (re) => { const m = html.match(re); return m ? strip(m[1]) : null; };
  const priceTxt = one(/<p[^>]*class="titlebar__price"[^>]*>([\s\S]*?)<\/p>/i);
  const feats = {};
  for (const m of html.matchAll(/<li[^>]*>\s*<h3>\s*([^<:]+?)\s*:\s*<strong>\s*([\s\S]*?)\s*<\/strong>/gi)) feats[strip(m[1]).toLowerCase()] = strip(m[2]);
  const ft = (re) => { for (const [k, v] of Object.entries(feats)) if (re.test(k)) return v; return null; };
  const money = (t) => {
    if (!t) return;
    const n2 = num((t.match(/[\d.,]{3,}/) || [])[0]);
    if (/USD|U\$S|US\$/i.test(t)) f.price = n2; else if (n2) { f.priceOther = n2; f.currency = "ARS"; }
  };
  money(priceTxt && /\d/.test(priceTxt) ? priceTxt : ft(/^precio$/));
  f.expensas = num((ft(/^expensas$/) || one(/titlebar__price-mobile[\s\S]*?<span>([^<]*expensas[^<]*)<\/span>/i) || "").match(/[\d.,]{3,}/)?.[0]);
  f.amb = num(ft(/ambientes/));
  if (f.amb == null) { const d = num(ft(/dormitorios/)); if (d != null) f.amb = d + 1; }
  f.banos = num(ft(/baños|banos/));
  f.cocheras = num(ft(/cochera/));
  f.m2 = num((ft(/sup\.? total|superficie total/) || "").match(/[\d.,]+/)?.[0]) ?? num((ft(/sup\.? cubierta/) || "").match(/[\d.,]+/)?.[0]);
  const pisoTxt = ft(/^piso|ubicaci[oó]n.*piso|n[uú]mero de piso/); if (pisoTxt) f.piso = /pb|planta baja/i.test(pisoTxt) ? "PB" : num(pisoTxt);
  f.pisos = num(ft(/cant\.? pisos|pisos del edificio|cantidad de pisos/));
  f.address = one(/<h2[^>]*class="titlebar__address"[^>]*>([\s\S]*?)<\/h2>/i);
  const loc = one(/<p[^>]*class="location-label"[^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/i);
  if (loc) { const parts = loc.split(",").map((x) => x.trim()); if (!f.address) f.address = parts[0]; if (parts[1]) f.barrio = parts[1]; }
  // Título: descripción corta del aviso (JSON-LD/og:description) o og:title
  const base = parseHtml(html, href);
  const og = (p) => { const m = html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]*property="${p}"|<meta[^>]+property="${p}"[^>]*content="([^"]*)"`, "i")); return m ? decode(m[1] || m[2]) : null; };
  const ogDesc = og("og:description");
  f.title = ogDesc && ogDesc.length < 140 ? ogDesc : (base.fields.title || og("og:title"));
  // Fotos: solo las de la carpeta del aviso (la de og:image), en tamaño completo
  const ogImg = og("og:image") || "";
  const folder = (ogImg.match(/static-content\/([^/]+)\//) || [])[1];
  const photos = [];
  if (folder) {
    const re = new RegExp(`https?:\\/\\/[^"'\\s]*static-content\\/${folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/([0-9a-f-]{20,})(?:_[a-z_]+)?\\.(jpe?g|webp|png)`, "gi");
    const seen = new Set();
    for (const m of html.matchAll(re)) { if (seen.has(m[1])) continue; seen.add(m[1]); photos.push(`https://www.argenprop.com/static-content/${folder}/${m[1]}.${m[2].toLowerCase()}`); }
  }
  const desc = one(/<div[^>]*class="[^"]*section-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || "";
  return { source: "pagina_argenprop", fields: clean({ ...clean(base.fields), ...clean(f), title: f.title || base.fields.title }), photos: photos.length ? photos.slice(0, MAX_PHOTOS) : base.photos, text: [f.title, desc, Object.entries(feats).map(([k, v]) => k + ": " + v).join("\n")].filter(Boolean).join("\n") };
}

export function parseZonaprop(html, href) {
  const f = {};
  const jsonAfter = (re) => { const m = html.match(re); if (!m) return null; try { return JSON.parse(m[1]); } catch { return null; } };
  const str = (re) => { const m = html.match(re); if (!m) return null; try { return JSON.parse('"' + m[1] + '"'); } catch { return m[1]; } };
  const mf = jsonAfter(/mainFeatures\s*=\s*(\{[^\n]*\})\s*\n/) || jsonAfter(/'mainFeatures'\s*:\s*(\{[^\n]*\})\s*,\s*\n/) || {};
  const v = (id) => mf[id] && mf[id].value != null ? mf[id].value : null;
  f.m2 = num(v("CFT100")) ?? num(v("CFT101"));
  f.amb = num(v("CFT1"));
  if (f.amb == null && num(v("CFT2")) != null) f.amb = num(v("CFT2")) + 1;
  f.banos = num(v("CFT3"));
  f.cocheras = num(v("CFT7"));
  const pd = jsonAfter(/'pricesData'\s*:\s*(\[[^\n]*\])\s*,\s*\n/);
  const prices = (pd || []).flatMap((x) => x.prices || []);
  const usd = prices.find((p) => /USD/i.test(p.isoCode || p.currency));
  if (usd) f.price = num(usd.amount);
  else if (prices[0]) { f.priceOther = num(prices[0].amount); f.currency = prices[0].isoCode || "ARS"; }
  else { const pt = str(/'price'\s*:\s*'([^']*)'/); if (pt && /USD/.test(pt)) f.price = num(pt.match(/[\d.,]+/)?.[0]); }
  const exp = num(str(/'expenses'\s*:\s*'([^']*)'/)); if (exp) f.expensas = exp;
  const addr = jsonAfter(/'address'\s*:\s*(\{[^\n}]*\})/); if (addr && addr.name) f.address = addr.name.replace(/\s+/g, " ").trim();
  const loc = jsonAfter(/'location'\s*:\s*(\{[^\n]*\})\s*,\s*\n/);
  if (loc) { let n = loc, zona = null, barrio = null; while (n) { if (n.label === "ZONA") zona = n.name; if (n.label === "BARRIO") barrio = n.name; n = n.parent; } f.barrio = zona || barrio || loc.name; }
  f.title = str(/'postingTitle'\s*:\s*"((?:[^"\\]|\\.)*)"/) || str(/'generatedTitle'\s*:\s*'([^']*)'/);
  const wa = str(/'whatsApp'\s*:\s*'([^']*)'/);
  if (wa && /\d{8,}/.test(wa.replace(/\D/g, ""))) f.phone = "+" + wa.replace(/^\+/, "").trim();
  const desc = (str(/'description'\s*:\s*"((?:[^"\\]|\\.)*)"/) || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ");
  const pisoM = desc.match(/(\d{1,2})\s*(?:°|º|\.º|\.°|er\.?|do\.?|to\.?|vo\.?|no\.?)\s*piso\b/i); if (pisoM) f.piso = num(pisoM[1]);
  const pisosM = desc.match(/(\d{1,2})\s*pisos\b/i); if (pisosM) f.pisos = num(pisosM[1]);
  const pics = jsonAfter(/'pictures'\s*:\s*(\[[^\n]*\])\s*,\s*\n/) || [];
  let photos = pics.sort((a, b) => (a.order || 0) - (b.order || 0)).map((p) => String(p.url1200x1200 || p.resizeUrl1200x1200 || p.url730x532 || "").replace(/\?.*$/, "")).filter(Boolean);
  const base = parseHtml(html, href);
  if (!photos.length) photos = base.photos;
  return { source: "pagina_zonaprop", fields: clean({ ...clean(base.fields), ...clean(f) }), photos: [...new Set(photos)].slice(0, MAX_PHOTOS), text: [f.title, desc].filter(Boolean).join("\n") };
}

/* ---------------- Mercado Libre (página) ----------------
   Características en datos embebidos: {"id":"Superficie total","text":"57 m²"}, precio en JSON-LD (offers),
   dirección en .ui-pdp-media__title y fotos D_NQ_NP_<id>-O.webp del CDN mlstatic. */
export function parseMercadoLibre(html, href) {
  const f = {};
  const specs = {};
  for (const m of html.matchAll(/\{"id":"([^"]{2,60})","text":"([^"]{0,80})"\}/g)) {
    const k = m[1].toLowerCase(); if (k in specs) continue;
    if (/^\d{6,}$/.test(m[2])) continue; // Mercado Libre usa códigos internos (ej. 242085) cuando el dato está vacío
    specs[k] = m[2];
  }
  const sp = (re) => { for (const [k, v] of Object.entries(specs)) if (re.test(k)) return v; return null; };
  const first = (v) => num(String(v || "").split(/\s+a\s+/)[0].match(/[\d.,]+/)?.[0]);
  f.m2 = first(sp(/^superficie total$/)) ?? first(sp(/^superficie cubierta$/));
  f.amb = first(sp(/^ambientes$/));
  if (f.amb == null && first(sp(/^dormitorios$/)) != null) f.amb = first(sp(/^dormitorios$/)) + 1;
  f.banos = first(sp(/^baños$/));
  f.cocheras = first(sp(/^cocheras$/));
  const pisoTxt = sp(/número de piso de la unidad|^piso$/); if (pisoTxt != null) f.piso = /pb|planta baja/i.test(pisoTxt) ? "PB" : first(pisoTxt);
  f.pisos = first(sp(/^cantidad de pisos$/));
  const expTxt = sp(/^expensas$/); if (expTxt) f.expensas = first(expTxt);
  const ld = html.match(/"offers":\{"price":([\d.]+)[^}]*"priceCurrency":"(\w+)"/);
  if (ld) { if (/USD/i.test(ld[2])) f.price = num(ld[1]); else { f.priceOther = num(ld[1]); f.currency = ld[2]; } }
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i); if (h1) f.title = decode(h1[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
  const locs = [
    ...[...html.matchAll(/"id":"LOCATION_RE"[^}]*\},"title":\{"text":"([^"]{6,160})"/g)].map((m) => m[1]),
    ...[...html.matchAll(/class="[^"]*ui-pdp-media__title[^"]*"[^>]*>([^<]{6,160})</g)].map((m) => decode(m[1]).trim())
  ].filter((t) => /\d/.test(t) && t.includes(","));
  if (locs[0]) { const parts = locs[0].split(",").map((x) => x.trim()); f.address = parts[0]; if (parts[1]) f.barrio = parts[1]; }
  const ids = [];
  for (const m of html.matchAll(/https:\/\/http2\.mlstatic\.com\/D_NQ_NP_(?:2X_)?(\d+-MLA\d+_\d+)-[A-Z]\.(?:webp|jpg)/g)) if (!ids.includes(m[1])) ids.push(m[1]);
  const photos = ids.map((id) => `https://http2.mlstatic.com/D_NQ_NP_2X_${id}-F.webp`).slice(0, MAX_PHOTOS);
  const base = parseHtml(html, href);
  const desc = (html.match(/"description":\{[^}]*?"content":"((?:[^"\\]|\\.)*)"/) || [])[1] || "";
  let descTxt = ""; try { descTxt = JSON.parse('"' + desc + '"'); } catch {}
  return { source: "pagina_mercadolibre", fields: clean({ ...clean(base.fields), ...clean(f) }), photos: photos.length ? photos : base.photos, text: [f.title, descTxt, Object.entries(specs).map(([k, v]) => k + ": " + v).join("\n")].filter(Boolean).join("\n").slice(0, 20000) };
}
