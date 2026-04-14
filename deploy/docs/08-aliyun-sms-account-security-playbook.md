# 阿里云短信认证与账号安全双环境教程

这份教程对应当前手机号优先登录 / 注册体系。

当前代码真相：

- 默认主入口是“手机号 + 验证码”
- 登录时可以切“手机号 + 密码”
- 首次验证码登录的新账号默认无密码
- 后续可在“账号安全”里首次设密 / 修改密码
- 忘记密码也走短信验证码

## 一、先记住环境分工

| 环境 | 用途 | Env 文件 | PM2 App | 默认要求 |
|------|------|----------|---------|----------|
| `staging` | 联调短信登录、注册、找回密码 | `/root/cloud-store-staging/cloud-store.env` | `cloud-store-staging` | 必须接真实阿里云 |
| `production` | 正式用户使用 | `/root/cloud-store/cloud-store.env` | `cloud-store` | 必须接真实阿里云 |
| `local-dev` | 本地开发排查 | 本地 `.env` 或终端变量 | 本地 node | 可临时 `mock` |

staging / production 都不要保留：

```text
CS_SMS_PROVIDER=mock
CS_SMS_DEBUG_CODES=true
```

deploy-safe 默认值应保持：

```text
CS_SMS_PROVIDER=aliyun
CS_SMS_DEBUG_CODES=false
```

## 二、开始前要准备什么

你需要先准备：

1. 阿里云账号
2. 号码认证服务中的“短信认证服务”
3. 一组可用的 AccessKey
4. 赠送签名
5. 赠送模板
6. staging 域名和 production 域名都已能访问对应站点

## 三、阿里云控制台要做什么

### 1. 开通服务

1. 登录阿里云控制台
2. 搜索 `号码认证服务`
3. 进入 `短信认证服务`
4. 按页面提示开通

### 2. 记录签名和模板

优先使用控制台赠送的：

- 赠送签名
- 赠送模板

你至少要记下：

- `ALIYUN_SMS_SIGN_NAME`
- `ALIYUN_SMS_TEMPLATE_CODE`

如果绑定手机号和找回密码要拆两套模板，再额外记下：

- `ALIYUN_SMS_TEMPLATE_CODE_BIND_PHONE`
- `ALIYUN_SMS_TEMPLATE_CODE_RESET_PASSWORD`

### 3. 创建 AccessKey

你最终要拿到：

- `ALIYUN_SMS_ACCESS_KEY_ID`
- `ALIYUN_SMS_ACCESS_KEY_SECRET`

## 四、先配 staging，再配 production

建议顺序：

1. 先完成 staging
2. 在 staging 跑通验证码登录 / 注册、首次设密、找回密码
3. 再把同样配置切到 production

### staging 环境变量示例

编辑：

```bash
sudo nano /root/cloud-store-staging/cloud-store.env
```

至少确保：

```text
CS_SMS_PROVIDER=aliyun
CS_SMS_DEBUG_CODES=false
ALIYUN_SMS_ACCESS_KEY_ID=你的AccessKeyId
ALIYUN_SMS_ACCESS_KEY_SECRET=你的AccessKeySecret
ALIYUN_SMS_SIGN_NAME=你的赠送签名
ALIYUN_SMS_TEMPLATE_CODE=你的赠送模板编号
```

如果你拆了模板，就改成：

```text
CS_SMS_PROVIDER=aliyun
CS_SMS_DEBUG_CODES=false
ALIYUN_SMS_ACCESS_KEY_ID=你的AccessKeyId
ALIYUN_SMS_ACCESS_KEY_SECRET=你的AccessKeySecret
ALIYUN_SMS_SIGN_NAME=你的赠送签名
ALIYUN_SMS_TEMPLATE_CODE_BIND_PHONE=绑定手机号模板编号
ALIYUN_SMS_TEMPLATE_CODE_RESET_PASSWORD=找回密码模板编号
```

重启：

```bash
cd /root/cloud-store-staging
set -a
source /root/cloud-store-staging/cloud-store.env
set +a
pm2 restart cloud-store-staging --update-env
```

### production 环境变量示例

编辑：

```bash
sudo nano /root/cloud-store/cloud-store.env
```

填法和 staging 相同，只是文件路径与 PM2 app 换成 production：

```bash
cd /root/cloud-store
set -a
source /root/cloud-store/cloud-store.env
set +a
pm2 restart cloud-store --update-env
```

## 五、怎么验证 staging 已接通

先在 staging 跑下面 4 条：

1. 新手机号验证码登录
   预期：自动注册并登录成功
2. 已存在手机号再次验证码登录
   预期：命中旧账号，不重复注册
3. 首次设密
   预期：账号安全里可设置新密码
4. 忘记密码
   预期：短信验证码能重置密码，旧密码失效

同时检查：

```bash
pm2 logs cloud-store-staging --lines 50
```

不应再看到：

- 阿里云配置不完整
- 签名或模板错误
- AccessKey 无效

## 六、production 上线前再核对什么

上线前再确认：

1. staging 已经用真实手机号跑通过
2. `CS_SMS_DEBUG_CODES=false`
3. 没有把 staging 的 env 文件直接误拷到 production
4. production PM2 app 是 `cloud-store`，不是 `cloud-store-staging`

## 七、短时排查怎么做

如果 staging 临时排查确实要回显验证码，可以短时打开：

```text
CS_SMS_DEBUG_CODES=true
```

排查完成后立刻改回：

```text
CS_SMS_DEBUG_CODES=false
```

不要把 staging / production 长期留在 debug 回显状态。

## 八、常见问题

### 1. 提示“阿里云号码认证短信认证配置不完整”

重点检查：

- `ALIYUN_SMS_ACCESS_KEY_ID`
- `ALIYUN_SMS_ACCESS_KEY_SECRET`
- `ALIYUN_SMS_SIGN_NAME`
- `ALIYUN_SMS_TEMPLATE_CODE`

### 2. 手机收不到验证码

按顺序检查：

1. 手机号是否为中国大陆手机号
2. staging 是否真的已经重启到新 env
3. 日志里是否有阿里云发送失败
4. 阿里云控制台发送记录里是否有记录

### 3. staging 正常，production 不正常

这通常是双环境混用问题。先核对：

1. 你改的是不是正确的 env 文件
2. 重启的是不是正确的 PM2 app
3. 两套环境变量是不是都填了同一组值

## 九、回滚原则

如果真实阿里云联调失败：

- local-dev 可以临时切回 `mock`
- staging / production 不建议长期切回 `mock`

如果 production 出问题，优先先把问题留在 staging 复现和修好，再重新发 production。
