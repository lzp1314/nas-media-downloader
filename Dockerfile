FROM node:22-alpine

RUN apk add --no-cache aria2 curl tzdata su-exec \
    && ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone

WORKDIR /app

# 零 npm 依赖，无需 npm install，构建不依赖外网 registry
COPY . .

# 兼容 Windows 换行，保证入口脚本可执行
RUN sed -i 's/\r$//' /app/docker/entrypoint.sh && chmod +x /app/docker/entrypoint.sh

ENV NODE_ENV=production \
    CONFIG_DIR=/config \
    MEDIA_ROOT=/media \
    DOWNLOADS_DIR=/media/影视 \
    PORT=8080 \
    TZ=Asia/Shanghai

EXPOSE 8080
EXPOSE 51413
EXPOSE 51413/udp

VOLUME ["/media", "/config"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1

CMD ["sh", "/app/docker/entrypoint.sh"]
