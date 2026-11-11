// Favorito "Enviar a Visitas": se ejecuta en la página del aviso abierta en el navegador del usuario,
// lee los datos con los mismos lectores que el servidor y los envía a la app.
// Se compila con: node favorito/build.mjs  (genera favorito/enviar-a-visitas.min.js e inserta el código en index.html)
import { parseZonaprop, parseArgenprop, parseRemax, mapRemaxApi, parseMercadoLibre, MAX_PHOTOS } from "../netlify/lib/parsers.mjs";

const APP = "__APP__";

function aviso(msg) {
  const d = document.createElement("div");
  d.textContent = msg;
  d.style.cssText = "position:fixed;z-index:2147483647;left:50%;top:24px;transform:translateX(-50%);max-width:min(560px,90vw);background:#191C19;color:#fff;font:600 15px/1.4 system-ui,sans-serif;padding:14px 20px;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.3)";
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 5000);
}

async function leer() {
  const host = location.hostname;
  const href = location.href.split("#")[0];
  const html = document.documentElement.outerHTML;
  if (/(^|\.)zonaprop\.com\.ar$/.test(host)) return { portal: "Zonaprop", r: parseZonaprop(html, href) };
  if (/(^|\.)argenprop\.com$/.test(host)) {
    const r = parseArgenprop(html, href);
    const id = (href.match(/--(\d{5,})/) || [])[1];
    const folder = (r.photos[0] || "").match(/static-content\/([^/]+)\//)?.[1];
    if (id) {
      try {
        const t = await (await fetch(`/aviso/gallerypartial?idAviso=${id}&tipo=fotos`)).text();
        const seen = new Set(), all = [];
        for (const m of t.matchAll(/static-content\/([^/"'\s)]+)\/([0-9a-f-]{20,})(?:_[a-z_]+)?\.(jpe?g|webp|png)/gi)) {
          if (folder && m[1] !== folder) continue;
          if (seen.has(m[2])) continue; seen.add(m[2]);
          all.push(`https://www.argenprop.com/static-content/${m[1]}/${m[2]}_u_large.${m[3].toLowerCase()}`);
        }
        if (all.length > r.photos.length) r.photos = all;
      } catch (e) {}
    }
    return { portal: "Argenprop", r };
  }
  if (/(^|\.)remax\.com\.ar$/.test(host)) {
    const slug = (href.match(/\/listings\/([^/?#]+)/) || [])[1];
    if (slug) {
      try {
        const j = await (await fetch(`https://api-ar.redremax.com/remaxweb-ar/api/listings/findBySlug/${encodeURIComponent(slug)}`)).json();
        if (j && j.data && j.data.id) return { portal: "RE/MAX", r: mapRemaxApi(j.data) };
      } catch (e) {}
    }
    return { portal: "RE/MAX", r: parseRemax(html, href) };
  }
  if (/(^|\.)mercadolibre\.com\.ar$/.test(host)) return { portal: "Mercado Libre", r: parseMercadoLibre(html, href) };
  return null;
}

(async () => {
  let res;
  try { res = await leer(); } catch (e) { aviso("No se pudo leer este aviso (" + e.message + ")."); return; }
  if (!res) { aviso("Abrí un aviso de Zonaprop, Argenprop, RE/MAX o Mercado Libre y tocá el favorito de nuevo."); return; }
  const f = res.r.fields || {};
  if (!f.price && !f.m2 && !f.amb) { aviso("No encontramos los datos de una propiedad. Abrí la página del aviso (no el listado de resultados) y probá de nuevo."); return; }
  if (f.phone && String(f.phone).replace(/\D/g, "").length < 8) delete f.phone;
  const payload = { v: 1, url: location.href.split("#")[0], portal: res.portal, source: "favorito", fields: f, photos: (res.r.photos || []).slice(0, MAX_PHOTOS), text: String(res.r.text || "").slice(0, 3000) };
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const url = APP + "/#importar=" + b64;
  const w = window.open(url, "_blank");
  if (w) aviso("Listo: se abrió Visitas con los datos de este aviso.");
  else location.href = url;
})();
