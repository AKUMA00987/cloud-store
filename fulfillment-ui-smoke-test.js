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
        if (key === 'content-type') return config.contentType || 'application/vnd.ms-excel; charset=utf-8';
        if (key === 'content-disposition') return config.contentDisposition || 'attachment; filename="orders-export-test.xls"';
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
  const eventHandlers = {};
  const historyCalls = { push: [], replace: [] };
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
  const shippedOrder = {
    id: 'order_relation_17',
    sourceId: 'ORD-SHIPPED',
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
  const paidOrder = {
    id: 'order_relation_18',
    sourceId: 'ORD-PAID',
    owner: 'buyerA',
    ownerDeleted: false,
    status: 'paid',
    time: Date.now() - 3600 * 1000,
    total: 44.9,
    subtotal: 39.9,
    deliveryFee: 5,
    discount: 0,
    address: { name: '李四', phone: '13822223333', full: '待发货地址 A' },
    items: [
      {
        orderItemId: 201,
        id: 601,
        productId: 601,
        name: '鹅蛋',
        qty: 1,
        price: 39.9,
        img: 'https://example.com/c.png',
        variantLabel: '大份',
        unit: '24枚',
        unitLabel: '24枚',
        shippingAddressSnapshot: { name: '仓库丙', phone: '13855556666', full: '测试仓库 3 号' }
      }
    ],
    shipments: [],
    fulfillmentSummary: {
      shipmentCount: 0,
      assignedItemCount: 0,
      totalItemCount: 1,
      unassignedItemCount: 1
    }
  };
  const refundOrder = {
    id: 'order_relation_19',
    sourceId: 'ORD-REFUND',
    owner: 'buyerA',
    ownerDeleted: false,
    status: 'refund_pending',
    trackingNo: 'LEGACY-TRACK-001',
    time: Date.now() - 7200 * 1000,
    total: 52.6,
    subtotal: 47.6,
    deliveryFee: 5,
    discount: 0,
    address: { name: '王五', phone: '13711112222', full: '退款地址 B' },
    items: [
      {
        orderItemId: 301,
        id: 701,
        productId: 701,
        name: '山药',
        qty: 2,
        price: 23.8,
        img: 'https://example.com/d.png',
        variantLabel: '精品',
        unit: '箱',
        unitLabel: '箱',
        shippingAddressSnapshot: { name: '仓库丁', phone: '13877778888', full: '测试仓库 4 号' }
      }
    ],
    shipments: [],
    fulfillmentSummary: {
      shipmentCount: 0,
      assignedItemCount: 0,
      totalItemCount: 1,
      unassignedItemCount: 1
    }
  };
  const refundRequest = {
    id: 'refund_001',
    orderId: 'order_relation_19',
    ownerUsername: 'buyerA',
    status: 'pending',
    reason: '商品破损',
    rejectReason: '',
    paymentRefunded: false,
    inventoryRestored: false,
    createdAt: Date.now() - 1800 * 1000,
    completedAt: 0,
    items: cloneJson(refundOrder.items)
  };
  const paymentLedger = {
    id: 'pay_tx_001',
    orderId: 'order_relation_18',
    username: 'buyerA',
    amount: 44.9,
    channel: 'alipay_wap',
    status: 'pending',
    createdAt: Date.now() - 1200 * 1000
  };
  const aftersalesLedger = {
    id: 'after_001',
    orderId: 'order_relation_19',
    ownerUsername: 'buyerA',
    type: 'refund',
    status: 'pending',
    createdAt: Date.now() - 900 * 1000
  };
  const inventoryLedger = {
    id: 'inventory_001',
    productId: 701,
    productName: '山药',
    delta: -2,
    reason: '订单占用',
    createdAt: Date.now() - 600 * 1000
  };
  const orderMap = {
    order_relation_17: shippedOrder,
    order_relation_18: paidOrder,
    order_relation_19: refundOrder,
    'ORD-SHIPPED': shippedOrder,
    'ORD-PAID': paidOrder,
    'ORD-REFUND': refundOrder
  };
  const adminOrders = [shippedOrder, paidOrder, refundOrder];

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
    location: { hash: '#/profile', href: 'http://127.0.0.1:3000/#/profile' },
    window: {
      addEventListener(type, handler) { eventHandlers[type] = handler; },
      removeEventListener() { },
      scrollTo() { },
      open() { },
      URL: {
        createObjectURL() { return 'blob:orders-export'; },
        revokeObjectURL() { }
      },
      history: {
        state: null,
        back() { },
        pushState(state) {
          this.state = cloneJson(state);
          historyCalls.push.push(cloneJson(state));
        },
        replaceState(state) {
          this.state = cloneJson(state);
          historyCalls.replace.push(cloneJson(state));
        }
      },
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
          items: adminOrders,
          meta: { page: 1, pageSize: 8, totalCount: adminOrders.length, totalPages: 1, hasPrev: false, hasNext: false }
        });
      }
      if (parsed.pathname === '/api/admin/fulfillment/orders' && method === 'GET') {
        return createJsonResponse({
          items: [paidOrder, shippedOrder],
          meta: { page: 1, pageSize: 8, totalCount: 2, totalPages: 1, hasPrev: false, hasNext: false }
        });
      }
      if (/^\/api\/admin\/fulfillment\/orders\/[^/]+\/[^/]+$/.test(parsed.pathname) && method === 'GET') {
        const orderId = decodeURIComponent(parsed.pathname.split('/').pop());
        return createJsonResponse(orderMap[orderId] || shippedOrder);
      }
      if (parsed.pathname === '/api/admin/orders/export' && method === 'GET') {
        exportRequests.push(parsed.searchParams.toString());
        return createBlobResponse('\uFEFF<?xml version="1.0" encoding="UTF-8"?><Workbook><Worksheet><Table><Row><Cell><Data>订单号</Data></Cell><Cell><Data>商品名称</Data></Cell></Row><Row><Cell><Data>ORD-SHIPPED</Data></Cell><Cell><Data>白萝卜</Data></Cell></Row></Table></Worksheet></Workbook>', {
          contentType: 'application/vnd.ms-excel; charset=utf-8',
          contentDisposition: 'attachment; filename="orders-export-test.xls"'
        });
      }
      if (parsed.pathname === '/api/refunds') {
        return createJsonResponse([refundRequest]);
      }
      if (parsed.pathname === '/api/payment-transactions') {
        return createJsonResponse([paymentLedger]);
      }
      if (parsed.pathname === '/api/aftersales') {
        return createJsonResponse([aftersalesLedger]);
      }
      if (parsed.pathname === '/api/inventory-logs') {
        return createJsonResponse([inventoryLedger]);
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

  sandbox.__shippedOrder = shippedOrder;
  sandbox.__paidOrder = paidOrder;
  sandbox.__refundOrder = refundOrder;
  sandbox.__refundRequest = refundRequest;
  sandbox.__currentUser = currentUser;
  sandbox.__buyerUser = buyerUser;

  vm.runInContext(`
    user = 'admin';
    usersState = {
      admin: normalizeUserRecord(__currentUser),
      buyerA: normalizeUserRecord(__buyerUser)
    };
    allOrdersLoaded = true;
    allOrdersState = [normalizeOrderSnapshot(__shippedOrder), normalizeOrderSnapshot(__paidOrder), normalizeOrderSnapshot(__refundOrder)];
    refundsState = [normalizeRefundRequest(__refundRequest)];
    refundsLoaded = true;
    paymentTransactionsState = [{ id: 'pay_tx_001', orderId: 'ORD-PAID', username: 'buyerA', amount: 44.9, channel: 'alipay_wap', status: 'pending', createdAt: Date.now() - 1200 * 1000 }];
    paymentTransactionsLoaded = true;
    aftersalesState = [{ id: 'after_001', orderId: 'ORD-REFUND', ownerUsername: 'buyerA', type: 'refund', status: 'pending', createdAt: Date.now() - 900 * 1000 }];
    aftersalesLoaded = true;
    inventoryLogsState = [{ id: 'inventory_001', productId: 701, productName: '山药', delta: -2, reason: '订单占用', createdAt: Date.now() - 600 * 1000 }];
    inventoryLogsLoaded = true;
    adminLightStatsState = { productCount: 2, userCount: 2, orderCount: 3, pendingRefundCount: 1, pendingOrderCount: 1, paidSalesTotal: 98 };
    adminOrderListState.items = [normalizeOrderSnapshot(__shippedOrder), normalizeOrderSnapshot(__paidOrder), normalizeOrderSnapshot(__refundOrder)];
    adminOrderListState.loaded = true;
    adminOrderListState.filters = { orderId: 'ORD-SHIPPED', ownerUsername: 'buyerA', status: 'shipped', dateFrom: '2026-04-10', dateTo: '2026-04-13' };
    adminFulfillmentState.items = [normalizeOrderSnapshot(__paidOrder), normalizeOrderSnapshot(__shippedOrder)];
    adminFulfillmentState.loaded = true;
    adminFulfillmentState.detail = normalizeOrderSnapshot(__paidOrder);
    currentAdminTab = 'od';
  `, context);

  vm.runInContext('renderAdminOd()', context);
  const orderHtml = document.getElementById('admin-od').innerHTML;
  assert(orderHtml.includes('导出 Excel'), '管理员订单页应提供显式导出 Excel 按钮');
  assert((orderHtml.match(/>详情<\/button>/g) || []).length === 3, '管理员订单页中所有订单都应显示详情按钮');
  assert((orderHtml.match(/>发货<\/button>/g) || []).length === 1, '只有已支付待发货订单应显示发货按钮');
  assert((orderHtml.match(/>退款<\/button>/g) || []).length === 1, '只有退款申请中的订单应显示退款按钮');
  assert(orderHtml.includes('物流信息：运输中，下一站杭州分拨中心'), '管理员订单页应展示物流卡片摘要');

  vm.runInContext(`
    adminOrderListState.items = [];
    adminOrderListState.loaded = true;
    renderAdminOd();
  `, context);
  const emptyOrderHtml = document.getElementById('admin-od').innerHTML;
  assert(emptyOrderHtml.includes('当前筛选下暂无订单'), '管理员订单筛选为空时应展示空态');
  assert(!emptyOrderHtml.includes('白萝卜'), '管理员订单筛选为空时不应退回全量订单');

  vm.runInContext(`
    adminOrderListState.items = [normalizeOrderSnapshot(__shippedOrder), normalizeOrderSnapshot(__paidOrder), normalizeOrderSnapshot(__refundOrder)];
    adminOrderListState.loaded = true;
    document.getElementById('admin-panel').classList.remove('hidden');
    document.getElementById('farmer-panel').classList.add('hidden');
    currentAdminTab = 'od';
    syncWorkspaceHistoryState('replace');
  `, context);
  assert(historyCalls.replace.length >= 1, '管理员订单页应写入后台历史快照');
  assert(historyCalls.replace[historyCalls.replace.length - 1].workspaceSnapshot.adminTab === 'od', '订单页历史快照应记录当前页签');
  vm.runInContext('renderWorkspaceNavZone("admin")', context);
  const adminNavHtml = document.getElementById('admin-nav-zone').innerHTML;
  assert(adminNavHtml.includes('台账'), '管理员后台导航应新增独立台账页签');

  await vm.runInContext('(async function(){ await openAdminOrderDetailModal("buyerA", "order_relation_17"); })()', context);
  const adminOrderDetailModalHtml = document.getElementById('modal-root').innerHTML;
  assert(adminOrderDetailModalHtml.includes('订单详情'), '管理员点击详情后应弹出订单详情弹窗');
  assert(adminOrderDetailModalHtml.includes('这里按买家端的视角展示商品、地址、物流和退款状态'), '管理员订单详情弹窗应按买家视角展示说明');
  assert(adminOrderDetailModalHtml.includes('白萝卜'), '管理员订单详情弹窗应展示商品信息');
  assert(adminOrderDetailModalHtml.includes('物流信息'), '管理员订单详情弹窗应展示物流区块');
  await vm.runInContext('(async function(){ await openAdminOrderDetailModal("buyerA", "order_relation_19"); })()', context);
  const legacyTrackingModalHtml = document.getElementById('modal-root').innerHTML;
  assert(legacyTrackingModalHtml.includes('LEGACY-TRACK-001'), '管理员订单详情应兼容展示仅存在 trackingNo 的旧订单运单号');

  await vm.runInContext('(async function(){ openAdminFulfillmentDetail("buyerA", "order_relation_18"); await Promise.resolve(); await Promise.resolve(); })()', context);
  assert(vm.runInContext('currentAdminTab', context) === 'ship', '管理员订单页点击发货后应切到发货工作台');
  const orderJumpDetailHtml = document.getElementById('admin-ship').innerHTML;
  assert(orderJumpDetailHtml.includes('发货详情'), '管理员订单页点击发货后应直接展示发货详情');
  assert(orderJumpDetailHtml.includes('鹅蛋'), '管理员发货详情应展示目标订单商品');
  assert(historyCalls.push.length >= 1, '管理员进入发货详情后应新增历史快照');
  assert(historyCalls.push[historyCalls.push.length - 1].workspaceSnapshot.adminTab === 'ship', '发货详情历史快照应记录发货页签');
  await vm.runInContext('(function(){ adminFulfillmentState.loading = true; renderAdminShip(); })()', context);
  const savingShipHtml = document.getElementById('admin-ship').innerHTML;
  assert(savingShipHtml.includes('正在保存...'), '发货详情保存中状态应使用清晰文案');
  assert(historyCalls.push[historyCalls.push.length - 1].workspaceSnapshot.adminFulfillmentView === 'detail', '发货详情历史快照应记录 detail 视图');

  await vm.runInContext('(async function(){ openAdminRefundDetailByOrder("buyerA", "order_relation_19"); for (var i = 0; i < 6; i += 1) await Promise.resolve(); })()', context);
  assert(vm.runInContext('currentAdminTab', context) === 'refund', '管理员订单页点击退款后应切到退款工作台');
  vm.runInContext('openAdminRefundDetail("refund_001")', context);
  vm.runInContext('renderAdminRefund()', context);
  const adminRefundHtml = document.getElementById('admin-refund').innerHTML;
  assert(adminRefundHtml.includes('退款详情'), '管理员点击退款后应展示退款详情');
  assert(adminRefundHtml.includes('商品破损'), '退款详情应展示退款原因');
  assert(!adminRefundHtml.includes('交易台账'), '退款工作台不应再包含交易台账区块');

  vm.runInContext("currentAdminTab = 'db'; renderAdminDb();", context);
  const adminDbHtml = document.getElementById('admin-db').innerHTML;
  assert(!adminDbHtml.includes('支付、售后和库存流水统一放在数据页查看'), '数据页签不应再直接包含交易台账区块');
  assert(adminDbHtml.includes('交易台账已经单拎到独立页签'), '数据页签应提示交易台账已迁移到独立页签');

  vm.runInContext("currentAdminTab = 'ledger'; renderAdminLedger();", context);
  const adminLedgerHtml = document.getElementById('admin-ledger').innerHTML;
  assert(adminLedgerHtml.includes('交易台账'), '交易台账应迁移到独立台账页签中');
  assert(adminLedgerHtml.includes('支付、售后和库存流水统一放在数据页查看'), '台账页签应展示交易台账说明');

  assert(typeof eventHandlers.popstate === 'function', '前端应注册 popstate 处理手机侧滑返回');
  eventHandlers.popstate({ state: { workspaceSnapshot: { route: 'admin', adminTab: 'od' } } });
  assert(vm.runInContext('currentAdminTab', context) === 'od', '手机侧滑返回时应先回到管理员上一层页签');
  assert(!document.getElementById('admin-panel').classList.contains('hidden'), '恢复管理员历史快照后不应直接退出后台');

  await vm.runInContext('(async function(){ await adminBack(); await Promise.resolve(); await Promise.resolve(); })()', context);
  assert(vm.runInContext('currentAdminTab', context) === 'db', '退出管理员页面时应重置当前页签');
  assert(vm.runInContext('adminFulfillmentState.view', context) === 'queue', '退出管理员页面时应清理发货详情状态');

  vm.runInContext("adminFulfillmentState.view = 'queue'; renderAdminShip();", context);
  const fulfillmentQueueHtml = document.getElementById('admin-ship').innerHTML;
  assert(fulfillmentQueueHtml.includes('履约工作台'), '发货工作台队列页应渲染顶部工作区 banner');
  assert(fulfillmentQueueHtml.includes('待发货订单'), '发货工作台队列页应显示摘要统计');

  vm.runInContext("adminFulfillmentState.detail = normalizeOrderSnapshot(__shippedOrder); adminFulfillmentState.view = 'detail'; renderAdminShip();", context);
  const fulfillmentDetailHtml = document.getElementById('admin-ship').innerHTML;
  assert(fulfillmentDetailHtml.includes('商品名称：白萝卜, 青菜'), '发货详情应完整展示同运单下的商品名称');
  assert(fulfillmentDetailHtml.includes('快递单号：YT123456789CN'), '发货详情应完整展示快递单号');
  assert(fulfillmentDetailHtml.includes('物流信息：运输中，下一站杭州分拨中心'), '发货详情应展示完整物流信息');
  vm.runInContext("adminFulfillmentState.detail = normalizeOrderSnapshot(__paidOrder); adminFulfillmentState.view = 'detail'; renderAdminShip();", context);
  const paidFulfillmentDetailHtml = document.getElementById('admin-ship').innerHTML;
  assert(paidFulfillmentDetailHtml.includes('同地址商品可以共用一条运单合包'), '发货详情应明确说明同地址商品可共用一条运单');

  await vm.runInContext('downloadAdminOrderCsv()', context);
  assert(exportRequests.length === 1, '管理员订单页导出按钮应发起一次导出请求');
  assert(exportRequests[0].includes('orderId=ORD-SHIPPED'), '导出请求应复用当前订单号筛选');
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
