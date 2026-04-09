# 日精月华 Phase 13 第一次准备服务器教程

这份教程只做“把服务器准备成可以部署网站的状态”。

## 一、你要先准备什么

开始前，请确认：

1. 你已经能登录阿里云 ECS
2. 你已经能通过 SSH 连上服务器
3. 服务器系统是常见 Linux 发行版

## 二、第一次登录服务器后先做什么

### 第 1 步：进入项目脚本目录

你现在的项目实际在：

- `server.js`：`/root/cloud-store/server.js`
- `index.html`：`/root/cloud-store/public/index.html`

所以后面的命令统一从这里开始：

```bash
cd /root/cloud-store
```

### 第 2 步：创建日志目录、备份目录和上传目录

执行：

```bash
sudo bash deploy/scripts/prepare-runtime-dirs.sh
```

### 成功时会看到什么

- 终端输出：

```text
runtime directories prepared under /root/cloud-store
```

### 第 3 步：确认目录真的创建成功了

执行：

```bash
ls /root/cloud-store
ls /root/cloud-store/public
ls /root/cloud-store/backups
ls /root/cloud-store/logs
```

你应该能看到这些目录：

- `public/uploads`
- `backups`
- `logs`

## 三、准备环境变量文件

### 第 1 步：复制模板

执行：

```bash
cp deploy/env/cloud-store.env.example /root/cloud-store/cloud-store.env
```

### 第 2 步：编辑配置

执行：

```bash
nano /root/cloud-store/cloud-store.env
```

### 你至少要检查这几项

- `HOST=127.0.0.1`
- `PORT=3000`
- `CLOUD_STORE_DB_PATH=/root/cloud-store/cloud-store.sqlite`
- `CLOUD_STORE_UPLOAD_ROOT=/root/cloud-store/public/uploads`
- `CS_ADMIN_BOOTSTRAP_PASSWORD=...`

### 特别提醒

- `CS_ADMIN_BOOTSTRAP_PASSWORD` 不能保持模板默认值
- 这项必须换成你自己设置的长密码
- 这个文件就在 `/root/cloud-store/cloud-store.env`

## 四、把 Nginx 模板放到系统目录

### 第 1 步：复制 Nginx 模板

执行：

```bash
sudo cp deploy/nginx/cloud-store.conf /etc/nginx/sites-available/cloud-store.conf
sudo ln -sf /etc/nginx/sites-available/cloud-store.conf /etc/nginx/sites-enabled/cloud-store.conf
sudo rm -f /etc/nginx/sites-enabled/default
```

### 第 2 步：检查 Nginx 配置

执行：

```bash
sudo nginx -t
```

看到下面这种结果再继续：

```text
syntax is ok
test is successful
```

### 第 3 步：重启 Nginx

执行：

```bash
sudo systemctl restart nginx
sudo systemctl status nginx --no-pager
```

成功时应看到：

- `active (running)`

## 五、准备 PM2 并托管 server.js

### 第 1 步：确认 PM2 是否已安装

```bash
pm2 -v
```

如果提示 `command not found`，执行：

```bash
sudo npm install -g pm2
```

### 第 2 步：启动应用

```bash
pm2 start /root/cloud-store/server.js --name cloud-store
```

### 第 3 步：检查应用状态

```bash
pm2 status
```

成功时应看到：

- `cloud-store` 为 `online`

### 第 4 步：保存 PM2 进程清单

```bash
pm2 save
```

### 第 5 步：如果你希望服务器重启后 PM2 自动拉起

执行：

```bash
pm2 startup
```

终端会打印一条带 `sudo` 的命令。把那条命令完整复制执行一次，然后再执行：

```bash
pm2 save
```

## 六、如果这里就失败了，先看哪里

先看 PM2 日志：

```bash
pm2 logs cloud-store --lines 20
```

如果你想看本地日志文件，再看：

```bash
tail -n 50 /root/cloud-store/logs/app.err.log
```

## 七、这一步完成后的结果

完成本教程后，你的服务器会具备：

- 固定目录结构
- 环境变量文件
- Nginx 配置模板
- PM2 托管的 `cloud-store` 应用进程
- 日志目录和备份目录

这时还没有做域名和 HTTPS，那是下一阶段的事。
