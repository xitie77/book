import { db } from "../db.js";
import {
  login,
  requireAuth,
  setSessionCookie,
  clearSessionCookie,
  destroySession,
  createSession,
  destroyUserSessions,
} from "../auth.js";
import { hashPassword, verifyPassword } from "../db.js";

export default async function authRoutes(app) {
  /* 登录 */
  app.post("/api/auth/login", async (request, reply) => {
    const { username, password } = request.body || {};
    const result = login(username, password);
    if (!result) return reply.code(401).send({ error: "账号或密码错误" });
    setSessionCookie(reply, result.token);
    return { user: result.user };
  });

  /* 退出 */
  app.post("/api/auth/logout", async (request, reply) => {
    destroySession(request.cookies?.book_sid);
    clearSessionCookie(reply);
    return { ok: true };
  });

  /* 当前用户 */
  app.get("/api/auth/me", { preHandler: requireAuth }, async (request) => {
    return { user: request.user };
  });

  /* 修改密码（仅自己） */
  app.patch("/api/auth/password", { preHandler: requireAuth }, async (request, reply) => {
    const { oldPassword, newPassword } = request.body || {};
    if (!newPassword || String(newPassword).length < 6) {
      return reply.code(400).send({ error: "新密码至少 6 位" });
    }
    const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(request.user.id);
    if (!row || !verifyPassword(oldPassword, row.password_hash)) {
      return reply.code(400).send({ error: "原密码不正确" });
    }
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
      hashPassword(newPassword),
      request.user.id
    );
    // 其它设备下线，保留当前会话
    destroyUserSessions(request.user.id, request.cookies?.book_sid);
    return { ok: true };
  });

  /* 修改昵称 */
  app.patch("/api/auth/profile", { preHandler: requireAuth }, async (request, reply) => {
    const { displayName } = request.body || {};
    const name = String(displayName || "").trim().slice(0, 30);
    if (!name) return reply.code(400).send({ error: "昵称不能为空" });
    db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(name, request.user.id);
    return { ok: true };
  });
}

export { createSession };
