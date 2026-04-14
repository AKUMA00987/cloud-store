# 15. 双环境正式版与测试版统一操作手册

这份文档的目标很简单：

以后你只看这一份，就能完成下面这些事：

1. 搭建 `staging`
2. 给 `staging` 发版
3. 给 `production` 发版
4. 配置短信
5. 配置支付宝
6. 配置微信支付
7. 做健康检查
8. 做回滚
9. 做首次数据初始化

这份文档完全按你现在这台服务器的真实情况写，不按抽象教程写。

---

## 一、先记住这套系统到底长什么样

你现在不是两套服务器，而是：

- 同一台 ECS
- 同一份 release 包
- 两套独立运行环境

### 当前固定结构

| 项目 | 正式环境 production | 测试环境 staging |
|------|---------------------|------------------|
| 用途 | 正式访问、正式支付 | 线上测试、联调、验收 |
| 域名 | `https://putiguoguo.com` | `https://staging.putiguoguo.com` |
| 项目目录 | `/root/cloud-store` | `/root/cloud-store-staging` |
| PM2 名称 | `cloud-store` | `cloud-store-staging` |
| Node 端口 | `3000` | `3001` |
| 数据库 | `/root/cloud-store/cloud-store.sqlite` | `/root/cloud-store-staging/cloud-store.sqlite` |
| 上传目录 | `/root/cloud-store/public/uploads` | `/root/cloud-store-staging/public/uploads` |
| env 文件 | `/root/cloud-store/cloud-store.env` | `/root/cloud-store-staging/cloud-store.env` |

### 最重要的原则

- `staging` 和 `production` 共用同一份代码包
- `staging` 和 `production` 不能共用数据库
- `staging` 和 `production` 不能共用 uploads
- `staging` 和 `production` 不能共用 env 文件
- `staging` 和 `production` 不能共用 PM2 名称
- `staging` 和 `production` 不能共用回调地址

你以后所有新功能都按这个顺序走：

1. 本地做好代码
2. 整理一份 `cloud-store-release`
3. 先发到 `staging`
4. 在 `staging` 验证
5. 验证通过后，再把同一份包发到 `production`

---

## 二、你以后真正只需要记住的 3 个目录

### 1. 代码发版包目录

```text
/root/cloud-store-release
```

这是唯一一份要上传到服务器的代码包。

### 2. production 目录

```text
/root/cloud-store
```

### 3. staging 目录

```text
/root/cloud-store-staging
```

---

## 三、先理解“发版包”和“运行目录”的区别

### 发版包 `cloud-store-release` 里应该有什么

- `server.js`
- `package.json`
- `package-lock.json`
- `public/`
- `deploy/`

### 发版包里不应该有什么

- `cloud-store.sqlite`
- `public/uploads`
- `cloud-store.env`
- `logs`
- `backups`

### 特别注意：首次搭环境时还要补 `node_modules`

当前 `cloud-store-release` 不包含 `node_modules`。

所以如果你是第一次把一个全新的目录跑起来，比如第一次搭 `/root/cloud-store-staging`，还要额外补依赖。

最省事的方法是直接复制 production 的依赖：

```bash
sudo cp -R /root/cloud-store/node_modules /root/cloud-store-staging/
```

---

## 四、以后每次操作前都先看这张表

| 你要操作的环境 | 当前目录 | PM2 名称 | 端口 | 域名 |
|----------------|----------|----------|------|------|
| `production` | `/root/cloud-store` | `cloud-store` | `3000` | `putiguoguo.com` |
| `staging` | `/root/cloud-store-staging` | `cloud-store-staging` | `3001` | `staging.putiguoguo.com` |

你每次动手前，都先问自己：

1. 我现在改的是哪套环境
2. 我现在所在目录对不对
3. 我现在重启的 PM2 名称对不对
4. 我现在的域名和回调是不是写对环境了

---

## 五、第一次搭建 staging 的完整步骤

