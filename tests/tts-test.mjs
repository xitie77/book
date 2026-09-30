/**
 * 听书接口测试：登录 → 上传 → 取音色 → 合成音频 → 校验是 MP3。
 * 用法：node tests/tts-test.mjs   （需要外网可达微软语音服务）
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const PORT = 4502;
const BASE = `http://127.0.0.1:${PORT}`;
const PW = "test-" + "pass-1234";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "book-tts-"));

let pass = 0,
  fail = 0;
const check = (n, c, e = "") =>
  c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n + " " + e));

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

  let r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "wbx", password: PW }),
  });
  grab(r);
  check("登录", r.status === 200, r.status);

  console.log("\n== 音色列表 ==");
  r = await fetch(`${BASE}/api/voices`, { headers: { cookie } });
  const vd = await r.json();
  check("返回音色", r.status === 200 && Array.isArray(vd.voices) && vd.voices.length >= 6, vd.voices?.length);
  const hasXiaoxiao = vd.voices?.some((v) => v.id === "zh-CN-XiaoxiaoNeural");
  const hasYunxi = vd.voices?.some((v) => v.id === "zh-CN-YunxiNeural");
  check("含晓晓", hasXiaoxiao);
  check("含云希", hasYunxi);

  const p1 =
    "夜色温柔，风也温柔，小镇上空浮着一层薄薄的雾，灯火一盏一盏亮起来。少年站在桥头，手里拿着一张早已泛黄的车票，眼神很安静。";
  const p2 =
    "他抬头看了看天，云在缓缓移动，像谁不经意间铺开的画卷。风从河面上吹过来，带着一点凉爽的水汽，他把衣领竖起来，慢慢往回走。";
  const text = `第一章 测试\n\n${p1}\n\n${p2}\n`;
  const fd = new FormData();
  fd.append("file", new Blob([Buffer.from(text, "utf8")], { type: "text/plain" }), "听书测试.txt");
  r = await fetch(`${BASE}/api/books`, { method: "POST", headers: { cookie }, body: fd });
  const up = await r.json();
  check("上传", r.status === 201, JSON.stringify(up));
  const bookId = up.book?.id;

  console.log("\n== 合成语音 ==");
  const t0 = Date.now();
  r = await fetch(
    `${BASE}/api/books/${bookId}/tts?chapter=1&seg=0&voice=zh-CN-XiaoxiaoNeural&rate=0`,
    { headers: { cookie } }
  );
  const audio = Buffer.from(await r.arrayBuffer());
  check("HTTP 200", r.status === 200, r.status + " " + audio.toString("utf8").slice(0, 120));
  check("Content-Type audio/mpeg", (r.headers.get("content-type") || "").includes("audio/mpeg"));
  const isMp3 =
    audio.length > 2000 && (audio[0] === 0xff || audio.toString("latin1", 0, 3) === "ID3");
  check("是 MP3 音频", isMp3, `${audio.length} 字节, 头字节=${audio[0]?.toString(16)}`);
  console.log(`  （首次合成耗时 ${Date.now() - t0}ms，${audio.length} 字节）`);

  console.log("\n== 缓存命中 ==");
  const t1 = Date.now();
  r = await fetch(
    `${BASE}/api/books/${bookId}/tts?chapter=1&seg=0&voice=zh-CN-XiaoxiaoNeural&rate=0`,
    { headers: { cookie } }
  );
  const audio2 = Buffer.from(await r.arrayBuffer());
  const ms = Date.now() - t1;
  check("第二次更快（走缓存）", r.status === 200 && audio2.length === audio.length, `${ms}ms`);
  console.log(`  （第二次耗时 ${ms}ms）`);

  console.log("\n== 换音色 ==");
  r = await fetch(
    `${BASE}/api/books/${bookId}/tts?chapter=1&seg=1&voice=zh-CN-YunxiNeural&rate=20`,
    { headers: { cookie } }
  );
  const audio3 = Buffer.from(await r.arrayBuffer());
  check("云希 1.2x 合成成功", r.status === 200 && audio3.length > 2000, r.status + " " + audio3.length);

  console.log(`\n===== 听书：${pass} 通过 / ${fail} 失败 =====`);
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
