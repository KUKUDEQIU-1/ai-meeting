# AI 会议纪要系统

第一阶段功能：上传 txt 会议文本，调用 AI 接口生成结构化会议总结 JSON 和章节分析 JSON，并在 Vue 页面展示。

## 技术栈

- 前端：Vue 3、Vite
- 后端：Node.js、Express
- 数据库：SQLite，通过 `sql.js` 持久化为本地 SQLite 文件
- 上传：multer
- AI：兼容 OpenAI Chat Completions 风格接口

## 项目结构

```text
C:\ai-meeting
├─ package.json
├─ .env.example
├─ .gitignore
├─ README.md
├─ server
│  ├─ package.json
│  ├─ index.js
│  ├─ .env.example
│  ├─ db
│  │  ├─ database.js
│  │  └─ schema.sql
│  ├─ routes
│  │  └─ meetings.js
│  ├─ services
│  │  └─ aiService.js
│  ├─ uploads
│  │  └─ .gitkeep
│  └─ data
│     └─ .gitkeep
└─ client
   ├─ package.json
   ├─ index.html
   ├─ vite.config.js
   ├─ public
   │  └─ favicon.svg
   └─ src
      ├─ main.js
      ├─ App.vue
      ├─ api
      │  └─ meetings.js
      ├─ components
      │  ├─ UploadMeeting.vue
      │  ├─ MeetingSummary.vue
      │  └─ TaskList.vue
      └─ styles
         └─ main.css
```

## 安装依赖

```bash
cd C:\ai-meeting
npm install
npm run install:all
```

## 配置 AI 接口

复制环境变量文件：

```powershell
Copy-Item server\.env.example server\.env
```

编辑 `server/.env`：

```env
PORT=3000
CLIENT_ORIGIN=http://localhost:5173
AI_API_URL=https://api.concertcalendar.cloud/v1/chat/completions
AI_API_KEY=
AI_MODEL=gpt-5.5
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_BITABLE_APP_TOKEN=
FEISHU_BITABLE_TABLE_ID=
```

如果暂时不配置 `AI_API_KEY`，后端会返回本地示例总结，方便先验证上传和页面展示流程。

## 启动开发环境

```bash
npm run dev
```

访问前端：

```text
http://localhost:5173
```

后端地址：

```text
http://localhost:3000
```

## Dokploy Compose 部署

如果使用 Dokploy 的 Docker Compose 方式部署：

1. 使用仓库根目录下的 `docker-compose.yml`
2. 域名绑定为 `huiyiai.yourtest.top`
3. 在 Dokploy 中配置环境变量，至少包括：

```env
APP_BASE_URL=https://huiyiai.yourtest.top
PORT=3000
CLIENT_ORIGIN=https://huiyiai.yourtest.top
```

4. 部署完成后优先验证：

```text
https://huiyiai.yourtest.top/api/health
https://huiyiai.yourtest.top/api/meeting/draft/3
https://huiyiai.yourtest.top/meeting-drafts/3
```

`docker-compose.yml` 已包含 `server/data` 和 `server/uploads` 的持久化卷，避免重建容器后本地数据丢失。

健康检查：

```text
http://localhost:3000/api/health
```

## API

### 上传会议文本

```text
POST /api/meetings/upload
```

表单字段：

```text
file: txt 文件
```

返回示例：

```json
{
  "id": 1,
  "summary": {
    "title": "会议标题",
    "overview": "会议概述",
    "keyPoints": ["关键要点"],
    "decisions": ["决策事项"],
    "actionItems": [
      {
        "task": "任务内容",
        "owner": "负责人",
        "deadline": "截止时间"
      }
    ],
    "risks": ["风险提示"]
  },
  "chapters": [
    {
      "title": "章节标题",
      "timeRange": "时间范围",
      "summary": "内容摘要"
    }
  ],
  "tasks": [
    {
      "title": "任务标题",
      "description": "任务说明",
      "owner": "负责人",
      "deadline": "截止时间",
      "priority": "中",
      "status": "待开始",
      "project": "AI会议助手",
      "source": "会议纪要"
    }
  ]
}
```

### 同步任务到飞书多维表格

```text
POST /api/meeting/sync-feishu
```

请求示例：

```json
{
  "meeting_title": "项目例会",
  "meeting_source": "会议纪要",
  "summary": "本次会议确认了后续任务安排。",
  "tasks": [
    {
      "title": "完成前端页面",
      "description": "完善会议纪要上传和展示页面。",
      "owner": "张三",
      "deadline": "2026-07-12",
      "priority": "中"
    }
  ]
}
```

返回示例：

```json
{
  "success": true,
  "created_count": 1,
  "failed": []
}
```

测试写入一条假任务：

```text
POST /api/meeting/sync-feishu/test
```

返回示例：

```json
{
  "success": true,
  "created_count": 1,
  "failed": [],
  "record": {}
}
```

### 处理会议并自动同步飞书

```text
POST /api/meeting/process
```

请求示例：

```json
{
  "text": "今天会议讨论了飞书同步模块，张三负责明天前完成字段校验，李四负责补充 README。",
  "meeting_source": "手动输入",
  "auto_sync_feishu": true
}
```

返回示例：

```json
{
  "success": true,
  "meeting_title": "会议标题",
  "meeting_source": "手动输入",
  "summary": "会议摘要",
  "tasks": [],
  "feishu_sync": {
    "success": true,
    "created_count": 1,
    "failed": []
  }
}
```