如果你已经搭过了，这一节以后可以跳过。

### 第 1 步：确认 production 正常

```bash
pm2 status
sudo systemctl status nginx --no-pager
curl http://127.0.0.1:3000/healthz
```

### 第 2 步：确认 DNS 已经指向当前服务器

域名控制台里要有一条：

- 主机记录：`staging`
- 记录类型：`A`
- 记录值：你的 ECS 公网 IP

### 第 3 步：把最新 release 包放到服务器

保证服务器上有：

```text
/root/cloud-store-release
```

并检查：

```bash
ls /root/cloud-store-release/deploy/env
ls /root/cloud-store-release/deploy/nginx
ls /root/cloud-store-release/deploy/scripts
```

### 第 4 步：创建 staging 目录

```bash
sudo mkdir -p /root/cloud-store-staging
sudo cp -R /root/cloud-store-release/* /root/cloud-store-staging/
```

### 第 5 步：补齐 staging 依赖

```bash
sudo cp -R /root/cloud-store/node_modules /root/cloud-store-staging/
```

### 第 6 步：准备运行目录

```bash
cd /root/cloud-store-staging
sudo BASE_DIR=/root/cloud-store-staging SITE_SLUG=cloud-store-staging bash deploy/scripts/prepare-runtime-dirs.sh
```

### 第 7 步：复制 env

```bash
cp /root/cloud-store-staging/deploy/env/cloud-store.staging.env.example /root/cloud-store-staging/cloud-store.env
nano /root/cloud-store-staging/cloud-store.env
```

至少先填这些：

```env
NODE_ENV=production
HOST=127.0.0.1
PORT=3001
CLOUD_STORE_RUNTIME_ENV=staging
CLOUD_STORE_RUNTIME_LABEL=测试环境 / staging
CLOUD_STORE_PUBLIC_BASE_URL=http://staging.putiguoguo.com
CLOUD_STORE_DB_PATH=/root/cloud-store-staging/cloud-store.sqlite
CLOUD_STORE_UPLOAD_ROOT=/root/cloud-store-staging/public/uploads
CS_ADMIN_BOOTSTRAP_PASSWORD=请改成强密码
CS_SMS_PROVIDER=aliyun
CS_SMS_DEBUG_CODES=false
CS_ENABLE_LOCAL_MOCK_PAYMENT=false
ALIPAY_ENABLED=false
WECHAT_PAY_ENABLED=false
```

### 第 8 步：启动 staging

```bash
cd /root/cloud-store-staging
set -a
source /root/cloud-store-staging/cloud-store.env
set +a
pm2 start /root/cloud-store-staging/server.js --name cloud-store-staging --update-env
pm2 save
pm2 status
```

### 第 9 步：先测本机 3001

```bash
curl http://127.0.0.1:3001/healthz
curl http://127.0.0.1:3001/api/runtime-meta
```

如果这里不通，先看：

```bash
pm2 logs cloud-store-staging --lines 80
```

### 第 10 步：配置 staging 的 HTTP Nginx

文件位置：

```text
/etc/nginx/sites-available/cloud-store-staging.conf
```

内容先用 HTTP 版：

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

启用并重载：

```bash
sudo ln -sf /etc/nginx/sites-available/cloud-store-staging.conf /etc/nginx/sites-enabled/cloud-store-staging.conf
sudo nginx -t
sudo systemctl restart nginx
```

### 第 11 步：先确认 HTTP 通

```bash
curl -I http://staging.putiguoguo.com
curl http://staging.putiguoguo.com/healthz
```

### 第 12 步：再补 HTTPS

```bash
sudo certbot --nginx -d staging.putiguoguo.com
```

然后把 Nginx 改成 HTTPS 版，再执行：

```bash
sudo nginx -t
sudo systemctl restart nginx
```

最后把 env 里的公网地址改回 HTTPS：

```env
CLOUD_STORE_PUBLIC_BASE_URL=https://staging.putiguoguo.com
```

