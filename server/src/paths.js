import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const SERVER_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** 数据目录：默认 server/data，可用 DATA_DIR 覆盖（容器里已挂卷） */
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(SERVER_ROOT, "data");

export const BOOKS_DIR = path.join(DATA_DIR, "books");   // 原始 txt / epub
export const COVERS_DIR = path.join(DATA_DIR, "covers"); // 封面
export const TTS_DIR = path.join(DATA_DIR, "tts");       // 听书合成缓存

export const DB_PATH = path.join(DATA_DIR, "app.db");

for (const dir of [DATA_DIR, BOOKS_DIR, COVERS_DIR, TTS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}
