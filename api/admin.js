"use strict";
/*
 * playltc owner-panel backend (Vercel serverless function, route: /api/admin)
 *
 * The owner panel (announcements, mutes, badges, deposits, user list, chat cleanup) sends its
 * reads and writes here instead of straight to Firebase. This checks that the caller is the owner
 * account, then does the change with the Firebase Admin SDK, so it never depends on the Rules.
 *
 * Needs FIREBASE_SERVICE_ACCOUNT (already set). Optional: FIREBASE_DB_URL.
 */

const OWNER_EMAIL = "123@users.playltc.wtf";
const READ = ["announcement", "muted", "mutes", "badges", "deposits", "users", "messages"];
const WRITE = ["announcement", "muted", "mutes", "badges", "deposits", "messages"];

let admin = null;
function init() {
  if (!admin) {
    admin = require("firebase-admin");
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
        databaseURL: process.env.FIREBASE_DB_URL || "https://playltc-default-rtdb.firebaseio.com"
      });
    }
  }
  return admin;
}

// A brand-new login token can be refused for a second or two if this server's clock is slightly behind ("used too early"). Retry briefly.
async function verifyToken(a, t) {
  for (let i = 0; ; i++) {
    try { return await a.auth().verifyIdToken(t); }
    catch (e) {
      if (i < 3 && /too early/i.test((e && e.message) || "")) { await new Promise(function (r) { setTimeout(r, 1500); }); continue; }
      throw e;
    }
  }
}

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

// "badges/bob" or "muted/bo%20b" -> clean path, or throws.
function cleanPath(p) {
  const parts = String(p || "").split("/").filter(Boolean).map(function (s) {
    let d; try { d = decodeURIComponent(s); } catch (e) { throw httpErr(400, "Bad path."); }
    if (!/^[-\w]{1,64}$/.test(d)) throw httpErr(400, "Bad path.");
    return d;
  });
  if (!parts.length || parts.length > 3) throw httpErr(400, "Bad path.");
  return parts;
}

async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  if (req.method !== "POST") return res.status(405).end(JSON.stringify({ error: "POST only" }));
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    if (!m) throw httpErr(401, "Log in again.");
    const a = init();
    let tok;
    try { tok = await verifyToken(a, m[1]); } catch (e) { console.error("admin: token check failed:", e && e.message); throw httpErr(401, "Log in again."); }
    if (String(tok.email || "").toLowerCase() !== OWNER_EMAIL) throw httpErr(403, "Owner only.");

    const method = String(body.method || "GET").toUpperCase();
    const parts = cleanPath(body.path);
    const top = parts[0];
    const ref = a.database().ref(parts.join("/"));
    let out = true;

    if (method === "GET") {
      if (READ.indexOf(top) < 0) throw httpErr(403, "Not allowed.");
      const v = (await ref.once("value")).val();
      out = body.shallow && v && typeof v === "object"
        ? Object.keys(v).reduce(function (o, k) { o[k] = true; return o; }, {})
        : v;
    } else {
      if (WRITE.indexOf(top) < 0) throw httpErr(403, "Not allowed.");
      if (JSON.stringify(body.body === undefined ? null : body.body).length > 200000) throw httpErr(400, "Too big.");
      if (method === "PUT") {
        if (top === "announcement") {
          const b = body.body;
          const ok = typeof b === "string" ? b.length <= 200
            : b && typeof b.t === "string" && b.t.length <= 200 && typeof b.e === "number";
          if (!ok) throw httpErr(400, "Bad announcement.");
        }
        await ref.set(body.body === undefined ? null : body.body);
      } else if (method === "PATCH") {
        if (!body.body || typeof body.body !== "object") throw httpErr(400, "Bad body.");
        await ref.update(body.body);
      } else if (method === "DELETE") {
        await ref.remove();
      } else throw httpErr(400, "Bad method.");
    }
    return res.status(200).end(JSON.stringify(out === undefined ? null : out));
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error("admin:", e && e.message);
    return res.status(status).end(JSON.stringify({ error: status === 500 ? "Something went wrong. Try again." : e.message }));
  }
}

module.exports = handler;
module.exports.cleanPath = cleanPath;