然后重启：

```bash
pm2 restart cloud-store-staging --update-env
```

### 第 13 步：重建 staging 最小测试基线

```bash
cd /root/cloud-store-staging
sudo BASE_DIR=/root/cloud-store-staging APP_NAME=cloud-store-staging APP_PORT=3001 bash /root/cloud-store-staging/deploy/scripts/reset-staging-data.sh
```

---

## 六、以后 staging 常规发版步骤

这是你以后最常用的流程。

### 第 1 步：确认 staging 当前健康

```bash
pm2 status
APP_PORT=3001 PUBLIC_URL=https://staging.putiguoguo.com/healthz bash /root/cloud-store-staging/deploy/scripts/check-health.sh
```

### 第 2 步：执行 staging 发版

```bash
cd /root/cloud-store-staging
sudo BASE_DIR=/root/cloud-store-staging PM2_APP_NAME=cloud-store-staging bash /root/cloud-store-staging/deploy/scripts/deploy-release-pm2.sh /root/cloud-store-release
```

### 第 3 步：发版后健康检查

```bash
APP_PORT=3001 PUBLIC_URL=https://staging.putiguoguo.com/healthz bash /root/cloud-store-staging/deploy/scripts/check-health.sh
```

### 第 4 步：看日志

```bash
pm2 logs cloud-store-staging --lines 50
```

### 第 5 步：做业务验证

至少验证：

1. 手机号验证码登录
2. 手机号密码登录
3. 支付宝支付
4. 微信支付
5. 下单结果页
6. 订单状态变化

---

## 七、以后 production 常规发版步骤

只有在 staging 已验证通过后，才做这一步。

### 第 1 步：确认 production 当前健康

```bash
pm2 status
bash /root/cloud-store/deploy/scripts/check-health.sh
```

### 第 2 步：执行 production 发版

```bash
cd /root/cloud-store
sudo BASE_DIR=/root/cloud-store PM2_APP_NAME=cloud-store bash /root/cloud-store/deploy/scripts/deploy-release-pm2.sh /root/cloud-store-release
```

### 第 3 步：发版后健康检查

```bash
bash /root/cloud-store/deploy/scripts/check-health.sh
```

### 第 4 步：看日志

```bash
pm2 logs cloud-store --lines 50
```

---

## 八、短信配置：staging 和 production 怎么分别配

### 1. 先记住原则

- `staging` 先接真实阿里云
- `production` 再接真实阿里云
- 两边都不要长期保留 `mock`

### 2. staging 要改哪个文件

```bash
nano /root/cloud-store-staging/cloud-store.env
```

至少填：

```env
CS_SMS_PROVIDER=aliyun
CS_SMS_DEBUG_CODES=false
ALIYUN_SMS_ACCESS_KEY_ID=你的AccessKeyId
ALIYUN_SMS_ACCESS_KEY_SECRET=你的AccessKeySecret
ALIYUN_SMS_SIGN_NAME=你的赠送签名
ALIYUN_SMS_TEMPLATE_CODE=你的赠送模板编号
ALIYUN_SMS_TEMPLATE_CODE_BIND_PHONE=绑定手机号模板编号
ALIYUN_SMS_TEMPLATE_CODE_LOGIN_OR_REGISTER=登录注册模板编号
ALIYUN_SMS_TEMPLATE_CODE_RESET_PASSWORD=找回密码模板编号
```

重启：

```bash
pm2 restart cloud-store-staging --update-env
```

### 3. production 要改哪个文件

```bash
nano /root/cloud-store/cloud-store.env
```

填法与 staging 相同，然后：

```bash
pm2 restart cloud-store --update-env
```

### 4. 短信验收顺序

先在 staging 验：

1. 新手机号验证码登录
2. 老手机号验证码登录
3. 首次设密
4. 忘记密码

全部通过后，再上 production。

---

## 九、支付宝配置：staging 和 production 怎么分别配

