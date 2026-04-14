# 微信内 H5 / 微信外 H5 双环境接入教程

这份教程覆盖 production 和 staging 两套环境。

当前代码真相：

- 微信支付已拆成两条正式链路：
  - `wechat_h5_inapp`
  - `wechat_h5_external`
- 页面会按浏览器环境自动推荐主按钮
- 真正改订单状态的仍然是服务端异步通知

## 一、先记住双环境分工

| 环境 | 用途 | Env 文件 | PM2 App | 公网域名 |
|------|------|----------|---------|----------|
| `staging` | 先做微信真实联调 | `/root/cloud-store-staging/cloud-store.env` | `cloud-store-staging` | `https://staging.你的域名` |
| `production` | 正式收款 | `/root/cloud-store/cloud-store.env` | `cloud-store` | `https://putiguoguo.com` |

建议顺序：

1. 先在 staging 配好白名单、回调和证书
2. staging 跑通微信内 / 微信外 H5
3. 再切 production

## 二、你要准备什么

你至少要有：

1. 可用的微信支付商户号
2. `WECHAT_PAY_APP_ID`
3. `WECHAT_PAY_MCH_ID`
4. `WECHAT_PAY_API_V3_KEY`
5. `WECHAT_PAY_PRIVATE_KEY`
6. `WECHAT_PAY_CERT_SERIAL_NO`
7. staging HTTPS 域名
8. production HTTPS 域名

## 三、回调和白名单怎么区分

### staging

```text
CLOUD_STORE_PUBLIC_BASE_URL=https://staging.你的域名
WECHAT_PAY_NOTIFY_URL=https://staging.你的域名/api/payments/wechat/notify
WECHAT_PAY_INAPP_RETURN_URL=https://staging.你的域名/#/paymentResult
WECHAT_PAY_EXTERNAL_RETURN_URL=https://staging.你的域名/#/paymentResult
```

### production

```text
CLOUD_STORE_PUBLIC_BASE_URL=https://putiguoguo.com
WECHAT_PAY_NOTIFY_URL=https://putiguoguo.com/api/payments/wechat/notify
WECHAT_PAY_INAPP_RETURN_URL=https://putiguoguo.com/#/paymentResult
WECHAT_PAY_EXTERNAL_RETURN_URL=https://putiguoguo.com/#/paymentResult
```

微信商户平台里也要同步分环境准备：

- 支付域名
- 白名单
- 微信内浏览器相关授权域名

不要把 production 域名提前填到 staging。

## 四、先配 staging

编辑：

```bash
sudo nano /root/cloud-store-staging/cloud-store.env
```

至少补齐：

```text
WECHAT_PAY_ENABLED=true
WECHAT_PAY_APP_ID=你的微信应用ID
WECHAT_PAY_MCH_ID=你的微信商户号
WECHAT_PAY_API_V3_KEY=你的APIv3Key
WECHAT_PAY_PRIVATE_KEY=你的商户私钥
WECHAT_PAY_CERT_SERIAL_NO=你的证书序列号
CLOUD_STORE_PUBLIC_BASE_URL=https://staging.你的域名
WECHAT_PAY_NOTIFY_URL=https://staging.你的域名/api/payments/wechat/notify
WECHAT_PAY_INAPP_RETURN_URL=https://staging.你的域名/#/paymentResult
WECHAT_PAY_EXTERNAL_RETURN_URL=https://staging.你的域名/#/paymentResult
```

重启：

```bash
cd /root/cloud-store-staging
set -a
source /root/cloud-store-staging/cloud-store.env
set +a
pm2 restart cloud-store-staging --update-env
```

## 五、staging 怎么验收

建议按这个顺序：

1. 普通手机浏览器打开 staging
2. 创建待支付订单
3. 先验证“更多支付方式 -> 微信支付”
4. 再用微信内置浏览器打开 staging
5. 验证主按钮是否自动变成微信支付
6. 支付后确认订单最终进入“待发货”

同时检查：

```bash
pm2 logs cloud-store-staging --lines 80
```

至少要同时满足：

1. 微信内打开时能命中 `wechat_h5_inapp`
2. 微信外打开时能命中 `wechat_h5_external`
3. 结果页不会直接假装“已支付”
4. 异步通知到达后，订单才进入“待发货”

## 六、staging 正常后再配 production

编辑：

```bash
sudo nano /root/cloud-store/cloud-store.env
```

把 staging 的微信字段复制过去，但把域名换成 production：

```text
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
cd /root/cloud-store
set -a
source /root/cloud-store/cloud-store.env
set +a
pm2 restart cloud-store --update-env
```

## 七、常见问题

### 1. 提示“微信支付配置不完整”

重点检查：

- `WECHAT_PAY_APP_ID`
- `WECHAT_PAY_MCH_ID`
- `WECHAT_PAY_API_V3_KEY`
- `WECHAT_PAY_PRIVATE_KEY`
- `WECHAT_PAY_CERT_SERIAL_NO`
- `WECHAT_PAY_NOTIFY_URL`
- `WECHAT_PAY_INAPP_RETURN_URL`
- `WECHAT_PAY_EXTERNAL_RETURN_URL`

### 2. 微信内能点，但拉不起支付

重点检查：

1. 当前是不是微信内置浏览器
2. staging 域名是否已进微信商户平台白名单
3. `WECHAT_PAY_APP_ID` 是否和实际主体对应

### 3. 能回跳，但订单没变已支付

重点检查：

1. `WECHAT_PAY_NOTIFY_URL` 是否公网可达
2. Nginx 是否正确转发
3. 白名单和回调域名是否写对环境

### 4. staging 正常，production 不正常

重点核对：

1. 你改的是不是 production env
2. 重启的是不是 `cloud-store`
3. 白名单里是不是只配了 staging，没有配 production

## 八、回滚原则

如果 staging 联调失败：

- 继续留在 staging 排查
- 不要跳过 staging 直接改 production

如果 production 出问题：

1. 先把 `WECHAT_PAY_ENABLED=false`
2. 重启 production PM2
3. staging 继续保留为排查入口
