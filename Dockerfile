# 夜读镜像：构建前端 + 运行后端（后端直接托管前端产物，零原生依赖）
FROM node:24-alpine AS web-build
WORKDIR /app/web
COPY web/package*.json ./
RUN npm install --registry=https://registry.npmmirror.com --no-audit --no-fund
COPY web/ ./
RUN npx vite build

FROM node:24-alpine
WORKDIR /app/server

COPY server/package*.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com --no-audit --no-fund

COPY server/ ./
COPY --from=web-build /app/web/dist /app/web/dist

RUN mkdir -p /app/server/data/books /app/server/data/covers

ENV PORT=4000
ENV MAX_UPLOAD_MB=50
EXPOSE 4000
CMD ["node", "src/index.js"]