### 1. 先记住原则

- 先 staging
- 再 production
- 回调地址不能混

### 2. staging 支付宝 env

文件：

```bash
nano /root/cloud-store-staging/cloud-store.env
```

至少填：

```env
ALIPAY_ENABLED=true
ALIPAY_APP_ID=你的AppID
ALIPAY_PRIVATE_KEY=你的商户私钥
ALIPAY_PUBLIC_KEY=支付宝公钥
ALIPAY_SELLER_ID=你的商户PID
CLOUD_STORE_PUBLIC_BASE_URL=https://staging.putiguoguo.com
ALIPAY_RETURN_URL=https://staging.putiguoguo.com/#/paymentResult
ALIPAY_NOTIFY_URL=https://staging.putiguoguo.com/api/payments/alipay/notify
```

重启：

```bash
pm2 restart cloud-store-staging --update-env
```

### 3. production 支付宝 env

文件：

```bash
nano /root/cloud-store/cloud-store.env
```

至少填：

```env
ALIPAY_ENABLED=true
ALIPAY_APP_ID=你的AppID
ALIPAY_PRIVATE_KEY=你的商户私钥
ALIPAY_PUBLIC_KEY=支付宝公钥
ALIPAY_SELLER_ID=你的商户PID
CLOUD_STORE_PUBLIC_BASE_URL=https://putiguoguo.com
ALIPAY_RETURN_URL=https://putiguoguo.com/#/paymentResult
ALIPAY_NOTIFY_URL=https://putiguoguo.com/api/payments/alipay/notify
```

重启：

```bash
pm2 restart cloud-store --update-env
```

### 4. 支付宝验收顺序

先在 staging 验：

1. 创建待支付订单
2. 能跳到支付宝收银台
3. 回跳结果页正常
4. 异步通知到达后订单变成“待发货”

通过后，再配 production。

---

## 十、微信支付配置：staging 和 production 怎么分别配

### 1. 先记住原则

- 先 staging
- 先把微信白名单和回调跑通
- 再 production

### 2. staging 微信 env

文件：

```bash
nano /root/cloud-store-staging/cloud-store.env
```

至少填：

```env
WECHAT_PAY_ENABLED=true
WECHAT_PAY_APP_ID=你的微信应用ID
WECHAT_PAY_MCH_ID=你的微信商户号
WECHAT_PAY_API_V3_KEY=你的APIv3Key
WECHAT_PAY_PRIVATE_KEY=你的商户私钥
WECHAT_PAY_CERT_SERIAL_NO=你的证书序列号
CLOUD_STORE_PUBLIC_BASE_URL=https://staging.putiguoguo.com
WECHAT_PAY_NOTIFY_URL=https://staging.putiguoguo.com/api/payments/wechat/notify
WECHAT_PAY_INAPP_RETURN_URL=https://staging.putiguoguo.com/#/paymentResult
WECHAT_PAY_EXTERNAL_RETURN_URL=https://staging.putiguoguo.com/#/paymentResult
```

重启：

```bash
pm2 restart cloud-store-staging --update-env
```

### 3. production 微信 env

文件：

```bash
nano /root/cloud-store/cloud-store.env
```

至少填：

```env
WECHAT_PAY_ENABLED=true
WECHAT_PAY_APP_ID=你的微信应用ID
WECHAT_PAY_MCH_ID=你的微信商户号
WECHAT_PAY_API_V3_KEY=你的APIv3Key
WECHAT_PAY_PRIVATE_KEY=你的商户私钥
WECHAT_PAY_CERT_SERIAL_NO=你的证书序列号
CLOUD_STORE_PUBLIC_BASE_URL=https://putiguoguo.com
WECHAT_PAY_NOTIFY_URL=https://putiguoguo.com/api/payments/wechat/notify
WECHAT_PAY_INAPP_RETURN_URL=https://putiguoguo.com/#/paymentResult
WECHAT_PAY_EXTERNAL_RETURN_URL=https://putiguoguo.com/#/paymentResult
```

