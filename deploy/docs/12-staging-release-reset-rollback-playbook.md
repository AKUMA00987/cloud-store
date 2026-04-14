# 12. staging 发版、清库、回滚、验收教程

这份教程只针对 staging：

- Base Dir：`/root/cloud-store-staging`
- PM2 App：`cloud-store-staging`
- 端口：`3001`

## 一、先记住 staging 常用命令

### 健康检查

```bash
APP_PORT=3001 PUBLIC_URL=https://staging.你的域名/healthz bash /root/cloud-store-staging/deploy/scripts/check-health.sh
```

### 发版

```bash
cd /root/cloud-store-staging
sudo BASE_DIR=/root/cloud-store-staging PM2_APP_NAME=cloud-store-staging bash /root/cloud-store-staging/deploy/scripts/deploy-release-pm2.sh /root/cloud-store-release
```

### 清库重建

```bash
cd /root/cloud-store-staging
sudo BASE_DIR=/root/cloud-store-staging APP_NAME=cloud-store-staging APP_PORT=3001 bash /root/cloud-store-staging/deploy/scripts/reset-staging-data.sh
```

### 回滚

```bash
cd /root/cloud-store-staging
sudo BASE_DIR=/root/cloud-store-staging PM2_APP_NAME=cloud-store-staging bash /root/cloud-store-staging/deploy/scripts/rollback-release-pm2.sh /root/cloud-store-staging/backups/manual/你的备份目录
```

## 二、发版前先检查什么

执行：

```bash
pm2 status
APP_PORT=3001 PUBLIC_URL=https://staging.你的域名/healthz bash /root/cloud-store-staging/deploy/scripts/check-health.sh
```

你要确认：

1. `cloud-store-staging` 是 `online`
2. health check 通过
3. production 也仍然正常

## 三、staging 发版步骤

### 第 1 步：确认发版包已准备好

你当前仍然复用同一份：

```text
/root/cloud-store-release
```

这份包不应包含：

- staging sqlite
- production sqlite
- uploads
- env
- logs
- backups

### 第 2 步：执行 staging 发版

```bash
cd /root/cloud-store-staging
sudo BASE_DIR=/root/cloud-store-staging PM2_APP_NAME=cloud-store-staging bash /root/cloud-store-staging/deploy/scripts/deploy-release-pm2.sh /root/cloud-store-release
```

这一步会自动：

1. 备份 staging 当前版本
2. 把 release 包复制进 staging
3. 重启 `cloud-store-staging`
4. 检查 Nginx

### 第 3 步：做 staging 健康检查

```bash
APP_PORT=3001 PUBLIC_URL=https://staging.你的域名/healthz bash /root/cloud-store-staging/deploy/scripts/check-health.sh
```

### 第 4 步：看 staging 日志

```bash
pm2 logs cloud-store-staging --lines 50
```

## 四、什么时候要跑 reset-staging-data

当你遇到下面场景时，要跑清库重建：

1. staging 数据太脏
2. 要重新验证手机号登录 / 注册
3. 要重新验证支付、物流、优惠券
4. production 已经正式上线，不希望继续把旧测试数据带到 staging

## 五、reset-staging-data 会做什么

脚本：

```bash
sudo BASE_DIR=/root/cloud-store-staging APP_NAME=cloud-store-staging APP_PORT=3001 bash /root/cloud-store-staging/deploy/scripts/reset-staging-data.sh
```

你需要手动输入：

```text
RESET_STAGING_DATA
```

这一步会：

- 清掉 staging 用户、商品、订单、支付、退款、购物车、短信验证码、Banner、公告
- 保留 admin 账号
- 重建最小测试基线
- 写入测试买家、样品商品、优惠券

脚本完成后，会给出：

- 密码买家手机号
- 默认测试密码
- 验证码买家手机号

## 六、reset 后你要验什么

至少验下面 6 件事：

1. admin 还能登录
2. 密码买家能用手机号 + 密码登录
3. 验证码买家能用手机号 + 验证码登录
4. staging 首页仍然显示“测试环境 / staging”
5. 样品商品能正常下单
6. staging 支付页、物流页、账号安全页都可继续联调

## 七、回滚步骤

### 第 1 步：找到 staging 备份目录

例如：

```text
/root/cloud-store-staging/backups/manual/20260414-010000-before-release
```

### 第 2 步：执行回滚

```bash
cd /root/cloud-store-staging
sudo BASE_DIR=/root/cloud-store-staging PM2_APP_NAME=cloud-store-staging bash /root/cloud-store-staging/deploy/scripts/rollback-release-pm2.sh /root/cloud-store-staging/backups/manual/20260414-010000-before-release
```

### 第 3 步：重新做健康检查

```bash
APP_PORT=3001 PUBLIC_URL=https://staging.你的域名/healthz bash /root/cloud-store-staging/deploy/scripts/check-health.sh
```

### 第 4 步：看日志

```bash
pm2 logs cloud-store-staging --lines 50
```

## 八、staging 和 production 不要混的地方

你每次操作前都要先确认这 5 件事：

1. 当前目录是不是 `/root/cloud-store-staging`
2. 当前 PM2 app 是不是 `cloud-store-staging`
3. 当前端口是不是 `3001`
4. 当前域名是不是 `staging.你的域名`
5. 当前备份目录是不是 `/root/cloud-store-staging/backups/...`

## 九、这轮 Phase 19 的验收标准

如果下面都成立，就说明 Phase 19 的 operator 面已经真正可用了：

1. staging 可以独立发版
2. staging 可以独立健康检查
3. staging 可以独立清库重建
4. staging 可以独立回滚
5. production 不会被 staging 操作误伤
