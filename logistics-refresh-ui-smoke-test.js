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

  const currentUser = {
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

  const baseOrder = {
    id: 'ORD-001',
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
        id: 'ship_1',
        trackingNo: 'YT123456789CN',
        carrierCode: 'yto',
        carrierName: '圆通快递',
        status: 'shipped',
        state: '0',
        data: [
          { context: '杭州分拨中心 已发出', ftime: '04-13 10:20' },
          { context: '包裹已到达杭州分拨中心', ftime: '04-13 08:10' }
        ],
        logisticsState: 'active_success',
        logisticsSummary: '杭州分拨中心 已发出',
        orderItemIds: [101],
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
          }
        ],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: 'admin',
        legacySource: ''
      },
      {
        id: 'ship_2',
        trackingNo: 'SF987654321CN',
        carrierCode: 'sf',
        carrierName: '顺丰速运',
        status: 'shipped',
        state: '0',
        data: [
          { context: '查无结果', ftime: '04-13 11:00' }
        ],
        logisticsState: 'no_trace',
        logisticsSummary: '已录入单号，等待物流公司返回轨迹',
        orderItemIds: [102],
        items: [
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
      },
      {
        id: 'ship_3',
        trackingNo: 'YD246810121CN',
        carrierCode: 'yd',
        carrierName: '韵达快递',
        status: 'shipped',
        state: '3',
        data: [
          { context: '包裹已签收，签收人：本人', ftime: '04-13 10:40' }
        ],
        logisticsState: 'signed',
        logisticsSummary: '已签收 · 04-13 10:40',
        orderItemIds: [102],
        items: [
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
      shipmentCount: 3,
      assignedItemCount: 2,
      totalItemCount: 2,
      unassignedItemCount: 0
    }
  };

  let pageFetchCount = 0;
  const requestLog = [];

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
    location: { hash: '#/orders' },
    window: {
      scrollY: 0,
      addEventListener() { },
      removeEventListener() { },
      scrollTo(x, y) { this.scrollY = Number(y || 0); },
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
      requestLog.push(method + ' ' + parsed.pathname + parsed.search);

      if (parsed.pathname === '/api/auth/me' && method === 'GET') return createJsonResponse(currentUser);
      if (parsed.pathname === '/api/users' && method === 'GET') return createJsonResponse([currentUser]);
      if (parsed.pathname === '/api/orders' && method === 'GET') {
        pageFetchCount += 1;
        return createJsonResponse({
          items: [cloneJson(baseOrder)],
          meta: { page: 1, pageSize: 8, totalCount: 1, totalPages: 1, hasPrev: false, hasNext: false }
        });
      }
      if (
        parsed.pathname === '/api/products'
        || parsed.pathname === '/api/categories'
        || parsed.pathname === '/api/banners'
        || parsed.pathname === '/api/announcements'
        || parsed.pathname === '/api/coupon-templates'
      ) {
        return createJsonResponse([]);
      }
      return createJsonResponse([]);
    }
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(match[1], context, { filename: 'index-inline.js' });
  await vm.runInContext('initApp()', context);

  const ordersHtml = document.getElementById('app').innerHTML;
  assert(!ordersHtml.includes('查看更新'), '订单列表不应再显示实时物流更新按钮');
  assert(!ordersHtml.includes('物流信息有更新'), '订单列表不应再显示实时物流更新提示');
  assert(ordersHtml.includes('还有 2 条'), '多运单订单列表态应继续收口为还有 N 条');

  vm.runInContext('view = "orderDetail"; paramId = 0; render();', context);
  const detailHtml = document.getElementById('app').innerHTML;
  assert(!detailHtml.includes('刷新当前订单'), '订单详情不应再显示实时刷新当前订单按钮');
  assert(detailHtml.indexOf('录入时间') < 0, '订单详情不应展示内部录入时间');
  assert(detailHtml.indexOf('最近查询时间') < 0, '订单详情不应展示最近查询时间');
  assert(detailHtml.includes('物流轨迹'), '运输中且存在有效轨迹时，订单详情应展示物流轨迹');
  assert(detailHtml.includes('杭州分拨中心 已发出'), '运输中运单应展示真实轨迹节点');
  assert(!detailHtml.includes('查无结果'), '查无结果类无效轨迹不应展示给用户');
  assert(detailHtml.includes('物流状态：已签收'), 'state=3 的运单在详情中应只展示状态');
  assert(!detailHtml.includes('包裹已签收，签收人：本人'), '已签收运单不应继续展开详细轨迹内容');
  assert(!requestLog.some(function (entry) { return /^POST \/api\/orders\/.*logistics-refresh-check/.test(entry); }), '前端不应再触发物流 refresh-check 接口');

  console.log('Logistics refresh UI smoke test passed.');
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