重启：

```bash
pm2 restart cloud-store --update-env
```

### 4. 微信支付验收顺序

先在 staging 验：

1. 微信外浏览器支付
2. 微信内浏览器支付
3. 回跳结果页
4. 异步通知后订单状态变更

通过后，再配 production。

---

## 十一、staging 和 production 的推荐验收顺序

### 每次新版本发布到 staging 后

你按这个顺序验证：

1. 网站能打开
2. “测试环境 / staging” 标签存在
3. 手机号验证码登录
4. 手机号密码登录
5. 下单
6. 支付宝支付
7. 微信支付
8. 订单状态
9. 管理端查看订单

### staging 验证通过后发布 production

你按这个顺序验证：

1. 站点能打开
2. 登录正常
3. 下单正常
4. 支付宝正常
5. 微信正常
6. 后台订单正常

---

## 十二、清库、回滚怎么做

### 1. staging 清库

```bash
cd /root/cloud-store-staging
sudo BASE_DIR=/root/cloud-store-staging APP_NAME=cloud-store-staging APP_PORT=3001 bash /root/cloud-store-staging/deploy/scripts/reset-staging-data.sh
```

### 2. staging 回滚

```bash
cd /root/cloud-store-staging
sudo BASE_DIR=/root/cloud-store-staging PM2_APP_NAME=cloud-store-staging bash /root/cloud-store-staging/deploy/scripts/rollback-release-pm2.sh /root/cloud-store-staging/backups/manual/你的备份目录
```

### 3. production 回滚

```bash
cd /root/cloud-store
sudo BASE_DIR=/root/cloud-store PM2_APP_NAME=cloud-store bash /root/cloud-store/deploy/scripts/rollback-release-pm2.sh /root/cloud-store/backups/manual/你的备份目录
```

### 4. 回滚后都要做健康检查

```bash
bash /root/cloud-store/deploy/scripts/check-health.sh
APP_PORT=3001 PUBLIC_URL=https://staging.putiguoguo.com/healthz bash /root/cloud-store-staging/deploy/scripts/check-health.sh
```

---

## 十三、首次数据初始化怎么做

这里一定要分清楚：

- `staging` 的初始化，目的是做“干净测试基线”
- `production` 的初始化，目的是做“正式上线前清空测试数据”

这两个脚本**不是同一个东西**，不能混用。

### 1. staging 首次数据初始化

适用场景：

- 刚搭好测试系统
- 之前测过一堆脏数据
- 想把测试库恢复成“可重复联调”的最小基线

执行：

```bash
cd /root/cloud-store-staging
sudo BASE_DIR=/root/cloud-store-staging APP_NAME=cloud-store-staging APP_PORT=3001 bash /root/cloud-store-staging/deploy/scripts/reset-staging-data.sh
```

这一步会：

- 清掉 staging 的测试用户、商品、订单、支付、退款、验证码、Banner、公告
- 保留 / 重建 `admin`
- 重建测试买家
- 重建样品商品、分类、优惠券

跑完后，你通常会得到两组测试账号：

- 密码买家：`13800000001 / Test@123456`
- 验证码买家：`13800000002`

这一步适合：

- 短信联调
- 支付宝联调
- 微信支付联调
- 物流联调
- 页面验收

### 2. production 首次数据初始化

适用场景：

- staging 已经全部联调通过
- 你准备正式对外上线
- 你要清掉测试期遗留的商品、订单、用户、Banner、公告等数据
- 但必须保留 `admin`

执行：

```bash
cd /root/cloud-store
sudo bash /root/cloud-store/deploy/scripts/reset-launch-data.sh
```

你会被要求手动输入：

```text
RESET_LAUNCH_DATA
```

这一步会：

