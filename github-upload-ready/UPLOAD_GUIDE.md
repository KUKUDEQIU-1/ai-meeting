# GitHub Upload Guide

这个文件夹 `github-upload-ready` 是已经整理好的可上传版本。

## 直接上传哪些内容

把这个文件夹里的所有内容上传到 GitHub 仓库根目录：

- `.dockerignore`
- `.gitignore`
- `Dockerfile`
- `docker-compose.yml`
- `README.md`
- `server/`

## 不要再额外上传的内容

不要把你本地原项目里的这些内容一起传上去：

- `server/.env`
- `server/node_modules/`
- `server/data/meetings.sqlite`
- `server/data/*.json`
- 任何本地日志文件

## server 目录里已经保留的内容

当前已保留：

- `server/index.js`
- `server/package.json`
- `server/package-lock.json`
- `server/.env.example`
- `server/db/`
- `server/public/`
- `server/routes/`
- `server/services/`
- `server/scripts/`
- `server/utils/`
- `server/data/.gitkeep`
- `server/uploads/.gitkeep`

## 上传后检查

GitHub 仓库根目录至少应能看到：

- `docker-compose.yml`
- `Dockerfile`
- `.dockerignore`
- `server/`

并且 `server/` 下面应能看到：

- `index.js`
- `package.json`
- `services/`
- `routes/`

## Dokploy 后续配置

上传完成后，在 Dokploy 中选择：

- Deployment Type: `Docker Compose`
- Compose File: `docker-compose.yml`

然后绑定域名：

- `huiyiai.yourtest.top`

并配置环境变量，至少包括：

```env
PORT=3000
APP_BASE_URL=https://huiyiai.yourtest.top
CLIENT_ORIGIN=https://huiyiai.yourtest.top
```
