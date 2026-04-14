# Cloud Store Deploy Kit

这个目录只放“部署与运维模板”，不会被网站前台直接读取。

当前部署口径已经从“单一线上环境”升级成“同一台 ECS 上的 production + staging 双环境”：

| 环境 | 用途 | Base Dir | PM2 App | Node 端口 | 公网域名 |
|------|------|----------|---------|-----------|----------|
| `production` | 正式收单、正式访问 | `/root/cloud-store` | `cloud-store` | `3000` | `https://putiguoguo.com` |
| `staging` | 线上测试、短信/支付/物流联调 | `/root/cloud-store-staging` | `cloud-store-staging` | `3001` | `https://staging.你的域名` |

当前原则：

- 同一份 `cloud-store-release/` 代码包，同时复用给 production 和 staging
- 两套环境只允许共用代码，不允许共用数据库、uploads、env、PM2 app 和 Nginx `server_name`
- staging 必须显式显示“测试环境 / staging”，并带 `noindex`
- 后续支付、短信、物流、页面联调，默认都先在 staging 做，不再回 production 当测试站

## 目录说明

- `env/`
  - 环境变量模板
- `nginx/`
  - Nginx 反向代理模板
- `systemd/`
  - 可选兼容模板，仅在你未来改回 `systemd` 管 Node 时使用
- `scripts/`
  - 备份、恢复、发布、回滚、健康检查、清库重建脚本模板
- `docs/`
  - 面向非程序员的分步操作教程

## 当前实际使用提醒

当前这套文档默认按你现在服务器上的真实方式理解：

- Nginx 继续由 `systemd` 管
- Node 进程应以 `PM2` 为准
- 发版优先参考：
  - `docs/04-pm2-release-flow.md`
  - `scripts/deploy-release-pm2.sh`
  - `scripts/rollback-release-pm2.sh`
- staging 专项搭建与运维优先参考：
  - `docs/15-dual-environment-master-ops-manual.md`
  - `docs/14-staging-beginner-step-by-step.md`
  - `docs/13-dual-environment-management-and-deployment-playbook.md`
  - `docs/11-online-staging-environment-playbook.md`
  - `docs/12-staging-release-reset-rollback-playbook.md`
  - `env/cloud-store.staging.env.example`
  - `nginx/cloud-store-staging.conf.example`
  - `scripts/reset-staging-data.sh`
- legacy 兼容项：
  - `scripts/deploy-release.sh`
  - 默认会拒绝执行，只有显式设置 `ALLOW_LEGACY_SYSTEMD_DEPLOY=1` 才会继续旧的 `systemd` 管应用流程

## 先看哪份文档

如果你现在要做的是：

- 以后只想看一份双环境总手册：
  - `docs/15-dual-environment-master-ops-manual.md`
- 想一次完成 staging + production 的数据初始化：
  - `docs/16-dual-environment-data-initialization-playbook.md`
- 第一次把 staging 搭起来：
  - `docs/14-staging-beginner-step-by-step.md`
  - `docs/13-dual-environment-management-and-deployment-playbook.md`
  - `docs/11-online-staging-environment-playbook.md`
- 给 staging 发版、清库、回滚、验收：
  - `docs/13-dual-environment-management-and-deployment-playbook.md`
  - `docs/12-staging-release-reset-rollback-playbook.md`
- 正式环境常规发版：
  - `docs/04-pm2-release-flow.md`
- 发布前备份、恢复、回滚：
  - `docs/02-backup-restore-release-rollback.md`
- 正式上线前清掉测试期数据，只保留 `admin`：
  - `docs/15-dual-environment-master-ops-manual.md`
  - `docs/07-launch-data-reset.md`
  - `scripts/reset-launch-data.sh`
  - `scripts/reset-launch-data.js`
- 接短信验证码登录 / 注册、忘记密码、手机号绑定：
  - `docs/08-aliyun-sms-account-security-playbook.md`
- 接支付宝 H5 / WAP：
  - `docs/09-alipay-wap-payment-playbook.md`
- 接微信内 H5 / 微信外 H5：
  - `docs/10-wechat-h5-payment-playbook.md`

## 短信与支付的当前真相

`Phase 18.3` 之后，当前代码口径已经固定为：

- 登录 / 注册默认主入口是“手机号 + 验证码”
- 登录时可切换为“手机号 + 密码”
- 首次验证码登录的账号默认无密码，需要在账号安全里首次设密
- 支付页会按环境自动推荐主按钮：
  - 微信内浏览器优先微信内 H5
  - 非微信浏览器默认先推支付宝
  - 页面保留“更多支付方式”

