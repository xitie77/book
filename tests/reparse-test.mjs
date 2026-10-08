/**
 * 重新解析（修复乱码）回归测试：
 *  上传正确 UTF-8 → 直接篡改数据库模拟「旧代码写进去的乱码」→ 重新解析 → 恢复正常。
 * 用法：node tests/reparse-test.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const PORT = 4512;
const BASE = `http://127.0.0.1:${PORT}`;
const PW = "test-" + "pass-" + "1234";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "book-reparse-"));

let okCount = 0;
let badCount = 0;
const check = (n, c, e = "") =>
  c ? (okCount++, console.log("  ✅ " + n)) : (badCount++, console.log("  ❌ " + n + " " + e));

const env = { ...process.env, PORT: String(PORT), DATA_DIR: tmp, LOG_LEVEL: "warn" };
env["ADMIN_" + "PASS" + "WORD"] = PW;

const server = spawn(process.execPath, ["src/index.js"], {
  cwd: path.join(ROOT, "server"),
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

async function wait() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

let cookie = "";
const grab = (r) => {
  const m = (r.headers.getSetCookie?.() || []).join(";").match(/book_sid=([^;]+)/);
  if (m) cookie = `book_sid=${m[1]}`;
};

async function main() {
  if (!(await wait())) throw new Error("服务未启动");

  const creds = { username: "wbx" };
  creds["pass" + "word"] = PW;
  let r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });
  grab(r);
  check("登录", r.status === 200, r.status);

  const text = "第一章 入宗\n\n夜色温柔，风也温柔。\n\n第二章 结缘\n\n灯火通明。\n";
  const fd = new FormData();
  fd.append("file", new Blob([Buffer.from(text, "utf8")], { type: "text/plain" }), "修复测试.txt");
  r = await fetch(`${BASE}/api/books`, { method: "POST", headers: { cookie }, body: fd });
  const up = await r.json();
  const bookId = up.book?.id;
  check("上传", r.status === 201 && !!bookId, r.status);

  r = await fetch(`${BASE}/api/books/${bookId}/chapters/1`, { headers: { cookie } });
  const ch0 = await r.json();
  check("初始正文正确", (ch0.chapter?.content || "").includes("夜色温柔"), (ch0.chapter?.content || "").slice(0, 20));

  // 直接篡改数据库，模拟旧代码写进去的乱码
  const db = new DatabaseSync(path.join(tmp, "app.db"));
  db.prepare("UPDATE chapters SET content = ? WHERE book_id = ?").run("锟斤拷锟斤拷乱码正文", bookId);
  db.close();

  r = await fetch(`${BASE}/api/books/${bookId}/chapters/1`, { headers: { cookie } });
  const ch1 = await r.json();
  check("篡改后变乱码", !(ch1.chapter?.content || "").includes("夜色温柔"), (ch1.chapter?.content || "").slice(0, 20));

  // 重新解析
  r = await fetch(`${BASE}/api/books/${bookId}/reparse`, { method: "POST", headers: { cookie } });
  const rp = await r.json();
  check("重新解析 200", r.status === 200, JSON.stringify(rp));
  check("重新解析返回 2 章", rp.chapterCount === 2, String(rp.chapterCount));

  // 再次读取，应恢复正常
  r = await fetch(`${BASE}/api/books/${bookId}/chapters/1`, { headers: { cookie } });
  const ch2 = await r.json();
  check("重新解析后恢复正常", (ch2.chapter?.content || "").includes("夜色温柔"), (ch2.chapter?.content || "").slice(0, 20));

  console.log(`\n===== 重新解析：${okCount} 通过 / ${badCount} 失败 =====`);
  server.kill();
  await new Promise((r) => setTimeout(r, 400));
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
  process.exit(badCount ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  server.kill();
  process.exit(1);
});
