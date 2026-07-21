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
FEISHU_ASSIGNEE_MAP_JSON={"张三":"ou_xxx","李四":{"open_id":"ou_yyy"}}
FEISHU_EVENT_VERIFICATION_TOKEN=
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

1. 只使用仓库根目录下的 `docker-compose.yml` 和根目录 `Dockerfile`
2. 根目录 `Dockerfile` 只会打包根目录下的 `server/`，不会使用 `github-upload-ready/` 或其他备份目录
3. 域名绑定为 `huiyiai.yourtest.top`
4. 在 Dokploy 中配置环境变量，至少包括：

```env
APP_BASE_URL=https://huiyiai.yourtest.top
PORT=3000
CLIENT_ORIGIN=https://huiyiai.yourtest.top
```

5. 部署完成后优先验证：

```text
https://huiyiai.yourtest.top/api/health
https://huiyiai.yourtest.top/api/meeting/latest-draft
https://huiyiai.yourtest.top/latest-meeting-draft
```

目标结果：

```text
GET /api/health -> {"status":"ok","version":"latest-draft-v2"}
GET /api/meeting/latest-draft -> 不应为路由 404
GET /latest-meeting-draft -> 不应为页面 404
```

如果 `/api/health` 仍只返回 `{"status":"ok"}`，说明线上仍在跑旧代码，不要继续排查业务接口，先检查 Dokploy 的以下配置：

1. `Repository`
2. `Branch`
3. `Build Context`
4. `Dockerfile Path`
5. 是否确实触发了重新构建，而不是复用旧镜像

最小上线文件清单：

1. `Dockerfile`
2. `docker-compose.yml`
3. `server/index.js`
4. `server/routes/meeting.js`
5. `server/routes/feishuCardAction.js`
6. `server/package.json`

建议不要把 `github-upload-ready/`、`github-latest-draft-patch/` 视为部署源目录，它们更适合作为临时备份，容易和真实上线代码混淆。

`docker-compose.yml` 已包含 `server/data` 和 `server/uploads` 的持久化卷，避免重建容器后本地数据丢失。

## 飞书任务私发确认卡片

飞书会议智能纪要和 docx 同步后的任务会先保存为待确认草稿，再按照负责人分别发送到个人飞书窗口。系统不会再发送群确认链接或在群内发送任务确认消息。

系统会自动读取指定群的成员姓名和飞书 `open_id`，不需要手动维护每个人的 ID。配置目标群：

```env
FEISHU_TASK_GROUP_CHAT_ID=oc_04b13848c71255285a08282b66cdafb3
```

机器人需要在该群内，并开通 `im:chat.members:read`。系统调用群成员接口后，按成员姓名匹配会议纪要中的负责人。

部署后可以手动验证读取结果：

```bash
npm run list:feishu-group-members
```

该命令只输出成员姓名和 `open_id`，不会输出应用密钥或访问令牌。

手动映射仅作为群成员接口不可用时的兜底配置：

```env
FEISHU_ASSIGNEE_MAP_JSON={"张三":"ou_xxx","李四":{"open_id":"ou_yyy"}}
```

负责人名称会先去除空白后匹配。未配置映射的负责人会记录为发送失败，不会回退发送到全局通知账号。

飞书开放平台还需要：

1. 开启应用机器人能力，并确保负责人在应用可用范围内。
2. 开通查看群成员权限：`im:chat.members:read`。
3. 开通发送机器人消息和更新消息卡片所需权限，例如 `im:message`、`im:message:send_as_bot`、`im:message:update`。
4. 订阅新版卡片回传事件 `card.action.trigger`。
5. 将事件回调地址设置为：
   ```text
   https://huiyiai.yourtest.top/api/feishu/card-action
   ```
6. 如果开放平台配置了事件验证 Token，将相同值写入：
   ```env
   FEISHU_EVENT_VERIFICATION_TOKEN=
   ```

卡片操作流程：

```text
生成草稿 -> 按负责人私发任务卡片 -> 修改任务字段 -> 点击确认 -> 仅该负责人的任务写入总任务表
```

点击“修改”只保存任务名称、截止时间和备注；点击“丢弃”会忽略该任务；点击“确认我的任务入总表”才会执行入表。重复点击确认不会重复创建任务。

`FEISHU_GROUP_NOTIFY_RECEIVE_ID` 不再控制任务确认流程，旧群通知配置可以保留用于兼容历史配置，但生产代码不会再使用它发送任务确认消息。

当前唯一交互回调接口为：

```text
POST /api/feishu/card-action
```

系统不再提供网页草稿确认页，也不再提供浏览器草稿编辑和 finalize API。用户必须在飞书私聊卡片内完成修改、丢弃和确认。

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
FEISHU_ASSIGNEE_MAP_JSON={"张三":"ou_xxx","李四":{"open_id":"ou_yyy"}}
FEISHU_EVENT_VERIFICATION_TOKEN=
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
- `FEISHU_GROUP_NOTIFY_RECEIVE_ID_TYPE=chat_id`：群通知接收 ID 类型。仅用于非草稿确认类群通知；飞书会议纪要/docx 草稿确认不再使用群确认链接。
- `FEISHU_GROUP_NOTIFY_RECEIVE_ID=`：目标群聊 ID。该变量不再控制草稿确认投递，草稿确认改为按负责人私发交互卡片。
- `FEISHU_ASSIGNEE_MAP_JSON=`：负责人到飞书 `open_id` 的映射，键会按去空格后的负责人姓名匹配；未映射负责人会记录为投递失败，不会回退发送到全局收件人。示例：`{"张三":"ou_xxx","李四":{"open_id":"ou_yyy"}}`。
- `FEISHU_EVENT_VERIFICATION_TOKEN=`：飞书事件订阅/卡片回调 verification token。配置后 `/api/feishu/card-action` 会拒绝 token 不匹配的回调。
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

## 飞书负责人私有任务卡片

飞书会议智能纪要和 docx 草稿路径会先创建本地 `meeting_task_drafts`，再按负责人归一化分组，向 `FEISHU_ASSIGNEE_MAP_JSON` 中配置的 `open_id` 私发一张交互任务卡片。每张卡片只包含该负责人的任务，使用 `receive_id_type=open_id`，卡片内可修改任务名称、截止时间、备注，或确认本人任务入总任务表。未配置映射的负责人只会在本地 `meeting_task_draft_assignees` 中记录投递失败，不会发送到 `FEISHU_NOTIFY_RECEIVE_ID` 或群聊。

飞书控制台需要配置：

1. 机器人具备向用户发送消息/卡片消息的 IM 权限，并可按 `open_id` 发送。
2. 卡片回调或事件订阅地址配置为：`https://你的域名/api/feishu/card-action`。
3. 如启用 verification token，将同一个值填入 `FEISHU_EVENT_VERIFICATION_TOKEN`。
4. 事件 URL 校验会返回 Feishu 的 `challenge`；`card.action.trigger` 回调会校验操作者 `open_id` 必须等于持久化的收件人 `open_id`。

重复点击“确认我的任务入总表”是幂等的：已确认负责人再次回调会直接返回已处理提示，不会再次使用回调输入构造任务数组。当前私有卡片流程优先覆盖飞书会议智能纪要/docx 的草稿路径；直接 GetNote 入表路径仍保持原有行为。

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
