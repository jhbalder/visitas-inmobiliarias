// API de la app: sesiones con Google, ambientes por broker, invitaciones, operaciones, equipo, fotos y panel de superusuario.
import {
  json, HttpError, fail, rid, validId, normEmail, getJSON, setJSON, del, listKeys, db,
  signSession, requireUser, verifyGoogle, isSuperEmail, superEmails, getUser, saveUser, addEnvToUser, removeEnvFromUser,
  metaKey, opKey, envContext, canOp, isStaffRole, canCreateOps, viewFor, mergeClient, mergeAssistant
} from "../lib/core.mjs";

export const config = {
  path: ["/api/config", "/api/session", "/api/me", "/api/envs", "/api/invites", "/api/invites/*", "/api/env/*", "/api/admin/*", "/api/photo/*"]
};

const INVITE_DAYS = 14;
const MAX_OP_BYTES = 4 * 1024 * 1024;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

export default async (req) => {
  try {
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
    const m = req.method;
    const [a, b, c, d] = parts;

    if (a === "config" && m === "GET") return json({
      server: true,
      googleClientId: process.env.GOOGLE_CLIENT_ID || "",
      ready: { google: !!process.env.GOOGLE_CLIENT_ID, secret: (process.env.AUTH_SECRET || "").length >= 24, superuser: superEmails().length > 0 }
    });
    if (a === "session" && m === "POST") return await createSession(req);
    if (a === "photo" && m === "GET" && b && c) return await getPhoto(b, c);
    if (a === "invites" && b && !c && m === "GET") return await inviteInfo(b);

    const user = await requireUser(req);
    if (a === "me" && m === "GET") return await me(user);
    if (a === "envs" && !b && m === "POST") return await createEnv(user, await body(req));
    if (a === "invites") {
      if (!b && m === "POST") return await createInvite(user, await body(req));
      if (b && c === "accept" && m === "POST") return await acceptInvite(user, b);
      if (b && !c && m === "DELETE") return await revokeInvite(user, b);
    }
    if (a === "env" && b) {
      if (!c && m === "GET") return await getEnv(user, b);
      if (!c && m === "PUT") return await renameEnv(user, b, await body(req));
      if (c === "ops" && d && m === "PUT") return await putOp(user, b, d, await body(req));
      if (c === "ops" && d && m === "DELETE") return await deleteOp(user, b, d);
      if (c === "team" && m === "GET") return await getTeam(user, b);
      if (c === "brokers" && !d && m === "POST") return await assignBroker(user, b, await body(req));
      if (c === "members" && d && m === "PUT") return await updateMember(user, b, d, await body(req));
      if (c === "members" && d && m === "DELETE") return await removeMember(user, b, d);
      if (c === "photos" && m === "POST") return await uploadPhoto(user, b, req);
    }
    if (a === "admin") {
      if (!user.super) fail(403, "solo_admin", "Solo el superusuario puede hacer esto.");
      if (b === "envs" && !c && m === "GET") return await adminEnvs();
      if (b === "envs" && c && !d && m === "PUT") return await adminUpdateEnv(c, await body(req));
      if (b === "envs" && c && d === "assign" && m === "POST") return await adminAssignBroker(c, await body(req));
    }
    fail(404, "no_encontrado", "Ruta no encontrada.");
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.code, message: e.message, ...(e.extra || {}) }, e.status);
    console.error(e);
    return json({ error: "error", message: "Ocurrió un error en el servidor. Probá de nuevo." }, 500);
  }
};

async function body(req) { try { return await req.json(); } catch { fail(400, "json", "Datos inválidos."); } }

/* ---------- sesión ---------- */
async function createSession(req) {
  const { credential } = await body(req);
  if (!credential) fail(400, "google", "Falta el ingreso de Google.");
  const g = await verifyGoogle(credential);
  const u = (await getUser(g.email)) || { email: g.email, envIds: [], created: Date.now() };
  u.name = g.name; u.picture = g.picture; u.lastLogin = Date.now();
  await saveUser(u);
  return json({ token: signSession(u), user: { email: u.email, name: u.name, picture: u.picture, super: isSuperEmail(u.email) } });
}

