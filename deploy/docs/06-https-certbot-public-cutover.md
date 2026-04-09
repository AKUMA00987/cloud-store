# 日精月华 Phase 14 HTTPS、正式切换与回滚教程

这份教程解决 4 件事：

1. 用 `Let's Encrypt + Certbot + Nginx` 申请证书
2. 开启正式 HTTPS
3. 让 HTTP 和 `www` 都跳到正式主域名
4. 如果出错，退回到上一个可用状态

这份教程默认你已经完成：

- `root/deploy/docs/05-domain-dns-http-prep.md`

也就是：

- 裸域和 `www` 都已经解析到 ECS
- `http://你的域名` 已经能打开
- `http://www.你的域名` 也已经能打开

## 一、这次最终要达到的效果

当前默认最终目标是：

- 正式主域名：`https://你的域名`
- `http://你的域名` 会跳到 `https://你的域名`
- `http://www.你的域名` 会跳到 `https://你的域名`
- `https://www.你的域名` 也会跳到 `https://你的域名`

也就是说，浏览器最后应该统一停在：

```text
https://你的域名
```

## 二、开始前先再确认 4 件事

### 第 1 件：安全组已经放行 443

在阿里云控制台确认入方向有：

- TCP `443`

### 第 2 件：Nginx 正常

执行：

```bash
sudo systemctl status nginx --no-pager
sudo nginx -t
```

### 第 3 件：网站当前 HTTP 正常

执行：

```bash
curl -I http://你的域名
curl -I http://www.你的域名
```

### 第 4 件：先手动做一份备份

执行：

```bash
sudo bash /root/cloud-store/deploy/scripts/backup-manual.sh
```

记住新生成的备份目录。

## 三、安装 Certbot

如果你的服务器还没装 Certbot，先执行：

```bash
sudo apt update
sudo apt install -y certbot python3-certbot-nginx
```

### 安装完后检查

执行：

```bash
certbot --version
```

能看到版本号就说明安装成功。

## 四、先把当前 Nginx 配置备份一份

你的服务器现在实际更可能使用：

- `/etc/nginx/sites-available/cloud-store.conf`

所以先执行：

```bash
sudo cp /etc/nginx/sites-available/cloud-store.conf /etc/nginx/sites-available/cloud-store.conf.before-phase14
```

如果你的实际生效文件不在这里，就按你服务器当前真实路径备份。

## 五、用 Certbot 为双域名申请证书

把下面的 `你的域名` 换成真实域名后执行：

```bash
sudo certbot --nginx -d 你的域名 -d www.你的域名
```

例如：

```bash
sudo certbot --nginx -d example.com -d www.example.com
```

### 执行过程中会发生什么

通常会看到：

1. 输入邮箱
2. 同意协议
3. 询问是否愿意接收通知
4. Certbot 自动修改 Nginx
5. 申请证书

### 成功时你会看到什么

通常会看到类似：

```text
Successfully received certificate
Congratulations! You have successfully enabled HTTPS
```

### 如果出现“证书申请成功，但无法自动安装”

像下面这种提示：

```text
Successfully received certificate
Could not install certificate
Could not automatically find a matching server block
```

不要慌，这表示：

- 证书已经申请成功
- 私钥也已经生成成功
- 只是 Certbot 没法自动把证书写进你当前的 Nginx 配置

这时不要反复重跑 `certbot install`。  
更稳的做法是：直接按下面的“手动写入 Nginx 证书配置”继续走。

## 六、如果 Certbot 没自动安装成功，手动把证书写进 Nginx

如果你刚才遇到的是“证书已签发，但安装失败”，按下面做。

### 第 1 步：打开当前 Nginx 配置

通常是：

```bash
sudo nano /etc/nginx/sites-available/cloud-store.conf
```

### 第 2 步：把配置替换成 HTTPS 正式版

把下面这份内容里的 `你的域名` 改成真实域名后，整体替换进去：

```nginx
server {
    listen 80;
    server_name 你的域名 www.你的域名;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://你的域名$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name 你的域名;

    ssl_certificate /etc/letsencrypt/live/你的域名/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/你的域名/privkey.pem;

    client_max_body_size 6m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection \"\";
        proxy_read_timeout 60s;
        proxy_connect_timeout 10s;
    }
}

server {
    listen 443 ssl http2;
    server_name www.你的域名;

    ssl_certificate /etc/letsencrypt/live/你的域名/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/你的域名/privkey.pem;

    return 301 https://你的域名$request_uri;
}
```

如果你不想手敲，也可以直接参考并对照这份模板：

- `root/deploy/nginx/cloud-store-https.conf.example`

### 第 3 步：检查 Nginx 配置

```bash
sudo nginx -t
```

你要看到：

```text
syntax is ok
test is successful
```

### 第 4 步：重启 Nginx

```bash
sudo systemctl restart nginx
sudo systemctl status nginx --no-pager
```

成功时应看到：

- `active (running)`

