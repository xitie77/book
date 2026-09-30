/**
 * 听书 + 前端产物 冒烟测试：启动服务 → 校验接口与页面 → 退出（不留后台进程）。
 * 用法：node tests/ui-smoke.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const PORT = 4503;
const BASE = `http://127.0.0.1:${PORT}`;
const PW = "test-" + "pass-1234";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "book-ui-"));

let pass = 0;
let fail = 0;
const check = (n, c, e = "") =>
  c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n + " " + e));

const dist = path.join(ROOT, "web", "dist");
if (!fs.existsSync(path.join(dist, "index.html"))) {
  console.error("先构建前端：cd web && npm run build");
  process.exit(2);
}

const server = spawn(process.execPath, ["src/index.js"], {
  cwd: path.join(ROOT, "server"),
  env: { ...process.env, PORT: String(PORT), DATA_DIR: tmp, ADMIN_PASSWORD: PW, LOG_LEVEL: "warn" },
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
const grab = (res) => {
  const m = (res.headers.getSetCookie?.() || []).join(";").match(/book_sid=([^;]+)/);
  if (m) cookie = `book_sid=${m[1]}`;
};

async function main() {
  if (!(await wait())) throw new Error("服务未启动");

  console.log("== 页面产物 ==");
  let r = await fetch(`${BASE}/`);
  let html = await r.text();
  check("首页 200", r.status === 200, r.status);
  check("引用打包资源", /\/assets\/index-.+\.js/.test(html));

  const jsPath = (html.match(/\/assets\/(index-[^"]+\.js)/) || [])[1];
  const cssPath = (html.match(/\/assets\/(index-[^"]+\.css)/) || [])[1];
  check("找到 JS 资源名", !!jsPath, jsPath);
  check("找到 CSS 资源名", !!cssPath, cssPath);

  const js = jsPath ? await (await fetch(`${BASE}/assets/${jsPath}`)).text() : "";
  const css = cssPath ? await (await fetch(`${BASE}/assets/${cssPath}`)).text() : "";
  check("JS 含听书逻辑（api/voices）", js.includes("/api/voices"));
  check("JS 含听书入口文案", js.includes("听这本书") || js.includes("🎧"));
  check("JS 含播放器组件", js.includes("player-controls"));
  check("CSS 含播放器样式", css.includes(".player") && css.includes(".voice-chip"));

  r = await fetch(`${BASE}/book/1`);
  check("SPA 深链接 /book/1 回退到 index", r.status === 200 && (await r.text()).includes("<div id=\"root\">"));

  console.log("\n== 接口 ==");
  r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "wbx", password: PW }),
  });
  grab(r);
  check("登录", r.status === 200, r.status);

  r = await fetch(`${BASE}/api/voices`, { headers: { cookie } });
  const vd = await r.json();
  check("音色 ≥ 8 个", vd.voices?.length >= 8, vd.voices?.length);
  const female = vd.voices?.filter((v) => v.gender === "女").length || 0;
  const male = vd.voices?.filter((v) => v.gender === "男").length || 0;
  check("有女声也有男声", female > 0 && male > 0, `女${female}/男${male}`);

  const text = `第一章 起\n\n${"夜色温柔，风也温柔，小镇上浮着一层薄薄的雾。".repeat(3)}\n\n${"少年抬头看天，云在缓缓移动。".repeat(3)}\n`;
  const fd = new FormData();
  fd.append("file", new Blob([Buffer.from(text, "utf8")], { type: "text/plain" }), "冒烟.txt");
  r = await fetch(`${BASE}/api/books`, { method: "POST", headers: { cookie }, body: fd });
  const bookId = (await r.json()).book?.id;
  check("上传", r.status === 201 && !!bookId, r.status);

  r = await fetch(`${BASE}/api/books/${bookId}/chapters/1`, { headers: { cookie } });
  const ch = await r.json();
  check("章节返回 segmentCount", ch.segmentCount >= 1, ch.segmentCount);

  r = await fetch(`${BASE}/api/books/${bookId}/tts?chapter=1&seg=0&voice=zh-CN-XiaoxiaoNeural`, {
    headers: { cookie },
  });
  const audio = Buffer.from(await r.arrayBuffer());
  check("合成音频", r.status === 200 && audio.length > 2000 && (audio[0] === 0xff || audio.toString("latin1", 0, 3) === "ID3"), r.status + " " + audio.length);

  r = await fetch(`${BASE}/api/books/${bookId}/tts-progress`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ chapterIdx: 1, segIdx: 2 }),
  });
  check("写听书进度", r.status === 200, r.status);

  r = await fetch(`${BASE}/api/books/${bookId}`, { headers: { cookie } });
  const info = await r.json();
  check("读回听书进度", info.ttsProgress?.chapterIdx === 1 && info.ttsProgress?.segIdx === 2, JSON.stringify(info.ttsProgress));

  console.log(`\n===== UI/听书冒烟：${pass} 通过 / ${fail} 失败 =====`);
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
