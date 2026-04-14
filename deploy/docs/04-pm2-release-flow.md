# 日精月华 PM2 实际使用版发版流程

这份文档只给你现在这台服务器用。

你的当前实际情况是：

- Node 进程由 `PM2` 守护
- Nginx 负责把公网 `80` 转发到 `127.0.0.1:3000`
- 项目目录是 `/root/cloud-store`
- 发版包目录是 `/root/cloud-store-release`

所以以后发版时，**不要再把“重启 Node”理解成 `systemctl restart cloud-store`**。  
你真正要重启的是：

```bash
pm2 restart cloud-store
```

`deploy/scripts/deploy-release.sh` 现在已经降级成 legacy 兼容脚本，默认会拒绝执行，避免误走旧的 `systemd` 管应用路径。

## 一、发版前先确认什么

先执行：

```bash
pm2 status
sudo systemctl status nginx --no-pager
bash /root/cloud-store/deploy/scripts/check-health.sh
```

你要看到：

- `pm2 status` 里 `cloud-store` 是 `online`
- `nginx` 是 `active (running)`
- 健康检查两步都通过

如果这一步都没通过，先不要发版。

## 二、当前发版包应该包含什么

`/root/cloud-store-release` 里应该至少有：

- `server.js`
- `package.json`
- `package-lock.json`
- `public/index.html`
- `deploy/`

不应该拿去覆盖的有：

- `/root/cloud-store/cloud-store.sqlite`
- `/root/cloud-store/public/uploads`
- `/root/cloud-store/cloud-store.env`
- `/root/cloud-store/logs`
- `/root/cloud-store/backups`

## 三、PM2 版标准发版步骤

### 第 1 步：进入网站目录

```bash
cd /root/cloud-store
```

### 第 2 步：执行 PM2 版发版脚本

```bash
sudo bash /root/cloud-store/deploy/scripts/deploy-release-pm2.sh /root/cloud-store-release
```

这一步会自动做：

1. 发布前手动备份
2. 把新版 `server.js`、`public/`、`deploy/`、`package.json`、`package-lock.json` 复制到 `/root/cloud-store`
3. 重启 `PM2` 里的 `cloud-store`
4. 检查 `nginx -t`
5. 重启 Nginx

补充说明：

- `deploy/` 现在也会跟着 release 一起同步，避免服务器上的 `deploy/scripts/*.sh`、`deploy/docs/*.md` 长期停留在旧版本
- `public/uploads` 仍然不会被覆盖

现在脚本会自动优先识别：

- `/etc/nginx/sites-available/cloud-store.conf`
- 如果没有，再尝试 `/etc/nginx/conf.d/cloud-store.conf`

同时如果你的服务器上没有 `cloud-store.service`，也不会再因为缺少这个文件而让备份直接失败。

### 第 3 步：做健康检查

```bash
bash /root/cloud-store/deploy/scripts/check-health.sh
```

如果看到：

```text
health checks passed
```

说明当前网站已经恢复到可访问状态。

补充说明：

- 当前 `check-health.sh` 已带启动期重试，默认会等待最多约 20 秒
- 如果 Node 刚重启，前几次短暂 `connection refused` 不再直接算发版失败

### 第 4 步：看 PM2 最新日志

```bash
pm2 logs cloud-store --lines 20
```

重点确认没有这些错误：

- `ENOENT`
- `EADDRINUSE`
- `Cannot find module`
- `permission denied`

## 四、如果发版后打不开网站怎么办

先按这个顺序查，不要一上来乱改文件：

### 1. 先看 PM2 进程还在不在

```bash
pm2 status
```

如果 `cloud-store` 不是 `online`，先重启：

```bash
pm2 restart cloud-store
```

### 2. 再看 Nginx 还在不在

```bash
sudo systemctl status nginx --no-pager
sudo nginx -t
```

如果这里报错，先修 Nginx，再谈公网访问。

### 3. 再看本机两层访问是不是通

```bash
curl -I http://127.0.0.1:3000/
curl -I http://127.0.0.1/
```

判断方法：

- 第一个通：说明 Node 正常
- 第二个通：说明 Nginx 反代正常
- 两个都通但外网不通：再查安全组或防火墙

## 五、PM2 版回滚步骤

### 第 1 步：找到要回滚到哪份备份

例如：

```text
/root/cloud-store/backups/manual/20260409-235432-before-release
```

### 第 2 步：执行 PM2 版回滚脚本

```bash
sudo bash /root/cloud-store/deploy/scripts/rollback-release-pm2.sh /root/cloud-store/backups/manual/20260409-235432-before-release
```

### 第 3 步：重新做健康检查

```bash
bash /root/cloud-store/deploy/scripts/check-health.sh
```

### 第 4 步：再看 PM2 日志

```bash
pm2 logs cloud-store --lines 20
```

## 六、最重要的一条

你现在这台机器，**应用进程真相在 PM2，不在 systemd**。

所以以后排查“网站是不是活着”，优先看：

```bash
pm2 status
pm2 logs cloud-store --lines 20
```

而不是先看：

```bash
systemctl status cloud-store
```

`systemd` 在你当前这台服务器上主要用于 Nginx，不是当前 Node 主进程的真相来源。
