# Health System — 个人健康管理 PWA

睡眠 · 训练 · 饮食 三合一,带 AI 教练层(结合 Attia / Stacy Sims 框架）。
本地优先：所有健康数据存在你自己浏览器里（localStorage），不上传任何服务器。
AI 教练 + 拍照估蛋白质通过一个服务端函数调用 Anthropic API，**API key 只放在服务端环境变量里，永远不进前端**。

---

## 在手机上当 app 用（部署后）

部署完会得到一个网址。用手机浏览器打开它：
- **iPhone（Safari）**：分享按钮 → 「添加到主屏幕」
- **Android（Chrome）**：菜单 → 「安装应用 / 添加到主屏幕」

之后就有图标、像原生 app 一样全屏打开，记录功能可离线使用（AI 需要联网）。

---

## 部署（约 10 分钟，推荐 Vercel）

### 方式 A：用 Claude Code（你电脑上）
把这个文件夹交给 Claude Code，告诉它：
> 「帮我把这个 Vite + PWA 项目部署到 Vercel，并设置环境变量 ANTHROPIC_API_KEY」

然后在提示时粘贴你自己的 Anthropic API key（从 https://console.anthropic.com 的 “Get API key” 获取）。

### 方式 B：手动
```bash
npm install
npm run build          # 验证能正常构建
npm i -g vercel        # 如未安装
vercel                 # 首次部署，按提示登录/选择
vercel env add ANTHROPIC_API_KEY   # 粘贴你的 key（选 Production/Preview/Development）
vercel --prod          # 正式部署
```

> ⚠️ **API key 安全**：key 只通过 `vercel env add` 进入服务端环境变量，绝不要写进任何代码文件或前端。`api/claude.js` 在服务器上读取它。

---

## 本地开发
```bash
npm install
npm run dev
```
注意：本地 `npm run dev` 下 `/api/claude` 不会自动运行（那是 Vercel 的 serverless 函数）。
要在本地连同 API 一起跑，用 `vercel dev` 并先设置好本地环境变量。

---

## 配置

- **AI 模型**：见 `src/App.jsx` 顶部的 `const MODEL`。默认 `claude-sonnet-4-6`（性价比高，适合每日教练）。
  想要最高质量改成 `claude-opus-4-8`；若某个模型串报错，换一个当前可用的即可。
- **蛋白质目标 / 体重 / 周期 / 赛事日期**：app 内「设置」页可改。
- **Strava**：从 Strava 网站导出活动 CSV，在「设置」页上传，自动解析。
- **清空数据**：「设置」页底部。

---

## 成本说明
AI 调用走你自己的 Anthropic API（按量计费），和 Claude 订阅是两笔账。
Sonnet 跑日常教练每月通常只是几美元级别。模型可在 `src/App.jsx` 切换。