### 第 5 步：先在服务器本机验证

```bash
curl -I https://你的域名
curl -I https://www.你的域名
```

预期结果：

- `https://你的域名` 能返回正常响应
- `https://www.你的域名` 会跳转到 `https://你的域名`

完成这一步后，再继续下面的正式验收。

## 七、如果 Certbot 成功了，先不要马上结束

你还要继续做 3 个检查。

### 检查 1：Nginx 配置是否还有效

```bash
sudo nginx -t
```

如果不是：

```text
syntax is ok
test is successful
```

先不要继续。

### 检查 2：Nginx 是否正常运行

```bash
sudo systemctl restart nginx
sudo systemctl status nginx --no-pager
```

### 检查 3：HTTPS 是否能打开

```bash
curl -I https://你的域名
curl -I https://www.你的域名
```

## 八、把 `www` 和 HTTP 都统一跳到主域名

如果 Certbot 没自动帮你得到你想要的最终跳转效果，就按我们固定的口径手工收口：

- 主域名：裸域
- 跳转域名：`www`

你可以参考下面这份示例模板：

- `root/deploy/nginx/cloud-store-https.conf.example`

这个模板表达的是同一件事：

1. `http://你的域名` 跳到 `https://你的域名`
2. `http://www.你的域名` 跳到 `https://你的域名`
3. `https://www.你的域名` 跳到 `https://你的域名`
4. 真正承载网站内容的是：

```text
https://你的域名
```

## 九、正式切换后要验证哪些页面

不要只看首页。

至少检查下面这些：

### 1. 首页

打开：

```text
https://你的域名
```

应该能正常看到首页，不再提示不安全。

### 2. 登录

进入登录页，尝试正常登录。

### 3. 商品详情

打开任意商品详情，确认页面、图片、价格、规格区域都正常。

### 4. 确认订单 / 待支付页

至少走到待支付页，确认不是只首页能开，交易链路也能开。

### 5. 后台入口

确认管理端 / 农户端入口仍能登录和打开。

### 6. 图片资源

检查商品图、上传图、Banner 图有没有混成打不开、跨协议警告、404。

## 十、怎么判断这次正式切换真的成功了

满足下面这些，才算成功：

1. `https://你的域名` 能打开
2. 浏览器不再提示不安全
3. `http://你的域名` 自动跳到 `https://你的域名`
4. `http://www.你的域名` 自动跳到 `https://你的域名`
5. `https://www.你的域名` 自动跳到 `https://你的域名`
6. 首页、登录、商品详情、待支付、后台入口、图片资源都正常

## 十一、怎么检查证书续期

执行：

```bash
sudo certbot renew --dry-run
```

如果这个命令通过，说明续期链路基本正常。

## 十二、如果出错，怎么回滚

按下面顺序，不要乱改。

### 场景 1：Certbot 申请失败

如果证书没申请下来：

- 不要强行启用 443 配置
- 继续保留当前 HTTP 可用状态
- 先解决域名解析、80 端口或 Nginx 问题

这时通常不用回滚，因为正式切换还没完成。

### 场景 1.5：证书申请成功，但自动安装失败

如果你看到的是：

- 证书已签发成功
- 但 Certbot 提示 `Could not install certificate`

那通常不用回滚。

你应该做的是：

1. 保留已经申请到的证书文件
2. 手动把证书路径写进 Nginx
3. 跑 `sudo nginx -t`
4. 重启 Nginx
5. 再重新验证 HTTPS

这属于“自动安装失败”，不是“证书申请失败”。

### 场景 2：Nginx 改坏了，网站打不开

先恢复备份前的 Nginx 配置：

```bash
sudo cp /etc/nginx/sites-available/cloud-store.conf.before-phase14 /etc/nginx/sites-available/cloud-store.conf
```

然后执行：

```bash
sudo nginx -t
sudo systemctl restart nginx
```

### 场景 3：HTTPS 有问题，但原来的 HTTP/IP 还想先保住

如果正式域名切换后有问题，你可以先恢复到“公网 IP + HTTP 可用”的旧状态：

1. 恢复 Phase 14 前的 Nginx 配置
2. 重启 Nginx
3. 用浏览器重新验证：

```text
http://公网IP
```

### 场景 4：改乱得比较多，想整套退回

找到你 Phase 14 前刚做的手动备份目录，然后执行：

```bash
sudo bash /root/cloud-store/deploy/scripts/rollback-release-pm2.sh /root/cloud-store/backups/manual/你的备份目录
```

再按顺序检查：

```bash
pm2 status
sudo systemctl status nginx --no-pager
bash /root/cloud-store/deploy/scripts/check-health.sh
```

## 十三、这一步做完以后，你应该达到什么状态

完成本教程后，你应该达到：

- 正式域名可访问
- HTTPS 可访问
- 浏览器地址最终统一到主域名
- 原来的公网 IP HTTP 基线仍有可回退路径

如果这些都满足，Phase 14 才算真正完成。
