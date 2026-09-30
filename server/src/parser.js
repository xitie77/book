import fs from "node:fs";
import zlib from "node:zlib";
import iconv from "iconv-lite";

/* ============================================================
 * 1. 文本编码识别（国内 txt 大量是 GBK/GB18030）
 * ============================================================ */

/** 统计 CJK 字符与替换符，用于给解码结果打分 */
function scoreText(text) {
  let cjk = 0;
  let bad = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c === 0xfffd) bad++;
    else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x303f)) cjk++;
  }
  return cjk - bad * 8;
}

/** 把原始 Buffer 解码成文本（自动识别 UTF-8 / UTF-16 / GB18030 / Big5） */
export function decodeBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString("utf8");
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return iconv.decode(buf.subarray(2), "utf16le");
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return iconv.decode(swapped, "utf16le");
  }

  // 合法 UTF-8 直接采用：UTF-8 是自校验编码，通过严格校验即确信。
  // （不能用「汉字多者胜」来比：GB18030 是双字节密集编码，拿它硬解 UTF-8 会产生大量
  //   “看着像汉字”的乱码，评分反而高于正确的 UTF-8，会把整本中文解成乱码。）
  const strict = new TextDecoder("utf-8", { fatal: true });
  try {
    return strict.decode(buf);
  } catch {
    /* 非 UTF-8，再试简体 / 繁体 */
  }

  // 非 UTF-8：在 GB18030 与 Big5 之间取更干净的一个（评分平手时优先 GB18030）
  const candidates = [];
  for (const enc of ["gb18030", "big5"]) {
    try {
      candidates.push(iconv.decode(buf, enc));
    } catch {
      /* ignore */
    }
  }
  if (!candidates.length) return buf.toString("utf8");

  let best = candidates[0];
  let bestScore = scoreText(best);
  for (const c of candidates.slice(1)) {
    const s = scoreText(c);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return best;
}

/* ============================================================
 * 2. 章节切分
 * ============================================================ */

const CN_NUM = "0-9零一二三四五六七八九十百千万两〇○";
const CHAPTER_RE = new RegExp(
  `^\\s*(?:` +
    `第\\s*[${CN_NUM}]{1,10}\\s*[章节回卷篇部集话]` +
    `|Chapter\\s+\\d{1,4}` +
    `|Chapter\\s+[IVXLCDM]{1,8}` +
    `|楔\\s*子|序\\s*章|序\\s*言|前\\s*言|引\\s*子|后\\s*记|尾\\s*声|终\\s*章` +
    `|番\\s*外[\\s\\S]{0,20}` +
    `)\\s*[^\\n]{0,40}$`
);

/** 是否像章节标题（限制长度且不含句子标点，避免把正文误判成标题） */
function isChapterTitle(line) {
  let t = line.replace(/^\uFEFF/, "").trim();
  if (!t || t.length > 50) return false;
  if (/[。！？；，、：…]/.test(t)) return false;
  // 全角数字转半角后匹配
  t = t.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  return CHAPTER_RE.test(t);
}

/**
 * 把整本书文本切成章节数组。
 * 找不到章节标记时，按约 6000 字自动分节。
 */
