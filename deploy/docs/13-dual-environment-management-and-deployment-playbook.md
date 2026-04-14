# 13. 双环境管理与部署总教程

这份教程把你现在项目的双环境体系一次讲清楚。

适用对象：

- 不想记很多零散命令
- 想知道 production 和 staging 到底怎么分
- 想按固定步骤完成搭建、发版、清库、回滚、联调

---

## 一、先理解这套双环境到底是什么

你现在的目标不是“再买一台测试服务器”，而是：

- 在同一台 ECS 上保留一套正式环境
- 再搭一套独立的线上测试环境

这两套环境：

- 共用同一份代码包
- 不共用数据库
- 不共用 uploads
- 不共用 env 文件
- 不共用 PM2 应用名
- 不共用 Nginx 域名入口

### 最终结构

| 项目 | production | staging |
|------|------------|---------|
| 用途 | 正式访问、正式收单 | 联调、验收、测试系统 |
| Base Dir | `/root/cloud-store` | `/root/cloud-store-staging` |
| PM2 App | `cloud-store` | `cloud-store-staging` |
| Node 端口 | `3000` | `3001` |
| 数据库 | `/root/cloud-store/cloud-store.sqlite` | `/root/cloud-store-staging/cloud-store.sqlite` |
| 图片目录 | `/root/cloud-store/public/uploads` | `/root/cloud-store-staging/public/uploads` |
| Env 文件 | `/root/cloud-store/cloud-store.env` | `/root/cloud-store-staging/cloud-store.env` |
| 域名 | `https://putiguoguo.com` | `https://staging.你的域名` |

---

## 二、你以后操作时的总原则

### 1. 先 staging，后 production

以后这些动作默认都先在 staging 做：

- 手机号登录 / 注册联调
- 短信验证码联调
- 支付宝联调
- 微信支付联调
- 物流联调
- 页面验收

只有 staging 通过后，才进入 production。

### 2. release 包只有一份

你继续只维护一份：

```text
/root/cloud-store-release
```

这份包既可以发给 production，也可以发给 staging。

### 3. staging 必须显式标识为测试环境

现在代码已经支持：

- 页面显示“测试环境 / staging”
- 返回 `X-Robots-Tag: noindex, nofollow, noarchive`

所以 staging 不再是“看起来像正式站，只是换了个地址”。

### 4. production 不再承担测试职责

一旦双环境搭好，production 只做：

- 正式访问
- 正式下单
- 正式收款

不要再回 production 上做首轮联调。

---

## 三、你要先准备哪些文件

这套双环境主要依赖下面这些文件：

### 模板和脚本

- [root/deploy/README.md](/d:/Docker/openclaw_daily/workspace/Daily_Workspace/cloud-store/root/deploy/README.md)
- [root/deploy/env/cloud-store.env.example](/d:/Docker/openclaw_daily/workspace/Daily_Workspace/cloud-store/root/deploy/env/cloud-store.env.example)
- [root/deploy/env/cloud-store.staging.env.example](/d:/Docker/openclaw_daily/workspace/Daily_Workspace/cloud-store/root/deploy/env/cloud-store.staging.env.example)
- [root/deploy/nginx/cloud-store-staging.conf.example](/d:/Docker/openclaw_daily/workspace/Daily_Workspace/cloud-store/root/deploy/nginx/cloud-store-staging.conf.example)
- [root/deploy/scripts/check-health.sh](/d:/Docker/openclaw_daily/workspace/Daily_Workspace/cloud-store/root/deploy/scripts/check-health.sh)
- [root/deploy/scripts/deploy-release-pm2.sh](/d:/Docker/openclaw_daily/workspace/Daily_Workspace/cloud-store/root/deploy/scripts/deploy-release-pm2.sh)
- [root/deploy/scripts/rollback-release-pm2.sh](/d:/Docker/openclaw_daily/workspace/Daily_Workspace/cloud-store/root/deploy/scripts/rollback-release-pm2.sh)
- [root/deploy/scripts/reset-staging-data.sh](/d:/Docker/openclaw_daily/workspace/Daily_Workspace/cloud-store/root/deploy/scripts/reset-staging-data.sh)

