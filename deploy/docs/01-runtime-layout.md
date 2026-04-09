# 日精月华 Phase 13 运行方式与目录结构

这份文档只解决一件事：
把线上运行方式固定下来，避免以后每次发布都重新猜“文件该放哪、服务该怎么启动”。

## 一、最终采用的运行方式

当前阶段固定为：

1. `Nginx` 对外接收公网请求
2. `Node` 只监听 `127.0.0.1:3000`
3. `PM2` 负责守护 Node 进程
4. `SQLite` 和上传图片继续按你现在的目录结构放在 `/root/cloud-store` 下

这意味着：

- 公网用户不会直接访问 `3000`
- 公网真正访问的是 `80` 和后续 `443`
- `3000` 只是服务器内部给 Nginx 转发用

## 二、当前真实目录

请按你现在服务器上的这套目录理解网站：

- `/root/cloud-store`
  - 网站项目根目录
- `/root/cloud-store/server.js`
  - Node 服务入口
- `/root/cloud-store/public/index.html`
  - 前台页面入口
- `/root/cloud-store/cloud-store.sqlite`
  - 当前数据库文件
- `/root/cloud-store/public/uploads`
  - 上传图片目录
- `/root/cloud-store/backups/manual`
  - 手动备份目录
- `/root/cloud-store/backups/daily`
  - 每日自动备份目录
- `/root/cloud-store/logs`
  - 应用和备份日志目录
- `/root/cloud-store/cloud-store.env`
  - 环境变量文件

## 三、为什么数据库和图片不能继续放在代码目录

你现在就是单目录结构，所以这阶段不强行要求你先改成 `releases/current/shared`。  
当前只做一件事：把这套单目录结构先运维稳。

这里要特别记住：

- `server.js` 在 `/root/cloud-store`
- `index.html` 在 `/root/cloud-store/public`
- 数据库也在 `/root/cloud-store`
- 上传图在 `/root/cloud-store/public/uploads`

这意味着你备份时不能只拷一个文件，要把数据库、图片、配置和 Nginx 一起算进去；应用进程真相则固定为 `PM2` 里的 `cloud-store`。

## 四、当前关键文件

- `/root/cloud-store/server.js`
  - Node 服务入口
- `/root/cloud-store/public/index.html`
  - 前台页面入口
- `/root/cloud-store/cloud-store.sqlite`
  - 线上数据库
- `/root/cloud-store/deploy/env/cloud-store.env.example`
  - 环境变量模板
- `/root/cloud-store/deploy/nginx/cloud-store.conf`
  - Nginx 模板
- `/root/cloud-store/deploy/systemd/cloud-store.service`
  - 可选兼容模板，不是当前默认应用进程真相
- `PM2`
  - 当前默认应用进程守护方式，进程名固定为 `cloud-store`

## 五、这一步完成后的结果

完成这一步后，后续教程会一直默认：

- 改 Node 入口看 `/root/cloud-store/server.js`
- 改页面入口看 `/root/cloud-store/public/index.html`
- 数据库看 `/root/cloud-store/cloud-store.sqlite`
- 图片看 `/root/cloud-store/public/uploads`
- 备份看 `/root/cloud-store/backups`
- 日志看 `/root/cloud-store/logs`

这样后面的备份、恢复、重启和健康检查就都能直接照做。
