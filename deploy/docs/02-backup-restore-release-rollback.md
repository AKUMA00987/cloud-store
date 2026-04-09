# 日精月华 Phase 13 备份、恢复、发布、回滚教程

这份文档是给“不会代码、只想稳稳操作”的使用者看的。

## 一、先记住：现在必须备份什么

当前线上可恢复状态，至少包含这 4 类：

1. 数据库
   - `/root/cloud-store/cloud-store.sqlite`
2. 上传图片
   - `/root/cloud-store/public/uploads`
3. 环境配置
   - `/root/cloud-store/cloud-store.env`
4. Nginx 配置与应用进程真相
   - `/etc/nginx/sites-available/cloud-store.conf` 或 `/etc/nginx/conf.d/cloud-store.conf`
   - `PM2` 中的 `cloud-store` 进程

只备份数据库不够。

## 二、发布前手动备份

### 目标

在你准备发新版本前，先留一份能回退的完整备份。

### 步骤

1. 登录服务器。
2. 进入当前版本目录：

```bash
cd /root/cloud-store
```

3. 执行手动备份：

```bash
bash deploy/scripts/backup-manual.sh before-release
```

### 看到什么算成功

- 终端出现 `manual backup complete`
- 在 `/root/cloud-store/backups/manual/` 下看到一个新的时间目录

### 如果没有成功

- 先不要发版
- 先检查：
  - `/root/cloud-store/backups/manual` 是否存在
  - `/root/cloud-store/cloud-store.sqlite` 是否存在
  - `/root/cloud-store/cloud-store.env` 是否存在

## 三、每日自动备份

### 目标

让服务器每天固定备份一次，避免只靠人工记忆。

### 步骤

1. 登录服务器。
2. 进入当前版本目录：

```bash
cd /root/cloud-store
```

3. 安装定时任务：

```bash
sudo bash deploy/scripts/install-daily-backup-cron.sh
```

### 看到什么算成功

- 终端出现 `installed cron file`
- 服务器里存在文件：

```bash
ls /etc/cron.d/cloud-store-backup
```

### 自动执行时间

- 默认每天凌晨 `03:20`

### 自动备份日志看哪里

```bash
tail -n 50 /root/cloud-store/logs/backup.log
```

## 四、发布新版本

### 目标

把你准备好的新版本文件覆盖到现在的 `/root/cloud-store`，并在替换后立即检查网站还活着。

### 步骤

1. 先确认你已经做了“发布前手动备份”。
2. 把你准备好的新版本文件夹放到服务器，比如：

```text
/root/cloud-store-release
```

3. 执行发布脚本：

```bash
sudo bash /root/cloud-store/deploy/scripts/deploy-release-pm2.sh /root/cloud-store-release
```

4. 执行健康检查：

```bash
bash /root/cloud-store/deploy/scripts/check-health.sh
```

### 看到什么算成功

- 终端出现 `release switched`
- `check-health.sh` 最后输出 `health checks passed`

### 如果没有成功

- 不要继续配置域名或证书
- 直接执行回滚
- 如果报 `nginx.service failed`，先执行：

```bash
sudo nginx -t
sudo systemctl status nginx --no-pager
```

- 最常见原因是你提前启用了 `443 ssl`，但证书还没配；Phase 13 先只保持 HTTP 反向代理即可

### 当前默认就是 PM2

当前这台服务器的应用主进程真相就是 `PM2`，所以发版时默认看：

- `root/deploy/docs/04-pm2-release-flow.md`
- `root/deploy/scripts/deploy-release-pm2.sh`
- `root/deploy/scripts/rollback-release-pm2.sh`

`root/deploy/scripts/deploy-release.sh` 现在只保留为 legacy 兼容脚本，默认会直接阻止执行，避免误把当前 PM2 服务器当成 `systemd` 管应用的机器。

补充说明：

- 备份脚本现在会自动优先识别 `sites-available/cloud-store.conf`
- 如果服务器上没有 `cloud-store.service`，也不会再影响当前 PM2 流程

## 五、回滚到上一版

### 目标

新版本发布后，如果首页打不开、接口报错、服务起不来，立刻切回上一版。

### 步骤

1. 登录服务器。
2. 执行回滚：

```bash
sudo bash /root/cloud-store/deploy/scripts/rollback-release-pm2.sh /root/cloud-store/backups/manual/20260409-120000-before-release
```

3. 再次执行健康检查：

```bash
bash /root/cloud-store/deploy/scripts/check-health.sh
```

### 看到什么算成功

- 终端出现 `rollback complete`
- 健康检查重新通过

## 六、从备份恢复

### 目标

如果数据库、图片或关键配置损坏，按备份恢复到某一个备份点。

### 步骤

1. 先确定你要恢复的备份目录，比如：

```text
/root/cloud-store/backups/manual/20260409-120000-before-release
```

2. 执行恢复：

```bash
sudo bash /root/cloud-store/deploy/scripts/restore-from-backup.sh /root/cloud-store/backups/manual/20260409-120000-before-release
```

3. 恢复完成后，执行健康检查：

```bash
bash /root/cloud-store/deploy/scripts/check-health.sh
```

### 看到什么算成功

- 终端出现 `restore complete`
- 健康检查通过
- 网站首页能打开

### 如果恢复后仍不正常

- 先回到更早一份备份再试一次
- 不要一边恢复一边继续发版

## 七、当前“可恢复状态”定义

只要下面这些都能被找回，我们就认为当前系统可恢复：

- SQLite 文件
- uploads 图片目录
- 环境变量文件
- Nginx 配置
- PM2 中的 `cloud-store` 进程可重新拉起

域名、证书和 HTTPS 仍属于下一阶段，不在这份恢复闭环里。
