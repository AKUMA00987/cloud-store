# 16. 双环境数据初始化实操手册

这份手册只解决一个具体场景：

- 你准备把 `production` 正式切成“只保留正式数据”的状态
- 同时也想把 `staging` 清干净，继续保留为测试系统
- 你希望两套环境都做一次彻底初始化，但不要互相误伤

这次操作的目标结果是：

- `staging` 变成干净的测试环境，并自动回填最小测试基线
- `production` 清掉测试期数据，只保留 `admin` 账号和商品分类
- 以后正式环境只录正式商品、正式用户、正式订单

---

## 一、先记住这次两套环境分别会变成什么

### 1. staging 初始化后

会变成：

- 仍然是测试环境
- 保留 `admin`
- 自动生成测试买家
- 自动生成测试商品
- 自动生成测试优惠券
- 继续可做短信 / 支付 / 物流联调

对应脚本：

```bash
/root/cloud-store-staging/deploy/scripts/reset-staging-data.sh
```

### 2. production 初始化后

会变成：

- 正式环境
- 只保留 `admin`
- 保留商品分类
- 清空测试期商品、订单、用户、Banner、公告、优惠券模板
- 不再自动长回默认演示数据

对应脚本：

```bash
/root/cloud-store/deploy/scripts/reset-launch-data.sh
```

---

## 二、这次推荐的执行顺序

严格按这个顺序做：

1. 先确认两套环境现在都正常
2. 先备份 `staging` 和 `production`
3. 先初始化 `staging`
4. 验证 `staging` 正常
5. 再初始化 `production`
6. 验证 `production` 正常
7. 开始录入正式商品和正式运营数据

不要反过来先动 `production`。

原因很简单：

- `staging` 是测试场，先把测试环境整理好，后面如果要补短信 / 支付 / 物流联调，还有地方可测
- `production` 一旦清掉测试期数据，就应该尽快进入正式录入阶段，不适合再拿来试错

---

## 三、正式动手前，先做这 6 个确认

### 1. 你能分清两套环境

先记住：

| 环境 | 目录 | PM2 名称 | 端口 | 域名 |
|------|------|----------|------|------|
| `production` | `/root/cloud-store` | `cloud-store` | `3000` | `putiguoguo.com` |
| `staging` | `/root/cloud-store-staging` | `cloud-store-staging` | `3001` | `staging.putiguoguo.com` |

### 2. 两套环境现在都在线

执行：

```bash
pm2 status
sudo systemctl status nginx --no-pager
curl http://127.0.0.1:3000/healthz
curl http://127.0.0.1:3001/healthz
```

你要确认：

- `cloud-store` 是 `online`
- `cloud-store-staging` 是 `online`
- `nginx` 是 `active (running)`
- `3000` 和 `3001` 的健康检查都能通

### 3. production 里已经没有你还想保留的测试订单

因为 `reset-launch-data.sh` 会清掉：

- 非 `admin` 用户
- 订单
- 优惠券
- 商品
- Banner
- 公告

### 4. 你已经准备好正式环境要录入的正式资料

比如：

- 正式商品
- 正式 Banner
- 正式公告
- 正式优惠券模板

### 5. 你知道 staging 初始化后会重新生成测试账号

初始化完成后，脚本会输出：

- 密码测试买家手机号
- 默认测试密码
- 验证码测试买家手机号

### 6. 你知道 production 初始化后不会自动回灌演示数据

因为脚本会写入：

```text
/root/cloud-store/.disable-default-seed
```

---

## 四、先做“双环境手动备份”

虽然两个 reset 脚本都会先自动备份，但你这次是重要切换，建议先手动做一轮双备份。

### 1. 备份 production

```bash
sudo bash /root/cloud-store/deploy/scripts/backup-manual.sh before-dual-init-production
```

### 2. 备份 staging

```bash
sudo BASE_DIR=/root/cloud-store-staging SITE_SLUG=cloud-store-staging bash /root/cloud-store-staging/deploy/scripts/backup-manual.sh before-dual-init-staging
```

### 3. 看备份目录是否真的生成了

```bash
ls -l /root/cloud-store/backups/manual
ls -l /root/cloud-store-staging/backups/manual
```

---

## 五、第 1 部分：初始化 staging

### 第 1 步：执行 staging 初始化

```bash
cd /root/cloud-store-staging
sudo BASE_DIR=/root/cloud-store-staging APP_NAME=cloud-store-staging APP_PORT=3001 bash /root/cloud-store-staging/deploy/scripts/reset-staging-data.sh
```

终端会要求你输入：

```text
RESET_STAGING_DATA
```

### 第 2 步：等脚本跑完

成功时，你会看到类似：

```text
staging data reset finished successfully.
```

### 第 3 步：看 staging 健康检查

```bash
APP_PORT=3001 PUBLIC_URL=https://staging.putiguoguo.com/healthz bash /root/cloud-store-staging/deploy/scripts/check-health.sh
pm2 logs cloud-store-staging --lines 50
```

### 第 4 步：登录 staging 做人工验收

至少确认这 7 件事：

1. `admin` 能正常登录
2. staging 页面仍显示“测试环境 / staging”
3. 有样品商品
4. 有测试优惠券
5. 密码测试买家能登录
6. 验证码测试买家能走短信登录
7. 下单、支付页、账号安全页还能继续联调

### 第 5 步：确认 staging 已经准备好继续当测试系统

