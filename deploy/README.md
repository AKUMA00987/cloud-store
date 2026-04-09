# Cloud Store Deploy Kit

这个目录只放“部署与运维模板”，不会被网站前台直接读取。

当前默认目标环境：

- Aliyun ECS
- Linux
- `Nginx + PM2 + Node`
- SQLite 继续保留为当前数据库
- 上传图片继续保留本地文件

## 目录说明

- `env/`
  - 环境变量模板
- `nginx/`
  - Nginx 反向代理模板
- `systemd/`
  - 可选兼容模板，仅在你未来改回 `systemd` 管 Node 时使用
- `scripts/`
  - 备份、恢复、发布、回滚、健康检查脚本模板
- `docs/`
  - 面向非程序员的分步操作教程

## 当前实际使用提醒

当前这套文档默认按你现在服务器上的真实方式理解：

- Nginx 继续由 `systemd` 管
- Node 进程应以 `PM2` 为准
- 发版优先参考：
  - `docs/04-pm2-release-flow.md`
  - `scripts/deploy-release-pm2.sh`
  - `scripts/rollback-release-pm2.sh`
- legacy 兼容项：
  - `scripts/deploy-release.sh`
  - 默认会拒绝执行，只有显式设置 `ALLOW_LEGACY_SYSTEMD_DEPLOY=1` 才会继续旧的 `systemd` 管应用流程

## Phase 14 相关文件

如果你准备继续做正式域名和 HTTPS，上线阶段重点看：

- `docs/05-domain-dns-http-prep.md`
- `docs/06-https-certbot-public-cutover.md`
- `nginx/cloud-store-https.conf.example`

如果你准备在正式上线前清掉测试期数据，只保留 `admin` 账号，再额外看：

- `docs/07-launch-data-reset.md`
- `scripts/reset-launch-data.sh`
- `scripts/reset-launch-data.js`

## 当前线上目录口径

按你现在服务器上的实际结构，这套模板统一按下面这些路径理解：

- `/root/cloud-store`
  - 网站项目根目录
- `/root/cloud-store/server.js`
  - Node 服务入口
- `/root/cloud-store/public/index.html`
  - 前台页面入口
- `/root/cloud-store/cloud-store.sqlite`
  - 当前正在使用的 SQLite 数据库
- `/root/cloud-store/public/uploads`
  - 上传图片目录
- `/root/cloud-store/cloud-store.env`
  - 运行环境变量文件
- `/root/cloud-store/backups`
  - 手动和自动备份目录
- `/root/cloud-store/logs`
  - 应用日志和备份日志目录

## 当前模板约定

- Node 只监听 `127.0.0.1:3000`
- 公网只通过 Nginx 进入
- 安全组只保留 `80/443/22`
- 域名和 HTTPS 证书切换现已在 `Phase 14` 文档中给出分步教程，但仍需要用户在自己的服务器和域名控制台上手动执行