### 分步教程

- [11-online-staging-environment-playbook.md](/d:/Docker/openclaw_daily/workspace/Daily_Workspace/cloud-store/root/deploy/docs/11-online-staging-environment-playbook.md)
- [12-staging-release-reset-rollback-playbook.md](/d:/Docker/openclaw_daily/workspace/Daily_Workspace/cloud-store/root/deploy/docs/12-staging-release-reset-rollback-playbook.md)
- [08-aliyun-sms-account-security-playbook.md](/d:/Docker/openclaw_daily/workspace/Daily_Workspace/cloud-store/root/deploy/docs/08-aliyun-sms-account-security-playbook.md)
- [09-alipay-wap-payment-playbook.md](/d:/Docker/openclaw_daily/workspace/Daily_Workspace/cloud-store/root/deploy/docs/09-alipay-wap-payment-playbook.md)
- [10-wechat-h5-payment-playbook.md](/d:/Docker/openclaw_daily/workspace/Daily_Workspace/cloud-store/root/deploy/docs/10-wechat-h5-payment-playbook.md)

---

## 四、第一次搭好双环境的完整顺序

### 第 1 步：准备 production 现状

先确认 production 本身是健康的：

```bash
cd /root/cloud-store
pm2 status
sudo systemctl status nginx --no-pager
bash /root/cloud-store/deploy/scripts/check-health.sh
```

你要确认：

- `cloud-store` 是 `online`
- `nginx` 是 `active (running)`
- 健康检查通过

### 第 2 步：准备 release 包

把当前最新代码整理成：

```text
/root/cloud-store-release
```

这份包不应包含：

- `cloud-store.sqlite`
- `public/uploads`
- `cloud-store.env`
- `logs`
- `backups`

### 第 3 步：创建 staging 目录

执行：

```bash
sudo mkdir -p /root/cloud-store-staging
sudo cp -R /root/cloud-store-release/* /root/cloud-store-staging/
```

### 第 4 步：准备 staging 运行目录

执行：

```bash
cd /root/cloud-store-staging
sudo bash deploy/scripts/prepare-runtime-dirs.sh
```

### 第 5 步：复制 staging env 模板

执行：

```bash
cp /root/cloud-store-staging/deploy/env/cloud-store.staging.env.example /root/cloud-store-staging/cloud-store.env
nano /root/cloud-store-staging/cloud-store.env
```

至少先确认：

```text
HOST=127.0.0.1
PORT=3001
CLOUD_STORE_RUNTIME_ENV=staging
CLOUD_STORE_RUNTIME_LABEL=测试环境 / staging
CLOUD_STORE_PUBLIC_BASE_URL=https://staging.你的域名
CLOUD_STORE_DB_PATH=/root/cloud-store-staging/cloud-store.sqlite
CLOUD_STORE_UPLOAD_ROOT=/root/cloud-store-staging/public/uploads
```

### 第 6 步：复制 staging Nginx 模板

执行：

```bash
sudo cp /root/cloud-store-staging/deploy/nginx/cloud-store-staging.conf.example /etc/nginx/sites-available/cloud-store-staging.conf
sudo ln -sf /etc/nginx/sites-available/cloud-store-staging.conf /etc/nginx/sites-enabled/cloud-store-staging.conf
```

然后把模板里的：

- 域名
- HTTPS 证书路径

改成你自己的 staging 值。

检查：

```bash
sudo nginx -t
sudo systemctl restart nginx
```

### 第 7 步：启动 staging PM2

执行：

```bash
cd /root/cloud-store-staging
set -a
source /root/cloud-store-staging/cloud-store.env
set +a
pm2 start /root/cloud-store-staging/server.js --name cloud-store-staging --update-env
pm2 save
```

### 第 8 步：确认 staging 真的独立

执行：

```bash
curl http://127.0.0.1:3001/healthz
```

你要确认返回里显示的是 staging。

