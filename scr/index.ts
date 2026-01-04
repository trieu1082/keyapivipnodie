import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { Redis } from "@upstash/redis/cloudflare";

export interface Env {
  // Upstash (Cloudflare integration hoặc tự set secrets)
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;

  // Your tokens
  PASTEFY_TOKEN: string;
  LINK4M_TOKEN: string;
  ADMIN_TOKEN: string;
}

const app = new Hono<{ Bindings: Env }>();

// CORS + Helmet equivalent
app.use("*", cors());
app.use("*", secureHeaders());

// TTL
const PENDING_TTL = 30 * 60;        // 30 phút
const ACTIVE_TTL  = 24 * 60 * 60;   // 24h
const KICK_TTL    = 5 * 60;         // 5 phút

function nowMs() {
  return Date.now();
}

function base64UrlEncode(bytes: Uint8Array) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function genKey() {
  // giống randomBytes(24).toString("base64url") bên Node
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function getRedis(env: Env) {
  // Cloudflare Workers + Upstash integration support
  return Redis.fromEnv(env);
}

async function isBlacklisted(redis: Redis, hwid: string) {
  return (await redis.get(`blacklist:${hwid}`)) || null;
}

async function createPastefyPublicNote(env: Env, { title, content }: { title: string; content: string }) {
  if (!env.PASTEFY_TOKEN) throw new Error("Missing PASTEFY_TOKEN");

  const r = await fetch("https://pastefy.app/api/v2/paste", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.PASTEFY_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title,
      content,
      encrypted: false,
      visibility: "UNLISTED", // hoặc "PUBLIC" nếu muốn public list
      type: "PASTE",
    }),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Pastefy create failed: ${r.status} ${text}`);
  }

  const data: any = await r.json();
  const paste = data?.paste;
  const id = paste?.id;
  const rawUrl = paste?.raw_url;
  const viewUrl = id ? `https://pastefy.app/${id}` : null;
  return { id, rawUrl, viewUrl };
}

// Link4m shorten
async function createLink4m(env: Env, longUrl: string) {
  if (!env.LINK4M_TOKEN) throw new Error("Missing LINK4M_TOKEN");

  const api = `https://link4m.co/api-shorten/v2?api=${env.LINK4M_TOKEN}&url=${encodeURIComponent(longUrl)}`;
  const r = await fetch(api);
  const j: any = await r.json();

  if (j.status !== "success" || !j.shortenedUrl) {
    throw new Error("Link4m shorten failed: " + JSON.stringify(j));
  }
  return j.shortenedUrl as string;
}

// ===== Admin middleware =====
const requireAdmin = async (c: any, next: any) => {
  const t = c.req.header("x-admin-token");
  if (!t || t !== c.env.ADMIN_TOKEN) return c.json({ ok: false, error: "UNAUTHORIZED" }, 401);
  return next();
};

// ============ USER ============

// 1) getkey
app.get("/v1/getkey", async (c) => {
  try {
    const hwid = String(c.req.query("hwid") || "").trim();
    if (!hwid) return c.json({ ok: false, error: "MISSING_HWID" }, 400);

    const redis = getRedis(c.env);

    const bl = await isBlacklisted(redis, hwid);
    if (bl) return c.json({ ok: false, error: "BLACKLISTED", info: bl }, 403);

    // active?
    const active: any = await redis.get(`active:${hwid}`);
    if (active?.expiresAt) {
      const left = Math.max(0, Math.floor((active.expiresAt - nowMs()) / 1000));
      return c.json({ ok: true, mode: "ACTIVE", secondsLeft: left, expiresAt: active.expiresAt });
    }

    // pending exists?
    const pending: any = await redis.get(`pending:${hwid}`);
    if (pending?.key && (pending?.link4mUrl || pending?.pasteUrl)) {
      const ttl = await redis.ttl(`pending:${hwid}`); // seconds
      return c.json({
        ok: true,
        mode: "PENDING_EXISTS",
        getKeyLink: pending.link4mUrl || pending.pasteUrl,
        pendingSecondsLeft: ttl,
      });
    }

    // create pending
    const key = genKey();

    const noteText =
`HWIND KEY (resset trog 30p nếu bn ko nhập!)
KEY: ${key}

Nhập key vào script và dùng!.
(by trieu1082)`;

    const paste = await createPastefyPublicNote(c.env, {
      title: `HWIND KEY - ${hwid.slice(0, 10)}`,
      content: noteText,
    });

    const pasteUrl = paste.viewUrl || paste.rawUrl;

    // shorten link4m (fail -> fallback pasteUrl)
    let link4mUrl: string | null = null;
    try {
      link4mUrl = await createLink4m(c.env, pasteUrl);
    } catch {
      link4mUrl = null;
    }

    await redis.set(
      `pending:${hwid}`,
      { key, createdAt: nowMs(), pasteId: paste.id, pasteUrl, link4mUrl },
      { ex: PENDING_TTL }
    );

    return c.json({
      ok: true,
      mode: "PENDING_CREATED",
      getKeyLink: link4mUrl || pasteUrl,
      expiresIn: PENDING_TTL,
    });
  } catch (e: any) {
    return c.json({ ok: false, error: "SERVER_ERROR", message: String(e?.message || e) }, 500);
  }
});

