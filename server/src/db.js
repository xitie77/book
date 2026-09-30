import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { DB_PATH } from "./paths.js";

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS books (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT '',
    author      TEXT NOT NULL DEFAULT '',
    kind        TEXT NOT NULL DEFAULT 'txt',      -- txt | epub
    file_path   TEXT NOT NULL,
    cover_path  TEXT,
    char_count  INTEGER NOT NULL DEFAULT 0,
    hash        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_books_owner ON books(owner_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_books_owner_hash ON books(owner_id, hash);

  CREATE TABLE IF NOT EXISTS chapters (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id   INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    idx       INTEGER NOT NULL,                   -- 第几章（从 1 开始）
    title     TEXT NOT NULL DEFAULT '',
    content   TEXT NOT NULL,
    char_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id, idx);

  CREATE TABLE IF NOT EXISTS progress (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_idx INTEGER NOT NULL DEFAULT 1,
    scroll_pct  REAL NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (user_id, book_id)
  );

  CREATE TABLE IF NOT EXISTS bookmarks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_idx INTEGER NOT NULL DEFAULT 1,
    scroll_pct  REAL NOT NULL DEFAULT 0,
    note        TEXT NOT NULL DEFAULT '',
    snippet     TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_bookmarks ON bookmarks(user_id, book_id, chapter_idx);
`);

/* ---------- 密码：内置 scrypt，零原生依赖 ---------- */

export function hashPassword(plain) {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(String(plain), salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(plain, stored) {
  if (typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, expected] = parts;
  const derived = scryptSync(String(plain), salt, 64);
  const expectedBuf = Buffer.from(expected, "hex");
  if (expectedBuf.length !== derived.length) return false;
  return timingSafeEqual(derived, expectedBuf);
}

/* ---------- 首次启动：数据库为空时创建账号 ---------- */

function randomPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  const bytes = randomBytes(16);
  for (let i = 0; i < 16; i++) out += chars[bytes[i] % chars.length];
  return out;
}

const userCount = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
if (userCount === 0) {
  const username = process.env.ADMIN_USERNAME || "wbx";
  const provided = process.env.ADMIN_PASSWORD || "";
  const password = provided || randomPassword();
  const displayName = process.env.ADMIN_NAME || "书友";
  db.prepare(
    "INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?, ?, ?, 1)"
  ).run(username, displayName, hashPassword(password));
  console.log(`[init] 已创建账号：${username}`);
  if (!provided) {
    console.log(`[init] 随机密码：${password}`);
    console.log("[init] 请登录后在「设置 → 修改密码」里改成自己的密码");
  }
}

export default db;