async function me(user) {
  const u = (await getUser(user.email)) || { email: user.email, name: user.name, envIds: [] };
  const envs = [];
  for (const envId of u.envIds || []) {
    const meta = await getJSON(metaKey(envId));
    const mem = meta && (meta.members || []).find((x) => x.email === user.email);
    if (!meta || !mem) continue;
    envs.push({ envId, name: meta.name, brokerName: meta.brokerName, role: mem.role, opIds: mem.opIds || [], active: meta.active !== false });
  }
  return json({ user: { email: user.email, name: user.name, picture: user.picture, super: user.super }, envs });
}

/* ---------- invitaciones ---------- */
const inviteKey = (token) => {
  const scope = String(token).split("~")[0];
  if (!validId(scope) || !/^[A-Za-z0-9_-]+~[A-Za-z0-9]{16,}$/.test(token)) fail(400, "invitacion", "El link de invitación no es válido.");
  return `invites/${scope}/${token}`;
};
const ROLE_LABEL = { broker: "Broker", broker_env: "Broker", asistente: "Asistente", cliente: "Cliente", colaborador: "Broker invitado" };

async function createInvite(user, inp) {
  const type = inp.type;
  const name = String(inp.name || "").trim().slice(0, 80);
  let scope, envId = null, envName = null, opIds = [];
  if (type === "broker") {
    if (!user.super) fail(403, "solo_admin", "Solo el superusuario invita brokers.");
    scope = "brokers";
    envName = String(inp.envName || "").trim().slice(0, 80) || (name ? "Inmobiliaria " + name : "Nueva inmobiliaria");
  } else if (type === "broker_env") {
    envId = inp.envId;
    const ctx = await envContext(user, envId);
    if (ctx.role !== "broker") fail(403, "permiso", "Solo un broker del ambiente puede invitar a otros brokers.");
    envName = ctx.meta.name; scope = envId;
  } else if (type === "asistente" || type === "cliente" || type === "colaborador") {
    envId = inp.envId;
    const ctx = await envContext(user, envId);
    envName = ctx.meta.name;
    scope = envId;
    const existing = new Set((await listKeys(`envs/${envId}/ops/`)).map((k) => k.split("/").pop()));
    if (type === "asistente") {
      if (ctx.role !== "broker") fail(403, "permiso", "Solo el broker puede invitar asistentes.");
      opIds = (Array.isArray(inp.opIds) ? inp.opIds : []).filter((x) => existing.has(x));
    } else {
      const opId = inp.opId;
      if (!existing.has(opId)) fail(400, "operacion", "La operación no existe.");
      if (!canOp(ctx, opId)) fail(403, "permiso", "No tenés acceso a esa operación.");
      if (type === "colaborador" && ctx.role !== "broker") fail(403, "permiso", "Solo el broker dueño del ambiente invita a otros brokers.");
      opIds = [opId];
    }
  } else fail(400, "tipo", "Tipo de invitación inválido.");

  const token = `${scope}~${rid(24)}`;
  const inv = { token, type, scope, envId, envName, opIds, name, createdBy: { email: user.email, name: user.name }, created: Date.now(), expires: Date.now() + INVITE_DAYS * 864e5 };
  await setJSON(inviteKey(token), inv);
  return json({ invite: publicInvite(inv) });
}
function publicInvite(inv) {
  const status = inv.revoked ? "revocada" : inv.usedAt ? "usada" : inv.expires < Date.now() ? "vencida" : "pendiente";
  return { token: inv.token, type: inv.type, roleLabel: ROLE_LABEL[inv.type], envId: inv.envId, envName: inv.envName, opIds: inv.opIds, name: inv.name, inviterName: inv.createdBy?.name, created: inv.created, expires: inv.expires, status, usedBy: inv.usedBy || null };
}
async function inviteInfo(token) {
  const inv = await getJSON(inviteKey(token));
  if (!inv) fail(404, "invitacion", "La invitación no existe.");
  const p = publicInvite(inv);
  if ((inv.type === "cliente" || inv.type === "colaborador") && inv.envId && inv.opIds[0]) {
    const op = await getJSON(opKey(inv.envId, inv.opIds[0]));
    p.opName = op ? op.name : null;
  }
  return json({ invite: p });
}
async function acceptInvite(user, token) {
  const key = inviteKey(token);
  const inv = await getJSON(key);
  if (!inv) fail(404, "invitacion", "La invitación no existe.");
  const st = publicInvite(inv).status;
  if (st === "usada" && inv.usedBy !== user.email) fail(410, "usada", "Esta invitación ya fue usada por otra cuenta. Pedí un link nuevo.");
  if (st === "vencida") fail(410, "vencida", "La invitación venció. Pedí un link nuevo.");
  if (st === "revocada") fail(410, "revocada", "La invitación fue anulada.");
  if (st === "usada") return json({ envId: inv.resultEnvId || inv.envId, opId: inv.opIds[0] || null, already: true });

  let envId = inv.envId, opId = inv.opIds[0] || null;
  if (inv.type === "broker") {
    envId = "e" + rid(12);
    const meta = { id: envId, name: inv.envName, brokerEmail: user.email, brokerName: user.name, created: Date.now(), active: true,
      members: [{ email: user.email, name: user.name, role: "broker", opIds: [], added: Date.now() }] };
    await setJSON(metaKey(envId), meta);
  } else {
    const meta = await getJSON(metaKey(envId));
    if (!meta) fail(404, "ambiente", "El ambiente ya no existe.");
    if (meta.active === false) fail(403, "desactivado", "Este ambiente está desactivado.");
    meta.members = meta.members || [];
    let mem = meta.members.find((x) => x.email === user.email);
    if (!mem) { mem = { email: user.email, name: user.name, role: inv.type, opIds: [], added: Date.now() }; meta.members.push(mem); }
    if (inv.type === "broker_env") { mem.role = "broker"; mem.opIds = []; }
    else if (mem.role !== "broker") {
      if (inv.type === "colaborador") mem.role = "colaborador";
      else if (inv.type === "asistente" && mem.role !== "colaborador") mem.role = "asistente";
      mem.opIds = [...new Set([...(mem.opIds || []), ...inv.opIds])];
    }
    mem.name = user.name;
    await setJSON(metaKey(envId), meta);
    if (inv.type === "cliente" && opId) {
      const op = await getJSON(opKey(envId, opId));
      if (op) {
        op.clients = op.clients || [];
        let c = op.clients.find((x) => x.email === user.email);
        if (!c) {
          // si el broker ya había cargado al cliente con el mismo nombre y sin mail, se vincula
          c = op.clients.find((x) => !x.email && inv.name && x.name.toLowerCase() === inv.name.toLowerCase());
          if (c) c.email = user.email;
          else op.clients.push({ id: "c" + rid(8), name: user.name, email: user.email, slots: [], notes: "" });
        }
        op._v = (op._v || 0) + 1;
        await setJSON(opKey(envId, opId), op);
      }
    }
  }
  await addEnvToUser(user.email, envId, user);
  inv.usedAt = Date.now(); inv.usedBy = user.email; inv.resultEnvId = envId;
  await setJSON(key, inv);
  return json({ envId, opId, role: inv.type });
}
async function revokeInvite(user, token) {
  const key = inviteKey(token);
  const inv = await getJSON(key);
  if (!inv) fail(404, "invitacion", "La invitación no existe.");
  let ok = user.super || inv.createdBy?.email === user.email;
  if (!ok && inv.envId) { const ctx = await envContext(user, inv.envId); ok = ctx.role === "broker"; }
  if (!ok) fail(403, "permiso", "No podés anular esta invitación.");
  inv.revoked = Date.now(); await setJSON(key, inv);
  return json({ ok: true });
}
async function listInvites(scope) {
  const out = [];
  for (const k of await listKeys(`invites/${scope}/`)) { const inv = await getJSON(k); if (inv) out.push(inv); }
  return out.sort((x, y) => y.created - x.created);
}

