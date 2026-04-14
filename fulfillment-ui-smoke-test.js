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
    href: '',
    download: '',
    src: '',
    files: [],
    style: { display: '' },
    classList: createClassList(id === 'admin-panel' || id === 'farmer-panel' ? ['hidden'] : []),
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener() { },
    removeEventListener() { },
    appendChild() { },
    removeChild() { },
    focus() { },
    click() {
      this.__clicked = true;
    }
  };
}

function createDocument() {
  const elements = {};
  return {
    body: createElement('body'),
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
    headers: {
      get() { return null; }
    },
    async json() { return JSON.parse(body); },
    async text() { return body; },
    async blob() { return Buffer.from(body, 'utf8'); }
  };
}

function createBlobResponse(text, options) {
  const config = options || {};
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        const key = String(name || '').toLowerCase();
        if (key === 'content-type') return config.contentType || 'text/csv; charset=utf-8';
        if (key === 'content-disposition') return config.contentDisposition || 'attachment; filename="orders-export-test.csv"';
        return null;
      }
    },
    async text() { return text; },
    async json() { return JSON.parse(text); },
    async blob() { return Buffer.from(text, 'utf8'); }
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

async function main() {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>\s*<div id="admin-panel"/);
  if (!match) throw new Error('未找到前端内联脚本');

  const document = createDocument();
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

  const exportRequests = [];
  const currentUser = {
    id: 1,
    username: 'admin',
    phone: '13800000000',
    phoneVerifiedAt: Date.now(),
    roles: { isFarmer: true, isAdmin: true, isSuperAdmin: true, farmerName: '管理员' },
    addresses: [],
    shippingAddresses: [{ id: 'ship_addr_1', name: '仓库甲', phone: '13811112222', full: '测试仓库 1 号' }],
    coupons: [],
    selectedAddressId: '',
    selectedCouponId: '',
    cart: [],
    orders: [],
    member: { levelId: 'normal', points: 0, totalSpent: 0 },
    createdAt: '2026/04/13'
  };
  const buyerUser = {
    id: 2,
    username: 'buyerA',
    phone: '13900001111',
    phoneVerifiedAt: Date.now(),
    roles: { isFarmer: false, isAdmin: false, isSuperAdmin: false, farmerName: 'buyerA' },
    addresses: [{ id: 'buyer_addr_1', name: '张三', phone: '13900001111', full: '测试收货地址' }],
    shippingAddresses: [],
    coupons: [],
    selectedAddressId: 'buyer_addr_1',
    selectedCouponId: '',
    cart: [],
    orders: [],
    member: { levelId: 'normal', points: 0, totalSpent: 0 },
    createdAt: '2026/04/13'
  };
  const sampleOrder = {
    id: 'order_relation_17',
    sourceId: 'ORD-001',
    owner: 'buyerA',
    ownerDeleted: false,
    status: 'shipped',
    time: Date.now(),
    total: 38,
    subtotal: 33,
    deliveryFee: 5,
    discount: 0,
    address: { name: '张三', phone: '13900001111', full: '测试收货地址' },
    items: [
      {
        orderItemId: 101,
        id: 501,
        productId: 501,
        name: '白萝卜',
        qty: 1,
        price: 18,
        img: 'https://example.com/a.png',
        variantLabel: '标准规格',
        unit: '斤',
        unitLabel: '斤',
        shippingAddressSnapshot: { name: '仓库甲', phone: '13811112222', full: '测试仓库 1 号' }
      },
      {
        orderItemId: 102,
        id: 502,
        productId: 502,
        name: '青菜',
        qty: 1,
        price: 15,
        img: 'https://example.com/b.png',
        variantLabel: '精品规格',
        unit: '把',
        unitLabel: '把',
        shippingAddressSnapshot: { name: '仓库乙', phone: '13833334444', full: '测试仓库 2 号' }
      }
    ],
    shipments: [
      {
        id: 'ship_17_1',
        trackingNo: 'YT123456789CN',
        carrierCode: 'yto',
        carrierName: '圆通快递',
        status: 'shipped',
        logisticsSummary: '运输中，下一站杭州分拨中心',
        orderItemIds: [101, 102],
        items: [
          {
            orderItemId: 101,
            id: 501,
            productId: 501,
            name: '白萝卜',
            qty: 1,
            price: 18,
            img: 'https://example.com/a.png',
            variantLabel: '标准规格',
            unit: '斤',
            unitLabel: '斤',
            shippingAddressSnapshot: { name: '仓库甲', phone: '13811112222', full: '测试仓库 1 号' }
          },
          {
            orderItemId: 102,
            id: 502,
            productId: 502,
            name: '青菜',
            qty: 1,
            price: 15,
            img: 'https://example.com/b.png',
            variantLabel: '精品规格',
            unit: '把',
            unitLabel: '把',
            shippingAddressSnapshot: { name: '仓库乙', phone: '13833334444', full: '测试仓库 2 号' }
          }
        ],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: 'admin',
        legacySource: ''
      }
    ],
    fulfillmentSummary: {
      shipmentCount: 1,
      assignedItemCount: 2,
      totalItemCount: 2,
      unassignedItemCount: 0
    }
  };

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
    Blob,
    alert() { },
    confirm() { return true; },
    localStorage: {
      getItem() { return null; },
      setItem() { },
      removeItem() { }
    },
    location: { hash: '#/profile' },
    window: {
      addEventListener() { },
      removeEventListener() { },
      scrollTo() { },
      open() { },
      URL: {
        createObjectURL() { return 'blob:orders-export'; },
        revokeObjectURL() { }
      },
      history: { back() { } },
      prompt() { return ''; }
    },
    document,
    lucide: { createIcons() { } },
    FileReader: undefined,
    Image: function () { },
    setTimeout() { return 0; },
    clearTimeout() { },
    fetch: async function (url, options) {
      const parsed = new URL(String(url), 'http://127.0.0.1:3000');
      const method = String(options && options.method || 'GET').toUpperCase();

      if (parsed.pathname === '/api/auth/me' && method === 'GET') return createJsonResponse(currentUser);
      if (parsed.pathname === '/api/users' && method === 'GET') return createJsonResponse([currentUser, buyerUser]);
      if (parsed.pathname === '/api/orders' && method === 'GET') {
        return createJsonResponse({
          items: [sampleOrder],
          meta: { page: 1, pageSize: 8, totalCount: 1, totalPages: 1, hasPrev: false, hasNext: false }
        });
      }
      if (parsed.pathname === '/api/admin/fulfillment/orders' && method === 'GET') {
        return createJsonResponse({
          items: [sampleOrder],
          meta: { page: 1, pageSize: 8, totalCount: 1, totalPages: 1, hasPrev: false, hasNext: false }
        });
      }
      if (/^\/api\/admin\/fulfillment\/orders\/[^/]+\/[^/]+$/.test(parsed.pathname) && method === 'GET') {
        return createJsonResponse(sampleOrder);
      }
      if (parsed.pathname === '/api/admin/orders/export' && method === 'GET') {
        exportRequests.push(parsed.searchParams.toString());
        return createBlobResponse('\uFEFF"订单号","商品名称"\r\n"ORD-001","白萝卜"', {
          contentType: 'text/csv; charset=utf-8',
          contentDisposition: 'attachment; filename="orders-export-test.csv"'
        });
      }
      if (
        parsed.pathname === '/api/products'
        || parsed.pathname === '/api/categories'
        || parsed.pathname === '/api/banners'
        || parsed.pathname === '/api/announcements'
        || parsed.pathname === '/api/coupon-templates'
        || parsed.pathname === '/api/refunds'
        || parsed.pathname === '/api/payment-transactions'
        || parsed.pathname === '/api/aftersales'
        || parsed.pathname === '/api/inventory-logs'
      ) {
        return createJsonResponse([]);
      }
      return createJsonResponse([]);
    }
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(match[1], context, { filename: 'index-inline.js' });
  await vm.runInContext('initApp()', context);

  sandbox.__sampleOrder = sampleOrder;
  sandbox.__currentUser = currentUser;
  sandbox.__buyerUser = buyerUser;

  vm.runInContext(`
    user = 'admin';
    usersState = {
      admin: normalizeUserRecord(__currentUser),
      buyerA: normalizeUserRecord(__buyerUser)
    };
    allOrdersLoaded = true;
    allOrdersState = [normalizeOrderSnapshot(__sampleOrder)];
    adminOrderListState.items = [normalizeOrderSnapshot(__sampleOrder)];
    adminOrderListState.loaded = true;
    adminOrderListState.filters = { orderId: 'ORD-001', ownerUsername: 'buyerA', status: 'shipped', dateFrom: '2026-04-10', dateTo: '2026-04-13' };
    adminFulfillmentState.items = [normalizeOrderSnapshot(__sampleOrder)];
    adminFulfillmentState.loaded = true;
    adminFulfillmentState.detail = normalizeOrderSnapshot(__sampleOrder);
    currentAdminTab = 'od';
  `, context);

  vm.runInContext('renderAdminOd()', context);
  const orderHtml = document.getElementById('admin-od').innerHTML;
  assert(orderHtml.includes('导出 CSV'), '管理员订单页应提供显式导出 CSV 按钮');
  assert(orderHtml.includes('去发货') || orderHtml.includes('查看详情'), '管理员订单页应保留跳转发货工作台入口');
  assert(orderHtml.includes('物流信息：运输中，下一站杭州分拨中心'), '管理员订单页应展示物流卡片摘要');

  await vm.runInContext('(async function(){ openAdminFulfillmentDetail("buyerA", "ORD-001"); await Promise.resolve(); await Promise.resolve(); })()', context);
  assert(vm.runInContext('currentAdminTab', context) === 'ship', '管理员订单页点击查看详情后应切到发货工作台');
  const orderJumpDetailHtml = document.getElementById('admin-ship').innerHTML;
  assert(orderJumpDetailHtml.includes('发货详情'), '管理员订单页点击查看详情后应直接展示发货详情');

  vm.runInContext("adminFulfillmentState.view = 'queue'; renderAdminShip();", context);
  const fulfillmentQueueHtml = document.getElementById('admin-ship').innerHTML;
  assert(fulfillmentQueueHtml.includes('履约工作台'), '发货工作台队列页应渲染顶部工作区 banner');
  assert(fulfillmentQueueHtml.includes('待发货订单'), '发货工作台队列页应显示摘要统计');

  vm.runInContext("adminFulfillmentState.view = 'detail'; renderAdminShip();", context);
  const fulfillmentDetailHtml = document.getElementById('admin-ship').innerHTML;
  assert(fulfillmentDetailHtml.includes('商品名称：白萝卜, 青菜'), '发货详情应完整展示同运单下的商品名称');
  assert(fulfillmentDetailHtml.includes('快递单号：YT123456789CN'), '发货详情应完整展示快递单号');
  assert(fulfillmentDetailHtml.includes('物流信息：运输中，下一站杭州分拨中心'), '发货详情应展示完整物流信息');

  await vm.runInContext('downloadAdminOrderCsv()', context);
  assert(exportRequests.length === 1, '管理员订单页导出按钮应发起一次导出请求');
  assert(exportRequests[0].includes('orderId=ORD-001'), '导出请求应复用当前订单号筛选');
  assert(exportRequests[0].includes('ownerUsername=buyerA'), '导出请求应复用当前用户名筛选');
  assert(exportRequests[0].includes('status=shipped'), '导出请求应复用当前状态筛选');
  assert(exportRequests[0].includes('dateFrom=2026-04-10'), '导出请求应复用当前开始日期筛选');
  assert(exportRequests[0].includes('dateTo=2026-04-13'), '导出请求应复用当前结束日期筛选');

  console.log('Fulfillment UI smoke test passed.');
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
