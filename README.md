---
title: TG Auto Signer
emoji: 🤖
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

# TG Auto Signer

Telegram 自动签到与自动续费多账号管理面板。

## 特性
- 支持多账号、独立设备环境模拟
- 支持多机器人自定义签到与续费步骤（发送、点击、小程序、AI图形验证码）
- 支持自定义签到周期与续费周期（按天计算）
- 支持失败重试调度与防封禁安全策略
- 支持 Neon / Supabase (PostgreSQL) 云端持久化存储（通过配置 DATABASE_URL 环境变量）
