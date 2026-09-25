FROM node:18-alpine

# 安装 Chromium 浏览器及字体依赖，用于自动唤起并运行 Telegram 小程序与 CF 验证
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

# 复制依赖文件并安装
COPY package.json ./
RUN npm install

# 复制所有源代码
COPY . .

# Hugging Face 默认暴露 7860 端口
ENV PORT=7860
EXPOSE 7860

# 启动命令
CMD ["npm", "start"]
