FROM node:18-alpine

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