再浏览器打开 staging，确认：

1. 能访问
2. 页面有“测试环境 / staging”
3. 不是 production 域名

---

## 五、staging 第一次上线后必须做什么

不要直接拿脏数据继续测试。

第一次起好 staging 后，先做最小测试基线重建：

```bash
cd /root/cloud-store-staging
sudo BASE_DIR=/root/cloud-store-staging APP_NAME=cloud-store-staging APP_PORT=3001 bash /root/cloud-store-staging/deploy/scripts/reset-staging-data.sh
```

你会被要求输入：

```text
RESET_STAGING_DATA
```

完成后，staging 会自动重建：

- admin
- 测试用密码买家
- 测试用验证码买家
- 基础分类
- 样品商品
- 优惠券

---

## 六、以后 staging 常规发版怎么做

### 发版命令

```bash
cd /root/cloud-store-staging
sudo BASE_DIR=/root/cloud-store-staging PM2_APP_NAME=cloud-store-staging bash /root/cloud-store-staging/deploy/scripts/deploy-release-pm2.sh /root/cloud-store-release
```

### 发版后健康检查

```bash
APP_PORT=3001 PUBLIC_URL=https://staging.你的域名/healthz bash /root/cloud-store-staging/deploy/scripts/check-health.sh
```

### 发版后看日志

```bash
pm2 logs cloud-store-staging --lines 50
```

---

## 七、以后 production 常规发版怎么做

### 发版命令

```bash
cd /root/cloud-store
sudo BASE_DIR=/root/cloud-store PM2_APP_NAME=cloud-store bash /root/cloud-store/deploy/scripts/deploy-release-pm2.sh /root/cloud-store-release
```

### 发版后健康检查

```bash
bash /root/cloud-store/deploy/scripts/check-health.sh
```

### 发版后看日志

```bash
pm2 logs cloud-store --lines 50
```

---

## 八、以后双环境分别怎么清库

### staging 清库

staging 可以清，而且推荐定期清。

命令：

```bash
cd /root/cloud-store-staging
sudo BASE_DIR=/root/cloud-store-staging APP_NAME=cloud-store-staging APP_PORT=3001 bash /root/cloud-store-staging/deploy/scripts/reset-staging-data.sh
```

### production 清库

production 不是用 `reset-staging-data`。

正式上线前如果需要初始化 production，只看：

- [07-launch-data-reset.md](/d:/Docker/openclaw_daily/workspace/Daily_Workspace/cloud-store/root/deploy/docs/07-launch-data-reset.md)
- `reset-launch-data.sh`

不要把 staging 的 reset 脚本拿去清 production。

---

## 九、以后双环境分别怎么回滚

### staging 回滚

```bash
cd /root/cloud-store-staging
sudo BASE_DIR=/root/cloud-store-staging PM2_APP_NAME=cloud-store-staging bash /root/cloud-store-staging/deploy/scripts/rollback-release-pm2.sh /root/cloud-store-staging/backups/manual/你的备份目录
```

### production 回滚

```bash
cd /root/cloud-store
sudo BASE_DIR=/root/cloud-store PM2_APP_NAME=cloud-store bash /root/cloud-store/deploy/scripts/rollback-release-pm2.sh /root/cloud-store/backups/manual/你的备份目录
```

---

## 十、短信、支付宝、微信到底先配哪边

统一规则：

### 1. 先 staging

先在 staging 完成：

- 阿里云短信
- 支付宝回调
- 微信白名单
- 微信回调

对应教程：

- [08-aliyun-sms-account-security-playbook.md](/d:/Docker/openclaw_daily/workspace/Daily_Workspace/cloud-store/root/deploy/docs/08-aliyun-sms-account-security-playbook.md)
- [09-alipay-wap-payment-playbook.md](/d:/Docker/openclaw_daily/workspace/Daily_Workspace/cloud-store/root/deploy/docs/09-alipay-wap-payment-playbook.md)
- [10-wechat-h5-payment-playbook.md](/d:/Docker/openclaw_daily/workspace/Daily_Workspace/cloud-store/root/deploy/docs/10-wechat-h5-payment-playbook.md)