/* ---------- ambiente y operaciones ---------- */
async function loadOps(envId) {
  const ops = [];
  for (const k of await listKeys(`envs/${envId}/ops/`)) { const op = await getJSON(k); if (op) ops.push(op); }
  return ops.sort((x, y) => (x.created || "").localeCompare(y.created || ""));
}
async function getEnv(user, envId) {
  const ctx = await envContext(user, envId);
  const ops = (await loadOps(envId)).filter((o) => canOp(ctx, o.id)).map((o) => viewFor(ctx, o));
  const { meta } = ctx;
  return json({ env: { id: meta.id, name: meta.name, brokerName: meta.brokerName, brokerEmail: meta.brokerEmail, active: meta.active !== false }, role: ctx.role, super: !!ctx.super, opIds: ctx.opIds, ops });
}
async function renameEnv(user, envId, inp) {
  const ctx = await envContext(user, envId);
  if (ctx.role !== "broker") fail(403, "permiso", "Solo el broker puede cambiar el nombre.");
  const name = String(inp.name || "").trim().slice(0, 80);
  if (!name) fail(400, "nombre", "Falta el nombre.");
  ctx.meta.name = name; await setJSON(metaKey(envId), ctx.meta);
  return json({ ok: true });
}
async function putOp(user, envId, opId, inp) {
  if (!validId(opId)) fail(400, "operacion", "Operación inválida.");
  const ctx = await envContext(user, envId);
  const inc = inp && inp.op;
  if (!inc || typeof inc !== "object") fail(400, "operacion", "Faltan los datos de la operación.");
  for (const k of ["props", "visits", "clients", "notices"]) if (inc[k] != null && !Array.isArray(inc[k])) fail(400, "operacion", "Datos inválidos.");
  const stored = await getJSON(opKey(envId, opId));
  if (!stored) {
    if (!canCreateOps(ctx.role)) fail(403, "permiso", "Solo el broker dueño del ambiente o su asistente crean operaciones.");
  } else {
    if (!canOp(ctx, opId)) fail(403, "permiso", "No tenés acceso a esta operación.");
    if ((inp.baseV || 0) !== (stored._v || 0)) {
      const e = new HttpError(409, "conflicto", "Otra persona hizo cambios en esta operación. Se actualizó con lo último.");
      e.extra = { op: viewFor(ctx, stored) }; throw e;
    }
  }
  let merged;
  if (ctx.role === "cliente") merged = mergeClient(stored, inc, user.email);
  else if (ctx.role === "asistente") merged = mergeAssistant(stored, inc);
  else merged = structuredClone(inc);
  merged.id = opId;
  merged.props = merged.props || []; merged.visits = merged.visits || []; merged.clients = merged.clients || []; merged.notices = merged.notices || [];
  merged.created = (stored && stored.created) || merged.created || new Date().toISOString().slice(0, 10);
  merged._v = ((stored && stored._v) || 0) + 1;
  merged.updatedAt = Date.now(); merged.updatedBy = user.email;
  const size = Buffer.byteLength(JSON.stringify(merged));
  if (size > MAX_OP_BYTES) fail(413, "muy_grande", "La operación es demasiado grande. Revisá que las fotos se hayan subido bien.");
  await setJSON(opKey(envId, opId), merged);
  if (!stored && ctx.role === "asistente") {
    const meta = await getJSON(metaKey(envId));
    const mem = meta.members.find((x) => x.email === user.email);
    if (mem && !mem.opIds.includes(opId)) { mem.opIds.push(opId); await setJSON(metaKey(envId), meta); }
  }
  return json({ op: viewFor(ctx, merged) });
}
async function deleteOp(user, envId, opId) {
  const ctx = await envContext(user, envId);
  if (ctx.role !== "broker") fail(403, "permiso", "Solo el broker puede eliminar operaciones.");
  await del(opKey(envId, opId));
  for (const mem of ctx.meta.members || []) mem.opIds = (mem.opIds || []).filter((x) => x !== opId);
  await setJSON(metaKey(envId), ctx.meta);
  return json({ ok: true });
}

