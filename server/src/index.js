import path from "node:path";
import fs from "node:fs";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";

import { SERVER_ROOT } from "./paths.js";
import "./db.js"; // 触发建表与初始账号
import authRoutes from "./routes/auth.js";
import bookRoutes from "./routes/books.js";

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 50);

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || "info" },
  bodyLimit: 5 * 1024 * 1024,
  trustProxy: true, // 位于 Caddy 之后
});

await app.register(cookie);
await app.register(multipart, {
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 5 },
});

app.get("/api/health", async () => ({
  ok: true,
  service: "book",
  time: new Date().toISOString(),
}));

await app.register(authRoutes);
await app.register(bookRoutes);

/* ---------- 前端静态资源（生产：后端直接托管 Vite 产物） ---------- */
const clientDir = path.join(SERVER_ROOT, "..", "web", "dist");
if (fs.existsSync(clientDir)) {
  await app.register(fastifyStatic, { root: clientDir, prefix: "/" });
  app.setNotFoundHandler((request, reply) => {
    if (request.raw.url?.startsWith("/api/")) {
      return reply.code(404).send({ error: "接口不存在" });
    }
    return reply.sendFile("index.html");
  });
} else {
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: "前端产物未构建（web/dist 不存在）" })
  );
}

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`小说阅读器已启动: http://localhost:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
