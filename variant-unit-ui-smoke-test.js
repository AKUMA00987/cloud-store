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
  const storage = new Map();
  const document = createDocument();

  [
    'app',
    'nav',
    'cart-badge',
    'modal-root',
    'admin-panel',
    'admin-nav-zone',
    'farmer-panel',
    'farmer-nav-zone',
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

  const categories = [
    { id: 'veg', name: '新鲜蔬菜', icon: '🥬', sortOrder: 0, showOnHome: true },
    { id: 'fruit', name: '时令水果', icon: '🍊', sortOrder: 1, showOnHome: true }
  ];

  const products = [
    {
      id: 1,
      name: '高山青菜',
      variants: [
        {
          id: 'veg-small',
          label: '小份',
          price: 12,
          units: [
            { id: 'small-bag', label: '袋装', price: 12, stock: 3, sortOrder: 0, isDefault: true },
            { id: 'small-box', label: '盒装', price: 15, stock: 2, sortOrder: 1, isDefault: false }
          ],
          sortOrder: 0,
          isDefault: true
        },
        {
          id: 'veg-large',
          label: '大份',
          price: 26,
          units: [
            { id: 'large-bag', label: '袋装', price: 26, stock: 4, sortOrder: 0, isDefault: true },
            { id: 'large-box', label: '箱装', price: 33, stock: 1, sortOrder: 1, isDefault: false }
          ],
          sortOrder: 1,
          isDefault: false
        }
      ],
      price: 12,
      orig: 30,
      unit: '袋装',
      cat: 'veg',
      stock: 10,
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
      cart: [],
      orders: [],
      member: { levelId: 'normal', points: 0, totalSpent: 0 },
      createdAt: '2026/04/09'
    },
    {
      id: 2,
      username: 'admin',
      roles: { isFarmer: true, isAdmin: true, isSuperAdmin: true, farmerName: '系统管理员' },
      addresses: [],
      shippingAddresses: [{ id: 'ship_admin', name: '管理员', phone: '13800000002', full: '仓库发货点' }],
      coupons: [],
      selectedAddressId: '',
      selectedCouponId: '',
      cart: [],
      orders: [],
      member: { levelId: 'normal', points: 0, totalSpent: 0 },
      createdAt: '2026/04/09'
    },
    {
      id: 3,
      username: 'farmer_li',
      roles: { isFarmer: true, isAdmin: false, isSuperAdmin: false, farmerName: '老李' },
      addresses: [],
      shippingAddresses: [{ id: 'ship_farmer', name: '老李', phone: '13800000001', full: '青山村 1 号' }],
      coupons: [],
      selectedAddressId: '',
      selectedCouponId: '',
      cart: [],
      orders: [],
      member: { levelId: 'normal', points: 0, totalSpent: 0 },
      createdAt: '2026/04/09'
    }
  ];

  let currentAuthUsername = 'buyer1';
  let prepareCounter = 0;

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
      const defaultUnit = (variant.units || []).find(function (unit) { return !!unit.isDefault; }) || (variant.units || [])[0] || null;
      return Object.assign({}, variant, {
        price: Number(defaultUnit && defaultUnit.price || variant.price || 0),
        stock: stock
      });
    });
    const defaultVariant = (product.variants || []).find(function (variant) { return !!variant.isDefault; }) || (product.variants || [])[0] || null;
    const defaultUnit = defaultVariant && ((defaultVariant.units || []).find(function (unit) { return !!unit.isDefault; }) || (defaultVariant.units || [])[0] || null);
    product.price = Number(defaultUnit && defaultUnit.price || product.price || 0);
    product.unit = defaultUnit && defaultUnit.label ? defaultUnit.label : product.unit;
    product.stock = (product.variants || []).reduce(function (sum, variant) {
      return sum + Number(variant.stock || 0);
    }, 0);
  }

  function setProductUnitStock(productId, variantId, unitId, deltaQty) {
    const product = products.find(function (item) { return Number(item.id || 0) === Number(productId || 0); });
    if (!product) return;
    product.variants = (product.variants || []).map(function (variant) {
      if (String(variant.id || '') !== String(variantId || '')) return Object.assign({}, variant);
      return Object.assign({}, variant, {
        units: (variant.units || []).map(function (unit) {
          if (String(unit.id || '') !== String(unitId || '')) return Object.assign({}, unit);
          return Object.assign({}, unit, { stock: Number(unit.stock || 0) + Number(deltaQty || 0) });
        })
      });
    });
    syncProductStocks(product);
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
      if (parsed.pathname === '/api/products' && method === 'POST') {
        const payload = JSON.parse(options.body || '{}');
        syncProductStocks(payload);
        products.push(cloneJson(payload));
        return createJsonResponse(cloneJson(payload));
      }
      if (parsed.pathname === '/api/categories') return createJsonResponse(cloneJson(categories));
      if (parsed.pathname === '/api/banners') return createJsonResponse([]);
      if (parsed.pathname === '/api/announcements') return createJsonResponse([]);
      if (parsed.pathname === '/api/coupon-templates') return createJsonResponse([]);
      if (parsed.pathname === '/api/refunds') return createJsonResponse([]);
      if (parsed.pathname === '/api/payment-transactions') return createJsonResponse([]);
      if (parsed.pathname === '/api/aftersales') return createJsonResponse([]);
      if (parsed.pathname === '/api/inventory-logs') return createJsonResponse([]);
      if (parsed.pathname === '/api/orders') return createJsonResponse(buildAllOrders());
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
        const nextState = JSON.parse(options.body || '{}');
        const target = getUser(username);
        Object.assign(target, cloneJson(nextState));
        return createJsonResponse(cloneJson(target));
      }

      if (parsed.pathname === '/api/orders/prepare-payment' && method === 'POST') {
        const payload = JSON.parse(options.body || '{}');
        prepareCounter += 1;
        const target = getUser(currentAuthUsername);
        const order = {
          id: 'ORD_UNIT_' + prepareCounter,
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
        };
        (payload.items || []).forEach(function (item) {
          setProductUnitStock(item.productId || item.id, item.variantId, item.unitId, -Number(item.qty || 0));
        });
        target.orders = [order].concat(target.orders || []);
        return createJsonResponse(cloneJson(order));
      }

      const payMatch = parsed.pathname.match(/^\/api\/orders\/([^/]+)\/pay$/);
      if (payMatch && method === 'POST') {
        const orderId = decodeURIComponent(payMatch[1]);
        const target = getUser(currentAuthUsername);
        const order = (target.orders || []).find(function (item) { return item.id === orderId; });
        order.status = 'paid';
        (order.items || []).forEach(function (item) {
          const product = products.find(function (entry) { return Number(entry.id || 0) === Number(item.productId || item.id || 0); });
          if (product) product.sales = Number(product.sales || 0) + Number(item.qty || 0);
        });
        return createJsonResponse(cloneJson(order));
      }

      return createJsonResponse({ message: 'not found' }, 404);
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(match[1], sandbox, { filename: 'index.html<script>' });

  async function flush(times) {
    for (let index = 0; index < (times || 5); index += 1) {
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

  await execAsync('await go("home");');
  await flush(2);
  let homeHtml = document.getElementById('app').innerHTML;
  assert(!homeHtml.includes('line-through'), '首页商品卡在无活动时不应展示划线价');

  await execAsync('await pushView("product", 1);');
  await flush(4);
  let appHtml = document.getElementById('app').innerHTML;
  assert(appHtml.includes('规格选择'), '商品详情页应展示规格选择区');
  assert(appHtml.includes('小份'), '商品详情页应展示规格按钮');
  assert(!appHtml.includes('line-through'), '商品详情页在无活动时不应展示划线价');

  await execAsync('await addToCart(1, { alertSuccess: false });');
  assert(alerts.includes('请先选择规格'), '未选规格时应先提示选择规格');

  exec('selectVariant(1, "veg-large");');
  await execAsync('await pushView("product", 1);');
  await flush(2);
  appHtml = document.getElementById('app').innerHTML;
  assert(appHtml.includes('单位选择'), '选中规格后应展示单位选择区');
  assert(appHtml.includes('袋装'), '选中规格后应展示单位按钮');
  exec('selectUnit(1, "large-box");');
  await execAsync('await pushView("product", 1);');
  await flush(2);
  appHtml = document.getElementById('app').innerHTML;
  assert(appHtml.includes('¥33.00'), '切换单位后详情页主价格应改为单位价格');
  await execAsync('await addToCart(1, { alertSuccess: false });');
  assert(exec('cart.length') === 1, '选中规格和单位后应能加入购物车');
  assert(exec('cart[0].variantId') === 'veg-large', '购物车应记录规格 ID');
  assert(exec('cart[0].unitId') === 'large-box', '购物车应记录单位 ID');
  assert(exec('cart[0].unitLabel') === '箱装', '购物车应记录单位名称');
  assert(exec('cart[0].price') === 33, '购物车应记录单位价格');

  await execAsync('await go("cart");');
  await flush(4);
  appHtml = document.getElementById('app').innerHTML;
  assert(appHtml.includes('veg-large'), '购物车操作按钮应保留规格维度');
  assert(appHtml.includes('large-box'), '购物车操作按钮应保留单位维度');

  exec('upd(1, 1, "veg-large", "large-box");');
  assert(exec('cart[0].qty') === 1, '单位库存不足时购物车数量不应超过上限');
  exec('selectUnit(1, "large-bag");');
  await execAsync('await addToCart(1, { alertSuccess: false });');
  assert(exec('cart.length') === 2, '相同规格不同单位应拆成两行购物车记录');

  exec('cart = [normalizeCartStateItem({ id: 1, productId: 1, name: "高山青菜", variantId: "veg-large", variantLabel: "大份", unitId: "large-bag", unitLabel: "袋装", unit: "袋装", price: 26, img: "https://example.com/veg.jpg", qty: 2 })]; updateCartBadge();');
  await execAsync('await confirmCheckout();');
  await flush(4);
  assert(exec('currentCheckoutOrder && currentCheckoutOrder.items[0].variantId') === 'veg-large', '确认订单应冻结规格 ID');
  assert(exec('currentCheckoutOrder && currentCheckoutOrder.items[0].unitId') === 'large-bag', '确认订单应冻结单位 ID');
  assert(exec('currentCheckoutOrder && currentCheckoutOrder.items[0].unitLabel') === '袋装', '确认订单应冻结单位名称');
  assert(exec('currentCheckoutOrder && currentCheckoutOrder.items[0].price') === 26, '确认订单应冻结单位价格');

  assert(exec('currentCheckoutOrder && currentCheckoutOrder.status') === 'pending', '确认订单后应进入待支付状态');
  assert(getUser('buyer1').orders[0].items[0].unitId === 'large-bag', '待支付订单快照应保留单位 ID');
  assert(products[0].variants.find(function (item) { return item.id === 'veg-large'; }).units.find(function (unit) { return unit.id === 'large-bag'; }).stock === 2, '进入支付后应先预占对应单位库存');

  [
    'new-name',
    'new-cat',
    'new-tags',
    'new-variants-json',
    'new-variants-panel',
    'new-stock-summary',
    'new-price-summary',
    'new-unit-summary',
    'new-harvest',
    'new-dispatch-hours',
    'new-farmer',
    'new-village',
    'new-shipping-address-id',
    'new-img'
  ].forEach(function (id) {
    document.getElementById(id);
  });

  exec('setProductFormVariants("new", [{ id: "orange_small", label: "小箱", price: 18, units: [{ id: "orange_small_box", label: "箱", price: 18, stock: 2, sortOrder: 0, isDefault: true }, { id: "orange_small_bag", label: "袋", price: 22, stock: 3, sortOrder: 1, isDefault: false }], sortOrder: 0, isDefault: true }, { id: "orange_large", label: "大箱", price: 32, units: [{ id: "orange_large_box", label: "箱", price: 32, stock: 5, sortOrder: 0, isDefault: true }], sortOrder: 1, isDefault: false }]);');
  assert(document.getElementById('new-stock-summary').textContent === '10', '后台商品总库存应为所有单位库存合计');
  assert(document.getElementById('new-price-summary').textContent === '¥18.00', '后台汇总应展示默认单位价格');
  assert(document.getElementById('new-unit-summary').textContent === '箱', '后台汇总应展示默认单位');
  let panelHtml = exec('renderVariantListPanel("new", { variants: getProductFormVariants("new", {}) })');
  assert(panelHtml.includes('规格库存：5'), '默认应展示规格库存摘要');
  assert(panelHtml.includes('单位价格'), '规格摘要应展示单位价格汇总');
  exec('toggleVariantPanelExpand("new", "orange_small");');
  panelHtml = exec('renderVariantListPanel("new", { variants: getProductFormVariants("new", {}) })');
  assert(panelHtml.includes('单位库存'), '点击规格后应可展开单位库存');
  assert(panelHtml.includes('单位价格'), '展开后应展示单位价格明细');

  exec('openVariantEditor("new", 0);');
  const modalHtml = document.getElementById('modal-root').innerHTML;
  assert(modalHtml.includes('单位价格'), '规格弹窗应改为维护单位价格');
  assert(!modalHtml.includes('规格价格'), '规格弹窗不应再显示规格价格输入');
  assert(modalHtml.includes('grid-cols-1 sm:grid-cols-4'), '规格弹窗在移动端应改为纵向优先布局');
  assert(modalHtml.includes('app-modal-card modal-wide'), '规格弹窗应复用统一的大尺寸移动端 modal 壳子');

  currentAuthUsername = 'admin';
  exec('usersState["admin"] = normalizeUserRecord({ username: "admin", roles: { isFarmer: true, isAdmin: true, isSuperAdmin: true, farmerName: "系统管理员" }, addresses: [], shippingAddresses: [{ id: "ship_admin", name: "管理员", phone: "13800000002", full: "仓库发货点" }], coupons: [], selectedAddressId: "", selectedCouponId: "", cart: [], orders: [], member: { levelId: "normal", points: 0, totalSpent: 0 }, createdAt: "2026/04/09" });');
  exec('user = "admin"; openShippingAddressPicker("new");');
  const shippingPickerHtml = document.getElementById('modal-root').innerHTML;
  assert(shippingPickerHtml.includes('app-modal-card modal-compact'), '发货地址选择弹窗应复用统一的小尺寸移动端 modal 壳子');
  assert(shippingPickerHtml.includes('app-modal-body'), '发货地址选择弹窗应限制高度并启用内部滚动');

  const uploadHtml = exec('renderProductImageUploader("new", { images: ["https://example.com/a.jpg"], img: "https://example.com/a.jpg" })');
  assert(uploadHtml.includes('flex flex-col gap-2 sm:flex-row'), '商品图片上传区在移动端应改成纵向优先布局');
  assert(exec('validateProductPayload({ name: "测试商品", cat: "veg", images: ["https://example.com/a.jpg"], variants: [{ label: "默认规格", units: [{ label: "箱", price: 18, stock: 2 }] }], harvest: "", dispatchHours: 4, shippingAddressId: "ship_admin", tags: [] })') === '', '商品校验不应再强制要求采摘日期');
  assert(html.includes('workspace-layout'), '管理端应使用统一的 workspace 布局壳子');
  assert(html.includes('.app-modal-shell'), '前端应提供统一的 modal 适配样式');
  assert(html.includes('.workspace-nav-card'), '后台应提供统一的当前菜单卡片样式');
  assert(html.includes('.workspace-nav-panel'), '后台应提供统一的右侧展开菜单面板样式');
  assert(html.includes('function toggleWorkspaceNav(scope)'), '前端应提供共享导航开合 helper');
  assert(html.includes('function renderWorkspaceNavShell(scope)'), '前端应提供共享导航壳层渲染 helper');
  assert(html.includes('grid-template-columns: repeat(3, minmax(0, 1fr))'), '后台菜单展开面板应改成九宫格布局');
  assert(html.includes('top: calc(100% + 10px);'), '后台菜单面板应改为从卡片下方展开');
  assert(html.includes('aspect-ratio: 1 / 1;'), '九宫格菜单项应尽量保持正方形');
  assert(html.includes('.workspace-nav-zone {\n      position: sticky;'), '后台导航区在手机端滚动时应保持 sticky');
  assert(html.includes('top: 56px;'), '后台导航区 sticky 位置应贴住绿色顶栏下沿');

  exec('user = "admin";');
  currentAuthUsername = 'admin';
  exec('toggleInventoryTree(1);');
  exec('renderAdminDb();');
  const adminDbHtml = document.getElementById('admin-db').innerHTML;
  assert(adminDbHtml.includes('库存管理'), '库存管理页应展示三级库存卡片');
  assert(adminDbHtml.includes('高山青菜'), '库存管理页应展示商品库存');
  assert(adminDbHtml.includes('大份'), '库存管理页展开后应展示规格库存');
  assert(adminDbHtml.includes('单位价格'), '库存管理页规格摘要应展示单位价格');

  exec('openInventoryUnitModal(1, "veg-large");');
  const inventoryModalHtml = document.getElementById('modal-root').innerHTML;
  assert(inventoryModalHtml.includes('单位价格'), '库存管理弹窗应展示单位价格');
  assert(inventoryModalHtml.includes('app-modal-card modal-compact'), '库存管理弹窗应复用统一的小尺寸移动端 modal 壳子');

  await execAsync('await showAdminPanel();');
  await flush(4);
  let adminNavHtml = document.getElementById('admin-nav-zone').innerHTML;
  assert(adminNavHtml.includes('workspace-nav-card'), '管理端应渲染当前菜单卡片');
  assert(adminNavHtml.includes('展开菜单'), '管理端当前菜单卡片应提示可展开');
  assert(adminNavHtml.includes('数据'), '管理端当前菜单卡片应显示当前页名称');
  assert(adminNavHtml.includes('workspace-nav-panel is-admin is-hidden'), '管理端菜单面板默认应收起');

  exec('toggleWorkspaceNav("admin");');
  adminNavHtml = document.getElementById('admin-nav-zone').innerHTML;
  assert(adminNavHtml.includes('切换后台工作区'), '管理端展开后应展示完整菜单面板');
  assert(adminNavHtml.includes('退款'), '管理端展开面板应展示共享菜单项');
  assert(!adminNavHtml.includes('切换到此菜单'), '展开面板不应再展示冗余引导文案');
  assert(adminNavHtml.includes('▾'), '卡片箭头应改成更协调的向下提示');
  assert(adminNavHtml.includes('onclick="switchAdminTab(\'ship\')"'), '管理端九宫格菜单项应保留可点击的安全切页事件');
  assert(!adminNavHtml.includes('workspace-nav-panel is-admin is-hidden'), '管理端菜单展开后不应保持 hidden');

  await execAsync('await switchAdminTab("ship");');
  await flush(4);
  adminNavHtml = document.getElementById('admin-nav-zone').innerHTML;
  assert(adminNavHtml.includes('发货'), '管理端切换后当前菜单卡片应更新为新页签');
  assert(adminNavHtml.includes('workspace-nav-panel is-admin is-hidden'), '管理端切页后菜单面板应自动收起');

  await execAsync('await showFarmerPanel();');
  await flush(4);
  let farmerNavHtml = document.getElementById('farmer-nav-zone').innerHTML;
  assert(farmerNavHtml.includes('workspace-nav-card'), '农户端应复用当前菜单卡片');
  assert(farmerNavHtml.includes('商品管理'), '农户端当前菜单卡片应显示当前页名称');
  assert(!document.getElementById('farmer-content').innerHTML.includes('grid grid-cols-2 gap-2 surface-card p-2'), '农户端不应再保留独立双按钮 strip');

  exec('toggleWorkspaceNav("farmer");');
  farmerNavHtml = document.getElementById('farmer-nav-zone').innerHTML;
  assert(farmerNavHtml.includes('切换农户工作区'), '农户端展开后应展示同一套导航面板');
  assert(farmerNavHtml.includes('发货地址'), '农户端展开面板应展示受权限约束的菜单项');
  assert(farmerNavHtml.includes('onclick="switchFarmerTab(\'ship\')"'), '农户端九宫格菜单项应保留可点击的安全切页事件');

  await execAsync('await switchFarmerTab("ship");');
  await flush(4);
  farmerNavHtml = document.getElementById('farmer-nav-zone').innerHTML;
  assert(farmerNavHtml.includes('发货地址'), '农户端切换后当前菜单卡片应更新为新页签');
  assert(farmerNavHtml.includes('workspace-nav-panel is-farmer is-hidden'), '农户端切页后菜单面板应自动收起');

  console.log('Variant unit UI smoke test passed.');
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
