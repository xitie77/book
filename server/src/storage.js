import fs from "node:fs";
import { db } from "./db.js";

/** 删除一本书对应的磁盘文件（原文件 + 封面）。数据库级联不会清磁盘。 */
export function removeBookFiles(row) {
  for (const p of [row?.file_path, row?.cover_path]) {
    if (!p) continue;
    try {
      fs.unlinkSync(p);
    } catch {
      /* 文件可能已不存在 */
    }
  }
}

/** 删除某用户全部书籍文件（删账号时用） */
export function removeAllUserBookFiles(userId) {
  const rows = db
    .prepare("SELECT file_path, cover_path FROM books WHERE owner_id = ?")
    .all(userId);
  for (const row of rows) removeBookFiles(row);
}

export function safeExt(name) {
  const m = String(name || "").toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return m ? m[1] : "";
}
