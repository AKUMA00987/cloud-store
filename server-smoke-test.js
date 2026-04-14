const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:3000';

class SessionClient {
  constructor() {
    this.cookie = '';
  }

  async request(pathname, options) {
    const config = Object.assign({}, options || {});
    config.headers = Object.assign({}, config.headers || {});
    if (this.cookie) config.headers.Cookie = this.cookie;
    const response = await fetch(baseUrl + pathname, config);
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    return response;
  }

  async requestJson(pathname, options) {
    const response = await this.request(pathname, options);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(pathname + ' 请求失败: ' + response.status + ' ' + text);
    }
    return response.json();
  }

  async requestError(pathname, options) {
    const response = await this.request(pathname, options);
    const payload = await response.json().catch(async function () {
      return { message: await response.text() };
    });
    assert(!response.ok, pathname + ' 应返回失败结果');
    return { status: response.status, body: payload || {} };
  }
}

function openDatabase() {
  const dbFilePath = path.resolve(process.env.CLOUD_STORE_DB_PATH || path.join(__dirname, 'cloud-store.sqlite'));
  const connection = new sqlite3.Database(dbFilePath);
  return {
    run(sql, params) {
      return new Promise(function (resolve, reject) {
        connection.run(sql, params || [], function (error) {
          if (error) reject(error);
          else resolve(this);
        });
      });
    },
    get(sql, params) {
      return new Promise(function (resolve, reject) {
        connection.get(sql, params || [], function (error, row) {
          if (error) reject(error);
          else resolve(row);
        });
      });
    },
    all(sql, params) {
      return new Promise(function (resolve, reject) {
        connection.all(sql, params || [], function (error, rows) {
          if (error) reject(error);
          else resolve(rows || []);
        });
      });
    },
    close() {
      return new Promise(function (resolve, reject) {
        connection.close(function (error) {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  };
}

function resolveUploadFilePath(uploadUrl) {
  const uploadRoot = path.resolve(process.env.CLOUD_STORE_UPLOAD_ROOT || path.join(__dirname, 'public', 'uploads'));
  const relativePath = String(uploadUrl || '').replace(/^\/uploads\/?/, '').replace(/\//g, path.sep);
  return path.join(uploadRoot, relativePath);
}

function buildAlipaySignContent(params, options) {
  const config = Object.assign({ excludeSignType: true }, options || {});
  return Object.keys(params || {})
    .filter(function (key) {
      const value = params[key];
      if (key === 'sign') return false;
      if (config.excludeSignType && key === 'sign_type') return false;
      return value !== null && value !== undefined && value !== '';
    })
    .sort()
    .map(function (key) {
      return key + '=' + String(params[key]);
    })
    .join('&');
}

function signAlipayPayload(params, privateKey) {
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(buildAlipaySignContent(params, { excludeSignType: true }), 'utf8');
  return signer.sign(privateKey, 'base64');
}

function parseEnvFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

const localMockPaymentEnabled = parseEnvFlag(process.env.CS_ENABLE_LOCAL_MOCK_PAYMENT)
  && String(process.env.NODE_ENV || '').trim() !== 'production';
const alipayTestPrivateKey = String(process.env.TEST_ALIPAY_PRIVATE_KEY || '').trim();
const wechatPayEnabled = parseEnvFlag(process.env.WECHAT_PAY_ENABLED);
let alipayTradeCounter = 1;
let wechatTradeCounter = 1;

function nextAlipayTradeNo() {
  const suffix = String(alipayTradeCounter).padStart(6, '0');
  alipayTradeCounter += 1;
  return '202604130000' + suffix;
}

function buildTestAlipayNotifyPayload(launch, order, overrides) {
  return Object.assign({
    app_id: String(process.env.ALIPAY_APP_ID || '').trim(),
    charset: 'utf-8',
    method: 'alipay.trade.wap.pay.return',
    notify_time: '2026-04-13 10:00:00',
    notify_type: 'trade_status_sync',
    out_trade_no: String(launch && launch.paymentTransaction && launch.paymentTransaction.externalTradeNo || ''),
    seller_id: String(process.env.ALIPAY_SELLER_ID || '').trim(),
    subject: '测试订单',
    total_amount: Number(order && order.total || 0).toFixed(2),
    trade_no: nextAlipayTradeNo(),
    trade_status: 'TRADE_SUCCESS',
    buyer_id: '2088123412341234',
    sign_type: 'RSA2'
  }, overrides || {});
}

function nextWechatTradeNo() {
  const suffix = String(wechatTradeCounter).padStart(6, '0');
  wechatTradeCounter += 1;
  return 'wx202604130000' + suffix;
}

function buildTestWechatNotifyPayload(launch, order, overrides) {
  return Object.assign({
    id: 'wx_notify_' + Date.now(),
    create_time: '2026-04-13T10:00:00+08:00',
    event_type: 'TRANSACTION.SUCCESS',
    resource_type: 'encrypt-resource',
    transaction: {
      out_trade_no: String(launch && launch.paymentTransaction && launch.paymentTransaction.externalTradeNo || ''),
      transaction_id: nextWechatTradeNo(),
      trade_state: 'SUCCESS',
      trade_type: launch && launch.channel === 'wechat_h5_inapp' ? 'JSAPI' : 'H5',
      amount: {
        total: Math.round(Number(order && order.total || 0) * 100),
        currency: 'CNY'
      },
      payer: {
        openid: launch && launch.channel === 'wechat_h5_inapp' ? 'openid-smoke-001' : ''
      }
    }
  }, overrides || {});
}

async function settlePendingOrder(client, preparedOrder, options) {
  const config = Object.assign({
    label: '待支付订单',
    channel: 'alipay_wap',
    headers: {},
    expectMockEnabled: false,
    repeatNotify: false
  }, options || {});
  if (config.channel === 'alipay_wap' && alipayTestPrivateKey) {
    const launch = await client.requestJson('/api/orders/' + encodeURIComponent(preparedOrder.id) + '/alipay-wap', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, config.headers || {}),
      body: JSON.stringify({})
    });
    assert(launch.channel === 'alipay_wap', config.label + ' 应返回 alipay_wap 渠道');
    assert(launch.method === 'POST', config.label + ' 应返回 POST 表单方式');
    assert(launch.params && launch.params.method === 'alipay.trade.wap.pay', config.label + ' 应返回手机网站支付 method');
    assert(launch.paymentTransaction && launch.paymentTransaction.channel === 'alipay_wap', config.label + ' 应切到 alipay_wap 流水');

    const pendingStatusPayload = await client.requestJson('/api/orders/' + encodeURIComponent(preparedOrder.id) + '/payment-status', {
      headers: Object.assign({}, config.headers || {})
    });
    assert(pendingStatusPayload.awaitingAsyncNotify === true, config.label + ' 在异步通知前应处于等待确认状态');

    const notifyPayload = buildTestAlipayNotifyPayload(launch, preparedOrder, config.notifyOverrides);
    notifyPayload.sign = signAlipayPayload(notifyPayload, alipayTestPrivateKey);
    const notifyResponse = await client.request('/api/payments/alipay/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(notifyPayload).toString()
    });
    assert(notifyResponse.ok, config.label + ' 的支付宝异步通知应返回成功');
    assert((await notifyResponse.text()) === 'success', config.label + ' 的支付宝异步通知成功时应返回 success');

    const paidStatusPayload = await client.requestJson('/api/orders/' + encodeURIComponent(preparedOrder.id) + '/payment-status?returnCheck=1', {
      headers: Object.assign({}, config.headers || {})
    });
    assert(paidStatusPayload.order && paidStatusPayload.order.status === 'paid', config.label + ' 在异步通知后应进入已支付');
    assert(paidStatusPayload.paymentTransaction && paidStatusPayload.paymentTransaction.channel === 'alipay_wap', config.label + ' 的支付流水应保持 alipay_wap');

    if (config.repeatNotify) {
      const repeatNotifyResponse = await client.request('/api/payments/alipay/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(notifyPayload).toString()
      });
      assert(repeatNotifyResponse.ok, config.label + ' 的重复异步通知也应返回成功');
    }

    return {
      order: paidStatusPayload.order,
      launch: launch,
      paymentStatus: paidStatusPayload,
      notifyPayload: notifyPayload
    };
  }

  if (config.channel === 'wechat_h5_inapp' || config.channel === 'wechat_h5_external') {
    assert(wechatPayEnabled, config.label + ' 需要启用 WECHAT_PAY_ENABLED=true');
    const launchPath = config.channel === 'wechat_h5_inapp' ? '/wechat-inapp-h5' : '/wechat-external-h5';
    const launch = await client.requestJson('/api/orders/' + encodeURIComponent(preparedOrder.id) + launchPath, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, config.headers || {}),
      body: JSON.stringify({})
    });
    assert(launch.channel === config.channel, config.label + ' 应返回对应微信渠道');
    assert(launch.method === 'POST', config.label + ' 应返回 POST 表单方式');
    assert(launch.params && launch.params.trade_type === (config.channel === 'wechat_h5_inapp' ? 'JSAPI' : 'H5'), config.label + ' 应返回对应微信 trade_type');
    assert(launch.paymentTransaction && launch.paymentTransaction.channel === config.channel, config.label + ' 应切到对应微信流水');

    const pendingStatusPayload = await client.requestJson('/api/orders/' + encodeURIComponent(preparedOrder.id) + '/payment-status', {
      headers: Object.assign({}, config.headers || {})
    });
    assert(pendingStatusPayload.awaitingAsyncNotify === true, config.label + ' 在异步通知前应处于等待确认状态');

    const notifyPayload = buildTestWechatNotifyPayload(launch, preparedOrder, config.notifyOverrides);
    const notifyResponse = await client.request('/api/payments/wechat/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(notifyPayload)
    });
    assert(notifyResponse.ok, config.label + ' 的微信异步通知应返回成功');
    const notifyBody = await notifyResponse.json();
    assert(notifyBody && notifyBody.code === 'SUCCESS', config.label + ' 的微信异步通知成功时应返回 SUCCESS');

    const paidStatusPayload = await client.requestJson('/api/orders/' + encodeURIComponent(preparedOrder.id) + '/payment-status?returnCheck=1', {
      headers: Object.assign({}, config.headers || {})
    });
    assert(paidStatusPayload.order && paidStatusPayload.order.status === 'paid', config.label + ' 在异步通知后应进入已支付');
    assert(paidStatusPayload.paymentTransaction && paidStatusPayload.paymentTransaction.channel === config.channel, config.label + ' 的支付流水应保持微信渠道');

    if (config.repeatNotify) {
      const repeatNotifyResponse = await client.request('/api/payments/wechat/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(notifyPayload)
      });
      assert(repeatNotifyResponse.ok, config.label + ' 的重复异步通知也应返回成功');
    }

    return {
      order: paidStatusPayload.order,
      launch: launch,
      paymentStatus: paidStatusPayload,
      notifyPayload: notifyPayload
    };
  }

  assert(localMockPaymentEnabled, 'server smoke 默认已切到真实支付宝结算链路；若要继续使用 /pay 调试，请显式设置 CS_ENABLE_LOCAL_MOCK_PAYMENT=true 且保持非 production');
  const paidOrder = await client.requestJson('/api/orders/' + encodeURIComponent(preparedOrder.id) + '/pay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert(paidOrder.status === 'paid', config.label + ' 的本地 mock 支付分支应能进入已支付');
  return {
    order: paidOrder,
    launch: null,
    paymentStatus: null,
    notifyPayload: null
  };
}