这一步完成后，意味着：

- 以后真实短信 / 支付 / 物流联调继续去 `staging`
- `production` 不再继续承接测试职责

---

## 六、第 2 部分：初始化 production

只有 staging 验证通过后，才继续这一步。

### 第 1 步：执行 production 初始化

```bash
cd /root/cloud-store
sudo bash /root/cloud-store/deploy/scripts/reset-launch-data.sh
```

终端会要求你输入：

```text
RESET_LAUNCH_DATA
```

### 第 2 步：等脚本跑完

成功时，你会看到类似：

```text
launch data reset finished successfully.
```

### 第 3 步：看 production 健康检查

```bash
bash /root/cloud-store/deploy/scripts/check-health.sh
pm2 logs cloud-store --lines 50
```

### 第 4 步：登录 production 后台做人工验收

至少确认这 8 件事：

1. `admin` 能正常登录
2. 商品列表为空
3. Banner 列表为空
4. 公告列表为空
5. 优惠券模板为空
6. 用户列表只剩 `admin`
7. 订单列表为空
8. 退款列表为空

### 第 5 步：确认默认演示数据不会再自动回来

执行：

```bash
ls -l /root/cloud-store/.disable-default-seed
pm2 restart cloud-store
```

然后重新刷新后台，再确认：

- 商品没有自动回来
- Banner 没有自动回来
- 公告没有自动回来
- 优惠券模板没有自动回来

---

## 七、这次操作完成后的正确状态

如果一切正常，最后应该是这样：

### staging

- 有测试数据
- 有测试买家
- 可以继续联调
- 页面带 `staging` 标识

### production

- 没有测试期脏数据
- 只有 `admin`
- 商品分类还在
- 可以开始录正式商品和正式运营内容

---

## 八、接下来你应该做什么

production 初始化完成后，建议马上按这个顺序继续：

1. 用 `admin` 登录 production
2. 先录正式商品分类检查
3. 录正式商品
4. 配正式 Banner
5. 配正式公告
6. 配正式优惠券模板
7. 用真实账号做第一轮正式验收

不要在 production 里再造测试账号、测试订单、测试 Banner。

---

## 九、如果 staging 初始化失败，怎么回滚

先找到 staging 的备份目录：

```bash
ls -l /root/cloud-store-staging/backups/manual
```

然后回滚：

```bash
cd /root/cloud-store-staging
sudo BASE_DIR=/root/cloud-store-staging PM2_APP_NAME=cloud-store-staging bash /root/cloud-store-staging/deploy/scripts/rollback-release-pm2.sh /root/cloud-store-staging/backups/manual/你的备份目录
```

回滚后再执行：

```bash
APP_PORT=3001 PUBLIC_URL=https://staging.putiguoguo.com/healthz bash /root/cloud-store-staging/deploy/scripts/check-health.sh
pm2 logs cloud-store-staging --lines 50
```

---

## 十、如果 production 初始化失败，怎么回滚

先找到 production 的备份目录：

```bash
ls -l /root/cloud-store/backups/manual
```

然后回滚：

```bash
cd /root/cloud-store
sudo BASE_DIR=/root/cloud-store PM2_APP_NAME=cloud-store bash /root/cloud-store/deploy/scripts/rollback-release-pm2.sh /root/cloud-store/backups/manual/你的备份目录
```

回滚后再执行：

```bash
bash /root/cloud-store/deploy/scripts/check-health.sh
pm2 logs cloud-store --lines 50
```

---

## 十一、你这次最容易犯错的 5 个地方

### 1. 在 production 目录里跑了 staging 命令

避免方法：

- 每次先看当前目录
- 每次先看 PM2 app 名称

### 2. 把 `cloud-store` 和 `cloud-store-staging` 搞混

避免方法：

- 正式环境只认 `cloud-store`
- 测试环境只认 `cloud-store-staging`

### 3. 以为 staging 也会变成“空系统”

不会。

staging reset 后会自动回填测试基线，目的是继续测试。

### 4. 以为 production reset 后还能继续做测试

不建议。

production reset 后就该开始录正式数据。

### 5. 没确认备份目录就直接跑 reset

避免方法：

- 先看 `backups/manual`
- 再输入确认口令

---

## 十二、这次最推荐你直接照抄的完整顺序

```bash
pm2 status
sudo systemctl status nginx --no-pager
curl http://127.0.0.1:3000/healthz
curl http://127.0.0.1:3001/healthz

sudo bash /root/cloud-store/deploy/scripts/backup-manual.sh before-dual-init-production
sudo BASE_DIR=/root/cloud-store-staging SITE_SLUG=cloud-store-staging bash /root/cloud-store-staging/deploy/scripts/backup-manual.sh before-dual-init-staging

cd /root/cloud-store-staging
sudo BASE_DIR=/root/cloud-store-staging APP_NAME=cloud-store-staging APP_PORT=3001 bash /root/cloud-store-staging/deploy/scripts/reset-staging-data.sh

APP_PORT=3001 PUBLIC_URL=https://staging.putiguoguo.com/healthz bash /root/cloud-store-staging/deploy/scripts/check-health.sh

cd /root/cloud-store
sudo bash /root/cloud-store/deploy/scripts/reset-launch-data.sh

bash /root/cloud-store/deploy/scripts/check-health.sh
```

如果你这次只想按最稳的方式做，就照这段顺序执行。
