import fs from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { db } from "../db.js";
import { requireAuth } from "../auth.js";
import { BOOKS_DIR, COVERS_DIR } from "../paths.js";
import { decodeBuffer, splitChapters, guessMeta, parseEpub, segmentText } from "../parser.js";
import { removeBookFiles, safeExt } from "../storage.js";
import { VOICES, synthesize } from "../tts.js";

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 50);

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** 取当前用户拥有的书，非本人返回 null */
function ownedBook(bookId, userId) {
  return db
    .prepare("SELECT * FROM books WHERE id = ? AND owner_id = ?")
    .get(Number(bookId), userId);
}

export default async function bookRoutes(app) {
  /* ---------- 书架列表 ---------- */
  app.get("/api/books", { preHandler: requireAuth }, async (request) => {
    const rows = db
      .prepare(
        `SELECT b.id, b.title, b.author, b.kind, b.char_count, b.cover_path IS NOT NULL AS has_cover,
                b.created_at, b.updated_at,
                (SELECT COUNT(*) FROM chapters c WHERE c.book_id = b.id) AS chapter_count,
                p.chapter_idx, p.scroll_pct, p.updated_at AS last_read_at
           FROM books b
           LEFT JOIN progress p ON p.book_id = b.id AND p.user_id = b.owner_id
          WHERE b.owner_id = ?
          ORDER BY COALESCE(p.updated_at, b.created_at) DESC`
      )
      .all(request.user.id);
    return {
      books: rows.map((r) => ({
        id: r.id,
        title: r.title,
        author: r.author,
        kind: r.kind,
        charCount: r.char_count,
        chapterCount: r.chapter_count,
        hasCover: !!r.has_cover,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        lastReadAt: r.last_read_at,
        reading: r.chapter_idx
          ? { chapterIdx: r.chapter_idx, scrollPct: r.scroll_pct }
          : null,
      })),
    };
  });

  /* ---------- 上传 txt / epub ---------- */
  app.post("/api/books", { preHandler: requireAuth }, async (request, reply) => {
    let part;
    try {
      part = await request.file({ limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 } });
    } catch {
      return reply.code(400).send({ error: "上传失败：文件过大或表单错误" });
    }
    if (!part) return reply.code(400).send({ error: "没有收到文件" });

    const ext = safeExt(part.filename);
    if (!["txt", "epub"].includes(ext)) {
      return reply.code(400).send({ error: "只支持 .txt 或 .epub 文件" });
    }

    const tmpPath = path.join(BOOKS_DIR, `tmp-${randomBytes(8).toString("hex")}.${ext}`);
    try {
      await pipeline(part.file, fs.createWriteStream(tmpPath));
    } catch {
      try { fs.unlinkSync(tmpPath); } catch {}
      return reply.code(413).send({ error: `文件超过 ${MAX_UPLOAD_MB}MB 上限` });
    }
    if (part.file.truncated) {
      try { fs.unlinkSync(tmpPath); } catch {}
      return reply.code(413).send({ error: `文件超过 ${MAX_UPLOAD_MB}MB 上限` });
    }

    const buf = fs.readFileSync(tmpPath);
    const hash = sha256(buf);

    const dup = db
      .prepare("SELECT id FROM books WHERE owner_id = ? AND hash = ?")
      .get(request.user.id, hash);
    if (dup) {
      try { fs.unlinkSync(tmpPath); } catch {}
      return reply.code(409).send({ error: "这本书已经在书架里了", bookId: dup.id });
    }

    let parsed;
    try {
      if (ext === "epub") {
        const e = parseEpub(buf);
        parsed = {
          title: e.title,
          author: e.author,
          chapters: e.chapters,
          cover: e.cover,
        };
      } else {
        const text = decodeBuffer(buf);
        const meta = guessMeta(text, part.filename);
        parsed = { title: meta.title, author: meta.author, chapters: splitChapters(text), cover: null };
      }
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch {}
      return reply.code(400).send({ error: "解析失败：" + (err?.message || "文件损坏") });
    }

    const finalName = `${hash.slice(0, 16)}.${ext}`;
    const finalPath = path.join(BOOKS_DIR, finalName);
    fs.renameSync(tmpPath, finalPath);

    let coverPath = null;
    if (parsed.cover) {
      const cname = `${hash.slice(0, 16)}.img`;
      coverPath = path.join(COVERS_DIR, cname);
      fs.writeFileSync(coverPath, parsed.cover);
    }

    const charCount = parsed.chapters.reduce((n, c) => n + c.content.length, 0);

    const insert = db.prepare(
      `INSERT INTO books (owner_id, title, author, kind, file_path, cover_path, char_count, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const info = insert.run(
      request.user.id,
      parsed.title || "未命名",
      parsed.author || "",
      ext,
      finalPath,
      coverPath,
      charCount,
      hash
    );
    const bookId = Number(info.lastInsertRowid);

    const chInsert = db.prepare(
      "INSERT INTO chapters (book_id, idx, title, content, char_count) VALUES (?, ?, ?, ?, ?)"
    );
    db.exec("BEGIN");
    try {
      parsed.chapters.forEach((c, i) => {
        chInsert.run(bookId, i + 1, c.title || `第 ${i + 1} 节`, c.content, c.content.length);
      });
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      removeBookFiles({ file_path: finalPath, cover_path: coverPath });
      db.prepare("DELETE FROM books WHERE id = ?").run(bookId);
      return reply.code(500).send({ error: "保存章节失败" });
    }

    return reply.code(201).send({
      book: {
        id: bookId,
        title: parsed.title || "未命名",
        author: parsed.author || "",
        kind: ext,
        chapterCount: parsed.chapters.length,
        charCount,
        hasCover: !!coverPath,
      },
    });
  });

  /* ---------- 书籍详情（含目录，不含正文） ---------- */
  app.get("/api/books/:id", { preHandler: requireAuth }, async (request, reply) => {
    const book = ownedBook(request.params.id, request.user.id);
    if (!book) return reply.code(404).send({ error: "书不存在" });
    const chapters = db
      .prepare("SELECT idx, title FROM chapters WHERE book_id = ? ORDER BY idx")
      .all(book.id);
    const prog = db
      .prepare(
        "SELECT chapter_idx, scroll_pct, tts_chapter, tts_seg FROM progress WHERE user_id = ? AND book_id = ?"
      )
      .get(request.user.id, book.id);
    return {
      book: {
        id: book.id,
        title: book.title,
        author: book.author,
        kind: book.kind,
        charCount: book.char_count,
        hasCover: !!book.cover_path,
        createdAt: book.created_at,
      },
      chapters,
      progress: prog ? { chapterIdx: prog.chapter_idx, scrollPct: prog.scroll_pct } : null,
      ttsProgress: prog ? { chapterIdx: prog.tts_chapter, segIdx: prog.tts_seg } : null,
    };
  });

  /* ---------- 单章正文（支持 ?dir=next / prev 便于连续翻页） ---------- */
  app.get("/api/books/:id/chapters/:idx", { preHandler: requireAuth }, async (request, reply) => {
    const book = ownedBook(request.params.id, request.user.id);
    if (!book) return reply.code(404).send({ error: "书不存在" });
    const idx = Math.max(1, Number(request.params.idx) || 1);
    const rows = db
      .prepare("SELECT idx, title, content FROM chapters WHERE book_id = ? ORDER BY idx")
      .all(book.id);
    const pos = rows.findIndex((r) => r.idx === idx);
    if (pos < 0) return reply.code(404).send({ error: "章节不存在" });
    const cur = rows[pos];
    return {
      chapter: { idx: cur.idx, title: cur.title, content: cur.content },
      segmentCount: segmentText(cur.content).length,
      prevIdx: pos > 0 ? rows[pos - 1].idx : null,
      nextIdx: pos < rows.length - 1 ? rows[pos + 1].idx : null,
      total: rows.length,
    };
  });

  /* ---------- 封面 ---------- */
  app.get("/api/books/:id/cover", { preHandler: requireAuth }, async (request, reply) => {
    const book = ownedBook(request.params.id, request.user.id);
    if (!book || !book.cover_path || !fs.existsSync(book.cover_path)) {
      return reply.code(404).send({ error: "没有封面" });
    }
    const ext = path.extname(book.cover_path).toLowerCase();
    const type = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : "image/jpeg";
    reply.header("Cache-Control", "private, max-age=86400");
    return reply.type(type).send(fs.createReadStream(book.cover_path));
  });

  /* ---------- 重命名 ---------- */
  app.patch("/api/books/:id", { preHandler: requireAuth }, async (request, reply) => {
    const book = ownedBook(request.params.id, request.user.id);
    if (!book) return reply.code(404).send({ error: "书不存在" });
    const { title, author } = request.body || {};
    db.prepare(
      "UPDATE books SET title = COALESCE(?, title), author = COALESCE(?, author), updated_at = datetime('now','localtime') WHERE id = ?"
    ).run(
      title != null ? String(title).trim().slice(0, 120) : null,
      author != null ? String(author).trim().slice(0, 60) : null,
      book.id
    );
    return { ok: true };
  });

  /* ---------- 删除（同时清磁盘） ---------- */
  app.delete("/api/books/:id", { preHandler: requireAuth }, async (request, reply) => {
    const book = ownedBook(request.params.id, request.user.id);
    if (!book) return reply.code(404).send({ error: "书不存在" });
    db.prepare("DELETE FROM books WHERE id = ?").run(book.id); // chapters/progress/bookmarks 级联
    removeBookFiles(book);
    return { ok: true };
  });

  /* ---------- 阅读进度 ---------- */
  app.put("/api/books/:id/progress", { preHandler: requireAuth }, async (request, reply) => {
    const book = ownedBook(request.params.id, request.user.id);
    if (!book) return reply.code(404).send({ error: "书不存在" });
    const chapterIdx = Math.max(1, Number(request.body?.chapterIdx) || 1);
    const scrollPct = Math.min(1, Math.max(0, Number(request.body?.scrollPct) || 0));
    db.prepare(
      `INSERT INTO progress (user_id, book_id, chapter_idx, scroll_pct, updated_at)
       VALUES (?, ?, ?, ?, datetime('now','localtime'))
       ON CONFLICT(user_id, book_id) DO UPDATE SET
         chapter_idx = excluded.chapter_idx,
         scroll_pct  = excluded.scroll_pct,
         updated_at  = excluded.updated_at`
    ).run(request.user.id, book.id, chapterIdx, scrollPct);
    return { ok: true };
  });

  /* ---------- 听书进度（只动 tts_* 字段） ---------- */
  app.put("/api/books/:id/tts-progress", { preHandler: requireAuth }, async (request, reply) => {
    const book = ownedBook(request.params.id, request.user.id);
    if (!book) return reply.code(404).send({ error: "书不存在" });
    const ttsChapter = Math.max(1, Number(request.body?.chapterIdx) || 1);
    const ttsSeg = Math.max(0, Number(request.body?.segIdx) || 0);
    db.prepare(
      `INSERT INTO progress (user_id, book_id, tts_chapter, tts_seg, tts_updated_at)
       VALUES (?, ?, ?, ?, datetime('now','localtime'))
       ON CONFLICT(user_id, book_id) DO UPDATE SET
         tts_chapter = excluded.tts_chapter,
         tts_seg     = excluded.tts_seg,
         tts_updated_at = excluded.tts_updated_at`
    ).run(request.user.id, book.id, ttsChapter, ttsSeg);
    return { ok: true };
  });

  /* ---------- 书签 ---------- */
  app.get("/api/books/:id/bookmarks", { preHandler: requireAuth }, async (request, reply) => {
    const book = ownedBook(request.params.id, request.user.id);
    if (!book) return reply.code(404).send({ error: "书不存在" });
    const rows = db
      .prepare(
        "SELECT id, chapter_idx, scroll_pct, note, snippet, created_at FROM bookmarks WHERE user_id = ? AND book_id = ? ORDER BY created_at DESC"
      )
      .all(request.user.id, book.id);
    return { bookmarks: rows };
  });

  app.post("/api/books/:id/bookmarks", { preHandler: requireAuth }, async (request, reply) => {
    const book = ownedBook(request.params.id, request.user.id);
    if (!book) return reply.code(404).send({ error: "书不存在" });
    const chapterIdx = Math.max(1, Number(request.body?.chapterIdx) || 1);
    const scrollPct = Math.min(1, Math.max(0, Number(request.body?.scrollPct) || 0));
    const note = String(request.body?.note || "").slice(0, 200);
    const snippet = String(request.body?.snippet || "").slice(0, 120);
    const info = db
      .prepare(
        "INSERT INTO bookmarks (user_id, book_id, chapter_idx, scroll_pct, note, snippet) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(request.user.id, book.id, chapterIdx, scrollPct, note, snippet);
    return reply.code(201).send({ id: Number(info.lastInsertRowid) });
  });

  app.delete("/api/books/:id/bookmarks/:bid", { preHandler: requireAuth }, async (request, reply) => {
    const book = ownedBook(request.params.id, request.user.id);
    if (!book) return reply.code(404).send({ error: "书不存在" });
    db.prepare("DELETE FROM bookmarks WHERE id = ? AND user_id = ? AND book_id = ?").run(
      Number(request.params.bid),
      request.user.id,
      book.id
    );
    return { ok: true };
  });

  /* ---------- 听书：音色列表 ---------- */
  app.get("/api/voices", { preHandler: requireAuth }, async () => ({ voices: VOICES }));

  /* ---------- 听书：合成一个语音片段 ---------- */
  app.get("/api/books/:id/tts", { preHandler: requireAuth }, async (request, reply) => {
    const book = ownedBook(request.params.id, request.user.id);
    if (!book) return reply.code(404).send({ error: "书不存在" });

    const chapterIdx = Math.max(1, Number(request.query.chapter) || 1);
    const segIdx = Math.max(0, Number(request.query.seg) || 0);
    const voice = String(request.query.voice || VOICES[0].id);
    const rate = Number(request.query.rate ?? 0);
    const pitch = Number(request.query.pitch ?? 0);

    const row = db
      .prepare("SELECT content FROM chapters WHERE book_id = ? AND idx = ?")
      .get(book.id, chapterIdx);
    if (!row) return reply.code(404).send({ error: "章节不存在" });

    const segments = segmentText(row.content);
    if (segIdx >= segments.length) return reply.code(404).send({ error: "片段不存在" });

    try {
      const { buffer, key } = await synthesize(segments[segIdx], { voice, rate, pitch });
      reply
        .header("Content-Type", "audio/mpeg")
        .header("Cache-Control", "private, max-age=604800")
        .header("X-Tts-Key", key);
      return reply.send(buffer);
    } catch (err) {
      request.log.error(err);
      return reply.code(502).send({ error: "语音合成失败：" + (err?.message || "未知错误") });
    }
  });
}
