# 夜读 · 部署指南

目标环境：**法兰克福 ARM 服务器（Debian 13，Docker + Caddy 已装）**，域名 `book.xitie.xyz`。

> 全部命令都在**服务器上**执行。项目在本机 `D:\project\book`。

---

## 零、准备清单

| 项 | 检查命令 | 期望 |
|---|---|---|
| 架构 | `uname -m` | `aarch64`（ARM）或 `x86_64` |
| Docker | `docker version` | 可用 |
| Caddy | `caddy version` | 可用 |
| 磁盘 | `df -h /` | 至少留 2GB（书是纯文本，很小） |
| 域名 | 控制台 | `book.xitie.xyz` 的 **A 记录**指向服务器公网 IP（已确认指向 `92.5.117.171`） |

海外服务器**无需备案**；安全组/防火墙放行 **80 与 443**（Caddy 签发证书必须走 80）。

---

## 一、把项目传到服务器

任选一种：

**A. 用 Git（推荐）**

```bash
git clone <你的仓库地址> book && cd book
```

**B. 直接上传压缩包**

把本机 `D:\project\book` 打包上传，解压后进入目录（**不要**带 `node_modules`、`data`、`web/dist`，它们会重新生成）。

> 注意：`server/src/**` 里的中文源文件务必保持 UTF-8 编码（上传工具不要转 GBK）。

---

## 二、一键启动应用

> ⚠️ **先看端口**：这台机器上 `wk.xitie.xyz`（工作流）通常已占用宿主机 **8080**。
> 先确认一下：
>
> ```bash
> ss -tlnp | grep -E ':8080|:8081'
> ```
>
> · 8080 空着 → 用默认；· 8080 被占 → 本次用 **8081**（下面命令已按 8081 写）。

```bash
# 端口空闲时：
./deploy.sh

# 8080 已被工作流占用时（推荐）：
./deploy.sh --port 8081
```

脚本会：构建镜像 → 创建数据卷 → 启动容器 → 等待健康检查 → 打印地址。

首次构建约 **1~3 分钟**（下载 node 基础镜像 + npm 依赖）。

验证（端口按你选的替换）：

```bash
curl http://127.0.0.1:8081/api/health
# {"ok":true,"service":"book",...}
```

> ARM 机器无需特殊处理：基础镜像 `node:24-alpine` 自带 arm64，项目零原生依赖。

---

## 三、配置 Caddy 反代 + HTTPS

这台机器上已有 `wk.xitie.xyz` 等站点，**必须用「追加」而不是覆盖**（整份覆盖会把别的站点弄丢）。

**1. 先备份现有配置**

```bash
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date +%F)
```

**2. 把下面这一段追加到 `/etc/caddy/Caddyfile` 末尾**

（注意 `reverse_proxy` 的端口要和第二步一致：8080 或 8081）

```bash
sudo tee -a /etc/caddy/Caddyfile >/dev/null <<'EOF'

book.xitie.xyz {
	encode zstd gzip

	request_body {
		max_size 60MB
	}

	reverse_proxy 127.0.0.1:8081

	header {
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		-Server
	}
}
EOF
```

**3. 校验并生效**

```bash
sudo caddy validate --config /etc/caddy/Caddyfile   # 先校验，出错就别 reload
sudo systemctl reload caddy
```

打开 `https://book.xitie.xyz` —— 证书由 Caddy 自动申请，首次访问可能要几秒。

> 若想开启访问日志：先 `sudo mkdir -p /var/log/caddy && sudo chown caddy:caddy /var/log/caddy`，
> 再把上面 block 里加上 `log { output file /var/log/caddy/book-access.log }`。

**证书签发失败排查**：域名解析是否生效（`dig +short book.xitie.xyz`）、80/443 是否放行、80 是否被占用。

---

## 四、账号

首次启动（数据库为空）会用 `ADMIN_USERNAME`（默认 `wbx`）创建账号，密码取 `ADMIN_PASSWORD`：

- 你在 `.env` 里设了 `ADMIN_PASSWORD` → 用它；
- 没设 → 随机生成，打印在容器日志里：`docker logs book | grep 随机密码`。

登录后到「设置 → 修改密码」改掉。密码只存数据库（scrypt 哈希），仓库与镜像里无明文。

---

## 五、数据与备份

数据都在数据卷 `book-data`（容器内 `/app/server/data`）：

```
data/
├── app.db        # SQLite：账号、书籍元数据、章节、进度、书签
├── books/        # 原始 txt / epub 文件
└── covers/       # epub 封面
```

备份：

```bash
docker run --rm -v book-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/book-backup-$(date +%F).tar.gz -C /data .
```

恢复：

```bash
docker run --rm -v book-data:/data -v "$PWD:/backup" alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/<备份文件>.tar.gz -C /data'
docker restart book
```

---

## 六、环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `4000` | 容器内监听端口 |
| `MAX_UPLOAD_MB` | `50` | 单本文件上传上限（MB） |
| `ADMIN_USERNAME` | `wbx` | 仅数据库为空时创建 |
| `ADMIN_PASSWORD` | （无，随机） | 首次创建账号的密码；仅数据库为空时生效 |
| `DATA_DIR` | `server/data` | 数据目录（容器内已挂卷） |

修改：编辑 `docker-compose.yml` 的 `environment`，然后 `docker compose up -d`。

---

## 七、运维

```bash
./deploy.sh --logs     # 实时日志
./deploy.sh --restart  # 重启
./deploy.sh --down     # 停止（数据保留）
docker stats book      # 资源占用
```

用 compose 启动（等价于脚本）：

```bash
docker compose up -d --build
```

升级：

```bash
git pull
docker build -t book:latest .
docker compose up -d --force-recreate book   # 数据卷不变，数据保留
```

---

## 八、常见问题

**Q：上传后书架看不到？**
刷新页面；或 `docker logs book` 看是否有解析报错。txt 支持 UTF-8 / GBK / GB18030 / Big5 自动识别。

**Q：章节切分不对？**
本应用按「第X章/节/回」等标记切章；识别不到的会自动按约 6000 字分节。可在「目录」里核对。

**Q：打不开 / 502？**
`docker ps` 看容器是否在跑 → `curl http://127.0.0.1:8080/api/health` → `sudo journalctl -u caddy -n 50`。

**Q：删除书会删文件吗？**
会。删书时同时清理磁盘上的原文件与封面，不留孤儿文件。

**Q：想加人一起用？**
目前是单账号（`wbx`）。需要多用户可在「设置」扩展，或改 `ADMIN_USERNAME` 重建。
