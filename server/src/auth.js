import { randomBytes } from "node:crypto";
import { db, verifyPassword } from "./db.js";

export const SESSION_COOKIE = "book_sid";
const SESSION_DAYS = 30;

export function createSession(userId) {
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  const expiresAt = expires.toISOString().slice(0, 19).replace("T", " ");
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(
    token,
    userId,
    expiresAt
  );
  return { token, expiresAt };
}

export function destroyUserSessions(userId, keepToken = null) {
  if (keepToken) {
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND token <> ?").run(userId, keepToken);
  } else {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }
}

export function destroySession(token) {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function userFromToken(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.is_admin, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ?`
    )
    .get(token);
  if (!row) return null;
  if (new Date(row.expires_at.replace(" ", "T")) < new Date()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isAdmin: !!row.is_admin,
  };
}

export function login(username, password) {
  const row = db
    .prepare("SELECT id, username, display_name, is_admin, password_hash FROM users WHERE username = ?")
    .get(String(username || "").trim());
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  const { token } = createSession(row.id);
  return {
    token,
    user: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      isAdmin: !!row.is_admin,
    },
  };
}

/**
 * preHandler：要求已登录。
 * 必须写 async（Fastify 5 里同步且不返回值的 hook 会让请求永久挂起）。
 */
export async function requireAuth(request, reply) {
  const token = request.cookies?.[SESSION_COOKIE];
  const user = userFromToken(token);
  if (!user) return reply.code(401).send({ error: "未登录或登录已过期" });
  request.user = user;
}

export function setSessionCookie(reply, token) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: SESSION_DAYS * 24 * 3600,
  });
}

export function clearSessionCookie(reply) {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}