function countCsvDataRows(csvText) {
  const normalized = String(csvText || '').replace(/^\uFEFF/, '');
  const lines = normalized.split(/\r?\n/).filter(function (line) {
    return String(line || '').trim() !== '';
  });
  return Math.max(0, lines.length - 1);
}

async function fetchShipmentRowsBySourceOrderId(sourceOrderId) {
  const db = openDatabase();
  try {
    return await db.all(
      'SELECT id, orderSourceId, trackingNo, logisticsSummary, logisticsState, lastLogisticsQueryAt, lastLogisticsSuccessAt FROM shipments WHERE orderSourceId = ? ORDER BY createdAt ASC, id ASC',
      [String(sourceOrderId || '').trim()]
    );
  } finally {
    await db.close();
  }
}

async function updateShipmentByOrderId(sourceOrderId, values) {
  const db = openDatabase();
  try {
    const row = await db.get('SELECT id FROM shipments WHERE orderSourceId = ? ORDER BY createdAt ASC, id ASC LIMIT 1', [String(sourceOrderId || '').trim()]);
    if (!row || !row.id) throw new Error('未找到运单');
    const payload = Object.assign({}, values || {});
    const keys = Object.keys(payload);
    if (!keys.length) return row.id;
    await db.run(
      'UPDATE shipments SET ' + keys.map(function (key) { return key + ' = ?'; }).join(', ') + ' WHERE id = ?',
      keys.map(function (key) { return payload[key]; }).concat([row.id])
    );
    return row.id;
  } finally {
    await db.close();
  }
}

async function readLatestSmsCode(phone, purpose) {
  const db = openDatabase();
  try {
    const row = await db.get(
      'SELECT code FROM sms_verification_codes WHERE phone = ? AND purpose = ? ORDER BY createdAt DESC, id DESC LIMIT 1',
      [String(phone || '').trim(), String(purpose || '').trim()]
    );
    return row && row.code ? String(row.code) : '';
  } finally {
    await db.close();
  }
}

async function readSmsVerificationRows(phone, purpose) {
  const db = openDatabase();
  try {
    const rows = await db.all(
      'SELECT id, code, createdAt, expiresAt, resendAvailableAt, consumedAt, invalidatedAt FROM sms_verification_codes WHERE phone = ? AND purpose = ? ORDER BY createdAt ASC, id ASC',
      [String(phone || '').trim(), String(purpose || '').trim()]
    );
    return Array.isArray(rows) ? rows.map(function (row) {
      return {
        id: Number(row.id || 0),
        code: String(row.code || ''),
        createdAt: Number(row.createdAt || 0),
        expiresAt: Number(row.expiresAt || 0),
        resendAvailableAt: Number(row.resendAvailableAt || 0),
        consumedAt: Number(row.consumedAt || 0),
        invalidatedAt: Number(row.invalidatedAt || 0)
      };
    }) : [];
  } finally {
    await db.close();
  }
}

async function reopenSmsResendWindow(phone, purpose) {
  const db = openDatabase();
  try {
    await db.run(
      'UPDATE sms_verification_codes SET resendAvailableAt = ? WHERE phone = ? AND purpose = ?',
      [Date.now() - 1000, String(phone || '').trim(), String(purpose || '').trim()]
    );
  } finally {
    await db.close();
  }
}

async function clearSmsCodes(phone, purpose) {
  const db = openDatabase();
  try {
    await db.run(
      'DELETE FROM sms_verification_codes WHERE phone = ? AND purpose = ?',
      [String(phone || '').trim(), String(purpose || '').trim()]
    );
  } finally {
    await db.close();
  }
}

