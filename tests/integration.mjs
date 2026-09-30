/**
 * 集成检查：启动完整服务（含已构建的前端产物），验证
 *  · / 返回前端页面
 *  · 深链接 /book/1 走 SPA 回退返回 index.html
 *  · /api/* 未授权返回 JSON 401（而不是落到前端）
 *  · 登录 → 上传 → 阅读 全链路
 * 用法：node tests/integration.mjs   （需先 cd web && npm run build）
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSampleEpub } from "./lib-epub.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const PORT = 4400;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP_PW = "test-" + "pass-1234";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "book-int-"));

const distExists = fs.existsSync(path.join(ROOT, "web", "dist", "index.html"));
if (!distExists) {
  console.error("请先构建前端：cd web && npm run build");
  process.exit(2);
}

let pass = 0,
  fail = 0;
const check = (n, c, e = "") => (c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n + " " + e)));

const server = spawn(process.execPath, ["src/index.js"], {
  cwd: path.join(ROOT, "server"),
  env: { ...process.env, PORT: String(PORT), DATA_DIR: tmp, ADMIN_PASSWORD: TMP_PW, LOG_LEVEL: "warn" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

async function wait() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

let cookie = "";
const getCookie = (res) => {
  const m = (res.headers.getSetCookie?.() || []).join(";").match(/book_sid=([^;]+)/);
  if (m) cookie = `book_sid=${m[1]}`;
};

async function main() {
  if (!(await wait())) throw new Error("服务未启动");

  console.log("\n== 静态资源 / SPA ==");
  let r = await fetch(`${BASE}/`);
  let html = await r.text();
  check("/ 200 且是前端页面", r.status === 200 && html.includes('id="root"'), `status=${r.status}`);

  r = await fetch(`${BASE}/book/1`);
  const deep = await r.text();
  check("深链接 /book/1 走 SPA 回退", r.status === 200 && deep.includes('id="root"'), `status=${r.status}`);

  r = await fetch(`${BASE}/api/books`);
  const j = await r.json().catch(() => ({}));
  check("/api 未授权返回 JSON 401", r.status === 401 && j.error, `status=${r.status}`);

  console.log("\n== 全链路 ==");
  r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "wbx", password: TMP_PW }),
  });
  check("登录", r.status === 200, `status=${r.status}`);
  getCookie(r);

  const text =
    "第一章 开始\n\n夜色温柔，风也温柔。\n\n第二章 结束\n\n故事到这里就结束了。\n";
  const fd = new FormData();
  fd.append("file", new Blob([Buffer.from(text, "utf8")], { type: "text/plain" }), "演示.txt");
  r = await fetch(`${BASE}/api/books`, { method: "POST", headers: { cookie }, body: fd });
  const up = await r.json();
  check("上传 201", r.status === 201, JSON.stringify(up));
  check("2 章", up.book?.chapterCount === 2, up.book?.chapterCount);

  const ch = await (
    await fetch(`${BASE}/api/books/${up.book.id}/chapters/1`, { headers: { cookie } })
  ).json();
  check("读到正文", ch.chapter?.content?.includes("夜色温柔"), ch.chapter?.content);
  check("下一章指针", ch.nextIdx === 2, ch.nextIdx);

  console.log("\n== EPUB 全链路 ==");
  const epub = buildSampleEpub();
  const fd2 = new FormData();
  fd2.append("file", new Blob([epub], { type: "application/epub+zip" }), "剑来.epub");
  r = await fetch(`${BASE}/api/books`, { method: "POST", headers: { cookie }, body: fd2 });
  const ep = await r.json();
  check("EPUB 上传 201", r.status === 201, JSON.stringify(ep));
  check("EPUB 书名", ep.book?.title === "剑来", ep.book?.title);
  check("EPUB 2 章", ep.book?.chapterCount === 2, ep.book?.chapterCount);
  check("EPUB 有封面", ep.book?.hasCover === true, ep.book?.hasCover);
  const ebc = await fetch(`${BASE}/api/books/${ep.book.id}/cover`, { headers: { cookie } });
  check("EPUB 封面可下载", ebc.status === 200, `status=${ebc.status}`);
  const ech = await (
    await fetch(`${BASE}/api/books/${ep.book.id}/chapters/1`, { headers: { cookie } })
  ).json();
  check("EPUB 读到正文", ech.chapter?.content?.includes("小镇上空的云很厚"), ech.chapter?.content?.slice(0, 20));

  console.log(`\n===== 集成：${pass} 通过 / ${fail} 失败 =====`);
  server.kill();
  await new Promise((r) => setTimeout(r, 400));
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {}
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  server.kill();
  process.exit(1);
});
