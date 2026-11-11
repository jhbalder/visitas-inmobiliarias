// Utilidades compartidas por las funciones: almacenamiento, sesiones, Google y permisos.
import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

/* ---------- almacenamiento (Netlify Blobs) ---------- */
// El acceso a Blobs se crea en cada uso: Netlify entrega credenciales nuevas en cada pedido y las
// guardadas de un pedido anterior vencen («Failed to decode token: Token expired»).
export function db() {
  if (globalThis.__MEMSTORE) return globalThis.__MEMSTORE; // solo pruebas locales
  return getStore({ name: "visitas", consistency: "strong" });
}
export const getJSON = (key) => db().get(key, { type: "json" });
export const setJSON = (key, val) => db().setJSON(key, val);
export const del = (key) => db().delete(key);
export async function listKeys(prefix) {
  const out = [];
  for await (const page of db().list({ prefix, paginate: true })) for (const b of page.blobs) out.push(b.key);
  return out;
}

/* ---------- respuestas y errores ---------- */
export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}
export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const fail = (status, code, message) => { throw new HttpError(status, code, message); };

/* ---------- ids ---------- */
export const rid = (n = 12) => crypto.randomBytes(n).toString("base64url").replace(/[-_]/g, "").slice(0, n);
export const validId = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{3,60}$/.test(s);
export const normEmail = (e) => String(e || "").trim().toLowerCase();
export const emailKey = (e) => "users/" + encodeURIComponent(normEmail(e));

