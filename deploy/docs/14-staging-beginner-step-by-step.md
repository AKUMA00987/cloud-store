# 14. staging 小白实操教程

这份教程只服务你现在这套真实情况，不讲抽象概念，直接按当前服务器来。

适用前提：

- 你已经有一台线上服务器
- 正式环境已经在这台服务器上跑着
- 正式域名是 `putiguoguo.com`
- 你准备把测试环境放到同一台服务器上的 `staging.putiguoguo.com`
- production 和 staging 共用同一份代码包，但数据库、上传目录、env、PM2、端口都分开

你现在这套系统，最终应该是这样：

| 项目 | 正式环境 production | 测试环境 staging |
|------|---------------------|------------------|
| 域名 | `putiguoguo.com` | `staging.putiguoguo.com` |
| 目录 | `/root/cloud-store` | `/root/cloud-store-staging` |
| PM2 名称 | `cloud-store` | `cloud-store-staging` |
| Node 端口 | `3000` | `3001` |
| 数据库 | `/root/cloud-store/cloud-store.sqlite` | `/root/cloud-store-staging/cloud-store.sqlite` |
| 上传目录 | `/root/cloud-store/public/uploads` | `/root/cloud-store-staging/public/uploads` |
| env 文件 | `/root/cloud-store/cloud-store.env` | `/root/cloud-store-staging/cloud-store.env` |

## 一、先记住一个最重要的原则

你现在不是要“再装一套新项目”，而是：

1. 继续保留 production
2. 再复制一份同版本代码到 staging
3. 让 staging 跑在 `3001`
4. 用 `staging.putiguoguo.com` 访问它

所以：

- production 不动
- staging 单独搭
- staging 出问题，不应该影响 production

## 二、你这次最容易踩的坑

你前面已经踩到的两个报错，本质上都是“服务器上的发版包不是最新的 Phase 19 包”：

### 报错 1

```bash
cp: cannot stat '/root/cloud-store-staging/deploy/env/cloud-store.staging.env.example': No such file or directory
```

说明：

- 服务器上的 `deploy/env/` 目录还是旧包
- 旧包里没有 `cloud-store.staging.env.example`

### 报错 2

```bash
runtime directories prepared under /root/cloud-store
```

说明：

- 服务器上的 `prepare-runtime-dirs.sh` 还是旧脚本
- 新脚本应该输出：

```text
runtime directories prepared for cloud-store-staging under /root/cloud-store-staging
```

所以你搭 staging 之前，第一件事不是配 Nginx，而是先确认服务器上的 release 包已经是最新版。

## 三、正式开始前的准备清单

### 1. 确认 production 还活着

```bash
pm2 status
sudo systemctl status nginx --no-pager
curl http://127.0.0.1:3000/healthz
```

你要看到：

- `cloud-store` 是 `online`
- `nginx` 是 `active (running)`
- `3000/healthz` 能返回 JSON

### 2. 确认 staging 子域名已经解析到这台服务器

域名控制台需要添加：

- 主机记录：`staging`
- 记录类型：`A`
- 记录值：你的 ECS 公网 IP

### 3. 确认你上传的是新版 release 包

假设最新发版包在：

```text
/root/cloud-store-release
```

执行：

```bash
ls /root/cloud-store-release/deploy/env
ls /root/cloud-store-release/deploy/nginx
ls /root/cloud-store-release/deploy/scripts
```

至少要看到：

- `cloud-store.staging.env.example`
- `cloud-store-staging.conf.example`
- `prepare-runtime-dirs.sh`
- `reset-staging-data.sh`
- `reset-staging-data.js`

再执行：

```bash
grep -n "runtime directories prepared for" /root/cloud-store-release/deploy/scripts/prepare-runtime-dirs.sh
```

如果这些都没有，先重新上传新版包，不要继续。

## 四、第一阶段：先把 staging 用 HTTP 跑起来

注意：

- 这一步先不要急着配 HTTPS
- 先让 `http://staging.putiguoguo.com` 跑通
- 等 HTTP 正常后，再上 HTTPS

### 第 1 步：创建 staging 目录

```bash
sudo mkdir -p /root/cloud-store-staging
sudo cp -R /root/cloud-store-release/* /root/cloud-store-staging/
```

检查：

```bash
ls /root/cloud-store-staging/deploy/env
ls /root/cloud-store-staging/deploy/nginx
```

### 第 1.5 步：补齐 staging 依赖

这一步很重要。

当前 `cloud-store-release` 只包含：

- `server.js`
- `public/`
- `package.json`
- `package-lock.json`
- `deploy/`

它**不包含** `node_modules`。

所以如果你是第一次把一个全新的 `/root/cloud-store-staging` 跑起来，必须额外补依赖，不然 `pm2` 很容易直接报 `errored`。

最稳妥的做法，是先直接复用 production 已经跑通的依赖：

```bash
sudo cp -R /root/cloud-store/node_modules /root/cloud-store-staging/
```

复制完后检查：