### 2. 再 production

staging 跑通后，再把域名和 env 切成 production 的值。

### 3. 不允许混用回调

比如：

- staging 支付宝回调必须指向 staging 域名
- production 支付宝回调必须指向 production 域名
- 微信白名单也要分环境核对

---

## 十一、你以后每次操作前都先看这 6 件事

### 如果你现在在操作 staging

你要先确认：

1. 当前目录是 `/root/cloud-store-staging`
2. 当前 PM2 app 是 `cloud-store-staging`
3. 当前端口是 `3001`
4. 当前域名是 `staging.你的域名`
5. 当前数据库路径是 `/root/cloud-store-staging/cloud-store.sqlite`
6. 当前备份目录是 `/root/cloud-store-staging/backups/...`

### 如果你现在在操作 production

你要先确认：

1. 当前目录是 `/root/cloud-store`
2. 当前 PM2 app 是 `cloud-store`
3. 当前端口是 `3000`
4. 当前域名是 `putiguoguo.com`
5. 当前数据库路径是 `/root/cloud-store/cloud-store.sqlite`
6. 当前备份目录是 `/root/cloud-store/backups/...`

---

## 十二、最常见的错误

### 1. 把 staging env 当成 production env

表现：

- production 站点显示“测试环境”
- 回调打到错误域名

### 2. 把 production 回调写进 staging

表现：

- staging 看起来能跳支付
- 但通知和结果串到 production

### 3. 把 staging reset 脚本拿去清 production

这个是高风险错误，必须避免。

### 4. 两套环境共用一个 sqlite

这会直接破坏双环境意义。

### 5. 改完 env 没重启对应 PM2

你改 env 之后必须重启对应环境的 app。

---

## 十三、建议你以后固定这样执行

### 场景 A：开发刚做完一轮新功能

1. 整理 `cloud-store-release`
2. 发到 staging
3. 跑 staging 健康检查
4. 必要时 reset staging
5. 做短信 / 支付 / 物流联调
6. 验收通过后，再发 production

### 场景 B：支付配置刚改完

1. 先改 staging env
2. 重启 staging
3. 跑 staging 联调
4. 成功后再改 production env

### 场景 C：staging 数据很脏

1. 跑 `reset-staging-data.sh`
2. 重新用测试买家验手机号登录 / 支付 / 物流

### 场景 D：发版后 staging 挂了

1. 看 `pm2 logs cloud-store-staging`
2. 跑健康检查
3. 不行就直接 staging 回滚
4. 不要碰 production

---

## 十四、你现在最推荐的入口

如果你准备开始真实双环境落地，建议直接按这三份文档走：

1. 先搭 staging：
   [11-online-staging-environment-playbook.md](/d:/Docker/openclaw_daily/workspace/Daily_Workspace/cloud-store/root/deploy/docs/11-online-staging-environment-playbook.md)
2. 再跑 staging 发版 / 清库 / 回滚：
   [12-staging-release-reset-rollback-playbook.md](/d:/Docker/openclaw_daily/workspace/Daily_Workspace/cloud-store/root/deploy/docs/12-staging-release-reset-rollback-playbook.md)
3. 最后做短信和支付联调：
   [08-aliyun-sms-account-security-playbook.md](/d:/Docker/openclaw_daily/workspace/Daily_Workspace/cloud-store/root/deploy/docs/08-aliyun-sms-account-security-playbook.md)
   [09-alipay-wap-payment-playbook.md](/d:/Docker/openclaw_daily/workspace/Daily_Workspace/cloud-store/root/deploy/docs/09-alipay-wap-payment-playbook.md)
   [10-wechat-h5-payment-playbook.md](/d:/Docker/openclaw_daily/workspace/Daily_Workspace/cloud-store/root/deploy/docs/10-wechat-h5-payment-playbook.md)

如果你愿意，我下一步可以继续直接帮你写一份“服务器实操版命令清单”，只保留你要复制执行的命令，不讲原理。