本地测试命令：

```powershell
$body = @{
  text = "今天会议讨论了飞书同步模块，张三负责明天前完成字段校验，李四负责补充 README。"
  meeting_source = "手动输入"
  auto_sync_feishu = $true
} | ConvertTo-Json -Depth 10

Invoke-RestMethod -Uri "http://localhost:3000/api/meeting/process" -Method Post -ContentType "application/json" -Body $body
```

### 查询会议纪要

```text
GET /api/meetings/:id
```

## 数据库

SQLite 文件会自动创建在：

```text
server/data/meetings.sqlite
```

表结构位于：

```text
server/db/schema.sql
```

## Get笔记自动同步

当前 Get笔记流程会自动扫描最近笔记，不再默认依赖“会议”标签。系统会优先使用 `audio.original`、`audio.transcript` 或 `transcript` 作为 AI 主输入，严格过滤任务后，为每场会议创建独立飞书任务表，并写入会议索引表和本地同步记录。

### 环境变量

```env
FEISHU_GROUP_NOTIFY_RECEIVE_ID_TYPE=chat_id
FEISHU_GROUP_NOTIFY_RECEIVE_ID=
FEISHU_NOTIFY_RECEIVE_ID_TYPE=email
FEISHU_NOTIFY_RECEIVE_ID=
GETNOTE_REQUIRE_TAG=false
GETNOTE_SYNC_TAG=
GETNOTE_SCAN_LIMIT=20
GETNOTE_MIN_NOTE_AGE_MINUTES=5
GETNOTE_MAX_LOOKBACK_DAYS=7
GETNOTE_WORKER_INTERVAL_MINUTES=15
GETNOTE_PROCESSING_TIMEOUT_MINUTES=30
```

- `GETNOTE_REQUIRE_TAG=false`：默认不按标签过滤，扫描最近 Get笔记列表中的所有新笔记。
- `GETNOTE_SYNC_TAG=`：仅当 `GETNOTE_REQUIRE_TAG=true` 时使用。
- `GETNOTE_SCAN_LIMIT=20`：每次扫描最近 20 条笔记。
- `GETNOTE_MIN_NOTE_AGE_MINUTES=5`：笔记创建后至少等待 5 分钟再处理，避免转写未完成。
- `GETNOTE_MAX_LOOKBACK_DAYS=7`：最多处理最近 7 天内的笔记。
- `GETNOTE_PROCESSING_TIMEOUT_MINUTES=30`：`processing` 状态超过 30 分钟允许重试。
- `FEISHU_GROUP_NOTIFY_RECEIVE_ID_TYPE=chat_id`：群通知接收 ID 类型。应用机器人发群消息时，这个接口使用 `chat_id`。
- `FEISHU_GROUP_NOTIFY_RECEIVE_ID=`：目标群聊 ID。配置后，每次成功录入任务会自动往该群发送总任务表链接。
- `FEISHU_NOTIFY_RECEIVE_ID_TYPE=email`：飞书私发通知的接收 ID 类型，默认 `email`。
- `FEISHU_NOTIFY_RECEIVE_ID=`：飞书私发通知接收人。配置后，worker 启动首次扫描若 `imported=0` 会私发“未读取到会议内容”。

### 正式使用方式一：手动同步

```bash
npm run sync:getnote
```

适合每天会议结束后手动跑一次，或部署到服务器后通过系统定时任务跑。

同步逻辑：

- 拉取最近 Get笔记列表。
- 跳过已经 `success` 的 `note_id`。
- 新笔记进入完整流程：获取详情、提取转写原文、AI 分析、严格过滤任务、创建独立飞书任务表、写入会议索引表、保存同步记录。
- 单条失败不会中断全部同步。
- 转写未完成时返回 `transcript_not_ready`，下一轮会继续尝试。

### 正式使用方式二：后台自动轮询

```bash
npm run worker:getnote
```

适合工具常驻运行。启动后立即同步一次，之后每 `GETNOTE_WORKER_INTERVAL_MINUTES` 分钟自动扫描一次。若上一轮还没结束，下一轮会自动跳过，避免并发重复执行。

补充行为：

- worker 每次启动后的首次扫描，如果 `imported=0`，终端会打印 `未读取到会议内容`。
- 如果同时配置了 `FEISHU_NOTIFY_RECEIVE_ID_TYPE` 和 `FEISHU_NOTIFY_RECEIVE_ID`，还会私发一条提醒。
- 每次成功录入任务后，如果配置了 `FEISHU_GROUP_NOTIFY_RECEIVE_ID`，会自动通过应用机器人往群里发送总任务表链接。

### 生产部署建议

使用 PM2 常驻运行：

```bash
pm2 start npm --name getnote-worker -- run worker:getnote
```

查看日志：

```bash
pm2 logs getnote-worker
```

重启：

```bash
pm2 restart getnote-worker
```

停止：

```bash
pm2 stop getnote-worker
```

也可以用系统定时任务每 15 分钟执行：

```bash
npm run sync:getnote
```

## 注意事项

- 支持 `.txt` 文件上传和直接粘贴会议文本。
- 默认上传大小限制为 2MB。
- 建议上传 UTF-8 编码文本。
- AI 接口需兼容 OpenAI Chat Completions 响应格式。
