/**
 * 端到端冒烟测试：登录 → 上传(GBK txt) → 书架 → 阅读 → 进度 → 去重 → 退出
 * 用法：node tests/api-smoke.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(HERE, "..", "server");

const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;
const USERNAME = "wbx";
const PASSWORD = "test-" + "pass-1234";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "book-test-"));
let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} ${extra}`);
  }
}

const server = spawn(process.execPath, ["src/index.js"], {
  cwd: SERVER_DIR,
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR: tmp,
    ADMIN_USERNAME: USERNAME,
    ADMIN_PASSWORD: PASSWORD,
    LOG_LEVEL: "warn",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function makeTxt() {
  const lines = [];
  lines.push("《测试小说》");
  lines.push("作者：夕颜");
  lines.push("");
  const chapters = [
    ["第一章 起点", "这是一段中文正文，用来验证 GBK 解码是否正确。山川异域，风月同天。"],
    ["第二章 风起", "第二章的中文内容。落霞与孤鹜齐飞，秋水共长天一色。"],
    ["第三章 归途", "第三章内容，测试章节切分是否正常工作。海内存知己，天涯若比邻。"],
  ];
  for (const [t, c] of chapters) {
    lines.push(t);
    lines.push("");
    lines.push(c);
    lines.push("");
  }
  return iconv.encode(lines.join("\n"), "gb18030");
}

let cookie = "";
function getSetCookie(res) {
  const raw = res.headers.getSetCookie?.() || [];
  for (const c of raw) {
    const m = c.match(/book_sid=([^;]+)/);
    if (m) cookie = `book_sid=${m[1]}`;
  }
}

async function main() {
  if (!(await waitHealth())) {
    console.error("服务器未能启动");
    process.exit(1);
  }
  console.log("\n== 登录 ==");
  let r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  check("正确账号密码登录 200", r.status === 200, `got ${r.status}`);
  getSetCookie(r);
  const me = await (await fetch(`${BASE}/api/auth/me`, { headers: { cookie } })).json();
  check("me 返回用户", me.user?.username === USERNAME, JSON.stringify(me));

  console.log("\n== 未授权保护 ==");
  r = await fetch(`${BASE}/api/books`);
  check("未登录访问书架 401", r.status === 401, `got ${r.status}`);
  r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: "wrong" }),
  });
  check("错误密码 401", r.status === 401, `got ${r.status}`);

  console.log("\n== 上传 GBK txt ==");
  const buf = makeTxt();
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: "text/plain" }), "测试小说.txt");
  r = await fetch(`${BASE}/api/books`, { method: "POST", headers: { cookie }, body: fd });
  const up = await r.json();
  check("上传返回 201", r.status === 201, JSON.stringify(up));
  check("识别到 3 章", up.book?.chapterCount === 3, `got ${up.book?.chapterCount}`);
  check("书名正确", up.book?.title === "测试小说", `got ${up.book?.title}`);
  const bookId = up.book?.id;

  console.log("\n== 书架 ==");
  const list = await (await fetch(`${BASE}/api/books`, { headers: { cookie } })).json();
  check("书架有 1 本", list.books?.length === 1, `got ${list.books?.length}`);
  check("章节数一致", list.books?.[0]?.chapterCount === 3);

  console.log("\n== 目录与正文 ==");
  const detail = await (await fetch(`${BASE}/api/books/${bookId}`, { headers: { cookie } })).json();
  check("目录 3 条", detail.chapters?.length === 3);
  check("目录首章标题", detail.chapters?.[0]?.title?.includes("第一章"), detail.chapters?.[0]?.title);
  const ch = await (
    await fetch(`${BASE}/api/books/${bookId}/chapters/1`, { headers: { cookie } })
  ).json();
  check("正文解码正确", ch.chapter?.content?.includes("山川异域"), ch.chapter?.content?.slice(0, 30));
  check("nextIdx = 2", ch.nextIdx === 2, `got ${ch.nextIdx}`);
  const ch3 = await (
    await fetch(`${BASE}/api/books/${bookId}/chapters/3`, { headers: { cookie } })
  ).json();
  check("末章 nextIdx = null", ch3.nextIdx === null, `got ${ch3.nextIdx}`);

  console.log("\n== 阅读进度 ==");
  r = await fetch(`${BASE}/api/books/${bookId}/progress`, {
    method: "PUT",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ chapterIdx: 2, scrollPct: 0.42 }),
  });
  check("保存进度 200", r.status === 200);
  const list2 = await (await fetch(`${BASE}/api/books`, { headers: { cookie } })).json();
  check("书架回显进度", list2.books?.[0]?.reading?.chapterIdx === 2, JSON.stringify(list2.books?.[0]?.reading));

  console.log("\n== 去重 ==");
  const fd2 = new FormData();
  fd2.append("file", new Blob([buf], { type: "text/plain" }), "dup.txt");
  r = await fetch(`${BASE}/api/books`, { method: "POST", headers: { cookie }, body: fd2 });
  check("重复上传 409", r.status === 409, `got ${r.status}`);

  console.log("\n== 书签 ==");
  r = await fetch(`${BASE}/api/books/${bookId}/bookmarks`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ chapterIdx: 1, scrollPct: 0.1, note: "标记", snippet: "山川异域" }),
  });
  check("新增书签 201", r.status === 201, `got ${r.status}`);
  const bms = await (
    await fetch(`${BASE}/api/books/${bookId}/bookmarks`, { headers: { cookie } })
  ).json();
  check("书签列表 1 条", bms.bookmarks?.length === 1);

  console.log("\n== 删除后清磁盘 ==");
  const fileBefore = fs.readdirSync(path.join(tmp, "books")).filter((f) => !f.startsWith("tmp-")).length;
  r = await fetch(`${BASE}/api/books/${bookId}`, { method: "DELETE", headers: { cookie } });
  check("删除 200", r.status === 200);
  const fileAfter = fs.readdirSync(path.join(tmp, "books")).filter((f) => !f.startsWith("tmp-")).length;
  check("磁盘文件已清理", fileAfter === fileBefore - 1, `before=${fileBefore} after=${fileAfter}`);

  console.log("\n== 退出 ==");
  r = await fetch(`${BASE}/api/auth/logout`, { method: "POST", headers: { cookie } });
  check("退出 200", r.status === 200);
  r = await fetch(`${BASE}/api/auth/me`, { headers: { cookie } });
  check("退出后 me 401", r.status === 401, `got ${r.status}`);

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
  server.kill();
  await new Promise((r) => setTimeout(r, 500));
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    /* Windows 下句柄释放稍慢，忽略 */
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  server.kill();
  process.exit(1);
});
