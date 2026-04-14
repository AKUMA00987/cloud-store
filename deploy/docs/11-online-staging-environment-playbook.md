# 11. 线上测试环境搭建教程

这份教程对应 `Phase 19`。

目标不是再开一台机器，而是在同一台 ECS 上搭一套独立的 staging：

- 独立目录
- 独立 PM2 app
- 独立端口
- 独立数据库
- 独立 uploads
- 独立公网子域名

## 一、先记住最终结构

| 项目 | production | staging |
|------|------------|---------|
| Base Dir | `/root/cloud-store` | `/root/cloud-store-staging` |
| PM2 App | `cloud-store` | `cloud-store-staging` |
| Node 端口 | `3000` | `3001` |
| DB | `/root/cloud-store/cloud-store.sqlite` | `/root/cloud-store-staging/cloud-store.sqlite` |
| Uploads | `/root/cloud-store/public/uploads` | `/root/cloud-store-staging/public/uploads` |
| Env 文件 | `/root/cloud-store/cloud-store.env` | `/root/cloud-store-staging/cloud-store.env` |
| 域名 | `putiguoguo.com` | `staging.你的域名` |

## 二、开始前要准备什么

你需要先准备：

1. 服务器里已经有 production 在运行
2. 你已经拿到新的发版包目录，例如 `/root/cloud-store-release`
3. 你已经准备好 staging 子域名
4. 你已经准备好 staging HTTPS

## 三、创建 staging 目录

执行：

```bash
sudo mkdir -p /root/cloud-store-staging
sudo mkdir -p /root/cloud-store-staging-release
sudo cp -R /root/cloud-store-release/* /root/cloud-store-staging/
```

说明：

- staging 继续复用同一份 release 包
- 不需要单独做第二份 release 结构

## 四、准备 staging 运行目录

执行：

```bash
cd /root/cloud-store-staging
sudo bash deploy/scripts/prepare-runtime-dirs.sh
```

成功时你应看到：

```text
runtime directories prepared for cloud-store-staging under /root/cloud-store-staging
```

## 五、复制 staging 环境变量模板

执行：

```bash
cp /root/cloud-store-staging/deploy/env/cloud-store.staging.env.example /root/cloud-store-staging/cloud-store.env
```

然后编辑：

```bash
nano /root/cloud-store-staging/cloud-store.env
```

你至少要确认这些字段：

```text
NODE_ENV=production
HOST=127.0.0.1
PORT=3001
CLOUD_STORE_RUNTIME_ENV=staging
CLOUD_STORE_RUNTIME_LABEL=测试环境 / staging
CLOUD_STORE_PUBLIC_BASE_URL=https://staging.你的域名
CLOUD_STORE_DB_PATH=/root/cloud-store-staging/cloud-store.sqlite
CLOUD_STORE_UPLOAD_ROOT=/root/cloud-store-staging/public/uploads
```

## 六、复制 staging Nginx 模板

执行：

```bash
sudo cp /root/cloud-store-staging/deploy/nginx/cloud-store-staging.conf.example /etc/nginx/sites-available/cloud-store-staging.conf
sudo ln -sf /etc/nginx/sites-available/cloud-store-staging.conf /etc/nginx/sites-enabled/cloud-store-staging.conf
```

然后把模板里的：

- `staging.example.com`
- 证书路径

都改成你自己的 staging 域名和证书路径。

检查：

```bash
sudo nginx -t
```

成功后重载：

```bash
sudo systemctl restart nginx
```

## 七、启动 staging PM2 应用

执行：

```bash
cd /root/cloud-store-staging
set -a
source /root/cloud-store-staging/cloud-store.env
set +a
pm2 start /root/cloud-store-staging/server.js --name cloud-store-staging --update-env
pm2 save
```

检查：

```bash
pm2 status
```

你应看到：

- `cloud-store` 仍然在线
- `cloud-store-staging` 也在线

## 八、确认 staging 没串 production

执行：

```bash
curl http://127.0.0.1:3001/healthz
```

你要在返回里看到：

- `env = staging`
- `isStaging = true`
- `database = cloud-store.sqlite`
- `uploads = uploads`

但要注意：

- 这些名字虽然相同，路径一定是 `/root/cloud-store-staging/...`
- staging 和 production 不能共用同一个 sqlite 文件

再打开 staging 首页，确认：

1. 页面能打开
2. 页面有“测试环境 / staging”标识
3. 响应带 `X-Robots-Tag: noindex`

## 九、staging 第一次上线后先做什么

第一次启动好 staging 后，不要直接拿旧测试垃圾数据联调。

先执行：

```bash
cd /root/cloud-store-staging
sudo bash deploy/scripts/reset-staging-data.sh
```

这一步会：

- 清掉 staging 业务数据
- 重建最小测试基线
- 保留 admin
- 生成测试买家、样品商品、优惠券

## 十、成功标准

这份教程完成后，你要同时满足：

1. production 还能正常访问
2. staging 能通过独立子域名访问
3. staging 首页明显显示“测试环境 / staging”
4. staging 和 production 使用不同 PM2 app
5. staging 和 production 使用不同数据库与 uploads

## 十一、如果失败怎么回退

如果 staging 没启动成功：

1. 不要动 production
2. 先看：

```bash
pm2 logs cloud-store-staging --lines 50
sudo nginx -t
```

3. 如果只是 staging 配坏了，可以先停掉：

```bash
pm2 delete cloud-store-staging
sudo rm -f /etc/nginx/sites-enabled/cloud-store-staging.conf
sudo systemctl restart nginx
```

production 不应受影响。
