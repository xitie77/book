/**
 * 听书：调用微软 Edge 在线神经语音（Read Aloud），返回 MP3。
 * 零第三方依赖——只用 Node 内置 WebSocket。
 *
 * 说明：
 *  · 鉴权靠 TrustedClientToken + Sec-MS-GEC 令牌；令牌算法 = SHA256(5 分钟取整的 Windows tick + token)。
 *  · 必须伪装成较新的 Edge（Chromium 版本号），旧版本号会被 403 拒绝。
 *  · 合成结果按 (音色,语速,音调,文本) 缓存到磁盘，同一段只合成一次。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { TTS_DIR } from "./paths.js";

const TRUSTED = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const CHROMIUM_MAJOR = CHROMIUM_FULL_VERSION.split(".")[0];
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const WSS_BASE = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const WIN_EPOCH = 11644473600;

const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`;

/** 精选音色（默认可选这些；其余 zh-CN 音色也可用 voice 参数直传） */
export const VOICES = [
  { id: "zh-CN-XiaoxiaoNeural", name: "晓晓", gender: "女", style: "温柔亲和", tag: "推荐" },
  { id: "zh-CN-XiaoyiNeural", name: "晓伊", gender: "女", style: "甜美俏皮", tag: "" },
  { id: "zh-CN-XiaochenNeural", name: "晓辰", gender: "女", style: "沉稳叙述", tag: "听书" },
  { id: "zh-CN-XiaohanNeural", name: "晓涵", gender: "女", style: "知性优雅", tag: "" },
  { id: "zh-CN-XiaomengNeural", name: "晓梦", gender: "女", style: "慵懒柔和", tag: "" },
  { id: "zh-CN-XiaoxuanNeural", name: "晓萱", gender: "女", style: "清亮活泼", tag: "" },
  { id: "zh-CN-YunxiNeural", name: "云希", gender: "男", style: "阳光少年", tag: "推荐" },
  { id: "zh-CN-YunyangNeural", name: "云扬", gender: "男", style: "专业播报", tag: "听书" },
  { id: "zh-CN-YunjianNeural", name: "云健", gender: "男", style: "磁性有力", tag: "" },
  { id: "zh-CN-YunfengNeural", name: "云枫", gender: "男", style: "低沉浑厚", tag: "" },
  { id: "zh-CN-YunhaoNeural", name: "云皓", gender: "男", style: "清晰稳重", tag: "" },
  { id: "zh-CN-YunzeNeural", name: "云泽", gender: "男", style: "醇厚叙事", tag: "" },
  { id: "zh-CN-liaoning-XiaobeiNeural", name: "晓北", gender: "女", style: "东北口音", tag: "" },
  { id: "zh-CN-shaanxi-XiaoniNeural", name: "晓妮", gender: "女", style: "陕西口音", tag: "" },
];

const VOICE_IDS = new Set(VOICES.map((v) => v.id));

/* ---------- Sec-MS-GEC 令牌 ---------- */
function secMsGec() {
  let ticks = Math.floor(Date.now() / 1000) + WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= 1e7; // Windows tick = 100ns
  return createHash("sha256").update(`${ticks}${TRUSTED}`, "utf8").digest("hex").toUpperCase();
}

function escapeXml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 去掉语音服务不支持的控制字符 */
function cleanText(s) {
  let out = "";
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if ((c >= 0 && c <= 8) || (c >= 11 && c <= 12) || (c >= 14 && c <= 31)) out += " ";
    else out += ch;
  }
  return out;
}

function clampRate(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-50, Math.min(100, Math.round(n)));
}
function clampPitch(pitch) {
  const n = Number(pitch);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-50, Math.min(50, Math.round(n)));
}

/* ---------- 单次合成 ---------- */
function synthOnce(text, voice, rate, pitch) {
  return new Promise((resolve, reject) => {
    const connId = randomUUID().replace(/-/g, "");
    const url =
      `${WSS_BASE}?TrustedClientToken=${TRUSTED}` +
      `&Sec-MS-GEC=${secMsGec()}` +
      `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}` +
      `&ConnectionId=${connId}`;

    const ws = new WebSocket(url, {
      headers: {
        Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "User-Agent": UA,
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "en-US,en;q=0.9",
        Pragma: "no-cache",
        "Cache-Control": "no-cache",
      },
    });
    ws.binaryType = "arraybuffer";

    const chunks = [];
    let settled = false;
    const finish = (err, buf) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      err ? reject(err) : resolve(buf);
    };
    const timer = setTimeout(() => finish(new Error("合成超时")), 30000);

    ws.onopen = () => {
      const stamp = () => {
        const d = new Date();
        const p = (n) => String(n).padStart(2, "0");
        const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ${p(
          d.getUTCHours()
        )}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
      };
      ws.send(
        `X-Timestamp:${stamp()}\r\n` +
          "Content-Type:application/json; charset=utf-8\r\n" +
          "Path:speech.config\r\n\r\n" +
          JSON.stringify({
            context: {
              synthesis: {
                audio: {
                  metadataoptions: { sentenceBoundaryEnabled: true, wordBoundaryEnabled: false },
                  outputFormat: OUTPUT_FORMAT,
                },
              },
            },
          })
      );

      const reqId = randomUUID().replace(/-/g, "");
      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>` +
        `<voice name='${voice}'>` +
        `<prosody pitch='${pitch >= 0 ? "+" : ""}${pitch}Hz' rate='${rate >= 0 ? "+" : ""}${rate}%' volume='+0%'>` +
        `${escapeXml(text)}</prosody></voice></speak>`;
      ws.send(
        `X-RequestId:${reqId}\r\n` +
          "Content-Type:application/ssml+xml\r\n" +
          `X-Timestamp:${stamp()}Z\r\n` +
          "Path:ssml\r\n\r\n" +
          ssml
      );
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        if (ev.data.includes("Path:turn.end")) {
          const audio = Buffer.concat(chunks);
          if (audio.length === 0) return finish(new Error("未收到音频数据"));
          finish(null, audio);
        }
        return;
      }
      const buf = Buffer.from(ev.data);
      if (buf.length < 2) return;
      const headerLen = buf.readUInt16BE(0);
      const header = buf.subarray(2, 2 + headerLen).toString("utf8");
      if (header.includes("Path:audio")) chunks.push(buf.subarray(2 + headerLen));
    };

    ws.onerror = () => finish(new Error("语音服务连接失败（网络或鉴权）"));
    ws.onclose = (e) => {
      if (!settled) finish(new Error(`语音服务提前关闭（code=${e?.code ?? "-"}）`));
    };
  });
}

/* ---------- 带缓存的合成 ---------- */
export async function synthesize(text, { voice, rate, pitch } = {}) {
  const clean = cleanText(text).trim();
  if (!clean) throw new Error("文本为空");
  if (clean.length > 4000) throw new Error("单段文本过长（上限 4000 字）");

  const v = VOICE_IDS.has(voice) || /^zh-CN-[A-Za-z]+Neural$/.test(voice) ? voice : VOICES[0].id;
  const r = clampRate(rate);
  const p = clampPitch(pitch);

  const key = createHash("sha256").update(`${v}|${r}|${p}|${clean}`, "utf8").digest("hex");
  const file = path.join(TTS_DIR, `${key}.mp3`);
  if (fs.existsSync(file)) return { buffer: fs.readFileSync(file), cached: true, key };

  const buffer = await synthOnce(clean, v, r, p);
  try {
    fs.writeFileSync(file, buffer);
  } catch {}
  return { buffer, cached: false, key };
}

export const voiceId = (id) => VOICES.find((v) => v.id === id);