export function splitChapters(text) {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n");
  const lines = normalized.split("\n");

  // 书名/前言前的碎内容先收着
  const chapters = [];
  let current = { title: "", lines: [] };

  const push = () => {
    const content = current.lines.join("\n").trim();
    if (content || current.title) {
      chapters.push({ title: current.title.trim(), content });
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/[\u3000\t]+$/g, "");
    if (isChapterTitle(line)) {
      push();
      current = { title: line.trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  push();

  // 未识别出章节：按块切
  if (chapters.length <= 1) {
    const body = normalized.trim();
    if (!body) return [{ title: "正文", content: "" }];
    const CHUNK = 6000;
    const out = [];
    const paras = body.split("\n\n");
    let buf = "";
    let n = 1;
    const flush = () => {
      if (buf.trim()) out.push({ title: `第 ${n} 节`, content: buf.trim() });
      n++;
      buf = "";
    };
    for (const p of paras) {
      if ((buf + "\n\n" + p).length > CHUNK && buf) flush();
      buf = buf ? buf + "\n\n" + p : p;
    }
    flush();
    return out.length ? out : [{ title: "正文", content: body }];
  }

  // 丢掉完全空白的块，以及「书名/作者」这类很短的无标题前言
  const cleaned = chapters.filter((c) => c.content || c.title);
  if (cleaned.length > 1 && !cleaned[0].title && cleaned[0].content.length < 100) {
    cleaned.shift();
  }
  return cleaned;
}

/* ============================================================
 * 3. 语音片段切分（听书用）
 * ============================================================ */

/**
 * 把章节正文切成适合语音合成的片段（每段约 40~220 字）。
 * 优先在句末标点处断开；单句过长时硬切。返回 string[]。
 */
export function segmentText(content) {
  const normalized = String(content || "").replace(/\r\n?/g, "\n");
  const paras = normalized
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const MAX = 220;
  const MIN = 40;
  const segments = [];
  let buf = "";
  const flush = () => {
    const t = buf.trim();
    if (t) segments.push(t);
    buf = "";
  };

  for (const para of paras) {
    const sentences = para.match(/[^。！？!?；;…]+[。！？!?；;…]*/g) || [para];
    for (let s of sentences) {
      s = s.trim();
      if (!s) continue;
      while (s.length > MAX) {
        if (buf) flush();
        segments.push(s.slice(0, MAX));
        s = s.slice(MAX);
      }
      if (buf && (buf + s).length > MAX) flush();
      buf += s;
      if (buf.length >= MAX) flush();
    }
    if (buf.length >= MIN) flush();
  }
  flush();

  if (!segments.length) {
    const t = normalized.trim();
    return t ? [t.slice(0, MAX)] : [];
  }
  return segments;
}

/* ============================================================
 * 4. 从文本里猜书名 / 作者
 * ============================================================ */

export function guessMeta(text, fallbackName) {
  const head = text.slice(0, 2000);
  let title = "";
  let author = "";

  const tMatch = head.match(/(?:书名|标题|名称)[:：]\s*(.+)/);
  if (tMatch) title = tMatch[1].trim().slice(0, 80);
  const aMatch = head.match(/(?:作者|著者|著)[:：]?\s*(.+)/);
  if (aMatch) author = aMatch[1].replace(/[（(].*?[)）]/g, "").trim().slice(0, 40);

  if (!title) {
    const m = head.match(/《([^》]{1,40})》/);
    if (m) title = m[1].trim();
  }
  if (!title) {
    title = String(fallbackName || "").replace(/\.(txt|epub)$/i, "").trim() || "未命名";
  }
  return { title, author };
}

/* ============================================================
 * 5. EPUB 解析（内置极简 ZIP 读取，零依赖）
 * ============================================================ */

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

/** 读取 ZIP 中央目录，返回 { 文件名 -> {method, compSize, size, offset} } */
function readZipEntries(buf) {
  let eocd = -1;
  const start = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是合法的 EPUB/ZIP 文件");

  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(ptr) !== CEN_SIG) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const size = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);
    entries[name] = { method, compSize, size, offset: localOff };
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipFile(buf, entry) {
  const off = entry.offset;
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error("不支持的压缩方式：" + entry.method);
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function htmlToText(html) {
  let s = html
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "");
  s = s.replace(/<(h[1-6])[^>]*>/gi, "\n");
  s = s.replace(/<\/(h[1-6])>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|li|tr|section)>/gi, "\n\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  return s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 解析 EPUB，返回 { title, author, chapters:[{title,content}], cover: Buffer|null } */
export function parseEpub(buf) {
  const entries = readZipEntries(buf);
  const readText = (name) => decodeBuffer(readZipFile(buf, entries[name]));

  const containerName = "META-INF/container.xml";
  if (!entries[containerName]) throw new Error("EPUB 缺少 container.xml");
  const container = readText(containerName);
  const opfPath = (container.match(/full-path="([^"]+)"/) || [])[1];
  if (!opfPath || !entries[opfPath]) throw new Error("EPUB 找不到 OPF 清单");
  const opf = readText(opfPath);
  const baseDir = opfPath.includes("/") ? opfPath.replace(/\/[^/]*$/, "/") : "";

  const metaTitle = (opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i) || [])[1];
  const metaAuthor = (opf.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i) || [])[1];

  // manifest: id -> href
  const manifest = {};
  const itemRe = /<item\b[^>]*\/?>/gi;
  let m;
  while ((m = itemRe.exec(opf))) {
    const tag = m[0];
    const id = (tag.match(/id="([^"]+)"/) || [])[1];
    const href = (tag.match(/href="([^"]+)"/) || [])[1];
    const props = (tag.match(/properties="([^"]+)"/) || [])[1] || "";
    const mt = (tag.match(/media-type="([^"]+)"/) || [])[1] || "";
    if (id && href) manifest[id] = { href, props, mediaType: mt };
  }

  // spine 顺序
  const spine = [];
  const spineRe = /<itemref\b[^>]*\/?>/gi;
  while ((m = spineRe.exec(opf))) {
    const idref = (m[0].match(/idref="([^"]+)"/) || [])[1];
    if (idref && manifest[idref]) spine.push(manifest[idref]);
  }

  const chapters = [];
  for (const item of spine) {
    const name = baseDir + decodeURIComponent(item.href);
    if (!entries[name]) continue;
    const html = readText(name);
    const text = htmlToText(html);
    if (!text) continue;
    let title = (html.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i) || [])[1];
    title = title ? htmlToText(title).slice(0, 60) : "";
    chapters.push({ title: title || `第 ${chapters.length + 1} 节`, content: text });
  }
  if (!chapters.length) throw new Error("EPUB 没有可读的正文");

  // 封面
  let cover = null;
  const coverItem =
    Object.values(manifest).find((it) => /cover-image/.test(it.props)) ||
    (() => {
      const metaName = (opf.match(/<meta[^>]*name="cover"[^>]*content="([^"]+)"/i) || [])[1];
      return metaName ? manifest[metaName] : null;
    })();
  if (coverItem) {
    const name = baseDir + decodeURIComponent(coverItem.href);
    if (entries[name]) {
      try {
        cover = readZipFile(buf, entries[name]);
      } catch {
        cover = null;
      }
    }
  }

  return {
    title: metaTitle ? decodeEntities(metaTitle).trim() : "",
    author: metaAuthor ? decodeEntities(metaAuthor).trim() : "",
    chapters,
    cover,
  };
}

/** 读本地 txt 文件 → { text } */
export function readTxtFile(filePath) {
  return decodeBuffer(fs.readFileSync(filePath));
}
