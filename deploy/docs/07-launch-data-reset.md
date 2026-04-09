# 07. 正式上线前的数据初始化教程

这份教程只用于一个场景：

- 网站功能已经验收完
- 你准备正式对外上线
- 想把测试期留下的新闻、活动、商品、订单、用户等数据全部清空
- 但必须保留 `admin` 账号继续登录后台

这套初始化脚本已经按你当前服务器真实目录写死为：

- 项目目录：`/root/cloud-store`
- 后端入口：`/root/cloud-store/server.js`
- 前端入口：`/root/cloud-store/public/index.html`
- 数据库：`/root/cloud-store/cloud-store.sqlite`
- 应用进程：`PM2`
- 反向代理：`Nginx`

---

## 一、这套初始化会清掉什么

会清空这些数据：

- 商品
- 首页 Banner
- 公告 / 新闻
- 优惠券模板 / 活动券模板
- 购物车
- 订单
- 订单商品明细
- 待支付记录
- 退款单
- 售后台账
- 库存流水
- 登录会话
- 所有非 `admin` 用户
- 所有用户地址
- 所有用户领券记录

---

## 二、这套初始化会保留什么

会保留这些内容：

- `admin` 账号本身
- `admin` 当前密码
- 商品分类
- 上传图片文件目录 `public/uploads`
- Nginx 配置
- PM2 应用名 `cloud-store`

说明：

- `admin` 会被重置成干净状态，但账号和密码不会删掉。
- `admin` 的地址、购物车、订单、领券、会员累计数据会被清空。
- 商品分类默认保留，这样你上线后可以直接开始录入正式商品。
- 上传图片文件不会自动删掉，因为这类文件有时还会复用；如果后面你确认测试图片也不要了，再手动清理。

---

## 三、为什么不能直接手动删数据库里的几张表

因为当前系统为了本地演示体验，带有“默认示例数据自动补种”机制。

如果只手动删掉：

- 商品
- Banner
- 公告
- 优惠券模板

下一次服务启动或访问相关接口时，这些默认演示数据可能又会自动回来。

所以这次初始化脚本会额外做一件事：

- 在 `/root/cloud-store/.disable-default-seed` 写入标记文件

这个标记文件存在时，系统就不会再自动回灌默认商品、Banner、公告和优惠券模板。

---

## 四、正式执行前，你先确认 3 件事

### 1. 网站现在是正常的

执行：

```bash
pm2 status
sudo systemctl status nginx --no-pager
bash /root/cloud-store/deploy/scripts/check-health.sh
```

你要确认：

- `cloud-store` 是 `online`
- `nginx` 是 `active (running)`
- 健康检查通过

### 2. 你已经做过一次手动备份

如果还没做，也没关系，脚本本身会先自动执行：

```bash
/root/cloud-store/deploy/scripts/backup-manual.sh before-launch-data-reset
```

### 3. 你确定现在这些数据都不要了

因为执行后会清掉测试期数据。

---

## 五、正式执行命令

在服务器终端执行：

```bash
sudo bash /root/cloud-store/deploy/scripts/reset-launch-data.sh
```

执行后，终端会要求你手动输入：

```text
RESET_LAUNCH_DATA
```

只有完整输入这串确认文字，脚本才会继续。

---

## 六、脚本内部实际做了什么

这套脚本会按这个顺序执行：

1. 先做一份手动备份
2. 暂停 PM2 中的 `cloud-store`
3. 清空正式上线前不该保留的数据
4. 保留 `admin` 账号和密码
5. 写入 `.disable-default-seed`，防止默认演示数据再自动长回来
6. 重启 `cloud-store`
7. 执行健康检查

---

## 七、执行成功后怎么验证

### 1. 先看脚本有没有报错

如果脚本最后出现类似：

```text
launch data reset finished successfully.
```

说明脚本已经跑完。

### 2. 再看基础运行状态

执行：

```bash
pm2 status
sudo systemctl status nginx --no-pager
bash /root/cloud-store/deploy/scripts/check-health.sh
```

你要确认：

- `cloud-store` 是 `online`
- `nginx` 是 `active (running)`
- 健康检查通过

### 3. 再登录后台做人工验收

用 `admin` 登录后台，重点确认：

- 商品列表为空
- Banner 列表为空
- 公告 / 新闻列表为空
- 优惠券模板为空
- 用户列表里只剩 `admin`
- 订单列表为空
- 退款列表为空

### 4. 再看默认演示数据是否真的不会回来了

重启一次应用后再看：

```bash
pm2 restart cloud-store
```

然后再刷新后台页面确认：

- 商品不会自动回来
- Banner 不会自动回来
- 公告不会自动回来
- 优惠券模板不会自动回来

---

## 八、如果执行失败，怎么回滚

### 场景 1：脚本中途失败，但网站还能进

先看最近日志：

```bash
pm2 logs cloud-store --lines 30
```

如果只是中途失败，优先不要重复乱跑，先把报错内容记录下来。

### 场景 2：你想完整恢复到初始化之前

先找到刚才自动生成的备份目录。

手动备份一般在：

```bash
/root/cloud-store/backups/manual/
```

例如：

```bash
ls -l /root/cloud-store/backups/manual
```

你会看到类似：

```text
20260410-xxxxxx-before-launch-data-reset
```

然后执行 PM2 版回滚：

```bash
sudo bash /root/cloud-store/deploy/scripts/rollback-release-pm2.sh /root/cloud-store/backups/manual/你的备份目录名
```

---

## 九、如果你想恢复“默认演示数据自动补种”

一般正式上线后不建议这样做。

但如果你只是想回到测试演示状态，可以删除这个文件：

```bash
sudo rm -f /root/cloud-store/.disable-default-seed
```

然后重启应用：

```bash
pm2 restart cloud-store
```

注意：

- 删除这个标记文件后，如果商品 / Banner / 公告 / 优惠券模板仍为空，系统下一次访问相关接口时就可能再次自动补种默认演示数据。

---

## 十、正式上线前的推荐顺序

推荐你按这个顺序做：

1. 先确认网站功能、域名、HTTPS 都正常
2. 备份当前数据
3. 跑这份初始化脚本
4. 用 `admin` 登录后台
5. 录入正式 Banner、公告、商品和活动配置
6. 再开始正式对外使用