/* ---------- equipo ---------- */
async function getTeam(user, envId) {
  const ctx = await envContext(user, envId);
  const invites = (await listInvites(envId)).map(publicInvite).filter((i) => i.status === "pendiente");
  const members = (ctx.meta.members || []).map((m) => ({ email: m.email, name: m.name, role: m.role, opIds: m.opIds || [], added: m.added }));
  if (ctx.role === "broker") return json({ members, invites });
  if (isStaffRole(ctx.role)) {
    const mine = new Set(ctx.opIds);
    const shared = (m) => m.role === "broker" || m.opIds.some((x) => mine.has(x));
    return json({
      members: (ctx.role === "colaborador" ? members.filter(shared) : members).map((m) => ({ ...m, opIds: m.role === "broker" ? [] : m.opIds.filter((x) => ctx.role === "asistente" || mine.has(x)) })),
      invites: invites.filter((i) => i.type === "cliente" && i.opIds.some((x) => canOp(ctx, x)))
    });
  }
  const mine = new Set(ctx.opIds);
  return json({
    members: members.filter((m) => m.role === "cliente" && m.opIds.some((x) => mine.has(x))).map(({ email, name, role, opIds }) => ({ email, name, role, opIds: opIds.filter((x) => mine.has(x)) })),
    invites: invites.filter((i) => i.type === "cliente" && i.opIds.some((x) => mine.has(x)))
  });
}
async function updateMember(user, envId, email, inp) {
  const ctx = await envContext(user, envId);
  if (ctx.role !== "broker") fail(403, "permiso", "Solo el broker asigna operaciones.");
  const mem = (ctx.meta.members || []).find((x) => x.email === normEmail(email));
  if (!mem) fail(404, "miembro", "No existe ese usuario en el ambiente.");
  if (mem.role === "broker") fail(400, "miembro", "El broker ve todas las operaciones.");
  const existing = new Set((await listKeys(`envs/${envId}/ops/`)).map((k) => k.split("/").pop()));
  if (Array.isArray(inp.opIds)) mem.opIds = inp.opIds.filter((x) => existing.has(x));
  await setJSON(metaKey(envId), ctx.meta);
  return json({ member: mem });
}
async function removeMember(user, envId, email) {
  const ctx = await envContext(user, envId);
  if (ctx.role !== "broker") fail(403, "permiso", "Solo el broker quita usuarios.");
  const e = normEmail(email);
  const mem = (ctx.meta.members || []).find((x) => x.email === e);
  if (!mem) fail(404, "miembro", "No existe ese usuario en el ambiente.");
  if (mem.role === "broker") {
    const brokers = (ctx.meta.members || []).filter((x) => x.role === "broker");
    if (brokers.length <= 1) fail(400, "miembro", "El ambiente tiene que tener al menos un broker.");
    if (e === user.email) fail(400, "miembro", "No podés quitarte a vos mismo. Pedíselo a otro broker del ambiente.");
  }
  ctx.meta.members = ctx.meta.members.filter((x) => x.email !== e);
  await setJSON(metaKey(envId), ctx.meta);
  await removeEnvFromUser(e, envId);
  return json({ ok: true });
}