async function main() {
  const anonClient = new SessionClient();
  const homeResponse = await anonClient.request('/');
  assert(homeResponse.ok, '首页应可正常访问');
  const healthPayload = await anonClient.requestJson('/healthz');
  const runtimePayload = await anonClient.requestJson('/api/runtime-meta');
  assert(healthPayload && healthPayload.ok === true, '健康检查接口应返回 ok=true');
  assert(healthPayload.service === 'cloud-store', '健康检查接口应返回服务标识');
  assert(healthPayload.storage && healthPayload.storage.database, '健康检查接口应返回最小运行状态');
  assert(runtimePayload && runtimePayload.env, 'runtime-meta 应返回环境标识');
  assert(typeof runtimePayload.isStaging === 'boolean', 'runtime-meta 应返回是否 staging');
  assert(healthPayload.runtime && healthPayload.runtime.env === runtimePayload.env, 'healthz 与 runtime-meta 应返回相同环境');
  if (process.env.CLOUD_STORE_DB_PATH) {
    assert(
      runtimePayload.paths && runtimePayload.paths.database === path.basename(path.resolve(process.env.CLOUD_STORE_DB_PATH)),
      'runtime-meta 应返回当前独立数据库文件名'
    );
  }
  if (process.env.CLOUD_STORE_UPLOAD_ROOT) {
    assert(
      runtimePayload.paths && runtimePayload.paths.uploads === path.basename(path.resolve(process.env.CLOUD_STORE_UPLOAD_ROOT)),
      'runtime-meta 应返回当前独立 uploads 目录名'
    );
  }
  if (String(process.env.CLOUD_STORE_RUNTIME_ENV || '').trim().toLowerCase() === 'staging') {
    assert(runtimePayload.isStaging === true, 'staging 启动时 runtime-meta 应明确标记为 staging');
    if (process.env.BASE_URL) {
      assert(String(runtimePayload.host || '').indexOf('127.0.0.1') > -1, 'staging rehearse 应返回独立监听 host');
    }
    assert(String(homeResponse.headers.get('x-robots-tag') || '').toLowerCase().indexOf('noindex') >= 0, 'staging 首页响应应带 noindex 边界');
  }

  const publicProducts = await anonClient.requestJson('/api/products');
  const publicProductPage = await anonClient.requestJson('/api/products?page=1&pageSize=2&status=active');
  const publicProduct = publicProducts.find(function (item) {
    return item
      && item.id
      && item.shippingAddressId
      && item.shippingAddressSnapshot
      && item.shippingAddressSnapshot.full
      && Array.isArray(item.variants)
      && item.variants.some(function (variant) {
        return Array.isArray(variant && variant.units) && variant.units.some(function (unit) {
          return Number(unit && unit.stock || 0) > 0;
        });
      });
  }) || publicProducts[0];
  assert(Array.isArray(publicProducts) && publicProducts.length > 0, '公开商品接口应返回在售商品');
  assert(Array.isArray(publicProductPage.items) && publicProductPage.items.length > 0, '公开商品分页接口应返回 items');
  assert(publicProductPage.meta && publicProductPage.meta.page === 1, '公开商品分页接口应返回 meta');
  assert(publicProduct && publicProduct.id, '应能拿到至少一条公开商品');

  const productDetail = await anonClient.requestJson('/api/products/' + encodeURIComponent(publicProduct.id));
  assert(Number(productDetail.id || 0) === Number(publicProduct.id || 0), '公开商品详情接口应可返回指定商品');

  const searchKeyword = String(publicProduct.name || '').trim().slice(0, 2);
  const searchProducts = await anonClient.requestJson('/api/products/search?q=' + encodeURIComponent(searchKeyword));
  assert(Array.isArray(searchProducts) && searchProducts.length > 0, '公开搜索接口应返回商品');

  const publicCategories = await anonClient.requestJson('/api/categories');
  const publicBanners = await anonClient.requestJson('/api/banners');
  const publicAnnouncements = await anonClient.requestJson('/api/announcements');
  const publicCouponTemplates = await anonClient.requestJson('/api/coupon-templates');
  assert(Array.isArray(publicCategories), '分类接口应可公开访问');
  assert(Array.isArray(publicBanners), 'Banner 接口应可公开访问');
  assert(Array.isArray(publicAnnouncements), '公告接口应可公开访问');
  assert(Array.isArray(publicCouponTemplates), '优惠券模板接口应可公开访问');

  const anonUsersError = await anonClient.requestError('/api/users');
  assert(anonUsersError.status === 401, '匿名访问 /api/users 应被拦截');

  const anonUploadError = await anonClient.requestError('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      folder: 'smoke',
      fileName: 'tiny.png',
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9p0rG9sAAAAASUVORK5CYII='
    })
  });
  assert(anonUploadError.status === 403, '匿名上传应被拦截');

  const anonProductSaveError = await anonClient.requestError('/api/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({}, publicProduct, { id: 0, name: '匿名不能新增' }))
  });
  assert(anonProductSaveError.status === 403, '匿名保存商品应被拦截');

  const buyerClient = new SessionClient();
  const buyerPhone = '139' + String(Date.now()).slice(-8);
  const buyerPassword = 'buyer123456';
  const phoneLoginSmsPayload = await anonClient.requestJson('/api/auth/send-sms-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: buyerPhone, purpose: 'login_or_register' })
  });
  assert(phoneLoginSmsPayload.ok === true, '手机号登录/注册应能获取验证码');
  assert(phoneLoginSmsPayload.autoRegisterOnVerify === true, '新手机号应在验证码通过后自动创建账号');
  const phoneLoginCode = String(phoneLoginSmsPayload.debugCode || '') || await readLatestSmsCode(buyerPhone, 'login_or_register');
  assert(/^\d{6}$/.test(phoneLoginCode), '手机号登录验证码应可通过显式 debug 或本地记录获取');
  const registeredBuyer = await buyerClient.requestJson('/api/auth/login-sms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: buyerPhone, code: phoneLoginCode })
  });
  const buyerUsername = registeredBuyer.username;
  assert(buyerUsername, '手机号验证码首次登录应返回自动生成的内部账号');
  assert(registeredBuyer.autoRegistered === true, '新手机号验证码登录应自动注册');
  assert(registeredBuyer.phone === buyerPhone, '自动注册账号应自动绑定手机号');
  assert(Number(registeredBuyer.phoneVerifiedAt || 0) > 0, '自动注册账号应写入手机号验证时间');
  assert(registeredBuyer.hasPassword === false, '首次验证码注册账号默认不应带密码');
  assert(registeredBuyer.nickname === '', '首次验证码注册账号昵称应默认为空');
  assert(!Object.prototype.hasOwnProperty.call(registeredBuyer, 'password'), '登录返回不应暴露密码字段');

  const buyerSessionUser = await buyerClient.requestJson('/api/auth/me');
  assert(buyerSessionUser.username === buyerUsername, '注册后应自动建立会话');
  assert(buyerSessionUser.phone === buyerPhone, '登录态应返回自动绑定的手机号');
  assert(buyerSessionUser.hasPassword === false, '登录态应暴露未设密码状态');
  assert(buyerSessionUser.nickname === '', '登录态应暴露空昵称');

  const buyerUsers = await buyerClient.requestJson('/api/users');
  assert(Array.isArray(buyerUsers) && buyerUsers.length === 1, '普通用户只应拿到自身资料');
  assert(buyerUsers[0].username === buyerUsername, '普通用户资料应是当前账号');
  assert(!Object.prototype.hasOwnProperty.call(buyerUsers[0], 'password'), '普通用户资料不应暴露密码字段');
  assert(buyerUsers[0].phone === buyerPhone, '普通用户资料应包含自动绑定手机号');
  assert(buyerUsers[0].hasPassword === false, '普通用户资料应包含 hasPassword=false');

  const buyerRoleError = await buyerClient.requestError('/api/users/' + encodeURIComponent(buyerUsername) + '/role', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roleType: 'admin' })
  });
  assert(buyerRoleError.status === 403, '普通用户不应能修改角色');

  const buyerUploadError = await buyerClient.requestError('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      folder: 'banner',
      fileName: 'tiny.png',
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9p0rG9sAAAAASUVORK5CYII='
    })
  });
  assert(buyerUploadError.status === 403, '普通用户不应能上传后台图片');

  const savedBuyerState = await buyerClient.requestJson('/api/users/' + encodeURIComponent(buyerUsername) + '/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: buyerUsername,
      addresses: [{ id: 'addr_smoke', name: '张三', phone: '13800000000', full: '测试地址' }],
      selectedAddressId: 'addr_smoke',
      coupons: registeredBuyer.coupons || []
    })
  });
  assert(savedBuyerState.selectedAddressId === 'addr_smoke', '普通用户应能保存自己的资料');

  const tamperedBuyerState = await buyerClient.requestJson('/api/users/' + encodeURIComponent(buyerUsername) + '/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: buyerUsername,
      phone: '13900139000',
      password: 'tamperedPassword',
      nickname: '手机号新用户',
      addresses: [{ id: 'addr_smoke', name: '张三', phone: '13800000000', full: '测试地址' }],
      selectedAddressId: 'addr_smoke'
    })
  });
  assert(tamperedBuyerState.phone === buyerPhone, '通用资料保存接口不应篡改已绑定手机号');
  assert(tamperedBuyerState.nickname === '手机号新用户', '通用资料保存接口应允许更新昵称');

  const duplicateBuyerClient = new SessionClient();
  const duplicateBuyerUsername = 'phase15_buyer_' + Date.now();
  const duplicateBuyerPassword = 'buyer654321';
  await duplicateBuyerClient.requestJson('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: duplicateBuyerUsername, password: duplicateBuyerPassword })
  });
  const duplicateBindError = await duplicateBuyerClient.requestError('/api/auth/send-sms-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: buyerPhone, purpose: 'bind_phone' })
  });
  assert(duplicateBindError.status === 409, '已绑定手机号不应允许第二个账号再次绑定');

  const noPasswordLoginError = await anonClient.requestError('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: buyerPhone, password: buyerPassword })
  });
  assert(noPasswordLoginError.status === 401, '未设置密码的手机号账号不应允许密码登录');
  assert(String(noPasswordLoginError.body && noPasswordLoginError.body.message || '').indexOf('尚未设置登录密码') >= 0, '未设置密码时应返回明确提示');

  await clearSmsCodes(buyerPhone, 'login_or_register');
  const firstRepeatSmsPayload = await anonClient.requestJson('/api/auth/send-sms-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: buyerPhone, purpose: 'login_or_register' })
  });
  const firstRepeatSmsCode = String(firstRepeatSmsPayload.debugCode || '') || await readLatestSmsCode(buyerPhone, 'login_or_register');
  const loginSmsBeforeResend = await readSmsVerificationRows(buyerPhone, 'login_or_register');
  assert(loginSmsBeforeResend.length === 1, '登录验证码重发测试前应只有一条短信记录');
  assert(loginSmsBeforeResend[0].code === firstRepeatSmsCode, '第一条登录验证码应与短信记录一致');
  await reopenSmsResendWindow(buyerPhone, 'login_or_register');
  const secondRepeatSmsPayload = await anonClient.requestJson('/api/auth/send-sms-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: buyerPhone, purpose: 'login_or_register' })
  });
  const repeatSmsCode = String(secondRepeatSmsPayload.debugCode || '') || await readLatestSmsCode(buyerPhone, 'login_or_register');
  const loginSmsAfterResend = await readSmsVerificationRows(buyerPhone, 'login_or_register');
  assert(loginSmsAfterResend.length === 2, '60 秒后再次发送登录验证码时应保留历史记录');
  assert(loginSmsAfterResend[0].invalidatedAt > 0, '登录验证码重发成功后旧码应立即失效');
  assert(loginSmsAfterResend[1].invalidatedAt === 0, '最新登录验证码应保持当前有效');
  assert(loginSmsAfterResend[1].createdAt > loginSmsAfterResend[0].createdAt, '重发登录验证码后发送时间应刷新');
  assert(loginSmsAfterResend[1].expiresAt > loginSmsAfterResend[0].expiresAt, '登录验证码有效期应按最新发送时间重算');
  const invalidatedLoginError = await anonClient.requestError('/api/auth/login-sms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: buyerPhone, code: firstRepeatSmsCode })
  });
  assert(invalidatedLoginError.status === 400, '重发后旧登录验证码不应继续登录');
  const repeatBuyerClient = new SessionClient();
  const repeatLoginBuyer = await repeatBuyerClient.requestJson('/api/auth/login-sms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: buyerPhone, code: repeatSmsCode })
  });
  assert(repeatLoginBuyer.username === buyerUsername, '同手机号再次验证码登录应命中已有账号');
  assert(repeatLoginBuyer.autoRegistered === false, '同手机号再次验证码登录不应重复注册');

  const changedPassword = 'buyer223344';
  const changePasswordPayload = await buyerClient.requestJson('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: '', newPassword: changedPassword })
  });
  assert(changePasswordPayload.ok === true, '已登录无密码用户应能首次设置密码');
  assert(String(changePasswordPayload.message || '').indexOf('设置') >= 0, '首次设密应返回设置成功提示');

  await buyerClient.requestJson('/api/auth/logout', { method: 'POST' });
  const buyerOldPasswordError = await buyerClient.requestError('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: buyerPhone, password: buyerPassword })
  });
  assert(buyerOldPasswordError.status === 401, '修改密码后旧密码不应再可用');

  const buyerChangedPasswordLogin = await buyerClient.requestJson('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: buyerPhone, password: changedPassword })
  });
  assert(buyerChangedPasswordLogin.username === buyerUsername, '修改密码后应可使用新密码登录');
  assert(buyerChangedPasswordLogin.hasPassword === true, '首次设密后应切到 hasPassword=true');

  await clearSmsCodes(buyerPhone, 'reset_password');
  const firstResetSmsPayload = await anonClient.requestJson('/api/auth/send-sms-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: buyerPhone, purpose: 'reset_password' })
  });
  const firstResetPhoneCode = String(firstResetSmsPayload.debugCode || '') || await readLatestSmsCode(buyerPhone, 'reset_password');
  assert(/^\d{6}$/.test(firstResetPhoneCode), '找回密码验证码应可通过显式 debug 或本地记录获取');
  await reopenSmsResendWindow(buyerPhone, 'reset_password');
  const secondResetSmsPayload = await anonClient.requestJson('/api/auth/send-sms-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: buyerPhone, purpose: 'reset_password' })
  });
  const resetPhoneCode = String(secondResetSmsPayload.debugCode || '') || await readLatestSmsCode(buyerPhone, 'reset_password');
  const resetSmsRows = await readSmsVerificationRows(buyerPhone, 'reset_password');
  assert(resetSmsRows.length === 2, '找回密码重发验证码时应保留历史记录');
  assert(resetSmsRows[0].invalidatedAt > 0, '找回密码重发成功后旧验证码应立即失效');
  assert(resetSmsRows[1].invalidatedAt === 0, '找回密码最新验证码应保持有效');
  assert(resetSmsRows[1].expiresAt > resetSmsRows[0].expiresAt, '找回密码验证码有效期应按最新发送时间重算');
  const invalidatedResetError = await anonClient.requestError('/api/auth/forgot-password/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: buyerPhone, code: firstResetPhoneCode, newPassword: 'reset112233' })
  });
  assert(invalidatedResetError.status === 400, '重发后旧找回密码验证码不应继续可用');
  if (!parseEnvFlag(process.env.CS_SMS_DEBUG_CODES)) {
    assert(!secondResetSmsPayload.debugCode, 'deploy-safe 默认值下找回密码接口不应回显调试验证码');
  }

  const resetPassword = 'buyer998877';
  const resetPasswordPayload = await anonClient.requestJson('/api/auth/forgot-password/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: buyerPhone, code: resetPhoneCode, newPassword: resetPassword })
  });
  assert(resetPasswordPayload.ok === true, '已绑定手机号应能通过验证码重置密码');

  const changedPasswordAfterResetError = await buyerClient.requestError('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: buyerPhone, password: changedPassword })
  });
  assert(changedPasswordAfterResetError.status === 401, '短信重置后旧的新密码也应失效');

  const buyerResetPasswordLogin = await buyerClient.requestJson('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: buyerPhone, password: resetPassword })
  });
  assert(buyerResetPasswordLogin.username === buyerUsername, '短信重置后应能使用重置后的密码登录');

  const db = openDatabase();
  const adminUsername = 'phase12_admin_' + Date.now();
  const farmerUsername = 'phase12_farmer_' + Date.now();
  const deleteUsername = 'phase12_delete_' + Date.now();
  try {
    await db.run(
      'INSERT INTO users (username, password, roles, addresses, shippingAddresses, coupons, selectedAddressId, selectedCouponId, cart, orders, member, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        adminUsername,
        'adminpass123',
        JSON.stringify({ isFarmer: true, isAdmin: true, isSuperAdmin: true, farmerName: '阶段管理员' }),
        '[]',
        '[]',
        '[]',
        '',
        '',
        '[]',
        '[]',
        JSON.stringify({ levelId: 'normal', points: 0, totalSpent: 0 }),
        '2026/04/09'
      ]
    );
    await db.run(
      'INSERT INTO users (username, password, roles, addresses, shippingAddresses, coupons, selectedAddressId, selectedCouponId, cart, orders, member, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        farmerUsername,
        'farmerpass123',
        JSON.stringify({ isFarmer: true, isAdmin: false, isSuperAdmin: false, farmerName: '阶段农户' }),
        '[]',
        '[]',
        '[]',
        '',
        '',
        '[]',
        '[]',
        JSON.stringify({ levelId: 'normal', points: 0, totalSpent: 0 }),
        '2026/04/09'
      ]
    );
    await db.run(
      'INSERT INTO users (username, password, roles, addresses, shippingAddresses, coupons, selectedAddressId, selectedCouponId, cart, orders, member, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        deleteUsername,
        'deletepass123',
        JSON.stringify({ isFarmer: false, isAdmin: false, isSuperAdmin: false, farmerName: deleteUsername }),
        '[]',
        '[]',
        '[]',
        '',
        '',
        '[]',
        '[]',
        JSON.stringify({ levelId: 'normal', points: 0, totalSpent: 0 }),
        '2026/04/09'
      ]
    );
  } finally {
    await db.close();
  }

  const adminClient = new SessionClient();
  const farmerClient = new SessionClient();

  const adminLogin = await adminClient.requestJson('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: adminUsername, password: 'adminpass123' })
  });
  assert(adminLogin.username === adminUsername, '管理员应可登录');

  const farmerLogin = await farmerClient.requestJson('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: farmerUsername, password: 'farmerpass123' })
  });
  assert(farmerLogin.username === farmerUsername, '农户应可登录');

  let checkoutSourceProduct = publicProduct;
  if (!checkoutSourceProduct.shippingAddressId || !(checkoutSourceProduct.shippingAddressSnapshot && checkoutSourceProduct.shippingAddressSnapshot.full)) {
    checkoutSourceProduct = await farmerClient.requestJson('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 0,
        name: '阶段支付烟测商品',
        price: 18,
        orig: 18,
        unit: '测试装',
        cat: publicProduct.cat,
        tags: ['支付烟测'],
        stock: 8,
        sales: 0,
        harvest: '2026-04-13',
        dispatchHours: 4,
        farmer: '支付烟测农户',
        farmerAccount: '',
        farmerUserId: 0,
        village: '支付测试村',
        shippingAddressId: 'smoke_shipping_address',
        shippingAddressSnapshot: { id: 'smoke_shipping_address', name: '烟测农户', phone: '13800009999', full: '支付测试村 1 号' },
        images: [publicProduct.img],
        img: publicProduct.img,
        off: false,
        trace: [],
        variants: [{
          id: 'smoke_payment_variant',
          label: '默认规格',
          price: 18,
          stock: 8,
          sortOrder: 0,
          isDefault: true,
          units: [{
            id: 'smoke_payment_unit',
            label: '测试装',
            price: 18,
            stock: 8,
            sortOrder: 0,
            isDefault: true
          }]
        }]
      })
    });
  }

  const adminUsersPage = await adminClient.requestJson('/api/users?page=1&pageSize=20&keyword=' + encodeURIComponent(buyerUsername));
  assert(Array.isArray(adminUsersPage.items) && adminUsersPage.items.some(function (item) { return item.username === buyerUsername; }), '管理员应能分页查看用户摘要');

  const adminUsers = await adminClient.requestJson('/api/users');
  assert(Array.isArray(adminUsers) && adminUsers.some(function (item) { return item.username === buyerUsername; }), '管理员应能获取受控用户列表');

  const uploadResult = await adminClient.requestJson('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      folder: 'banner',
      fileName: 'tiny.png',
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9p0rG9sAAAAASUVORK5CYII='
    })
  });
  assert(/^\/uploads\/banner\//.test(uploadResult.url), '管理员应能上传 Banner 图片');
  assert(fs.existsSync(resolveUploadFilePath(uploadResult.url)), '上传文件应落盘成功');

  const adminLightStats = await adminClient.requestJson('/api/admin/light-stats');
  assert(typeof adminLightStats.productCount === 'number', '管理员应能读取轻量统计');
  const normalBrowserHeaders = { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 Chrome/124 Safari/537.36' };
  const wechatBrowserHeaders = { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 MicroMessenger' };

  const buyerOrderPrepare = await buyerClient.requestJson('/api/orders/prepare-payment', {
    method: 'POST',
    headers: normalBrowserHeaders,
    body: JSON.stringify({
      items: [{
        id: checkoutSourceProduct.id,
        productId: checkoutSourceProduct.id,
        name: checkoutSourceProduct.name,
        variantId: checkoutSourceProduct.variants.find(function (variant) {
          return Array.isArray(variant && variant.units) && variant.units.some(function (unit) {
            return Number(unit && unit.stock || 0) > 0;
          });
        }).id,
        variantLabel: checkoutSourceProduct.variants.find(function (variant) {
          return Array.isArray(variant && variant.units) && variant.units.some(function (unit) {
            return Number(unit && unit.stock || 0) > 0;
          });
        }).label,
        unitId: checkoutSourceProduct.variants.find(function (variant) {
          return Array.isArray(variant && variant.units) && variant.units.some(function (unit) {
            return Number(unit && unit.stock || 0) > 0;
          });
        }).units.find(function (unit) { return Number(unit && unit.stock || 0) > 0; }).id,
        unitLabel: checkoutSourceProduct.variants.find(function (variant) {
          return Array.isArray(variant && variant.units) && variant.units.some(function (unit) {
            return Number(unit && unit.stock || 0) > 0;
          });
        }).units.find(function (unit) { return Number(unit && unit.stock || 0) > 0; }).label,
        unit: checkoutSourceProduct.variants.find(function (variant) {
          return Array.isArray(variant && variant.units) && variant.units.some(function (unit) {
            return Number(unit && unit.stock || 0) > 0;
          });
        }).units.find(function (unit) { return Number(unit && unit.stock || 0) > 0; }).label,
        price: Number(checkoutSourceProduct.variants.find(function (variant) {
          return Array.isArray(variant && variant.units) && variant.units.some(function (unit) {
            return Number(unit && unit.stock || 0) > 0;
          });
        }).units.find(function (unit) { return Number(unit && unit.stock || 0) > 0; }).price || checkoutSourceProduct.price || 0),
        qty: 1,
        img: checkoutSourceProduct.img,
        shippingAddressId: checkoutSourceProduct.shippingAddressId || '',
        shippingAddressSnapshot: checkoutSourceProduct.shippingAddressSnapshot || {}
      }],
      address: { name: '张三', phone: '13800000000', full: '测试地址' },
      subtotal: 0,
      deliveryFee: 5,
      discount: 0,
      total: 0,
      couponId: '',
      couponText: ''
    })
  });
  assert(buyerOrderPrepare.status === 'pending', '买家应能创建待支付订单');
  assert(Number(buyerOrderPrepare.reserveExpiresAt || 0) > Number(buyerOrderPrepare.time || 0), '待支付订单应带过期时间');
  if (wechatPayEnabled) {
    assert(Array.isArray(buyerOrderPrepare.availableChannels) && buyerOrderPrepare.availableChannels.indexOf('wechat_h5_external') >= 0, '非微信环境的待支付订单应暴露微信外 H5 备选渠道');
    assert(buyerOrderPrepare.recommendedChannel === 'alipay_wap', '非微信环境应优先推荐支付宝支付');
  }
  if (!localMockPaymentEnabled) {
    const blockedMockPayment = await buyerClient.requestError('/api/orders/' + encodeURIComponent(buyerOrderPrepare.id) + '/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert(blockedMockPayment.status === 403, '非 local-dev 环境不应再允许 /pay 直达已支付');
    assert(String(blockedMockPayment.body && blockedMockPayment.body.message || '').includes('仅供本地开发调试使用'), 'mock 支付拒绝信息应明确提示仅供本地开发调试');
  }

  const beforePaidProducts = await anonClient.requestJson('/api/products');
  const beforePaidProduct = beforePaidProducts.find(function (item) { return Number(item.id || 0) === Number(checkoutSourceProduct.id || 0); }) || checkoutSourceProduct;
  const beforeSales = Number(beforePaidProduct && beforePaidProduct.sales || 0);
  const buyerSettlement = await settlePendingOrder(buyerClient, buyerOrderPrepare, {
    label: '买家首笔待支付订单',
    channel: 'alipay_wap',
    headers: normalBrowserHeaders,
    repeatNotify: true
  });
  if (alipayTestPrivateKey) {
    assert(buyerSettlement.paymentStatus && buyerSettlement.paymentStatus.paymentTransaction && buyerSettlement.paymentStatus.paymentTransaction.gatewayTradeNo, '真实支付宝结算后应记录支付宝交易号');

    const afterPaidProducts = await anonClient.requestJson('/api/products');
    const afterPaidProduct = afterPaidProducts.find(function (item) { return Number(item.id || 0) === Number(checkoutSourceProduct.id || 0); }) || checkoutSourceProduct;
    assert(Number(afterPaidProduct && afterPaidProduct.sales || 0) === beforeSales + 1, '重复异步通知不应重复增加销量');

    const buyerCancelPrepare = await buyerClient.requestJson('/api/orders/prepare-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: buyerOrderPrepare.items,
        address: { name: '张三', phone: '13800000000', full: '测试地址' },
        subtotal: buyerOrderPrepare.subtotal,
        deliveryFee: buyerOrderPrepare.deliveryFee,
        discount: buyerOrderPrepare.discount,
        total: buyerOrderPrepare.total,
        couponId: '',
        couponText: ''
      })
    });
    const cancelLaunch = await buyerClient.requestJson('/api/orders/' + encodeURIComponent(buyerCancelPrepare.id) + '/alipay-wap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const cancelledOrder = await buyerClient.requestJson('/api/orders/' + encodeURIComponent(buyerCancelPrepare.id) + '/cancel-pending', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert(cancelledOrder.status === 'cancelled', '第二笔待支付订单应可取消');

    const cancelledNotifyPayload = buildTestAlipayNotifyPayload(cancelLaunch, buyerCancelPrepare);
    cancelledNotifyPayload.sign = signAlipayPayload(cancelledNotifyPayload, alipayTestPrivateKey);
    const cancelledNotifyResponse = await buyerClient.request('/api/payments/alipay/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(cancelledNotifyPayload).toString()
    });
    assert(cancelledNotifyResponse.ok, '取消订单后的异步通知也应被幂等接收');
    const cancelledStatusPayload = await buyerClient.requestJson('/api/orders/' + encodeURIComponent(buyerCancelPrepare.id) + '/payment-status');
    assert(cancelledStatusPayload.order && cancelledStatusPayload.order.status === 'cancelled', '已取消订单不应被异步通知重新改成已支付');
  }

  if (wechatPayEnabled) {
    const buyerWechatPrepare = await buyerClient.requestJson('/api/orders/prepare-payment', {
      method: 'POST',
      headers: wechatBrowserHeaders,
      body: JSON.stringify({
        items: buyerOrderPrepare.items,
        address: { name: '张三', phone: '13800000000', full: '微信内测试地址' },
        subtotal: buyerOrderPrepare.subtotal,
        deliveryFee: buyerOrderPrepare.deliveryFee,
        discount: buyerOrderPrepare.discount,
        total: buyerOrderPrepare.total,
        couponId: '',
        couponText: ''
      })
    });
    assert(buyerWechatPrepare.recommendedChannel === 'wechat_h5_inapp', '微信浏览器下应优先推荐微信内 H5 支付');
    assert(Array.isArray(buyerWechatPrepare.availableChannels) && buyerWechatPrepare.availableChannels[0] === 'wechat_h5_inapp', '微信浏览器下可用渠道应先列出微信内 H5');
    const buyerWechatSettlement = await settlePendingOrder(buyerClient, buyerWechatPrepare, {
      label: '买家微信内 H5 待支付订单',
      channel: 'wechat_h5_inapp',
      headers: wechatBrowserHeaders,
      repeatNotify: true
    });
    assert(buyerWechatSettlement.launch && buyerWechatSettlement.launch.params && buyerWechatSettlement.launch.params.trade_type === 'JSAPI', '微信内 H5 结算应生成 JSAPI 合约');
    assert(buyerWechatSettlement.paymentStatus && buyerWechatSettlement.paymentStatus.paymentTransaction && buyerWechatSettlement.paymentStatus.paymentTransaction.channel === 'wechat_h5_inapp', '微信内 H5 结算后支付流水应保持微信内渠道');

    const buyerWechatExternalPrepare = await buyerClient.requestJson('/api/orders/prepare-payment', {
      method: 'POST',
      headers: normalBrowserHeaders,
      body: JSON.stringify({
        items: buyerOrderPrepare.items,
        address: { name: '张三', phone: '13800000000', full: '微信外测试地址' },
        subtotal: buyerOrderPrepare.subtotal,
        deliveryFee: buyerOrderPrepare.deliveryFee,
        discount: buyerOrderPrepare.discount,
        total: buyerOrderPrepare.total,
        couponId: '',
        couponText: ''
      })
    });
    assert(Array.isArray(buyerWechatExternalPrepare.availableChannels) && buyerWechatExternalPrepare.availableChannels.indexOf('wechat_h5_external') >= 0, '非微信环境应继续暴露微信外 H5 备选渠道');
    const buyerWechatExternalSettlement = await settlePendingOrder(buyerClient, buyerWechatExternalPrepare, {
      label: '买家微信外 H5 待支付订单',
      channel: 'wechat_h5_external',
      headers: normalBrowserHeaders,
      repeatNotify: true
    });
    assert(buyerWechatExternalSettlement.launch && buyerWechatExternalSettlement.launch.params && buyerWechatExternalSettlement.launch.params.trade_type === 'H5', '微信外 H5 结算应生成 H5 合约');

    const buyerWechatCancelPrepare = await buyerClient.requestJson('/api/orders/prepare-payment', {
      method: 'POST',
      headers: normalBrowserHeaders,
      body: JSON.stringify({
        items: buyerOrderPrepare.items,
        address: { name: '张三', phone: '13800000000', full: '微信取消测试地址' },
        subtotal: buyerOrderPrepare.subtotal,
        deliveryFee: buyerOrderPrepare.deliveryFee,
        discount: buyerOrderPrepare.discount,
        total: buyerOrderPrepare.total,
        couponId: '',
        couponText: ''
      })
    });
    const wechatCancelLaunch = await buyerClient.requestJson('/api/orders/' + encodeURIComponent(buyerWechatCancelPrepare.id) + '/wechat-external-h5', {
      method: 'POST',
      headers: normalBrowserHeaders,
      body: JSON.stringify({})
    });
    const cancelledWechatOrder = await buyerClient.requestJson('/api/orders/' + encodeURIComponent(buyerWechatCancelPrepare.id) + '/cancel-pending', {
      method: 'POST',
      headers: normalBrowserHeaders,
      body: JSON.stringify({})
    });
    assert(cancelledWechatOrder.status === 'cancelled', '微信待支付订单也应可取消');
    const cancelledWechatNotifyPayload = buildTestWechatNotifyPayload(wechatCancelLaunch, buyerWechatCancelPrepare);
    const cancelledWechatNotifyResponse = await buyerClient.request('/api/payments/wechat/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cancelledWechatNotifyPayload)
    });
    assert(cancelledWechatNotifyResponse.ok, '取消订单后的微信异步通知也应被幂等接收');
    const cancelledWechatStatusPayload = await buyerClient.requestJson('/api/orders/' + encodeURIComponent(buyerWechatCancelPrepare.id) + '/payment-status', {
      headers: normalBrowserHeaders
    });
    assert(cancelledWechatStatusPayload.order && cancelledWechatStatusPayload.order.status === 'cancelled', '已取消微信订单不应被异步通知重新改成已支付');
  }

  const adminOrdersPage = await adminClient.requestJson('/api/orders?page=1&pageSize=20&ownerUsername=' + encodeURIComponent(buyerUsername));
  assert(Array.isArray(adminOrdersPage.items) && adminOrdersPage.items.some(function (item) { return item.id === buyerOrderPrepare.id; }), '管理员应能查看指定买家订单');

  const fulfillmentSupportProduct = await farmerClient.requestJson('/api/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 0,
      name: '阶段履约烟测商品',
      price: 12,
      orig: 12,
      unit: '测试装',
      cat: publicProduct.cat,
      tags: ['履约烟测'],
      stock: 8,
      sales: 0,
      harvest: '2026-04-13',
      dispatchHours: 4,
      farmer: '履约烟测农户',
      farmerAccount: '',
      farmerUserId: 0,
      village: '履约测试村',
      shippingAddressId: 'fulfillment_shipping_address',
      shippingAddressSnapshot: { id: 'fulfillment_shipping_address', name: '履约烟测农户', phone: '13800008888', full: '履约测试村 9 号' },
      images: [publicProduct.img],
      img: publicProduct.img,
      off: false,
      trace: [],
      variants: [{
        id: 'fulfillment_variant',
        label: '默认规格',
        price: 12,
        stock: 8,
        sortOrder: 0,
        isDefault: true,
        units: [{
          id: 'fulfillment_unit',
          label: '测试装',
          price: 12,
          stock: 8,
          sortOrder: 0,
          isDefault: true
        }]
      }]
    })
  });
  const fulfillmentSeedItem = {
    id: fulfillmentSupportProduct.id,
    productId: fulfillmentSupportProduct.id,
    name: fulfillmentSupportProduct.name,
    variantId: fulfillmentSupportProduct.variants[0].id,
    variantLabel: fulfillmentSupportProduct.variants[0].label,
    unitId: fulfillmentSupportProduct.variants[0].units[0].id,
    unitLabel: fulfillmentSupportProduct.variants[0].units[0].label,
    unit: fulfillmentSupportProduct.variants[0].units[0].label,
    price: Number(fulfillmentSupportProduct.variants[0].units[0].price || 12),
    qty: 1,
    img: fulfillmentSupportProduct.img,
    shippingAddressId: fulfillmentSupportProduct.shippingAddressId || '',
    shippingAddressSnapshot: fulfillmentSupportProduct.shippingAddressSnapshot || {}
  };
  const fulfillmentOrderPrepare = await buyerClient.requestJson('/api/orders/prepare-payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [Object.assign({}, fulfillmentSeedItem), Object.assign({}, fulfillmentSeedItem)],
      address: { name: '李四', phone: '13900000000', full: '履约测试地址' },
      subtotal: Number(fulfillmentSeedItem.price || 0) * 2,
      deliveryFee: 5,
      discount: 0,
      total: Number(fulfillmentSeedItem.price || 0) * 2 + 5,
      couponId: '',
      couponText: ''
    })
  });
  const fulfillmentPaidOrder = (await settlePendingOrder(buyerClient, fulfillmentOrderPrepare, {
    label: '履约测试订单'
  })).order;
  assert(fulfillmentPaidOrder.status === 'paid', '履约测试订单应成功进入待发货状态');

  const fulfillmentQueue = await adminClient.requestJson('/api/admin/fulfillment/orders?page=1&pageSize=20&ownerUsername=' + encodeURIComponent(buyerUsername));
  assert(Array.isArray(fulfillmentQueue.items) && fulfillmentQueue.items.some(function (item) { return item.id === fulfillmentPaidOrder.id; }), '管理员发货工作台应能看到待发货订单');

  const fulfillmentDetail = await adminClient.requestJson('/api/admin/fulfillment/orders/' + encodeURIComponent(buyerUsername) + '/' + encodeURIComponent(fulfillmentPaidOrder.id));
  assert(Array.isArray(fulfillmentDetail.items) && fulfillmentDetail.items.length === 2, '发货详情应返回完整订单商品');
  assert(fulfillmentDetail.items.every(function (item) { return Number(item.orderItemId || 0) > 0; }), '发货详情中的订单项应暴露稳定 orderItemId');
  assert(Array.isArray(fulfillmentDetail.shipments) && fulfillmentDetail.shipments.length === 0, '未发货订单初始不应带 shipment 记录');
  assert(fulfillmentDetail.fulfillmentSummary && fulfillmentDetail.fulfillmentSummary.totalItemCount === 2, '发货详情应返回 fulfillmentSummary');

  const nonAdminFulfillmentError = await buyerClient.requestError('/api/admin/fulfillment/orders/' + encodeURIComponent(buyerUsername) + '/' + encodeURIComponent(fulfillmentPaidOrder.id) + '/shipments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      trackingNo: 'BUYER-FORBIDDEN-001',
      orderItemIds: [fulfillmentDetail.items[0].orderItemId]
    })
  });
  assert(nonAdminFulfillmentError.status === 403, '普通买家不应能执行管理员发货');

  const firstShipment = await adminClient.requestJson('/api/admin/fulfillment/orders/' + encodeURIComponent(buyerUsername) + '/' + encodeURIComponent(fulfillmentPaidOrder.id) + '/shipments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      trackingNo: 'SF123456789CN',
      carrierCode: 'sf',
      carrierName: '顺丰速运',
      orderItemIds: [fulfillmentDetail.items[0].orderItemId]
    })
  });
  assert(firstShipment.status === 'paid', '只发一部分订单项时，订单仍应保持待发货');
  assert(Array.isArray(firstShipment.shipments) && firstShipment.shipments.length === 1, '第一次发货后应生成第一条 shipment');
  assert(firstShipment.fulfillmentSummary && Number(firstShipment.fulfillmentSummary.assignedItemCount || 0) === 1, '第一次发货后应只统计 1 条已分配商品');
  assert(Array.isArray(firstShipment.shipments[0].orderItemIds) && firstShipment.shipments[0].orderItemIds.length === 1, 'shipment 应只绑定选中的订单项');

  const duplicateShipmentError = await adminClient.requestError('/api/admin/fulfillment/orders/' + encodeURIComponent(buyerUsername) + '/' + encodeURIComponent(fulfillmentPaidOrder.id) + '/shipments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      trackingNo: 'SF123456789CN-RETRY',
      carrierCode: 'sf',
      carrierName: '顺丰速运',
      orderItemIds: [fulfillmentDetail.items[0].orderItemId]
    })
  });
  assert(duplicateShipmentError.status === 400, '已绑定过的订单项不应允许重复发货');

  const secondShipment = await adminClient.requestJson('/api/admin/fulfillment/orders/' + encodeURIComponent(buyerUsername) + '/' + encodeURIComponent(fulfillmentPaidOrder.id) + '/shipments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      trackingNo: 'YT987654321CN',
      carrierCode: 'yto',
      carrierName: '圆通快递',
      orderItemIds: [fulfillmentDetail.items[1].orderItemId]
    })
  });
  assert(secondShipment.status === 'shipped', '全部订单项都分配后，订单应转成已发货');
  assert(Array.isArray(secondShipment.shipments) && secondShipment.shipments.length === 2, '同一订单应允许存在两条快递号记录');
  assert(Number(secondShipment.fulfillmentSummary.unassignedItemCount || 0) === 0, '全部发货后不应再有未分配商品');

  const shippedOrdersPage = await adminClient.requestJson('/api/orders?page=1&pageSize=20&ownerUsername=' + encodeURIComponent(buyerUsername) + '&orderId=' + encodeURIComponent(fulfillmentPaidOrder.id));
  const shippedOrderFromPage = (shippedOrdersPage.items || []).find(function (item) { return item.id === fulfillmentPaidOrder.id; });
  assert(shippedOrderFromPage && Array.isArray(shippedOrderFromPage.shipments) && shippedOrderFromPage.shipments.length === 2, '管理员订单分页接口应返回 shipment 列表');

  const exportOrderItemName = '=2+3公式商品';
  const exportTrackingNo = '@YTFORMULA001';
  const exportDb = openDatabase();
  await exportDb.run('UPDATE order_items SET name = ? WHERE id = ?', [exportOrderItemName, fulfillmentDetail.items[0].orderItemId]);
  await exportDb.run('UPDATE shipments SET trackingNo = ? WHERE id = ?', [exportTrackingNo, firstShipment.shipments[0].id]);
  await exportDb.close();

  const exportOrderPage = await adminClient.requestJson('/api/orders?page=1&pageSize=20&ownerUsername=' + encodeURIComponent(buyerUsername) + '&orderId=' + encodeURIComponent(fulfillmentPaidOrder.id) + '&status=shipped');
  const exportOrder = (exportOrderPage.items || []).find(function (item) { return item.id === fulfillmentPaidOrder.id; });
  assert(exportOrder && Array.isArray(exportOrder.items) && exportOrder.items.length === 2, '导出前的订单筛选应命中测试订单');

  const exportResponse = await adminClient.request('/api/admin/orders/export?ownerUsername=' + encodeURIComponent(buyerUsername) + '&orderId=' + encodeURIComponent(fulfillmentPaidOrder.id) + '&status=shipped');
  assert(exportResponse.ok, '管理员订单导出接口应返回成功结果');
  assert(/text\/csv/i.test(String(exportResponse.headers.get('content-type') || '')), '订单导出接口应返回 text/csv 响应头');
  assert(/attachment; filename=/i.test(String(exportResponse.headers.get('content-disposition') || '')), '订单导出接口应返回下载文件名');
  const exportBuffer = Buffer.from(await exportResponse.arrayBuffer());
  const exportCsv = exportBuffer.toString('utf8');
  assert(exportBuffer[0] === 0xEF && exportBuffer[1] === 0xBB && exportBuffer[2] === 0xBF, 'CSV 导出应带 UTF-8 BOM');
  assert(exportCsv.includes('"订单号","订单状态","下单时间","买家","收货姓名","收货手机号","收货详细地址"'), 'CSV 导出应包含拆分后的收货字段列头');
  assert(exportCsv.includes('商品名称') && exportCsv.includes('快递单号'), 'CSV 导出应包含商品名称和快递单号列');
  assert(countCsvDataRows(exportCsv) === exportOrder.items.length, 'CSV 数据行数应与同筛选条件下的订单商品数一致');
  assert(exportCsv.includes("\"'=2+3公式商品\""), 'CSV 导出应转义以公式前缀开头的商品名称');
  assert(exportCsv.includes("\"'@YTFORMULA001\""), 'CSV 导出应转义以公式前缀开头的快递单号');

  async function createLegacyShippedOrderWithTracking(trackingNo, carrierCode, carrierName) {
    const prepared = await buyerClient.requestJson('/api/orders/prepare-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [Object.assign({}, fulfillmentSeedItem)],
        address: { name: '物流测试', phone: '13600000000', full: '物流测试地址' },
        subtotal: Number(fulfillmentSeedItem.price || 0),
        deliveryFee: 5,
        discount: 0,
        total: Number(fulfillmentSeedItem.price || 0) + 5,
        couponId: '',
        couponText: ''
      })
    });
    const paid = (await settlePendingOrder(buyerClient, prepared, {
      label: '物流兼容订单'
    })).order;
    return adminClient.requestJson('/api/orders/' + encodeURIComponent(paid.id) + '/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerUsername: buyerUsername,
        status: 'shipped',
        trackingNo: trackingNo,
        carrierCode: carrierCode,
        carrierName: carrierName
      })
    });
  }

  const compatibilityOrderPrepare = await buyerClient.requestJson('/api/orders/prepare-payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [Object.assign({}, fulfillmentSeedItem)],
      address: { name: '王五', phone: '13700000000', full: '兼容测试地址' },
      subtotal: Number(fulfillmentSeedItem.price || 0),
      deliveryFee: 5,
      discount: 0,
      total: Number(fulfillmentSeedItem.price || 0) + 5,
      couponId: '',
      couponText: ''
    })
  });
  const compatibilityPaidOrder = (await settlePendingOrder(buyerClient, compatibilityOrderPrepare, {
    label: '旧接口兼容订单'
  })).order;
  const compatibilityShipped = await adminClient.requestJson('/api/orders/' + encodeURIComponent(compatibilityPaidOrder.id) + '/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ownerUsername: buyerUsername,
      status: 'shipped',
      trackingNo: 'ZT000000001CN',
      carrierCode: 'zto',
      carrierName: '中通快递'
    })
  });
  assert(compatibilityShipped.status === 'shipped', '旧订单状态接口发货兼容层仍应可用');
  assert(Array.isArray(compatibilityShipped.shipments) && compatibilityShipped.shipments.length === 1, '旧订单状态接口发货时也应落到 shipment 真相');

  const smokeDb = openDatabase();
  const legacyTrackingGap = await smokeDb.get("SELECT COUNT(*) AS count FROM orders o WHERE TRIM(COALESCE(o.trackingNo, '')) <> '' AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.orderId = o.id) AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.orderId = o.id)");
  await smokeDb.close();
  assert(Number(legacyTrackingGap && legacyTrackingGap.count || 0) === 0, '启动后的数据库中，不应残留有订单项却只有 trackingNo 没有 shipment 的订单');

  const signedLogisticsOrder = await createLegacyShippedOrderWithTracking('SIGNED000001CN', 'sto', '申通快递');
  const waitLogisticsOrder = await createLegacyShippedOrderWithTracking('WAIT000001CN', 'yto', '圆通快递');
  const failLogisticsOrder = await createLegacyShippedOrderWithTracking('FAIL000001CN', 'sf', '顺丰速运');

  await updateShipmentByOrderId(compatibilityPaidOrder.id, {
    trackingNo: '',
    logisticsSummary: '旧物流文案',
    logisticsState: 'active_success',
    lastLogisticsQueryAt: 0,
    lastLogisticsSuccessAt: 0
  });
  await updateShipmentByOrderId(waitLogisticsOrder.id, {
    logisticsSummary: '旧物流文案',
    logisticsState: 'active_success',
    lastLogisticsQueryAt: 0,
    lastLogisticsSuccessAt: 0
  });
  await updateShipmentByOrderId(failLogisticsOrder.id, {
    logisticsSummary: '旧物流成功摘要',
    logisticsState: 'active_success',
    lastLogisticsQueryAt: Date.now() - (3 * 60 * 60 * 1000),
    lastLogisticsSuccessAt: Date.now() - (4 * 60 * 60 * 1000)
  });

  const listRefreshPayload = await buyerClient.requestJson('/api/orders/logistics-refresh-check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visibleOrderIds: [fulfillmentPaidOrder.id] })
  });
  assert(Array.isArray(listRefreshPayload.changedOrderIds), '订单列表 refresh-check 应返回变化订单列表');
  assert(Number(listRefreshPayload.changedCount || 0) >= 4, '订单列表 refresh-check 应检查当前买家的全部订单，而不只看当前可见订单');
  assert(Array.isArray(listRefreshPayload.visibleChangedOrderIds) && listRefreshPayload.visibleChangedOrderIds.length === 1, '订单列表 refresh-check 应返回当前可见订单里的变化交集');
  assert(listRefreshPayload.visibleChangedOrderIds[0] === fulfillmentPaidOrder.id, '当前可见变化订单应命中传入的订单号');
  assert(typeof listRefreshPayload.message === 'undefined', 'refresh-check 响应不应暴露面向用户的节流或失败文案');

  const refreshedFulfillmentOrder = await buyerClient.requestJson('/api/orders/' + encodeURIComponent(fulfillmentPaidOrder.id));
  assert(Array.isArray(refreshedFulfillmentOrder.shipments) && refreshedFulfillmentOrder.shipments.every(function (shipment) {
    return shipment.logisticsState === 'active_success' && Number(shipment.lastLogisticsQueryAt || 0) > 0;
  }), '物流刷新后，普通运单应落成 active_success 并持久化最近查询时间');

  const compatibilityOrderDetail = await buyerClient.requestJson('/api/orders/' + encodeURIComponent(compatibilityPaidOrder.id));
  assert(compatibilityOrderDetail.shipments[0].logisticsState === 'no_tracking', '无单号运单应归一化为 no_tracking');
  assert(compatibilityOrderDetail.shipments[0].logisticsSummary === '待发货，暂未录入物流信息', '无单号运单应回退到待发货文案');

  const waitOrderDetail = await buyerClient.requestJson('/api/orders/' + encodeURIComponent(waitLogisticsOrder.id));
  assert(waitOrderDetail.shipments[0].logisticsState === 'no_trace', '无轨迹运单应归一化为 no_trace');
  assert(waitOrderDetail.shipments[0].logisticsSummary === '已录入单号，等待物流公司返回轨迹', '无轨迹运单应使用等待轨迹文案');

  const signedOrderDetail = await buyerClient.requestJson('/api/orders/' + encodeURIComponent(signedLogisticsOrder.id));
  assert(signedOrderDetail.shipments[0].logisticsState === 'signed', '已签收运单应归一化为 signed');
  assert(String(signedOrderDetail.shipments[0].logisticsSummary || '').indexOf('已签收') >= 0, '已签收运单摘要应直接强调已签收');

  const failOrderDetail = await buyerClient.requestJson('/api/orders/' + encodeURIComponent(failLogisticsOrder.id));
  assert(failOrderDetail.shipments[0].logisticsState === 'stale_success', '失败但已有旧结果时应回退为 stale_success');
  assert(failOrderDetail.shipments[0].logisticsSummary === '旧物流成功摘要', '失败但已有旧结果时应保留上次成功摘要');

  const fulfillmentRowsBeforeThrottle = await fetchShipmentRowsBySourceOrderId(fulfillmentPaidOrder.id);
  const throttleQueryAtBefore = Number(fulfillmentRowsBeforeThrottle[0] && fulfillmentRowsBeforeThrottle[0].lastLogisticsQueryAt || 0);
  const secondListRefreshPayload = await buyerClient.requestJson('/api/orders/logistics-refresh-check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visibleOrderIds: [fulfillmentPaidOrder.id] })
  });
  const fulfillmentRowsAfterThrottle = await fetchShipmentRowsBySourceOrderId(fulfillmentPaidOrder.id);
  assert(Number(secondListRefreshPayload.changedCount || 0) === 0, '两小时内重复检查不应继续产出新的变化提示');
  assert(Number(fulfillmentRowsAfterThrottle[0] && fulfillmentRowsAfterThrottle[0].lastLogisticsQueryAt || 0) === throttleQueryAtBefore, '两小时节流命中后，不应改写最近查询时间');

  await updateShipmentByOrderId(fulfillmentPaidOrder.id, {
    lastLogisticsQueryAt: Date.now() - (3 * 60 * 60 * 1000)
  });
  const thirdListRefreshPayload = await buyerClient.requestJson('/api/orders/logistics-refresh-check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visibleOrderIds: [fulfillmentPaidOrder.id] })
  });
  const fulfillmentRowsAfterExpiry = await fetchShipmentRowsBySourceOrderId(fulfillmentPaidOrder.id);
  assert(Number(thirdListRefreshPayload.changedCount || 0) === 0, '超过两小时后重复查询但结果不变时，不应误报有更新');
  assert(Number(fulfillmentRowsAfterExpiry[0] && fulfillmentRowsAfterExpiry[0].lastLogisticsQueryAt || 0) > throttleQueryAtBefore, '超过两小时后应重新回查并更新最近查询时间');

  const detailOnlyOrder = await createLegacyShippedOrderWithTracking('SIGNED-DETAIL-001', 'yd', '韵达快递');
  const failRowsBeforeDetail = await fetchShipmentRowsBySourceOrderId(failLogisticsOrder.id);
  const detailRefreshPayload = await buyerClient.requestJson('/api/orders/' + encodeURIComponent(detailOnlyOrder.id) + '/logistics-refresh-check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  const failRowsAfterDetail = await fetchShipmentRowsBySourceOrderId(failLogisticsOrder.id);
  const detailOnlyOrderSnapshot = await buyerClient.requestJson('/api/orders/' + encodeURIComponent(detailOnlyOrder.id));
  assert(detailRefreshPayload.changed === true && detailRefreshPayload.orderId === detailOnlyOrder.id, '订单详情 refresh-check 应只返回当前订单的变化结论');
  assert(detailOnlyOrderSnapshot.shipments[0].logisticsState === 'signed', '订单详情 refresh-check 后应可按 order.id 定向读取最新运单结果');
  assert(Number(failRowsAfterDetail[0] && failRowsAfterDetail[0].lastLogisticsQueryAt || 0) === Number(failRowsBeforeDetail[0] && failRowsBeforeDetail[0].lastLogisticsQueryAt || 0), '订单详情 refresh-check 不应顺带刷新其他订单');

  const foreignBuyerOrderError = await duplicateBuyerClient.requestError('/api/orders/' + encodeURIComponent(detailOnlyOrder.id));
  assert(foreignBuyerOrderError.status === 404, '非订单所属买家不应读取其他人的单订单接口');

  const farmerUpload = await farmerClient.requestJson('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      folder: 'product',
      fileName: 'tiny.png',
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9p0rG9sAAAAASUVORK5CYII='
    })
  });
  assert(/^\/uploads\/product\//.test(farmerUpload.url), '农户应能上传商品图片');

  const farmerProduct = await farmerClient.requestJson('/api/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '阶段农户自营商品',
      price: 18,
      orig: 18,
      unit: '袋装',
      cat: publicProduct.cat,
      tags: ['新品'],
      stock: 8,
      sales: 0,
      harvest: '2026-04-09',
      dispatchHours: 6,
      farmer: '占位农户名',
      farmerAccount: 'fake_farmer',
      farmerUserId: 0,
      village: '测试村',
      shippingAddressId: '',
      shippingAddressSnapshot: {},
      images: [farmerUpload.url],
      img: farmerUpload.url,
      off: false,
      trace: [],
      variants: [{
        id: 'phase12_variant',
        label: '标准规格',
        units: [{ id: 'phase12_unit', label: '袋装', price: 18, stock: 8, sortOrder: 0, isDefault: true }],
        sortOrder: 0,
        isDefault: true
      }]
    })
  });
  assert(farmerProduct.farmerAccount === farmerUsername, '农户保存商品时应由服务端强制绑定自己的账号');

  const roleUpdated = await adminClient.requestJson('/api/users/' + encodeURIComponent(buyerUsername) + '/role', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roleType: 'farmer' })
  });
  assert(roleUpdated.roles && roleUpdated.roles.isFarmer === true, '超级管理员应能修改用户角色');

  const deletedUser = await adminClient.requestJson('/api/users/' + encodeURIComponent(deleteUsername), {
    method: 'DELETE'
  });
  assert(deletedUser.deleted === true, '超级管理员应能删除用户');

  await buyerClient.requestJson('/api/auth/logout', { method: 'POST' });
  const buyerSessionAfterLogout = await buyerClient.requestError('/api/auth/me');
  assert(buyerSessionAfterLogout.status === 401, '退出登录后会话应失效');

  console.log('Server smoke test passed.');
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
