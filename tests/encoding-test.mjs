/**
 * 编码识别回归测试：锁定「合法 UTF-8 必须优先于 GB18030」这一修复。
 * 背景：旧实现按「汉字多者胜」评分，GB18030 硬解 UTF-8 会产出大量伪汉字乱码，
 *       评分反而更高，导致 UTF-8 小说整本乱码、切章失效。
 * 用法：node tests/encoding-test.mjs
 */
import iconv from "iconv-lite";
import { decodeBuffer, splitChapters } from "../server/src/parser.js";

let pass = 0;
let fail = 0;
const check = (n, c, e = "") =>
  c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n + " " + e));

const CN = "第一回　授劍術處女下山　盜法書袁公歸洞\n夜色温柔，风也温柔。\n";

console.log("== 编码识别 ==");

// 1) UTF-8（无 BOM）必须原样解出
const u8 = Buffer.from(CN, "utf8");
const rU8 = decodeBuffer(u8);
check("UTF-8 原样解出", rU8 === CN, JSON.stringify(rU8.slice(0, 20)));

// 2) UTF-8 带 BOM
const rBom = decodeBuffer(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), u8]));
check("UTF-8 带 BOM", rBom === CN, JSON.stringify(rBom.slice(0, 20)));

// 3) UTF-16LE 带 BOM
const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(CN, "utf16le")]);
check("UTF-16LE 带 BOM", decodeBuffer(u16) === CN);

// 4) GBK / GB18030 简体
const gbkText = "第1章 入宗\n夜色温柔，风也温柔。";
const rGbk = decodeBuffer(iconv.encode(gbkText, "gb18030"));
check("GB18030 简体", rGbk === gbkText, JSON.stringify(rGbk.slice(0, 20)));

// 5) Big5 繁体
const b5Text = "第一回　授劍術處女下山\n夜色溫柔，風也溫柔。";
const rB5 = decodeBuffer(iconv.encode(b5Text, "big5"));
check("Big5 繁体", rB5 === b5Text, JSON.stringify(rB5.slice(0, 20)));

console.log("\n== 切章 ==");
const novel =
  "第一章 入宗\n" + "夜色温柔。".repeat(30) + "\n\n" +
  "第二章 结缘堂\n" + "灯火通明。".repeat(30) + "\n\n" +
  "第三章 凝丝\n" + "竹影摇动。".repeat(30) + "\n";
const ch = splitChapters(decodeBuffer(Buffer.from(novel, "utf8")));
check("UTF-8 正文切出 3 章", ch.length === 3, ch.length);
check("首章标题正确", ch[0]?.title === "第一章 入宗", JSON.stringify(ch[0]?.title));

console.log(`\n===== 编码：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
