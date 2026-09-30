/**
 * EPUB 解析测试：构造最小 EPUB，验证 parseEpub。
 * 用法：node tests/epub-test.mjs
 */
import { parseEpub } from "../server/src/parser.js";
import { buildSampleEpub } from "./lib-epub.mjs";

let pass = 0,
  fail = 0;
const check = (n, c, e = "") =>
  c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n + " " + e));

const zip = buildSampleEpub();
const r = parseEpub(zip);

check("书名", r.title === "剑来", r.title);
check("作者", r.author === "烽火戏诸侯", r.author);
check("2 章", r.chapters.length === 2, r.chapters.length);
check("第 1 章标题", r.chapters[0].title.includes("惊蛰"), r.chapters[0].title);
check(
  "第 1 章正文",
  r.chapters[0].content.includes("小镇上空的云很厚"),
  r.chapters[0].content.slice(0, 20)
);
check("第 2 章正文", r.chapters[1].content.includes("泥瓶巷"), r.chapters[1].content.slice(0, 20));
check("有封面", r.cover && r.cover.toString() === "FAKEJPEGDATA");

console.log(`\n===== EPUB：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