```bash
ls /root/cloud-store-staging/node_modules/express
ls /root/cloud-store-staging/node_modules/sqlite3
```

如果你不想复制，也可以改成在 staging 目录重新安装：

```bash
cd /root/cloud-store-staging
npm ci --omit=dev
```

但对你现在这台已经跑着 production 的机器来说，直接复制 production 的 `node_modules` 更省事。

### 第 2 步：准备 staging 运行目录

```bash
cd /root/cloud-store-staging
sudo BASE_DIR=/root/cloud-store-staging SITE_SLUG=cloud-store-staging bash deploy/scripts/prepare-runtime-dirs.sh
```

正确输出应该类似：

```text
runtime directories prepared for cloud-store-staging under /root/cloud-store-staging
```

### 第 3 步：复制 staging env 文件

```bash
cp /root/cloud-store-staging/deploy/env/cloud-store.staging.env.example /root/cloud-store-staging/cloud-store.env
nano /root/cloud-store-staging/cloud-store.env
```

至少先改成下面这些值：

```env
NODE_ENV=production
HOST=127.0.0.1
PORT=3001

CLOUD_STORE_RUNTIME_ENV=staging
CLOUD_STORE_RUNTIME_LABEL=测试环境 / staging
CLOUD_STORE_PUBLIC_BASE_URL=http://staging.putiguoguo.com

CLOUD_STORE_DB_PATH=/root/cloud-store-staging/cloud-store.sqlite
CLOUD_STORE_UPLOAD_ROOT=/root/cloud-store-staging/public/uploads

CS_ADMIN_BOOTSTRAP_PASSWORD=请改成你自己的强密码

CS_SMS_PROVIDER=aliyun
CS_SMS_DEBUG_CODES=false

CS_ENABLE_LOCAL_MOCK_PAYMENT=false
ALIPAY_ENABLED=false
WECHAT_PAY_ENABLED=false
```

### 第 4 步：先启动 staging 的 Node 服务

```bash
cd /root/cloud-store-staging
set -a
source /root/cloud-store-staging/cloud-store.env
set +a
pm2 start /root/cloud-store-staging/server.js --name cloud-store-staging --update-env
pm2 save
pm2 status
```

如果这里显示：

- `cloud-store-staging` 是 `errored`

先不要继续下一步，马上执行：

```bash
pm2 logs cloud-store-staging --lines 80
```

第一次搭 staging 时，最常见的报错就是：

- `Cannot find module 'express'`
- `Cannot find module 'sqlite3'`

如果你看到这类报错，回到上面的“第 1.5 步：补齐 staging 依赖”。

### 第 5 步：先只测本机 3001

```bash
curl http://127.0.0.1:3001/healthz
curl http://127.0.0.1:3001/api/runtime-meta
```

你要重点看：

- `env` 是 `staging`
- `label` 是 `测试环境 / staging`
- `isStaging` 是 `true`
- `port` 是 `3001`

如果这里不通，先看：

```bash
pm2 logs cloud-store-staging --lines 50
```

## 五、第二阶段：给 staging 配 HTTP 版 Nginx

目标是先让浏览器可以打开：

```text
http://staging.putiguoguo.com
```

### 第 1 步：写一份 HTTP 版 staging 配置

```bash
sudo nano /etc/nginx/sites-available/cloud-store-staging.conf
```

把下面这份完整粘进去：

```nginx
server {
    listen 80;
    server_name staging.putiguoguo.com;

    client_max_body_size 12m;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_read_timeout 60s;
        proxy_connect_timeout 10s;
    }

    location /healthz {
        proxy_pass http://127.0.0.1:3001/healthz;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 第 2 步：启用 staging 配置

```bash
sudo ln -sf /etc/nginx/sites-available/cloud-store-staging.conf /etc/nginx/sites-enabled/cloud-store-staging.conf
sudo nginx -t
sudo systemctl restart nginx
```

### 第 3 步：测试 HTTP

```bash
curl -I http://staging.putiguoguo.com
curl http://staging.putiguoguo.com/healthz
```

浏览器打开：

```text
http://staging.putiguoguo.com
```

你要看到：

1. 页面能打开
2. 页面顶部有“测试环境 / staging”
3. 不影响 `putiguoguo.com`

## 六、第三阶段：确认 staging 和 production 真的分开了

执行：

```bash
pm2 status
curl http://127.0.0.1:3000/healthz
curl http://127.0.0.1:3001/healthz
ls /root/cloud-store/cloud-store.sqlite
ls /root/cloud-store-staging/cloud-store.sqlite
```

你应该能区分：

- `3000` 是 production
- `3001` 是 staging
- 两个 sqlite 路径不同

## 七、第四阶段：给 staging 补 HTTPS

只有在下面两件事都成立后，才开始这一步：

1. `http://staging.putiguoguo.com` 已经能正常打开
2. `http://127.0.0.1:3001/healthz` 也正常

### 第 1 步：申请 staging 子域名证书