/* ---------- fotos ---------- */
async function uploadPhoto(user, envId, req) {
  const ctx = await envContext(user, envId);
  if (!isStaffRole(ctx.role)) fail(403, "permiso", "Solo el broker o el asistente suben fotos.");
  const type = req.headers.get("content-type") || "";
  if (!/^image\/(jpeg|png|webp)$/.test(type)) fail(415, "formato", "La foto tiene que ser JPG, PNG o WEBP.");
  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_PHOTO_BYTES) fail(413, "muy_grande", "La foto es demasiado pesada.");
  const id = rid(20);
  await db().set(`photos/${envId}/${id}`, buf, { metadata: { type } });
  return json({ url: `/api/photo/${envId}/${id}` });
}
async function getPhoto(envId, id) {
  if (!validId(envId) || !validId(id)) fail(400, "foto", "Foto inválida.");
  const r = await db().getWithMetadata(`photos/${envId}/${id}`, { type: "arrayBuffer" });
  if (!r) fail(404, "foto", "La foto no existe.");
  return new Response(r.data, { headers: { "content-type": r.metadata?.type || "image/jpeg", "cache-control": "public, max-age=31536000, immutable" } });
}

/* ---------- superusuario ---------- */
async function adminEnvs() {
  const envs = [];
  for (const k of await listKeys("envs/")) {
    if (!k.endsWith("/meta")) continue;
    const meta = await getJSON(k); if (!meta) continue;
    const ops = (await listKeys(`envs/${meta.id}/ops/`)).length;
    const by = (r) => (meta.members || []).filter((m) => m.role === r).length;
    envs.push({ id: meta.id, name: meta.name, brokerName: meta.brokerName, brokerEmail: meta.brokerEmail, created: meta.created, active: meta.active !== false, ops, asistentes: by("asistente"), clientes: by("cliente"), colaboradores: by("colaborador"), brokers: (meta.members || []).filter((m) => m.role === "broker").map((m) => ({ email: m.email, name: m.name })) });
  }
  envs.sort((x, y) => y.created - x.created);
  const invites = (await listInvites("brokers")).map(publicInvite).filter((i) => i.status === "pendiente");
  return json({ envs, invites });
}
async function adminUpdateEnv(envId, inp) {
  const meta = await getJSON(metaKey(envId));
  if (!meta) fail(404, "ambiente", "El ambiente no existe.");
  if (typeof inp.active === "boolean") meta.active = inp.active;
  if (inp.name) meta.name = String(inp.name).trim().slice(0, 80);
  await setJSON(metaKey(envId), meta);
  return json({ ok: true });
}