`Phase 18.2` 之后，deploy-safe 边界也已经固定为：

- deploy 模板默认面向 staging/public，短信默认 `aliyun + debug=false`
- `POST /api/orders/:orderId/pay` 只保留给显式 local-dev 调试；只有手动设置 `CS_ENABLE_LOCAL_MOCK_PAYMENT=true` 且保持非 production 时才允许使用
- staging/public 不应继承本地 mock 支付或短信调试开关

当你要把 `18.3` 这组能力包进测试系统时，至少要先准备 3 类配置：

- 手机号优先登录 / 注册：
  - 阿里云短信账号、赠送签名、登录/注册与找回密码模板
- 支付宝：
  - AppId、RSA2 密钥、公钥、同步 / 异步回调
- 微信支付：
  - 商户号、API v3 Key、商户私钥、证书序列号、JSAPI / H5 域名白名单与回调

## 当前线上目录口径

production 统一按下面这些路径理解：

- `/root/cloud-store`
  - 网站项目根目录
- `/root/cloud-store/server.js`
  - Node 服务入口
- `/root/cloud-store/public/index.html`
  - 前台页面入口
- `/root/cloud-store/cloud-store.sqlite`
  - production SQLite 数据库
- `/root/cloud-store/public/uploads`
  - production 上传图片目录
- `/root/cloud-store/cloud-store.env`
  - production 运行环境变量文件

staging 统一按下面这些路径理解：

- `/root/cloud-store-staging`
  - staging 项目根目录
- `/root/cloud-store-staging/server.js`
  - staging Node 服务入口
- `/root/cloud-store-staging/public/index.html`
  - staging 前台页面入口
- `/root/cloud-store-staging/cloud-store.sqlite`
  - staging SQLite 数据库
- `/root/cloud-store-staging/public/uploads`
  - staging 上传图片目录
- `/root/cloud-store-staging/cloud-store.env`
  - staging 运行环境变量文件

两套环境都各自拥有：

- `backups/`
- `logs/`
- 自己的 PM2 app
- 自己的 Nginx `server_name`

## 当前模板约定

- production Node 只监听 `127.0.0.1:3000`
- staging Node 只监听 `127.0.0.1:3001`
- 公网只通过 Nginx 进入
- 安全组只保留 `80/443/22`
- staging 必须显式标成“测试环境 / staging”，并保持 `noindex`
- release 包仍保持单一结构，不打包数据库、uploads、env、logs、backups
- PM2 发版脚本当前会同步覆盖 `server.js`、`public/`、`deploy/`、`package.json`、`package-lock.json`；其中 `public/uploads` 仍然保留服务器现有内容，不会被 release 覆盖
- `deploy/scripts/check-health.sh` 当前已带启动期重试，默认会等待最多约 20 秒，避免 PM2 重启后瞬时健康检查抢跑造成假失败

## 这轮 Phase 19 的交付边界

需要同步到线上 / 部署环境的文件：

- `root/server.js`
- `root/public/index.html`
- `root/deploy/env/cloud-store.staging.env.example`
- `root/deploy/nginx/cloud-store-staging.conf.example`
- `root/deploy/scripts/check-health.sh`
- `root/deploy/scripts/backup-manual.sh`
- `root/deploy/scripts/restore-from-backup.sh`
- `root/deploy/scripts/deploy-release-pm2.sh`
- `root/deploy/scripts/rollback-release-pm2.sh`
- `root/deploy/scripts/prepare-runtime-dirs.sh`
- `root/deploy/scripts/reset-staging-data.sh`
- `root/deploy/scripts/reset-staging-data.js`
- `root/deploy/README.md`
- `root/deploy/docs/08-aliyun-sms-account-security-playbook.md`
- `root/deploy/docs/09-alipay-wap-payment-playbook.md`
- `root/deploy/docs/10-wechat-h5-payment-playbook.md`
- `root/deploy/docs/11-online-staging-environment-playbook.md`
- `root/deploy/docs/12-staging-release-reset-rollback-playbook.md`

仅用于本地协作、测试或过程留档的文件：

- `root/server-smoke-test.js`
- `.planning/phases/19-online-staging-environment/*`
- `cloud-store-progress.md`
- `cloud-store-checklist.md`
- `.planning/STATE.md`