// 2) redeem
app.post("/v1/redeem", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const hwid = String(body?.hwid || "").trim();
    const key = String(body?.key || "").trim();
    if (!hwid || !key) return c.json({ ok: false, error: "MISSING_HWID_OR_KEY" }, 400);

    const redis = getRedis(c.env);

    const bl = await isBlacklisted(redis, hwid);
    if (bl) return c.json({ ok: false, error: "BLACKLISTED", info: bl }, 403);

    const active: any = await redis.get(`active:${hwid}`);
    if (active?.expiresAt) {
      const left = Math.max(0, Math.floor((active.expiresAt - nowMs()) / 1000));
      return c.json({ ok: true, mode: "ALREADY_ACTIVE", secondsLeft: left, expiresAt: active.expiresAt });
    }

    const pending: any = await redis.get(`pending:${hwid}`);
    if (!pending?.key) return c.json({ ok: false, error: "NO_PENDING_KEY" }, 404);
    if (pending.key !== key) return c.json({ ok: false, error: "INVALID_KEY" }, 401);

    const activatedAt = nowMs();
    const expiresAt = activatedAt + ACTIVE_TTL * 1000;

    await redis.set(`active:${hwid}`, { key, activatedAt, expiresAt }, { ex: ACTIVE_TTL });
    await redis.del(`pending:${hwid}`);

    return c.json({ ok: true, mode: "ACTIVATED", expiresAt, secondsLeft: ACTIVE_TTL });
  } catch (e: any) {
    return c.json({ ok: false, error: "SERVER_ERROR", message: String(e?.message || e) }, 500);
  }
});

app.get("/v1/status", async (c) => {
  try {
    const hwid = String(c.req.query("hwid") || "").trim();
    if (!hwid) return c.json({ ok: false, error: "MISSING_HWID" }, 400);

    const redis = getRedis(c.env);

    const bl = await isBlacklisted(redis, hwid);
    if (bl) return c.json({ ok: false, error: "BLACKLISTED", info: bl }, 403);

    const active: any = await redis.get(`active:${hwid}`);
    if (!active?.expiresAt) return c.json({ ok: true, valid: false, secondsLeft: 0 });

    const left = Math.max(0, Math.floor((active.expiresAt - nowMs()) / 1000));
    return c.json({ ok: true, valid: left > 0, secondsLeft: left, expiresAt: active.expiresAt });
  } catch (e: any) {
    return c.json({ ok: false, error: "SERVER_ERROR", message: String(e?.message || e) }, 500);
  }
});

// poll
app.get("/v1/poll", async (c) => {
  try {
    const hwid = String(c.req.query("hwid") || "").trim();
    if (!hwid) return c.json({ ok: false, error: "MISSING_HWID" }, 400);

    const redis = getRedis(c.env);

    const bl = await isBlacklisted(redis, hwid);
    if (bl) return c.json({ ok: false, error: "BLACKLISTED", info: bl }, 403);

    const kick: any = await redis.get(`kick:${hwid}`);

    const active: any = await redis.get(`active:${hwid}`);
    let secondsLeft = 0;
    let valid = false;

    if (active?.expiresAt) {
      secondsLeft = Math.max(0, Math.floor((active.expiresAt - nowMs()) / 1000));
      valid = secondsLeft > 0;
    }

    return c.json({
      ok: true,
      valid,
      secondsLeft,
      expiresAt: active?.expiresAt || null,
      kick: kick || null,
    });
  } catch (e: any) {
    return c.json({ ok: false, error: "SERVER_ERROR", message: String(e?.message || e) }, 500);
  }
});

// ============ ADMIN ============
app.get("/admin/actives", requireAdmin, async (c) => {
  try {
    const redis = getRedis(c.env);

    let cursor: any = 0;
    const out: any[] = [];

    do {
      const [nextCursor, keys] = await redis.scan(cursor, { match: "active:*", count: 200 });
      cursor = Number(nextCursor);

      for (const k of keys as string[]) {
        const hwid = String(k).slice("active:".length);
        const v: any = await redis.get(k);
        if (!v?.expiresAt) continue;

        const left = Math.max(0, Math.floor((v.expiresAt - nowMs()) / 1000));
        out.push({ hwid, secondsLeft: left, expiresAt: v.expiresAt, activatedAt: v.activatedAt });
      }
    } while (cursor !== 0);

    out.sort((a, b) => b.secondsLeft - a.secondsLeft);
    return c.json({ ok: true, count: out.length, items: out });
  } catch (e: any) {
    return c.json({ ok: false, error: "SERVER_ERROR", message: String(e?.message || e) }, 500);
  }
});

app.post("/admin/blacklist", requireAdmin, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const hwid = String(body?.hwid || "").trim();
    const reason = String(body?.reason || "blacklisted").trim();
    if (!hwid) return c.json({ ok: false, error: "MISSING_HWID" }, 400);

    const redis = getRedis(c.env);

    await redis.set(`blacklist:${hwid}`, { reason, at: nowMs() });
    await redis.del(`pending:${hwid}`);
    await redis.del(`active:${hwid}`);

    await redis.set(`kick:${hwid}`, { reason, at: nowMs() }, { ex: KICK_TTL });

    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: "SERVER_ERROR", message: String(e?.message || e) }, 500);
  }
});

app.post("/admin/unblacklist", requireAdmin, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const hwid = String(body?.hwid || "").trim();
    if (!hwid) return c.json({ ok: false, error: "MISSING_HWID" }, 400);

    const redis = getRedis(c.env);
    await redis.del(`blacklist:${hwid}`);

    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: "SERVER_ERROR", message: String(e?.message || e) }, 500);
  }
});

app.post("/admin/kick", requireAdmin, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const hwid = String(body?.hwid || "").trim();
    const reason = String(body?.reason || "kicked by admin").trim();
    if (!hwid) return c.json({ ok: false, error: "MISSING_HWID" }, 400);

    const redis = getRedis(c.env);
    await redis.set(`kick:${hwid}`, { reason, at: nowMs() }, { ex: KICK_TTL });

    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: "SERVER_ERROR", message: String(e?.message || e) }, 500);
  }
});

app.get("/", (c) => c.text("HWIND Key API OK"));

export default app;