// El superusuario asigna un broker existente a una operación de otro ambiente (queda como "broker invitado").
async function adminAssignBroker(envId, inp) {
  const meta = await getJSON(metaKey(envId));
  if (!meta) fail(404, "ambiente", "El ambiente no existe.");
  const opId = inp.opId;
  if (!validId(opId) || !(await getJSON(opKey(envId, opId)))) fail(404, "operacion", "La operación no existe.");
  const email = normEmail(inp.email);
  const u = await getUser(email);
  if (!u) fail(404, "usuario", "Ese broker todavía no ingresó a la app.");
  let isBrokerSomewhere = false;
  for (const k of await listKeys("envs/")) { if (!k.endsWith("/meta")) continue; const mm = await getJSON(k); if (mm && mm.brokerEmail === email) { isBrokerSomewhere = true; break; } }
  if (!isBrokerSomewhere) fail(400, "usuario", "Esa cuenta no es broker de ningún ambiente.");
  meta.members = meta.members || [];
  let mem = meta.members.find((x) => x.email === email);
  if (mem && mem.role === "broker") fail(400, "usuario", "Ese broker ya es el dueño de este ambiente.");
  if (!mem) { mem = { email, name: u.name, role: "colaborador", opIds: [], added: Date.now() }; meta.members.push(mem); }
  mem.role = "colaborador";
  mem.opIds = [...new Set([...(mem.opIds || []), opId])];
  await setJSON(metaKey(envId), meta);
  await addEnvToUser(email, envId, u);
  return json({ member: mem });
}


/* ---------- ambientes creados por brokers o por el superusuario ---------- */
async function brokerSomewhere(email) {
  const u = await getUser(email);
  for (const envId of (u && u.envIds) || []) {
    const meta = await getJSON(metaKey(envId));
    if (meta && (meta.members || []).some((m) => m.email === normEmail(email) && m.role === "broker")) return true;
  }
  return false;
}
async function createEnv(user, inp) {
  if (!user.super && !(await brokerSomewhere(user.email))) fail(403, "permiso", "Solo los brokers y el superusuario pueden crear ambientes.");
  const name = String(inp.name || "").trim().slice(0, 80);
  if (!name) fail(400, "nombre", "Poné un nombre para el ambiente.");
  const envId = "e" + rid(12);
  const meta = { id: envId, name, brokerEmail: user.email, brokerName: user.name, created: Date.now(), active: true, createdBy: user.email,
    members: [{ email: user.email, name: user.name, role: "broker", opIds: [], added: Date.now() }] };
  await setJSON(metaKey(envId), meta);
  await addEnvToUser(user.email, envId, user);
  return json({ envId, name });
}
// Asignar directamente (sin link) a un broker que ya usa la app. El superusuario puede asignar a cualquier usuario registrado.
async function assignBroker(user, envId, inp) {
  const ctx = await envContext(user, envId);
  if (ctx.role !== "broker") fail(403, "permiso", "Solo un broker del ambiente puede sumar brokers.");
  const email = normEmail(inp.email);
  if (!email || !email.includes("@")) fail(400, "mail", "Escribí el mail de Google del broker.");
  const u = await getUser(email);
  if (!u) fail(404, "usuario", "Ese mail todavía no ingresó a la app. Mandale una invitación con link.");
  if (!user.super && !(await brokerSomewhere(email))) fail(400, "usuario", "Esa cuenta no es broker en ningún ambiente. Mandale una invitación con link.");
  const meta = ctx.meta; meta.members = meta.members || [];
  let mem = meta.members.find((x) => x.email === email);
  if (mem && mem.role === "broker") fail(400, "usuario", "Ya es broker de este ambiente.");
  if (!mem) { mem = { email, name: u.name, added: Date.now() }; meta.members.push(mem); }
  mem.role = "broker"; mem.opIds = []; mem.name = u.name;
  await setJSON(metaKey(envId), meta);
  await addEnvToUser(email, envId, u);
  return json({ member: mem });
}
