const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const vm = require('vm');
const sqlite3 = require('sqlite3').verbose();

// === SERVER_BOOTSTRAP ===
// [SERVER_BOOTSTRAP] Express、SQLite 路径和静态资源入口统一在文件头初始化。
const app = express();
const port = Number(process.env.PORT || 3000);
const host = String(process.env.HOST || '127.0.0.1').trim() || '127.0.0.1';
const dbPath = path.resolve(process.env.CLOUD_STORE_DB_PATH || path.join(__dirname, 'cloud-store.sqlite'));
const publicPath = path.resolve(process.env.CLOUD_STORE_PUBLIC_PATH || path.join(__dirname, 'public'));
const htmlPath = path.join(publicPath, 'index.html');
const uploadRootPath = path.resolve(process.env.CLOUD_STORE_UPLOAD_ROOT || path.join(publicPath, 'uploads'));
const disableDefaultSeedMarkerPath = path.resolve(
  process.env.CLOUD_STORE_DISABLE_SAMPLE_DATA_FILE || path.join(__dirname, '.disable-default-seed')
);
const disableDefaultSampleData =
  parseEnvFlag(process.env.CLOUD_STORE_DISABLE_SAMPLE_DATA) ||
  fs.existsSync(disableDefaultSeedMarkerPath);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
fs.mkdirSync(uploadRootPath, { recursive: true });
const db = new sqlite3.Database(dbPath);
const SESSION_COOKIE_NAME = 'cs_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_REFRESH_MS = 12 * 60 * 60 * 1000;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const AUTH_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const AUTH_RATE_LIMIT_MAX_FAILURES = 8;
const PASSWORD_MIN_LENGTH = 6;
const SMS_CODE_LENGTH = 6;
const SMS_CODE_TTL_MS = 5 * 60 * 1000;
const SMS_CODE_RESEND_MS = 60 * 1000;
const SMS_CODE_SHORT_WINDOW_MS = 10 * 60 * 1000;
const SMS_CODE_SHORT_LIMIT = 5;
const ALIPAY_GATEWAY_DEFAULT = 'https://openapi.alipay.com/gateway.do';
const ALIPAY_WAP_METHOD = 'alipay.trade.wap.pay';
const ALIPAY_REFUND_METHOD = 'alipay.trade.refund';
const ALIPAY_CHARSET = 'utf-8';
const ALIPAY_SIGN_TYPE = 'RSA2';
const ALIPAY_VERSION = '1.0';
const ALIPAY_TIMEOUT_EXPRESS = '10m';
const WECHAT_PAY_H5_GATEWAY_DEFAULT = 'https://api.mch.weixin.qq.com/v3/pay/transactions/h5';
const WECHAT_PAY_JSAPI_GATEWAY_DEFAULT = 'https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi';
const LOGISTICS_THROTTLE_MS = 2 * 60 * 60 * 1000;
const LOGISTICS_BACKGROUND_POLL_MS = Math.max(60 * 1000, Number(process.env.CS_LOGISTICS_POLL_INTERVAL_MS || 0) || LOGISTICS_THROTTLE_MS);
const LOGISTICS_BACKGROUND_POLL_DISABLED = parseEnvFlag(process.env.CS_DISABLE_LOGISTICS_POLLING);
const LOGISTICS_STATUS_ONLY_PROVIDER_STATES = ['3', '4', '14'];
const logisticsBackgroundPollingState = {
  timer: null,
  running: false,
  lastStartedAt: 0,
  lastCompletedAt: 0,
  lastProcessedCount: 0,
  lastChangedCount: 0,
  lastError: ''
};
const authAttemptBuckets = new Map();

function parseEnvFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function isProductionRuntime() {
  return String(process.env.NODE_ENV || '').trim() === 'production';
}

function isLocalMockPaymentEnabled() {
  return parseEnvFlag(process.env.CS_ENABLE_LOCAL_MOCK_PAYMENT) && !isProductionRuntime();
}

function getRuntimeEnv() {
  return String(process.env.CLOUD_STORE_RUNTIME_ENV || '').trim().toLowerCase() || 'production';
}

function isStagingRuntime() {
  return getRuntimeEnv() === 'staging';
}

function getRuntimeLabel() {
  const explicitLabel = String(process.env.CLOUD_STORE_RUNTIME_LABEL || '').trim();
  if (explicitLabel) return explicitLabel;
  return isStagingRuntime() ? '测试环境 / staging' : '正式环境 / production';
}

function getRuntimeMeta(req) {
  return {
    env: getRuntimeEnv(),
    label: getRuntimeLabel(),
    isStaging: isStagingRuntime(),
    host: host,
    port: port,
    publicBaseUrl: buildPublicBaseUrl(req),
    paths: {
      database: path.basename(dbPath),
      uploads: path.basename(uploadRootPath)
    }
  };
}

function getPaymentFormActionOrigins() {
  const sources = ["'self'"];
  [
    String(process.env.ALIPAY_GATEWAY || '').trim() || ALIPAY_GATEWAY_DEFAULT,
    String(process.env.WECHAT_PAY_H5_GATEWAY || '').trim() || WECHAT_PAY_H5_GATEWAY_DEFAULT,
    String(process.env.WECHAT_PAY_JSAPI_GATEWAY || '').trim() || WECHAT_PAY_JSAPI_GATEWAY_DEFAULT
  ].forEach(function (gateway) {
    if (!gateway) return;
    try {
      const origin = new URL(gateway).origin;
      if (origin && sources.indexOf(origin) < 0) sources.push(origin);
    } catch (error) {
      // Ignore malformed overrides and keep the default boundary intact.
    }
  });
  return sources.join(' ');
}

app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ limit: '12mb', extended: true }));

function setSecurityHeaders(req, res) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self' https: data: blob:; img-src 'self' data: https: blob:; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; font-src 'self' data: https:; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'self'; form-action " + getPaymentFormActionOrigins()
  );
  if (isStagingRuntime()) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  }
}

app.use(function (req, res, next) {
  setSecurityHeaders(req, res);
  next();
});

app.use(express.static(publicPath));
app.use('/uploads', express.static(uploadRootPath));

app.get('/healthz', function (req, res) {
  const runtimeMeta = getRuntimeMeta(req);
  res.json({
    ok: true,
    service: 'cloud-store',
    runtime: runtimeMeta,
    host: host,
    port: port,
    storage: {
      database: path.basename(dbPath),
      uploadsMounted: !!uploadRootPath
    },
    now: new Date().toISOString()
  });
});

app.get('/api/runtime-meta', function (req, res) {
  res.json(getRuntimeMeta(req));
});

// [SERVER_DB_HELPERS] 所有 SQLite 增删改查 Promise 封装都从这里往下查。
function run(sql, params) {
  return new Promise(function (resolve, reject) {
    db.run(sql, params || [], function (error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

function get(sql, params) {
  return new Promise(function (resolve, reject) {
    db.get(sql, params || [], function (error, row) {
      if (error) reject(error);
      else resolve(row);
    });
  });
}

function all(sql, params) {
  return new Promise(function (resolve, reject) {
    db.all(sql, params || [], function (error, rows) {
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

function execSql(sql) {
  return new Promise(function (resolve, reject) {
    db.exec(sql, function (error) {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function withImmediateTransaction(asyncFn) {
  let committed = false;
  await execSql('BEGIN IMMEDIATE');
  try {
    const result = await asyncFn();
    await execSql('COMMIT');
    committed = true;
    return result;
  } catch (error) {
    if (!committed) {
      try {
        await execSql('ROLLBACK');
      } catch (rollbackError) {
        console.error('ROLLBACK 失败', rollbackError);
      }
    }
    throw error;
  }
}

// [SERVER_PARSE_HELPERS] JSON 字段、图片上传和默认种子数据读取都依赖这组基础工具。
function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function parseJsonObject(value, fallback) {
  if (!value) return Object.assign({}, fallback || {});
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : Object.assign({}, fallback || {});
  } catch (error) {
    return Object.assign({}, fallback || {});
  }
}

function normalizeTextFilter(value) {
  return String(value || '').trim();
}

function containsTextFilter(source, keyword) {
  const target = normalizeTextFilter(keyword).toLowerCase();
  if (!target) return true;
  return String(source || '').toLowerCase().indexOf(target) >= 0;
}

function tokenizeSearchKeyword(value) {
  return normalizeTextFilter(value)
    .toLowerCase()
    .split(/\s+/)
    .map(function (item) { return item.trim(); })
    .filter(Boolean);
}

function exactTextFilter(source, keyword) {
  const target = normalizeTextFilter(keyword).toLowerCase();
  if (!target) return true;
  return String(source || '').toLowerCase() === target;
}

function parseTimeFilterValue(value, options) {
  const raw = normalizeTextFilter(value);
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) return Number(raw);
  const config = Object.assign({ endOfDay: false }, options || {});
  const isoLike = raw.length <= 10 ? raw + (config.endOfDay ? 'T23:59:59.999' : 'T00:00:00.000') : raw;
  const parsed = new Date(isoLike).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function isTimestampInRange(value, dateFrom, dateTo) {
  const target = Number(value || 0);
  if (dateFrom && target < dateFrom) return false;
  if (dateTo && target > dateTo) return false;
  return true;
}

function parsePositiveInt(value, fallback, options) {
  const config = Object.assign({ min: 1, max: 100 }, options || {});
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(config.max, Math.max(config.min, Math.floor(parsed)));
}

function hasPagingQuery(query) {
  return !!(query && (query.page != null || query.pageSize != null));
}

function normalizePaging(query, defaults) {
  const config = Object.assign({ page: 1, pageSize: 20, maxPageSize: 100 }, defaults || {});
  const page = parsePositiveInt(query && query.page, config.page, { min: 1, max: 100000 });
  const pageSize = parsePositiveInt(query && query.pageSize, config.pageSize, { min: 1, max: config.maxPageSize });
  return {
    page: page,
    pageSize: pageSize,
    offset: (page - 1) * pageSize
  };
}

function buildPagedResult(items, totalCount, page, pageSize) {
  const total = Math.max(0, Number(totalCount || 0));
  const currentPage = Math.max(1, Number(page || 1));
  const size = Math.max(1, Number(pageSize || 1));
  const totalPages = Math.max(1, Math.ceil(total / size));
  return {
    items: Array.isArray(items) ? items : [],
    meta: {
      page: currentPage,
      pageSize: size,
      totalCount: total,
      totalPages: totalPages,
      hasPrev: currentPage > 1,
      hasNext: currentPage < totalPages
    }
  };
}

function buildContainsLikeValue(value) {
  return '%' + normalizeTextFilter(value) + '%';
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function sanitizeFileSegment(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'file';
}

function getExtensionByMime(mimeType) {
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/gif') return '.gif';
  return '.jpg';
}

function writeDataUrlImage(dataUrl, folderName, originalName) {
  const matched = String(dataUrl || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!matched) throw new Error('图片数据格式不正确');
  const mimeType = matched[1].toLowerCase();
  if (!/^image\/(png|jpeg|jpg|webp|gif)$/.test(mimeType)) throw new Error('仅支持 PNG、JPG、WEBP、GIF 图片');
  const binarySize = Buffer.byteLength(matched[2], 'base64');
  if (binarySize > MAX_UPLOAD_BYTES) throw new Error('图片大小不能超过 5MB');
  const uploadDir = ensureDirectory(path.join(uploadRootPath, sanitizeFileSegment(folderName || 'common')));
  const ext = mimeType === 'image/jpg' ? '.jpg' : getExtensionByMime(mimeType);
  const baseName = sanitizeFileSegment(path.parse(originalName || '').name || 'image');
  const fileName = Date.now() + '-' + baseName + ext;
  const filePath = path.join(uploadDir, fileName);
  fs.writeFileSync(filePath, matched[2], 'base64');
  return '/uploads/' + sanitizeFileSegment(folderName || 'common') + '/' + fileName;
}

function parseCookies(headerValue) {
  return String(headerValue || '').split(';').reduce(function (result, pair) {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex < 0) return result;
    const key = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    if (!key) return result;
    result[key] = decodeURIComponent(value || '');
    return result;
  }, {});
}

function generateToken(bytes) {
  return crypto.randomBytes(bytes || 24).toString('hex');
}

function hashPassword(password, salt) {
  const normalizedSalt = salt || generateToken(16);
  const hash = crypto.scryptSync(String(password || ''), normalizedSalt, 64).toString('hex');
  return ['scrypt', normalizedSalt, hash].join('$');
}

function isPasswordHash(value) {
  return String(value || '').indexOf('scrypt$') === 0;
}

function verifyPassword(storedPassword, candidatePassword) {
  const stored = String(storedPassword || '');
  const candidate = String(candidatePassword || '');
  if (!stored || !candidate) return false;
  if (!isPasswordHash(stored)) return stored === candidate;
  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  const expected = hashPassword(candidate, parts[1]);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(stored));
}

function buildSessionCookieValue(sessionId, req) {
  const parts = [
    SESSION_COOKIE_NAME + '=' + encodeURIComponent(sessionId),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + Math.floor(SESSION_TTL_MS / 1000)
  ];
  const forwardedProto = String(req && req.headers && req.headers['x-forwarded-proto'] || '').toLowerCase();
  const isSecure = !!(req && req.secure) || forwardedProto === 'https';
  if (isSecure) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie(res, req) {
  res.setHeader('Set-Cookie', buildSessionCookieValue('', req) + '; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
}

function normalizePemEnvValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(/\\n/g, '\n');
}

function buildPublicBaseUrl(req) {
  const forwardedProto = String(req && req.headers && req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const scheme = forwardedProto || (req && req.secure ? 'https' : 'http');
  const hostHeader = String(req && req.headers && req.headers.host || '').split(',')[0].trim();
  return hostHeader ? (scheme + '://' + hostHeader) : '';
}

function getAlipayConfig(req) {
  const enabled = parseEnvFlag(process.env.ALIPAY_ENABLED);
  const explicitPublicBaseUrl = String(process.env.CLOUD_STORE_PUBLIC_BASE_URL || '').trim();
  const explicitReturnUrl = String(process.env.ALIPAY_RETURN_URL || '').trim();
  const explicitNotifyUrl = String(process.env.ALIPAY_NOTIFY_URL || '').trim();
  const allowDerivedCallbacks = !enabled || isLocalMockPaymentEnabled();
  const publicBaseUrl = explicitPublicBaseUrl || (allowDerivedCallbacks ? buildPublicBaseUrl(req) : '');
  const returnUrl = explicitReturnUrl || (allowDerivedCallbacks && publicBaseUrl ? (publicBaseUrl + '/#/paymentResult') : '');
  const notifyUrl = explicitNotifyUrl || (allowDerivedCallbacks && publicBaseUrl ? (publicBaseUrl + '/api/payments/alipay/notify') : '');
  return {
    enabled: enabled,
    appId: String(process.env.ALIPAY_APP_ID || '').trim(),
    gateway: String(process.env.ALIPAY_GATEWAY || '').trim() || ALIPAY_GATEWAY_DEFAULT,
    privateKey: normalizePemEnvValue(process.env.ALIPAY_PRIVATE_KEY),
    publicKey: normalizePemEnvValue(process.env.ALIPAY_PUBLIC_KEY),
    sellerId: String(process.env.ALIPAY_SELLER_ID || '').trim(),
    returnUrl: returnUrl,
    notifyUrl: notifyUrl,
    publicBaseUrl: publicBaseUrl,
    charset: ALIPAY_CHARSET,
    signType: ALIPAY_SIGN_TYPE,
    version: ALIPAY_VERSION
  };
}

function assertAlipayReady(config) {
  if (!config.enabled) {
    throw new Error('支付宝 WAP 支付未启用，请先在 cloud-store.env 中设置 ALIPAY_ENABLED=true');
  }
  if (!config.appId || !config.privateKey || !config.publicKey) {
    throw new Error('支付宝配置不完整，请先补齐 AppId、公钥和私钥');
  }
  const missingKeys = [];
  if (!config.publicBaseUrl) missingKeys.push('CLOUD_STORE_PUBLIC_BASE_URL');
  if (!config.returnUrl) missingKeys.push('ALIPAY_RETURN_URL');
  if (!config.notifyUrl) missingKeys.push('ALIPAY_NOTIFY_URL');
  if (missingKeys.length) {
    throw new Error('支付宝公网回调配置缺失，请先在 cloud-store.env 中补齐 ' + missingKeys.join('、'));
  }
}

function formatAlipayTimestamp(value) {
  const date = new Date(Number(value || Date.now()));
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return year + '-' + month + '-' + day + ' ' + hour + ':' + minute + ':' + second;
}

function buildAlipaySignContent(params, options) {
  const config = Object.assign({ excludeSignType: false }, options || {});
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

function signAlipayParams(params, privateKey) {
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(buildAlipaySignContent(params), 'utf8');
  return signer.sign(privateKey, 'base64');
}

function verifyAlipaySignature(params, publicKey) {
  const payload = Object.assign({}, params || {});
  const sign = String(payload.sign || '').replace(/ /g, '+').trim();
  if (!sign) return false;
  delete payload.sign;
  const verifier = crypto.createVerify('RSA-SHA256');
  // Alipay async notifications are verified with sign/sign_type excluded from the source string.
  verifier.update(buildAlipaySignContent(payload, { excludeSignType: true }), 'utf8');
  return verifier.verify(publicKey, sign, 'base64');
}

function formatCurrencyAmount(value) {
  return Number(value || 0).toFixed(2);
}

function buildGatewayOutTradeNo(prefix, sourceOrderId) {
  const normalizedPrefix = String(prefix || '').replace(/[^0-9A-Za-z_]/g, '');
  const normalizedOrderId = String(sourceOrderId || '').trim().replace(/[^0-9A-Za-z_]/g, '_');
  const composite = (normalizedPrefix + normalizedOrderId).replace(/^_+/, '');
  return (composite || ('trade_' + Date.now())).slice(0, 64);
}

function buildAlipayOutTradeNo(ownerUsername, sourceOrderId) {
  return buildGatewayOutTradeNo('cs_', sourceOrderId);
}

function parseAlipayOutTradeNo(value) {
  const raw = String(value || '').trim();
  const separatorIndex = raw.indexOf(':');
  if (!raw || separatorIndex <= 0) return null;
  return {
    ownerUsername: raw.slice(0, separatorIndex),
    sourceOrderId: raw.slice(separatorIndex + 1)
  };
}

function buildAlipayOrderSubject(order) {
  const normalizedOrder = normalizeOrderRecord(order);
  const firstItem = normalizeOrderItem(normalizedOrder.items[0], 0);
  const base = firstItem && firstItem.name ? firstItem.name : '日精月华订单';
  const suffix = normalizedOrder.items.length > 1 ? ('等' + normalizedOrder.items.length + '件商品') : '';
  return (base + suffix).slice(0, 64);
}

function buildAlipayReturnUrl(config, order) {
  const base = String(config && config.returnUrl || '').trim();
  if (!base) return '';
  const separator = base.indexOf('?') >= 0 ? '&' : '?';
  return base + separator + 'orderId=' + encodeURIComponent(String(order && order.id || ''));
}

function buildAlipayQuitUrl(config) {
  const returnUrl = String(config && config.returnUrl || '').trim();
  if (returnUrl) {
    try {
      return new URL(returnUrl).origin + '/#/orders';
    } catch (error) {
      // Fall through to the configured public base URL when returnUrl is malformed.
    }
  }
  const publicBaseUrl = String(config && config.publicBaseUrl || '').trim();
  return publicBaseUrl ? (publicBaseUrl + '/#/orders') : '';
}

function buildAlipayGatewayRequest(methodName, bizContent, config, extraParams) {
  const params = Object.assign({
    app_id: config.appId,
    method: String(methodName || '').trim(),
    format: 'JSON',
    charset: config.charset,
    sign_type: config.signType,
    timestamp: formatAlipayTimestamp(Date.now()),
    version: config.version
  }, extraParams || {});
  if (config.sellerId && !params.seller_id) params.seller_id = config.sellerId;
  if (bizContent && Object.keys(bizContent).length) params.biz_content = JSON.stringify(bizContent);
  params.sign = signAlipayParams(params, config.privateKey);
  return {
    gateway: config.gateway,
    method: 'POST',
    params: params
  };
}

function getAlipayResponseNodeKey(methodName) {
  return String(methodName || '').trim().replace(/\./g, '_') + '_response';
}

function requestUrlEncodedForm(targetUrl, params) {
  const endpoint = new URL(String(targetUrl || '').trim());
  const body = new URLSearchParams(params || {}).toString();
  const transport = endpoint.protocol === 'http:' ? http : https;
  return new Promise(function (resolve, reject) {
    const request = transport.request({
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      port: endpoint.port || (endpoint.protocol === 'http:' ? 80 : 443),
      path: endpoint.pathname + endpoint.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=' + ALIPAY_CHARSET,
        'Accept-Charset': ALIPAY_CHARSET,
        'Content-Length': Buffer.byteLength(body, 'utf8')
      }
    }, function (response) {
      const chunks = [];
      response.on('data', function (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', function () {
        resolve({
          statusCode: Number(response.statusCode || 0),
          headers: response.headers || {},
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

async function callAlipayGateway(methodName, bizContent, config, extraParams) {
  const requestPayload = buildAlipayGatewayRequest(methodName, bizContent, config, extraParams);
  let gatewayResponse = null;
  try {
    gatewayResponse = await requestUrlEncodedForm(requestPayload.gateway, requestPayload.params);
  } catch (error) {
    throw new Error('支付宝网关请求失败：' + (error && error.message ? error.message : String(error)));
  }
  if (gatewayResponse.statusCode < 200 || gatewayResponse.statusCode >= 300) {
    throw new Error('支付宝网关响应失败（HTTP ' + gatewayResponse.statusCode + '）');
  }
  let payload = null;
  try {
    payload = JSON.parse(String(gatewayResponse.body || '{}'));
  } catch (error) {
    throw new Error('支付宝网关返回了无法解析的响应');
  }
  const responseNodeKey = getAlipayResponseNodeKey(methodName);
  const responseNode = payload && payload[responseNodeKey] && typeof payload[responseNodeKey] === 'object'
    ? payload[responseNodeKey]
    : null;
  if (!responseNode) {
    throw new Error('支付宝网关返回缺少 ' + responseNodeKey);
  }
  if (String(responseNode.code || '') !== '10000') {
    const errorParts = [];
    if (responseNode.sub_code) errorParts.push(String(responseNode.sub_code));
    errorParts.push(String(responseNode.sub_msg || responseNode.msg || '支付宝接口调用失败'));
    if (responseNode.code) errorParts.push('(code ' + String(responseNode.code) + ')');
    throw new Error(errorParts.join(' '));
  }
  return {
    request: requestPayload,
    raw: payload,
    response: responseNode
  };
}

function buildAlipayWapRequest(order, paymentTransaction, config) {
  const normalizedOrder = normalizeOrderRecord(order);
  const payment = normalizePaymentTransaction(paymentTransaction);
  const bizContent = {
    out_trade_no: payment.externalTradeNo || buildAlipayOutTradeNo(normalizedOrder.owner, normalizedOrder.id),
    total_amount: formatCurrencyAmount(normalizedOrder.total),
    subject: buildAlipayOrderSubject(normalizedOrder),
    product_code: 'QUICK_WAP_PAY',
    quit_url: buildAlipayQuitUrl(config)
  };
  return buildAlipayGatewayRequest(ALIPAY_WAP_METHOD, Object.assign(bizContent, {
    timeout_express: ALIPAY_TIMEOUT_EXPRESS
  }), config, {
    notify_url: config.notifyUrl,
    return_url: buildAlipayReturnUrl(config, normalizedOrder)
  });
}

function isWechatBrowser(req) {
  const userAgent = String(req && req.headers && (req.headers['user-agent'] || req.headers['User-Agent']) || '').toLowerCase();
  return userAgent.indexOf('micromessenger') >= 0;
}

function getPaymentChannelRuntimeMeta(req, options) {
  const config = Object.assign({ preferredChannel: '' }, options || {});
  const availableChannels = [];
  const alipayEnabled = parseEnvFlag(process.env.ALIPAY_ENABLED);
  const wechatEnabled = parseEnvFlag(process.env.WECHAT_PAY_ENABLED);
  const wechatBrowser = isWechatBrowser(req);
  if (wechatEnabled && wechatBrowser) availableChannels.push('wechat_h5_inapp');
  if (alipayEnabled) availableChannels.push('alipay_wap');
  if (wechatEnabled && !wechatBrowser) availableChannels.push('wechat_h5_external');
  const recommendedChannel = availableChannels.indexOf(config.preferredChannel) >= 0
    ? config.preferredChannel
    : (availableChannels[0] || '');
  return {
    availableChannels: availableChannels,
    recommendedChannel: recommendedChannel,
    wechatBrowser: wechatBrowser
  };
}

function withPaymentRuntimeMeta(order, req, options) {
  return Object.assign({}, normalizeOrderRecord(order), getPaymentChannelRuntimeMeta(req, options));
}

function getWechatPayConfig(req) {
  const enabled = parseEnvFlag(process.env.WECHAT_PAY_ENABLED);
  const explicitPublicBaseUrl = String(process.env.CLOUD_STORE_PUBLIC_BASE_URL || '').trim();
  const publicBaseUrl = explicitPublicBaseUrl || ((!enabled || isLocalMockPaymentEnabled()) ? buildPublicBaseUrl(req) : '');
  const inAppReturnUrl = String(process.env.WECHAT_PAY_INAPP_RETURN_URL || '').trim() || (publicBaseUrl ? (publicBaseUrl + '/#/paymentResult') : '');
  const externalReturnUrl = String(process.env.WECHAT_PAY_EXTERNAL_RETURN_URL || '').trim() || (publicBaseUrl ? (publicBaseUrl + '/#/paymentResult') : '');
  return {
    enabled: enabled,
    appId: String(process.env.WECHAT_PAY_APP_ID || '').trim(),
    mchId: String(process.env.WECHAT_PAY_MCH_ID || '').trim(),
    apiV3Key: String(process.env.WECHAT_PAY_API_V3_KEY || '').trim(),
    privateKey: normalizePemEnvValue(process.env.WECHAT_PAY_PRIVATE_KEY),
    certSerialNo: String(process.env.WECHAT_PAY_CERT_SERIAL_NO || '').trim(),
    notifyUrl: String(process.env.WECHAT_PAY_NOTIFY_URL || '').trim(),
    publicBaseUrl: publicBaseUrl,
    inAppReturnUrl: inAppReturnUrl,
    externalReturnUrl: externalReturnUrl,
    h5Gateway: String(process.env.WECHAT_PAY_H5_GATEWAY || '').trim() || WECHAT_PAY_H5_GATEWAY_DEFAULT,
    jsapiGateway: String(process.env.WECHAT_PAY_JSAPI_GATEWAY || '').trim() || WECHAT_PAY_JSAPI_GATEWAY_DEFAULT
  };
}

function assertWechatPayReady(config, channel) {
  if (!config.enabled) {
    throw new Error('微信支付未启用，请先在 cloud-store.env 中设置 WECHAT_PAY_ENABLED=true');
  }
  const missingKeys = [];
  if (!config.appId) missingKeys.push('WECHAT_PAY_APP_ID');
  if (!config.mchId) missingKeys.push('WECHAT_PAY_MCH_ID');
  if (!config.apiV3Key) missingKeys.push('WECHAT_PAY_API_V3_KEY');
  if (!config.privateKey) missingKeys.push('WECHAT_PAY_PRIVATE_KEY');
  if (!config.certSerialNo) missingKeys.push('WECHAT_PAY_CERT_SERIAL_NO');
  if (!config.notifyUrl) missingKeys.push('WECHAT_PAY_NOTIFY_URL');
  if (channel === 'wechat_h5_inapp' && !config.inAppReturnUrl) missingKeys.push('WECHAT_PAY_INAPP_RETURN_URL');
  if (channel === 'wechat_h5_external' && !config.externalReturnUrl) missingKeys.push('WECHAT_PAY_EXTERNAL_RETURN_URL');
  if (missingKeys.length) {
    throw new Error('微信支付配置不完整，请先在 cloud-store.env 中补齐 ' + missingKeys.join('、'));
  }
}

function buildWechatReturnUrl(baseUrl, order) {
  const base = String(baseUrl || '').trim();
  if (!base) return '';
  const separator = base.indexOf('?') >= 0 ? '&' : '?';
  return base + separator + 'orderId=' + encodeURIComponent(String(order && order.id || ''));
}

function buildWechatLaunchRequest(order, paymentTransaction, config, channel, req) {
  const normalizedOrder = normalizeOrderRecord(order);
  const payment = normalizePaymentTransaction(paymentTransaction);
  const externalTradeNo = payment.externalTradeNo || buildAlipayOutTradeNo(normalizedOrder.owner, normalizedOrder.id);
  const commonParams = {
    appid: config.appId,
    mchid: config.mchId,
    description: buildAlipayOrderSubject(normalizedOrder),
    out_trade_no: externalTradeNo,
    notify_url: config.notifyUrl,
    amount: {
      total: Math.round(Number(normalizedOrder.total || 0) * 100),
      currency: 'CNY'
    }
  };
  if (channel === 'wechat_h5_inapp') {
    return {
      gateway: config.jsapiGateway,
      method: 'POST',
      params: Object.assign({}, commonParams, {
        trade_type: 'JSAPI',
        redirect_url: buildWechatReturnUrl(config.inAppReturnUrl, normalizedOrder),
        payer: {
          openid: String(req && req.headers && req.headers['x-wechat-openid'] || '').trim() || 'mock-openid-for-contract'
        }
      })
    };
  }
  return {
    gateway: config.h5Gateway,
    method: 'POST',
    params: Object.assign({}, commonParams, {
      trade_type: 'H5',
      redirect_url: buildWechatReturnUrl(config.externalReturnUrl, normalizedOrder),
      scene_info: {
        payer_client_ip: getClientIp(req),
        h5_info: { type: 'Wap' }
      }
    })
  };
}

function getClientIp(req) {
  const forwardedFor = String(req && req.headers && req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwardedFor || String(req && req.ip || 'unknown');
}

function consumeRateLimitFailure(key) {
  const now = Date.now();
  const existing = authAttemptBuckets.get(key) || { failures: [], blockedUntil: 0 };
  const recentFailures = existing.failures.filter(function (timestamp) {
    return now - timestamp <= AUTH_RATE_LIMIT_WINDOW_MS;
  });
  recentFailures.push(now);
  const blockedUntil = recentFailures.length >= AUTH_RATE_LIMIT_MAX_FAILURES ? now + AUTH_RATE_LIMIT_WINDOW_MS : 0;
  authAttemptBuckets.set(key, { failures: recentFailures, blockedUntil: blockedUntil });
  return blockedUntil;
}

function clearRateLimitFailures(key) {
  authAttemptBuckets.delete(key);
}

function getRateLimitBlockMessage(key) {
  const now = Date.now();
  const bucket = authAttemptBuckets.get(key);
  if (!bucket) return '';
  if (bucket.blockedUntil && bucket.blockedUntil > now) {
    const waitMinutes = Math.max(1, Math.ceil((bucket.blockedUntil - now) / 60000));
    return '登录失败次数过多，请在 ' + waitMinutes + ' 分钟后重试';
  }
  return '';
}

function normalizePhoneNumber(value) {
  return String(value || '').replace(/[^\d]/g, '').trim();
}

function isValidChinaMainlandPhone(value) {
  return /^1\d{10}$/.test(normalizePhoneNumber(value));
}

function maskPhoneNumber(value) {
  const normalized = normalizePhoneNumber(value);
  if (!isValidChinaMainlandPhone(normalized)) return '';
  return normalized.slice(0, 3) + '****' + normalized.slice(-4);
}

function generateSmsVerificationCode() {
  return String(Math.floor(Math.random() * 900000) + 100000);
}

function normalizeSmsPurpose(value) {
  const normalized = String(value || '').trim();
  if (normalized === 'reset_password') return 'reset_password';
  if (normalized === 'login_or_register') return 'login_or_register';
  return 'bind_phone';
}

function getSmsPurposeLabel(value) {
  const normalized = normalizeSmsPurpose(value);
  if (normalized === 'reset_password') return '找回密码';
  if (normalized === 'login_or_register') return '登录或注册';
  return '绑定手机号';
}

function validateNewPassword(value) {
  const password = String(value || '');
  if (!password) return '请填写新密码';
  if (password.length < PASSWORD_MIN_LENGTH) return '新密码至少 6 位';
  return '';
}

function percentEncodeAliyun(value) {
  return encodeURIComponent(String(value || ''))
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

function buildAliyunRpcSignedUrl(params, accessKeyId, accessKeySecret, host) {
  const publicParams = Object.assign({}, params, {
    AccessKeyId: accessKeyId,
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: generateToken(16),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: '2017-05-25'
  });
  const canonicalized = Object.keys(publicParams)
    .sort()
    .map(function (key) {
      return percentEncodeAliyun(key) + '=' + percentEncodeAliyun(publicParams[key]);
    })
    .join('&');
  const stringToSign = 'GET&%2F&' + percentEncodeAliyun(canonicalized);
  const signature = crypto
    .createHmac('sha1', String(accessKeySecret || '') + '&')
    .update(stringToSign)
    .digest('base64');
  return String(host || 'https://dypnsapi.aliyuncs.com/')
    .replace(/\?+$/, '')
    + '/?' + canonicalized + '&Signature=' + percentEncodeAliyun(signature);
}

function getAliyunSmsConfig(purpose) {
  const normalizedPurpose = normalizeSmsPurpose(purpose);
  const accessKeyId = String(process.env.ALIYUN_SMS_ACCESS_KEY_ID || '').trim();
  const accessKeySecret = String(process.env.ALIYUN_SMS_ACCESS_KEY_SECRET || '').trim();
  const signName = String(process.env.ALIYUN_SMS_SIGN_NAME || '').trim();
  const bindTemplateCode = String(process.env.ALIYUN_SMS_TEMPLATE_CODE_BIND_PHONE || process.env.ALIYUN_SMS_TEMPLATE_CODE || '').trim();
  const resetTemplateCode = String(process.env.ALIYUN_SMS_TEMPLATE_CODE_RESET_PASSWORD || process.env.ALIYUN_SMS_TEMPLATE_CODE || '').trim();
  const loginTemplateCode = String(process.env.ALIYUN_SMS_TEMPLATE_CODE_LOGIN_OR_REGISTER || process.env.ALIYUN_SMS_TEMPLATE_CODE_LOGIN || bindTemplateCode).trim();
  const templateCode = normalizedPurpose === 'reset_password'
    ? resetTemplateCode
    : (normalizedPurpose === 'login_or_register' ? loginTemplateCode : bindTemplateCode);
  const schemeName = String(process.env.ALIYUN_SMS_SCHEME_NAME || '').trim();
  const provider = String(process.env.CS_SMS_PROVIDER || '').trim().toLowerCase();
  const hasAliyunConfig = !!(accessKeyId && accessKeySecret && signName && templateCode);
  const inferredProvider = provider || (hasAliyunConfig ? 'aliyun' : (isProductionRuntime() ? 'aliyun' : 'mock'));
  return {
    provider: inferredProvider,
    accessKeyId: accessKeyId,
    accessKeySecret: accessKeySecret,
    signName: signName,
    templateCode: templateCode,
    schemeName: schemeName
  };
}

function shouldExposeSmsDebugCode(config) {
  const explicit = String(process.env.CS_SMS_DEBUG_CODES || '').trim().toLowerCase();
  if (explicit) return parseEnvFlag(explicit);
  return false;
}

async function sendAliyunSms(phone, code, purpose) {
  const config = getAliyunSmsConfig(purpose);
  if (config.provider !== 'aliyun') {
    return {
      provider: 'mock',
      deliveryStatus: 'mock',
      messageId: 'mock_' + Date.now(),
      debugCode: code
    };
  }
  if (!config.accessKeyId || !config.accessKeySecret || !config.signName || !config.templateCode) {
    throw new Error('阿里云号码认证短信认证配置不完整，请先补齐 AccessKey、赠送签名和赠送模板编号');
  }
  const debugMode = shouldExposeSmsDebugCode(config);
  const templateParam = {
    code: '##code##',
    min: String(Math.max(1, Math.ceil(SMS_CODE_TTL_MS / 60000)))
  };
  const requestParams = {
    Action: 'SendSmsVerifyCode',
    PhoneNumber: phone,
    CountryCode: '86',
    SignName: config.signName,
    TemplateCode: config.templateCode,
    TemplateParam: JSON.stringify(templateParam),
    OutId: 'cloud_store_' + normalizeSmsPurpose(purpose) + '_' + Date.now(),
    CodeLength: 6,
    ValidTime: Math.ceil(SMS_CODE_TTL_MS / 1000),
    DuplicatePolicy: 1,
    Interval: Math.ceil(SMS_CODE_RESEND_MS / 1000),
    CodeType: 1,
    AutoRetry: 1,
    ReturnVerifyCode: debugMode ? 'true' : 'false'
  };
  if (config.schemeName) requestParams.SchemeName = config.schemeName;
  const requestUrl = buildAliyunRpcSignedUrl(requestParams, config.accessKeyId, config.accessKeySecret, 'https://dypnsapi.aliyuncs.com');
  const responseText = await new Promise(function (resolve, reject) {
    https.get(requestUrl, function (response) {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', function (chunk) { body += chunk; });
      response.on('end', function () {
        if (response.statusCode >= 400) {
          reject(new Error('阿里云短信请求失败：HTTP ' + response.statusCode + ' ' + body));
          return;
        }
        resolve(body);
      });
    }).on('error', reject);
  });
  let payload = {};
  try {
    payload = JSON.parse(responseText || '{}');
  } catch (error) {
    throw new Error('阿里云号码认证短信认证返回结果无法解析');
  }
  if (String(payload.Code || '').trim() !== 'OK') {
    throw new Error('阿里云号码认证短信发送失败：' + String(payload.Message || payload.Code || '未知错误'));
  }
  return {
    provider: 'aliyun',
    deliveryStatus: 'sent',
    messageId: String(payload && payload.Model && payload.Model.BizId || payload.BizId || payload.RequestId || ''),
    debugCode: debugMode ? String(payload && payload.Model && payload.Model.VerifyCode || '') : undefined
  };
}

async function checkAliyunSmsVerification(phone, code, purpose) {
  const config = getAliyunSmsConfig(purpose);
  if (config.provider !== 'aliyun') {
    return { verified: false, provider: 'mock' };
  }
  if (!config.accessKeyId || !config.accessKeySecret) {
    throw new Error('阿里云号码认证短信认证配置不完整，请先补齐 AccessKey');
  }
  const requestParams = {
    Action: 'CheckSmsVerifyCode',
    PhoneNumber: phone,
    CountryCode: '86',
    VerifyCode: String(code || '').trim(),
    CaseAuthPolicy: 1
  };
  if (config.schemeName) requestParams.SchemeName = config.schemeName;
  const requestUrl = buildAliyunRpcSignedUrl(requestParams, config.accessKeyId, config.accessKeySecret, 'https://dypnsapi.aliyuncs.com');
  const responseText = await new Promise(function (resolve, reject) {
    https.get(requestUrl, function (response) {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', function (chunk) { body += chunk; });
      response.on('end', function () {
        if (response.statusCode >= 400) {
          reject(new Error('阿里云号码认证短信核验失败：HTTP ' + response.statusCode + ' ' + body));
          return;
        }
        resolve(body);
      });
    }).on('error', reject);
  });
  let payload = {};
  try {
    payload = JSON.parse(responseText || '{}');
  } catch (error) {
    throw new Error('阿里云号码认证短信核验返回结果无法解析');
  }
  if (String(payload.Code || '').trim() !== 'OK') {
    throw new Error('阿里云号码认证短信核验失败：' + String(payload.Message || payload.Code || '未知错误'));
  }
  const verifyResult = String(payload && payload.Model && payload.Model.VerifyResult || '').trim().toUpperCase();
  return {
    provider: 'aliyun',
    verified: verifyResult === 'PASS',
    verifyResult: verifyResult
  };
}

function readDefaultArray(pattern) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const matched = html.match(pattern);
  if (!matched) return [];
  const defaults = vm.runInNewContext('(' + matched[1] + ')');
  return Array.isArray(defaults) ? defaults : [];
}

function createDefaultCouponTemplates() {
  return [
    { templateId: 'welcome10', name: '新人券', type: 'full_reduction', amount: 10, minSpend: 50 },
    { templateId: 'fresh90', name: '鲜享折扣券', type: 'discount', discountRate: 9.0, minSpend: 0 }
  ];
}

function normalizeCouponTemplate(item, index) {
  return {
    id: item && item.id ? Number(item.id) : undefined,
    templateId: item && (item.templateId || item.id) ? String(item.templateId || item.id) : 'tpl_' + index,
    name: item && item.name ? item.name : '未命名优惠券',
    type: item && item.type === 'discount' ? 'discount' : 'full_reduction',
    discountRate: Number(item && item.discountRate || 0),
    amount: Number(item && item.amount || 0),
    minSpend: Number(item && item.minSpend || 0)
  };
}

function hydrateCouponTemplate(row) {
  return normalizeCouponTemplate({
    id: row.id,
    templateId: row.templateId,
    name: row.name,
    type: row.type,
    discountRate: row.discountRate,
    amount: row.amount,
    minSpend: row.minSpend
  }, row.id || 0);
}

function toDbCouponTemplate(item, index) {
  const template = normalizeCouponTemplate(item, index);
  return {
    id: template.id,
    templateId: template.templateId,
    name: template.name,
    type: template.type,
    discountRate: template.discountRate,
    amount: template.amount,
    minSpend: template.minSpend
  };
}

function buildCouponFromTemplate(template) {
  const item = normalizeCouponTemplate(template, 0);
  return {
    id: 'coupon_' + item.templateId + '_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
    templateId: item.templateId,
    name: item.name,
    type: item.type,
    discountRate: Number(item.discountRate || 0),
    amount: Number(item.amount || 0),
    minSpend: Number(item.minSpend || 0),
    used: false
  };
}

// [SERVER_USER_MODEL] 用户角色、地址、购物车、订单、会员信息都在这里做标准化。
function normalizeRoleFlags(username, roles) {
  const name = String(username || '').trim();
  const normalized = Object.assign({ isFarmer: false, isAdmin: false, isSuperAdmin: false, farmerName: name }, roles || {});
  normalized.isFarmer = !!normalized.isFarmer;
  normalized.isAdmin = !!normalized.isAdmin;
  normalized.isSuperAdmin = !!normalized.isSuperAdmin;
  normalized.farmerName = normalized.farmerName ? String(normalized.farmerName) : name;
  // admin 账号是系统内置超级管理员，始终拥有全部后台权限，避免历史脏数据把超管角色改丢。
  if (name === 'admin') {
    normalized.isSuperAdmin = true;
    normalized.isAdmin = true;
    normalized.isFarmer = true;
    normalized.farmerName = '系统管理员';
  }
  return normalized;
}

function normalizeUserRecord(record) {
  return Object.assign({
    id: record && record.id ? Number(record.id) : undefined,
    username: '',
    password: '',
    nickname: '',
    phone: '',
    phoneVerifiedAt: 0,
    roles: { isFarmer: false, isAdmin: false, isSuperAdmin: false, farmerName: '' },
    addresses: [],
    shippingAddresses: [],
    coupons: [],
    selectedAddressId: '',
    selectedCouponId: '',
    cart: [],
    orders: [],
    member: { levelId: 'normal', points: 0, totalSpent: 0 },
    createdAt: new Date().toLocaleDateString('zh-CN')
  }, record || {}, {
    id: record && record.id ? Number(record.id) : undefined,
    nickname: String(record && record.nickname || '').trim(),
    phone: normalizePhoneNumber(record && record.phone),
    phoneVerifiedAt: Number(record && record.phoneVerifiedAt || 0),
    roles: normalizeRoleFlags(record && record.username, record && record.roles),
    addresses: Array.isArray(record && record.addresses) ? record.addresses : [],
    shippingAddresses: Array.isArray(record && record.shippingAddresses) ? record.shippingAddresses : [],
    coupons: Array.isArray(record && record.coupons) ? record.coupons : [],
    cart: Array.isArray(record && record.cart) ? record.cart : [],
    orders: Array.isArray(record && record.orders) ? record.orders : [],
    member: Object.assign({ levelId: 'normal', points: 0, totalSpent: 0 }, record && record.member || {})
  });
}

function buildUserSummaryRecord(record) {
  const user = normalizeUserRecord(record);
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    phone: user.phone,
    phoneVerifiedAt: user.phoneVerifiedAt,
    roles: user.roles,
    createdAt: user.createdAt
  };
}

function userHasPassword(record) {
  const user = normalizeUserRecord(record);
  return !!String(user.password || '').trim();
}

function selfUserRecord(record) {
  const user = normalizeUserRecord(record);
  user.hasPassword = userHasPassword(user);
  delete user.password;
  return user;
}

function publicUserRecord(record) {
  return buildUserSummaryRecord(record);
}

function hydrateUser(row) {
  return normalizeUserRecord({
    id: row.id,
    username: row.username,
    password: row.password,
    nickname: row.nickname,
    phone: row.phone,
    phoneVerifiedAt: row.phoneVerifiedAt,
    roles: parseJsonObject(row.roles, { isFarmer: false, isAdmin: false, farmerName: row.username }),
    addresses: parseJsonArray(row.addresses),
    shippingAddresses: parseJsonArray(row.shippingAddresses),
    coupons: parseJsonArray(row.coupons),
    selectedAddressId: row.selectedAddressId,
    selectedCouponId: row.selectedCouponId,
    cart: parseJsonArray(row.cart),
    orders: parseJsonArray(row.orders),
    member: parseJsonObject(row.member, { levelId: 'normal', points: 0, totalSpent: 0 }),
    createdAt: row.createdAt
  });
}

function toDbUser(record) {
  const user = normalizeUserRecord(record);
  return {
    id: user.id,
    username: user.username,
    password: user.password || '',
    nickname: user.nickname || '',
    phone: user.phone || '',
    phoneVerifiedAt: Number(user.phoneVerifiedAt || 0),
    roles: JSON.stringify(user.roles || {}),
    addresses: JSON.stringify(user.addresses || []),
    shippingAddresses: JSON.stringify(user.shippingAddresses || []),
    coupons: JSON.stringify(user.coupons || []),
    selectedAddressId: user.selectedAddressId || '',
    selectedCouponId: user.selectedCouponId || '',
    cart: JSON.stringify(user.cart || []),
    orders: JSON.stringify(user.orders || []),
    member: JSON.stringify(user.member || {}),
    createdAt: user.createdAt || new Date().toLocaleDateString('zh-CN')
  };
}

function normalizeUserAddress(item, type, index) {
  return {
    id: item && item.id ? String(item.id) : 'addr_' + type + '_' + index,
    type: type === 'shipping' ? 'shipping' : 'receiver',
    name: item && item.name ? String(item.name) : '',
    phone: item && item.phone ? String(item.phone) : '',
    full: item && item.full ? String(item.full) : '',
    sortOrder: Number(item && item.sortOrder != null ? item.sortOrder : index || 0)
  };
}

function hydrateUserAddress(row) {
  return normalizeUserAddress({
    id: row.sourceId || row.id,
    name: row.name,
    phone: row.phone,
    full: row.full,
    sortOrder: row.sortOrder
  }, row.type, row.sortOrder);
}

function normalizeOrderRecord(order) {
  return Object.assign({
    id: '',
    owner: '',
    ownerDeleted: false,
    items: [],
    shipments: [],
    fulfillmentSummary: {
      shipmentCount: 0,
      assignedItemCount: 0,
      totalItemCount: 0,
      unassignedItemCount: 0
    },
    total: 0,
    subtotal: 0,
    deliveryFee: 0,
    discount: 0,
    status: 'pending',
    time: Date.now(),
    address: {},
    coupon: '',
    couponId: '',
    trackingNo: '',
    reserveExpiresAt: 0,
    inventoryReleased: false,
    inventoryReleasedAt: 0,
    cancelReason: ''
  }, order || {}, {
    id: order && order.id ? String(order.id) : '',
    owner: order && (order.owner || order.username) ? String(order.owner || order.username) : '',
    ownerDeleted: !!(order && order.ownerDeleted),
    items: Array.isArray(order && order.items) ? order.items : [],
    shipments: Array.isArray(order && order.shipments) ? order.shipments.map(function (shipment) { return normalizeShipmentRecord(shipment); }) : [],
    fulfillmentSummary: normalizeFulfillmentSummary(order && order.fulfillmentSummary, order && order.items, order && order.shipments),
    total: Number(order && order.total || 0),
    subtotal: Number(order && order.subtotal || 0),
    deliveryFee: Number(order && order.deliveryFee || 0),
    discount: Number(order && order.discount || 0),
    status: order && order.status ? String(order.status) : 'pending',
    time: Number(order && order.time || Date.now()),
    address: order && order.address && typeof order.address === 'object' && !Array.isArray(order.address) ? order.address : {},
    coupon: order && order.coupon ? String(order.coupon) : '',
    couponId: order && order.couponId ? String(order.couponId) : '',
    trackingNo: order && order.trackingNo ? String(order.trackingNo) : '',
    reserveExpiresAt: Number(order && order.reserveExpiresAt || 0),
    inventoryReleased: !!(order && order.inventoryReleased),
    inventoryReleasedAt: Number(order && order.inventoryReleasedAt || 0),
    cancelReason: order && order.cancelReason ? String(order.cancelReason) : ''
  });
}

function isPaidOrderStatus(status) {
  return ['paid', 'shipped', 'done'].indexOf(String(status || '')) >= 0;
}

function getAftersaleTypeByStatus(status) {
  const value = String(status || '').toLowerCase();
  if (!value) return '';
  if (value === 'cancelled') return 'cancel';
  if (value.indexOf('refund') >= 0) return 'refund';
  if (value.indexOf('after') >= 0 || value.indexOf('service') >= 0) return 'after_sale';
  return '';
}

function normalizeRefundRequest(record) {
  return Object.assign({
    id: '',
    orderId: '',
    ownerUsername: '',
    scopeType: 'order',
    itemsSnapshot: [],
    sourceOrderStatus: '',
    status: 'pending',
    refundAmount: 0,
    reason: '',
    assigneeRole: 'admin',
    assigneeUsername: '',
    inventoryRestored: false,
    paymentRefunded: false,
    rejectReason: '',
    requestedAt: 0,
    reviewedAt: 0,
    completedAt: 0,
    updatedAt: 0
  }, record || {}, {
    id: record && record.id ? String(record.id) : '',
    orderId: record && record.orderId ? String(record.orderId) : '',
    ownerUsername: record && record.ownerUsername ? String(record.ownerUsername) : '',
    scopeType: record && record.scopeType === 'item' ? 'item' : 'order',
    itemsSnapshot: Array.isArray(record && record.itemsSnapshot) ? record.itemsSnapshot.map(function (item, index) {
      return normalizeOrderItem(item, index);
    }) : [],
    sourceOrderStatus: record && record.sourceOrderStatus ? String(record.sourceOrderStatus) : '',
    status: record && record.status ? String(record.status) : 'pending',
    refundAmount: Number(record && record.refundAmount || 0),
    reason: record && record.reason ? String(record.reason) : '',
    assigneeRole: record && record.assigneeRole ? String(record.assigneeRole) : 'admin',
    assigneeUsername: record && record.assigneeUsername ? String(record.assigneeUsername) : '',
    inventoryRestored: !!(record && record.inventoryRestored),
    paymentRefunded: !!(record && record.paymentRefunded),
    rejectReason: record && record.rejectReason ? String(record.rejectReason) : '',
    requestedAt: Number(record && record.requestedAt || 0),
    reviewedAt: Number(record && record.reviewedAt || 0),
    completedAt: Number(record && record.completedAt || 0),
    updatedAt: Number(record && record.updatedAt || 0)
  });
}

function hydrateRefundRequest(row) {
  return normalizeRefundRequest({
    id: row.id,
    orderId: row.orderId,
    ownerUsername: row.ownerUsername,
    scopeType: row.scopeType,
    itemsSnapshot: parseJsonArray(row.itemsSnapshot),
    sourceOrderStatus: row.sourceOrderStatus,
    status: row.status,
    refundAmount: row.refundAmount,
    reason: row.reason,
    assigneeRole: row.assigneeRole,
    assigneeUsername: row.assigneeUsername,
    inventoryRestored: !!row.inventoryRestored,
    paymentRefunded: !!row.paymentRefunded,
    rejectReason: row.rejectReason,
    requestedAt: row.requestedAt,
    reviewedAt: row.reviewedAt,
    completedAt: row.completedAt,
    updatedAt: row.updatedAt
  });
}

function toDbRefundRequest(record) {
  const refund = normalizeRefundRequest(record);
  return {
    id: refund.id,
    orderId: refund.orderId,
    ownerUsername: refund.ownerUsername,
    scopeType: refund.scopeType,
    itemsSnapshot: JSON.stringify(refund.itemsSnapshot || []),
    sourceOrderStatus: refund.sourceOrderStatus,
    status: refund.status,
    refundAmount: refund.refundAmount,
    reason: refund.reason,
    assigneeRole: refund.assigneeRole,
    assigneeUsername: refund.assigneeUsername,
    inventoryRestored: refund.inventoryRestored ? 1 : 0,
    paymentRefunded: refund.paymentRefunded ? 1 : 0,
    rejectReason: refund.rejectReason,
    requestedAt: refund.requestedAt,
    reviewedAt: refund.reviewedAt,
    completedAt: refund.completedAt,
    updatedAt: refund.updatedAt
  };
}

function normalizeAuditMeta(audit, fallback) {
  return Object.assign({
    actionType: 'manual_adjust',
    operatorUsername: '',
    operatorRole: 'system',
    orderId: '',
    note: '',
    channel: 'mock_h5'
  }, fallback || {}, audit && typeof audit === 'object' && !Array.isArray(audit) ? audit : {}, {
    actionType: audit && audit.actionType ? String(audit.actionType) : (fallback && fallback.actionType ? String(fallback.actionType) : 'manual_adjust'),
    operatorUsername: audit && audit.operatorUsername ? String(audit.operatorUsername) : (fallback && fallback.operatorUsername ? String(fallback.operatorUsername) : ''),
    operatorRole: audit && audit.operatorRole ? String(audit.operatorRole) : (fallback && fallback.operatorRole ? String(fallback.operatorRole) : 'system'),
    orderId: audit && audit.orderId ? String(audit.orderId) : (fallback && fallback.orderId ? String(fallback.orderId) : ''),
    note: audit && audit.note ? String(audit.note) : (fallback && fallback.note ? String(fallback.note) : ''),
    channel: audit && audit.channel ? String(audit.channel) : (fallback && fallback.channel ? String(fallback.channel) : 'mock_h5')
  });
}

function buildOrderMap(orders) {
  return (Array.isArray(orders) ? orders : []).reduce(function (result, item) {
    const order = normalizeOrderRecord(item);
    if (order.id) result[order.id] = order;
    return result;
  }, {});
}

function buildVariantId(value, index) {
  const seed = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return seed ? ('variant_' + seed + '_' + Number(index || 0)) : ('variant_' + Number(index || 0));
}

function buildUnitId(value, index) {
  const seed = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return seed ? ('unit_' + seed + '_' + Number(index || 0)) : ('unit_' + Number(index || 0));
}

function buildUniqueUnitId(preferredId, label, index, usedIds) {
  const registry = usedIds || {};
  const preferred = String(preferredId || '').trim();
  const fallback = buildUnitId(label, index);
  let candidate = preferred || fallback;
  if (!registry[candidate]) {
    registry[candidate] = true;
    return candidate;
  }
  if (!registry[fallback]) {
    registry[fallback] = true;
    return fallback;
  }
  let suffix = 1;
  while (registry[fallback + '_' + suffix]) suffix += 1;
  candidate = fallback + '_' + suffix;
  registry[candidate] = true;
  return candidate;
}

function normalizeVariantUnits(variant, index, product) {
  const payload = variant || {};
  const baseProduct = product || {};
  const rawList = Array.isArray(payload.units) ? payload.units : [];
  const fallbackLabel = String(payload.unit || payload.label || baseProduct.unit || '').trim() || (index === 0 ? '默认单位' : ('单位' + (index + 1)));
  const fallbackStock = Math.max(0, Number(payload.stock != null ? payload.stock : 0));
  const fallbackPrice = Number(payload.price != null ? payload.price : (index === 0 ? Number(baseProduct.price || 0) : 0));
  const fallbackDeliveryFee = Math.max(0, Number(payload.deliveryFee != null ? payload.deliveryFee : (index === 0 ? Number(baseProduct.deliveryFee || 0) : 0)));
  const sourceList = rawList.length ? rawList : [{
    id: payload.defaultUnitId || buildUnitId(fallbackLabel || 'default', 0),
    label: fallbackLabel,
    price: fallbackPrice,
    deliveryFee: fallbackDeliveryFee,
    stock: fallbackStock,
    sortOrder: 0,
    isDefault: true
  }];
  const usedUnitIds = {};
  const normalized = sourceList.map(function (item, unitIndex) {
    const unit = item || {};
    const label = String(unit.label || '').trim() || (unitIndex === 0 ? fallbackLabel : ('单位' + (unitIndex + 1)));
    const unitId = buildUniqueUnitId(unit.id, label, unitIndex, usedUnitIds);
    return {
      id: unitId,
      label: label,
      price: Number(unit.price != null ? unit.price : (unitIndex === 0 ? fallbackPrice : fallbackPrice)),
      deliveryFee: Math.max(0, Number(unit.deliveryFee != null ? unit.deliveryFee : fallbackDeliveryFee)),
      stock: Math.max(0, Number(unit.stock != null ? unit.stock : (unitIndex === 0 ? fallbackStock : 0))),
      sortOrder: Number(unit.sortOrder != null ? unit.sortOrder : unitIndex),
      isDefault: !!unit.isDefault
    };
  }).sort(function (a, b) {
    if (Number(b.isDefault) !== Number(a.isDefault)) return Number(b.isDefault) - Number(a.isDefault);
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return String(a.id).localeCompare(String(b.id), 'zh-CN');
  }).map(function (item, unitIndex) {
    return Object.assign({}, item, {
      sortOrder: Number(item.sortOrder != null ? item.sortOrder : unitIndex)
    });
  });
  if (!normalized.some(function (item) { return item.isDefault; })) {
    normalized[0] = Object.assign({}, normalized[0], { isDefault: true });
  } else {
    let defaultAssigned = false;
    for (let unitIndex = 0; unitIndex < normalized.length; unitIndex++) {
      const shouldKeepDefault = !!normalized[unitIndex].isDefault && !defaultAssigned;
      normalized[unitIndex] = Object.assign({}, normalized[unitIndex], { isDefault: shouldKeepDefault });
      if (shouldKeepDefault) defaultAssigned = true;
    }
  }
  return normalized;
}

function getDefaultUnitForVariant(variant, product) {
  const units = normalizeVariantUnits(variant, Number(variant && variant.sortOrder || 0), product);
  return units.find(function (item) { return item.isDefault; }) || units[0] || null;
}

function getVariantUnitById(variant, unitId, product) {
  const units = normalizeVariantUnits(variant, Number(variant && variant.sortOrder || 0), product);
  const targetId = String(unitId || '').trim();
  if (!targetId) return getDefaultUnitForVariant(variant, product);
  return units.find(function (item) {
    return String(item.id || '') === targetId;
  }) || null;
}

function resolveVariantUnitForItem(variant, item, product) {
  const normalizedVariant = variant || {};
  const payload = item || {};
  const direct = getVariantUnitById(normalizedVariant, payload.unitId, product);
  if (direct) return direct;
  const targetLabel = String(payload.unitLabel || payload.unit || '').trim();
  if (!targetLabel) return getDefaultUnitForVariant(normalizedVariant, product);
  return normalizeVariantUnits(normalizedVariant, Number(normalizedVariant.sortOrder || 0), product).find(function (entry) {
    return String(entry.label || '') === targetLabel;
  }) || getDefaultUnitForVariant(normalizedVariant, product);
}

function normalizeProductVariants(product) {
  const payload = product || {};
  const rawList = Array.isArray(payload.variants) ? payload.variants : [];
  const fallbackLabel = String(payload.unit || '').trim() || '默认规格';
  const fallbackPrice = Number(payload.price || 0);
  const fallbackStock = Math.max(0, Number(payload.stock || 0));
  const sourceList = rawList.length ? rawList : [{
    id: payload.defaultVariantId || buildVariantId(fallbackLabel || 'default', 0),
    label: fallbackLabel,
    price: fallbackPrice,
    stock: fallbackStock,
    sortOrder: 0,
    isDefault: true
  }];
  const normalized = sourceList.map(function (item, index) {
    const variant = item || {};
    const label = String(variant.label || '').trim() || (index === 0 ? fallbackLabel : ('规格' + (index + 1)));
    const units = normalizeVariantUnits(variant, index, payload);
    const defaultUnit = units.find(function (entry) { return entry && entry.isDefault; }) || units[0] || null;
    return {
      id: String(variant.id || buildVariantId(label, index)),
      label: label,
      price: Number(defaultUnit && defaultUnit.price != null ? defaultUnit.price : (variant.price != null ? variant.price : (index === 0 ? fallbackPrice : 0))),
      units: units,
      stock: units.reduce(function (sum, unit) {
        return sum + Math.max(0, Number(unit && unit.stock || 0));
      }, 0),
      sortOrder: Number(variant.sortOrder != null ? variant.sortOrder : index),
      isDefault: !!variant.isDefault
    };
  }).sort(function (a, b) {
    if (Number(b.isDefault) !== Number(a.isDefault)) return Number(b.isDefault) - Number(a.isDefault);
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return String(a.id).localeCompare(String(b.id), 'zh-CN');
  }).map(function (item, index) {
    return Object.assign({}, item, {
      sortOrder: Number(item.sortOrder != null ? item.sortOrder : index)
    });
  });
  if (!normalized.some(function (item) { return item.isDefault; })) {
    normalized[0] = Object.assign({}, normalized[0], { isDefault: true });
  } else {
    let defaultAssigned = false;
    for (let index = 0; index < normalized.length; index++) {
      const shouldKeepDefault = !!normalized[index].isDefault && !defaultAssigned;
      normalized[index] = Object.assign({}, normalized[index], { isDefault: shouldKeepDefault });
      if (shouldKeepDefault) defaultAssigned = true;
    }
  }
  return normalized;
}

function getDefaultVariant(product) {
  const variants = normalizeProductVariants(product);
  return variants.find(function (item) { return item.isDefault; }) || variants[0];
}

function normalizeOrderItem(item, index) {
  return Object.assign({
    orderItemId: 0,
    id: 0,
    productId: 0,
    name: '',
    variantId: '',
    variantLabel: '',
    unitId: '',
    unitLabel: '',
    unit: '',
    price: 0,
    deliveryFee: 0,
    qty: 0,
    img: '',
    shippingAddressId: '',
    shippingAddressSnapshot: {}
    }, item || {}, {
    orderItemId: Number(item && (item.orderItemId != null ? item.orderItemId : 0) || 0),
    id: item && item.id ? Number(item.id) : index + 1,
    productId: Number(item && (item.productId != null ? item.productId : item.id) || 0),
    name: item && item.name ? String(item.name) : '',
    variantId: item && item.variantId ? String(item.variantId) : '',
    variantLabel: item && (item.variantLabel || item.unitLabel || item.unit) ? String(item.variantLabel || item.unitLabel || item.unit) : '',
    unitId: item && item.unitId ? String(item.unitId) : '',
    unitLabel: item && (item.unitLabel || item.unit || item.variantLabel) ? String(item.unitLabel || item.unit || item.variantLabel) : '',
    unit: item && (item.unit || item.unitLabel || item.variantLabel) ? String(item.unit || item.unitLabel || item.variantLabel) : '',
    price: Number(item && item.price || 0),
    deliveryFee: Number(item && item.deliveryFee || 0),
    qty: Number(item && item.qty || 0),
    img: item && item.img ? String(item.img) : '',
    shippingAddressId: item && item.shippingAddressId ? String(item.shippingAddressId) : '',
    shippingAddressSnapshot: item && item.shippingAddressSnapshot && typeof item.shippingAddressSnapshot === 'object' && !Array.isArray(item.shippingAddressSnapshot) ? item.shippingAddressSnapshot : {}
  });
}

function normalizeFulfillmentSummary(summary, items, shipments) {
  const itemList = Array.isArray(items) ? items : [];
  const shipmentList = Array.isArray(shipments) ? shipments : [];
  const assignedMap = shipmentList.reduce(function (result, shipment) {
    const ids = Array.isArray(shipment && shipment.orderItemIds) ? shipment.orderItemIds : [];
    ids.forEach(function (id) {
      const numericId = Number(id || 0);
      if (numericId > 0) result[numericId] = true;
    });
    return result;
  }, {});
  const assignedItemCount = Math.max(0, Number(summary && summary.assignedItemCount != null ? summary.assignedItemCount : Object.keys(assignedMap).length));
  const totalItemCount = Math.max(0, Number(summary && summary.totalItemCount != null ? summary.totalItemCount : itemList.length));
  return {
    shipmentCount: Math.max(0, Number(summary && summary.shipmentCount != null ? summary.shipmentCount : shipmentList.length)),
    assignedItemCount: assignedItemCount,
    totalItemCount: totalItemCount,
    unassignedItemCount: Math.max(0, Number(summary && summary.unassignedItemCount != null ? summary.unassignedItemCount : (totalItemCount - assignedItemCount)))
  };
}

function normalizeShipmentLogisticsState(state, payload) {
  const raw = String(state || '').trim();
  if (['no_tracking', 'no_trace', 'active_success', 'stale_success', 'signed'].indexOf(raw) >= 0) return raw;
  const providerState = String(payload && (payload.state != null ? payload.state : payload.logisticsProviderState) || '').trim();
  if (providerState === '3') return 'signed';
  if (providerState === '4' || providerState === '14') return 'stale_success';
  if (hasValidShipmentLogisticsData(payload && payload.data != null ? payload.data : payload && payload.logisticsDataJson)) return 'active_success';
  if (String(payload && payload.trackingNo || '').trim()) return 'no_trace';
  return 'no_tracking';
}

function normalizeShipmentLogisticsData(value) {
  const rows = Array.isArray(value) ? value : parseJsonArray(value);
  return rows.map(function (entry) {
    const payload = entry && typeof entry === 'object' ? entry : {};
    const context = String(payload.context || payload.desc || payload.description || '').trim();
    const ftime = String(payload.ftime || payload.time || payload.acceptTime || '').trim();
    const area = String(payload.area || payload.location || '').trim();
    const status = String(payload.status || payload.state || '').trim();
    const time = Math.max(0, Number(payload.timestamp || payload.timeValue || 0));
    return {
      context: context,
      ftime: ftime,
      area: area,
      status: status,
      time: time
    };
  }).filter(function (entry) {
    return !!(entry.context || entry.ftime || entry.area || entry.status || entry.time);
  });
}

function isShipmentInvalidLogisticsContext(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  return /(查无结果|暂无结果|暂无轨迹|暂无物流|无物流信息|暂未查询到)/.test(text);
}

function hasValidShipmentLogisticsData(value) {
  return normalizeShipmentLogisticsData(value).some(function (entry) {
    return !isShipmentInvalidLogisticsContext(entry.context);
  });
}

function normalizeShipmentProviderState(value, logisticsState, logisticsData) {
  const raw = String(value || '').trim();
  if (raw) return raw;
  if (String(logisticsState || '').trim() === 'signed') return '3';
  if (hasValidShipmentLogisticsData(logisticsData)) return '0';
  return '';
}

function describeShipmentProviderState(value, logisticsState) {
  const providerState = String(value || '').trim();
  if (providerState === '3') return '已签收';
  if (providerState === '4') return '已退签';
  if (providerState === '14') return '已拒签';
  if (String(logisticsState || '').trim() === 'signed') return '已签收';
  return '';
}

function getLatestShipmentLogisticsContext(logisticsData) {
  const validEntries = normalizeShipmentLogisticsData(logisticsData).filter(function (entry) {
    return !isShipmentInvalidLogisticsContext(entry.context);
  });
  return validEntries.length ? String(validEntries[0].context || '').trim() : '';
}

function buildShipmentLogisticsSummary(state, payload) {
  const trackingNo = String(payload && payload.trackingNo || '').trim();
  const existing = String(payload && payload.logisticsSummary || '').trim();
  const logisticsData = payload && (payload.data != null ? payload.data : payload.logisticsDataJson);
  const providerState = normalizeShipmentProviderState(
    payload && (payload.state != null ? payload.state : payload.logisticsProviderState),
    state,
    logisticsData
  );
  const providerLabel = describeShipmentProviderState(providerState, state);
  const latestContext = getLatestShipmentLogisticsContext(logisticsData);
  if (existing) {
    if (state === 'signed' && existing.indexOf('已签收') < 0) return '已签收 · ' + existing;
    if ((providerState === '4' || providerState === '14') && providerLabel && existing.indexOf(providerLabel) < 0) return providerLabel + ' · ' + existing;
    return existing;
  }
  if (latestContext) return latestContext;
  if (providerLabel) return providerLabel;
  if (state === 'signed') return '已签收';
  if (state === 'active_success' || state === 'stale_success') {
    return trackingNo ? '已录入单号，等待物流公司返回轨迹' : '待发货，暂未录入物流信息';
  }
  if (state === 'no_trace' && trackingNo) return '已录入单号，等待物流公司返回轨迹';
  return '待发货，暂未录入物流信息';
}

function normalizeShipmentRecord(record) {
  const payload = record || {};
  const logisticsData = normalizeShipmentLogisticsData(payload.data != null ? payload.data : payload.logisticsDataJson);
  const logisticsState = normalizeShipmentLogisticsState(payload.logisticsState, payload);
  const providerState = normalizeShipmentProviderState(payload.state != null ? payload.state : payload.logisticsProviderState, logisticsState, logisticsData);
  return {
    id: payload.id ? String(payload.id) : '',
    orderRelationId: payload.orderRelationId ? String(payload.orderRelationId) : (payload.orderId ? String(payload.orderId) : ''),
    orderId: payload.orderSourceId ? String(payload.orderSourceId) : (payload.sourceOrderId ? String(payload.sourceOrderId) : ''),
    owner: payload.owner ? String(payload.owner) : (payload.ownerUsername ? String(payload.ownerUsername) : ''),
    trackingNo: payload.trackingNo ? String(payload.trackingNo) : '',
    carrierCode: payload.carrierCode ? String(payload.carrierCode) : '',
    carrierName: payload.carrierName ? String(payload.carrierName) : '',
    status: payload.status ? String(payload.status) : 'shipped',
    logisticsState: logisticsState,
    state: providerState,
    data: logisticsData,
    logisticsSummary: buildShipmentLogisticsSummary(logisticsState, payload),
    lastLogisticsQueryAt: Math.max(0, Number(payload.lastLogisticsQueryAt || 0)),
    lastLogisticsSuccessAt: Math.max(0, Number(payload.lastLogisticsSuccessAt || 0)),
    createdAt: Number(payload.createdAt || 0),
    updatedAt: Number(payload.updatedAt || 0),
    createdBy: payload.createdBy ? String(payload.createdBy) : '',
    legacySource: payload.legacySource ? String(payload.legacySource) : '',
    orderItemIds: Array.isArray(payload.orderItemIds) ? payload.orderItemIds.map(function (item) { return Number(item || 0); }).filter(function (item) { return item > 0; }) : [],
    items: Array.isArray(payload.items) ? payload.items.map(function (item, index) { return normalizeOrderItem(item, index); }) : []
  };
}

function buildShipmentRecordsForOrder(items, shipmentRows, shipmentItemRows) {
  const orderItems = Array.isArray(items) ? items : [];
  const itemByOrderItemId = orderItems.reduce(function (result, item) {
    const normalizedItem = normalizeOrderItem(item, 0);
    if (normalizedItem.orderItemId > 0) result[normalizedItem.orderItemId] = normalizedItem;
    return result;
  }, {});
  const linksByShipmentId = (Array.isArray(shipmentItemRows) ? shipmentItemRows : []).reduce(function (result, row) {
    const shipmentId = String(row && row.shipmentId || '');
    if (!shipmentId) return result;
    if (!result[shipmentId]) result[shipmentId] = [];
    result[shipmentId].push({
      orderItemId: Number(row && row.orderItemId || 0),
      sortOrder: Number(row && row.sortOrder || 0)
    });
    return result;
  }, {});
  const shipments = (Array.isArray(shipmentRows) ? shipmentRows : []).map(function (row) {
    const shipmentId = String(row && row.id || '');
    const links = (linksByShipmentId[shipmentId] || []).slice().sort(function (a, b) {
      return Number(a.sortOrder || 0) - Number(b.sortOrder || 0);
    });
    const shipmentItems = links.map(function (link) {
      return itemByOrderItemId[link.orderItemId];
    }).filter(Boolean);
    return normalizeShipmentRecord(Object.assign({}, row, {
      orderRelationId: row && row.orderId ? row.orderId : '',
      sourceOrderId: row && row.orderSourceId ? row.orderSourceId : '',
      owner: row && row.ownerUsername ? row.ownerUsername : '',
      orderItemIds: links.map(function (link) { return link.orderItemId; }),
      items: shipmentItems
    }));
  });
  return {
    shipments: shipments,
    fulfillmentSummary: normalizeFulfillmentSummary(null, orderItems, shipments)
  };
}

function hydrateOrderRows(orderRow, itemRows, shipmentRows, shipmentItemRows) {
  const items = (itemRows || []).map(function (itemRow, index) {
    return normalizeOrderItem({
      orderItemId: itemRow.id,
      id: itemRow.productId,
      productId: itemRow.productId,
      name: itemRow.name,
      variantId: itemRow.variantId,
      variantLabel: itemRow.variantLabel,
      unitId: itemRow.unitId,
      unitLabel: itemRow.unitLabel,
      unit: itemRow.unit,
      price: itemRow.price,
      deliveryFee: itemRow.deliveryFee,
      qty: itemRow.qty,
      img: itemRow.img,
      shippingAddressId: itemRow.shippingAddressId,
      shippingAddressSnapshot: {
        id: itemRow.shippingAddressId,
        name: itemRow.shippingName,
        phone: itemRow.shippingPhone,
        full: itemRow.shippingFull
      }
    }, index);
  });
  const shipmentPayload = buildShipmentRecordsForOrder(items, shipmentRows, shipmentItemRows);
  const trackingProjection = String(orderRow && orderRow.trackingNo || '').trim()
    || (shipmentPayload.shipments[0] && shipmentPayload.shipments[0].trackingNo ? shipmentPayload.shipments[0].trackingNo : '');
  return normalizeOrderRecord({
    id: orderRow.sourceId || orderRow.id,
    owner: orderRow.username,
    ownerDeleted: !!orderRow.ownerDeleted,
    items: items,
    total: orderRow.total,
    subtotal: orderRow.subtotal,
    deliveryFee: orderRow.deliveryFee,
    discount: orderRow.discount,
    status: orderRow.status,
    time: orderRow.createdAt,
    address: {
      name: orderRow.receiverName,
      phone: orderRow.receiverPhone,
      full: orderRow.receiverFull
    },
    coupon: orderRow.couponText,
    couponId: orderRow.couponId,
    trackingNo: trackingProjection,
    shipments: shipmentPayload.shipments,
    fulfillmentSummary: shipmentPayload.fulfillmentSummary,
    reserveExpiresAt: orderRow.reserveExpiresAt,
    inventoryReleased: !!orderRow.inventoryReleased,
    inventoryReleasedAt: orderRow.inventoryReleasedAt,
    cancelReason: orderRow.cancelReason
  });
}

async function syncUserAddressRelations(username, receiverAddresses, shippingAddresses) {
  await run('DELETE FROM user_addresses WHERE username = ?', [username]);
  const receiverList = Array.isArray(receiverAddresses) ? receiverAddresses : [];
  const shippingList = Array.isArray(shippingAddresses) ? shippingAddresses : [];
  for (let index = 0; index < receiverList.length; index++) {
    const item = normalizeUserAddress(receiverList[index], 'receiver', index);
    const relationId = username + ':' + item.type + ':' + item.id;
    await run(
      'INSERT INTO user_addresses (id, sourceId, username, type, name, phone, full, sortOrder) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [relationId, item.id, username, item.type, item.name, item.phone, item.full, index]
    );
  }
  for (let index = 0; index < shippingList.length; index++) {
    const item = normalizeUserAddress(shippingList[index], 'shipping', index);
    const relationId = username + ':' + item.type + ':' + item.id;
    await run(
      'INSERT INTO user_addresses (id, sourceId, username, type, name, phone, full, sortOrder) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [relationId, item.id, username, item.type, item.name, item.phone, item.full, index]
    );
  }
}

async function listUserAddressRelations(username) {
  const rows = await all('SELECT * FROM user_addresses WHERE username = ? ORDER BY type ASC, sortOrder ASC, id ASC', [username]);
  const receiverAddresses = [];
  const shippingAddresses = [];
  rows.forEach(function (row) {
    const item = hydrateUserAddress(row);
    if (row.type === 'shipping') shippingAddresses.push(item);
    else receiverAddresses.push(item);
  });
  return { addresses: receiverAddresses, shippingAddresses: shippingAddresses };
}

async function syncUserOrderRelations(username, orders) {
  await run('DELETE FROM shipment_items WHERE orderId IN (SELECT id FROM orders WHERE username = ?)', [username]);
  await run('DELETE FROM shipments WHERE orderId IN (SELECT id FROM orders WHERE username = ?)', [username]);
  await run('DELETE FROM order_items WHERE orderId IN (SELECT id FROM orders WHERE username = ?)', [username]);
  await run('DELETE FROM orders WHERE username = ?', [username]);
  const orderList = Array.isArray(orders) ? orders : [];
  for (let orderIndex = 0; orderIndex < orderList.length; orderIndex++) {
    const order = normalizeOrderRecord(orderList[orderIndex]);
    const relationOrderId = username + ':' + order.id;
    await run(
      'INSERT INTO orders (id, sourceId, username, status, total, subtotal, deliveryFee, discount, couponText, couponId, receiverName, receiverPhone, receiverFull, trackingNo, ownerDeleted, createdAt, reserveExpiresAt, inventoryReleased, inventoryReleasedAt, cancelReason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        relationOrderId,
        order.id,
        username,
        order.status,
        order.total,
        order.subtotal,
        order.deliveryFee,
        order.discount,
        order.coupon,
        order.couponId,
        order.address && order.address.name ? order.address.name : '',
        order.address && order.address.phone ? order.address.phone : '',
        order.address && order.address.full ? order.address.full : '',
        order.trackingNo || '',
        0,
        order.time,
        Number(order.reserveExpiresAt || 0),
        order.inventoryReleased ? 1 : 0,
        Number(order.inventoryReleasedAt || 0),
        order.cancelReason || ''
      ]
    );
    const insertedOrderItems = [];
    for (let itemIndex = 0; itemIndex < order.items.length; itemIndex++) {
      const item = normalizeOrderItem(order.items[itemIndex], itemIndex);
      const insertItemResult = await run(
        'INSERT INTO order_items (id, orderId, productId, name, variantId, variantLabel, unitId, unitLabel, unit, price, deliveryFee, qty, img, shippingAddressId, shippingName, shippingPhone, shippingFull, sortOrder) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          item.orderItemId > 0 ? item.orderItemId : null,
          relationOrderId,
          item.productId,
          item.name,
          item.variantId,
          item.variantLabel,
          item.unitId,
          item.unitLabel,
          item.unit,
          item.price,
          item.deliveryFee,
          item.qty,
          item.img,
          item.shippingAddressId,
          item.shippingAddressSnapshot && item.shippingAddressSnapshot.name ? item.shippingAddressSnapshot.name : '',
          item.shippingAddressSnapshot && item.shippingAddressSnapshot.phone ? item.shippingAddressSnapshot.phone : '',
          item.shippingAddressSnapshot && item.shippingAddressSnapshot.full ? item.shippingAddressSnapshot.full : '',
          itemIndex
        ]
      );
      insertedOrderItems.push({
        legacyOrderItemId: item.orderItemId > 0 ? item.orderItemId : Number(insertItemResult && insertItemResult.lastID || 0),
        rowId: item.orderItemId > 0 ? item.orderItemId : Number(insertItemResult && insertItemResult.lastID || 0)
      });
    }
    const orderItemIdMap = insertedOrderItems.reduce(function (result, item) {
      if (item.legacyOrderItemId > 0 && item.rowId > 0) result[item.legacyOrderItemId] = item.rowId;
      return result;
    }, {});
    const shipments = Array.isArray(order.shipments) ? order.shipments.map(normalizeShipmentRecord) : [];
    for (let shipmentIndex = 0; shipmentIndex < shipments.length; shipmentIndex++) {
      const shipment = shipments[shipmentIndex];
      const shipmentId = shipment.id || buildShipmentId();
      const shipmentCreatedAt = Number(shipment.createdAt || order.time || Date.now());
      const shipmentUpdatedAt = Number(shipment.updatedAt || shipmentCreatedAt);
      const shipmentLogistics = normalizeShipmentRecord(shipment);
      await run(
        'INSERT INTO shipments (id, orderId, orderSourceId, ownerUsername, trackingNo, carrierCode, carrierName, status, logisticsSummary, logisticsState, logisticsProviderState, logisticsDataJson, lastLogisticsQueryAt, lastLogisticsSuccessAt, createdAt, updatedAt, createdBy, legacySource) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          shipmentId,
          relationOrderId,
          order.id,
          username,
          shipmentLogistics.trackingNo || '',
          shipmentLogistics.carrierCode || '',
          shipmentLogistics.carrierName || '',
          shipmentLogistics.status || 'shipped',
          shipmentLogistics.logisticsSummary || '',
          shipmentLogistics.logisticsState || 'no_tracking',
          shipmentLogistics.state || '',
          JSON.stringify(shipmentLogistics.data || []),
          Number(shipmentLogistics.lastLogisticsQueryAt || 0),
          Number(shipmentLogistics.lastLogisticsSuccessAt || 0),
          shipmentCreatedAt,
          shipmentUpdatedAt,
          shipmentLogistics.createdBy || '',
          shipmentLogistics.legacySource || ''
        ]
      );
      const shipmentItemIds = Array.isArray(shipment.orderItemIds) && shipment.orderItemIds.length
        ? shipment.orderItemIds
        : (Array.isArray(shipment.items) ? shipment.items.map(function (entry, itemIndex) {
            return normalizeOrderItem(entry, itemIndex).orderItemId;
          }) : []);
      for (let linkIndex = 0; linkIndex < shipmentItemIds.length; linkIndex++) {
        const legacyOrderItemId = Number(shipmentItemIds[linkIndex] || 0);
        const rowOrderItemId = Number(orderItemIdMap[legacyOrderItemId] || legacyOrderItemId || 0);
        if (rowOrderItemId <= 0) continue;
        await run(
          'INSERT INTO shipment_items (shipmentId, orderId, orderItemId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)',
          [shipmentId, relationOrderId, rowOrderItemId, linkIndex, shipmentCreatedAt]
        );
      }
    }
  }
}

async function loadShipmentRelationsByOrderIds(orderRelationIds) {
  const ids = Array.from(new Set((Array.isArray(orderRelationIds) ? orderRelationIds : []).map(function (item) {
    return String(item || '').trim();
  }).filter(Boolean)));
  if (!ids.length) {
    return { shipmentsByOrderId: {}, shipmentItemsByOrderId: {} };
  }
  const placeholders = ids.map(function () { return '?'; }).join(', ');
  const shipmentRows = await all(
    'SELECT ' + SHIPMENT_LIST_COLUMNS + ' FROM shipments WHERE orderId IN (' + placeholders + ') ORDER BY createdAt ASC, id ASC',
    ids
  );
  const shipmentItemRows = await all(
    'SELECT ' + SHIPMENT_ITEM_COLUMNS + ' FROM shipment_items WHERE orderId IN (' + placeholders + ') ORDER BY orderId ASC, shipmentId ASC, sortOrder ASC, id ASC',
    ids
  );
  const shipmentsByOrderId = shipmentRows.reduce(function (result, row) {
    if (!result[row.orderId]) result[row.orderId] = [];
    result[row.orderId].push(row);
    return result;
  }, {});
  const shipmentItemsByOrderId = shipmentItemRows.reduce(function (result, row) {
    if (!result[row.orderId]) result[row.orderId] = [];
    result[row.orderId].push(row);
    return result;
  }, {});
  return {
    shipmentsByOrderId: shipmentsByOrderId,
    shipmentItemsByOrderId: shipmentItemsByOrderId
  };
}

async function listUserOrderRelations(username) {
  const orderRows = await all('SELECT * FROM orders WHERE username = ? ORDER BY createdAt DESC, id DESC', [username]);
  const itemRows = await all(
    'SELECT oi.* FROM order_items oi INNER JOIN orders o ON o.id = oi.orderId WHERE o.username = ? ORDER BY oi.orderId ASC, oi.sortOrder ASC, oi.id ASC',
    [username]
  );
  const shipmentRelations = await loadShipmentRelationsByOrderIds(orderRows.map(function (row) { return row.id; }));
  const itemsByOrderId = itemRows.reduce(function (result, row) {
    if (!result[row.orderId]) result[row.orderId] = [];
    result[row.orderId].push(row);
    return result;
  }, {});
  return orderRows.map(function (row) {
    return hydrateOrderRows(
      row,
      itemsByOrderId[row.id] || [],
      shipmentRelations.shipmentsByOrderId[row.id] || [],
      shipmentRelations.shipmentItemsByOrderId[row.id] || []
    );
  });
}

async function listAllOrderSnapshots() {
  const userRows = await all('SELECT username FROM users');
  const activeUsers = userRows.reduce(function (result, row) {
    result[row.username] = true;
    return result;
  }, {});
  const orderRows = await all('SELECT * FROM orders ORDER BY createdAt DESC, id DESC');
  const itemRows = await all('SELECT * FROM order_items ORDER BY orderId ASC, sortOrder ASC, id ASC');
  const shipmentRelations = await loadShipmentRelationsByOrderIds(orderRows.map(function (row) { return row.id; }));
  const itemsByOrderId = itemRows.reduce(function (result, row) {
    if (!result[row.orderId]) result[row.orderId] = [];
    result[row.orderId].push(row);
    return result;
  }, {});
  return orderRows.map(function (row) {
    return hydrateOrderRows(Object.assign({}, row, {
      ownerDeleted: row.ownerDeleted || !activeUsers[row.username]
    }), itemsByOrderId[row.id] || [], shipmentRelations.shipmentsByOrderId[row.id] || [], shipmentRelations.shipmentItemsByOrderId[row.id] || []);
  });
}

function buildOrderRelationId(username, sourceOrderId) {
  return String(username || '').trim() + ':' + String(sourceOrderId || '').trim();
}

function buildPaymentTransactionId(username, sourceOrderId) {
  return buildOrderRelationId(username, sourceOrderId);
}

function resolveOrderItemUnitDeliveryFee(unit, item) {
  if (unit && unit.deliveryFee != null) return Math.max(0, Number(unit.deliveryFee || 0));
  return Math.max(0, Number(item && item.deliveryFee || 0));
}

function getReserveExpiresAt(createdAt) {
  return Number(createdAt || Date.now()) + 600000;
}

function isPendingOrderExpired(order, now) {
  const normalized = normalizeOrderRecord(order);
  const target = Number(now || Date.now());
  return normalized.status !== 'pending'
    || !!normalized.inventoryReleased
    || (Number(normalized.reserveExpiresAt || 0) > 0 && Number(normalized.reserveExpiresAt || 0) <= target);
}

function getVariantById(product, variantId) {
  const normalizedProduct = normalizeProduct(product);
  const targetId = String(variantId || '').trim();
  if (!targetId) return getDefaultVariant(normalizedProduct);
  return (normalizedProduct.variants || []).find(function (item) {
    return String(item.id || '') === targetId;
  }) || null;
}

function cloneVariantTree(product) {
  const normalizedProduct = normalizeProduct(product);
  return normalizeProductVariants(normalizedProduct).map(function (variant, index) {
    return Object.assign({}, variant, {
      units: normalizeVariantUnits(variant, index, normalizedProduct).map(function (unit) {
        return Object.assign({}, unit);
      })
    });
  });
}

function applyVariantUnitInventoryDelta(product, item, deltaQty, options) {
  const normalizedProduct = normalizeProduct(product);
  const payload = normalizeOrderItem(item, 0);
  const config = Object.assign({ allowCreateVariant: false, allowCreateUnit: false }, options || {});
  const nextVariants = cloneVariantTree(normalizedProduct);
  const fallbackVariantLabel = String(payload.variantLabel || payload.unitLabel || payload.unit || '').trim() || '默认规格';
  const fallbackUnitLabel = String(payload.unitLabel || payload.unit || payload.variantLabel || '').trim() || fallbackVariantLabel || '默认单位';
  let targetVariant = nextVariants.find(function (variant) {
    return String(variant.id || '') === String(payload.variantId || '');
  }) || null;
  if (!targetVariant && config.allowCreateVariant) {
    targetVariant = {
      id: String(payload.variantId || buildVariantId(fallbackVariantLabel, nextVariants.length)),
      label: fallbackVariantLabel,
      price: Number(payload.price || 0),
      units: [],
      stock: 0,
      sortOrder: nextVariants.length,
      isDefault: nextVariants.length === 0
    };
    nextVariants.push(targetVariant);
  }
  if (!targetVariant) return { matched: false, variants: normalizeProductVariants(Object.assign({}, normalizedProduct, { variants: nextVariants })) };
  let targetUnit = null;
  if (String(payload.unitId || '').trim()) {
    targetUnit = targetVariant.units.find(function (unit) {
      return String(unit.id || '') === String(payload.unitId || '');
    }) || null;
  }
  if (!targetUnit && fallbackUnitLabel) {
    targetUnit = targetVariant.units.find(function (unit) {
      return String(unit.label || '') === fallbackUnitLabel;
    }) || null;
  }
  if (!targetUnit && config.allowCreateUnit) {
    targetUnit = {
      id: String(payload.unitId || buildUnitId(fallbackUnitLabel, targetVariant.units.length)),
      label: fallbackUnitLabel,
      price: Number(payload.price || targetVariant.price || 0),
      deliveryFee: Math.max(0, Number(payload.deliveryFee || 0)),
      stock: 0,
      sortOrder: targetVariant.units.length,
      isDefault: targetVariant.units.length === 0
    };
    targetVariant.units.push(targetUnit);
  }
  if (!targetUnit) return { matched: false, variants: normalizeProductVariants(Object.assign({}, normalizedProduct, { variants: nextVariants })) };
  targetUnit.stock = Math.max(0, Number(targetUnit.stock || 0) + Number(deltaQty || 0));
  targetVariant.units = normalizeVariantUnits(targetVariant, Number(targetVariant.sortOrder || 0), normalizedProduct);
  targetVariant.stock = targetVariant.units.reduce(function (sum, unit) {
    return sum + Math.max(0, Number(unit && unit.stock || 0));
  }, 0);
  return {
    matched: true,
    variant: targetVariant,
    unit: targetUnit,
    variants: normalizeProductVariants(Object.assign({}, normalizedProduct, { variants: nextVariants }))
  };
}

async function getOrderSnapshotByRelationId(relationOrderId) {
  const row = await get('SELECT * FROM orders WHERE id = ?', [relationOrderId]);
  if (!row) return null;
  const itemRows = await all('SELECT * FROM order_items WHERE orderId = ? ORDER BY sortOrder ASC, id ASC', [relationOrderId]);
  const shipmentRelations = await loadShipmentRelationsByOrderIds([relationOrderId]);
  return hydrateOrderRows(
    row,
    itemRows,
    shipmentRelations.shipmentsByOrderId[relationOrderId] || [],
    shipmentRelations.shipmentItemsByOrderId[relationOrderId] || []
  );
}

async function getOrderSnapshotByOwner(ownerUsername, sourceOrderId) {
  const relationOrderId = buildOrderRelationId(ownerUsername, sourceOrderId);
  return getOrderSnapshotByRelationId(relationOrderId);
}

async function saveProductMutationWithAudit(previousProduct, nextProduct, auditMeta, timestamp) {
  const previous = normalizeProduct(previousProduct);
  const next = normalizeProduct(nextProduct);
  const item = toDbProduct(next);
  const audit = normalizeAuditMeta(auditMeta, {
    actionType: 'manual_adjust',
    operatorUsername: next.farmerAccount || previous.farmerAccount || '',
    operatorRole: next.farmerAccount || previous.farmerAccount ? 'farmer' : 'admin',
    note: '商品库存或销量发生变更'
  });
  await run(
    'UPDATE products SET name = ?, price = ?, orig = ?, unit = ?, cat = ?, tags = ?, stock = ?, sales = ?, harvest = ?, dispatchHours = ?, farmer = ?, farmerAccount = ?, farmerUserId = ?, village = ?, shippingAddressId = ?, shippingAddressSnapshot = ?, imagesJson = ?, img = ?, off = ?, "trace" = ?, variantsJson = ? WHERE id = ?',
    [
      item.name,
      item.price,
      item.orig,
      item.unit,
      item.cat,
      item.tags,
      item.stock,
      item.sales,
      item.harvest,
      item.dispatchHours,
      item.farmer,
      item.farmerAccount,
      item.farmerUserId,
      item.village,
      item.shippingAddressId,
      item.shippingAddressSnapshot,
      item.imagesJson,
      item.img,
      item.off,
      item.trace,
      item.variantsJson,
      item.id
    ]
  );
  const deltaStock = next.stock - previous.stock;
  const deltaSales = next.sales - previous.sales;
  if (deltaStock !== 0 || deltaSales !== 0) {
    await run(
      'INSERT INTO inventory_logs (productId, productName, operatorUsername, operatorRole, actionType, deltaStock, deltaSales, beforeStock, afterStock, beforeSales, afterSales, orderId, note, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        next.id,
        next.name,
        audit.operatorUsername,
        audit.operatorRole,
        audit.actionType,
        deltaStock,
        deltaSales,
        previous.stock,
        next.stock,
        previous.sales,
        next.sales,
        audit.orderId,
        audit.note,
        Number(timestamp || Date.now())
      ]
    );
  }
  return next;
}

function normalizePreparePaymentPayload(payload) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  return {
    username: String(source.username || '').trim(),
    items: Array.isArray(source.items) ? source.items.map(function (item, index) {
      return normalizeOrderItem(item, index);
    }) : [],
    address: source.address && typeof source.address === 'object' && !Array.isArray(source.address) ? Object.assign({}, source.address) : {},
    subtotal: Number(source.subtotal || 0),
    deliveryFee: Math.max(0, Number(source.deliveryFee || 0)),
    discount: Math.max(0, Number(source.discount || 0)),
    total: Math.max(0, Number(source.total || 0)),
    couponId: String(source.couponId || '').trim(),
    couponText: String(source.couponText || source.coupon || '').trim()
  };
}

async function createPendingOrderFromCheckout(username, payload) {
  const ownerUsername = String(username || '').trim();
  const request = normalizePreparePaymentPayload(payload);
  if (!ownerUsername) throw new Error('用户未登录，无法创建待支付订单');
  if (request.username && request.username !== ownerUsername) throw new Error('订单归属用户不匹配');
  if (!request.items.length) throw new Error('订单商品为空，无法继续支付');
  if (!request.address || !String(request.address.name || '').trim() || !String(request.address.phone || '').trim() || !String(request.address.full || '').trim()) {
    throw new Error('请先选择完整的收货地址');
  }
  const owner = await getUserByUsername(ownerUsername);
  if (!owner) throw new Error('用户不存在，无法创建待支付订单');
  return withImmediateTransaction(async function () {
    const now = Date.now();
    const sourceOrderId = 'ORD' + now + Math.floor(Math.random() * 1000);
    const relationOrderId = buildOrderRelationId(ownerUsername, sourceOrderId);
    const orderItems = [];
    let subtotal = 0;
    let deliveryFee = 0;
    for (let index = 0; index < request.items.length; index++) {
      const requestItem = normalizeOrderItem(request.items[index], index);
      if (!(Number(requestItem.productId || 0) > 0) || !(Number(requestItem.qty || 0) > 0)) {
        throw new Error('订单商品参数不完整');
      }
      const productRow = await get('SELECT * FROM products WHERE id = ?', [requestItem.productId]);
      if (!productRow) throw new Error((requestItem.name || '商品') + ' 已不存在，请返回购物车重新确认');
      const product = hydrateProduct(productRow);
      if (product.off) throw new Error(product.name + ' 已下架，请返回购物车重新确认');
      const variant = getVariantById(product, requestItem.variantId);
      if (!variant) throw new Error(product.name + ' 规格不存在，请返回购物车重新确认');
      const unit = resolveVariantUnitForItem(variant, requestItem, product);
      if (!unit) throw new Error(product.name + ' 单位不存在，请返回购物车重新确认');
      if (Number(unit.stock || 0) < Number(requestItem.qty || 0)) {
        throw new Error(product.name + '（' + variant.label + ' / ' + unit.label + '）库存不足，请修改购物车后再结算');
      }
      const shippingAddressSnapshot = requestItem.shippingAddressSnapshot && requestItem.shippingAddressSnapshot.full
        ? Object.assign({}, requestItem.shippingAddressSnapshot)
        : (product.shippingAddressSnapshot && product.shippingAddressSnapshot.full ? Object.assign({}, product.shippingAddressSnapshot) : {});
      const shippingAddressId = String(requestItem.shippingAddressId || product.shippingAddressId || shippingAddressSnapshot.id || '').trim();
      if (!shippingAddressId || !shippingAddressSnapshot.full) {
        throw new Error(product.name + ' 暂未配置发货地址，暂时无法下单');
      }
      const inventoryMutation = applyVariantUnitInventoryDelta(product, Object.assign({}, requestItem, {
        variantId: variant.id,
        variantLabel: variant.label,
        unitId: unit.id,
        unitLabel: unit.label
      }), -Number(requestItem.qty || 0));
      if (!inventoryMutation.matched) {
        throw new Error(product.name + ' 单位不存在，请返回购物车重新确认');
      }
      await saveProductMutationWithAudit(product, Object.assign({}, product, { variants: inventoryMutation.variants }), {
        actionType: 'order_reserve',
        operatorUsername: ownerUsername,
        operatorRole: 'buyer',
        orderId: sourceOrderId,
        note: '确认订单进入支付后预占库存'
      }, now);
      const orderItem = normalizeOrderItem({
        id: product.id,
        productId: product.id,
        name: product.name,
        variantId: variant.id,
        variantLabel: variant.label,
        unitId: unit.id,
        unitLabel: unit.label,
        unit: unit.label,
        price: Number(unit.price || 0),
        deliveryFee: resolveOrderItemUnitDeliveryFee(unit, requestItem),
        qty: Number(requestItem.qty || 0),
        img: product.img,
        shippingAddressId: shippingAddressId,
        shippingAddressSnapshot: shippingAddressSnapshot
      }, index);
      subtotal += Number(orderItem.price || 0) * Number(orderItem.qty || 0);
      deliveryFee += Number(orderItem.deliveryFee || 0) * Number(orderItem.qty || 0);
      orderItems.push(orderItem);
    }
    const reserveExpiresAt = getReserveExpiresAt(now);
    deliveryFee = Math.max(0, Number(deliveryFee || 0));
    const discount = Math.max(0, Number(request.discount || 0));
    const total = Math.max(0, subtotal + deliveryFee - discount);
    await run(
      'INSERT INTO orders (id, sourceId, username, status, total, subtotal, deliveryFee, discount, couponText, couponId, receiverName, receiverPhone, receiverFull, trackingNo, ownerDeleted, createdAt, reserveExpiresAt, inventoryReleased, inventoryReleasedAt, cancelReason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        relationOrderId,
        sourceOrderId,
        ownerUsername,
        'pending',
        total,
        subtotal,
        deliveryFee,
        discount,
        request.couponText,
        request.couponId,
        String(request.address.name || '').trim(),
        String(request.address.phone || '').trim(),
        String(request.address.full || '').trim(),
        '',
        0,
        now,
        reserveExpiresAt,
        0,
        0,
        ''
      ]
    );
    for (let index = 0; index < orderItems.length; index++) {
      const item = orderItems[index];
      await run(
        'INSERT INTO order_items (orderId, productId, name, variantId, variantLabel, unitId, unitLabel, unit, price, deliveryFee, qty, img, shippingAddressId, shippingName, shippingPhone, shippingFull, sortOrder) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          relationOrderId,
          item.productId,
          item.name,
          item.variantId,
          item.variantLabel,
          item.unitId,
          item.unitLabel,
          item.unit,
          item.price,
          item.deliveryFee,
          item.qty,
          item.img,
          item.shippingAddressId,
          item.shippingAddressSnapshot && item.shippingAddressSnapshot.name ? item.shippingAddressSnapshot.name : '',
          item.shippingAddressSnapshot && item.shippingAddressSnapshot.phone ? item.shippingAddressSnapshot.phone : '',
          item.shippingAddressSnapshot && item.shippingAddressSnapshot.full ? item.shippingAddressSnapshot.full : '',
          index
        ]
      );
    }
    await run(
      'INSERT OR REPLACE INTO payment_transactions (id, username, orderId, amount, status, channel, couponId, couponText, receiverName, receiverPhone, receiverFull, externalTradeNo, createdAt, paidAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        buildPaymentTransactionId(ownerUsername, sourceOrderId),
        ownerUsername,
        sourceOrderId,
        total,
        'pending',
        'mock_h5',
        request.couponId,
        request.couponText,
        String(request.address.name || '').trim(),
        String(request.address.phone || '').trim(),
        String(request.address.full || '').trim(),
        buildAlipayOutTradeNo(ownerUsername, sourceOrderId),
        now,
        0
      ]
    );
    return normalizeOrderRecord({
      id: sourceOrderId,
      owner: ownerUsername,
      items: orderItems,
      subtotal: subtotal,
      deliveryFee: deliveryFee,
      discount: discount,
      total: total,
      status: 'pending',
      time: now,
      address: Object.assign({}, request.address),
      coupon: request.couponText,
      couponId: request.couponId,
      trackingNo: '',
      reserveExpiresAt: reserveExpiresAt,
      inventoryReleased: false,
      inventoryReleasedAt: 0,
      cancelReason: ''
    });
  });
}

async function releaseReservedInventoryForOrder(order, reason, actorMeta) {
  const normalizedOrder = normalizeOrderRecord(order);
  if (!normalizedOrder.id || !normalizedOrder.owner) throw new Error('订单不存在，无法释放库存');
  if (normalizedOrder.inventoryReleased) throw new Error('该订单库存已释放，不能重复处理');
  const now = Date.now();
  const releaseReason = String(reason || '').trim() || 'buyer_pending_cancel';
  const relationOrderId = buildOrderRelationId(normalizedOrder.owner, normalizedOrder.id);
  const actionType = releaseReason === 'timeout_release' ? 'order_release_timeout' : 'order_release_cancel';
  const note = releaseReason === 'timeout_release' ? '待支付订单超时后释放预占库存' : '待支付订单取消后释放预占库存';
  for (let index = 0; index < normalizedOrder.items.length; index++) {
    const item = normalizeOrderItem(normalizedOrder.items[index], index);
    const productRow = await get('SELECT * FROM products WHERE id = ?', [item.productId]);
    if (!productRow) throw new Error(item.name + ' 已不存在，无法释放库存');
    const product = hydrateProduct(productRow);
    const inventoryMutation = applyVariantUnitInventoryDelta(product, item, Number(item.qty || 0), {
      allowCreateVariant: true,
      allowCreateUnit: true
    });
    await saveProductMutationWithAudit(product, Object.assign({}, product, { variants: inventoryMutation.variants }), {
      actionType: actionType,
      operatorUsername: actorMeta && actorMeta.operatorUsername ? actorMeta.operatorUsername : normalizedOrder.owner,
      operatorRole: actorMeta && actorMeta.operatorRole ? actorMeta.operatorRole : 'system',
      orderId: normalizedOrder.id,
      note: note
    }, now);
  }
  await run(
    'UPDATE orders SET status = ?, inventoryReleased = 1, inventoryReleasedAt = ?, cancelReason = ? WHERE id = ?',
    ['cancelled', now, releaseReason, relationOrderId]
  );
  await run(
    'UPDATE payment_transactions SET status = ?, paidAt = CASE WHEN status = ? THEN paidAt ELSE 0 END WHERE id = ?',
    [releaseReason === 'timeout_release' ? 'expired' : 'cancelled', 'paid', buildPaymentTransactionId(normalizedOrder.owner, normalizedOrder.id)]
  );
  return getOrderSnapshotByRelationId(relationOrderId);
}

async function cleanupExpiredPendingOrders(now) {
  const cutoff = Number(now || Date.now());
  const expiredRows = await all(
    "SELECT * FROM orders WHERE status = 'pending' AND reserveExpiresAt > 0 AND reserveExpiresAt <= ? AND inventoryReleased = 0 ORDER BY createdAt ASC, id ASC",
    [cutoff]
  );
  if (!expiredRows.length) return 0;
  await withImmediateTransaction(async function () {
    for (let index = 0; index < expiredRows.length; index++) {
      const row = expiredRows[index];
      const itemRows = await all('SELECT * FROM order_items WHERE orderId = ? ORDER BY sortOrder ASC, id ASC', [row.id]);
      const order = hydrateOrderRows(row, itemRows);
      if (order.inventoryReleased || order.status !== 'pending' || (order.reserveExpiresAt && order.reserveExpiresAt > cutoff)) continue;
      await releaseReservedInventoryForOrder(order, 'timeout_release', {
        operatorUsername: 'system',
        operatorRole: 'system'
      });
    }
  });
  return expiredRows.length;
}

async function getRefundRequestById(refundId) {
  const row = await get('SELECT * FROM refund_requests WHERE id = ?', [String(refundId || '').trim()]);
  return row ? hydrateRefundRequest(row) : null;
}

// [SERVER_LEDGER_QUERY] 退款工作台和台账页的只读查询统一在这里收口，避免每个路由都自己拼筛选逻辑。
function normalizePaymentTransaction(row) {
  return {
    id: row && row.id ? String(row.id) : '',
    username: row && row.username ? String(row.username) : '',
    orderId: row && row.orderId ? String(row.orderId) : '',
    amount: Number(row && row.amount || 0),
    status: row && row.status ? String(row.status) : 'paid',
    channel: row && row.channel ? String(row.channel) : 'mock_h5',
    couponId: row && row.couponId ? String(row.couponId) : '',
    couponText: row && row.couponText ? String(row.couponText) : '',
    receiverName: row && row.receiverName ? String(row.receiverName) : '',
    receiverPhone: row && row.receiverPhone ? String(row.receiverPhone) : '',
    receiverFull: row && row.receiverFull ? String(row.receiverFull) : '',
    externalTradeNo: row && row.externalTradeNo ? String(row.externalTradeNo) : '',
    gatewayTradeNo: row && row.gatewayTradeNo ? String(row.gatewayTradeNo) : '',
    gatewayBuyerId: row && row.gatewayBuyerId ? String(row.gatewayBuyerId) : '',
    notifyStatus: row && row.notifyStatus ? String(row.notifyStatus) : '',
    notifyPayload: parseJsonObject(row && row.notifyPayload, {}),
    notifyAt: Number(row && row.notifyAt || 0),
    initiatedAt: Number(row && row.initiatedAt || 0),
    returnCheckedAt: Number(row && row.returnCheckedAt || 0),
    lastError: row && row.lastError ? String(row.lastError) : '',
    createdAt: Number(row && row.createdAt || 0),
    paidAt: Number(row && row.paidAt || 0)
  };
}

async function getPaymentTransactionByOwnerAndOrder(username, sourceOrderId) {
  const row = await get(
    'SELECT * FROM payment_transactions WHERE id = ?',
    [buildPaymentTransactionId(String(username || '').trim(), String(sourceOrderId || '').trim())]
  );
  return row ? normalizePaymentTransaction(row) : null;
}

async function getPaymentTransactionByExternalTradeNo(externalTradeNo) {
  const normalizedExternalTradeNo = String(externalTradeNo || '').trim();
  if (!normalizedExternalTradeNo) return null;
  const row = await get(
    'SELECT * FROM payment_transactions WHERE externalTradeNo = ? ORDER BY createdAt DESC LIMIT 1',
    [normalizedExternalTradeNo]
  );
  return row ? normalizePaymentTransaction(row) : null;
}

async function resolvePaymentNotificationContext(externalTradeNo) {
  const normalizedExternalTradeNo = String(externalTradeNo || '').trim();
  let paymentTransaction = await getPaymentTransactionByExternalTradeNo(normalizedExternalTradeNo);
  let owner = paymentTransaction && paymentTransaction.username ? paymentTransaction.username : '';
  let orderId = paymentTransaction && paymentTransaction.orderId ? paymentTransaction.orderId : '';
  if (!owner || !orderId) {
    const identifier = parseAlipayOutTradeNo(normalizedExternalTradeNo);
    if (!identifier) return null;
    owner = identifier.ownerUsername;
    orderId = identifier.sourceOrderId;
    paymentTransaction = await getPaymentTransactionByOwnerAndOrder(owner, orderId);
  }
  if (!owner || !orderId) return null;
  const relationOrderId = buildOrderRelationId(owner, orderId);
  return {
    owner: owner,
    orderId: orderId,
    relationOrderId: relationOrderId,
    transactionId: buildPaymentTransactionId(owner, orderId),
    order: await getOrderSnapshotByRelationId(relationOrderId),
    paymentTransaction: paymentTransaction
  };
}

async function updatePaymentTransactionState(transactionId, updates) {
  const payload = Object.assign({
    status: null,
    channel: null,
    externalTradeNo: null,
    gatewayTradeNo: null,
    gatewayBuyerId: null,
    notifyStatus: null,
    notifyPayload: null,
    notifyAt: null,
    initiatedAt: null,
    returnCheckedAt: null,
    paidAt: null,
    lastError: null
  }, updates || {});
  await run(
    `UPDATE payment_transactions
     SET status = CASE WHEN ? IS NOT NULL THEN ? ELSE status END,
         channel = CASE WHEN ? IS NOT NULL THEN ? ELSE channel END,
         externalTradeNo = CASE WHEN ? IS NOT NULL THEN ? ELSE externalTradeNo END,
         gatewayTradeNo = CASE WHEN ? IS NOT NULL THEN ? ELSE gatewayTradeNo END,
         gatewayBuyerId = CASE WHEN ? IS NOT NULL THEN ? ELSE gatewayBuyerId END,
         notifyStatus = CASE WHEN ? IS NOT NULL THEN ? ELSE notifyStatus END,
         notifyPayload = CASE WHEN ? IS NOT NULL THEN ? ELSE notifyPayload END,
         notifyAt = CASE WHEN ? IS NOT NULL THEN ? ELSE notifyAt END,
         initiatedAt = CASE WHEN ? IS NOT NULL THEN ? ELSE initiatedAt END,
         returnCheckedAt = CASE WHEN ? IS NOT NULL THEN ? ELSE returnCheckedAt END,
         paidAt = CASE WHEN ? IS NOT NULL THEN ? ELSE paidAt END,
         lastError = CASE WHEN ? IS NOT NULL THEN ? ELSE lastError END
     WHERE id = ?`,
    [
      payload.status, payload.status,
      payload.channel, payload.channel,
      payload.externalTradeNo, payload.externalTradeNo,
      payload.gatewayTradeNo, payload.gatewayTradeNo,
      payload.gatewayBuyerId, payload.gatewayBuyerId,
      payload.notifyStatus, payload.notifyStatus,
      payload.notifyPayload, payload.notifyPayload,
      payload.notifyAt, payload.notifyAt,
      payload.initiatedAt, payload.initiatedAt,
      payload.returnCheckedAt, payload.returnCheckedAt,
      payload.paidAt, payload.paidAt,
      payload.lastError, payload.lastError,
      transactionId
    ]
  );
}

async function updatePaymentTransactionAlipayState(transactionId, updates) {
  return updatePaymentTransactionState(transactionId, updates);
}

function normalizeAftersaleRecord(row) {
  return {
    id: row && row.id ? String(row.id) : '',
    username: row && row.username ? String(row.username) : '',
    orderId: row && row.orderId ? String(row.orderId) : '',
    type: row && row.type ? String(row.type) : 'cancel',
    status: row && row.status ? String(row.status) : '',
    amount: Number(row && row.amount || 0),
    reason: row && row.reason ? String(row.reason) : '',
    createdAt: Number(row && row.createdAt || 0),
    updatedAt: Number(row && row.updatedAt || 0)
  };
}

function normalizeInventoryLog(row) {
  return {
    id: Number(row && row.id || 0),
    productId: Number(row && row.productId || 0),
    productName: row && row.productName ? String(row.productName) : '',
    operatorUsername: row && row.operatorUsername ? String(row.operatorUsername) : '',
    operatorRole: row && row.operatorRole ? String(row.operatorRole) : 'system',
    actionType: row && row.actionType ? String(row.actionType) : 'manual_adjust',
    deltaStock: Number(row && row.deltaStock || 0),
    deltaSales: Number(row && row.deltaSales || 0),
    beforeStock: Number(row && row.beforeStock || 0),
    afterStock: Number(row && row.afterStock || 0),
    beforeSales: Number(row && row.beforeSales || 0),
    afterSales: Number(row && row.afterSales || 0),
    orderId: row && row.orderId ? String(row.orderId) : '',
    note: row && row.note ? String(row.note) : '',
    createdAt: Number(row && row.createdAt || 0)
  };
}

const PRODUCT_LIST_COLUMNS = [
  'id', 'name', 'price', 'orig', 'unit', 'cat', 'tags', 'stock', 'sales', 'harvest', 'dispatchHours',
  'farmer', 'farmerAccount', 'farmerUserId', 'village', 'shippingAddressId', 'shippingAddressSnapshot',
  'imagesJson', 'img', 'off', '"trace"', 'variantsJson'
].join(', ');

const ORDER_LIST_COLUMNS = [
  'id', 'sourceId', 'username', 'status', 'total', 'subtotal', 'deliveryFee', 'discount', 'couponText',
  'couponId', 'receiverName', 'receiverPhone', 'receiverFull', 'trackingNo', 'ownerDeleted', 'createdAt',
  'reserveExpiresAt', 'inventoryReleased', 'inventoryReleasedAt', 'cancelReason'
].join(', ');

const ORDER_ITEM_COLUMNS = [
  'id', 'orderId', 'productId', 'name', 'variantId', 'variantLabel', 'unitId', 'unitLabel', 'unit', 'price',
  'deliveryFee', 'qty', 'img', 'shippingAddressId', 'shippingName', 'shippingPhone', 'shippingFull', 'sortOrder'
].join(', ');
const SHIPMENT_LIST_COLUMNS = [
  'id', 'orderId', 'orderSourceId', 'ownerUsername', 'trackingNo', 'carrierCode', 'carrierName', 'status',
  'logisticsSummary', 'logisticsState', 'logisticsProviderState', 'logisticsDataJson', 'lastLogisticsQueryAt', 'lastLogisticsSuccessAt',
  'createdAt', 'updatedAt', 'createdBy', 'legacySource'
].join(', ');
const SHIPMENT_ITEM_COLUMNS = [
  'id', 'shipmentId', 'orderId', 'orderItemId', 'sortOrder', 'createdAt'
].join(', ');

const USER_SUMMARY_COLUMNS = ['id', 'username', 'nickname', 'phone', 'phoneVerifiedAt', 'roles', 'createdAt'].join(', ');
const REFUND_LIST_COLUMNS = ['id', 'orderId', 'ownerUsername', 'scopeType', 'itemsSnapshot', 'sourceOrderStatus', 'status', 'refundAmount', 'reason', 'assigneeRole', 'assigneeUsername', 'inventoryRestored', 'paymentRefunded', 'rejectReason', 'requestedAt', 'reviewedAt', 'completedAt', 'updatedAt'].join(', ');
const PAYMENT_LIST_COLUMNS = ['id', 'username', 'orderId', 'amount', 'status', 'channel', 'couponId', 'couponText', 'receiverName', 'receiverPhone', 'receiverFull', 'externalTradeNo', 'gatewayTradeNo', 'gatewayBuyerId', 'notifyStatus', 'notifyPayload', 'notifyAt', 'initiatedAt', 'returnCheckedAt', 'lastError', 'createdAt', 'paidAt'].join(', ');
const AFTERSALE_LIST_COLUMNS = ['id', 'username', 'orderId', 'type', 'status', 'amount', 'reason', 'createdAt', 'updatedAt'].join(', ');
const INVENTORY_LOG_COLUMNS = ['id', 'productId', 'productName', 'operatorUsername', 'operatorRole', 'actionType', 'deltaStock', 'deltaSales', 'beforeStock', 'afterStock', 'beforeSales', 'afterSales', 'orderId', 'note', 'createdAt'].join(', ');

function upsertUserRecordByUsername(list, item) {
  const next = Array.isArray(list) ? list.slice() : [];
  const target = normalizeUserRecord(item);
  const index = next.findIndex(function (entry) {
    return String(entry && entry.username || '') === target.username;
  });
  if (index >= 0) next[index] = target;
  else next.push(target);
  return next;
}

async function listProductsPage(filters) {
  await seedProductsIfNeeded();
  const query = filters || {};
  const paging = normalizePaging(query, { pageSize: 12, maxPageSize: 40 });
  const conditions = [];
  const params = [];
  const keyword = normalizeTextFilter(query.keyword || query.q);
  const categoryId = normalizeTextFilter(query.category || query.cat);
  const status = normalizeTextFilter(query.status);
  if (status === 'active') conditions.push('off = 0');
  else if (status === 'inactive') conditions.push('off = 1');
  if (categoryId) {
    conditions.push('cat = ?');
    params.push(categoryId);
  }
  if (keyword) {
    conditions.push('(name LIKE ? OR farmer LIKE ? OR village LIKE ?)');
    params.push(buildContainsLikeValue(keyword), buildContainsLikeValue(keyword), buildContainsLikeValue(keyword));
  }
  const whereClause = conditions.length ? (' WHERE ' + conditions.join(' AND ')) : '';
  const countRow = await get('SELECT COUNT(*) AS count FROM products' + whereClause, params);
  const rows = await all(
    'SELECT ' + PRODUCT_LIST_COLUMNS + ' FROM products' + whereClause + ' ORDER BY id DESC LIMIT ? OFFSET ?',
    params.concat([paging.pageSize, paging.offset])
  );
  return buildPagedResult(rows.map(hydrateProduct), countRow && countRow.count, paging.page, paging.pageSize);
}

async function listUserSummariesPage(filters) {
  const query = filters || {};
  const paging = normalizePaging(query, { pageSize: 12, maxPageSize: 40 });
  const conditions = [];
  const params = [];
  const keyword = normalizeTextFilter(query.keyword);
  const roleType = normalizeTextFilter(query.roleType || query.role);
  const detailedUsername = normalizeTextFilter(query.detailedUsername);
  if (keyword) {
    conditions.push('username LIKE ?');
    params.push(buildContainsLikeValue(keyword));
  }
  if (roleType === 'admin') conditions.push("(roles LIKE '%\"isAdmin\":true%' OR roles LIKE '%\"isSuperAdmin\":true%')");
  else if (roleType === 'farmer') conditions.push("roles LIKE '%\"isFarmer\":true%'");
  else if (roleType === 'normal') conditions.push("(roles NOT LIKE '%\"isAdmin\":true%' AND roles NOT LIKE '%\"isSuperAdmin\":true%' AND roles NOT LIKE '%\"isFarmer\":true%')");
  const whereClause = conditions.length ? (' WHERE ' + conditions.join(' AND ')) : '';
  const countRow = await get('SELECT COUNT(*) AS count FROM users' + whereClause, params);
  const rows = await all(
    'SELECT ' + USER_SUMMARY_COLUMNS + ' FROM users' + whereClause + ' ORDER BY id ASC LIMIT ? OFFSET ?',
    params.concat([paging.pageSize, paging.offset])
  );
  let items = rows.map(function (row) {
    return buildUserSummaryRecord({
      id: row.id,
      username: row.username,
      roles: parseJsonObject(row.roles, { isFarmer: false, isAdmin: false, isSuperAdmin: false, farmerName: row.username }),
      createdAt: row.createdAt
    });
  });
  if (detailedUsername) {
    const detailedUser = await getUserByUsername(detailedUsername);
    if (detailedUser) items = upsertUserRecordByUsername(items, buildUserSummaryRecord(detailedUser));
  }
  return buildPagedResult(items, countRow && countRow.count, paging.page, paging.pageSize);
}

async function hydratePagedOrders(orderRows) {
  const rows = Array.isArray(orderRows) ? orderRows : [];
  if (!rows.length) return [];
  const placeholders = rows.map(function () { return '?'; }).join(', ');
  const itemRows = await all(
    'SELECT ' + ORDER_ITEM_COLUMNS + ' FROM order_items WHERE orderId IN (' + placeholders + ') ORDER BY orderId ASC, sortOrder ASC, id ASC',
    rows.map(function (row) { return row.id; })
  );
  const ownerNames = rows.map(function (row) {
    return String(row && row.username || '').trim();
  }).filter(Boolean);
  const uniqueOwners = Array.from(new Set(ownerNames));
  const ownerDeletedMap = {};
  if (uniqueOwners.length) {
    const userPlaceholders = uniqueOwners.map(function () { return '?'; }).join(', ');
    const userRows = await all(
      'SELECT username FROM users WHERE username IN (' + userPlaceholders + ')',
      uniqueOwners
    );
    const activeUsers = userRows.reduce(function (result, row) {
      result[String(row && row.username || '').trim()] = true;
      return result;
    }, {});
    uniqueOwners.forEach(function (username) {
      ownerDeletedMap[username] = !activeUsers[username];
    });
  }
  const shipmentRelations = await loadShipmentRelationsByOrderIds(rows.map(function (row) { return row.id; }));
  const itemsByOrderId = itemRows.reduce(function (result, row) {
    if (!result[row.orderId]) result[row.orderId] = [];
    result[row.orderId].push(row);
    return result;
  }, {});
  return rows.map(function (row) {
    return hydrateOrderRows(Object.assign({}, row, {
      ownerDeleted: row.ownerDeleted || ownerDeletedMap[String(row && row.username || '').trim()]
    }), itemsByOrderId[row.id] || [], shipmentRelations.shipmentsByOrderId[row.id] || [], shipmentRelations.shipmentItemsByOrderId[row.id] || []);
  });
}

async function listOrdersByOwnerPage(ownerUsername, filters) {
  const owner = String(ownerUsername || '').trim();
  const query = filters || {};
  const paging = normalizePaging(query, { pageSize: 8, maxPageSize: 30 });
  if (!owner) return buildPagedResult([], 0, paging.page, paging.pageSize);
  const conditions = ['username = ?'];
  const params = [owner];
  const status = normalizeTextFilter(query.status);
  const dateFrom = parseTimeFilterValue(query.dateFrom);
  const dateTo = parseTimeFilterValue(query.dateTo, { endOfDay: true });
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (dateFrom) {
    conditions.push('createdAt >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push('createdAt <= ?');
    params.push(dateTo);
  }
  const whereClause = ' WHERE ' + conditions.join(' AND ');
  const countRow = await get('SELECT COUNT(*) AS count FROM orders' + whereClause, params);
  const orderRows = await all(
    'SELECT ' + ORDER_LIST_COLUMNS + ' FROM orders' + whereClause + ' ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?',
    params.concat([paging.pageSize, paging.offset])
  );
  const items = await hydratePagedOrders(orderRows);
  return buildPagedResult(items, countRow && countRow.count, paging.page, paging.pageSize);
}

async function listAllOrdersPage(filters) {
  const query = filters || {};
  const paging = normalizePaging(query, { pageSize: 10, maxPageSize: 50 });
  const filterQuery = buildAdminOrderFilterQuery(query);
  const countRow = await get('SELECT COUNT(*) AS count FROM orders' + filterQuery.whereClause, filterQuery.params);
  const orderRows = await all(
    'SELECT ' + ORDER_LIST_COLUMNS + ' FROM orders' + filterQuery.whereClause + ' ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?',
    filterQuery.params.concat([paging.pageSize, paging.offset])
  );
  const items = await hydratePagedOrders(orderRows);
  return buildPagedResult(items, countRow && countRow.count, paging.page, paging.pageSize);
}

function normalizeOrderExportFilters(query) {
  return {
    ownerUsername: normalizeTextFilter(query && (query.ownerUsername || query.username)),
    status: normalizeTextFilter(query && query.status),
    orderId: normalizeTextFilter(query && query.orderId),
    dateFrom: parseTimeFilterValue(query && query.dateFrom),
    dateTo: parseTimeFilterValue(query && query.dateTo, { endOfDay: true })
  };
}

function buildAdminOrderFilterQuery(query) {
  const normalized = normalizeOrderExportFilters(query || {});
  const conditions = [];
  const params = [];
  if (normalized.ownerUsername) {
    conditions.push('username LIKE ?');
    params.push(buildContainsLikeValue(normalized.ownerUsername));
  }
  if (normalized.status) {
    conditions.push('status = ?');
    params.push(normalized.status);
  }
  if (normalized.orderId) {
    conditions.push('(sourceId LIKE ? OR id LIKE ?)');
    params.push(buildContainsLikeValue(normalized.orderId), buildContainsLikeValue(normalized.orderId));
  }
  if (normalized.dateFrom) {
    conditions.push('createdAt >= ?');
    params.push(normalized.dateFrom);
  }
  if (normalized.dateTo) {
    conditions.push('createdAt <= ?');
    params.push(normalized.dateTo);
  }
  return {
    normalized: normalized,
    whereClause: conditions.length ? (' WHERE ' + conditions.join(' AND ')) : '',
    params: params
  };
}

async function listAllOrdersForExport(filters) {
  const filterQuery = buildAdminOrderFilterQuery(filters || {});
  const orderRows = await all(
    'SELECT ' + ORDER_LIST_COLUMNS + ' FROM orders' + filterQuery.whereClause + ' ORDER BY createdAt DESC, id DESC',
    filterQuery.params
  );
  return hydratePagedOrders(orderRows);
}

function getOrderStatusExportLabel(status) {
  const normalized = String(status || '').trim();
  const labelMap = {
    pending: '待支付',
    paid: '待发货',
    shipped: '已发货',
    done: '已完成',
    cancelled: '已取消',
    refund_pending: '退款中',
    refunded: '已退款'
  };
  return labelMap[normalized] || normalized || '未知状态';
}

function formatOrderExportDateTime(value) {
  const numeric = Number(value || 0);
  if (!(numeric > 0)) return '';
  return new Date(numeric).toLocaleString('zh-CN');
}

function normalizeOrderExportAddress(address) {
  const payload = address && typeof address === 'object' ? address : {};
  return {
    name: String(payload.name || '').trim(),
    phone: String(payload.phone || '').trim(),
    full: String(payload.full || '').trim()
  };
}

function findShipmentForOrderItem(order, item) {
  const targetOrderItemId = Number(item && item.orderItemId || 0);
  if (!(targetOrderItemId > 0)) return null;
  const shipments = Array.isArray(order && order.shipments) ? order.shipments : [];
  for (let index = 0; index < shipments.length; index++) {
    const shipment = shipments[index];
    const orderItemIds = Array.isArray(shipment && shipment.orderItemIds) ? shipment.orderItemIds : [];
    if (orderItemIds.some(function (itemId) { return Number(itemId || 0) === targetOrderItemId; })) return shipment;
  }
  return null;
}

function buildOrderExportRows(orders) {
  const list = Array.isArray(orders) ? orders : [];
  return list.reduce(function (rows, order) {
    const items = Array.isArray(order && order.items) ? order.items : [];
    const receiver = order && order.address && typeof order.address === 'object' ? order.address : {};
    items.forEach(function (item) {
      const shipment = findShipmentForOrderItem(order, item);
      const shippingAddress = normalizeOrderExportAddress(item && item.shippingAddressSnapshot);
      rows.push({
        '订单号': String(order && (order.sourceId || order.id) || ''),
        '订单状态': getOrderStatusExportLabel(order && order.status),
        '下单时间': formatOrderExportDateTime(order && order.time),
        '买家': String(order && order.owner || ''),
        '收货姓名': String(receiver.name || ''),
        '收货手机号': String(receiver.phone || ''),
        '收货详细地址': String(receiver.full || ''),
        '商品名称': String(item && item.name || ''),
        '规格': String(item && item.variantLabel || '默认规格'),
        '单位': String(item && (item.unit || item.unitLabel) || '默认单位'),
        '数量': Number(item && item.qty || 0),
        '发货人': shippingAddress.name,
        '发货人电话': shippingAddress.phone,
        '发货地址': shippingAddress.full,
        '快递单号': String(shipment && shipment.trackingNo || ''),
        '订单实付': Number(order && order.total || 0).toFixed(2)
      });
    });
    return rows;
  }, []);
}

function escapeFormulaValue(value) {
  const text = String(value == null ? '' : value);
  return /^[\t\r\n ]*[=+\-@]/.test(text) ? ("'" + text) : text;
}

function serializeOrderExportCsv(rows) {
  const items = Array.isArray(rows) ? rows : [];
  const columns = ['订单号', '订单状态', '下单时间', '买家', '收货姓名', '收货手机号', '收货详细地址', '商品名称', '规格', '单位', '数量', '发货人', '发货人电话', '发货地址', '快递单号', '订单实付'];
  const escapeCell = function (value) {
    const normalized = escapeFormulaValue(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return '"' + normalized.replace(/"/g, '""') + '"';
  };
  const headerLine = columns.map(escapeCell).join(',');
  const bodyLines = items.map(function (row) {
    return columns.map(function (column) {
      return escapeCell(row && row[column] != null ? row[column] : '');
    }).join(',');
  });
  return '\uFEFF' + [headerLine].concat(bodyLines).join('\r\n');
}

function buildOrderExportFilename(timestamp) {
  const date = new Date(timestamp || Date.now());
  const pad = function (value) {
    return String(Number(value || 0)).padStart(2, '0');
  };
  return 'orders-export-'
    + date.getFullYear()
    + pad(date.getMonth() + 1)
    + pad(date.getDate())
    + '-'
    + pad(date.getHours())
    + pad(date.getMinutes())
    + pad(date.getSeconds())
    + '.csv';
}

async function listAdminFulfillmentOrdersPage(filters) {
  const query = filters || {};
  const paging = normalizePaging(query, { pageSize: 8, maxPageSize: 40 });
  const conditions = [];
  const params = [];
  const ownerUsername = normalizeTextFilter(query.ownerUsername || query.username);
  const orderId = normalizeTextFilter(query.orderId);
  const status = normalizeTextFilter(query.status) || 'paid';
  if (ownerUsername) {
    conditions.push('username LIKE ?');
    params.push(buildContainsLikeValue(ownerUsername));
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (orderId) {
    conditions.push('(sourceId LIKE ? OR id LIKE ?)');
    params.push(buildContainsLikeValue(orderId), buildContainsLikeValue(orderId));
  }
  const whereClause = conditions.length ? (' WHERE ' + conditions.join(' AND ')) : '';
  const countRow = await get('SELECT COUNT(*) AS count FROM orders' + whereClause, params);
  const orderRows = await all(
    'SELECT ' + ORDER_LIST_COLUMNS + ' FROM orders' + whereClause + ' ORDER BY createdAt ASC, id ASC LIMIT ? OFFSET ?',
    params.concat([paging.pageSize, paging.offset])
  );
  const items = await hydratePagedOrders(orderRows);
  return buildPagedResult(items, countRow && countRow.count, paging.page, paging.pageSize);
}

function buildShipmentId() {
  return 'ship_' + Date.now() + '_' + generateToken(10);
}

async function listShipmentRowsByOrderId(relationOrderId) {
  return all('SELECT ' + SHIPMENT_LIST_COLUMNS + ' FROM shipments WHERE orderId = ? ORDER BY createdAt ASC, id ASC', [relationOrderId]);
}

async function listShipmentItemRowsByOrderId(relationOrderId) {
  return all('SELECT ' + SHIPMENT_ITEM_COLUMNS + ' FROM shipment_items WHERE orderId = ? ORDER BY shipmentId ASC, sortOrder ASC, id ASC', [relationOrderId]);
}

function buildShipmentLogisticsSignature(record) {
  const shipment = normalizeShipmentRecord(record);
  return JSON.stringify({
    logisticsState: shipment.logisticsState,
    state: shipment.state,
    logisticsSummary: shipment.logisticsSummary,
    data: shipment.data
  });
}

function buildMockCourierSummary(prefix, now) {
  const timeText = new Date(now).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).replace(/\//g, '-');
  return prefix + ' · ' + timeText;
}

function buildMockCourierTimeline(entries) {
  return (Array.isArray(entries) ? entries : []).map(function (entry) {
    const payload = entry || {};
    const time = Math.max(0, Number(payload.time || Date.now()));
    return {
      context: String(payload.context || '').trim(),
      ftime: new Date(time).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).replace(/\//g, '-'),
      time: time
    };
  }).filter(function (entry) {
    return !!String(entry.context || '').trim();
  });
}

async function queryCourierTrackingAdapter(shipment, now) {
  const trackingNo = String(shipment && shipment.trackingNo || '').trim();
  const carrierName = String(shipment && shipment.carrierName || '').trim();
  const upperTracking = trackingNo.toUpperCase();
  if (!trackingNo) {
    return {
      logisticsState: 'no_tracking',
      state: '',
      data: [],
      logisticsSummary: '待发货，暂未录入物流信息',
      successAt: 0
    };
  }
  if (upperTracking.indexOf('FAIL') >= 0 || upperTracking.indexOf('ERROR') >= 0) {
    throw new Error('courier_lookup_failed');
  }
  if (upperTracking.indexOf('NO-TRACE') >= 0 || upperTracking.indexOf('NOTRACE') >= 0 || upperTracking.indexOf('WAIT') >= 0) {
    return {
      logisticsState: 'no_trace',
      state: '0',
      data: buildMockCourierTimeline([
        { time: now - 20 * 60 * 1000, context: '查无结果' }
      ]),
      logisticsSummary: '已录入单号，等待物流公司返回轨迹',
      successAt: 0
    };
  }
  if (upperTracking.indexOf('RETURN') >= 0 || upperTracking.indexOf('BACK') >= 0) {
    return {
      logisticsState: 'stale_success',
      state: '4',
      data: buildMockCourierTimeline([
        { time: now - 25 * 60 * 1000, context: '收件人地址异常，包裹已退回' }
      ]),
      logisticsSummary: '已退签',
      successAt: now
    };
  }
  if (upperTracking.indexOf('REJECT') >= 0 || upperTracking.indexOf('REFUSE') >= 0) {
    return {
      logisticsState: 'stale_success',
      state: '14',
      data: buildMockCourierTimeline([
        { time: now - 25 * 60 * 1000, context: '收件人拒签，包裹待退回' }
      ]),
      logisticsSummary: '已拒签',
      successAt: now
    };
  }
  if (upperTracking.indexOf('SIGNED') >= 0 || upperTracking.indexOf('DELIVERED') >= 0 || upperTracking.indexOf('DONE') >= 0) {
    return {
      logisticsState: 'signed',
      state: '3',
      data: buildMockCourierTimeline([
        { time: now - 15 * 60 * 1000, context: '包裹已签收，签收人：本人' },
        { time: now - 60 * 60 * 1000, context: '快件已到达派送站，正在安排派送' }
      ]),
      logisticsSummary: buildMockCourierSummary('已签收', now - 15 * 60 * 1000),
      successAt: now
    };
  }
  return {
    logisticsState: 'active_success',
    state: '0',
    data: buildMockCourierTimeline([
      { time: now - 30 * 60 * 1000, context: (carrierName || '物流') + '已从杭州分拨中心发出' },
      { time: now - 3 * 60 * 60 * 1000, context: '包裹已到达杭州分拨中心' },
      { time: now - 6 * 60 * 60 * 1000, context: '商家已通知快递揽件' }
    ]),
    logisticsSummary: buildMockCourierSummary((carrierName || '物流') + '运输中，最新节点已同步', now - 30 * 60 * 1000),
    successAt: now
  };
}

async function saveShipmentLogisticsSnapshot(shipmentId, payload, now) {
  const snapshot = normalizeShipmentRecord(Object.assign({}, payload, { id: shipmentId }));
  const updatedAt = Math.max(Number(now || Date.now()), Number(snapshot.updatedAt || 0));
  await run(
    'UPDATE shipments SET logisticsSummary = ?, logisticsState = ?, logisticsProviderState = ?, logisticsDataJson = ?, lastLogisticsQueryAt = ?, lastLogisticsSuccessAt = ?, updatedAt = ? WHERE id = ?',
    [
      snapshot.logisticsSummary,
      snapshot.logisticsState,
      String(snapshot.state || ''),
      JSON.stringify(snapshot.data || []),
      Math.max(0, Number(snapshot.lastLogisticsQueryAt || 0)),
      Math.max(0, Number(snapshot.lastLogisticsSuccessAt || 0)),
      updatedAt,
      shipmentId
    ]
  );
  return snapshot;
}

async function refreshShipmentLogisticsRow(row, now) {
  const shipment = normalizeShipmentRecord(row);
  const beforeSignature = buildShipmentLogisticsSignature(shipment);
  let nextPayload = Object.assign({}, shipment);
  if (!shipment.trackingNo) {
    nextPayload = Object.assign({}, shipment, {
      logisticsState: 'no_tracking',
      state: '',
      data: [],
      logisticsSummary: '待发货，暂未录入物流信息'
    });
  } else if ((shipment.logisticsState === 'signed' || LOGISTICS_STATUS_ONLY_PROVIDER_STATES.indexOf(String(shipment.state || '')) >= 0) && Number(shipment.lastLogisticsSuccessAt || 0) > 0) {
    nextPayload = Object.assign({}, shipment, {
      logisticsState: shipment.logisticsState,
      state: shipment.state,
      data: shipment.data,
      logisticsSummary: buildShipmentLogisticsSummary(shipment.logisticsState, shipment)
    });
  } else if (Number(shipment.lastLogisticsQueryAt || 0) > 0 && now - Number(shipment.lastLogisticsQueryAt || 0) < LOGISTICS_THROTTLE_MS) {
    nextPayload = Object.assign({}, shipment, {
      logisticsState: shipment.logisticsState,
      state: shipment.state,
      data: shipment.data,
      logisticsSummary: buildShipmentLogisticsSummary(shipment.logisticsState, shipment)
    });
  } else {
    try {
      const adapterResult = await queryCourierTrackingAdapter(shipment, now);
      nextPayload = Object.assign({}, shipment, {
        logisticsState: adapterResult.logisticsState,
        state: adapterResult.state,
        data: adapterResult.data,
        logisticsSummary: adapterResult.logisticsSummary,
        lastLogisticsQueryAt: now,
        lastLogisticsSuccessAt: Math.max(0, Number(adapterResult.successAt || 0))
      });
    } catch (error) {
      const hasHistoricalSuccess = Number(shipment.lastLogisticsSuccessAt || 0) > 0 && !!String(shipment.logisticsSummary || '').trim();
      nextPayload = Object.assign({}, shipment, {
        logisticsState: hasHistoricalSuccess
          ? (shipment.logisticsState === 'signed' ? 'signed' : 'stale_success')
          : 'no_trace',
        state: shipment.state,
        data: shipment.data,
        logisticsSummary: hasHistoricalSuccess
          ? buildShipmentLogisticsSummary(shipment.logisticsState, shipment)
          : '已录入单号，等待物流公司返回轨迹',
        lastLogisticsQueryAt: now,
        lastLogisticsSuccessAt: hasHistoricalSuccess ? Number(shipment.lastLogisticsSuccessAt || 0) : 0
      });
    }
  }
  const normalizedNext = normalizeShipmentRecord(nextPayload);
  const signatureChanged = buildShipmentLogisticsSignature(normalizedNext) !== beforeSignature;
  const shouldPersist =
    signatureChanged
    || Number(normalizedNext.lastLogisticsQueryAt || 0) !== Number(shipment.lastLogisticsQueryAt || 0)
    || Number(normalizedNext.lastLogisticsSuccessAt || 0) !== Number(shipment.lastLogisticsSuccessAt || 0);
  if (shouldPersist) {
    await saveShipmentLogisticsSnapshot(shipment.id, normalizedNext, now);
  }
  return {
    changed: signatureChanged,
    shipment: normalizedNext
  };
}

async function refreshOrderLogisticsByRelationId(relationOrderId) {
  const shipmentRows = await listShipmentRowsByOrderId(relationOrderId);
  if (!shipmentRows.length) {
    return { changed: false, order: await getOrderSnapshotByRelationId(relationOrderId) };
  }
  const now = Date.now();
  let changed = false;
  for (let index = 0; index < shipmentRows.length; index++) {
    const result = await refreshShipmentLogisticsRow(shipmentRows[index], now);
    if (result.changed) changed = true;
  }
  return {
    changed: changed,
    order: await getOrderSnapshotByRelationId(relationOrderId)
  };
}

function isShipmentBackgroundPollingCandidate(row) {
  const shipment = normalizeShipmentRecord(row);
  const orderStatus = String(row && row.orderStatus || '').trim();
  if (!shipment.trackingNo) return false;
  if (['done', 'cancelled', 'refunded'].indexOf(orderStatus) >= 0) return false;
  if (shipment.logisticsState === 'signed') return false;
  if (LOGISTICS_STATUS_ONLY_PROVIDER_STATES.indexOf(String(shipment.state || '')) >= 0) return false;
  return true;
}

async function listShipmentsForBackgroundPolling() {
  const qualifiedShipmentColumns = SHIPMENT_LIST_COLUMNS.split(', ').map(function (column) {
    return 's.' + column;
  }).join(', ');
  return all(
    'SELECT ' + qualifiedShipmentColumns + ', o.status AS orderStatus FROM shipments s INNER JOIN orders o ON o.id = s.orderId WHERE TRIM(COALESCE(s.trackingNo, \'\')) <> \'\' ORDER BY s.updatedAt ASC, s.createdAt ASC, s.id ASC'
  );
}

async function runBackgroundLogisticsPolling(reason) {
  if (LOGISTICS_BACKGROUND_POLL_DISABLED) {
    return { skipped: true, reason: 'disabled' };
  }
  if (logisticsBackgroundPollingState.running) {
    return { skipped: true, reason: 'already_running' };
  }
  logisticsBackgroundPollingState.running = true;
  logisticsBackgroundPollingState.lastStartedAt = Date.now();
  logisticsBackgroundPollingState.lastError = '';
  try {
    const rows = await listShipmentsForBackgroundPolling();
    let processedCount = 0;
    let changedCount = 0;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (!isShipmentBackgroundPollingCandidate(row)) continue;
      processedCount += 1;
      const result = await refreshShipmentLogisticsRow(row, Date.now());
      if (result.changed) changedCount += 1;
    }
    logisticsBackgroundPollingState.lastProcessedCount = processedCount;
    logisticsBackgroundPollingState.lastChangedCount = changedCount;
    logisticsBackgroundPollingState.lastCompletedAt = Date.now();
    if (processedCount > 0) {
      console.log('[logistics-poll] ' + reason + ' processed=' + processedCount + ' changed=' + changedCount);
    }
    return {
      skipped: false,
      processedCount: processedCount,
      changedCount: changedCount
    };
  } catch (error) {
    logisticsBackgroundPollingState.lastCompletedAt = Date.now();
    logisticsBackgroundPollingState.lastError = error && error.message ? String(error.message) : 'unknown_error';
    console.error('[logistics-poll] failed:', error);
    return {
      skipped: false,
      error: logisticsBackgroundPollingState.lastError
    };
  } finally {
    logisticsBackgroundPollingState.running = false;
  }
}

function startBackgroundLogisticsPolling() {
  if (LOGISTICS_BACKGROUND_POLL_DISABLED || logisticsBackgroundPollingState.timer) return;
  setTimeout(function () {
    runBackgroundLogisticsPolling('startup').catch(function (error) {
      console.error('[logistics-poll] startup failed:', error);
    });
  }, 1000);
  logisticsBackgroundPollingState.timer = setInterval(function () {
    runBackgroundLogisticsPolling('interval').catch(function (error) {
      console.error('[logistics-poll] interval failed:', error);
    });
  }, LOGISTICS_BACKGROUND_POLL_MS);
  if (logisticsBackgroundPollingState.timer && typeof logisticsBackgroundPollingState.timer.unref === 'function') {
    logisticsBackgroundPollingState.timer.unref();
  }
}

async function listAllOrdersByOwner(ownerUsername) {
  const owner = String(ownerUsername || '').trim();
  if (!owner) return [];
  const orderRows = await all(
    'SELECT ' + ORDER_LIST_COLUMNS + ' FROM orders WHERE username = ? ORDER BY createdAt DESC, id DESC',
    [owner]
  );
  return hydratePagedOrders(orderRows);
}

function isOrderLogisticsCandidate(order) {
  const snapshot = normalizeOrderRecord(order);
  if (Array.isArray(snapshot.shipments) && snapshot.shipments.length > 0) return true;
  return ['paid', 'shipped', 'done'].indexOf(String(snapshot.status || '').trim()) >= 0;
}

function normalizeVisibleOrderIdList(value) {
  return Array.from(new Set((Array.isArray(value) ? value : []).map(function (item) {
    return String(item || '').trim();
  }).filter(Boolean)));
}

async function runBuyerLogisticsRefreshCheck(ownerUsername, options) {
  const owner = String(ownerUsername || '').trim();
  const config = Object.assign({ visibleOrderIds: [], orderId: '' }, options || {});
  const visibleOrderIds = normalizeVisibleOrderIdList(config.visibleOrderIds);
  const targetOrderId = String(config.orderId || '').trim();
  const orderList = targetOrderId
    ? [await getOrderSnapshotByOwner(owner, targetOrderId)].filter(Boolean)
    : await listAllOrdersByOwner(owner);
  const candidates = orderList.filter(isOrderLogisticsCandidate);
  const changedOrderIds = [];
  for (let index = 0; index < candidates.length; index++) {
    const order = normalizeOrderRecord(candidates[index]);
    const refreshed = await refreshOrderLogisticsByRelationId(buildOrderRelationId(owner, order.id));
    if (refreshed.changed) changedOrderIds.push(order.id);
  }
  const changedIdSet = changedOrderIds.reduce(function (result, item) {
    result[String(item || '').trim()] = true;
    return result;
  }, {});
  const visibleChangedOrderIds = visibleOrderIds.filter(function (item) {
    return !!changedIdSet[item];
  });
  return {
    orderId: targetOrderId,
    changed: targetOrderId ? changedOrderIds.indexOf(targetOrderId) >= 0 : visibleChangedOrderIds.length > 0,
    changedOrderIds: changedOrderIds,
    changedCount: changedOrderIds.length,
    visibleOrderIds: visibleOrderIds,
    visibleChangedOrderIds: visibleChangedOrderIds,
    visibleChangedCount: visibleChangedOrderIds.length
  };
}

async function syncDerivedOrderStatusFromShipments(relationOrderId) {
  const orderRow = await get('SELECT * FROM orders WHERE id = ?', [relationOrderId]);
  if (!orderRow) return null;
  const itemRows = await all('SELECT * FROM order_items WHERE orderId = ? ORDER BY sortOrder ASC, id ASC', [relationOrderId]);
  const shipmentRows = await listShipmentRowsByOrderId(relationOrderId);
  const shipmentItemRows = await listShipmentItemRowsByOrderId(relationOrderId);
  const assignedItemIds = shipmentItemRows.reduce(function (result, row) {
    const numericId = Number(row && row.orderItemId || 0);
    if (numericId > 0) result[numericId] = true;
    return result;
  }, {});
  const nextStatus = itemRows.length && itemRows.every(function (itemRow) {
    return !!assignedItemIds[Number(itemRow.id || 0)];
  }) ? 'shipped' : 'paid';
  const nextTrackingNo = shipmentRows[0] && shipmentRows[0].trackingNo ? String(shipmentRows[0].trackingNo) : '';
  await run('UPDATE orders SET status = ?, trackingNo = ? WHERE id = ?', [nextStatus, nextTrackingNo, relationOrderId]);
  const updatedRow = await get('SELECT * FROM orders WHERE id = ?', [relationOrderId]);
  return hydrateOrderRows(updatedRow, itemRows, shipmentRows, shipmentItemRows);
}

async function createShipmentForOrder(ownerUsername, sourceOrderId, payload, actorUsername) {
  const owner = String(ownerUsername || '').trim();
  const orderId = String(sourceOrderId || '').trim();
  const actor = String(actorUsername || '').trim();
  const trackingNo = String(payload && payload.trackingNo || '').trim();
  const carrierCode = String(payload && payload.carrierCode || '').trim();
  const carrierName = String(payload && payload.carrierName || '').trim();
  const requestedOrderItemIds = Array.isArray(payload && payload.orderItemIds) ? payload.orderItemIds : [];
  const selectedOrderItemIds = Array.from(new Set(requestedOrderItemIds.map(function (item) {
    return Number(item || 0);
  }).filter(function (item) {
    return item > 0;
  })));
  if (!owner || !orderId) throw new Error('订单标识不完整');
  if (!trackingNo) throw new Error('请先填写快递单号');
  if (!selectedOrderItemIds.length) throw new Error('请至少选择一条订单商品');
  return withImmediateTransaction(async function () {
    const relationOrderId = buildOrderRelationId(owner, orderId);
    const orderRow = await get('SELECT * FROM orders WHERE id = ?', [relationOrderId]);
    if (!orderRow) throw new Error('订单不存在');
    if (String(orderRow.status || '').trim() !== 'paid') throw new Error('当前订单状态不支持继续发货');
    const itemRows = await all('SELECT * FROM order_items WHERE orderId = ? ORDER BY sortOrder ASC, id ASC', [relationOrderId]);
    if (!itemRows.length) throw new Error('订单缺少商品行，无法发货');
    const itemIdMap = itemRows.reduce(function (result, row) {
      result[Number(row.id || 0)] = row;
      return result;
    }, {});
    const invalidOrderItemId = selectedOrderItemIds.find(function (itemId) {
      return !itemIdMap[itemId];
    });
    if (invalidOrderItemId) throw new Error('存在不属于该订单的商品行，无法发货');
    const existingShipmentItemRows = await listShipmentItemRowsByOrderId(relationOrderId);
    const assignedItemMap = existingShipmentItemRows.reduce(function (result, row) {
      result[Number(row && row.orderItemId || 0)] = true;
      return result;
    }, {});
    const duplicatedItemId = selectedOrderItemIds.find(function (itemId) {
      return !!assignedItemMap[itemId];
    });
    if (duplicatedItemId) throw new Error('所选商品中包含已发货条目，请刷新后重试');
    const shipmentId = buildShipmentId();
    const now = Date.now();
    const shipmentLogistics = normalizeShipmentRecord({
      trackingNo: trackingNo,
      carrierCode: carrierCode,
      carrierName: carrierName,
      logisticsState: 'no_trace',
      logisticsSummary: '已录入单号，等待物流公司返回轨迹'
    });
    await run(
      'INSERT INTO shipments (id, orderId, orderSourceId, ownerUsername, trackingNo, carrierCode, carrierName, status, logisticsSummary, logisticsState, logisticsProviderState, logisticsDataJson, lastLogisticsQueryAt, lastLogisticsSuccessAt, createdAt, updatedAt, createdBy, legacySource) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        shipmentId,
        relationOrderId,
        orderId,
        owner,
        shipmentLogistics.trackingNo,
        shipmentLogistics.carrierCode,
        shipmentLogistics.carrierName,
        'shipped',
        shipmentLogistics.logisticsSummary,
        shipmentLogistics.logisticsState,
        shipmentLogistics.state || '',
        JSON.stringify(shipmentLogistics.data || []),
        0,
        0,
        now,
        now,
        actor,
        ''
      ]
    );
    for (let index = 0; index < selectedOrderItemIds.length; index++) {
      await run(
        'INSERT INTO shipment_items (shipmentId, orderId, orderItemId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)',
        [shipmentId, relationOrderId, selectedOrderItemIds[index], index, now]
      );
    }
    return syncDerivedOrderStatusFromShipments(relationOrderId);
  });
}

async function listRefundRequestsPage(filters) {
  const query = filters || {};
  const paging = normalizePaging(query, { pageSize: 8, maxPageSize: 40 });
  const conditions = [];
  const params = [];
  const status = normalizeTextFilter(query.status);
  const orderId = normalizeTextFilter(query.orderId);
  const ownerUsername = normalizeTextFilter(query.ownerUsername);
  const dateFrom = parseTimeFilterValue(query.dateFrom);
  const dateTo = parseTimeFilterValue(query.dateTo, { endOfDay: true });
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (orderId) {
    conditions.push('orderId LIKE ?');
    params.push(buildContainsLikeValue(orderId));
  }
  if (ownerUsername) {
    conditions.push('ownerUsername LIKE ?');
    params.push(buildContainsLikeValue(ownerUsername));
  }
  if (dateFrom) {
    conditions.push('requestedAt >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push('requestedAt <= ?');
    params.push(dateTo);
  }
  const whereClause = conditions.length ? (' WHERE ' + conditions.join(' AND ')) : '';
  const countRow = await get('SELECT COUNT(*) AS count FROM refund_requests' + whereClause, params);
  const rows = await all(
    'SELECT ' + REFUND_LIST_COLUMNS + ' FROM refund_requests' + whereClause + ' ORDER BY requestedAt DESC, id DESC LIMIT ? OFFSET ?',
    params.concat([paging.pageSize, paging.offset])
  );
  return buildPagedResult(rows.map(hydrateRefundRequest), countRow && countRow.count, paging.page, paging.pageSize);
}

async function listPaymentTransactionsPage(filters) {
  const query = filters || {};
  const paging = normalizePaging(query, { pageSize: 10, maxPageSize: 50 });
  const conditions = [];
  const params = [];
  const orderId = normalizeTextFilter(query.orderId);
  const username = normalizeTextFilter(query.username);
  const status = normalizeTextFilter(query.status);
  const dateFrom = parseTimeFilterValue(query.dateFrom);
  const dateTo = parseTimeFilterValue(query.dateTo, { endOfDay: true });
  if (orderId) {
    conditions.push('orderId LIKE ?');
    params.push(buildContainsLikeValue(orderId));
  }
  if (username) {
    conditions.push('username LIKE ?');
    params.push(buildContainsLikeValue(username));
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (dateFrom) {
    conditions.push('(CASE WHEN paidAt > 0 THEN paidAt ELSE createdAt END) >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push('(CASE WHEN paidAt > 0 THEN paidAt ELSE createdAt END) <= ?');
    params.push(dateTo);
  }
  const whereClause = conditions.length ? (' WHERE ' + conditions.join(' AND ')) : '';
  const countRow = await get('SELECT COUNT(*) AS count FROM payment_transactions' + whereClause, params);
  const rows = await all(
    'SELECT ' + PAYMENT_LIST_COLUMNS + ' FROM payment_transactions' + whereClause + ' ORDER BY paidAt DESC, createdAt DESC, id DESC LIMIT ? OFFSET ?',
    params.concat([paging.pageSize, paging.offset])
  );
  return buildPagedResult(rows.map(normalizePaymentTransaction), countRow && countRow.count, paging.page, paging.pageSize);
}

async function listAftersaleRecordsPage(filters) {
  const query = filters || {};
  const paging = normalizePaging(query, { pageSize: 10, maxPageSize: 50 });
  const conditions = [];
  const params = [];
  const orderId = normalizeTextFilter(query.orderId);
  const username = normalizeTextFilter(query.username);
  const status = normalizeTextFilter(query.status);
  const type = normalizeTextFilter(query.type);
  const dateFrom = parseTimeFilterValue(query.dateFrom);
  const dateTo = parseTimeFilterValue(query.dateTo, { endOfDay: true });
  if (orderId) {
    conditions.push('orderId LIKE ?');
    params.push(buildContainsLikeValue(orderId));
  }
  if (username) {
    conditions.push('username LIKE ?');
    params.push(buildContainsLikeValue(username));
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (type) {
    conditions.push('type = ?');
    params.push(type);
  }
  if (dateFrom) {
    conditions.push('(CASE WHEN updatedAt > 0 THEN updatedAt ELSE createdAt END) >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push('(CASE WHEN updatedAt > 0 THEN updatedAt ELSE createdAt END) <= ?');
    params.push(dateTo);
  }
  const whereClause = conditions.length ? (' WHERE ' + conditions.join(' AND ')) : '';
  const countRow = await get('SELECT COUNT(*) AS count FROM aftersales' + whereClause, params);
  const rows = await all(
    'SELECT ' + AFTERSALE_LIST_COLUMNS + ' FROM aftersales' + whereClause + ' ORDER BY updatedAt DESC, createdAt DESC, id DESC LIMIT ? OFFSET ?',
    params.concat([paging.pageSize, paging.offset])
  );
  return buildPagedResult(rows.map(normalizeAftersaleRecord), countRow && countRow.count, paging.page, paging.pageSize);
}

async function listInventoryLogsPage(filters) {
  const query = filters || {};
  const paging = normalizePaging(query, { pageSize: 10, maxPageSize: 50 });
  const conditions = [];
  const params = [];
  const orderId = normalizeTextFilter(query.orderId);
  const username = normalizeTextFilter(query.username || query.operatorUsername);
  const actionType = normalizeTextFilter(query.actionType || query.status);
  const dateFrom = parseTimeFilterValue(query.dateFrom);
  const dateTo = parseTimeFilterValue(query.dateTo, { endOfDay: true });
  if (orderId) {
    conditions.push('orderId LIKE ?');
    params.push(buildContainsLikeValue(orderId));
  }
  if (username) {
    conditions.push('operatorUsername LIKE ?');
    params.push(buildContainsLikeValue(username));
  }
  if (actionType) {
    conditions.push('actionType = ?');
    params.push(actionType);
  }
  if (dateFrom) {
    conditions.push('createdAt >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push('createdAt <= ?');
    params.push(dateTo);
  }
  const whereClause = conditions.length ? (' WHERE ' + conditions.join(' AND ')) : '';
  const countRow = await get('SELECT COUNT(*) AS count FROM inventory_logs' + whereClause, params);
  const rows = await all(
    'SELECT ' + INVENTORY_LOG_COLUMNS + ' FROM inventory_logs' + whereClause + ' ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?',
    params.concat([paging.pageSize, paging.offset])
  );
  return buildPagedResult(rows.map(normalizeInventoryLog), countRow && countRow.count, paging.page, paging.pageSize);
}

async function getAdminLightStats() {
  const stats = await Promise.all([
    get('SELECT COUNT(*) AS count FROM products'),
    get('SELECT COUNT(*) AS count FROM users'),
    get('SELECT COUNT(*) AS count FROM orders'),
    get("SELECT COUNT(*) AS count FROM refund_requests WHERE status = 'pending'"),
    get("SELECT COUNT(*) AS count FROM orders WHERE status = 'pending'"),
    get("SELECT COALESCE(SUM(amount), 0) AS total FROM payment_transactions WHERE status = 'paid'")
  ]);
  return {
    productCount: Number(stats[0] && stats[0].count || 0),
    userCount: Number(stats[1] && stats[1].count || 0),
    orderCount: Number(stats[2] && stats[2].count || 0),
    pendingRefundCount: Number(stats[3] && stats[3].count || 0),
    pendingOrderCount: Number(stats[4] && stats[4].count || 0),
    paidSalesTotal: Number(stats[5] && stats[5].total || 0)
  };
}

async function listRefundRequests(filters) {
  const rows = await all('SELECT * FROM refund_requests ORDER BY requestedAt DESC, id DESC');
  const query = filters || {};
  const status = normalizeTextFilter(query.status);
  const orderId = normalizeTextFilter(query.orderId);
  const ownerUsername = normalizeTextFilter(query.ownerUsername);
  const dateFrom = parseTimeFilterValue(query.dateFrom);
  const dateTo = parseTimeFilterValue(query.dateTo, { endOfDay: true });
  return rows
    .map(hydrateRefundRequest)
    .filter(function (item) {
      return exactTextFilter(item.status, status)
        && containsTextFilter(item.orderId, orderId)
        && containsTextFilter(item.ownerUsername, ownerUsername)
        && isTimestampInRange(item.requestedAt || item.updatedAt || 0, dateFrom, dateTo);
    });
}

async function listPaymentTransactions(filters) {
  const rows = await all('SELECT * FROM payment_transactions ORDER BY paidAt DESC, createdAt DESC, id DESC');
  const query = filters || {};
  const orderId = normalizeTextFilter(query.orderId);
  const username = normalizeTextFilter(query.username);
  const status = normalizeTextFilter(query.status);
  const dateFrom = parseTimeFilterValue(query.dateFrom);
  const dateTo = parseTimeFilterValue(query.dateTo, { endOfDay: true });
  return rows
    .map(normalizePaymentTransaction)
    .filter(function (item) {
      return containsTextFilter(item.orderId, orderId)
        && containsTextFilter(item.username, username)
        && exactTextFilter(item.status, status)
        && isTimestampInRange(item.paidAt || item.createdAt || 0, dateFrom, dateTo);
    });
}

async function listAftersaleRecords(filters) {
  const rows = await all('SELECT * FROM aftersales ORDER BY updatedAt DESC, createdAt DESC, id DESC');
  const query = filters || {};
  const orderId = normalizeTextFilter(query.orderId);
  const username = normalizeTextFilter(query.username);
  const status = normalizeTextFilter(query.status);
  const type = normalizeTextFilter(query.type);
  const dateFrom = parseTimeFilterValue(query.dateFrom);
  const dateTo = parseTimeFilterValue(query.dateTo, { endOfDay: true });
  return rows
    .map(normalizeAftersaleRecord)
    .filter(function (item) {
      return containsTextFilter(item.orderId, orderId)
        && containsTextFilter(item.username, username)
        && exactTextFilter(item.status, status)
        && exactTextFilter(item.type, type)
        && isTimestampInRange(item.updatedAt || item.createdAt || 0, dateFrom, dateTo);
    });
}

async function listInventoryLogs(filters) {
  const rows = await all('SELECT * FROM inventory_logs ORDER BY createdAt DESC, id DESC');
  const query = filters || {};
  const orderId = normalizeTextFilter(query.orderId);
  const username = normalizeTextFilter(query.username || query.operatorUsername);
  const actionType = normalizeTextFilter(query.actionType || query.status);
  const dateFrom = parseTimeFilterValue(query.dateFrom);
  const dateTo = parseTimeFilterValue(query.dateTo, { endOfDay: true });
  return rows
    .map(normalizeInventoryLog)
    .filter(function (item) {
      return containsTextFilter(item.orderId, orderId)
        && containsTextFilter(item.operatorUsername, username)
        && exactTextFilter(item.actionType, actionType)
        && isTimestampInRange(item.createdAt, dateFrom, dateTo);
    });
}

async function searchBuyerVisibleProducts(keyword) {
  await seedProductsIfNeeded();
  const categoryList = await getCategoryList();
  const categoryNameById = categoryList.reduce(function (result, item) {
    result[String(item.id || '')] = String(item.name || '');
    return result;
  }, {});
  const tokens = tokenizeSearchKeyword(keyword);
  const rows = await all(
    'SELECT ' + PRODUCT_LIST_COLUMNS + ' FROM products WHERE off = 0 ORDER BY sales DESC, id DESC LIMIT ?',
    [120]
  );
  const hydrated = rows.map(hydrateProduct);
  if (!tokens.length) return hydrated;
  return hydrated
    .map(function (item) {
      const haystacks = [
        item.name,
        item.farmer,
        item.village,
        categoryNameById[String(item.cat || '')] || '',
        Array.isArray(item.tags) ? item.tags.join(' ') : ''
      ].join(' ').toLowerCase();
      const matchCount = tokens.reduce(function (count, token) {
        return count + (haystacks.indexOf(token) >= 0 ? 1 : 0);
      }, 0);
      return { item: item, matchCount: matchCount };
    })
    .filter(function (entry) {
      return entry.matchCount > 0;
    })
    .sort(function (a, b) {
      if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
      if (Number(b.item.sales || 0) !== Number(a.item.sales || 0)) return Number(b.item.sales || 0) - Number(a.item.sales || 0);
      return Number(b.item.id || 0) - Number(a.item.id || 0);
    })
    .slice(0, 24)
    .map(function (entry) { return entry.item; });
}

async function getProductById(productId) {
  await seedProductsIfNeeded();
  const row = await get('SELECT * FROM products WHERE id = ?', [Number(productId || 0)]);
  return row ? hydrateProduct(row) : null;
}

async function getActiveRefundRequestByOrder(ownerUsername, orderId) {
  const row = await get(
    "SELECT * FROM refund_requests WHERE ownerUsername = ? AND orderId = ? AND status = 'pending' ORDER BY requestedAt DESC, id DESC LIMIT 1",
    [String(ownerUsername || '').trim(), String(orderId || '').trim()]
  );
  return row ? hydrateRefundRequest(row) : null;
}

async function insertRefundRequest(record) {
  const refund = toDbRefundRequest(record);
  await run(
    'INSERT INTO refund_requests (id, orderId, ownerUsername, scopeType, itemsSnapshot, sourceOrderStatus, status, refundAmount, reason, assigneeRole, assigneeUsername, inventoryRestored, paymentRefunded, rejectReason, requestedAt, reviewedAt, completedAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      refund.id,
      refund.orderId,
      refund.ownerUsername,
      refund.scopeType,
      refund.itemsSnapshot,
      refund.sourceOrderStatus,
      refund.status,
      refund.refundAmount,
      refund.reason,
      refund.assigneeRole,
      refund.assigneeUsername,
      refund.inventoryRestored,
      refund.paymentRefunded,
      refund.rejectReason,
      refund.requestedAt,
      refund.reviewedAt,
      refund.completedAt,
      refund.updatedAt
    ]
  );
  return getRefundRequestById(refund.id);
}

async function updateRefundRequest(record) {
  const refund = toDbRefundRequest(record);
  await run(
    'UPDATE refund_requests SET orderId = ?, ownerUsername = ?, scopeType = ?, itemsSnapshot = ?, sourceOrderStatus = ?, status = ?, refundAmount = ?, reason = ?, assigneeRole = ?, assigneeUsername = ?, inventoryRestored = ?, paymentRefunded = ?, rejectReason = ?, requestedAt = ?, reviewedAt = ?, completedAt = ?, updatedAt = ? WHERE id = ?',
    [
      refund.orderId,
      refund.ownerUsername,
      refund.scopeType,
      refund.itemsSnapshot,
      refund.sourceOrderStatus,
      refund.status,
      refund.refundAmount,
      refund.reason,
      refund.assigneeRole,
      refund.assigneeUsername,
      refund.inventoryRestored,
      refund.paymentRefunded,
      refund.rejectReason,
      refund.requestedAt,
      refund.reviewedAt,
      refund.completedAt,
      refund.updatedAt,
      refund.id
    ]
  );
  return getRefundRequestById(refund.id);
}

function normalizeCartItem(item, index) {
  return {
    productId: Number(item && item.id || item && item.productId || 0),
    name: item && item.name ? String(item.name) : '',
    variantId: item && item.variantId ? String(item.variantId) : '',
    variantLabel: item && (item.variantLabel || item.unit) ? String(item.variantLabel || item.unit) : '',
    unitId: item && item.unitId ? String(item.unitId) : '',
    unitLabel: item && (item.unitLabel || item.unit || item.variantLabel) ? String(item.unitLabel || item.unit || item.variantLabel) : '',
    price: Number(item && item.price || 0),
    deliveryFee: Number(item && item.deliveryFee || 0),
    unit: item && (item.unit || item.unitLabel || item.variantLabel) ? String(item.unit || item.unitLabel || item.variantLabel) : '',
    img: item && item.img ? String(item.img) : '',
    qty: Number(item && item.qty || 0),
    sortOrder: Number(item && item.sortOrder != null ? item.sortOrder : index || 0)
  };
}

function hydrateCartItem(row) {
  return {
    id: row.productId,
    name: row.name,
    variantId: row.variantId || '',
    variantLabel: row.variantLabel || row.unit || '',
    unitId: row.unitId || '',
    unitLabel: row.unitLabel || row.unit || row.variantLabel || '',
    price: row.price,
    deliveryFee: Number(row.deliveryFee || 0),
    unit: row.unit,
    img: row.img,
    qty: row.qty
  };
}

async function syncUserCartRelations(username, cart) {
  await run('DELETE FROM cart_items WHERE username = ?', [username]);
  const cartList = Array.isArray(cart) ? cart : [];
  for (let index = 0; index < cartList.length; index++) {
    const item = normalizeCartItem(cartList[index], index);
    await run(
      'INSERT INTO cart_items (username, productId, name, variantId, variantLabel, unitId, unitLabel, price, deliveryFee, unit, img, qty, sortOrder) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [username, item.productId, item.name, item.variantId, item.variantLabel, item.unitId, item.unitLabel, item.price, item.deliveryFee, item.unit, item.img, item.qty, index]
    );
  }
}

async function listUserCartRelations(username) {
  const rows = await all('SELECT * FROM cart_items WHERE username = ? ORDER BY sortOrder ASC, id ASC', [username]);
  return rows.map(hydrateCartItem);
}

function normalizeUserCoupon(item, index) {
  return {
    id: item && item.id ? String(item.id) : 'coupon_' + index,
    templateId: item && item.templateId ? String(item.templateId) : '',
    name: item && item.name ? String(item.name) : '',
    type: item && item.type === 'discount' ? 'discount' : 'full_reduction',
    discountRate: Number(item && item.discountRate || 0),
    amount: Number(item && item.amount || 0),
    minSpend: Number(item && item.minSpend || 0),
    used: !!(item && item.used),
    sortOrder: Number(item && item.sortOrder != null ? item.sortOrder : index || 0)
  };
}

function hydrateUserCoupon(row) {
  return normalizeUserCoupon({
    id: row.sourceId || row.id,
    templateId: row.templateId,
    name: row.name,
    type: row.type,
    discountRate: row.discountRate,
    amount: row.amount,
    minSpend: row.minSpend,
    used: !!row.used,
    sortOrder: row.sortOrder
  }, row.sortOrder);
}

async function syncUserCouponRelations(username, coupons) {
  await run('DELETE FROM user_coupons WHERE username = ?', [username]);
  const couponList = Array.isArray(coupons) ? coupons : [];
  for (let index = 0; index < couponList.length; index++) {
    const item = normalizeUserCoupon(couponList[index], index);
    const relationId = username + ':' + item.id;
    await run(
      'INSERT INTO user_coupons (id, sourceId, username, templateId, name, type, discountRate, amount, minSpend, used, sortOrder) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [relationId, item.id, username, item.templateId, item.name, item.type, item.discountRate, item.amount, item.minSpend, item.used ? 1 : 0, index]
    );
  }
}

async function listUserCouponRelations(username) {
  const rows = await all('SELECT * FROM user_coupons WHERE username = ? ORDER BY sortOrder ASC, id ASC', [username]);
  return rows.map(hydrateUserCoupon);
}

// [SERVER_RELATIONS] 用户与地址/订单/购物车/优惠券的关系表同步都集中在这里。
async function insertPaymentTransaction(username, order, options) {
  const normalizedOrder = normalizeOrderRecord(order);
  if (!username || !normalizedOrder.id || !isPaidOrderStatus(normalizedOrder.status)) return;
  const meta = normalizeAuditMeta(options, {
    actionType: 'payment_success',
    operatorUsername: username,
    operatorRole: 'buyer',
    orderId: normalizedOrder.id,
    note: '订单支付完成后自动记账',
    channel: 'mock_h5'
  });
  await run(
    'INSERT OR IGNORE INTO payment_transactions (id, username, orderId, amount, status, channel, couponId, couponText, receiverName, receiverPhone, receiverFull, externalTradeNo, createdAt, paidAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      username + ':' + normalizedOrder.id,
      username,
      normalizedOrder.id,
      normalizedOrder.total,
      'paid',
      meta.channel || 'mock_h5',
      normalizedOrder.couponId || '',
      normalizedOrder.coupon || '',
      normalizedOrder.address && normalizedOrder.address.name ? normalizedOrder.address.name : '',
      normalizedOrder.address && normalizedOrder.address.phone ? normalizedOrder.address.phone : '',
      normalizedOrder.address && normalizedOrder.address.full ? normalizedOrder.address.full : '',
      buildAlipayOutTradeNo(username, normalizedOrder.id),
      Date.now(),
      Number(options && options.paidAt || normalizedOrder.time || Date.now())
    ]
  );
}

async function insertAftersaleRecord(username, order, options) {
  const normalizedOrder = normalizeOrderRecord(order);
  const aftersaleType = getAftersaleTypeByStatus(normalizedOrder.status);
  if (!username || !normalizedOrder.id || !aftersaleType) return;
  const meta = normalizeAuditMeta(options, {
    actionType: aftersaleType,
    operatorUsername: username,
    operatorRole: 'system',
    orderId: normalizedOrder.id,
    note: aftersaleType === 'cancel' ? '订单已取消' : '订单进入售后流程'
  });
  await run(
    'INSERT OR IGNORE INTO aftersales (id, username, orderId, type, status, amount, reason, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      username + ':' + normalizedOrder.id + ':' + aftersaleType,
      username,
      normalizedOrder.id,
      aftersaleType,
      normalizedOrder.status,
      normalizedOrder.total,
      meta.note || '',
      Number(options && options.createdAt || Date.now()),
      Date.now()
    ]
  );
}

// [SERVER_ORDER_DERIVED] 支付流水、售后记录、库存审计等派生数据都由订单变化触发。
// 用户状态保存仍沿用原接口，但这里会把订单状态差异沉淀为支付与售后日志，避免前端为统计先做大改。
async function syncOrderDerivedRelations(username, previousOrders, nextOrders, auditMeta) {
  const previousMap = buildOrderMap(previousOrders);
  const nextMap = buildOrderMap(nextOrders);
  const nextIds = Object.keys(nextMap);
  for (let index = 0; index < nextIds.length; index++) {
    const orderId = nextIds[index];
    const currentOrder = nextMap[orderId];
    const previousOrder = previousMap[orderId];
    const wasPaid = previousOrder ? isPaidOrderStatus(previousOrder.status) : false;
    const nowPaid = isPaidOrderStatus(currentOrder.status);
    const previousAftersaleType = previousOrder ? getAftersaleTypeByStatus(previousOrder.status) : '';
    const currentAftersaleType = ['buyer_pending_cancel', 'timeout_release'].indexOf(String(currentOrder.cancelReason || '')) >= 0
      ? ''
      : getAftersaleTypeByStatus(currentOrder.status);
    if (nowPaid && !wasPaid) {
      await insertPaymentTransaction(username, currentOrder, {
        channel: auditMeta && auditMeta.channel ? auditMeta.channel : 'mock_h5',
        paidAt: currentOrder.time || Date.now(),
        operatorUsername: auditMeta && auditMeta.operatorUsername ? auditMeta.operatorUsername : username,
        operatorRole: auditMeta && auditMeta.operatorRole ? auditMeta.operatorRole : 'buyer',
        note: '订单从用户状态保存中识别为已支付'
      });
    }
    if (currentAftersaleType && currentAftersaleType !== previousAftersaleType) {
      await insertAftersaleRecord(username, currentOrder, {
        createdAt: Date.now(),
        operatorUsername: auditMeta && auditMeta.operatorUsername ? auditMeta.operatorUsername : username,
        operatorRole: auditMeta && auditMeta.operatorRole ? auditMeta.operatorRole : 'system',
        note: currentAftersaleType === 'cancel' ? '订单状态变更为已取消' : '订单状态变更为售后/退款'
      });
    }
  }
}

async function backfillOrderDerivedRelations() {
  const users = await listUsers();
  for (let index = 0; index < users.length; index++) {
    const user = users[index];
    const orders = Array.isArray(user.orders) ? user.orders : [];
    for (let orderIndex = 0; orderIndex < orders.length; orderIndex++) {
      const order = normalizeOrderRecord(orders[orderIndex]);
      if (isPaidOrderStatus(order.status)) {
        await insertPaymentTransaction(user.username, order, {
          paidAt: order.time || Date.now(),
          operatorUsername: user.username,
          operatorRole: 'buyer',
          channel: 'mock_h5',
          note: '从历史订单回填支付流水'
        });
      }
      if (getAftersaleTypeByStatus(order.status) && ['buyer_pending_cancel', 'timeout_release'].indexOf(String(order.cancelReason || '')) < 0) {
        await insertAftersaleRecord(user.username, order, {
          createdAt: order.time || Date.now(),
          operatorUsername: user.username,
          operatorRole: 'system',
          note: '从历史订单回填售后记录'
        });
      }
    }
  }
}

async function hydrateUserWithRelations(row) {
  const base = hydrateUser(row);
  const addressRelations = await listUserAddressRelations(base.username);
  const orderRelations = await listUserOrderRelations(base.username);
  const cartRelations = await listUserCartRelations(base.username);
  const couponRelations = await listUserCouponRelations(base.username);
  base.addresses = addressRelations.addresses.length ? addressRelations.addresses : base.addresses;
  base.shippingAddresses = addressRelations.shippingAddresses.length ? addressRelations.shippingAddresses : base.shippingAddresses;
  base.orders = orderRelations.length ? orderRelations : base.orders;
  base.cart = cartRelations.length ? cartRelations : base.cart;
  base.coupons = couponRelations.length ? couponRelations : base.coupons;
  return normalizeUserRecord(base);
}

function normalizeProduct(product) {
  const source = product || {};
  const rawImages = Array.isArray(source.images) ? source.images : [];
  let normalizedImages = rawImages
    .map(function (item) { return String(item || '').trim(); })
    .filter(Boolean)
    .filter(function (item, index, list) { return list.indexOf(item) === index; });
  const explicitCover = String(source.img || source.coverImage || '').trim();
  if (explicitCover && normalizedImages.indexOf(explicitCover) < 0) normalizedImages.unshift(explicitCover);
  if (explicitCover && normalizedImages.indexOf(explicitCover) > 0) {
    normalizedImages = [explicitCover].concat(normalizedImages.filter(function (item) { return item !== explicitCover; }));
  }
  const normalized = Object.assign({
    cat: 'veg',
    tags: [],
    stock: 30,
    sales: 0,
    harvest: new Date().toISOString().slice(0, 10),
    dispatchHours: 4,
    farmer: '待设置',
    farmerAccount: '',
    farmerUserId: 0,
    village: '待设置',
    shippingAddressId: '',
    shippingAddressSnapshot: {},
    images: [],
    img: '',
    off: false,
    trace: []
  }, source, {
    id: source && source.id ? Number(source.id) : undefined,
    orig: Number(source && (source.orig != null ? source.orig : source.price) || 0),
    sales: Number(source && source.sales || 0),
    dispatchHours: Number(source && source.dispatchHours || 4),
    off: !!(source && source.off),
    tags: Array.isArray(source && source.tags) ? source.tags : [],
    shippingAddressId: source && source.shippingAddressId ? String(source.shippingAddressId) : '',
    shippingAddressSnapshot: source && source.shippingAddressSnapshot && typeof source.shippingAddressSnapshot === 'object' && !Array.isArray(source.shippingAddressSnapshot) ? source.shippingAddressSnapshot : {},
    trace: Array.isArray(source && source.trace) ? source.trace : []
  });
  normalized.variants = normalizeProductVariants(Object.assign({}, normalized, {
    variants: product && Array.isArray(product.variants) ? product.variants : normalized.variants
  }));
  const defaultVariant = getDefaultVariant(normalized);
  const defaultUnit = defaultVariant ? getDefaultUnitForVariant(defaultVariant, normalized) : null;
  normalized.price = Number(defaultUnit && defaultUnit.price || defaultVariant && defaultVariant.price || 0);
  normalized.deliveryFee = Number(defaultUnit && defaultUnit.deliveryFee || 0);
  normalized.orig = normalized.price;
  normalized.unit = defaultUnit && defaultUnit.label ? String(defaultUnit.label) : '';
  normalized.stock = normalized.variants.reduce(function (sum, item) {
    return sum + Math.max(0, Number(item && item.stock || 0));
  }, 0);
  normalized.defaultVariantId = defaultVariant && defaultVariant.id ? String(defaultVariant.id) : '';
  normalized.defaultUnitId = defaultUnit && defaultUnit.id ? String(defaultUnit.id) : '';
  normalized.images = normalizedImages.length ? normalizedImages : (normalized.img ? [String(normalized.img).trim()] : []);
  normalized.img = explicitCover && normalized.images.indexOf(explicitCover) > -1
    ? explicitCover
    : (normalized.images[0] || '');
  if (!normalized.images.length && normalized.img) normalized.images = [normalized.img];
  return normalized;
}

function hydrateProduct(row) {
  return normalizeProduct({
    id: row.id,
    name: row.name,
    price: row.price,
    orig: row.orig,
    unit: row.unit,
    cat: row.cat,
    tags: parseJsonArray(row.tags),
    stock: row.stock,
    sales: row.sales,
    harvest: row.harvest,
    dispatchHours: row.dispatchHours,
    farmer: row.farmer,
    farmerAccount: row.farmerAccount,
    farmerUserId: row.farmerUserId,
    village: row.village,
    shippingAddressId: row.shippingAddressId,
    shippingAddressSnapshot: parseJsonObject(row.shippingAddressSnapshot, {}),
    images: parseJsonArray(row.imagesJson),
    img: row.img,
    off: !!row.off,
    trace: parseJsonArray(row.trace),
    variants: parseJsonArray(row.variantsJson)
  });
}

function toDbProduct(product) {
  const item = normalizeProduct(product);
  return {
    id: item.id,
    name: item.name || '',
    price: item.price,
    orig: Number(item.orig != null ? item.orig : item.price),
    unit: item.unit || '',
    cat: item.cat || 'veg',
    tags: JSON.stringify(item.tags || []),
    stock: item.stock,
    sales: item.sales,
    harvest: item.harvest || '',
    dispatchHours: item.dispatchHours,
    farmer: item.farmer || '待设置',
    farmerAccount: item.farmerAccount || '',
    farmerUserId: Number(item.farmerUserId || 0),
    village: item.village || '待设置',
    shippingAddressId: item.shippingAddressId || '',
    shippingAddressSnapshot: JSON.stringify(item.shippingAddressSnapshot || {}),
    imagesJson: JSON.stringify(item.images || []),
    img: item.img || '',
    off: item.off ? 1 : 0,
    trace: JSON.stringify(item.trace || []),
    variantsJson: JSON.stringify(item.variants || [])
  };
}

function readDefaultProducts() {
  return readDefaultArray(/const PRODUCTS = (\[[\s\S]*?\]);\s*const CATEGORIES =/).map(normalizeProduct);
}

// [SERVER_CATEGORY_MODEL] 商品分类的种子、归一化和持久化统一从这里往下查。
function buildCategoryId(value, index) {
  const seed = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return seed || 'category_' + (index || 0);
}

function normalizeCategory(item, index) {
  const category = item || {};
  return {
    id: category && category.id ? String(category.id) : buildCategoryId(category.name, index),
    name: category && category.name ? String(category.name).trim() : '未命名分类',
    icon: category && category.icon ? String(category.icon).trim() : '🧺',
    sortOrder: Number(category && category.sortOrder != null ? category.sortOrder : index || 0),
    showOnHome: !(category && category.showOnHome === false) && String(category && category.showOnHome || '') !== '0'
  };
}

function hydrateCategory(row) {
  return normalizeCategory({
    id: row.id,
    name: row.name,
    icon: row.icon,
    sortOrder: row.sortOrder,
    showOnHome: !!Number(row.showOnHome != null ? row.showOnHome : 1)
  }, row.sortOrder);
}

function toDbCategory(item, index) {
  const category = normalizeCategory(item, index);
  return {
    id: category.id,
    name: category.name,
    icon: category.icon,
    sortOrder: category.sortOrder,
    showOnHome: category.showOnHome ? 1 : 0
  };
}

function readDefaultCategories() {
  return readDefaultArray(/const CATEGORIES = (\[[\s\S]*?\]);\s*const PRODUCT_TAG_OPTIONS =/).map(normalizeCategory);
}

function normalizeBanner(banner, index) {
  return Object.assign({
    id: banner && banner.id ? Number(banner.id) : undefined,
    title: '',
    sub: '',
    img: '',
    linkType: 'none',
    externalUrl: '',
    productId: 0,
    sortOrder: index || 0
  }, banner || {}, {
    id: banner && banner.id ? Number(banner.id) : undefined,
    linkType: banner && banner.linkType ? banner.linkType : 'none',
    externalUrl: banner && banner.externalUrl ? banner.externalUrl : '',
    productId: Number(banner && banner.productId || 0),
    sortOrder: Number(banner && banner.sortOrder != null ? banner.sortOrder : index || 0)
  });
}

function hydrateBanner(row) {
  return normalizeBanner({
    id: row.id,
    title: row.title,
    sub: row.sub,
    img: row.img,
    linkType: row.linkType,
    externalUrl: row.externalUrl,
    productId: row.productId,
    sortOrder: row.sortOrder
  }, row.sortOrder);
}

function toDbBanner(banner, index) {
  const item = normalizeBanner(banner, index);
  return {
    id: item.id,
    title: item.title || '',
    sub: item.sub || '',
    img: item.img || '',
    linkType: item.linkType === 'external' ? 'external' : item.linkType === 'product' ? 'product' : 'none',
    externalUrl: item.externalUrl || '',
    productId: Number(item.productId || 0),
    sortOrder: Number(item.sortOrder || 0)
  };
}

function readDefaultBanners() {
  return readDefaultArray(/const BANNERS = (\[[\s\S]*?\]);\s*const ANNOUNCEMENTS =/).map(normalizeBanner);
}

function normalizeAnnouncement(item, index) {
  return Object.assign({
    id: item && item.id ? Number(item.id) : undefined,
    text: '',
    active: true,
    linkType: 'none',
    externalUrl: '',
    productId: 0,
    sortOrder: index || 0
  }, item || {}, {
    id: item && item.id ? Number(item.id) : undefined,
    active: item && item.active !== false,
    linkType: item && item.linkType ? item.linkType : 'none',
    externalUrl: item && item.externalUrl ? item.externalUrl : '',
    productId: Number(item && item.productId || 0),
    sortOrder: Number(item && item.sortOrder != null ? item.sortOrder : index || 0)
  });
}

function hydrateAnnouncement(row) {
  return normalizeAnnouncement({
    id: row.id,
    text: row.text,
    active: !!row.active,
    linkType: row.linkType,
    externalUrl: row.externalUrl,
    productId: row.productId,
    sortOrder: row.sortOrder
  }, row.sortOrder);
}

function toDbAnnouncement(item, index) {
  const data = normalizeAnnouncement(item, index);
  return {
    id: data.id,
    text: data.text || '',
    active: data.active ? 1 : 0,
    linkType: data.linkType === 'external' ? 'external' : data.linkType === 'product' ? 'product' : 'none',
    externalUrl: data.externalUrl || '',
    productId: Number(data.productId || 0),
    sortOrder: Number(data.sortOrder || 0)
  };
}

function readDefaultAnnouncements() {
  return readDefaultArray(/const ANNOUNCEMENTS = (\[[\s\S]*?\]);\s*\/\/ === STATE ===/).map(normalizeAnnouncement);
}

// [SERVER_PRODUCT_CONTENT] 商品、Banner、公告等主内容模型和持久化从这里往下查。
async function insertProduct(product) {
  const item = toDbProduct(product);
  const audit = normalizeAuditMeta(product && product._audit, {
    actionType: 'create',
    operatorUsername: item.farmerAccount || '',
    operatorRole: item.farmerAccount ? 'farmer' : 'admin',
    note: '新商品创建并初始化库存'
  });
  const result = await run(
    'INSERT INTO products (id, name, price, orig, unit, cat, tags, stock, sales, harvest, dispatchHours, farmer, farmerAccount, farmerUserId, village, shippingAddressId, shippingAddressSnapshot, imagesJson, img, off, "trace", variantsJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      item.id || null,
      item.name,
      item.price,
      item.orig,
      item.unit,
      item.cat,
      item.tags,
      item.stock,
      item.sales,
      item.harvest,
      item.dispatchHours,
      item.farmer,
      item.farmerAccount,
      item.farmerUserId,
      item.village,
      item.shippingAddressId,
      item.shippingAddressSnapshot,
      item.imagesJson,
      item.img,
      item.off,
      item.trace,
      item.variantsJson
    ]
  );
  await run(
    'INSERT INTO inventory_logs (productId, productName, operatorUsername, operatorRole, actionType, deltaStock, deltaSales, beforeStock, afterStock, beforeSales, afterSales, orderId, note, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      item.id || result.lastID,
      item.name,
      audit.operatorUsername,
      audit.operatorRole,
      audit.actionType,
      item.stock,
      item.sales,
      0,
      item.stock,
      0,
      item.sales,
      audit.orderId,
      audit.note,
      Date.now()
    ]
  );
  return item.id || result.lastID;
}

async function updateProduct(product) {
  const item = toDbProduct(product);
  const existingRow = await get('SELECT * FROM products WHERE id = ?', [item.id]);
  const previous = existingRow ? hydrateProduct(existingRow) : null;
  const result = await run(
    'UPDATE products SET name = ?, price = ?, orig = ?, unit = ?, cat = ?, tags = ?, stock = ?, sales = ?, harvest = ?, dispatchHours = ?, farmer = ?, farmerAccount = ?, farmerUserId = ?, village = ?, shippingAddressId = ?, shippingAddressSnapshot = ?, imagesJson = ?, img = ?, off = ?, "trace" = ?, variantsJson = ? WHERE id = ?',
    [
      item.name,
      item.price,
      item.orig,
      item.unit,
      item.cat,
      item.tags,
      item.stock,
      item.sales,
      item.harvest,
      item.dispatchHours,
      item.farmer,
      item.farmerAccount,
      item.farmerUserId,
      item.village,
      item.shippingAddressId,
      item.shippingAddressSnapshot,
      item.imagesJson,
      item.img,
      item.off,
      item.trace,
      item.variantsJson,
      item.id
    ]
  );
  if (result.changes && previous) {
    const next = normalizeProduct(product);
    const deltaStock = next.stock - previous.stock;
    const deltaSales = next.sales - previous.sales;
    if (deltaStock !== 0 || deltaSales !== 0) {
      // 库存流水直接在商品写入点记录，这样既能覆盖人工改库存，也能覆盖支付成功后的库存扣减。
      const audit = normalizeAuditMeta(product && product._audit, {
        actionType: deltaStock < 0 && deltaSales > 0 ? 'order_sale' : 'manual_adjust',
        operatorUsername: next.farmerAccount || previous.farmerAccount || '',
        operatorRole: next.farmerAccount || previous.farmerAccount ? 'farmer' : 'admin',
        note: deltaStock < 0 && deltaSales > 0 ? '订单支付后自动扣减库存并累计销量' : '商品库存或销量发生人工调整'
      });
      await run(
        'INSERT INTO inventory_logs (productId, productName, operatorUsername, operatorRole, actionType, deltaStock, deltaSales, beforeStock, afterStock, beforeSales, afterSales, orderId, note, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          next.id,
          next.name,
          audit.operatorUsername,
          audit.operatorRole,
          audit.actionType,
          deltaStock,
          deltaSales,
          previous.stock,
          next.stock,
          previous.sales,
          next.sales,
          audit.orderId,
          audit.note,
          Date.now()
        ]
      );
    }
  }
  return result.changes;
}

function buildProductOrderStatusSummary(rows) {
  const source = Array.isArray(rows) ? rows : [];
  const statusMap = source.reduce(function (result, item) {
    const key = String(item && item.status || '').trim() || 'unknown';
    result[key] = Number(item && item.count || 0);
    return result;
  }, {});
  const displayOrder = ['pending', 'paid', 'shipped', 'done', 'cancelled', 'refund_pending', 'refunded'];
  const statusCounts = [];
  for (let index = 0; index < displayOrder.length; index++) {
    const status = displayOrder[index];
    if (statusMap[status] > 0) statusCounts.push({ status: status, count: statusMap[status] });
    delete statusMap[status];
  }
  Object.keys(statusMap).sort().forEach(function (status) {
    if (statusMap[status] > 0) statusCounts.push({ status: status, count: statusMap[status] });
  });
  return statusCounts;
}

async function getProductDeleteImpact(productId) {
  const id = Number(productId || 0);
  if (!(id > 0)) return null;
  const productRow = await get('SELECT * FROM products WHERE id = ?', [id]);
  if (!productRow) return null;
  const statusRows = await all(
    'SELECT o.status AS status, COUNT(DISTINCT o.id) AS count FROM orders o INNER JOIN order_items oi ON oi.orderId = o.id WHERE oi.productId = ? GROUP BY o.status',
    [id]
  );
  const statusCounts = buildProductOrderStatusSummary(statusRows);
  const totalOrders = statusCounts.reduce(function (sum, item) {
    return sum + Number(item && item.count || 0);
  }, 0);
  return {
    productId: id,
    productName: productRow.name || '',
    totalOrders: totalOrders,
    statusCounts: statusCounts
  };
}

async function deleteProductById(productId, auditMeta) {
  const id = Number(productId || 0);
  if (!(id > 0)) return null;
  const productRow = await get('SELECT * FROM products WHERE id = ?', [id]);
  if (!productRow) return null;
  const impact = await getProductDeleteImpact(id);
  const product = hydrateProduct(productRow);
  const audit = normalizeAuditMeta(auditMeta, {
    actionType: 'product_delete',
    operatorUsername: product.farmerAccount || '',
    operatorRole: product.farmerAccount ? 'farmer' : 'admin',
    note: '删除商品并保留历史订单快照'
  });
  await run(
    'INSERT INTO inventory_logs (productId, productName, operatorUsername, operatorRole, actionType, deltaStock, deltaSales, beforeStock, afterStock, beforeSales, afterSales, orderId, note, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      product.id,
      product.name,
      audit.operatorUsername,
      audit.operatorRole,
      audit.actionType,
      0,
      0,
      Number(product.stock || 0),
      Number(product.stock || 0),
      Number(product.sales || 0),
      Number(product.sales || 0),
      audit.orderId || '',
      audit.note,
      Date.now()
    ]
  );
  await run('DELETE FROM cart_items WHERE productId = ?', [id]);
  const result = await run('DELETE FROM products WHERE id = ?', [id]);
  if (!result.changes) return null;
  return {
    deleted: true,
    productId: id,
    productName: product.name || '',
    impact: impact || { productId: id, productName: product.name || '', totalOrders: 0, statusCounts: [] }
  };
}

async function seedProductsIfNeeded() {
  if (disableDefaultSampleData) return;
  const row = await get('SELECT COUNT(*) AS count FROM products');
  if (row && row.count > 0) return;
  const defaults = readDefaultProducts();
  for (const product of defaults) {
    await insertProduct(product);
  }
}

async function saveCouponTemplateList(list) {
  await run('DELETE FROM coupon_templates');
  for (let index = 0; index < list.length; index++) {
    const item = toDbCouponTemplate(list[index], index);
    await run(
      'INSERT INTO coupon_templates (id, templateId, name, type, discountRate, amount, minSpend) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [item.id || null, item.templateId, item.name, item.type, item.discountRate, item.amount, item.minSpend]
    );
  }
}

async function seedCouponTemplatesIfNeeded() {
  if (disableDefaultSampleData) return;
  const row = await get('SELECT COUNT(*) AS count FROM coupon_templates');
  if (row && row.count > 0) return;
  await saveCouponTemplateList(createDefaultCouponTemplates());
}

async function getCouponTemplateList() {
  await seedCouponTemplatesIfNeeded();
  const rows = await all('SELECT * FROM coupon_templates ORDER BY id ASC');
  return rows.map(hydrateCouponTemplate);
}

function hydrateSmsVerificationRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id || 0),
    phone: normalizePhoneNumber(row.phone),
    purpose: normalizeSmsPurpose(row.purpose),
    code: String(row.code || ''),
    username: String(row.username || '').trim(),
    createdAt: Number(row.createdAt || 0),
    expiresAt: Number(row.expiresAt || 0),
    resendAvailableAt: Number(row.resendAvailableAt || 0),
    consumedAt: Number(row.consumedAt || 0),
    invalidatedAt: Number(row.invalidatedAt || 0),
    requestIp: String(row.requestIp || ''),
    deliveryChannel: String(row.deliveryChannel || 'mock'),
    deliveryStatus: String(row.deliveryStatus || 'queued'),
    messageId: String(row.messageId || '')
  };
}

async function getUserByPhone(phone) {
  const normalized = normalizePhoneNumber(phone);
  if (!normalized) return null;
  const row = await get('SELECT * FROM users WHERE phone = ?', [normalized]);
  return row ? hydrateUserWithRelations(row) : null;
}

async function generatePhoneFirstUsername() {
  for (let index = 0; index < 10; index++) {
    const candidate = 'u_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1679616).toString(36).padStart(4, '0');
    if (!await getUserByUsername(candidate)) return candidate;
  }
  throw new Error('自动生成账号失败，请稍后再试');
}

async function createPhoneFirstUser(phone) {
  const normalizedPhone = normalizePhoneNumber(phone);
  if (!isValidChinaMainlandPhone(normalizedPhone)) throw new Error('请输入正确的手机号');
  const templates = await getCouponTemplateList();
  const username = await generatePhoneFirstUsername();
  await insertUser(normalizeUserRecord({
    username: username,
    password: '',
    nickname: '',
    phone: normalizedPhone,
    phoneVerifiedAt: Date.now(),
    roles: { isFarmer: false, isAdmin: false, isSuperAdmin: false, farmerName: username },
    addresses: [],
    coupons: templates.map(buildCouponFromTemplate),
    selectedAddressId: '',
    selectedCouponId: '',
    cart: [],
    orders: [],
    member: { levelId: 'normal', points: 0, totalSpent: 0 },
    createdAt: new Date().toLocaleDateString('zh-CN')
  }));
  return getUserByUsername(username);
}

async function getLatestSmsVerification(phone, purpose) {
  const normalizedPhone = normalizePhoneNumber(phone);
  if (!normalizedPhone) return null;
  const row = await get(
    'SELECT * FROM sms_verification_codes WHERE phone = ? AND purpose = ? ORDER BY id DESC LIMIT 1',
    [normalizedPhone, normalizeSmsPurpose(purpose)]
  );
  return hydrateSmsVerificationRow(row);
}

async function getCurrentActiveSmsVerification(phone, purpose) {
  const normalizedPhone = normalizePhoneNumber(phone);
  if (!normalizedPhone) return null;
  const row = await get(
    'SELECT * FROM sms_verification_codes WHERE phone = ? AND purpose = ? AND consumedAt = 0 AND invalidatedAt = 0 ORDER BY id DESC LIMIT 1',
    [normalizedPhone, normalizeSmsPurpose(purpose)]
  );
  return hydrateSmsVerificationRow(row);
}

async function countRecentSmsRequests(phone, purpose, windowStart) {
  const row = await get(
    'SELECT COUNT(*) AS count FROM sms_verification_codes WHERE phone = ? AND purpose = ? AND createdAt >= ?',
    [normalizePhoneNumber(phone), normalizeSmsPurpose(purpose), Number(windowStart || 0)]
  );
  return Number(row && row.count || 0);
}

async function cleanupExpiredSmsVerifications() {
  await run('DELETE FROM sms_verification_codes WHERE expiresAt > 0 AND expiresAt <= ?', [Date.now()]);
}

async function createSmsVerificationRecord(record) {
  const item = hydrateSmsVerificationRow(record || {});
  const result = await run(
    'INSERT INTO sms_verification_codes (phone, purpose, code, username, createdAt, expiresAt, resendAvailableAt, consumedAt, invalidatedAt, requestIp, deliveryChannel, deliveryStatus, messageId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [item.phone, item.purpose, item.code, item.username, item.createdAt, item.expiresAt, item.resendAvailableAt, item.consumedAt, item.invalidatedAt, item.requestIp, item.deliveryChannel, item.deliveryStatus, item.messageId]
  );
  return get('SELECT * FROM sms_verification_codes WHERE id = ?', [result.lastID]).then(hydrateSmsVerificationRow);
}

async function consumeSmsVerificationRecord(id) {
  const now = Date.now();
  await run('UPDATE sms_verification_codes SET consumedAt = ? WHERE id = ?', [now, Number(id || 0)]);
}

async function invalidateSmsVerificationRecords(phone, purpose, now) {
  await run(
    'UPDATE sms_verification_codes SET invalidatedAt = ? WHERE phone = ? AND purpose = ? AND consumedAt = 0 AND invalidatedAt = 0',
    [Number(now || Date.now()), normalizePhoneNumber(phone), normalizeSmsPurpose(purpose)]
  );
}

async function issueSmsVerificationCode(phone, purpose, options) {
  const normalizedPhone = normalizePhoneNumber(phone);
  const normalizedPurpose = normalizeSmsPurpose(purpose);
  const config = Object.assign({ username: '', requestIp: '' }, options || {});
  await cleanupExpiredSmsVerifications();
  if (!isValidChinaMainlandPhone(normalizedPhone)) {
    throw new Error('请输入正确的手机号');
  }
  const latest = await getLatestSmsVerification(normalizedPhone, normalizedPurpose);
  const now = Date.now();
  if (latest && Number(latest.resendAvailableAt || 0) > now) {
    const waitSeconds = Math.max(1, Math.ceil((Number(latest.resendAvailableAt || 0) - now) / 1000));
    throw new Error('验证码已发送，请在 ' + waitSeconds + ' 秒后重试');
  }
  const recentCount = await countRecentSmsRequests(normalizedPhone, normalizedPurpose, now - SMS_CODE_SHORT_WINDOW_MS);
  if (recentCount >= SMS_CODE_SHORT_LIMIT) {
    throw new Error('验证码发送过于频繁，请稍后再试');
  }
  const providerConfig = getAliyunSmsConfig(normalizedPurpose);
  const code = providerConfig.provider === 'aliyun' ? '' : generateSmsVerificationCode();
  const delivery = await sendAliyunSms(normalizedPhone, code, normalizedPurpose);
  const created = await withImmediateTransaction(async function () {
    await invalidateSmsVerificationRecords(normalizedPhone, normalizedPurpose, now);
    return createSmsVerificationRecord({
      phone: normalizedPhone,
      purpose: normalizedPurpose,
      code: String(delivery.debugCode || code || ''),
      username: config.username,
      createdAt: now,
      expiresAt: now + SMS_CODE_TTL_MS,
      resendAvailableAt: now + SMS_CODE_RESEND_MS,
      consumedAt: 0,
      invalidatedAt: 0,
      requestIp: config.requestIp,
      deliveryChannel: delivery.provider,
      deliveryStatus: delivery.deliveryStatus,
      messageId: delivery.messageId
    });
  });
  return {
    ok: true,
    phone: normalizedPhone,
    maskedPhone: maskPhoneNumber(normalizedPhone),
    purpose: normalizedPurpose,
    resendAfterSeconds: Math.ceil(SMS_CODE_RESEND_MS / 1000),
    expiresInSeconds: Math.ceil(SMS_CODE_TTL_MS / 1000),
    sentAt: created.createdAt,
    mock: delivery.provider !== 'aliyun',
    debugCode: shouldExposeSmsDebugCode(providerConfig) ? delivery.debugCode : undefined
  };
}

async function verifySmsCodeOrThrow(phone, purpose, code) {
  const normalizedPhone = normalizePhoneNumber(phone);
  const normalizedPurpose = normalizeSmsPurpose(purpose);
  const normalizedCode = String(code || '').trim();
  const config = getAliyunSmsConfig(normalizedPurpose);
  await cleanupExpiredSmsVerifications();
  if (!isValidChinaMainlandPhone(normalizedPhone)) throw new Error('请输入正确的手机号');
  if (!/^\d{6}$/.test(normalizedCode)) throw new Error('请输入 6 位验证码');
  const currentRecord = await getCurrentActiveSmsVerification(normalizedPhone, normalizedPurpose);
  if (!currentRecord) throw new Error('请先获取验证码');
  if (Number(currentRecord.expiresAt || 0) <= Date.now()) throw new Error('验证码已过期，请重新获取');
  if (config.provider === 'aliyun') {
    const verifyResult = await checkAliyunSmsVerification(normalizedPhone, normalizedCode, normalizedPurpose);
    if (!verifyResult.verified) throw new Error('验证码错误或已失效');
    return currentRecord;
  }
  if (String(currentRecord.code || '') !== normalizedCode) throw new Error('验证码错误或已失效');
  return currentRecord;
}

async function insertUser(record) {
  const user = toDbUser(record);
  const result = await run(
    'INSERT INTO users (username, password, nickname, phone, phoneVerifiedAt, roles, addresses, shippingAddresses, coupons, selectedAddressId, selectedCouponId, cart, orders, member, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [user.username, user.password, user.nickname, user.phone, user.phoneVerifiedAt, user.roles, user.addresses, user.shippingAddresses, user.coupons, user.selectedAddressId, user.selectedCouponId, user.cart, user.orders, user.member, user.createdAt]
  );
  await syncUserAddressRelations(user.username, JSON.parse(user.addresses), JSON.parse(user.shippingAddresses));
  await syncUserOrderRelations(user.username, JSON.parse(user.orders));
  await syncUserCartRelations(user.username, JSON.parse(user.cart));
  await syncUserCouponRelations(user.username, JSON.parse(user.coupons));
  return result.lastID;
}

async function updateUser(record) {
  const user = toDbUser(record);
  const result = await run(
    'UPDATE users SET password = ?, nickname = ?, phone = ?, phoneVerifiedAt = ?, roles = ?, addresses = ?, shippingAddresses = ?, coupons = ?, selectedAddressId = ?, selectedCouponId = ?, cart = ?, orders = ?, member = ?, createdAt = ? WHERE username = ?',
    [user.password, user.nickname, user.phone, user.phoneVerifiedAt, user.roles, user.addresses, user.shippingAddresses, user.coupons, user.selectedAddressId, user.selectedCouponId, user.cart, user.orders, user.member, user.createdAt, user.username]
  );
  await syncUserAddressRelations(user.username, JSON.parse(user.addresses), JSON.parse(user.shippingAddresses));
  await syncUserOrderRelations(user.username, JSON.parse(user.orders));
  await syncUserCartRelations(user.username, JSON.parse(user.cart));
  await syncUserCouponRelations(user.username, JSON.parse(user.coupons));
  return result.changes;
}

async function createSession(username) {
  const sessionId = generateToken(32);
  const now = Date.now();
  await run(
    'INSERT INTO sessions (id, username, createdAt, expiresAt, lastSeenAt) VALUES (?, ?, ?, ?, ?)',
    [sessionId, String(username || '').trim(), now, now + SESSION_TTL_MS, now]
  );
  return sessionId;
}

async function getSessionRecord(sessionId) {
  const normalized = String(sessionId || '').trim();
  if (!normalized) return null;
  const row = await get('SELECT * FROM sessions WHERE id = ?', [normalized]);
  if (!row) return null;
  if (Number(row.expiresAt || 0) <= Date.now()) {
    await run('DELETE FROM sessions WHERE id = ?', [normalized]);
    return null;
  }
  return {
    id: String(row.id || ''),
    username: String(row.username || '').trim(),
    createdAt: Number(row.createdAt || 0),
    expiresAt: Number(row.expiresAt || 0),
    lastSeenAt: Number(row.lastSeenAt || 0)
  };
}

async function touchSession(session) {
  const target = session || {};
  if (!target.id) return;
  const now = Date.now();
  const shouldRefresh = Number(target.expiresAt || 0) - now <= SESSION_REFRESH_MS;
  await run(
    'UPDATE sessions SET lastSeenAt = ?, expiresAt = ? WHERE id = ?',
    [now, shouldRefresh ? now + SESSION_TTL_MS : Number(target.expiresAt || now + SESSION_TTL_MS), target.id]
  );
}

async function deleteSession(sessionId) {
  if (!sessionId) return;
  await run('DELETE FROM sessions WHERE id = ?', [String(sessionId || '').trim()]);
}

async function deleteSessionsByUsername(username) {
  const target = String(username || '').trim();
  if (!target) return;
  await run('DELETE FROM sessions WHERE username = ?', [target]);
}

async function cleanupExpiredSessions() {
  await run('DELETE FROM sessions WHERE expiresAt <= ?', [Date.now()]);
}

async function backfillPasswordHashes() {
  const rows = await all('SELECT id, password FROM users');
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const password = String(row && row.password || '');
    if (!password || isPasswordHash(password)) continue;
    await run('UPDATE users SET password = ? WHERE id = ?', [hashPassword(password), row.id]);
  }
}

function buildBootstrapAdminPassword() {
  const configured = String(process.env.CS_ADMIN_BOOTSTRAP_PASSWORD || '').trim();
  if (configured) return configured;
  return 'boot-' + generateToken(8);
}

function getAccessLevel(user) {
  const roles = normalizeRoleFlags(user && user.username, user && user.roles);
  if (roles.isSuperAdmin) return 'superadmin';
  if (roles.isAdmin) return 'admin';
  if (roles.isFarmer) return 'farmer';
  if (user && user.username) return 'logged';
  return 'public';
}

function hasAccessLevel(user, level) {
  const access = getAccessLevel(user);
  if (level === 'public') return true;
  if (level === 'logged') return access !== 'public';
  if (level === 'farmer') return ['farmer', 'admin', 'superadmin'].indexOf(access) >= 0;
  if (level === 'admin') return ['admin', 'superadmin'].indexOf(access) >= 0;
  if (level === 'superadmin') return access === 'superadmin';
  return false;
}

function ensureAccess(level, message) {
  return function (req, res) {
    if (!hasAccessLevel(req.currentUser, level)) {
      res.status(403).json({ message: message || '当前账号无权执行该操作' });
      return false;
    }
    return true;
  };
}

function ensureLoggedIn(req, res, message) {
  if (!req.currentUser || !req.currentUser.username) {
    res.status(401).json({ message: message || '请先登录' });
    return false;
  }
  return true;
}

function canManageTargetUser(currentUser, targetUsername) {
  const target = String(targetUsername || '').trim();
  if (!target) return false;
  if (!currentUser || !currentUser.username) return false;
  if (currentUser.username === target) return true;
  return hasAccessLevel(currentUser, 'admin');
}

function canManageProduct(currentUser, product) {
  if (!currentUser || !currentUser.username) return false;
  if (hasAccessLevel(currentUser, 'admin')) return true;
  if (!hasAccessLevel(currentUser, 'farmer')) return false;
  const normalized = normalizeProduct(product || {});
  return String(normalized.farmerAccount || '').trim() === String(currentUser.username || '').trim();
}

async function applyOrderPaymentBenefits(ownerUsername, order) {
  const owner = String(ownerUsername || '').trim();
  if (!owner) return;
  const user = await getUserByUsername(owner);
  if (!user) return;
  const normalizedOrder = normalizeOrderRecord(order);
  user.member = Object.assign({ levelId: 'normal', points: 0, totalSpent: 0 }, user.member || {}, {
    totalSpent: Number(user.member && user.member.totalSpent || 0) + Number(normalizedOrder.subtotal || 0)
  });
  if (normalizedOrder.couponId) {
    user.coupons = (Array.isArray(user.coupons) ? user.coupons : []).map(function (item, index) {
      const coupon = normalizeUserCoupon(item, index);
      return coupon.id === normalizedOrder.couponId ? Object.assign({}, coupon, { used: true }) : coupon;
    });
  }
  user.selectedCouponId = '';
  user.cart = [];
  await syncUserCartRelations(owner, []);
  await syncUserCouponRelations(owner, user.coupons || []);
  await updateUser(user);
}

async function finalizePendingOrderPayment(ownerUsername, sourceOrderId, options) {
  const owner = String(ownerUsername || '').trim();
  const orderId = String(sourceOrderId || '').trim();
  if (!owner || !orderId) throw new Error('待支付订单参数不完整');
  const paymentMeta = Object.assign({
    channel: 'mock_h5',
    gatewayTradeNo: '',
    gatewayBuyerId: '',
    notifyStatus: '',
    notifyPayload: '',
    notifyAt: 0
  }, options || {});
  await cleanupExpiredPendingOrders(Date.now());
  return withImmediateTransaction(async function () {
    const relationOrderId = buildOrderRelationId(owner, orderId);
    const order = await getOrderSnapshotByRelationId(relationOrderId);
    if (!order) throw new Error('订单不存在');
    const now = Date.now();
    if (order.status !== 'pending' || order.inventoryReleased) {
      throw new Error('订单已超时取消，不能继续支付');
    }
    if (Number(order.reserveExpiresAt || 0) > 0 && Number(order.reserveExpiresAt || 0) <= now) {
      throw new Error('订单已超时取消，不能继续支付');
    }
    for (let index = 0; index < order.items.length; index++) {
      const item = normalizeOrderItem(order.items[index], index);
      const productRow = await get('SELECT * FROM products WHERE id = ?', [item.productId]);
      if (!productRow) throw new Error(item.name + ' 已不存在，无法完成支付');
      const product = hydrateProduct(productRow);
      await saveProductMutationWithAudit(product, Object.assign({}, product, {
        sales: Number(product.sales || 0) + Number(item.qty || 0)
      }), {
        actionType: 'order_sale',
        operatorUsername: owner,
        operatorRole: 'buyer',
        orderId: order.id,
        note: '待支付订单支付完成后确认销量'
      }, now);
    }
    await run('UPDATE orders SET status = ?, cancelReason = ? WHERE id = ?', ['paid', '', relationOrderId]);
    await updatePaymentTransactionAlipayState(buildPaymentTransactionId(owner, orderId), {
      status: 'paid',
      channel: paymentMeta.channel || 'mock_h5',
      gatewayTradeNo: String(paymentMeta.gatewayTradeNo || ''),
      gatewayBuyerId: String(paymentMeta.gatewayBuyerId || ''),
      notifyStatus: String(paymentMeta.notifyStatus || ''),
      notifyPayload: paymentMeta.notifyPayload ? JSON.stringify(paymentMeta.notifyPayload) : '',
      notifyAt: paymentMeta.notifyAt ? Number(paymentMeta.notifyAt) : '',
      paidAt: now,
      lastError: ''
    });
    const savedOrder = await getOrderSnapshotByRelationId(relationOrderId);
    await applyOrderPaymentBenefits(owner, savedOrder);
    return savedOrder;
  });
}

async function cancelPendingOrder(ownerUsername, sourceOrderId) {
  const owner = String(ownerUsername || '').trim();
  const orderId = String(sourceOrderId || '').trim();
  if (!owner || !orderId) throw new Error('待支付订单参数不完整');
  await cleanupExpiredPendingOrders(Date.now());
  return withImmediateTransaction(async function () {
    const relationOrderId = buildOrderRelationId(owner, orderId);
    const order = await getOrderSnapshotByRelationId(relationOrderId);
    if (!order) throw new Error('订单不存在');
    if (order.status !== 'pending' || order.inventoryReleased) {
      throw new Error('当前订单不能重复取消');
    }
    return releaseReservedInventoryForOrder(order, 'buyer_pending_cancel', {
      operatorUsername: owner,
      operatorRole: 'buyer'
    });
  });
}

async function createAlipayWapLaunch(ownerUsername, sourceOrderId, req) {
  const owner = String(ownerUsername || '').trim();
  const orderId = String(sourceOrderId || '').trim();
  if (!owner || !orderId) throw new Error('支付发起参数不完整');
  await cleanupExpiredPendingOrders(Date.now());
  const relationOrderId = buildOrderRelationId(owner, orderId);
  const order = await getOrderSnapshotByRelationId(relationOrderId);
  if (!order) throw new Error('订单不存在');
  if (order.status !== 'pending' || order.inventoryReleased || isPendingOrderExpired(order)) {
    throw new Error('当前订单已超时或已取消，不能继续发起支付');
  }
  const config = getAlipayConfig(req);
  assertAlipayReady(config);
  const transactionId = buildPaymentTransactionId(owner, orderId);
  const externalTradeNo = buildAlipayOutTradeNo(owner, orderId);
  await updatePaymentTransactionAlipayState(transactionId, {
    status: 'pending',
    channel: 'alipay_wap',
    externalTradeNo: externalTradeNo,
    initiatedAt: Date.now(),
    lastError: ''
  });
  const paymentTransaction = await getPaymentTransactionByOwnerAndOrder(owner, orderId);
  return Object.assign({
    orderId: orderId,
    channel: 'alipay_wap',
    recommendedChannel: 'alipay_wap',
    availableChannels: getPaymentChannelRuntimeMeta(req, { preferredChannel: 'alipay_wap' }).availableChannels
  }, buildAlipayWapRequest(order, paymentTransaction, config), {
    paymentTransaction: paymentTransaction
  });
}

async function createWechatPaymentLaunch(ownerUsername, sourceOrderId, req, channel) {
  const owner = String(ownerUsername || '').trim();
  const orderId = String(sourceOrderId || '').trim();
  const targetChannel = channel === 'wechat_h5_inapp' ? 'wechat_h5_inapp' : 'wechat_h5_external';
  if (!owner || !orderId) throw new Error('支付发起参数不完整');
  await cleanupExpiredPendingOrders(Date.now());
  const relationOrderId = buildOrderRelationId(owner, orderId);
  const order = await getOrderSnapshotByRelationId(relationOrderId);
  if (!order) throw new Error('订单不存在');
  if (order.status !== 'pending' || order.inventoryReleased || isPendingOrderExpired(order)) {
    throw new Error('当前订单已超时或已取消，不能继续发起支付');
  }
  const config = getWechatPayConfig(req);
  assertWechatPayReady(config, targetChannel);
  const transactionId = buildPaymentTransactionId(owner, orderId);
  const externalTradeNo = buildAlipayOutTradeNo(owner, orderId);
  await updatePaymentTransactionState(transactionId, {
    status: 'pending',
    channel: targetChannel,
    externalTradeNo: externalTradeNo,
    initiatedAt: Date.now(),
    lastError: ''
  });
  const paymentTransaction = await getPaymentTransactionByOwnerAndOrder(owner, orderId);
  return Object.assign({
    orderId: orderId,
    channel: targetChannel,
    recommendedChannel: targetChannel,
    availableChannels: getPaymentChannelRuntimeMeta(req, { preferredChannel: targetChannel }).availableChannels
  }, buildWechatLaunchRequest(order, paymentTransaction, config, targetChannel, req), {
    paymentTransaction: paymentTransaction
  });
}

async function getBuyerPaymentStatus(ownerUsername, sourceOrderId, options, req) {
  const owner = String(ownerUsername || '').trim();
  const orderId = String(sourceOrderId || '').trim();
  if (!owner || !orderId) throw new Error('支付状态查询参数不完整');
  await cleanupExpiredPendingOrders(Date.now());
  const relationOrderId = buildOrderRelationId(owner, orderId);
  const order = await getOrderSnapshotByRelationId(relationOrderId);
  if (!order) throw new Error('订单不存在');
  const paymentTransaction = await getPaymentTransactionByOwnerAndOrder(owner, orderId);
  if (options && options.markReturnChecked && paymentTransaction) {
    await updatePaymentTransactionAlipayState(buildPaymentTransactionId(owner, orderId), {
      returnCheckedAt: Date.now()
    });
  }
  const latestTransaction = await getPaymentTransactionByOwnerAndOrder(owner, orderId);
  const runtimeMeta = getPaymentChannelRuntimeMeta(req, {
    preferredChannel: latestTransaction && latestTransaction.channel ? latestTransaction.channel : ''
  });
  return {
    order: Object.assign({}, order, runtimeMeta),
    paymentTransaction: latestTransaction,
    awaitingAsyncNotify: order.status === 'pending'
      && !order.inventoryReleased
      && latestTransaction
      && ['alipay_wap', 'wechat_h5_inapp', 'wechat_h5_external'].indexOf(latestTransaction.channel) >= 0
      && latestTransaction.status === 'pending',
    isFinal: order.status !== 'pending' || !!order.inventoryReleased,
    availableChannels: runtimeMeta.availableChannels,
    recommendedChannel: runtimeMeta.recommendedChannel,
    wechatBrowser: runtimeMeta.wechatBrowser
  };
}

async function handleAlipayNotification(payload) {
  const notifyPayload = Object.assign({}, payload || {});
  const config = getAlipayConfig();
  if (!config.publicKey) {
    return { ok: false, shouldAcknowledge: false, message: '支付宝公钥未配置' };
  }
  if (!verifyAlipaySignature(notifyPayload, config.publicKey)) {
    return { ok: false, shouldAcknowledge: false, message: '支付宝异步通知验签失败' };
  }
  const context = await resolvePaymentNotificationContext(notifyPayload.out_trade_no);
  if (!context) {
    return { ok: false, shouldAcknowledge: false, message: '支付宝订单号无法识别' };
  }
  const owner = context.owner;
  const orderId = context.orderId;
  const relationOrderId = context.relationOrderId;
  const order = context.order;
  const transactionId = context.transactionId;
  const paymentTransaction = context.paymentTransaction;
  if (!order || !paymentTransaction) {
    return { ok: false, shouldAcknowledge: false, message: '本地订单或支付流水不存在' };
  }
  const notifyAt = Date.now();
  const tradeStatus = String(notifyPayload.trade_status || '').trim();
  const gatewayTradeNo = String(notifyPayload.trade_no || '').trim();
  const gatewayBuyerId = String(notifyPayload.buyer_id || '').trim();
  const totalAmount = formatCurrencyAmount(order.total);
  if (String(notifyPayload.app_id || '').trim() && config.appId && String(notifyPayload.app_id || '').trim() !== config.appId) {
    await updatePaymentTransactionAlipayState(transactionId, {
      notifyStatus: 'invalid_app_id',
      notifyPayload: JSON.stringify(notifyPayload),
      notifyAt: notifyAt,
      gatewayTradeNo: gatewayTradeNo,
      gatewayBuyerId: gatewayBuyerId,
      lastError: '支付宝应用 ID 不匹配'
    });
    return { ok: false, shouldAcknowledge: false, message: '支付宝应用 ID 不匹配' };
  }
  if (String(notifyPayload.total_amount || '').trim() && String(notifyPayload.total_amount || '').trim() !== totalAmount) {
    await updatePaymentTransactionAlipayState(transactionId, {
      notifyStatus: 'invalid_total_amount',
      notifyPayload: JSON.stringify(notifyPayload),
      notifyAt: notifyAt,
      gatewayTradeNo: gatewayTradeNo,
      gatewayBuyerId: gatewayBuyerId,
      lastError: '支付宝金额校验失败'
    });
    return { ok: false, shouldAcknowledge: false, message: '支付宝金额校验失败' };
  }
  if (paymentTransaction.status === 'paid' || order.status === 'paid') {
    await updatePaymentTransactionAlipayState(transactionId, {
      notifyStatus: tradeStatus || paymentTransaction.notifyStatus || 'TRADE_SUCCESS',
      notifyPayload: JSON.stringify(notifyPayload),
      notifyAt: notifyAt,
      channel: 'alipay_wap',
      gatewayTradeNo: gatewayTradeNo,
      gatewayBuyerId: gatewayBuyerId,
      lastError: ''
    });
    return { ok: true, shouldAcknowledge: true, order: await getOrderSnapshotByRelationId(relationOrderId) };
  }
  if (['TRADE_SUCCESS', 'TRADE_FINISHED'].indexOf(tradeStatus) < 0) {
    await updatePaymentTransactionAlipayState(transactionId, {
      notifyStatus: tradeStatus || 'ignored_non_success',
      notifyPayload: JSON.stringify(notifyPayload),
      notifyAt: notifyAt,
      channel: 'alipay_wap',
      gatewayTradeNo: gatewayTradeNo,
      gatewayBuyerId: gatewayBuyerId,
      lastError: ''
    });
    return { ok: true, shouldAcknowledge: true, order: order };
  }
  if (order.inventoryReleased || order.status !== 'pending' || isPendingOrderExpired(order)) {
    await updatePaymentTransactionAlipayState(transactionId, {
      notifyStatus: 'ignored_terminal_state',
      notifyPayload: JSON.stringify(notifyPayload),
      notifyAt: notifyAt,
      channel: 'alipay_wap',
      gatewayTradeNo: gatewayTradeNo,
      gatewayBuyerId: gatewayBuyerId,
      lastError: '订单已取消或超时，异步通知未再转 paid'
    });
    return { ok: true, shouldAcknowledge: true, order: order };
  }
  const paidOrder = await finalizePendingOrderPayment(owner, orderId, {
    channel: 'alipay_wap',
    gatewayTradeNo: gatewayTradeNo,
    gatewayBuyerId: gatewayBuyerId,
    notifyStatus: tradeStatus,
    notifyPayload: notifyPayload,
    notifyAt: notifyAt
  });
  return { ok: true, shouldAcknowledge: true, order: paidOrder };
}

async function handleWechatNotification(payload) {
  const notifyPayload = Object.assign({}, payload || {});
  const transaction = notifyPayload.transaction && typeof notifyPayload.transaction === 'object'
    ? notifyPayload.transaction
    : notifyPayload;
  const outTradeNo = String(transaction.out_trade_no || notifyPayload.out_trade_no || '').trim();
  const context = await resolvePaymentNotificationContext(outTradeNo);
  if (!context) {
    return { ok: false, shouldAcknowledge: false, message: '微信支付订单号无法识别' };
  }
  const owner = context.owner;
  const orderId = context.orderId;
  const relationOrderId = context.relationOrderId;
  const order = context.order;
  const transactionId = context.transactionId;
  const paymentTransaction = context.paymentTransaction;
  if (!order || !paymentTransaction) {
    return { ok: false, shouldAcknowledge: false, message: '本地订单或支付流水不存在' };
  }
  const notifyAt = Date.now();
  const tradeState = String(transaction.trade_state || notifyPayload.trade_state || '').trim();
  const gatewayTradeNo = String(transaction.transaction_id || notifyPayload.transaction_id || '').trim();
  const gatewayBuyerId = String(transaction.payer && transaction.payer.openid || notifyPayload.openid || '').trim();
  const amountTotalFen = Number(transaction.amount && transaction.amount.total || notifyPayload.amountTotal || 0);
  const expectedTotalFen = Math.round(Number(order.total || 0) * 100);
  const wechatChannel = paymentTransaction.channel === 'wechat_h5_inapp'
    ? 'wechat_h5_inapp'
    : (paymentTransaction.channel === 'wechat_h5_external' ? 'wechat_h5_external' : (String(transaction.trade_type || '').trim() === 'JSAPI' ? 'wechat_h5_inapp' : 'wechat_h5_external'));
  if (amountTotalFen > 0 && amountTotalFen !== expectedTotalFen) {
    await updatePaymentTransactionState(transactionId, {
      notifyStatus: 'invalid_total_amount',
      notifyPayload: JSON.stringify(notifyPayload),
      notifyAt: notifyAt,
      channel: wechatChannel,
      gatewayTradeNo: gatewayTradeNo,
      gatewayBuyerId: gatewayBuyerId,
      lastError: '微信支付金额校验失败'
    });
    return { ok: false, shouldAcknowledge: false, message: '微信支付金额校验失败' };
  }
  if (paymentTransaction.status === 'paid' || order.status === 'paid') {
    await updatePaymentTransactionState(transactionId, {
      notifyStatus: tradeState || paymentTransaction.notifyStatus || 'SUCCESS',
      notifyPayload: JSON.stringify(notifyPayload),
      notifyAt: notifyAt,
      channel: wechatChannel,
      gatewayTradeNo: gatewayTradeNo,
      gatewayBuyerId: gatewayBuyerId,
      lastError: ''
    });
    return { ok: true, shouldAcknowledge: true, order: await getOrderSnapshotByRelationId(relationOrderId) };
  }
  if (tradeState !== 'SUCCESS') {
    await updatePaymentTransactionState(transactionId, {
      notifyStatus: tradeState || 'ignored_non_success',
      notifyPayload: JSON.stringify(notifyPayload),
      notifyAt: notifyAt,
      channel: wechatChannel,
      gatewayTradeNo: gatewayTradeNo,
      gatewayBuyerId: gatewayBuyerId,
      lastError: ''
    });
    return { ok: true, shouldAcknowledge: true, order: order };
  }
  if (order.inventoryReleased || order.status !== 'pending' || isPendingOrderExpired(order)) {
    await updatePaymentTransactionState(transactionId, {
      notifyStatus: 'ignored_terminal_state',
      notifyPayload: JSON.stringify(notifyPayload),
      notifyAt: notifyAt,
      channel: wechatChannel,
      gatewayTradeNo: gatewayTradeNo,
      gatewayBuyerId: gatewayBuyerId,
      lastError: '订单已取消或超时，异步通知未再转 paid'
    });
    return { ok: true, shouldAcknowledge: true, order: order };
  }
  const paidOrder = await finalizePendingOrderPayment(owner, orderId, {
    channel: wechatChannel,
    gatewayTradeNo: gatewayTradeNo,
    gatewayBuyerId: gatewayBuyerId,
    notifyStatus: tradeState,
    notifyPayload: notifyPayload,
    notifyAt: notifyAt
  });
  return { ok: true, shouldAcknowledge: true, order: paidOrder };
}

async function applyOrderSnapshotStatus(username, sourceOrderId, status, trackingNo, options) {
  const owner = String(username || '').trim();
  const orderId = String(sourceOrderId || '').trim();
  if (!owner || !orderId) return null;
  const relationOrderId = owner + ':' + orderId;
  const existingRow = await get('SELECT * FROM orders WHERE id = ?', [relationOrderId]);
  if (!existingRow) return null;
  const existingItemRows = await all('SELECT * FROM order_items WHERE orderId = ? ORDER BY sortOrder ASC, id ASC', [relationOrderId]);
  const previousSnapshot = hydrateOrderRows(existingRow, existingItemRows);
  const existingUser = await getUserByUsername(owner);
  const previousOrders = existingUser && Array.isArray(existingUser.orders) ? existingUser.orders.slice() : [previousSnapshot];
  const nextStatus = String(status || existingRow.status || '').trim() || existingRow.status;
  const nextTrackingNo = nextStatus === 'shipped'
    ? String(trackingNo || '').trim()
    : String(existingRow.trackingNo || '').trim();
  const audit = normalizeAuditMeta(options && options.auditMeta, {
    operatorUsername: owner,
    operatorRole: 'system',
    actionType: nextStatus === 'cancelled' ? 'cancel' : 'order_status_update',
    orderId: orderId,
    note: '通过订单快照接口更新订单状态为 ' + nextStatus
  });
  await run('UPDATE orders SET status = ?, trackingNo = ? WHERE id = ?', [nextStatus, nextTrackingNo, relationOrderId]);
  let nextOrders = [Object.assign({}, previousSnapshot, { status: nextStatus, trackingNo: nextTrackingNo })];
  if (existingUser) {
    existingUser.orders = (existingUser.orders || []).map(function (item) {
      if (String(item && item.id || '') !== orderId) return item;
      return Object.assign({}, normalizeOrderRecord(item), {
        status: nextStatus,
        trackingNo: nextTrackingNo
      });
    });
    nextOrders = existingUser.orders;
    await syncOrderDerivedRelations(owner, previousOrders, nextOrders, audit);
    await updateUser(existingUser);
  } else {
    await syncOrderDerivedRelations(owner, [previousSnapshot], nextOrders, audit);
  }
  const row = await get('SELECT * FROM orders WHERE id = ?', [relationOrderId]);
  const itemRows = await all('SELECT * FROM order_items WHERE orderId = ? ORDER BY sortOrder ASC, id ASC', [relationOrderId]);
  return hydrateOrderRows(row, itemRows);
}

async function requireAdminRefundActor(actorUsername) {
  const actor = await getUserByUsername(String(actorUsername || '').trim());
  const role = actor ? normalizeRoleFlags(actor.username, actor.roles) : null;
  if (!role || (!role.isAdmin && !role.isSuperAdmin)) {
    throw new Error('当前账号没有退款处理权限');
  }
  return actor;
}

async function createRefundRequestForOrder(ownerUsername, sourceOrderId, reason) {
  const owner = String(ownerUsername || '').trim();
  const orderId = String(sourceOrderId || '').trim();
  const refundReason = String(reason || '').trim();
  if (!owner || !orderId) throw new Error('退款申请参数不完整');
  if (!refundReason) throw new Error('请先填写退款原因');
  const relationOrderId = owner + ':' + orderId;
  const existingRow = await get('SELECT * FROM orders WHERE id = ?', [relationOrderId]);
  if (!existingRow) throw new Error('订单不存在');
  const existingItemRows = await all('SELECT * FROM order_items WHERE orderId = ? ORDER BY sortOrder ASC, id ASC', [relationOrderId]);
  const order = hydrateOrderRows(existingRow, existingItemRows);
  if (['paid', 'shipped'].indexOf(order.status) < 0) {
    throw new Error('当前订单状态不支持申请退款');
  }
  const activeRefund = await getActiveRefundRequestByOrder(owner, orderId);
  if (activeRefund) throw new Error('该订单已有待处理退款申请');
  const refundId = 'refund_' + orderId + '_' + Date.now();
  const now = Date.now();
  await insertRefundRequest({
    id: refundId,
    orderId: orderId,
    ownerUsername: owner,
    scopeType: 'order',
    itemsSnapshot: order.items || [],
    sourceOrderStatus: order.status,
    status: 'pending',
    refundAmount: Number(order.total || 0),
    reason: refundReason,
    assigneeRole: 'admin',
    assigneeUsername: '',
    inventoryRestored: false,
    paymentRefunded: false,
    rejectReason: '',
    requestedAt: now,
    reviewedAt: 0,
    completedAt: 0,
    updatedAt: now
  });
  await applyOrderSnapshotStatus(owner, orderId, 'refund_pending', order.trackingNo || '', {
    auditMeta: {
      operatorUsername: owner,
      operatorRole: 'buyer',
      actionType: 'refund_request',
      orderId: orderId,
      note: '买家提交退款申请'
    }
  });
  return getRefundRequestById(refundId);
}

async function rejectRefundRequest(refundId, actorUsername, rejectReason) {
  const actor = await requireAdminRefundActor(actorUsername);
  const refund = await getRefundRequestById(refundId);
  if (!refund) throw new Error('退款申请不存在');
  if (refund.status !== 'pending') throw new Error('当前退款申请不可驳回');
  await applyOrderSnapshotStatus(refund.ownerUsername, refund.orderId, refund.sourceOrderStatus, '', {
    auditMeta: {
      operatorUsername: actor.username,
      operatorRole: 'admin',
      actionType: 'refund_reject',
      orderId: refund.orderId,
      note: '管理员驳回退款申请'
    }
  });
  return updateRefundRequest(Object.assign({}, refund, {
    status: 'rejected',
    assigneeUsername: actor.username,
    rejectReason: String(rejectReason || '').trim(),
    reviewedAt: Date.now(),
    updatedAt: Date.now()
  }));
}

async function executeMockRefund(refund, actorUsername) {
  return {
    success: true,
    processedAt: Date.now(),
    actorUsername: actorUsername,
    refundId: refund.id
  };
}

async function executeAlipayRefund(refund, actorUsername, config) {
  const normalizedRefund = normalizeRefundRequest(refund);
  const paymentTransaction = await getPaymentTransactionByOwnerAndOrder(normalizedRefund.ownerUsername, normalizedRefund.orderId);
  if (!paymentTransaction) {
    throw new Error('支付宝退款失败：缺少支付流水');
  }
  assertAlipayReady(config);
  const bizContent = {
    refund_amount: formatCurrencyAmount(normalizedRefund.refundAmount),
    out_request_no: normalizedRefund.id || ('refund_' + Date.now())
  };
  if (paymentTransaction.gatewayTradeNo) bizContent.trade_no = paymentTransaction.gatewayTradeNo;
  else if (paymentTransaction.externalTradeNo) bizContent.out_trade_no = paymentTransaction.externalTradeNo;
  if (!bizContent.trade_no && !bizContent.out_trade_no) {
    throw new Error('支付宝退款失败：缺少支付宝交易号或商户订单号');
  }
  if (normalizedRefund.reason) bizContent.refund_reason = String(normalizedRefund.reason).slice(0, 256);
  try {
    const gatewayResult = await callAlipayGateway(ALIPAY_REFUND_METHOD, bizContent, config);
    await updatePaymentTransactionAlipayState(paymentTransaction.id, {
      lastError: ''
    });
    return {
      success: true,
      processedAt: Date.now(),
      actorUsername: actorUsername,
      refundId: normalizedRefund.id,
      gateway: 'alipay',
      gatewayTradeNo: String(gatewayResult.response.trade_no || paymentTransaction.gatewayTradeNo || ''),
      externalTradeNo: String(gatewayResult.response.out_trade_no || paymentTransaction.externalTradeNo || ''),
      response: gatewayResult.response
    };
  } catch (error) {
    await updatePaymentTransactionAlipayState(paymentTransaction.id, {
      lastError: '支付宝退款失败：' + String(error && error.message ? error.message : error)
    });
    throw error;
  }
}

async function executeRefund(refund, actorUsername) {
  const normalizedRefund = normalizeRefundRequest(refund);
  const paymentTransaction = await getPaymentTransactionByOwnerAndOrder(normalizedRefund.ownerUsername, normalizedRefund.orderId);
  const channel = String(paymentTransaction && paymentTransaction.channel || '').trim();
  if (channel === 'alipay_wap') {
    const config = getAlipayConfig();
    const hasRealConfig = config.enabled && config.appId && config.privateKey && config.publicKey;
    if (!hasRealConfig && isLocalMockPaymentEnabled()) {
      return executeMockRefund(normalizedRefund, actorUsername);
    }
    return executeAlipayRefund(normalizedRefund, actorUsername, config);
  }
  if (channel.indexOf('wechat_') === 0) {
    if (isLocalMockPaymentEnabled()) {
      return executeMockRefund(normalizedRefund, actorUsername);
    }
    throw new Error('当前订单为微信支付，退款接口尚未接入，不能直接标记为已退款');
  }
  return executeMockRefund(normalizedRefund, actorUsername);
}

async function restoreInventoryByRefund(refund, actorUsername) {
  const items = Array.isArray(refund && refund.itemsSnapshot) ? refund.itemsSnapshot : [];
  for (let index = 0; index < items.length; index++) {
    const item = normalizeOrderItem(items[index], index);
    const row = await get('SELECT * FROM products WHERE id = ?', [item.productId]);
    // 商品被删除后，退款流程继续完成；库存恢复直接跳过，不阻塞退款主链路。
    if (!row) continue;
    const product = hydrateProduct(row);
    const inventoryMutation = applyVariantUnitInventoryDelta(product, item, Number(item.qty || 0), {
      allowCreateVariant: true,
      allowCreateUnit: true
    });
    await updateProduct(Object.assign({}, product, {
      variants: inventoryMutation.variants,
      sales: Math.max(0, Number(product.sales || 0) - Number(item.qty || 0)),
      _audit: {
        operatorUsername: actorUsername,
        operatorRole: 'admin',
        actionType: 'refund_restore',
        orderId: refund.orderId,
        note: '退款完成后恢复库存与销量'
      }
    }));
  }
}

async function completeRefundRequest(refundId, actorUsername) {
  const actor = await requireAdminRefundActor(actorUsername);
  const refund = await getRefundRequestById(refundId);
  if (!refund) throw new Error('退款申请不存在');
  if (refund.status !== 'pending') throw new Error('当前退款申请不可完成');
  const relationOrderId = refund.ownerUsername + ':' + refund.orderId;
  const orderRow = await get('SELECT * FROM orders WHERE id = ?', [relationOrderId]);
  if (!orderRow) throw new Error('原订单不存在');
  if (String(orderRow.status || '') === 'refunded') throw new Error('该订单已退款完成');
  if (!refund.paymentRefunded) {
    const refundResult = await executeRefund(refund, actor.username);
    if (!refundResult || !refundResult.success) throw new Error('退款执行失败');
  }
  if (!refund.inventoryRestored) {
    await restoreInventoryByRefund(refund, actor.username);
  }
  await applyOrderSnapshotStatus(refund.ownerUsername, refund.orderId, 'refunded', '', {
    auditMeta: {
      operatorUsername: actor.username,
      operatorRole: 'admin',
      actionType: 'refund_complete',
      orderId: refund.orderId,
      note: '管理员确认退款完成'
    }
  });
  return updateRefundRequest(Object.assign({}, refund, {
    status: 'completed',
    assigneeUsername: actor.username,
    inventoryRestored: true,
    paymentRefunded: true,
    reviewedAt: Date.now(),
    completedAt: Date.now(),
    updatedAt: Date.now()
  }));
}

async function updateOrderSnapshotStatus(username, sourceOrderId, status, trackingNo) {
  const owner = String(username || '').trim();
  const orderId = String(sourceOrderId || '').trim();
  if (!owner || !orderId) return null;
  const relationOrderId = owner + ':' + orderId;
  const existingRow = await get('SELECT * FROM orders WHERE id = ?', [relationOrderId]);
  if (!existingRow) return null;
  const currentStatus = String(existingRow.status || '').trim();
  const nextStatus = String(status || currentStatus || '').trim() || currentStatus;
  if (['refund_pending', 'refunded'].indexOf(nextStatus) >= 0) {
    throw new Error('退款状态请通过退款专用接口处理');
  }
  if (['refund_pending', 'refunded', 'done', 'cancelled'].indexOf(currentStatus) >= 0 && nextStatus !== currentStatus) {
    throw new Error('当前订单状态不可逆向修改');
  }
  return applyOrderSnapshotStatus(owner, orderId, nextStatus, trackingNo, null);
}

async function deleteUserAccount(username) {
  const owner = String(username || '').trim();
  if (!owner) return { deleted: false, preservedOrders: 0, removedProducts: 0 };
  if (owner === 'admin') throw new Error('系统管理员账号不能删除');
  const existing = await getUserByUsername(owner);
  if (!existing) return { deleted: false, preservedOrders: 0, removedProducts: 0 };
  const relatedProducts = await all(
    'SELECT id FROM products WHERE farmerAccount = ? OR farmerUserId = ?',
    [owner, Number(existing.id || 0)]
  );
  const preservedOrderRow = await get('SELECT COUNT(*) AS count FROM orders WHERE username = ?', [owner]);
  await run('UPDATE orders SET ownerDeleted = 1 WHERE username = ?', [owner]);
  await run('DELETE FROM user_addresses WHERE username = ?', [owner]);
  await run('DELETE FROM cart_items WHERE username = ?', [owner]);
  await run('DELETE FROM user_coupons WHERE username = ?', [owner]);
  if (relatedProducts.length) {
    const placeholders = relatedProducts.map(function () { return '?'; }).join(', ');
    const productIds = relatedProducts.map(function (item) { return item.id; });
    await run('DELETE FROM inventory_logs WHERE productId IN (' + placeholders + ')', productIds);
  }
  await run('DELETE FROM products WHERE farmerAccount = ? OR farmerUserId = ?', [owner, Number(existing.id || 0)]);
  await deleteSessionsByUsername(owner);
  await run('DELETE FROM users WHERE username = ?', [owner]);
  return {
    deleted: true,
    preservedOrders: Number(preservedOrderRow && preservedOrderRow.count || 0),
    removedProducts: relatedProducts.length
  };
}

async function getUserByUsername(username) {
  const row = await get('SELECT * FROM users WHERE username = ?', [username]);
  return row ? hydrateUserWithRelations(row) : null;
}

async function listUsers() {
  const rows = await all('SELECT * FROM users ORDER BY id ASC');
  const users = [];
  for (const row of rows) {
    users.push(await hydrateUserWithRelations(row));
  }
  return users;
}

async function seedAdminIfNeeded() {
  const admin = await getUserByUsername('admin');
  if (admin) {
    const normalizedAdmin = normalizeUserRecord(Object.assign({}, admin, {
      roles: normalizeRoleFlags('admin', admin.roles)
    }));
    if (normalizedAdmin.password && !isPasswordHash(normalizedAdmin.password)) {
      normalizedAdmin.password = hashPassword(normalizedAdmin.password);
    }
    await updateUser(normalizedAdmin);
    return;
  }
  const bootstrapPassword = buildBootstrapAdminPassword();
  await insertUser(normalizeUserRecord({
    username: 'admin',
    password: hashPassword(bootstrapPassword),
    roles: { isFarmer: true, isAdmin: true, isSuperAdmin: true, farmerName: '系统管理员' },
    addresses: [],
    coupons: [],
    cart: [],
    orders: [],
    member: { levelId: 'normal', points: 0, totalSpent: 680 },
    createdAt: new Date().toLocaleDateString('zh-CN')
  }));
  console.warn('[security] 未发现 admin 账号，已创建一次性引导密码，请尽快登录后修改：' + bootstrapPassword);
}

async function saveBannerList(list) {
  await run('DELETE FROM banners');
  for (let index = 0; index < list.length; index++) {
    const item = toDbBanner(list[index], index);
    await run(
      'INSERT INTO banners (id, title, sub, img, linkType, externalUrl, productId, sortOrder) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [item.id || null, item.title, item.sub, item.img, item.linkType, item.externalUrl, item.productId, index]
    );
  }
}

async function seedBannersIfNeeded() {
  if (disableDefaultSampleData) return;
  const row = await get('SELECT COUNT(*) AS count FROM banners');
  if (row && row.count > 0) return;
  await saveBannerList(readDefaultBanners());
}

async function saveCategoryList(list) {
  await run('DELETE FROM categories');
  for (let index = 0; index < list.length; index++) {
    const item = toDbCategory(list[index], index);
    await run(
      'INSERT INTO categories (id, name, icon, sortOrder, showOnHome) VALUES (?, ?, ?, ?, ?)',
      [item.id, item.name, item.icon, index, item.showOnHome]
    );
  }
}

async function seedCategoriesIfNeeded() {
  const row = await get('SELECT COUNT(*) AS count FROM categories');
  if (row && row.count > 0) return;
  await saveCategoryList(readDefaultCategories());
}

async function getCategoryList() {
  await seedCategoriesIfNeeded();
  const rows = await all('SELECT * FROM categories ORDER BY sortOrder ASC, id ASC');
  return rows.map(hydrateCategory);
}

async function saveAnnouncementList(list) {
  await run('DELETE FROM announcements');
  for (let index = 0; index < list.length; index++) {
    const item = toDbAnnouncement(list[index], index);
    await run(
      'INSERT INTO announcements (id, text, active, linkType, externalUrl, productId, sortOrder) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [item.id || null, item.text, item.active, item.linkType, item.externalUrl, item.productId, index]
    );
  }
}

async function seedAnnouncementsIfNeeded() {
  if (disableDefaultSampleData) return;
  const row = await get('SELECT COUNT(*) AS count FROM announcements');
  if (row && row.count > 0) return;
  await saveAnnouncementList(readDefaultAnnouncements());
}

async function backfillUserRelationsFromJson() {
  const userRows = await all('SELECT * FROM users ORDER BY id ASC');
  for (const row of userRows) {
    const addressCountRow = await get('SELECT COUNT(*) AS count FROM user_addresses WHERE username = ?', [row.username]);
    if (!addressCountRow || Number(addressCountRow.count || 0) === 0) {
      await syncUserAddressRelations(row.username, parseJsonArray(row.addresses), parseJsonArray(row.shippingAddresses));
    }
    const orderCountRow = await get('SELECT COUNT(*) AS count FROM orders WHERE username = ?', [row.username]);
    if (!orderCountRow || Number(orderCountRow.count || 0) === 0) {
      await syncUserOrderRelations(row.username, parseJsonArray(row.orders));
    }
    const cartCountRow = await get('SELECT COUNT(*) AS count FROM cart_items WHERE username = ?', [row.username]);
    if (!cartCountRow || Number(cartCountRow.count || 0) === 0) {
      await syncUserCartRelations(row.username, parseJsonArray(row.cart));
    }
    const couponCountRow = await get('SELECT COUNT(*) AS count FROM user_coupons WHERE username = ?', [row.username]);
    if (!couponCountRow || Number(couponCountRow.count || 0) === 0) {
      await syncUserCouponRelations(row.username, parseJsonArray(row.coupons));
    }
  }
}

async function ensureScaleReadyIndexes() {
  const statements = [
    'CREATE INDEX IF NOT EXISTS idx_products_cat_off_id ON products(cat, off, id)',
    'CREATE INDEX IF NOT EXISTS idx_products_off_id ON products(off, id)',
    'CREATE INDEX IF NOT EXISTS idx_products_farmer_account_id ON products(farmerAccount, id)',
    'CREATE INDEX IF NOT EXISTS idx_users_username_id ON users(username, id)',
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique ON users(phone) WHERE phone <> ''",
    'CREATE INDEX IF NOT EXISTS idx_users_phone_verified ON users(phoneVerifiedAt, id)',
    'CREATE INDEX IF NOT EXISTS idx_orders_username_status_created_id ON orders(username, status, createdAt, id)',
    'CREATE INDEX IF NOT EXISTS idx_orders_status_created_id ON orders(status, createdAt, id)',
    'CREATE INDEX IF NOT EXISTS idx_orders_source_username ON orders(sourceId, username)',
    'CREATE INDEX IF NOT EXISTS idx_order_items_order_sort_id ON order_items(orderId, sortOrder, id)',
    'CREATE INDEX IF NOT EXISTS idx_shipments_order_created_id ON shipments(orderId, createdAt, id)',
    'CREATE INDEX IF NOT EXISTS idx_shipments_order_source_owner ON shipments(orderSourceId, ownerUsername, id)',
    'CREATE INDEX IF NOT EXISTS idx_shipment_items_order_shipment_sort_id ON shipment_items(orderId, shipmentId, sortOrder, id)',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_shipment_items_order_item_unique ON shipment_items(orderItemId)',
    'CREATE INDEX IF NOT EXISTS idx_cart_items_username_product_id ON cart_items(username, productId, id)',
    'CREATE INDEX IF NOT EXISTS idx_user_addresses_username_type_sort_id ON user_addresses(username, type, sortOrder, id)',
    'CREATE INDEX IF NOT EXISTS idx_user_coupons_username_used_sort_id ON user_coupons(username, used, sortOrder, id)',
    'CREATE INDEX IF NOT EXISTS idx_refund_requests_owner_status_requested_id ON refund_requests(ownerUsername, status, requestedAt, id)',
    'CREATE INDEX IF NOT EXISTS idx_refund_requests_order_id ON refund_requests(orderId, id)',
    'CREATE INDEX IF NOT EXISTS idx_payment_transactions_username_status_created_id ON payment_transactions(username, status, createdAt, id)',
    'CREATE INDEX IF NOT EXISTS idx_payment_transactions_order_status ON payment_transactions(orderId, status)',
    'CREATE INDEX IF NOT EXISTS idx_payment_transactions_external_trade ON payment_transactions(externalTradeNo, status)',
    'CREATE INDEX IF NOT EXISTS idx_payment_transactions_gateway_trade ON payment_transactions(gatewayTradeNo, status)',
    'CREATE INDEX IF NOT EXISTS idx_aftersales_username_status_created_id ON aftersales(username, status, createdAt, id)',
    'CREATE INDEX IF NOT EXISTS idx_aftersales_order_type_created_id ON aftersales(orderId, type, createdAt, id)',
    'CREATE INDEX IF NOT EXISTS idx_inventory_logs_order_created_id ON inventory_logs(orderId, createdAt, id)',
    'CREATE INDEX IF NOT EXISTS idx_inventory_logs_operator_action_created_id ON inventory_logs(operatorUsername, actionType, createdAt, id)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_username_expires ON sessions(username, expiresAt)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expiresAt)',
    'CREATE INDEX IF NOT EXISTS idx_sms_codes_phone_purpose_created ON sms_verification_codes(phone, purpose, createdAt, id)',
    'CREATE INDEX IF NOT EXISTS idx_sms_codes_phone_purpose_resend ON sms_verification_codes(phone, purpose, resendAvailableAt, id)',
    'CREATE INDEX IF NOT EXISTS idx_sms_codes_phone_purpose_code ON sms_verification_codes(phone, purpose, code, consumedAt, expiresAt, id)',
    'CREATE INDEX IF NOT EXISTS idx_sms_codes_phone_purpose_active ON sms_verification_codes(phone, purpose, consumedAt, invalidatedAt, createdAt, id)'
  ];
  for (let index = 0; index < statements.length; index++) {
    await run(statements[index]);
  }
}

async function backfillLegacyTrackingShipments() {
  const legacyOrders = await all(
    "SELECT o.id, o.sourceId, o.username, o.status, o.trackingNo, o.createdAt FROM orders o WHERE TRIM(COALESCE(o.trackingNo, '')) <> '' AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.orderId = o.id)"
  );
  for (let index = 0; index < legacyOrders.length; index++) {
    const row = legacyOrders[index];
    const itemRows = await all('SELECT id FROM order_items WHERE orderId = ? ORDER BY sortOrder ASC, id ASC', [row.id]);
    if (!itemRows.length) continue;
    const now = Number(row.createdAt || Date.now());
    const shipmentId = buildShipmentId();
    const shipmentLogistics = normalizeShipmentRecord({
      trackingNo: row.trackingNo,
      status: String(row.status || 'shipped') === 'done' ? 'done' : 'shipped',
      logisticsState: row.trackingNo ? 'no_trace' : 'no_tracking',
      logisticsSummary: row.trackingNo ? '已录入单号，等待物流公司返回轨迹' : '待发货，暂未录入物流信息'
    });
    await run(
      'INSERT INTO shipments (id, orderId, orderSourceId, ownerUsername, trackingNo, carrierCode, carrierName, status, logisticsSummary, logisticsState, logisticsProviderState, logisticsDataJson, lastLogisticsQueryAt, lastLogisticsSuccessAt, createdAt, updatedAt, createdBy, legacySource) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        shipmentId,
        row.id,
        row.sourceId,
        row.username,
        shipmentLogistics.trackingNo,
        '',
        '',
        shipmentLogistics.status,
        shipmentLogistics.logisticsSummary,
        shipmentLogistics.logisticsState,
        shipmentLogistics.state || '',
        JSON.stringify(shipmentLogistics.data || []),
        0,
        0,
        now,
        now,
        'system',
        'orders.trackingNo'
      ]
    );
    for (let itemIndex = 0; itemIndex < itemRows.length; itemIndex++) {
      await run(
        'INSERT INTO shipment_items (shipmentId, orderId, orderItemId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)',
        [shipmentId, row.id, Number(itemRows[itemIndex].id || 0), itemIndex, now]
      );
    }
  }
}

// [SERVER_DB_INIT] 建表、补种子、历史数据回填都在 initDatabase 阶段完成。
async function initDatabase() {
  await run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      orig REAL NOT NULL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT '',
      cat TEXT NOT NULL DEFAULT 'veg',
      tags TEXT NOT NULL DEFAULT '[]',
      stock INTEGER NOT NULL DEFAULT 0,
      sales INTEGER NOT NULL DEFAULT 0,
      harvest TEXT NOT NULL DEFAULT '',
      dispatchHours INTEGER NOT NULL DEFAULT 4,
      farmer TEXT NOT NULL DEFAULT '',
      farmerAccount TEXT NOT NULL DEFAULT '',
      farmerUserId INTEGER NOT NULL DEFAULT 0,
      village TEXT NOT NULL DEFAULT '',
      shippingAddressId TEXT NOT NULL DEFAULT '',
      shippingAddressSnapshot TEXT NOT NULL DEFAULT '{}',
      imagesJson TEXT NOT NULL DEFAULT '[]',
      img TEXT NOT NULL DEFAULT '',
      off INTEGER NOT NULL DEFAULT 0,
      "trace" TEXT NOT NULL DEFAULT '[]',
      variantsJson TEXT NOT NULL DEFAULT '[]'
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL DEFAULT '',
      nickname TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      phoneVerifiedAt INTEGER NOT NULL DEFAULT 0,
      roles TEXT NOT NULL DEFAULT '{}',
      addresses TEXT NOT NULL DEFAULT '[]',
      shippingAddresses TEXT NOT NULL DEFAULT '[]',
      coupons TEXT NOT NULL DEFAULT '[]',
      selectedAddressId TEXT NOT NULL DEFAULT '',
      selectedCouponId TEXT NOT NULL DEFAULT '',
      cart TEXT NOT NULL DEFAULT '[]',
      orders TEXT NOT NULL DEFAULT '[]',
      member TEXT NOT NULL DEFAULT '{}',
      createdAt TEXT NOT NULL DEFAULT ''
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS sms_verification_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL DEFAULT '',
      purpose TEXT NOT NULL DEFAULT 'bind_phone',
      code TEXT NOT NULL DEFAULT '',
      username TEXT NOT NULL DEFAULT '',
      createdAt INTEGER NOT NULL DEFAULT 0,
      expiresAt INTEGER NOT NULL DEFAULT 0,
      resendAvailableAt INTEGER NOT NULL DEFAULT 0,
      consumedAt INTEGER NOT NULL DEFAULT 0,
      invalidatedAt INTEGER NOT NULL DEFAULT 0,
      requestIp TEXT NOT NULL DEFAULT '',
      deliveryChannel TEXT NOT NULL DEFAULT 'mock',
      deliveryStatus TEXT NOT NULL DEFAULT 'queued',
      messageId TEXT NOT NULL DEFAULT ''
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      createdAt INTEGER NOT NULL DEFAULT 0,
      expiresAt INTEGER NOT NULL DEFAULT 0,
      lastSeenAt INTEGER NOT NULL DEFAULT 0
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS coupon_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      templateId TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'full_reduction',
      discountRate REAL NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      minSpend REAL NOT NULL DEFAULT 0
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '',
      sortOrder INTEGER NOT NULL DEFAULT 0,
      showOnHome INTEGER NOT NULL DEFAULT 1
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS banners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '',
      sub TEXT NOT NULL DEFAULT '',
      img TEXT NOT NULL DEFAULT '',
      linkType TEXT NOT NULL DEFAULT 'none',
      externalUrl TEXT NOT NULL DEFAULT '',
      productId INTEGER NOT NULL DEFAULT 0,
      sortOrder INTEGER NOT NULL DEFAULT 0
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      linkType TEXT NOT NULL DEFAULT 'none',
      externalUrl TEXT NOT NULL DEFAULT '',
      productId INTEGER NOT NULL DEFAULT 0,
      sortOrder INTEGER NOT NULL DEFAULT 0
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS user_addresses (
      id TEXT PRIMARY KEY,
      sourceId TEXT NOT NULL DEFAULT '',
      username TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'receiver',
      name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      full TEXT NOT NULL DEFAULT '',
      sortOrder INTEGER NOT NULL DEFAULT 0
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      sourceId TEXT NOT NULL DEFAULT '',
      username TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      total REAL NOT NULL DEFAULT 0,
      subtotal REAL NOT NULL DEFAULT 0,
      deliveryFee REAL NOT NULL DEFAULT 0,
      discount REAL NOT NULL DEFAULT 0,
      couponText TEXT NOT NULL DEFAULT '',
      couponId TEXT NOT NULL DEFAULT '',
      receiverName TEXT NOT NULL DEFAULT '',
      receiverPhone TEXT NOT NULL DEFAULT '',
      receiverFull TEXT NOT NULL DEFAULT '',
      trackingNo TEXT NOT NULL DEFAULT '',
      ownerDeleted INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL DEFAULT 0,
      reserveExpiresAt INTEGER NOT NULL DEFAULT 0,
      inventoryReleased INTEGER NOT NULL DEFAULT 0,
      inventoryReleasedAt INTEGER NOT NULL DEFAULT 0,
      cancelReason TEXT NOT NULL DEFAULT ''
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      orderId TEXT NOT NULL,
      productId INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL DEFAULT '',
      variantId TEXT NOT NULL DEFAULT '',
      variantLabel TEXT NOT NULL DEFAULT '',
      unitId TEXT NOT NULL DEFAULT '',
      unitLabel TEXT NOT NULL DEFAULT '',
      unit TEXT NOT NULL DEFAULT '',
      price REAL NOT NULL DEFAULT 0,
      deliveryFee REAL NOT NULL DEFAULT 0,
      qty INTEGER NOT NULL DEFAULT 0,
      img TEXT NOT NULL DEFAULT '',
      shippingAddressId TEXT NOT NULL DEFAULT '',
      shippingName TEXT NOT NULL DEFAULT '',
      shippingPhone TEXT NOT NULL DEFAULT '',
      shippingFull TEXT NOT NULL DEFAULT '',
      sortOrder INTEGER NOT NULL DEFAULT 0
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS shipments (
      id TEXT PRIMARY KEY,
      orderId TEXT NOT NULL,
      orderSourceId TEXT NOT NULL DEFAULT '',
      ownerUsername TEXT NOT NULL DEFAULT '',
      trackingNo TEXT NOT NULL DEFAULT '',
      carrierCode TEXT NOT NULL DEFAULT '',
      carrierName TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'shipped',
      logisticsSummary TEXT NOT NULL DEFAULT '',
      logisticsState TEXT NOT NULL DEFAULT 'no_tracking',
      logisticsProviderState TEXT NOT NULL DEFAULT '',
      logisticsDataJson TEXT NOT NULL DEFAULT '[]',
      lastLogisticsQueryAt INTEGER NOT NULL DEFAULT 0,
      lastLogisticsSuccessAt INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL DEFAULT 0,
      updatedAt INTEGER NOT NULL DEFAULT 0,
      createdBy TEXT NOT NULL DEFAULT '',
      legacySource TEXT NOT NULL DEFAULT ''
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS shipment_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipmentId TEXT NOT NULL,
      orderId TEXT NOT NULL,
      orderItemId INTEGER NOT NULL DEFAULT 0,
      sortOrder INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL DEFAULT 0
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS cart_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      productId INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL DEFAULT '',
      variantId TEXT NOT NULL DEFAULT '',
      variantLabel TEXT NOT NULL DEFAULT '',
      unitId TEXT NOT NULL DEFAULT '',
      unitLabel TEXT NOT NULL DEFAULT '',
      price REAL NOT NULL DEFAULT 0,
      deliveryFee REAL NOT NULL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT '',
      img TEXT NOT NULL DEFAULT '',
      qty INTEGER NOT NULL DEFAULT 0,
      sortOrder INTEGER NOT NULL DEFAULT 0
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS user_coupons (
      id TEXT PRIMARY KEY,
      sourceId TEXT NOT NULL DEFAULT '',
      username TEXT NOT NULL,
      templateId TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'full_reduction',
      discountRate REAL NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      minSpend REAL NOT NULL DEFAULT 0,
      used INTEGER NOT NULL DEFAULT 0,
      sortOrder INTEGER NOT NULL DEFAULT 0
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS payment_transactions (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      orderId TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'paid',
      channel TEXT NOT NULL DEFAULT 'mock_h5',
      couponId TEXT NOT NULL DEFAULT '',
      couponText TEXT NOT NULL DEFAULT '',
      receiverName TEXT NOT NULL DEFAULT '',
      receiverPhone TEXT NOT NULL DEFAULT '',
      receiverFull TEXT NOT NULL DEFAULT '',
      externalTradeNo TEXT NOT NULL DEFAULT '',
      gatewayTradeNo TEXT NOT NULL DEFAULT '',
      gatewayBuyerId TEXT NOT NULL DEFAULT '',
      notifyStatus TEXT NOT NULL DEFAULT '',
      notifyPayload TEXT NOT NULL DEFAULT '{}',
      notifyAt INTEGER NOT NULL DEFAULT 0,
      initiatedAt INTEGER NOT NULL DEFAULT 0,
      returnCheckedAt INTEGER NOT NULL DEFAULT 0,
      lastError TEXT NOT NULL DEFAULT '',
      createdAt INTEGER NOT NULL DEFAULT 0,
      paidAt INTEGER NOT NULL DEFAULT 0
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS aftersales (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      orderId TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'cancel',
      status TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',
      createdAt INTEGER NOT NULL DEFAULT 0,
      updatedAt INTEGER NOT NULL DEFAULT 0
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS refund_requests (
      id TEXT PRIMARY KEY,
      orderId TEXT NOT NULL,
      ownerUsername TEXT NOT NULL,
      scopeType TEXT NOT NULL DEFAULT 'order',
      itemsSnapshot TEXT NOT NULL DEFAULT '[]',
      sourceOrderStatus TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      refundAmount REAL NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',
      assigneeRole TEXT NOT NULL DEFAULT 'admin',
      assigneeUsername TEXT NOT NULL DEFAULT '',
      inventoryRestored INTEGER NOT NULL DEFAULT 0,
      paymentRefunded INTEGER NOT NULL DEFAULT 0,
      rejectReason TEXT NOT NULL DEFAULT '',
      requestedAt INTEGER NOT NULL DEFAULT 0,
      reviewedAt INTEGER NOT NULL DEFAULT 0,
      completedAt INTEGER NOT NULL DEFAULT 0,
      updatedAt INTEGER NOT NULL DEFAULT 0
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS inventory_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      productId INTEGER NOT NULL DEFAULT 0,
      productName TEXT NOT NULL DEFAULT '',
      operatorUsername TEXT NOT NULL DEFAULT '',
      operatorRole TEXT NOT NULL DEFAULT 'system',
      actionType TEXT NOT NULL DEFAULT 'manual_adjust',
      deltaStock INTEGER NOT NULL DEFAULT 0,
      deltaSales INTEGER NOT NULL DEFAULT 0,
      beforeStock INTEGER NOT NULL DEFAULT 0,
      afterStock INTEGER NOT NULL DEFAULT 0,
      beforeSales INTEGER NOT NULL DEFAULT 0,
      afterSales INTEGER NOT NULL DEFAULT 0,
      orderId TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      createdAt INTEGER NOT NULL DEFAULT 0
    )
  `);
  const columnDefinitions = {
    name: "TEXT NOT NULL DEFAULT ''",
    price: 'REAL NOT NULL DEFAULT 0',
    orig: 'REAL NOT NULL DEFAULT 0',
    unit: "TEXT NOT NULL DEFAULT ''",
    cat: "TEXT NOT NULL DEFAULT 'veg'",
    tags: "TEXT NOT NULL DEFAULT '[]'",
    stock: 'INTEGER NOT NULL DEFAULT 0',
    sales: 'INTEGER NOT NULL DEFAULT 0',
    harvest: "TEXT NOT NULL DEFAULT ''",
    dispatchHours: 'INTEGER NOT NULL DEFAULT 4',
    farmer: "TEXT NOT NULL DEFAULT ''",
    farmerAccount: "TEXT NOT NULL DEFAULT ''",
    farmerUserId: 'INTEGER NOT NULL DEFAULT 0',
    village: "TEXT NOT NULL DEFAULT ''",
    shippingAddressId: "TEXT NOT NULL DEFAULT ''",
    shippingAddressSnapshot: "TEXT NOT NULL DEFAULT '{}'",
    imagesJson: "TEXT NOT NULL DEFAULT '[]'",
    img: "TEXT NOT NULL DEFAULT ''",
    off: 'INTEGER NOT NULL DEFAULT 0',
    trace: "TEXT NOT NULL DEFAULT '[]'",
    variantsJson: "TEXT NOT NULL DEFAULT '[]'"
  };
  const columns = await all('PRAGMA table_info(products)');
  const existingColumns = columns.reduce(function (result, item) {
    result[item.name] = true;
    return result;
  }, {});
  for (const key of Object.keys(columnDefinitions)) {
    if (existingColumns[key]) continue;
    const columnName = key === 'trace' ? '"trace"' : key;
    await run('ALTER TABLE products ADD COLUMN ' + columnName + ' ' + columnDefinitions[key]);
  }
  var userColumns = await all('PRAGMA table_info(users)');
  var userExisting = userColumns.reduce(function (result, item) {
    result[item.name] = true;
    return result;
  }, {});
  var userDefinitions = {
    password: "TEXT NOT NULL DEFAULT ''",
    nickname: "TEXT NOT NULL DEFAULT ''",
    phone: "TEXT NOT NULL DEFAULT ''",
    phoneVerifiedAt: 'INTEGER NOT NULL DEFAULT 0',
    roles: "TEXT NOT NULL DEFAULT '{}'",
    addresses: "TEXT NOT NULL DEFAULT '[]'",
    shippingAddresses: "TEXT NOT NULL DEFAULT '[]'",
    coupons: "TEXT NOT NULL DEFAULT '[]'",
    selectedAddressId: "TEXT NOT NULL DEFAULT ''",
    selectedCouponId: "TEXT NOT NULL DEFAULT ''",
    cart: "TEXT NOT NULL DEFAULT '[]'",
    orders: "TEXT NOT NULL DEFAULT '[]'",
    member: "TEXT NOT NULL DEFAULT '{}'",
    createdAt: "TEXT NOT NULL DEFAULT ''"
  };
  for (const key of Object.keys(userDefinitions)) {
    if (!userExisting[key]) await run('ALTER TABLE users ADD COLUMN ' + key + ' ' + userDefinitions[key]);
  }
  var smsCodeColumns = await all('PRAGMA table_info(sms_verification_codes)');
  var smsCodeExisting = smsCodeColumns.reduce(function (result, item) {
    result[item.name] = true;
    return result;
  }, {});
  var smsCodeDefinitions = {
    phone: "TEXT NOT NULL DEFAULT ''",
    purpose: "TEXT NOT NULL DEFAULT 'bind_phone'",
    code: "TEXT NOT NULL DEFAULT ''",
    username: "TEXT NOT NULL DEFAULT ''",
    createdAt: 'INTEGER NOT NULL DEFAULT 0',
    expiresAt: 'INTEGER NOT NULL DEFAULT 0',
    resendAvailableAt: 'INTEGER NOT NULL DEFAULT 0',
    consumedAt: 'INTEGER NOT NULL DEFAULT 0',
    invalidatedAt: 'INTEGER NOT NULL DEFAULT 0',
    requestIp: "TEXT NOT NULL DEFAULT ''",
    deliveryChannel: "TEXT NOT NULL DEFAULT 'mock'",
    deliveryStatus: "TEXT NOT NULL DEFAULT 'queued'",
    messageId: "TEXT NOT NULL DEFAULT ''"
  };
  for (const key of Object.keys(smsCodeDefinitions)) {
    if (!smsCodeExisting[key]) await run('ALTER TABLE sms_verification_codes ADD COLUMN ' + key + ' ' + smsCodeDefinitions[key]);
  }
  var categoryColumns = await all('PRAGMA table_info(categories)');
  var categoryExisting = categoryColumns.reduce(function (result, item) {
    result[item.name] = true;
    return result;
  }, {});
  var categoryDefinitions = {
    name: "TEXT NOT NULL DEFAULT ''",
    icon: "TEXT NOT NULL DEFAULT ''",
    sortOrder: 'INTEGER NOT NULL DEFAULT 0',
    showOnHome: 'INTEGER NOT NULL DEFAULT 1'
  };
  for (const key of Object.keys(categoryDefinitions)) {
    if (!categoryExisting[key]) await run('ALTER TABLE categories ADD COLUMN ' + key + ' ' + categoryDefinitions[key]);
  }
  var bannerColumns = await all('PRAGMA table_info(banners)');
  var bannerExisting = bannerColumns.reduce(function (result, item) {
    result[item.name] = true;
    return result;
  }, {});
  var bannerDefinitions = {
    linkType: "TEXT NOT NULL DEFAULT 'none'",
    externalUrl: "TEXT NOT NULL DEFAULT ''",
    productId: 'INTEGER NOT NULL DEFAULT 0'
  };
  for (const key of Object.keys(bannerDefinitions)) {
    if (!bannerExisting[key]) await run('ALTER TABLE banners ADD COLUMN ' + key + ' ' + bannerDefinitions[key]);
  }
  var announcementColumns = await all('PRAGMA table_info(announcements)');
  var announcementExisting = announcementColumns.reduce(function (result, item) {
    result[item.name] = true;
    return result;
  }, {});
  var announcementDefinitions = {
    linkType: "TEXT NOT NULL DEFAULT 'none'",
    externalUrl: "TEXT NOT NULL DEFAULT ''",
    productId: 'INTEGER NOT NULL DEFAULT 0'
  };
  for (const key of Object.keys(announcementDefinitions)) {
    if (!announcementExisting[key]) await run('ALTER TABLE announcements ADD COLUMN ' + key + ' ' + announcementDefinitions[key]);
  }
  var addressColumns = await all('PRAGMA table_info(user_addresses)');
  var addressExisting = addressColumns.reduce(function (result, item) {
    result[item.name] = true;
    return result;
  }, {});
  var addressDefinitions = {
    sourceId: "TEXT NOT NULL DEFAULT ''"
  };
  for (const key of Object.keys(addressDefinitions)) {
    if (!addressExisting[key]) await run('ALTER TABLE user_addresses ADD COLUMN ' + key + ' ' + addressDefinitions[key]);
  }
  var orderColumns = await all('PRAGMA table_info(orders)');
  var orderExisting = orderColumns.reduce(function (result, item) {
    result[item.name] = true;
    return result;
  }, {});
  var orderDefinitions = {
    sourceId: "TEXT NOT NULL DEFAULT ''",
    trackingNo: "TEXT NOT NULL DEFAULT ''",
    ownerDeleted: 'INTEGER NOT NULL DEFAULT 0',
    reserveExpiresAt: 'INTEGER NOT NULL DEFAULT 0',
    inventoryReleased: 'INTEGER NOT NULL DEFAULT 0',
    inventoryReleasedAt: 'INTEGER NOT NULL DEFAULT 0',
    cancelReason: "TEXT NOT NULL DEFAULT ''"
  };
  for (const key of Object.keys(orderDefinitions)) {
    if (!orderExisting[key]) await run('ALTER TABLE orders ADD COLUMN ' + key + ' ' + orderDefinitions[key]);
  }
  var orderItemColumns = await all('PRAGMA table_info(order_items)');
  var orderItemExisting = orderItemColumns.reduce(function (result, item) {
    result[item.name] = true;
    return result;
  }, {});
  var orderItemDefinitions = {
    variantId: "TEXT NOT NULL DEFAULT ''",
    variantLabel: "TEXT NOT NULL DEFAULT ''",
    unitId: "TEXT NOT NULL DEFAULT ''",
    unitLabel: "TEXT NOT NULL DEFAULT ''",
    deliveryFee: 'REAL NOT NULL DEFAULT 0'
  };
  for (const key of Object.keys(orderItemDefinitions)) {
    if (!orderItemExisting[key]) await run('ALTER TABLE order_items ADD COLUMN ' + key + ' ' + orderItemDefinitions[key]);
  }
  var shipmentColumns = await all('PRAGMA table_info(shipments)');
  var shipmentExisting = shipmentColumns.reduce(function (result, item) {
    result[item.name] = true;
    return result;
  }, {});
  var shipmentDefinitions = {
    orderSourceId: "TEXT NOT NULL DEFAULT ''",
    ownerUsername: "TEXT NOT NULL DEFAULT ''",
    trackingNo: "TEXT NOT NULL DEFAULT ''",
    carrierCode: "TEXT NOT NULL DEFAULT ''",
    carrierName: "TEXT NOT NULL DEFAULT ''",
    status: "TEXT NOT NULL DEFAULT 'shipped'",
    logisticsSummary: "TEXT NOT NULL DEFAULT ''",
    logisticsState: "TEXT NOT NULL DEFAULT 'no_tracking'",
    logisticsProviderState: "TEXT NOT NULL DEFAULT ''",
    logisticsDataJson: "TEXT NOT NULL DEFAULT '[]'",
    lastLogisticsQueryAt: 'INTEGER NOT NULL DEFAULT 0',
    lastLogisticsSuccessAt: 'INTEGER NOT NULL DEFAULT 0',
    createdAt: 'INTEGER NOT NULL DEFAULT 0',
    updatedAt: 'INTEGER NOT NULL DEFAULT 0',
    createdBy: "TEXT NOT NULL DEFAULT ''",
    legacySource: "TEXT NOT NULL DEFAULT ''"
  };
  for (const key of Object.keys(shipmentDefinitions)) {
    if (!shipmentExisting[key]) await run('ALTER TABLE shipments ADD COLUMN ' + key + ' ' + shipmentDefinitions[key]);
  }
  var shipmentItemColumns = await all('PRAGMA table_info(shipment_items)');
  var shipmentItemExisting = shipmentItemColumns.reduce(function (result, item) {
    result[item.name] = true;
    return result;
  }, {});
  var shipmentItemDefinitions = {
    orderItemId: 'INTEGER NOT NULL DEFAULT 0',
    sortOrder: 'INTEGER NOT NULL DEFAULT 0',
    createdAt: 'INTEGER NOT NULL DEFAULT 0'
  };
  for (const key of Object.keys(shipmentItemDefinitions)) {
    if (!shipmentItemExisting[key]) await run('ALTER TABLE shipment_items ADD COLUMN ' + key + ' ' + shipmentItemDefinitions[key]);
  }
  var cartItemColumns = await all('PRAGMA table_info(cart_items)');
  var cartItemExisting = cartItemColumns.reduce(function (result, item) {
    result[item.name] = true;
    return result;
  }, {});
  var cartItemDefinitions = {
    variantId: "TEXT NOT NULL DEFAULT ''",
    variantLabel: "TEXT NOT NULL DEFAULT ''",
    unitId: "TEXT NOT NULL DEFAULT ''",
    unitLabel: "TEXT NOT NULL DEFAULT ''",
    deliveryFee: 'REAL NOT NULL DEFAULT 0'
  };
  for (const key of Object.keys(cartItemDefinitions)) {
    if (!cartItemExisting[key]) await run('ALTER TABLE cart_items ADD COLUMN ' + key + ' ' + cartItemDefinitions[key]);
  }
  var userCouponColumns = await all('PRAGMA table_info(user_coupons)');
  var userCouponExisting = userCouponColumns.reduce(function (result, item) {
    result[item.name] = true;
    return result;
  }, {});
  var userCouponDefinitions = {
    sourceId: "TEXT NOT NULL DEFAULT ''"
  };
  for (const key of Object.keys(userCouponDefinitions)) {
    if (!userCouponExisting[key]) await run('ALTER TABLE user_coupons ADD COLUMN ' + key + ' ' + userCouponDefinitions[key]);
  }
  var paymentColumns = await all('PRAGMA table_info(payment_transactions)');
  var paymentExisting = paymentColumns.reduce(function (result, item) {
    result[item.name] = true;
    return result;
  }, {});
  var paymentDefinitions = {
    externalTradeNo: "TEXT NOT NULL DEFAULT ''",
    gatewayTradeNo: "TEXT NOT NULL DEFAULT ''",
    gatewayBuyerId: "TEXT NOT NULL DEFAULT ''",
    notifyStatus: "TEXT NOT NULL DEFAULT ''",
    notifyPayload: "TEXT NOT NULL DEFAULT '{}'",
    notifyAt: 'INTEGER NOT NULL DEFAULT 0',
    initiatedAt: 'INTEGER NOT NULL DEFAULT 0',
    returnCheckedAt: 'INTEGER NOT NULL DEFAULT 0',
    lastError: "TEXT NOT NULL DEFAULT ''"
  };
  for (const key of Object.keys(paymentDefinitions)) {
    if (!paymentExisting[key]) await run('ALTER TABLE payment_transactions ADD COLUMN ' + key + ' ' + paymentDefinitions[key]);
  }
  var refundColumns = await all('PRAGMA table_info(refund_requests)');
  var refundExisting = refundColumns.reduce(function (result, item) {
    result[item.name] = true;
    return result;
  }, {});
  var refundDefinitions = {
    orderId: "TEXT NOT NULL DEFAULT ''",
    ownerUsername: "TEXT NOT NULL DEFAULT ''",
    scopeType: "TEXT NOT NULL DEFAULT 'order'",
    itemsSnapshot: "TEXT NOT NULL DEFAULT '[]'",
    sourceOrderStatus: "TEXT NOT NULL DEFAULT ''",
    status: "TEXT NOT NULL DEFAULT 'pending'",
    refundAmount: 'REAL NOT NULL DEFAULT 0',
    reason: "TEXT NOT NULL DEFAULT ''",
    assigneeRole: "TEXT NOT NULL DEFAULT 'admin'",
    assigneeUsername: "TEXT NOT NULL DEFAULT ''",
    inventoryRestored: 'INTEGER NOT NULL DEFAULT 0',
    paymentRefunded: 'INTEGER NOT NULL DEFAULT 0',
    rejectReason: "TEXT NOT NULL DEFAULT ''",
    requestedAt: 'INTEGER NOT NULL DEFAULT 0',
    reviewedAt: 'INTEGER NOT NULL DEFAULT 0',
    completedAt: 'INTEGER NOT NULL DEFAULT 0',
    updatedAt: 'INTEGER NOT NULL DEFAULT 0'
  };
  for (const key of Object.keys(refundDefinitions)) {
    if (!refundExisting[key]) await run('ALTER TABLE refund_requests ADD COLUMN ' + key + ' ' + refundDefinitions[key]);
  }
  await ensureScaleReadyIndexes();
  await cleanupExpiredSessions();
  await cleanupExpiredSmsVerifications();
  await backfillPasswordHashes();
  await seedCategoriesIfNeeded();
  await seedCouponTemplatesIfNeeded();
  await seedAdminIfNeeded();
  await backfillUserRelationsFromJson();
  await backfillLegacyTrackingShipments();
  // 支付与售后都能从现有订单状态回填；库存流水缺少历史差值，只能从本次版本开始持续积累。
  await backfillOrderDerivedRelations();
  await cleanupExpiredPendingOrders(Date.now());
}

app.use(function (req, res, next) {
  (async function () {
    req.sessionId = '';
    req.currentUser = null;
    req.currentAccessLevel = 'public';
    const cookies = parseCookies(req.headers && req.headers.cookie);
    const sessionId = String(cookies[SESSION_COOKIE_NAME] || '').trim();
    if (!sessionId) return;
    const session = await getSessionRecord(sessionId);
    if (!session) {
      clearSessionCookie(res, req);
      return;
    }
    const currentUser = await getUserByUsername(session.username);
    if (!currentUser) {
      await deleteSession(session.id);
      clearSessionCookie(res, req);
      return;
    }
    await touchSession(session);
    req.sessionId = session.id;
    req.currentUser = currentUser;
    req.currentAccessLevel = getAccessLevel(currentUser);
  })().then(function () {
    next();
  }).catch(next);
});

// [API_PRODUCTS] 商品列表和商品按 ID 新增/覆盖都走这组接口。
app.get('/api/products', async function (req, res) {
  try {
    if (hasPagingQuery(req.query)) {
      const page = await listProductsPage({
        page: req.query && req.query.page,
        pageSize: req.query && req.query.pageSize,
        category: req.query && req.query.category,
        cat: req.query && req.query.cat,
        status: hasAccessLevel(req.currentUser, 'farmer') ? (req.query && req.query.status) : 'active',
        keyword: req.query && req.query.keyword,
        q: req.query && req.query.q
      });
      return res.json(page);
    }
    if (hasAccessLevel(req.currentUser, 'farmer')) {
      await seedProductsIfNeeded();
      const rows = await all('SELECT * FROM products ORDER BY id ASC');
      return res.json(rows.map(hydrateProduct));
    }
    const page = await listProductsPage({ page: 1, pageSize: 60, status: 'active' });
    res.json(page.items);
  } catch (error) {
    res.status(500).json({ message: '获取商品失败', error: error.message });
  }
});

app.get('/api/products/search', async function (req, res) {
  try {
    const products = await searchBuyerVisibleProducts(req.query && req.query.q);
    res.json(products);
  } catch (error) {
    res.status(500).json({ message: '搜索商品失败', error: error.message });
  }
});

app.get('/api/products/:id', async function (req, res) {
  try {
    const product = await getProductById(req.params.id);
    if (!product) return res.status(404).json({ message: '商品不存在' });
    if (product.off && !canManageProduct(req.currentUser, product)) {
      return res.status(404).json({ message: '商品不存在' });
    }
    res.json(product);
  } catch (error) {
    res.status(500).json({ message: '获取商品详情失败', error: error.message });
  }
});

app.post('/api/products', async function (req, res) {
  try {
    if (!ensureAccess('farmer')(req, res, '当前账号无权维护商品')) return;
    const payload = normalizeProduct(req.body || {});
    const existing = payload.id ? await getProductById(payload.id) : null;
    if (payload.id && !existing) return res.status(404).json({ message: '商品不存在，无法更新' });
    if (existing && !canManageProduct(req.currentUser, existing)) {
      return res.status(403).json({ message: '当前账号无权修改该商品' });
    }
    if (!hasAccessLevel(req.currentUser, 'admin')) {
      payload.farmerAccount = req.currentUser.username;
      payload.farmer = req.currentUser.roles && req.currentUser.roles.farmerName ? req.currentUser.roles.farmerName : req.currentUser.username;
      payload.farmerUserId = Number(req.currentUser.id || 0);
    }
    let productId = payload.id;
    if (productId) {
      const changes = await updateProduct(payload);
      if (!changes) {
        return res.status(404).json({ message: '商品不存在，无法更新' });
      }
    } else {
      productId = await insertProduct(payload);
    }
    const row = await get('SELECT * FROM products WHERE id = ?', [productId]);
    res.json(hydrateProduct(row));
  } catch (error) {
    res.status(500).json({ message: '保存商品失败', error: error.message });
  }
});

app.get('/api/products/:id/delete-impact', async function (req, res) {
  try {
    if (!ensureAccess('farmer')(req, res, '当前账号无权删除商品')) return;
    const impact = await getProductDeleteImpact(req.params.id);
    if (!impact) return res.status(404).json({ message: '商品不存在' });
    const product = await getProductById(req.params.id);
    if (!canManageProduct(req.currentUser, product)) {
      return res.status(403).json({ message: '当前账号无权查看该商品删除影响' });
    }
    res.json(impact);
  } catch (error) {
    res.status(500).json({ message: '获取商品删除影响失败', error: error.message });
  }
});

app.delete('/api/products/:id', async function (req, res) {
  try {
    if (!ensureAccess('farmer')(req, res, '当前账号无权删除商品')) return;
    const existing = await getProductById(req.params.id);
    if (!existing) return res.status(404).json({ message: '商品不存在，无法删除' });
    if (!canManageProduct(req.currentUser, existing)) {
      return res.status(403).json({ message: '当前账号无权删除该商品' });
    }
    const payload = req.body || {};
    const deleted = await deleteProductById(req.params.id, normalizeAuditMeta(payload._audit, {
      actionType: 'product_delete',
      operatorUsername: req.currentUser.username,
      operatorRole: hasAccessLevel(req.currentUser, 'admin') ? 'admin' : 'farmer',
      note: '删除商品并保留历史订单快照'
    }));
    res.json(deleted);
  } catch (error) {
    res.status(500).json({ message: '删除商品失败', error: error.message });
  }
});

// [API_CONTENT] Banner、公告、上传图片、优惠券模板都归到内容配置接口组。
app.get('/api/categories', async function (req, res) {
  try {
    const categories = await getCategoryList();
    res.json(categories);
  } catch (error) {
    res.status(500).json({ message: '获取商品分类失败', error: error.message });
  }
});

app.post('/api/categories', async function (req, res) {
  try {
    if (!ensureAccess('admin')(req, res, '当前账号无权维护商品分类')) return;
    const payload = Array.isArray(req.body) ? req.body : [];
    await saveCategoryList(payload);
    const categories = await getCategoryList();
    res.json(categories);
  } catch (error) {
    res.status(500).json({ message: '保存商品分类失败', error: error.message });
  }
});

app.get('/api/banners', async function (req, res) {
  try {
    await seedBannersIfNeeded();
    const rows = await all('SELECT * FROM banners ORDER BY sortOrder ASC, id ASC');
    res.json(rows.map(hydrateBanner));
  } catch (error) {
    res.status(500).json({ message: '获取 Banner 失败', error: error.message });
  }
});

app.post('/api/banners', async function (req, res) {
  try {
    if (!ensureAccess('admin')(req, res, '当前账号无权维护 Banner')) return;
    const payload = Array.isArray(req.body) ? req.body : [];
    await saveBannerList(payload);
    const rows = await all('SELECT * FROM banners ORDER BY sortOrder ASC, id ASC');
    res.json(rows.map(hydrateBanner));
  } catch (error) {
    res.status(500).json({ message: '保存 Banner 失败', error: error.message });
  }
});

app.get('/api/announcements', async function (req, res) {
  try {
    await seedAnnouncementsIfNeeded();
    const rows = await all('SELECT * FROM announcements ORDER BY sortOrder ASC, id ASC');
    res.json(rows.map(hydrateAnnouncement));
  } catch (error) {
    res.status(500).json({ message: '获取公告失败', error: error.message });
  }
});

app.post('/api/announcements', async function (req, res) {
  try {
    if (!ensureAccess('admin')(req, res, '当前账号无权维护公告')) return;
    const payload = Array.isArray(req.body) ? req.body : [];
    await saveAnnouncementList(payload);
    const rows = await all('SELECT * FROM announcements ORDER BY sortOrder ASC, id ASC');
    res.json(rows.map(hydrateAnnouncement));
  } catch (error) {
    res.status(500).json({ message: '保存公告失败', error: error.message });
  }
});

app.post('/api/upload', function (req, res) {
  try {
    if (!ensureAccess('farmer')(req, res, '当前账号无权上传图片')) return;
    const payload = req.body || {};
    const folder = sanitizeFileSegment(payload.folder || 'common');
    if (['banner', 'category'].indexOf(folder) >= 0 && !hasAccessLevel(req.currentUser, 'admin')) {
      return res.status(403).json({ message: '当前账号无权上传该类型图片' });
    }
    const imageUrl = writeDataUrlImage(payload.dataUrl, folder, payload.fileName);
    res.json({ url: imageUrl });
  } catch (error) {
    res.status(400).json({ message: '图片上传失败', error: error.message });
  }
});

app.get('/api/coupon-templates', async function (req, res) {
  try {
    const templates = await getCouponTemplateList();
    res.json(templates);
  } catch (error) {
    res.status(500).json({ message: '获取优惠券模板失败', error: error.message });
  }
});

app.post('/api/coupon-templates', async function (req, res) {
  try {
    if (!ensureAccess('admin')(req, res, '当前账号无权维护优惠券模板')) return;
    const payload = Array.isArray(req.body) ? req.body : [];
    await saveCouponTemplateList(payload);
    const templates = await getCouponTemplateList();
    res.json(templates);
  } catch (error) {
    res.status(500).json({ message: '保存优惠券模板失败', error: error.message });
  }
});

app.get('/api/orders', async function (req, res) {
  try {
    await cleanupExpiredPendingOrders(Date.now());
    if (hasPagingQuery(req.query)) {
      const ownerUsername = String(req.query && (req.query.ownerUsername || req.query.username) || '').trim();
      if (ownerUsername) {
        if (!ensureLoggedIn(req, res, '请先登录后查看订单')) return;
        if (ownerUsername !== req.currentUser.username && !hasAccessLevel(req.currentUser, 'admin')) {
          return res.status(403).json({ message: '当前账号无权查看该订单列表' });
        }
        const page = await listOrdersByOwnerPage(req.query.ownerUsername, {
          page: req.query.page,
          pageSize: req.query.pageSize,
          status: req.query.status,
          dateFrom: req.query.dateFrom,
          dateTo: req.query.dateTo
        });
        return res.json(page);
      }
      if (!ensureAccess('admin')(req, res, '当前账号无权查看全部订单')) return;
      const page = await listAllOrdersPage({
        page: req.query && req.query.page,
        pageSize: req.query && req.query.pageSize,
        ownerUsername: req.query && (req.query.ownerUsername || req.query.username),
        orderId: req.query && req.query.orderId,
        status: req.query && req.query.status,
        dateFrom: req.query && req.query.dateFrom,
        dateTo: req.query && req.query.dateTo
      });
      return res.json(page);
    }
    if (!ensureAccess('admin')(req, res, '当前账号无权查看全部订单')) return;
    const orders = await listAllOrderSnapshots();
    res.json(orders);
  } catch (error) {
    res.status(500).json({ message: '获取订单快照失败', error: error.message });
  }
});

app.get('/api/orders/:orderId', async function (req, res) {
  try {
    if (!ensureLoggedIn(req, res, '请先登录后查看订单')) return;
    const sourceOrderId = String(req.params.orderId || '').trim();
    const order = await getOrderSnapshotByOwner(req.currentUser.username, sourceOrderId);
    if (!order) return res.status(404).json({ message: '订单不存在' });
    res.json(order);
  } catch (error) {
    res.status(400).json({ message: error.message || '订单加载失败', error: error.message });
  }
});

app.post('/api/orders/logistics-refresh-check', async function (req, res) {
  try {
    if (!ensureLoggedIn(req, res, '请先登录后查看物流')) return;
    res.json({
      changed: false,
      changedOrderIds: [],
      changedCount: 0,
      visibleOrderIds: normalizeVisibleOrderIdList(req.body && req.body.visibleOrderIds),
      visibleChangedOrderIds: [],
      visibleChangedCount: 0,
      mode: 'background_polling'
    });
  } catch (error) {
    res.status(400).json({ message: error.message || '物流检查失败', error: error.message });
  }
});

app.post('/api/orders/:orderId/logistics-refresh-check', async function (req, res) {
  try {
    if (!ensureLoggedIn(req, res, '请先登录后查看物流')) return;
    const sourceOrderId = String(req.params.orderId || '').trim();
    const order = await getOrderSnapshotByOwner(req.currentUser.username, sourceOrderId);
    if (!order) return res.status(404).json({ message: '订单不存在' });
    res.json({
      orderId: sourceOrderId,
      changed: false,
      changedOrderIds: [],
      changedCount: 0,
      visibleOrderIds: [],
      visibleChangedOrderIds: [],
      visibleChangedCount: 0,
      mode: 'background_polling'
    });
  } catch (error) {
    res.status(400).json({ message: error.message || '物流检查失败', error: error.message });
  }
});

app.get('/api/admin/orders/export', async function (req, res) {
  try {
    await cleanupExpiredPendingOrders(Date.now());
    if (!ensureAccess('admin')(req, res, '当前账号无权导出订单')) return;
    const orders = await listAllOrdersForExport({
      ownerUsername: req.query && (req.query.ownerUsername || req.query.username),
      orderId: req.query && req.query.orderId,
      status: req.query && req.query.status,
      dateFrom: req.query && req.query.dateFrom,
      dateTo: req.query && req.query.dateTo
    });
    const csv = serializeOrderExportCsv(buildOrderExportRows(orders));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + buildOrderExportFilename(Date.now()) + '"');
    res.send(csv);
  } catch (error) {
    res.status(500).json({ message: '导出订单失败', error: error.message });
  }
});

app.get('/api/admin/fulfillment/orders', async function (req, res) {
  try {
    if (!ensureAccess('admin')(req, res, '当前账号无权查看发货工作台')) return;
    const page = await listAdminFulfillmentOrdersPage({
      page: req.query && req.query.page,
      pageSize: req.query && req.query.pageSize,
      ownerUsername: req.query && (req.query.ownerUsername || req.query.username),
      orderId: req.query && req.query.orderId,
      status: req.query && req.query.status
    });
    res.json(page);
  } catch (error) {
    res.status(500).json({ message: '发货工作台订单加载失败', error: error.message });
  }
});

app.get('/api/admin/fulfillment/orders/:ownerUsername/:orderId', async function (req, res) {
  try {
    if (!ensureAccess('admin')(req, res, '当前账号无权查看发货详情')) return;
    const ownerUsername = String(req.params.ownerUsername || '').trim();
    const sourceOrderId = String(req.params.orderId || '').trim();
    const order = await getOrderSnapshotByOwner(ownerUsername, sourceOrderId);
    if (!order) return res.status(404).json({ message: '订单不存在' });
    res.json(order);
  } catch (error) {
    res.status(400).json({ message: error.message || '发货详情加载失败', error: error.message });
  }
});

app.post('/api/admin/fulfillment/orders/:ownerUsername/:orderId/shipments', async function (req, res) {
  try {
    if (!ensureAccess('admin')(req, res, '当前账号无权执行发货')) return;
    const ownerUsername = String(req.params.ownerUsername || '').trim();
    const sourceOrderId = String(req.params.orderId || '').trim();
    const order = await createShipmentForOrder(ownerUsername, sourceOrderId, req.body || {}, req.currentUser && req.currentUser.username);
    if (!order) return res.status(404).json({ message: '订单不存在' });
    res.json(order);
  } catch (error) {
    res.status(400).json({ message: error.message || '发货保存失败', error: error.message });
  }
});

app.post('/api/orders/prepare-payment', async function (req, res) {
  try {
    if (!ensureLoggedIn(req, res, '请先登录后再下单')) return;
    await cleanupExpiredPendingOrders(Date.now());
    const ownerUsername = req.currentUser.username;
    const order = await createPendingOrderFromCheckout(ownerUsername, req.body || {});
    res.json(withPaymentRuntimeMeta(order, req));
  } catch (error) {
    res.status(400).json({ message: error.message || '创建待支付订单失败', error: error.message });
  }
});

app.post('/api/orders/:orderId/pay', async function (req, res) {
  try {
    if (!ensureLoggedIn(req, res, '请先登录后再支付')) return;
    if (!isLocalMockPaymentEnabled()) {
      return res.status(403).json({
        message: 'mock 支付接口仅供本地开发调试使用，请改走 /api/orders/:orderId/alipay-wap 并以支付宝异步通知确认结果'
      });
    }
    await cleanupExpiredPendingOrders(Date.now());
    const sourceOrderId = String(req.params.orderId || '').trim();
    const ownerUsername = req.currentUser.username;
    const order = await finalizePendingOrderPayment(ownerUsername, sourceOrderId, {
      channel: 'mock_h5'
    });
    res.json(order);
  } catch (error) {
    res.status(400).json({ message: error.message || '待支付订单支付失败', error: error.message });
  }
});

app.post('/api/orders/:orderId/alipay-wap', async function (req, res) {
  try {
    if (!ensureLoggedIn(req, res, '请先登录后再支付')) return;
    const sourceOrderId = String(req.params.orderId || '').trim();
    const launch = await createAlipayWapLaunch(req.currentUser.username, sourceOrderId, req);
    res.json(launch);
  } catch (error) {
    res.status(400).json({ message: error.message || '支付宝支付发起失败', error: error.message });
  }
});

app.post('/api/orders/:orderId/wechat-inapp-h5', async function (req, res) {
  try {
    if (!ensureLoggedIn(req, res, '请先登录后再支付')) return;
    const sourceOrderId = String(req.params.orderId || '').trim();
    const launch = await createWechatPaymentLaunch(req.currentUser.username, sourceOrderId, req, 'wechat_h5_inapp');
    res.json(launch);
  } catch (error) {
    res.status(400).json({ message: error.message || '微信内 H5 支付发起失败', error: error.message });
  }
});

app.post('/api/orders/:orderId/wechat-external-h5', async function (req, res) {
  try {
    if (!ensureLoggedIn(req, res, '请先登录后再支付')) return;
    const sourceOrderId = String(req.params.orderId || '').trim();
    const launch = await createWechatPaymentLaunch(req.currentUser.username, sourceOrderId, req, 'wechat_h5_external');
    res.json(launch);
  } catch (error) {
    res.status(400).json({ message: error.message || '微信外 H5 支付发起失败', error: error.message });
  }
});

app.get('/api/orders/:orderId/payment-status', async function (req, res) {
  try {
    if (!ensureLoggedIn(req, res, '请先登录后查看支付状态')) return;
    const sourceOrderId = String(req.params.orderId || '').trim();
    const payload = await getBuyerPaymentStatus(req.currentUser.username, sourceOrderId, {
      markReturnChecked: parseEnvFlag(req.query && req.query.returnCheck)
    }, req);
    res.json(payload);
  } catch (error) {
    res.status(400).json({ message: error.message || '获取支付状态失败', error: error.message });
  }
});

app.post('/api/payments/alipay/notify', async function (req, res) {
  try {
    const handled = await handleAlipayNotification(req.body || {});
    if (!handled.ok && !handled.shouldAcknowledge) return res.status(400).send('fail');
    return res.type('text/plain').send('success');
  } catch (error) {
    console.error('支付宝异步通知处理失败', error);
    res.status(500).type('text/plain').send('fail');
  }
});

app.post('/api/payments/wechat/notify', async function (req, res) {
  try {
    const handled = await handleWechatNotification(req.body || {});
    if (!handled.ok && !handled.shouldAcknowledge) {
      return res.status(400).json({ code: 'FAIL', message: handled.message || 'FAIL' });
    }
    return res.json({ code: 'SUCCESS', message: '成功' });
  } catch (error) {
    console.error('微信支付异步通知处理失败', error);
    res.status(500).json({ code: 'FAIL', message: 'FAIL' });
  }
});

app.post('/api/orders/:orderId/cancel-pending', async function (req, res) {
  try {
    if (!ensureLoggedIn(req, res, '请先登录后再取消订单')) return;
    await cleanupExpiredPendingOrders(Date.now());
    const sourceOrderId = String(req.params.orderId || '').trim();
    const ownerUsername = req.currentUser.username;
    const order = await cancelPendingOrder(ownerUsername, sourceOrderId);
    res.json(order);
  } catch (error) {
    res.status(400).json({ message: error.message || '待支付订单取消失败', error: error.message });
  }
});

app.get('/api/refunds', async function (req, res) {
  try {
    if (!ensureAccess('admin')(req, res, '当前账号无权查看退款记录')) return;
    if (hasPagingQuery(req.query)) {
      const page = await listRefundRequestsPage({
        page: req.query && req.query.page,
        pageSize: req.query && req.query.pageSize,
        status: req.query && req.query.status,
        orderId: req.query && req.query.orderId,
        ownerUsername: req.query && req.query.ownerUsername,
        dateFrom: req.query && req.query.dateFrom,
        dateTo: req.query && req.query.dateTo
      });
      return res.json(page);
    }
    const refunds = await listRefundRequests({
      status: req.query && req.query.status,
      orderId: req.query && req.query.orderId,
      ownerUsername: req.query && req.query.ownerUsername,
      dateFrom: req.query && req.query.dateFrom,
      dateTo: req.query && req.query.dateTo
    });
    res.json(refunds);
  } catch (error) {
    res.status(500).json({ message: '获取退款申请失败', error: error.message });
  }
});

app.get('/api/payment-transactions', async function (req, res) {
  try {
    if (!ensureAccess('admin')(req, res, '当前账号无权查看支付流水')) return;
    if (hasPagingQuery(req.query)) {
      const page = await listPaymentTransactionsPage({
        page: req.query && req.query.page,
        pageSize: req.query && req.query.pageSize,
        orderId: req.query && req.query.orderId,
        username: req.query && req.query.username,
        status: req.query && req.query.status,
        dateFrom: req.query && req.query.dateFrom,
        dateTo: req.query && req.query.dateTo
      });
      return res.json(page);
    }
    const list = await listPaymentTransactions({
      orderId: req.query && req.query.orderId,
      username: req.query && req.query.username,
      status: req.query && req.query.status,
      dateFrom: req.query && req.query.dateFrom,
      dateTo: req.query && req.query.dateTo
    });
    res.json(list);
  } catch (error) {
    res.status(500).json({ message: '获取支付流水失败', error: error.message });
  }
});

app.get('/api/aftersales', async function (req, res) {
  try {
    if (!ensureAccess('admin')(req, res, '当前账号无权查看售后记录')) return;
    if (hasPagingQuery(req.query)) {
      const page = await listAftersaleRecordsPage({
        page: req.query && req.query.page,
        pageSize: req.query && req.query.pageSize,
        orderId: req.query && req.query.orderId,
        username: req.query && req.query.username,
        status: req.query && req.query.status,
        type: req.query && req.query.type,
        dateFrom: req.query && req.query.dateFrom,
        dateTo: req.query && req.query.dateTo
      });
      return res.json(page);
    }
    const list = await listAftersaleRecords({
      orderId: req.query && req.query.orderId,
      username: req.query && req.query.username,
      status: req.query && req.query.status,
      type: req.query && req.query.type,
      dateFrom: req.query && req.query.dateFrom,
      dateTo: req.query && req.query.dateTo
    });
    res.json(list);
  } catch (error) {
    res.status(500).json({ message: '获取售后记录失败', error: error.message });
  }
});

app.get('/api/inventory-logs', async function (req, res) {
  try {
    if (!ensureAccess('admin')(req, res, '当前账号无权查看库存流水')) return;
    if (hasPagingQuery(req.query)) {
      const page = await listInventoryLogsPage({
        page: req.query && req.query.page,
        pageSize: req.query && req.query.pageSize,
        orderId: req.query && req.query.orderId,
        username: req.query && req.query.username,
        operatorUsername: req.query && req.query.operatorUsername,
        actionType: req.query && req.query.actionType,
        status: req.query && req.query.status,
        dateFrom: req.query && req.query.dateFrom,
        dateTo: req.query && req.query.dateTo
      });
      return res.json(page);
    }
    const list = await listInventoryLogs({
      orderId: req.query && req.query.orderId,
      username: req.query && req.query.username,
      operatorUsername: req.query && req.query.operatorUsername,
      actionType: req.query && req.query.actionType,
      status: req.query && req.query.status,
      dateFrom: req.query && req.query.dateFrom,
      dateTo: req.query && req.query.dateTo
    });
    res.json(list);
  } catch (error) {
    res.status(500).json({ message: '获取库存流水失败', error: error.message });
  }
});

app.post('/api/orders/:orderId/refund-request', async function (req, res) {
  try {
    if (!ensureLoggedIn(req, res, '请先登录后再申请退款')) return;
    const sourceOrderId = String(req.params.orderId || '').trim();
    const ownerUsername = req.currentUser.username;
    const reason = String(req.body && req.body.reason || '').trim();
    const refund = await createRefundRequestForOrder(ownerUsername, sourceOrderId, reason);
    res.json(refund);
  } catch (error) {
    res.status(400).json({ message: error.message || '退款申请提交失败', error: error.message });
  }
});

app.post('/api/orders/:orderId/status', async function (req, res) {
  try {
    if (!ensureAccess('admin')(req, res, '当前账号无权更新订单状态')) return;
    const sourceOrderId = String(req.params.orderId || '').trim();
    const ownerUsername = String(req.body && req.body.ownerUsername || '').trim();
    const status = String(req.body && req.body.status || '').trim();
    const trackingNo = String(req.body && req.body.trackingNo || '').trim();
    if (!sourceOrderId || !ownerUsername || !status) return res.status(400).json({ message: '订单状态更新参数不完整' });
    let updated = null;
    if (status === 'shipped') {
      if (!trackingNo) return res.status(400).json({ message: '请先填写物流编号' });
      const order = await getOrderSnapshotByOwner(ownerUsername, sourceOrderId);
      if (!order) return res.status(404).json({ message: '订单不存在' });
      updated = await createShipmentForOrder(ownerUsername, sourceOrderId, {
        trackingNo: trackingNo,
        carrierCode: String(req.body && req.body.carrierCode || '').trim(),
        carrierName: String(req.body && req.body.carrierName || '').trim(),
        orderItemIds: (order.items || []).map(function (item) {
          return Number(item && item.orderItemId || 0);
        }).filter(function (item) {
          return item > 0;
        })
      }, req.currentUser && req.currentUser.username);
    } else {
      updated = await updateOrderSnapshotStatus(ownerUsername, sourceOrderId, status, trackingNo);
    }
    if (!updated) return res.status(404).json({ message: '订单不存在' });
    res.json(updated);
  } catch (error) {
    res.status(400).json({ message: error.message || '订单状态保存失败', error: error.message });
  }
});

app.post('/api/refunds/:refundId/reject', async function (req, res) {
  try {
    const refundId = String(req.params.refundId || '').trim();
    if (!ensureAccess('admin')(req, res, '当前账号无权驳回退款')) return;
    const actorUsername = req.currentUser.username;
    const rejectReason = String(req.body && req.body.rejectReason || '').trim();
    const refund = await rejectRefundRequest(refundId, actorUsername, rejectReason);
    res.json(refund);
  } catch (error) {
    res.status(400).json({ message: error.message || '退款驳回失败', error: error.message });
  }
});

app.post('/api/refunds/:refundId/complete', async function (req, res) {
  try {
    const refundId = String(req.params.refundId || '').trim();
    if (!ensureAccess('admin')(req, res, '当前账号无权完成退款')) return;
    const actorUsername = req.currentUser.username;
    const refund = await completeRefundRequest(refundId, actorUsername);
    res.json(refund);
  } catch (error) {
    res.status(400).json({ message: error.message || '退款完成失败', error: error.message });
  }
});

// [API_USERS_AUTH] 用户列表、登录注册、状态落库、角色授权都集中在这里。
app.get('/api/users', async function (req, res) {
  try {
    if (!ensureLoggedIn(req, res, '请先登录后再获取用户数据')) return;
    await cleanupExpiredPendingOrders(Date.now());
    if (hasPagingQuery(req.query)) {
      if (!ensureAccess('admin')(req, res, '当前账号无权查看用户列表')) return;
      const page = await listUserSummariesPage({
        page: req.query && req.query.page,
        pageSize: req.query && req.query.pageSize,
        keyword: req.query && req.query.keyword,
        roleType: req.query && (req.query.roleType || req.query.role),
        detailedUsername: req.query && req.query.detailedUsername
      });
      return res.json(page);
    }
    if (hasAccessLevel(req.currentUser, 'admin')) {
      const users = await listUsers();
      return res.json(users.map(selfUserRecord));
    }
    res.json([selfUserRecord(req.currentUser)]);
  } catch (error) {
    res.status(500).json({ message: '获取用户失败', error: error.message });
  }
});

app.get('/api/admin/light-stats', async function (req, res) {
  try {
    if (!ensureAccess('admin')(req, res, '当前账号无权查看后台统计')) return;
    await cleanupExpiredPendingOrders(Date.now());
    res.json(await getAdminLightStats());
  } catch (error) {
    res.status(500).json({ message: '获取后台轻量统计失败', error: error.message });
  }
});

app.post('/api/auth/login', async function (req, res) {
  try {
    const payload = req.body || {};
    const phone = normalizePhoneNumber(payload.phone || payload.username);
    const username = String(payload.username || '').trim();
    const password = String(payload.password || '');
    const usingPhoneLogin = isValidChinaMainlandPhone(phone);
    const loginIdentity = usingPhoneLogin ? phone : username;
    if (!loginIdentity || !password) {
      return res.status(400).json({ message: usingPhoneLogin || payload.phone ? '请填写手机号和密码' : '请填写用户名和密码' });
    }
    const rateLimitKey = getClientIp(req) + ':' + String(loginIdentity || '').trim().toLowerCase();
    const blockedMessage = getRateLimitBlockMessage(rateLimitKey);
    if (blockedMessage) return res.status(429).json({ message: blockedMessage });
    const user = usingPhoneLogin ? await getUserByPhone(phone) : await getUserByUsername(username);
    if (!user) {
      consumeRateLimitFailure(rateLimitKey);
      return res.status(401).json({ message: usingPhoneLogin ? '手机号或密码错误' : '用户名或密码错误' });
    }
    if (usingPhoneLogin && !userHasPassword(user)) {
      consumeRateLimitFailure(rateLimitKey);
      return res.status(401).json({ message: '该账号尚未设置登录密码，请先使用验证码登录' });
    }
    if (!verifyPassword(user.password, password)) {
      consumeRateLimitFailure(rateLimitKey);
      return res.status(401).json({ message: usingPhoneLogin ? '手机号或密码错误' : '用户名或密码错误' });
    }
    if (!isPasswordHash(user.password)) {
      user.password = hashPassword(password);
      await updateUser(user);
    }
    clearRateLimitFailures(rateLimitKey);
    const sessionId = await createSession(user.username);
    res.setHeader('Set-Cookie', buildSessionCookieValue(sessionId, req));
    res.json(selfUserRecord(await getUserByUsername(user.username)));
  } catch (error) {
    res.status(500).json({ message: '登录失败', error: error.message });
  }
});

app.post('/api/auth/login-sms', async function (req, res) {
  const payload = req.body || {};
  const phone = normalizePhoneNumber(payload.phone);
  const rateLimitKey = getClientIp(req) + ':sms:' + phone;
  try {
    if (!isValidChinaMainlandPhone(phone)) {
      return res.status(400).json({ message: '请输入正确的手机号' });
    }
    const blockedMessage = getRateLimitBlockMessage(rateLimitKey);
    if (blockedMessage) return res.status(429).json({ message: blockedMessage });
    const record = await verifySmsCodeOrThrow(phone, 'login_or_register', payload.code);
    let targetUser = await getUserByPhone(phone);
    let autoRegistered = false;
    if (!targetUser) {
      targetUser = await createPhoneFirstUser(phone);
      autoRegistered = true;
    }
    await consumeSmsVerificationRecord(record.id);
    clearRateLimitFailures(rateLimitKey);
    const sessionId = await createSession(targetUser.username);
    res.setHeader('Set-Cookie', buildSessionCookieValue(sessionId, req));
    res.json(Object.assign({
      ok: true,
      autoRegistered: autoRegistered,
      message: autoRegistered ? '注册并登录成功' : '登录成功'
    }, selfUserRecord(await getUserByUsername(targetUser.username))));
  } catch (error) {
    consumeRateLimitFailure(rateLimitKey);
    const status = /验证码|手机号/.test(String(error.message || '')) ? 400 : 500;
    res.status(status).json({ message: error.message || '验证码登录失败' });
  }
});

app.post('/api/auth/register', async function (req, res) {
  try {
    const username = String(req.body && req.body.username || '').trim();
    const password = String(req.body && req.body.password || '');
    if (!username || !password) return res.status(400).json({ message: '请填写用户名和密码' });
    if (username.length < 3) return res.status(400).json({ message: '用户名至少3个字符' });
    if (await getUserByUsername(username)) return res.status(409).json({ message: '用户名已存在' });
    const templates = await getCouponTemplateList();
    await insertUser(normalizeUserRecord({
      username: username,
      password: hashPassword(password),
      roles: { isFarmer: false, isAdmin: false, farmerName: username },
      addresses: [],
      coupons: templates.map(buildCouponFromTemplate),
      selectedAddressId: '',
      selectedCouponId: '',
      cart: [],
      orders: [],
      member: { levelId: 'normal', points: 0, totalSpent: 0 },
      createdAt: new Date().toLocaleDateString('zh-CN')
    }));
    const created = await getUserByUsername(username);
    const sessionId = await createSession(username);
    res.setHeader('Set-Cookie', buildSessionCookieValue(sessionId, req));
    res.json(selfUserRecord(created));
  } catch (error) {
    res.status(500).json({ message: '注册失败', error: error.message });
  }
});

app.post('/api/auth/change-password', async function (req, res) {
  try {
    if (!ensureLoggedIn(req, res, '请先登录后再修改密码')) return;
    const payload = req.body || {};
    const currentPassword = String(payload.currentPassword || '');
    const newPassword = String(payload.newPassword || '');
    const passwordError = validateNewPassword(newPassword);
    if (passwordError) return res.status(400).json({ message: passwordError });
    const latestUser = await getUserByUsername(req.currentUser.username);
    if (!latestUser) return res.status(404).json({ message: '当前用户不存在' });
    const hadPassword = userHasPassword(latestUser);
    if (hadPassword && !currentPassword) return res.status(400).json({ message: '请填写当前密码' });
    if (hadPassword && !verifyPassword(latestUser.password, currentPassword)) {
      return res.status(400).json({ message: '当前密码错误' });
    }
    latestUser.password = hashPassword(newPassword);
    await updateUser(latestUser);
    if (req.sessionId) {
      await deleteSessionsByUsername(latestUser.username);
      const sessionId = await createSession(latestUser.username);
      res.setHeader('Set-Cookie', buildSessionCookieValue(sessionId, req));
    }
    res.json({ ok: true, message: hadPassword ? '密码修改成功' : '登录密码设置成功' });
  } catch (error) {
    res.status(500).json({ message: '修改密码失败', error: error.message });
  }
});

app.post('/api/auth/send-sms-code', async function (req, res) {
  try {
    const payload = req.body || {};
    const purpose = normalizeSmsPurpose(payload.purpose);
    const phone = normalizePhoneNumber(payload.phone);
    if (!isValidChinaMainlandPhone(phone)) {
      return res.status(400).json({ message: '请输入正确的手机号' });
    }
    if (purpose === 'bind_phone') {
      if (!ensureLoggedIn(req, res, '请先登录后再绑定手机号')) return;
      const owner = await getUserByUsername(req.currentUser.username);
      if (!owner) return res.status(404).json({ message: '当前用户不存在' });
      const existingPhoneOwner = await getUserByPhone(phone);
      if (existingPhoneOwner && existingPhoneOwner.username !== owner.username) {
        return res.status(409).json({ message: '该手机号已绑定其他账号' });
      }
      const result = await issueSmsVerificationCode(phone, purpose, {
        username: owner.username,
        requestIp: getClientIp(req)
      });
      return res.json(Object.assign({ message: '验证码已发送，请注意查收' }, result));
    }
    if (purpose === 'login_or_register') {
      const targetUser = await getUserByPhone(phone);
      const result = await issueSmsVerificationCode(phone, purpose, {
        username: targetUser && targetUser.username ? targetUser.username : '',
        requestIp: getClientIp(req)
      });
      return res.json(Object.assign({
        message: targetUser ? '验证码已发送，请注意查收' : '验证码已发送，验证通过后将自动创建账号',
        autoRegisterOnVerify: !targetUser
      }, result));
    }
    const targetUser = await getUserByPhone(phone);
    if (!targetUser) return res.status(404).json({ message: '该手机号尚未绑定账号' });
    const result = await issueSmsVerificationCode(phone, purpose, {
      username: targetUser.username,
      requestIp: getClientIp(req)
    });
    res.json(Object.assign({ message: '验证码已发送，请注意查收' }, result));
  } catch (error) {
    const status = /已绑定|尚未绑定|已发送|频繁|手机号|配置不完整/.test(String(error.message || '')) ? 400 : 500;
    res.status(status).json({ message: error.message || '短信验证码发送失败' });
  }
});

app.post('/api/auth/bind-phone', async function (req, res) {
  try {
    if (!ensureLoggedIn(req, res, '请先登录后再绑定手机号')) return;
    const payload = req.body || {};
    const phone = normalizePhoneNumber(payload.phone);
    const record = await verifySmsCodeOrThrow(phone, 'bind_phone', payload.code);
    const latestUser = await getUserByUsername(req.currentUser.username);
    if (!latestUser) return res.status(404).json({ message: '当前用户不存在' });
    const existingPhoneOwner = await getUserByPhone(phone);
    if (existingPhoneOwner && existingPhoneOwner.username !== latestUser.username) {
      return res.status(409).json({ message: '该手机号已绑定其他账号' });
    }
    latestUser.phone = phone;
    latestUser.phoneVerifiedAt = Date.now();
    await updateUser(latestUser);
    await consumeSmsVerificationRecord(record.id);
    res.json(Object.assign({ ok: true, message: '手机号绑定成功' }, selfUserRecord(await getUserByUsername(latestUser.username))));
  } catch (error) {
    const status = /验证码|手机号|已绑定/.test(String(error.message || '')) ? 400 : 500;
    res.status(status).json({ message: error.message || '绑定手机号失败' });
  }
});

app.post('/api/auth/forgot-password/reset', async function (req, res) {
  try {
    const payload = req.body || {};
    const phone = normalizePhoneNumber(payload.phone);
    const newPassword = String(payload.newPassword || '');
    const passwordError = validateNewPassword(newPassword);
    if (passwordError) return res.status(400).json({ message: passwordError });
    const record = await verifySmsCodeOrThrow(phone, 'reset_password', payload.code);
    const targetUser = await getUserByPhone(phone);
    if (!targetUser) return res.status(404).json({ message: '该手机号尚未绑定账号' });
    targetUser.password = hashPassword(newPassword);
    await updateUser(targetUser);
    await consumeSmsVerificationRecord(record.id);
    await deleteSessionsByUsername(targetUser.username);
    res.json({ ok: true, message: '密码重置成功，请重新登录' });
  } catch (error) {
    const status = /验证码|手机号|密码/.test(String(error.message || '')) ? 400 : 500;
    res.status(status).json({ message: error.message || '重置密码失败' });
  }
});

app.get('/api/auth/me', async function (req, res) {
  try {
    if (!req.currentUser) return res.status(401).json({ message: '当前未登录' });
    res.json(selfUserRecord(req.currentUser));
  } catch (error) {
    res.status(500).json({ message: '获取当前登录用户失败', error: error.message });
  }
});

app.post('/api/auth/logout', async function (req, res) {
  try {
    if (req.sessionId) await deleteSession(req.sessionId);
    clearSessionCookie(res, req);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: '退出登录失败', error: error.message });
  }
});

app.post('/api/users/:username/state', async function (req, res) {
  try {
    const username = String(req.params.username || '').trim();
    if (!ensureLoggedIn(req, res, '请先登录后再保存资料')) return;
    if (!canManageTargetUser(req.currentUser, username)) {
      return res.status(403).json({ message: '当前账号无权保存该用户资料' });
    }
    const existing = await getUserByUsername(username);
    if (!existing) return res.status(404).json({ message: '用户不存在' });
    const payload = normalizeUserRecord(Object.assign({}, existing, req.body || {}, {
      username: username,
      password: existing.password,
      phone: existing.phone,
      phoneVerifiedAt: existing.phoneVerifiedAt
    }));
    if (!hasAccessLevel(req.currentUser, 'admin')) payload.roles = existing.roles;
    await updateUser(payload);
    await syncOrderDerivedRelations(username, existing.orders, payload.orders, normalizeAuditMeta(req.body && req.body._audit, {
      operatorUsername: req.currentUser.username,
      operatorRole: hasAccessLevel(req.currentUser, 'admin') ? 'admin' : 'buyer',
      channel: 'mock_h5'
    }));
    const updated = await getUserByUsername(username);
    res.json(selfUserRecord(updated));
  } catch (error) {
    res.status(500).json({ message: '保存用户数据失败', error: error.message });
  }
});

app.post('/api/users/:username/role', async function (req, res) {
  try {
    if (!ensureAccess('superadmin')(req, res, '只有超级管理员可以管理账号授权')) return;
    const username = String(req.params.username || '').trim();
    const existing = await getUserByUsername(username);
    if (!existing) return res.status(404).json({ message: '用户不存在' });
    if (username === 'admin') {
      const updatedAdmin = normalizeUserRecord(Object.assign({}, existing, {
        roles: normalizeRoleFlags('admin', existing.roles)
      }));
      if (JSON.stringify(updatedAdmin.roles) !== JSON.stringify(existing.roles)) {
        await updateUser(updatedAdmin);
      }
      return res.json(selfUserRecord(updatedAdmin));
    }
    const roleType = String(req.body && req.body.roleType || 'normal');
    existing.roles = { isFarmer: false, isAdmin: false, isSuperAdmin: false, farmerName: username };
    if (roleType === 'farmer') existing.roles.isFarmer = true;
    if (roleType === 'admin') existing.roles.isAdmin = true;
    await updateUser(existing);
    const updated = await getUserByUsername(username);
    res.json(selfUserRecord(updated));
  } catch (error) {
    res.status(500).json({ message: '保存用户权限失败', error: error.message });
  }
});

app.delete('/api/users/:username', async function (req, res) {
  try {
    if (!ensureAccess('superadmin')(req, res, '只有超级管理员可以删除用户')) return;
    const username = String(req.params.username || '').trim();
    if (!username) return res.status(400).json({ message: '用户名不能为空' });
    const result = await deleteUserAccount(username);
    if (!result.deleted) return res.status(404).json({ message: '用户不存在' });
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message || '删除用户失败', error: error.message });
  }
});

// [SPA_FALLBACK] 非 API 请求统一回退到前端单页入口。
app.get(/^(?!\/api).*/, function (req, res) {
  res.sendFile(htmlPath);
});

initDatabase()
  .then(function () {
    app.listen(port, host, function () {
      console.log('cloud-store server running on ' + host + ':' + port);
      startBackgroundLogisticsPolling();
    });
  })
  .catch(function (error) {
    console.error('init database failed:', error);
    process.exit(1);
  });