/* ---------- sesiones propias (firmadas) ---------- */
const SESSION_DAYS = 30;
function secret() {
  const s = process.env.AUTH_SECRET || "";
  if (s.length < 24) fail(500, "config", "Falta configurar AUTH_SECRET (40 caracteres o más) en Netlify.");
  return s;
}
export function signSession(user) {
  const body = Buffer.from(JSON.stringify({ email: user.email, name: user.name, picture: user.picture || "", exp: Date.now() + SESSION_DAYS * 864e5 })).toString("base64url");
  const mac = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return body + "." + mac;
}
export function readSession(token) {
  const [body, mac] = String(token || "").split(".");
  if (!body || !mac) return null;
  const expect = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try { const p = JSON.parse(Buffer.from(body, "base64url").toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}
export const superEmails = () => (process.env.SUPERUSER_EMAILS || "").toLowerCase().split(/[\s,;]+/).filter(Boolean);
export const isSuperEmail = (e) => superEmails().includes(normEmail(e));

export async function requireUser(req) {
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const s = readSession(tok);
  if (!s) fail(401, "sesion", "Tu sesión venció. Ingresá de nuevo con Google.");
  return { email: normEmail(s.email), name: s.name, picture: s.picture, super: isSuperEmail(s.email) };
}

/* ---------- Google ---------- */
// Verifica el ingreso de Google. Primero localmente con las claves públicas de Google (rápido, sin depender
// de tokeninfo); si eso no se puede, consulta tokeninfo. Cada pedido a Google se reintenta una vez.
let _certs = null, _certsAt = 0;
async function fetchRetry(url) {
  let last;
  for (let i = 0; i < 2; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(7000) }); if (r.status < 500) return r; last = new Error("HTTP " + r.status); }
    catch (e) { last = e; }
  }
  throw last;
}
async function googleCerts() {
  if (_certs && Date.now() - _certsAt < 3600e3) return _certs;
  const r = await fetchRetry("https://www.googleapis.com/oauth2/v3/certs");
  const j = await r.json();
  _certs = j.keys || []; _certsAt = Date.now();
  return _certs;
}
const b64json = (x) => JSON.parse(Buffer.from(x, "base64url").toString("utf8"));
async function verifyLocal(credential) {
  const [h, pl, sig] = String(credential).split(".");
  if (!h || !pl || !sig) return null;
  const head = b64json(h);
  if (head.alg !== "RS256") return null;
  const jwk = (await googleCerts()).find((k) => k.kid === head.kid);
  if (!jwk) return null;
  const ok = crypto.verify("RSA-SHA256", Buffer.from(h + "." + pl), crypto.createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(sig, "base64url"));
  if (!ok) fail(401, "google", "Google no validó el ingreso. Probá de nuevo.");
  const p = b64json(pl);
  if (!p.exp || p.exp * 1000 < Date.now() - 60e3) fail(401, "google", "El ingreso de Google venció. Probá de nuevo.");
  return p;
}
export async function verifyGoogle(credential) {
  if (globalThis.__TEST_GOOGLE) return globalThis.__TEST_GOOGLE(credential); // solo pruebas locales
  const cid = process.env.GOOGLE_CLIENT_ID;
  if (!cid) fail(500, "config", "Falta configurar GOOGLE_CLIENT_ID en Netlify.");
  let p = null;
  try { p = await verifyLocal(credential); }
  catch (e) { if (e instanceof HttpError) throw e; console.error("Verificación local de Google:", e); }
  if (!p) {
    let r;
    try { r = await fetchRetry("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential)); }
    catch (e) { fail(503, "google_red", "No pudimos validar tu cuenta con Google. Probá de nuevo en unos segundos."); }
    if (!r.ok) fail(401, "google", "Google no validó el ingreso. Probá de nuevo.");
    p = await r.json();
  }
  if (p.aud !== cid) fail(401, "google", "El ingreso no corresponde a esta aplicación.");
  if (!["accounts.google.com", "https://accounts.google.com"].includes(p.iss)) fail(401, "google", "Emisor no válido.");
  if (!(p.email_verified === true || p.email_verified === "true")) fail(401, "google", "La cuenta de Google no tiene el mail verificado.");
  return { email: normEmail(p.email), name: p.name || p.email, picture: p.picture || "" };
}

/* ---------- usuarios y ambientes ---------- */
export async function getUser(email) { return (await getJSON(emailKey(email))) || null; }
export async function saveUser(u) { await setJSON(emailKey(u.email), u); }
export async function addEnvToUser(email, envId, profile = {}) {
  const u = (await getUser(email)) || { email: normEmail(email), name: profile.name || email, picture: profile.picture || "", envIds: [], created: Date.now() };
  if (!u.envIds.includes(envId)) u.envIds.push(envId);
  await saveUser(u);
}
export async function removeEnvFromUser(email, envId) {
  const u = await getUser(email); if (!u) return;
  u.envIds = (u.envIds || []).filter((x) => x !== envId); await saveUser(u);
}
export const metaKey = (envId) => `envs/${envId}/meta`;
export const opKey = (envId, opId) => `envs/${envId}/ops/${opId}`;

export async function envContext(user, envId) {
  if (!validId(envId)) fail(400, "ambiente", "Ambiente inválido.");
  const meta = await getJSON(metaKey(envId));
  if (!meta) fail(404, "ambiente", "El ambiente no existe.");
  if (user.super) return { meta, role: "broker", super: true, opIds: null };
  if (meta.active === false) fail(403, "desactivado", "Este ambiente está desactivado. Consultá con el administrador.");
  const m = (Array.isArray(meta.members) ? meta.members : []).find((x) => x && x.email === user.email);
  if (!m) fail(403, "sin_acceso", "Tu cuenta no tiene acceso a este ambiente.");
  return { meta, role: m.role, opIds: m.opIds || [], member: m };
}
export const canOp = (ctx, opId) => ctx.role === "broker" || (ctx.opIds || []).includes(opId);
export const isStaffRole = (r) => r === "broker" || r === "asistente" || r === "colaborador";
export const canCreateOps = (r) => r === "broker" || r === "asistente";

/* ---------- vistas y reglas de escritura por rol ---------- */
export function clientView(op) {
  const o = structuredClone(op);
  o.props = (o.props || []).filter((p) => p.approval === "aprobada").map((p) => { delete p.phone; return p; });
  const ids = new Set(o.props.map((p) => p.id));
  o.visits = (o.visits || []).filter((v) => ids.has(v.propId) && (v.state === "confirmada" || (v.state === "rechazada" && v.rejectedBy === "cliente")));
  o.notices = [];
  return o;
}
export function viewFor(ctx, op) { return ctx.role === "cliente" ? clientView(op) : op; }

const txt = (s, n) => String(s ?? "").slice(0, n);
function appendLogs(target, incoming) {
  target.log = target.log || [];
  const have = new Set(target.log.map((l) => l.date + "|" + l.text));
  for (const l of incoming.log || []) {
    const k = l.date + "|" + l.text;
    if (!have.has(k)) { target.log.push({ date: txt(l.date, 10), text: txt(l.text, 400) }); have.add(k); }
  }
}

// Cliente: solo puede cambiar su elección, prioridad, motivo, rechazar visitas confirmadas, registrar resultados,
// dejar avisos y editar sus propios horarios.
export function mergeClient(stored, inc, email) {
  const out = structuredClone(stored);
  const ip = new Map((inc.props || []).map((p) => [p.id, p]));
  const from = ["nueva", "leida", "para_agendar", "descartada", "por_visitar"];
  const to = ["nueva", "leida", "para_agendar", "descartada", "por_visitar", "oferta"];
  for (const sp of out.props || []) {
    if (sp.approval !== "aprobada") continue;
    const p = ip.get(sp.id); if (!p) continue;
    if (p.status !== sp.status && from.includes(sp.status) && to.includes(p.status)) sp.status = p.status;
    sp.rank = Number.isFinite(p.rank) ? p.rank : null;
    sp.choiceNote = txt(p.choiceNote, 500);
    appendLogs(sp, p);
  }
  const iv = new Map((inc.visits || []).map((v) => [v.id, v]));
  for (const sv of out.visits || []) {
    const v = iv.get(sv.id); if (!v) continue;
    if (sv.state === "confirmada" && v.state === "rechazada" && v.rejectedBy === "cliente") {
      Object.assign(sv, { state: "rechazada", rejectedBy: "cliente", clientReason: txt(v.clientReason, 500), rejectedName: txt(v.rejectedName, 80) });
    }
    if (sv.state === "confirmada" && v.result && v.result.rating) sv.result = { rating: txt(v.result.rating, 20), note: txt(v.result.note, 1000) };
  }
  const haveN = new Set((out.notices || []).map((n) => n.id));
  out.notices = out.notices || [];
  for (const n of inc.notices || []) if (n && n.id && !haveN.has(n.id)) out.notices.unshift({ ...n, text: txt(n.text, 400), reason: txt(n.reason, 500), seen: [] });
  const me = (out.clients || []).find((c) => c.email === email);
  const mine = (inc.clients || []).find((c) => c.email === email);
  if (me && mine) { me.name = txt(mine.name, 80) || me.name; me.notes = txt(mine.notes, 1000); me.slots = Array.isArray(mine.slots) ? mine.slots.slice(0, 10) : me.slots; }
  return out;
}

// Asistente: no puede aprobar propiedades ni confirmar visitas.
export function mergeAssistant(stored, inc) {
  const out = structuredClone(inc);
  const sp = new Map(((stored && stored.props) || []).map((p) => [p.id, p]));
  out.props = (out.props || []).map((p) => ({ ...p, approval: sp.has(p.id) ? sp.get(p.id).approval : "pendiente" }));
  const sv = new Map(((stored && stored.visits) || []).map((v) => [v.id, v]));
  out.visits = (out.visits || []).map((v) => {
    const s = sv.get(v.id);
    const wasConfirmed = s && s.state === "confirmada" && s.date === v.date && s.time === v.time;
    if (v.state === "confirmada" && !wasConfirmed) return { ...v, state: "propuesta" };
    return v;
  });
  return out;
}
