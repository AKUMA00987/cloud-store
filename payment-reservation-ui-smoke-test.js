const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createClassList(initialValues) {
  const set = new Set(initialValues || []);
  return {
    add(value) { set.add(value); },
    remove(value) { set.delete(value); },
    toggle(value, force) {
      if (typeof force === 'boolean') {
        if (force) set.add(value);
        else set.delete(value);
        return force;
      }
      if (set.has(value)) {
        set.delete(value);
        return false;
      }
      set.add(value);
      return true;
    },
    contains(value) { return set.has(value); }
  };
}

function createElement(id) {
  return {
    id,
    value: '',
    innerHTML: '',
    textContent: '',
    src: '',
    files: [],
    style: { display: '' },
    classList: createClassList(id === 'admin-panel' || id === 'farmer-panel' ? ['hidden'] : []),
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener() { },
    focus() { }
  };
}

function createDocument() {
  const elements = {};
  return {
    getElementById(id) {
      if (!elements[id]) elements[id] = createElement(id);
      return elements[id];
    },
    createElement(tagName) {
      return createElement(tagName || 'div');
    }
  };
}

function createJsonResponse(payload, status) {
  const body = JSON.stringify(payload);
  return {
    ok: (status || 200) >= 200 && (status || 200) < 300,
    status: status || 200,
    async json() { return JSON.parse(body); },
    async text() { return body; }
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

async function main() {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf-8');
  const match = html.match(/<script>([\s\S]*?)<\/script>\s*<div id="admin-panel"/);
  if (!match) throw new Error('未找到前端内联脚本');

  const alerts = [];
  const fetchCalls = [];
  const storage = new Map();
  const document = createDocument();
  const navigatorState = { userAgent: 'Mozilla/5.0 Chrome/124 Safari/537.36' };

  [
    'app',
    'nav',
    'cart-badge',
    'modal-root',
    'admin-panel',
    'farmer-panel',
    'admin-db',
    'admin-refund',
    'admin-pd',
    'admin-od',
    'admin-category',
    'admin-ship',
    'admin-coupon',
    'admin-banner',
    'admin-auth',
    'farmer-content',
    'atab-db',
    'atab-refund',
    'atab-pd',
    'atab-od',
    'atab-category',
    'atab-ship',
    'atab-coupon',
    'atab-banner',
    'atab-auth'
  ].forEach(function (id) {
    document.getElementById(id);
  });
  document.getElementById('nav').style.display = 'flex';

  const categories = [{ id: 'veg', name: '新鲜蔬菜', icon: '🥬', sortOrder: 0, showOnHome: true }];
  const products = [
    {
      id: 1,
      name: '高山青菜',
      variants: [
        {
          id: 'veg-large',
          label: '大份',
          price: 26,
          units: [
            { id: 'large-bag', label: '袋装', stock: 4, deliveryFee: 5, sortOrder: 0, isDefault: true },
            { id: 'large-box', label: '箱装', stock: 2, deliveryFee: 8, sortOrder: 1, isDefault: false }
          ],
          sortOrder: 0,
          isDefault: true
        }
      ],
      price: 26,
      orig: 30,
      unit: '袋装',
      cat: 'veg',
      stock: 6,
      off: false,
      tags: ['有机'],
      sales: 5,
      farmer: '老李',
      farmerAccount: 'farmer_li',
      farmerUserId: 3,
      village: '青山村',
      harvest: '2026-04-08',
      dispatchHours: 6,
      shippingAddressId: 'ship_farmer',
      shippingAddressSnapshot: { id: 'ship_farmer', name: '老李', phone: '13800000001', full: '青山村 1 号' },
      img: 'https://example.com/veg.jpg',
      trace: []
    }
  ];

  const users = [
    {
      id: 1,
      username: 'buyer1',
      roles: { isFarmer: false, isAdmin: false, isSuperAdmin: false, farmerName: 'buyer1' },
      addresses: [{ id: 'addr1', name: '张三', phone: '13800000000', full: '测试收货地址' }],
      shippingAddresses: [],
      coupons: [],
      selectedAddressId: 'addr1',
      selectedCouponId: '',
      cart: [{
        id: 1,
        productId: 1,
        name: '高山青菜',
        variantId: 'veg-large',
        variantLabel: '大份',
        unitId: 'large-bag',
        unitLabel: '袋装',
        price: 26,
        unit: '袋装',
        img: 'https://example.com/veg.jpg',
        qty: 1
      }],
      orders: [],
      member: { levelId: 'normal', points: 0, totalSpent: 0 },
      createdAt: '2026/04/09'
    }
  ];

  let currentAuthUsername = 'buyer1';
  let prepareCounter = 0;
  const paymentTransactions = {};

  function getUser(username) {
    return users.find(function (item) { return item.username === username; }) || null;
  }

  function buildAllOrders() {
    return users.reduce(function (all, user) {
      return all.concat((user.orders || []).map(function (order) {
        return Object.assign({ owner: user.username }, cloneJson(order));
      }));
    }, []);
  }

  function syncProductStocks(product) {
    product.variants = (product.variants || []).map(function (variant) {
      const stock = (variant.units || []).reduce(function (sum, unit) { return sum + Number(unit.stock || 0); }, 0);
      return Object.assign({}, variant, { stock: stock });
    });
    product.stock = (product.variants || []).reduce(function (sum, variant) {
      return sum + Number(variant.stock || 0);
    }, 0);
  }

  function setProductUnitStock(productId, variantId, unitId, delta) {
    const product = products.find(function (item) { return Number(item.id || 0) === Number(productId || 0); });
    if (!product) return;
    product.variants = (product.variants || []).map(function (variant) {
      if (String(variant.id || '') !== String(variantId || '')) return Object.assign({}, variant);
      return Object.assign({}, variant, {
        units: (variant.units || []).map(function (unit) {
          if (String(unit.id || '') !== String(unitId || '')) return Object.assign({}, unit);
          return Object.assign({}, unit, { stock: Number(unit.stock || 0) + Number(delta || 0) });
        })
      });
    });
    syncProductStocks(product);
  }

  function getPaymentRuntimeMeta(preferredChannel) {
    const wechatBrowser = /micromessenger/i.test(String(navigatorState.userAgent || ''));
    const availableChannels = wechatBrowser
      ? ['alipay_wap', 'wechat_h5_inapp']
      : ['alipay_wap', 'wechat_h5_external'];
    return {
      availableChannels: availableChannels,
      recommendedChannel: availableChannels.indexOf(String(preferredChannel || '')) >= 0 ? String(preferredChannel || '') : availableChannels[0],
      wechatBrowser: wechatBrowser
    };
  }

  const sandbox = {
    console,
    Math,
    Date,
    JSON,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    URL,
    alert(message) {
      alerts.push(String(message));
    },
    confirm() {
      return true;
    },
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      }
    },
    location: { hash: '#/home' },
    window: {
      addEventListener() { },
      scrollTo() { },
      open() { },
      history: { back() { } },
      prompt() { return ''; },
      navigator: navigatorState
    },
    navigator: navigatorState,
    document,
    lucide: { createIcons() { } },
    FileReader: undefined,
    Image: function () { },
    setTimeout() { return 0; },
    clearTimeout() { },
    fetch: async function (url, options) {
      const parsed = new URL(String(url), 'http://127.0.0.1:3000');
      const method = String(options && options.method || 'GET').toUpperCase();
      const payload = options && options.body ? JSON.parse(options.body) : null;
      fetchCalls.push({ path: parsed.pathname, method: method, body: payload });

      if (parsed.pathname === '/api/auth/me' && method === 'GET') {
        const currentUser = getUser(currentAuthUsername);
        return currentUser ? createJsonResponse(cloneJson(currentUser)) : createJsonResponse({ message: '未登录' }, 401);
      }
      if (parsed.pathname === '/api/products' && method === 'GET' && parsed.searchParams.get('page')) {
        return createJsonResponse({
          items: cloneJson(products),
          meta: { page: 1, pageSize: Number(parsed.searchParams.get('pageSize') || products.length || 1), totalCount: products.length, totalPages: 1, hasPrev: false, hasNext: false }
        });
      }
      if (/^\/api\/products\/\d+$/.test(parsed.pathname) && method === 'GET') {
        const productId = Number(parsed.pathname.split('/').pop() || 0);
        const product = products.find(function (item) { return Number(item.id || 0) === productId; });
        return createJsonResponse(cloneJson(product || { message: 'not found' }), product ? 200 : 404);
      }
      if (parsed.pathname === '/api/products' && method === 'GET') return createJsonResponse(cloneJson(products));
      if (parsed.pathname === '/api/categories' && method === 'GET') return createJsonResponse(cloneJson(categories));
      if (parsed.pathname === '/api/banners' && method === 'GET') return createJsonResponse([]);
      if (parsed.pathname === '/api/announcements' && method === 'GET') return createJsonResponse([]);
      if (parsed.pathname === '/api/coupon-templates' && method === 'GET') return createJsonResponse([]);
      if (parsed.pathname === '/api/refunds' && method === 'GET') return createJsonResponse([]);
      if (parsed.pathname === '/api/payment-transactions' && method === 'GET') return createJsonResponse([]);
      if (parsed.pathname === '/api/aftersales' && method === 'GET') return createJsonResponse([]);
      if (parsed.pathname === '/api/inventory-logs' && method === 'GET') return createJsonResponse([]);
      if (parsed.pathname === '/api/orders' && method === 'GET') return createJsonResponse(buildAllOrders());
      if (parsed.pathname === '/api/users' && method === 'GET' && parsed.search) {
        return createJsonResponse({ items: cloneJson(users), meta: { page: 1, pageSize: users.length || 1, totalCount: users.length, totalPages: 1, hasPrev: false, hasNext: false } });
      }
      if (parsed.pathname === '/api/users' && method === 'GET') {
        const currentListUser = getUser(currentAuthUsername);
        return createJsonResponse(currentListUser ? [cloneJson(currentListUser)] : [], currentListUser ? 200 : 401);
      }

      const stateMatch = parsed.pathname.match(/^\/api\/users\/([^/]+)\/state$/);
      if (stateMatch && method === 'POST') {
        const username = decodeURIComponent(stateMatch[1]);
        const target = getUser(username);
        Object.assign(target, cloneJson(payload || {}));
        return createJsonResponse(cloneJson(target));
      }

      if (parsed.pathname === '/api/orders/prepare-payment' && method === 'POST') {
        prepareCounter += 1;
        const owner = getUser(currentAuthUsername);
        const order = Object.assign({
          id: 'ORD_PENDING_' + prepareCounter,
          owner: currentAuthUsername,
          items: cloneJson(payload.items || []),
          subtotal: Number(payload.subtotal || 0),
          deliveryFee: Number(payload.deliveryFee || 0),
          discount: Number(payload.discount || 0),
          total: Number(payload.total || 0),
          status: 'pending',
          time: Date.now(),
          address: cloneJson(payload.address || {}),
          coupon: String(payload.couponText || ''),
          couponId: String(payload.couponId || ''),
          trackingNo: '',
          reserveExpiresAt: Date.now() + 600000,
          inventoryReleased: false,
          inventoryReleasedAt: 0,
          cancelReason: ''
        }, getPaymentRuntimeMeta(''));
        owner.orders = [order].concat(owner.orders || []);
        paymentTransactions[order.id] = {
          id: currentAuthUsername + ':' + order.id,
          orderId: order.id,
          status: 'pending',
          channel: '',
          externalTradeNo: currentAuthUsername + ':' + order.id,
          gatewayTradeNo: '',
          returnCheckedAt: 0
        };
        (payload.items || []).forEach(function (item) {
          setProductUnitStock(item.productId || item.id, item.variantId, item.unitId, -Number(item.qty || 0));
        });
        return createJsonResponse(cloneJson(order));
      }

      const alipayLaunchMatch = parsed.pathname.match(/^\/api\/orders\/([^/]+)\/alipay-wap$/);
      if (alipayLaunchMatch && method === 'POST') {
        const orderId = decodeURIComponent(alipayLaunchMatch[1]);
        const transaction = paymentTransactions[orderId];
        if (transaction) transaction.channel = 'alipay_wap';
        return createJsonResponse({
          orderId: orderId,
          channel: 'alipay_wap',
          availableChannels: getPaymentRuntimeMeta('alipay_wap').availableChannels,
          recommendedChannel: 'alipay_wap',
          gateway: 'https://openapi.alipay.com/gateway.do',
          method: 'POST',
          params: {
            app_id: '2021006146624607',
            method: 'alipay.trade.wap.pay',
            charset: 'utf-8',
            sign_type: 'RSA2',
            product_code: 'QUICK_WAP_PAY',
            return_url: 'https://putiguoguo.com/#/paymentResult?orderId=' + encodeURIComponent(orderId)
          },
          paymentTransaction: cloneJson(transaction || {})
        });
      }

      const wechatInAppLaunchMatch = parsed.pathname.match(/^\/api\/orders\/([^/]+)\/wechat-inapp-h5$/);
      if (wechatInAppLaunchMatch && method === 'POST') {
        const orderId = decodeURIComponent(wechatInAppLaunchMatch[1]);
        const transaction = paymentTransactions[orderId];
        if (transaction) transaction.channel = 'wechat_h5_inapp';
        return createJsonResponse({
          orderId: orderId,
          channel: 'wechat_h5_inapp',
          availableChannels: getPaymentRuntimeMeta('wechat_h5_inapp').availableChannels,
          recommendedChannel: 'wechat_h5_inapp',
          gateway: 'https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi',
          method: 'POST',
          params: {
            trade_type: 'JSAPI',
            redirect_url: 'https://putiguoguo.com/#/paymentResult?orderId=' + encodeURIComponent(orderId)
          },
          paymentTransaction: cloneJson(transaction || {})
        });
      }

      const wechatExternalLaunchMatch = parsed.pathname.match(/^\/api\/orders\/([^/]+)\/wechat-external-h5$/);
      if (wechatExternalLaunchMatch && method === 'POST') {
        const orderId = decodeURIComponent(wechatExternalLaunchMatch[1]);
        const transaction = paymentTransactions[orderId];
        if (transaction) transaction.channel = 'wechat_h5_external';
        return createJsonResponse({
          orderId: orderId,
          channel: 'wechat_h5_external',
          availableChannels: getPaymentRuntimeMeta('wechat_h5_external').availableChannels,
          recommendedChannel: 'wechat_h5_external',
          gateway: 'https://api.mch.weixin.qq.com/v3/pay/transactions/h5',
          method: 'POST',
          params: {
            trade_type: 'H5',
            redirect_url: 'https://putiguoguo.com/#/paymentResult?orderId=' + encodeURIComponent(orderId)
          },
          paymentTransaction: cloneJson(transaction || {})
        });
      }

      const paymentStatusMatch = parsed.pathname.match(/^\/api\/orders\/([^/]+)\/payment-status$/);
      if (paymentStatusMatch && method === 'GET') {
        const orderId = decodeURIComponent(paymentStatusMatch[1]);
        const owner = getUser(currentAuthUsername);
        const order = (owner.orders || []).find(function (item) { return item.id === orderId; });
        const transaction = paymentTransactions[orderId] || null;
        if (transaction && parsed.searchParams.get('returnCheck')) {
          transaction.returnCheckedAt = Date.now();
        }
        return createJsonResponse({
          order: cloneJson(order ? Object.assign({}, order, getPaymentRuntimeMeta(transaction && transaction.channel)) : {}),
          paymentTransaction: cloneJson(transaction || {}),
          awaitingAsyncNotify: !!(order && order.status === 'pending' && transaction && ['alipay_wap', 'wechat_h5_inapp', 'wechat_h5_external'].indexOf(transaction.channel) >= 0 && transaction.status === 'pending'),
          isFinal: !!(order && (order.status !== 'pending' || order.inventoryReleased))
        }, order ? 200 : 404);
      }

      const cancelMatch = parsed.pathname.match(/^\/api\/orders\/([^/]+)\/cancel-pending$/);
      if (cancelMatch && method === 'POST') {
        const orderId = decodeURIComponent(cancelMatch[1]);
        const owner = getUser(currentAuthUsername);
        const order = (owner.orders || []).find(function (item) { return item.id === orderId; });
        Object.assign(order, {
          status: 'cancelled',
          inventoryReleased: true,
          inventoryReleasedAt: Date.now(),
          cancelReason: 'buyer_pending_cancel'
        });
        if (paymentTransactions[orderId]) paymentTransactions[orderId].status = 'cancelled';
        (order.items || []).forEach(function (item) {
          setProductUnitStock(item.productId || item.id, item.variantId, item.unitId, Number(item.qty || 0));
        });
        return createJsonResponse(cloneJson(order));
      }

      if (parsed.pathname === '/api/auth/logout' && method === 'POST') {
        currentAuthUsername = '';
        return createJsonResponse({ ok: true });
      }
      return createJsonResponse({ message: 'not found' }, 404);
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(match[1], sandbox, { filename: 'index.html<script>' });

  async function flush(times) {
    for (let index = 0; index < (times || 6); index += 1) {
      await Promise.resolve();
      await new Promise(function (resolve) { setImmediate(resolve); });
    }
  }

  function exec(code) {
    return vm.runInContext(code, sandbox);
  }

  async function execAsync(code) {
    return vm.runInContext('(async function(){' + code + '})()', sandbox);
  }

  await flush(8);

  await execAsync('await pushView("confirmOrder");');
  await flush(4);
  await execAsync('await confirmCheckout();');
  await flush(4);

  const prepareCall = fetchCalls.find(function (item) {
    return item.path === '/api/orders/prepare-payment' && item.method === 'POST';
  });
  assert(prepareCall, '确认订单时应请求服务端创建待支付订单');
  assert(prepareCall.body.items[0].variantId === 'veg-large', '待支付下单应带上规格 ID');
  assert(prepareCall.body.items[0].unitId === 'large-bag', '待支付下单应带上单位 ID');
  assert(prepareCall.body.items[0].unitLabel === '袋装', '待支付下单应带上单位名称');
  assert(prepareCall.body.items[0].deliveryFee === 5, '待支付下单应带上所选单位的配送费');
  assert(prepareCall.body.deliveryFee === 5, '待支付下单应按所选单位汇总配送费');
  assert(exec('currentCheckoutOrder && currentCheckoutOrder.items[0].unitId') === 'large-bag', '待支付订单快照应保留单位 ID');
  assert(products[0].variants[0].units.find(function (unit) { return unit.id === 'large-bag'; }).stock === 3, '进入支付后应立即预占单位库存');
  assert(exec("paymentPage().indexOf('支付宝支付') >= 0") === true, '非微信环境下主按钮应默认推荐支付宝支付');
  assert(exec("paymentPage().indexOf('更多支付方式') >= 0") === true, '非微信环境下应提供更多支付方式入口');
  exec(`
    (function () {
      var refreshed = Object.assign({}, currentCheckoutOrder);
      delete refreshed.availableChannels;
      delete refreshed.recommendedChannel;
      delete refreshed.wechatBrowser;
      updateBuyerOrderCache(refreshed);
    })();
  `);
  assert(exec("paymentPage().indexOf('更多支付方式') >= 0") === true, '支付页刷新后的订单快照缺少通道字段时也应保留更多支付方式入口');
  assert(exec('getRecommendedPaymentChannel(currentCheckoutOrder)') === 'alipay_wap', '支付页刷新后的订单快照缺少通道字段时应保留原推荐支付方式');

  await execAsync('await startRecommendedPayment();');
  await flush(4);
  const alipayCall = fetchCalls.find(function (item) {
    return /\/api\/orders\/ORD_PENDING_1\/alipay-wap$/.test(item.path) && item.method === 'POST';
  });
  assert(alipayCall, '非微信环境默认支付应请求服务端发起支付宝 WAP 支付');
  assert(fetchCalls.every(function (item) { return !/\/pay$/.test(item.path); }), '支付 UI 默认主路径不应再调用 /pay mock 支付接口');
  assert(exec('window.__lastPaymentLaunch && window.__lastPaymentLaunch.params.method') === 'alipay.trade.wap.pay', '支付宝主按钮应准备支付宝手机网站支付表单');
  assert(exec('window.__lastPaymentLaunch && window.__lastPaymentLaunch.params.product_code') === 'QUICK_WAP_PAY', '支付宝主按钮应准备正确的 QUICK_WAP_PAY 产品编码');
  assert(exec('window.__lastPaymentLaunch && window.__lastPaymentLaunch.method') === 'GET', '支付宝主按钮应改为通过 query string 跳转网关');
  assert(exec('window.__lastPaymentLaunch && window.__lastPaymentLaunch.submissionMode') === 'query', '支付宝主按钮应把参数拼进 query string');
  assert(exec('window.__lastPaymentLaunch && window.__lastPaymentLaunch.url && window.__lastPaymentLaunch.url.indexOf("charset=utf-8") >= 0') === true, '支付宝跳转 URL 中应显式包含 charset=utf-8');
  assert(exec('window.__lastPaymentLaunch && window.__lastPaymentLaunch.acceptCharset') === 'utf-8', '支付宝主按钮应显式按 utf-8 提交网关表单');

  getUser('buyer1').orders[0].status = 'paid';
  getUser('buyer1').cart = [];
  paymentTransactions['ORD_PENDING_1'].status = 'paid';
  paymentTransactions['ORD_PENDING_1'].channel = 'alipay_wap';
  paymentTransactions['ORD_PENDING_1'].gatewayTradeNo = '202604120000000001';
  await execAsync('await syncPaymentResultStatus({ orderId: "ORD_PENDING_1", returnCheck: true, force: true });');
  await flush(6);
  assert(exec('paymentResultState.order && paymentResultState.order.status') === 'paid', '支付宝支付结果页应通过只读查询拿到已支付状态');
  assert(exec("paymentResultPage().indexOf('支付宝手机网站支付') >= 0") === true, '支付结果页应展示支付宝渠道文案');
  assert(exec('cart.length') === 0, '支付结果确认后应清空购物车');
  assert(products[0].variants[0].units.find(function (unit) { return unit.id === 'large-bag'; }).stock === 3, '支付宝支付成功后不应二次扣减单位库存');

  exec('window.navigator.userAgent = navigator.userAgent = "Mozilla/5.0 MicroMessenger"; cart = [normalizeCartStateItem({ id: 1, productId: 1, name: "高山青菜", variantId: "veg-large", variantLabel: "大份", unitId: "large-bag", unitLabel: "袋装", unit: "袋装", price: 26, img: "https://example.com/veg.jpg", qty: 1 })]; updateCartBadge();');
  await execAsync('await confirmCheckout();');
  await flush(4);
  assert(exec("paymentPage().indexOf('支付宝支付') >= 0") === true, '微信环境下主按钮仍应默认推荐支付宝支付');
  assert(exec("paymentPage().indexOf('更多支付方式') >= 0") === true, '微信环境下仍应保留更多支付方式入口');

  await execAsync('await startRecommendedPayment();');
  await flush(4);
  const wechatEnvAlipayCall = fetchCalls.find(function (item) {
    return /\/api\/orders\/ORD_PENDING_2\/alipay-wap$/.test(item.path) && item.method === 'POST';
  });
  assert(wechatEnvAlipayCall, '微信环境主按钮应继续请求服务端发起支付宝 WAP 支付');
  assert(exec('window.__lastPaymentLaunch && window.__lastPaymentLaunch.params.method') === 'alipay.trade.wap.pay', '微信环境的支付宝主按钮应准备支付宝手机网站支付表单');
  assert(exec('window.__lastPaymentLaunch && window.__lastPaymentLaunch.params.product_code') === 'QUICK_WAP_PAY', '微信环境的支付宝主按钮也应准备正确的 QUICK_WAP_PAY 产品编码');
  assert(exec('window.__lastPaymentLaunch && window.__lastPaymentLaunch.method') === 'GET', '微信环境的支付宝主按钮也应通过 query string 跳转网关');
  assert(exec('window.__lastPaymentLaunch && window.__lastPaymentLaunch.submissionMode') === 'query', '微信环境的支付宝主按钮也应把参数拼进 query string');
  assert(exec('window.__lastPaymentLaunch && window.__lastPaymentLaunch.url && window.__lastPaymentLaunch.url.indexOf("charset=utf-8") >= 0') === true, '微信环境的支付宝跳转 URL 中也应显式包含 charset=utf-8');
  assert(exec('window.__lastPaymentLaunch && window.__lastPaymentLaunch.acceptCharset') === 'utf-8', '微信环境的支付宝表单也应显式按 utf-8 提交');

  await execAsync('toggleMorePaymentChannels();');
  await flush(2);
  assert(exec("paymentPage().indexOf('微信支付（微信内 H5）') >= 0") === true, '微信环境的更多支付方式中应展示微信内 H5');

  await execAsync('await startSecondaryPaymentChannel("wechat_h5_inapp");');
  await flush(4);
  const wechatInAppCall = fetchCalls.find(function (item) {
    return /\/api\/orders\/ORD_PENDING_2\/wechat-inapp-h5$/.test(item.path) && item.method === 'POST';
  });
  assert(wechatInAppCall, '微信环境应能从更多支付方式发起微信内 H5 支付');
  assert(exec('window.__lastPaymentLaunch && window.__lastPaymentLaunch.params.trade_type') === 'JSAPI', '微信内 H5 支付应准备 JSAPI 合约参数');

  getUser('buyer1').orders.find(function (item) { return item.id === 'ORD_PENDING_2'; }).status = 'paid';
  getUser('buyer1').cart = [];
  paymentTransactions['ORD_PENDING_2'].status = 'paid';
  paymentTransactions['ORD_PENDING_2'].channel = 'wechat_h5_inapp';
  paymentTransactions['ORD_PENDING_2'].gatewayTradeNo = 'wx202604120000000001';
  await execAsync('await syncPaymentResultStatus({ orderId: "ORD_PENDING_2", returnCheck: true, force: true });');
  await flush(6);
  assert(exec("paymentResultPage().indexOf('微信内 H5 支付') >= 0") === true, '支付结果页应展示微信内 H5 渠道文案');
  assert(products[0].variants[0].units.find(function (unit) { return unit.id === 'large-bag'; }).stock === 2, '第二笔支付成功后库存应继续保持预占后的结果');

  exec('window.navigator.userAgent = navigator.userAgent = "Mozilla/5.0 Chrome/124 Safari/537.36"; cart = [normalizeCartStateItem({ id: 1, productId: 1, name: "高山青菜", variantId: "veg-large", variantLabel: "大份", unitId: "large-bag", unitLabel: "袋装", unit: "袋装", price: 26, img: "https://example.com/veg.jpg", qty: 1 })]; updateCartBadge();');
  await execAsync('await confirmCheckout();');
  await flush(4);
  await execAsync('toggleMorePaymentChannels();');
  await flush(2);
  assert(exec("paymentPage().indexOf('微信支付（微信外 H5）') >= 0") === true, '非微信环境的更多支付方式中应展示微信外 H5');

  await execAsync('await startSecondaryPaymentChannel("wechat_h5_external");');
  await flush(4);
  const wechatExternalCall = fetchCalls.find(function (item) {
    return /\/api\/orders\/ORD_PENDING_3\/wechat-external-h5$/.test(item.path) && item.method === 'POST';
  });
  assert(wechatExternalCall, '更多支付方式应能发起微信外 H5 支付');
  assert(exec('window.__lastPaymentLaunch && window.__lastPaymentLaunch.params.trade_type') === 'H5', '微信外 H5 支付应准备 H5 合约参数');

  getUser('buyer1').orders.find(function (item) { return item.id === 'ORD_PENDING_3'; }).status = 'paid';
  getUser('buyer1').cart = [];
  paymentTransactions['ORD_PENDING_3'].status = 'paid';
  paymentTransactions['ORD_PENDING_3'].channel = 'wechat_h5_external';
  paymentTransactions['ORD_PENDING_3'].gatewayTradeNo = 'wx202604120000000002';
  await execAsync('await syncPaymentResultStatus({ orderId: "ORD_PENDING_3", returnCheck: true, force: true });');
  await flush(6);
  assert(exec("paymentResultPage().indexOf('微信外 H5 支付') >= 0") === true, '支付结果页应展示微信外 H5 渠道文案');
  assert(products[0].variants[0].units.find(function (unit) { return unit.id === 'large-bag'; }).stock === 1, '三笔支付完成后库存应反映真实锁定结果');

  exec('cart = [normalizeCartStateItem({ id: 1, productId: 1, name: "高山青菜", variantId: "veg-large", variantLabel: "大份", unitId: "large-box", unitLabel: "箱装", unit: "箱装", price: 26, img: "https://example.com/veg.jpg", qty: 1 })]; updateCartBadge();');
  assert(exec('cartPage().indexOf(\'配送费</span><span class="text-gray-500">¥8.00</span>\') >= 0') === true, '购物车页应按当前单位展示配送费，而不是固定 5 元');
  await execAsync('await confirmCheckout();');
  await flush(4);
  assert(exec('currentCheckoutOrder && currentCheckoutOrder.deliveryFee') === 8, '切换到不同单位后应使用该单位配置的配送费');
  assert(products[0].variants[0].units.find(function (unit) { return unit.id === 'large-box'; }).stock === 1, '第四笔待支付订单应预占对应单位库存');

  await execAsync('await cancelOrder(0);');
  await flush(6);
  assert(products[0].variants[0].units.find(function (unit) { return unit.id === 'large-box'; }).stock === 2, '取消待支付订单后应恢复单位库存');
  assert(getUser('buyer1').orders.find(function (order) { return order.cancelReason === "buyer_pending_cancel"; }), '取消待支付订单应记录取消原因');

  products[0].variants[0].units.find(function (unit) { return unit.id === 'large-bag'; }).deliveryFee = 0;
  products[0].variants[0].units.find(function (unit) { return unit.id === 'large-bag'; }).stock = 5;
  exec(`
    cart = [normalizeCartStateItem({
      id: 1,
      productId: 1,
      name: "高山青菜",
      variantId: "veg-large",
      variantLabel: "大份",
      unitId: "large-bag",
      unitLabel: "袋装",
      unit: "袋装",
      price: 26,
      deliveryFee: 5,
      img: "https://example.com/veg.jpg",
      qty: 1
    })];
    view = "product";
    paramId = 1;
    selectedVariantState[1] = { variantId: "veg-large", unitId: "large-bag" };
    updateCartBadge();
  `);
  await execAsync('await addToCart(1, { alertSuccess: false });');
  await flush(4);
  assert(exec('cart[0].qty') === 2, '重复加入同一单位时应继续累加数量');
  assert(exec('cart[0].deliveryFee') === 0, '重复加入同一单位时应把旧购物车条目的配送费刷新成当前商品单位真相');
  await execAsync('await pushView("confirmOrder");');
  await flush(4);
  await execAsync('await confirmCheckout();');
  await flush(4);
  assert(exec('currentCheckoutOrder && currentCheckoutOrder.deliveryFee') === 0, '旧购物车条目在重新加购后应按当前商品单位配送费 0 元创建待支付订单');

  products[0].variants[0].units.find(function (unit) { return unit.id === 'large-bag'; }).deliveryFee = 5;
  products[0].variants[0].units.find(function (unit) { return unit.id === 'large-bag'; }).isDefault = true;
  products[0].variants[0].units.find(function (unit) { return unit.id === 'large-box'; }).deliveryFee = 8;
  products[0].variants[0].units.find(function (unit) { return unit.id === 'large-box'; }).isDefault = false;
  exec('cart = []; selectedVariantState = {}; updateCartBadge();');
  await execAsync('await pushView("product", 1);');
  await flush(4);
  assert(exec('getSelectedUnitForProduct(getProds()[0], { autoSingle: false }).id') === 'large-bag', '单规格商品首次进入详情时应先跟随当前默认单位');

  products[0].variants[0].units.find(function (unit) { return unit.id === 'large-bag'; }).isDefault = false;
  products[0].variants[0].units.find(function (unit) { return unit.id === 'large-box'; }).isDefault = true;
  await execAsync('await fetchProductDetail(1);');
  await execAsync('await pushView("product", 1);');
  await flush(4);
  assert(exec('getSelectedUnitForProduct(getProds()[0], { autoSingle: false }).id') === 'large-box', '默认单位切换后，买家端应跟随新的默认单位而不是黏住旧默认');
  assert(((exec('product(1)').match(/choice-pill warm active/g) || []).length) === 1, '默认单位切换后，买家端单位按钮不应出现多个同时点亮');
  await execAsync('await addToCart(1, { alertSuccess: false });');
  await flush(4);
  assert(exec('cart[0].unitId') === 'large-box', '默认单位切换后重新加购应使用新的默认单位 ID');
  assert(exec('cart[0].deliveryFee') === 8, '默认单位切换后重新加购应带上新的单位配送费');

  exec('cart = [normalizeCartStateItem({ id: 1, productId: 1, name: "高山青菜", variantId: "veg-large", variantLabel: "大份", unitId: "large-bag", unitLabel: "袋装", unit: "袋装", price: 26, deliveryFee: 5, img: "https://example.com/veg.jpg", qty: 1 })]; updateCartBadge();');
  products[0].variants[0].units.find(function (unit) { return unit.id === 'large-bag'; }).deliveryFee = 10;
  await execAsync('await go("cart");');
  await flush(6);
  assert(exec('cart[0].deliveryFee') === 10, '进入购物车时应把旧购物车条目的配送费刷新成服务端最新商品真相');
  assert(exec('buildCheckoutSummary(getUserMeta()).deliveryFee') === 10, '购物车汇总应跟随服务端最新单位配送费，而不是继续显示旧的 5 元');

  console.log('Payment reservation UI smoke test passed.');
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
