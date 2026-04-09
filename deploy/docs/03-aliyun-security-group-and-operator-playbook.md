# 日精月华 Phase 13 阿里云安全组与操作手册

这份文档解决两件事：

1. 阿里云安全组到底该开放哪些端口
2. 服务器日常操作时，先看什么、再做什么

## 一、安全组只保留这 3 个端口

当前阶段只保留：

- `80`
- `443`
- `22`

### 为什么只开这 3 个

- `80`
  - 给公网 HTTP 访问网站
- `443`
  - 给后续 HTTPS 访问网站
- `22`
  - 给你自己 SSH 登录服务器

### 为什么不能开 3000

因为 `3000` 是 Node 服务的内部端口。

正确关系是：

- 外网访问 `80/443`
- Nginx 再转给 `127.0.0.1:3000`

如果你把 `3000` 也开到公网：

- 外网就能绕过 Nginx 直接打 Node
- 暴露面会变大
- 后面域名和 HTTPS 也更容易乱

### 为什么数据库端口也不能开

当前数据库是本机 SQLite，不需要公网访问。
后续即使换数据库，也默认不对公网开放。

### 现阶段为什么 Nginx 模板只先开 80

因为当前还是 Phase 13，只先把反向代理、运维、备份和安全组基线收稳。

`443` 这个端口可以先在安全组里预留，但 **Nginx 配置里不要提前启用 `listen 443 ssl`**，否则没有证书时会导致 `nginx -t` 或 `nginx reload` 失败。

真正启用 HTTPS、证书路径和强制跳转，要等 Phase 14 再一起做。

## 二、阿里云控制台怎么检查安全组

### 步骤

1. 登录阿里云控制台。
2. 进入 `云服务器 ECS`。
3. 找到你的实例。
4. 点击实例对应的 `安全组`。
5. 进入 `安全组规则`。
6. 只保留你真正需要的入方向规则。

### 你应该看到什么

入方向里，原则上应只有：

- TCP `22`
- TCP `80`
- TCP `443`

### 如果你看到了这些端口，要检查后删除

- `3000`
- 任意数据库端口
- 其他你根本不知道为什么开的端口

## 三、日常最常用的 5 个服务器动作

当前这台服务器请按下面这套理解：

- Node 应用进程：`PM2`
- Nginx：`systemd`

也就是说，网站程序本身不要再优先看 `systemctl status cloud-store`，而是优先看 `pm2 status`。

## 1. 看应用状态

```bash
pm2 status
```

成功时，你应该看到：

- `cloud-store` 显示为 `online`

如果不是：

- 先不要发版
- 先看日志

## 2. 重启应用

```bash
pm2 restart cloud-store
```

然后马上检查：

```bash
pm2 status
```

## 3. 看 Nginx 状态

```bash
sudo systemctl status nginx --no-pager
```

成功时也应该看到：

- `active (running)`

## 4. 看应用日志

```bash
tail -n 50 /root/cloud-store/logs/app.out.log
tail -n 50 /root/cloud-store/logs/app.err.log
pm2 logs cloud-store --lines 20
```

如果没有日志文件：

- 先确认 `/root/cloud-store/logs` 是否存在
- 再看 `pm2 logs cloud-store --lines 20` 有没有报错

## 5. 看网站是否还能访问

```bash
bash /root/cloud-store/deploy/scripts/check-health.sh
```

如果脚本最后出现：

- `health checks passed`

说明当前至少服务和代理都活着。

## 四、每次动服务器前后的固定动作

### 变更前

1. 先做手动备份
2. 确认 `pm2 status` 里 `cloud-store` 是 `online`
3. 确认 `nginx` 是 `active (running)`

### 变更后

1. `pm2 restart cloud-store`
2. `sudo nginx -t`
3. `sudo systemctl restart nginx`
4. 执行健康检查
5. 访问首页确认页面能打开
6. 如果失败，优先回滚，不要硬修到更乱

## 五、这阶段和下一阶段的边界

Phase 13 到这里为止，只解决：

- Nginx
- PM2 版应用运维
- 安全组
- 备份恢复
- 发布回滚
- 服务器基础操作

还没有解决的，属于 Phase 14：

- 域名解析
- HTTPS 证书
- HTTP 自动跳 HTTPS
- 正式域名上线验证

所以如果你现在问“证书放哪、域名怎么指”，那是下一阶段的内容，不在本手册里混做。