```bash
sudo certbot --nginx -d staging.putiguoguo.com
```

成功后，通常会得到：

```text
/etc/letsencrypt/live/staging.putiguoguo.com/fullchain.pem
/etc/letsencrypt/live/staging.putiguoguo.com/privkey.pem
```

### 第 2 步：把 staging conf 改成 HTTPS 版

```bash
sudo nano /etc/nginx/sites-available/cloud-store-staging.conf
```

改成下面这份：

```nginx
server {
    listen 80;
    server_name staging.putiguoguo.com;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    return 301 https://staging.putiguoguo.com$request_uri;
}

server {
    listen 443 ssl http2;
    server_name staging.putiguoguo.com;

    ssl_certificate     /etc/letsencrypt/live/staging.putiguoguo.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/staging.putiguoguo.com/privkey.pem;

    client_max_body_size 12m;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_read_timeout 60s;
        proxy_connect_timeout 10s;
    }

    location /healthz {
        proxy_pass http://127.0.0.1:3001/healthz;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

然后执行：

```bash
sudo nginx -t
sudo systemctl restart nginx
```

### 第 3 步：把 staging env 改回 HTTPS

```bash
nano /root/cloud-store-staging/cloud-store.env
```

至少把这些值改回：

```env
CLOUD_STORE_PUBLIC_BASE_URL=https://staging.putiguoguo.com
ALIPAY_RETURN_URL=https://staging.putiguoguo.com/#/paymentResult
ALIPAY_NOTIFY_URL=https://staging.putiguoguo.com/api/payments/alipay/notify
WECHAT_PAY_NOTIFY_URL=https://staging.putiguoguo.com/api/payments/wechat/notify
WECHAT_PAY_INAPP_RETURN_URL=https://staging.putiguoguo.com/#/paymentResult
WECHAT_PAY_EXTERNAL_RETURN_URL=https://staging.putiguoguo.com/#/paymentResult
```

改完后：

```bash
pm2 restart cloud-store-staging --update-env
```

## 八、如果你看到 `ERR_CONNECTION_CLOSED`，代表什么

这不算“HTTPS 已经好了”。

这通常说明：

- 浏览器已经尝试连 `https://staging.putiguoguo.com`
- 但是服务器 443 这条链路没有正常接住

常见原因有：

1. `443` 的 Nginx 配置没写好
2. 证书路径写错
3. staging 证书还没申请成功
4. `nginx -t` 实际上没通过
5. Nginx 没有正确重启
6. 安全组没有放行 `443`

这时执行：

```bash
sudo nginx -t
sudo systemctl status nginx --no-pager
sudo ss -lntp | grep 443
sudo tail -n 50 /var/log/nginx/error.log
sudo grep -R "staging.putiguoguo.com" /etc/nginx/sites-available /etc/nginx/sites-enabled
```

## 九、你这套系统最推荐的首次落地顺序

1. 先确认 production 正常
2. 先确认新版 release 包已上传
3. 复制 release 到 `/root/cloud-store-staging`
4. 跑 `prepare-runtime-dirs.sh`
5. 写 `/root/cloud-store-staging/cloud-store.env`
6. 启动 `cloud-store-staging`
7. 先确认 `127.0.0.1:3001/healthz` 正常
8. 先配 HTTP 版 staging nginx
9. 先确认 `http://staging.putiguoguo.com` 正常
10. 再配证书和 HTTPS
11. 再把 env 中 `http://` 改回 `https://`
12. 最后再开始短信 / 支付 / 微信联调

## 十、staging 第一次跑起来后马上做什么

当 staging 网站已经能正常打开后，建议立刻做一次“最小测试基线重建”：

```bash
cd /root/cloud-store-staging
sudo BASE_DIR=/root/cloud-store-staging APP_NAME=cloud-store-staging APP_PORT=3001 bash /root/cloud-store-staging/deploy/scripts/reset-staging-data.sh
```

## 十一、完成后的验收标准

你做到下面这些，才算 staging 真正搭好了：

1. `putiguoguo.com` 还能正常访问
2. `staging.putiguoguo.com` 也能正常访问
3. production 走 `3000`
4. staging 走 `3001`
5. `pm2 status` 里同时有 `cloud-store` 和 `cloud-store-staging`
6. staging 页面能看到“测试环境 / staging”
7. staging 数据库和 production 数据库路径不同
8. staging 上传目录和 production 上传目录路径不同

## 十二、你下一次卡住时，优先把这几条结果贴出来

```bash
pm2 status
curl http://127.0.0.1:3001/healthz
sudo nginx -t
sudo systemctl status nginx --no-pager
sudo ss -lntp | grep 443
sudo tail -n 50 /var/log/nginx/error.log
cat /root/cloud-store-staging/cloud-store.env
cat /etc/nginx/sites-available/cloud-store-staging.conf
```

注意：

- 如果 `cloud-store.env` 里有密钥，发给我前先把密钥值打码
- 只保留变量名即可，不要泄露真实私钥