- 清掉 production 的测试期商品、Banner、公告、优惠券模板
- 清掉订单、支付、退款、购物车、会话和所有非 `admin` 用户
- 保留 `admin`
- 保留商品分类
- 保留 `public/uploads`
- 写入 `.disable-default-seed`，防止默认演示数据自动补回来

### 3. staging 初始化和 production 初始化的区别

| 项目 | staging 初始化 | production 初始化 |
|------|----------------|-------------------|
| 脚本 | `reset-staging-data.sh` | `reset-launch-data.sh` |
| 目的 | 重建测试基线 | 正式上线前清空测试数据 |
| 是否保留测试买家 | 会重建 | 不保留 |
| 是否保留样品商品 | 会重建 | 不保留 |
| 是否保留分类 | 保留 / 重建 | 保留 |
| 是否保留 admin | 保留 | 保留 |
| 是否用于正式对外上线 | 否 | 是 |

### 4. 你以后应该怎么选

如果你现在是在做测试：

- 用 `reset-staging-data.sh`

如果你现在准备正式上线：

- 用 `reset-launch-data.sh`

### 5. 最安全的推荐顺序

以后首次正式上线，推荐按这个顺序：

1. 先在 staging 验完整条链路
2. 必要时反复重置 staging 测试基线
3. staging 验证通过
4. 用同一份 release 发到 production
5. 在 production 执行 `reset-launch-data.sh`
6. 用 `admin` 登录后台
7. 手动录入正式商品、Banner、公告和运营配置
8. 再对外开放

---

## 十四、最常见的错误

### 1. 把 staging 的回调地址写进 production

会导致：

- 支付回调串环境
- 结果页串环境

### 2. 把 production 的域名写进 staging

会导致：

- staging 看起来能跳支付
- 但通知打到正式环境

### 3. 改完 env 没重启 PM2

改 env 后必须：

```bash
pm2 restart cloud-store-staging --update-env
pm2 restart cloud-store --update-env
```

### 4. 第一次搭 staging 忘了补 `node_modules`

会导致：

- `Cannot find module 'express'`
- `Cannot find module 'sqlite3'`

### 5. 两套环境共用一个 sqlite

这会直接破坏测试系统的意义。

### 6. 还没打通 HTTP 就急着上 HTTPS

正确顺序应该是：

1. 先本机 `3001`
2. 再域名 HTTP
3. 再域名 HTTPS

---

## 十五、你以后最推荐的固定工作流

以后每次做新版本，都固定按这个节奏：

1. 本地改好代码
2. 重新整理 `cloud-store-release`
3. 上传到服务器
4. 发到 `staging`
5. 在 `staging` 做登录、短信、支付宝、微信、订单验证
6. 验证通过后，再发到 `production`

---

## 十六、你以后最常用的一组命令

### 查看进程

```bash
pm2 status
```

### 看 staging 日志

```bash
pm2 logs cloud-store-staging --lines 50
```

### 看 production 日志

```bash
pm2 logs cloud-store --lines 50
```

### 检查 Nginx

```bash
sudo nginx -t
sudo systemctl status nginx --no-pager
```

### 检查 staging 本机

```bash
curl http://127.0.0.1:3001/healthz
curl http://127.0.0.1:3001/api/runtime-meta
```

### 检查 production 本机

```bash
curl http://127.0.0.1:3000/healthz
```

### 检查 staging 公网

```bash
curl -I https://staging.putiguoguo.com
curl https://staging.putiguoguo.com/healthz
```

### 检查 production 公网

```bash
curl -I https://putiguoguo.com
curl https://putiguoguo.com/healthz
```

---

## 十七、最后一句最重要的话

以后你就把这份文档理解成：

**双环境总控操作台账**

你不需要再自己去记：

- 哪个脚本给 staging 用
- 哪个 env 给 production 用
- 短信先配哪边
- 支付宝先配哪边
- 微信先配哪边

统一答案就是：

1. 先 `staging`
2. 验证通过
3. 再 `production`
4. 同一份 release 包
5. 两套独立数据
