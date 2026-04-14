# 支付宝 H5 / WAP 双环境接入教程

这份教程覆盖 production 和 staging 两套环境。

当前代码真相：

- 支付宝链路对应 `alipay_wap`
- 同步返回只负责展示结果
- 真正改订单状态的是服务端异步通知
- `ALIPAY_ENABLED=true` 时，缺少公网变量会直接 fail-fast

## 一、先记住双环境分工

| 环境 | 用途 | Env 文件 | PM2 App | 公网域名 |
|------|------|----------|---------|----------|
| `staging` | 先做真实支付宝联调 | `/root/cloud-store-staging/cloud-store.env` | `cloud-store-staging` | `https://staging.你的域名` |
| `production` | 正式用户支付 | `/root/cloud-store/cloud-store.env` | `cloud-store` | `https://putiguoguo.com` |

建议顺序：

1. 先在 staging 跑通
2. staging 验证通过后再切 production

## 二、你要准备什么

你需要先准备：

1. 已实名认证的支付宝开放平台账号
2. 已开通 `手机网站支付`
3. RSA2 密钥对
4. staging HTTPS 域名
5. production HTTPS 域名

## 三、支付宝开放平台要拿到哪些值

你最终要拿到：

- `ALIPAY_APP_ID`
- `ALIPAY_PRIVATE_KEY`
- `ALIPAY_PUBLIC_KEY`
- `ALIPAY_SELLER_ID`

## 四、回调地址怎么区分

### staging 回调

```text
CLOUD_STORE_PUBLIC_BASE_URL=https://staging.你的域名
ALIPAY_RETURN_URL=https://staging.你的域名/#/paymentResult
ALIPAY_NOTIFY_URL=https://staging.你的域名/api/payments/alipay/notify
```

### production 回调

```text
CLOUD_STORE_PUBLIC_BASE_URL=https://putiguoguo.com
ALIPAY_RETURN_URL=https://putiguoguo.com/#/paymentResult
ALIPAY_NOTIFY_URL=https://putiguoguo.com/api/payments/alipay/notify
```

注意：

- staging 和 production 的回调地址不要混写
- 不要把 production 回调先填到 staging
- `notify` 地址必须公网可达

## 五、先配 staging

编辑：

```bash
sudo nano /root/cloud-store-staging/cloud-store.env
```

至少补齐：

```text
ALIPAY_ENABLED=true
ALIPAY_APP_ID=你的AppID
ALIPAY_PRIVATE_KEY=你的商户私钥
ALIPAY_PUBLIC_KEY=支付宝公钥
ALIPAY_SELLER_ID=你的商户PID
CLOUD_STORE_PUBLIC_BASE_URL=https://staging.你的域名
ALIPAY_RETURN_URL=https://staging.你的域名/#/paymentResult
ALIPAY_NOTIFY_URL=https://staging.你的域名/api/payments/alipay/notify
```

重启：

```bash
cd /root/cloud-store-staging
set -a
source /root/cloud-store-staging/cloud-store.env
set +a
pm2 restart cloud-store-staging --update-env
```

## 六、staging 怎么验收

按这个顺序：

1. 打开 staging 站点
2. 用买家账号创建待支付订单
3. 在非微信浏览器里点击支付宝主按钮
4. 完成支付后回到 `#/paymentResult`
5. 查看订单是否最终进入“待发货”

同时检查：

```bash
pm2 logs cloud-store-staging --lines 80
```

你要重点确认：

1. 能跳到支付宝收银台
2. 回跳后不会直接假装“已支付”
3. 异步通知到了以后，订单才变成“待发货”
4. 支付流水里能看到 `alipay_wap`

## 七、staging 正常后再配 production

编辑：

```bash
sudo nano /root/cloud-store/cloud-store.env
```

把 staging 的支付宝字段复制过去，但把域名换成 production：

```text
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
cd /root/cloud-store
set -a
source /root/cloud-store/cloud-store.env
set +a
pm2 restart cloud-store --update-env
```

## 八、常见问题

### 1. 提示“支付宝配置不完整”

重点检查：

- `ALIPAY_APP_ID`
- `ALIPAY_PRIVATE_KEY`
- `ALIPAY_PUBLIC_KEY`
- `CLOUD_STORE_PUBLIC_BASE_URL`
- `ALIPAY_RETURN_URL`
- `ALIPAY_NOTIFY_URL`

### 2. 能跳转，但订单不变已支付

优先检查：

1. `ALIPAY_NOTIFY_URL` 是否公网可达
2. Nginx 是否正确转发
3. 公钥 / 私钥是否匹配
4. 有没有把 staging / production 回调写反

### 3. staging 可以，production 不可以

这通常是环境串了。重点核对：

1. 你改的是不是 production 的 env
2. 重启的是不是 `cloud-store`
3. 回调域名是不是还残留 staging

## 九、回滚原则

如果 staging 联调失败：

- 先把问题留在 staging 修
- 不要跳过 staging 直接去 production 硬试

如果 production 出问题：

1. 先把 `ALIPAY_ENABLED=false`
2. 重启 production PM2
3. 保持 staging 继续做排查
