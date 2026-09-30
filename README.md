# 夜读 🌙

一个自用的**番茄小说式**小说阅读器。上传 txt / epub → 进书架 → 点开即读。
暖纸阅读质感，手机端友好，支持深色模式。

## 功能

- **上传即解析**：`.txt`（自动识别 UTF-8 / GBK / GB18030 / Big5 编码）与 `.epub`（内置解析，无第三方依赖）
- **书架**：封面墙式书格，显示章节数、字数、读到第几章；支持拖动上传、重命名、删除
- **阅读器**：自动切分章节、目录跳转、上一章/下一章、键盘翻页、手机左右滑动翻页
- **阅读体验**：4 套配色（纸黄/牛皮/护眼绿/夜间）、字号与行距调节（本地记忆）
- **🎧 听书**：微软 Edge 神经语音，**14 种实测可用音色**（普通话 7 + 台湾 3 + 粤语 3 + 方言 2，如 晓晓/晓伊/云希/云扬/云健/晓北(东北)/晓妮(陕西)），支持**语速**与**音调**调节、自动连播下一段/下一章、锁屏媒体控制；合成结果自动缓存，重复收听秒开；进度独立记忆
- **进度记忆**：自动记录读到第几章第几屏、听到第几段，下次点开直接续读/续听
- **书签**：随手标记当前阅读位置
- **登录**：Cookie 会话，scrypt 密码哈希（无原生依赖）
- **手机适配**：安全区适配、可「添加到主屏幕」（PWA）

## 技术栈

- 后端：**Node 24 内置 `node:sqlite`（零原生依赖）** + Fastify 5 + `@fastify/multipart`
- 听书：Node 内置 `WebSocket` 直连微软 Edge 在线语音（`server/src/tts.js`），**无需额外依赖/密钥**
- 前端：React 19 + Vite 6 + 原生 CSS（无 UI 框架）
- 单容器单端口（容器内 4000），数据落 SQLite + 本地文件

## 本地运行

```bash
# 后端（首次会自动建库；密码见下方「账号」）
cd server && npm install && npm start          # http://localhost:4000

# 前端开发（热更新，已配好 /api 代理）
cd web && npm install && npm run dev           # http://localhost:5173

# 生产构建（后端直接托管前端产物）
cd web && npm run build
cd ../server && npm start                      # 访问 http://localhost:4000
```

## 测试

```bash
node tests/api-smoke.mjs      # 后端接口：登录/上传(GBK)/书架/阅读/进度/去重/删书清盘（23 项）
node tests/epub-test.mjs      # EPUB 解析：书名/作者/章节/封面（7 项）
cd web && npm run build && cd ..
node tests/integration.mjs    # 静态资源 + SPA 深链接 + 全链路（14 项）
node tests/tts-test.mjs       # 听书：音色列表/合成 MP3/缓存命中/换声变速（10 项，需外网）
node tests/ui-smoke.mjs       # 前端产物 + 听书接口 + 听书进度（17 项）
node tests/encoding-test.mjs  # 编码识别：UTF-8/BOM/UTF-16/GB18030/Big5 + 切章（7 项）
```

> 听书依赖微软在线语音服务，需服务器可访问 `speech.platform.bing.com`（国内多数服务器可直连）。

## 部署

见 [DEPLOY.md](./DEPLOY.md)。一句话：

```bash
./deploy.sh                                # 构建并启动，监听 127.0.0.1:8080
sudo cp Caddyfile /etc/caddy/Caddyfile     # 反向代理 book.xitie.xyz（HTTPS 自动签）
sudo systemctl reload caddy
```

## 目录结构

```
book/
├── server/                 # 后端
│   ├── src/
│   │   ├── index.js        # Fastify 入口（挂路由 + 托管前端）
│   │   ├── db.js           # node:sqlite 建表 / scrypt 密码 / 初始账号
│   │   ├── auth.js         # 会话与鉴权
│   │   ├── parser.js       # 编码识别 + 章节切分 + EPUB 解析 + 语音分段
│   │   ├── tts.js          # 听书：Edge 在线语音合成 + 磁盘缓存
│   │   ├── storage.js      # 删书清盘
│   │   └── routes/         # auth.js / books.js
│   └── package.json
├── web/                    # 前端（React + Vite）
│   └── src/{pages,components}/
├── tests/                  # 三个测试脚本
├── Dockerfile / docker-compose.yml / Caddyfile
└── deploy.sh / deploy.ps1 / DEPLOY.md
```

## 账号

首次启动（数据库为空）时用 `ADMIN_USERNAME`（默认 `wbx`）创建账号：

- 设了 `ADMIN_PASSWORD` → 用你设的密码；
- 没设 → 随机生成一个，**打印在启动日志里**（`[init] 随机密码：…`），登录后到「设置 → 修改密码」改掉。

密码只存在数据库（scrypt 哈希），仓库和镜像里都没有明文。
