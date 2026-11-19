"use strict";
/*
 * playltc chat backend (Vercel serverless function, route: /api/chat)
 *
 * Every chat message goes through here, never straight from the browser to the database.
 *  1. Checks who is sending (Firebase login token).
 *  2. Refuses the message if that person is muted (permanent mute from the owner panel,
 *     or a timed mute in "mutes/<name>").
 *  3. Checks the text against the hate-speech filter. A hit blocks the message and mutes the
 *     sender for 5 minutes straight away.
 *  4. Otherwise saves the message with the Firebase Admin SDK.
 *
 * Needs FIREBASE_SERVICE_ACCOUNT (already set for deposits). Optional:
 *   BLOCKED_WORDS  extra words to block, comma separated, e.g. "word1,word2"
 *   FIREBASE_DB_URL
 */

const MUTE_MS = 5 * 60 * 1000;
const MAIL = "@users.playltc.wtf";
const LIST = "eyJzdHJpY3QiOiBbIm5pZ2dlciIsICJuaWdnYSIsICJmYWdnb3QiXSwgIndvcmQiOiBbImNoaW5rIiwgImdvb2siLCAic3BpYyIsICJzcGljayIsICJraWtlIiwgImNvb24iLCAid2V0YmFjayIsICJiZWFuZXIiLCAicGFraSIsICJyYWdoZWFkIiwgInRvd2VsaGVhZCIsICJ0cmFubnkiLCAiZmFnIiwgImR5a2UiLCAicmV0YXJkIiwgImppZ2Fib28iLCAiZGFya2llIiwgInppcHBlcmhlYWQiXSwgInBocmFzZXMiOiBbIlxcYig/OndoaXRlfGFyeWFuKSAoPzpwb3dlcnxwcmlkZXxzdXByZW1hY3kpXFxiIiwgIlxcYmhlaWwgaGl0bGVyXFxiIiwgIlxcYnNpZWcgaGVpbFxcYiIsICJcXGJnYXMgdGhlIGpld3M/XFxiIiwgIlxcYmtpbGwgYWxsICg/OnRoZSApPyg/OmJsYWNrcz98amV3cz98d2hpdGVzP3xtdXNsaW1zP3xnYXlzP3xtZXhpY2Fucz98YXNpYW5zP3xhcmFicz8pXFxiIl19";

let admin = null;
function init() {
  if (!admin) {
    admin = require("firebase-admin");
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
        databaseURL: process.env.FIREBASE_DB_URL || "https://playltcwtf-default-rtdb.firebaseio.com"
      });
    }
  }
  return admin;
}

// ---- the filter -------------------------------------------------------------------------
const LEET = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i", "|": "i", "+": "t" };
const HOMO = { "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0441": "c", "\u0440": "p", "\u0445": "x", "\u0443": "y", "\u0456": "i", "\u0455": "s" };
// innocent words that contain a blocked string
const OK_WORDS = /\b(?:sniggers?|sniggering|sniggered|niggardly|niggard)\b/g;

let R = null;
function rules() {
  if (!R) {
    const d = JSON.parse(Buffer.from(LIST, "base64").toString("utf8"));
    const rx = (t) => t.split("").map((c) => c + "+").join("");   // allow stretched letters: "cooon"
    const extra = (process.env.BLOCKED_WORDS || "").toLowerCase().split(",").map((s) => s.replace(/[^a-z]/g, "")).filter(Boolean);
    R = {
      strict: new RegExp(d.strict.map(rx).join("|")),
      words: new RegExp("(?:^| )(?:" + d.word.concat(extra).map(rx).join("|") + ")(?:s|z|es|ed)?(?= |$)"),
      phrases: d.phrases.map((p) => new RegExp(p))
    };
  }
  return R;
}

function variants(text) {
  const base = String(text).normalize("NFKD")
    .replace(/[\u0300-\u036f\u200b-\u200f\u2060\ufeff\u00ad]/g, "")
    .toLowerCase()
    .replace(/[\u0430\u0435\u043e\u0441\u0440\u0445\u0443\u0456\u0455]/g, (c) => HOMO[c]);
  const leet = base.replace(/[01345@$!|+7]/g, (c) => LEET[c] || c);
  return [base, leet].map((v) => {
    let sp = v.replace(/[^a-z]+/g, " ").trim().replace(OK_WORDS, " ").replace(/ +/g, " ");
    sp = sp.replace(/(?:\b[a-z] ){2,}[a-z]\b/g, (m) => m.replace(/ /g, ""));   // "c o o n" -> "coon"
    return { sp, sq: sp.replace(/ /g, "") };
  });
}

function blocked(text) {
  const r = rules();
  return variants(text).some((v) => r.strict.test(v.sq) || r.words.test(v.sp) || r.phrases.some((p) => p.test(v.sp)));
}

// ---- the endpoint -----------------------------------------------------------------------
async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const text = String(body.text || "").trim().slice(0, 200);
    if (!text) return res.status(400).json({ error: "Empty message." });

    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    if (!m) return res.status(401).json({ error: "Log in again." });
    const a = init();
    let tok;
    try { tok = await a.auth().verifyIdToken(m[1]); } catch (e) {
      // If this says the token has an incorrect "aud" (audience), the service account in Vercel is from a different Firebase project than the site's login.
      console.error("chat: token check failed:", e && e.message);
      return res.status(401).json({ error: "Log in again." });
    }
    const email = String(tok.email || "");
    if (!email.endsWith(MAIL)) return res.status(403).json({ error: "Not allowed." });
    const name = email.slice(0, -MAIL.length);

    const db = a.database();
    const [perm, timed] = await Promise.all([db.ref("muted/" + name).once("value"), db.ref("mutes/" + name).once("value")]);
    if (perm.exists()) return res.status(403).json({ error: "muted", permanent: true });
    const until = Number(timed.val()) || 0;
    if (until > Date.now()) return res.status(403).json({ error: "muted", until });

    if (blocked(text)) {
      const end = Date.now() + MUTE_MS;
      await db.ref("mutes/" + name).set(end);
      return res.status(403).json({ error: "blocked", until: end });
    }

    // One message per second per user, enforced here so nobody can skip the page's own limit.
    const rl = await db.ref("rl/chat/" + tok.uid).transaction((t) => (Date.now() - (Number(t) || 0) < 1000 ? undefined : Date.now()));
    if (!rl.committed) return res.status(429).json({ error: "Slow down." });

    await db.ref("messages").push({ name, uid: tok.uid, text, ts: a.database.ServerValue.TIMESTAMP });
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("chat:", e && e.message);   // shows up in Vercel -> Logs
    return res.status(500).json({ error: "Something went wrong. Try again." });
  }
}

module.exports = handler;
module.exports.blocked = blocked;
