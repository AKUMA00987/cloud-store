const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// [SMOKE_BOOTSTRAP] 冒烟测试统一从这里配置服务地址和请求助手。
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:3000';

async function requestJson(path, options) {
  const response = await fetch(baseUrl + path, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(path + ' 请求失败: ' + response.status + ' ' + text);
  }
  return response.json();
}

async function requestError(path, options) {
  const response = await fetch(baseUrl + path, options);
  const payload = await response.json().catch(async function () {
    return { message: await response.text() };
  });
  assert(!response.ok, path + ' 应返回失败结果');
  return { status: response.status, body: payload || {} };
}

function openDatabase() {
  const dbFilePath = path.join(__dirname, 'cloud-store.sqlite');
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

// [SMOKE_MAIN] 覆盖首页、商品、运营内容、登录注册、用户状态和上传链路的最小回归集合。
async function main() {
  const homeResponse = await fetch(baseUrl + '/');
  assert(homeResponse.ok, '首页应可正常访问');

  const originalBanners = await requestJson('/api/banners');
  const originalAnnouncements = await requestJson('/api/announcements');
  const products = await requestJson('/api/products');
  const searchKeyword = String((products[0] && products[0].name) || '').trim().slice(0, 2);
  const originalCategories = await requestJson('/api/categories');
  const originalCouponTemplates = await requestJson('/api/coupon-templates');
  const users = await requestJson('/api/users');
  const uploadResult = await requestJson('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      folder: 'smoke',
      fileName: 'tiny.png',
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9p0rG9sAAAAASUVORK5CYII='
    })
  });

  assert(Array.isArray(products) && products.length > 0, '商品接口应返回数据');
  assert(Array.isArray(products[0].variants) && products[0].variants.length >= 1, '旧商品应自动返回至少 1 条兼容规格');
  assert(Array.isArray(products[0].variants[0].units) && products[0].variants[0].units.length >= 1, '商品接口应返回至少 1 条单位记录');
  assert(products[0].orig === products[0].price, '无活动时商品原价字段应收敛为当前标准价');
  assert(searchKeyword, '应能从现有商品中提取搜索关键字');
  assert(Array.isArray(originalCategories) && originalCategories.length > 0, '商品分类接口应返回数据');
  assert(Array.isArray(originalBanners) && originalBanners.length > 0, 'Banner 接口应返回数据');
  assert(Array.isArray(originalAnnouncements), '公告接口应返回数组');
  assert(Array.isArray(originalCouponTemplates) && originalCouponTemplates.length > 0, '优惠券模板接口应返回数据');
  assert(Array.isArray(users) && users.some(function (item) { return item.username === 'admin'; }), '用户接口应返回管理员账号');
  assert(/^\/uploads\/smoke\//.test(uploadResult.url), '上传接口应返回可访问的图片路径');
  assert(fs.existsSync(path.join(__dirname, 'public', uploadResult.url.replace(/^\//, '').replace(/\//g, path.sep))), '上传后的图片文件应落到本地目录');

  const baseProduct = products[0];
  const variantizedProduct = Object.assign({}, baseProduct, {
    variants: [
      {
        id: 'smoke_small',
        label: '小份',
        price: 11,
        units: [
          { id: 'smoke_small_bag', label: '袋装', stock: 3, sortOrder: 0, isDefault: true },
          { id: 'smoke_small_box', label: '盒装', stock: 1, sortOrder: 1, isDefault: false }
        ],
        sortOrder: 0,
        isDefault: true
      },
      {
        id: 'smoke_large',
        label: '大份',
        price: 19,
        units: [
          { id: 'smoke_large_bag', label: '袋装', price: 21, stock: 5, sortOrder: 0, isDefault: true },
          { id: 'smoke_large_box', label: '箱装', price: 27, stock: 2, sortOrder: 1, isDefault: false }
        ],
        sortOrder: 1,
        isDefault: false
      }
    ]
  });
  const savedVariantProduct = await requestJson('/api/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(variantizedProduct)
  });
  assert(Array.isArray(savedVariantProduct.variants) && savedVariantProduct.variants.length === 2, '多规格商品保存后应返回两条规格');
  assert(savedVariantProduct.stock === 11, '商品总库存应等于单位库存合计');
  assert(savedVariantProduct.price === 11, '商品顶层价格应派生为默认单位价格');
  assert(savedVariantProduct.unit === '袋装', '商品顶层单位应派生为默认单位名称');
  assert(savedVariantProduct.variants[0].stock === 4, '规格库存应等于当前规格下单位库存合计');
  assert(savedVariantProduct.variants[0].units[0].label === '袋装', '规格应返回单位列表');
  assert(savedVariantProduct.variants[0].units[0].price === 11, '旧规格单位缺失价格时应继承父规格价格');
  assert(savedVariantProduct.variants[1].price === 21, '规格兼容价格应派生为默认单位价格');
  assert(savedVariantProduct.variants[1].units[1].price === 27, '显式单位价格应被保留');

  const smokeUsername = 'smoke_' + Date.now();
  const registeredUser = await requestJson('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: smokeUsername, password: '123456' })
  });
  assert(registeredUser.username === smokeUsername, '注册接口应返回新用户');
  assert(Array.isArray(registeredUser.coupons), '注册后应自动返回新人优惠券');

  const loginUser = await requestJson('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: smokeUsername, password: '123456' })
  });
  assert(loginUser.username === smokeUsername, '登录接口应返回对应用户');

  const savedUserState = await requestJson('/api/users/' + smokeUsername + '/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({}, loginUser, {
      addresses: [{ id: 'addr_test', name: '张三', phone: '13800000000', full: '测试地址' }],
      shippingAddresses: [{ id: 'ship_test', name: '李四', phone: '13900000000', full: '测试发货地址' }],
      selectedAddressId: 'addr_test',
      cart: [{
        id: savedVariantProduct.id,
        name: savedVariantProduct.name,
        variantId: 'smoke_large',
        variantLabel: '大份',
        unitId: 'smoke_large_bag',
        unitLabel: '袋装',
        price: 21,
        unit: '袋装',
        img: savedVariantProduct.img,
        qty: 1
      }],
      orders: [{
        id: 'ORD_SMOKE',
        items: [{
          id: savedVariantProduct.id,
          productId: savedVariantProduct.id,
          name: savedVariantProduct.name,
          variantId: 'smoke_large',
          variantLabel: '大份',
          unitId: 'smoke_large_bag',
          unitLabel: '袋装',
          price: 21,
          unit: '袋装',
          qty: 1,
          img: savedVariantProduct.img,
          shippingAddressId: 'ship_test',
          shippingAddressSnapshot: { id: 'ship_test', name: '李四', phone: '13900000000', full: '测试发货地址' }
        }],
        subtotal: 19,
        total: 24,
        status: 'paid',
        time: Date.now(),
        address: { name: '张三', phone: '13800000000', full: '测试地址' },
        coupon: ''
      }],
      member: { levelId: 'normal', points: 0, totalSpent: 18 }
    }))
  });
  assert(savedUserState.selectedAddressId === 'addr_test', '用户状态保存后应返回最新地址选择');
  assert(Array.isArray(savedUserState.shippingAddresses) && savedUserState.shippingAddresses.length === 1, '用户状态保存后应返回发货地址');
  assert(Array.isArray(savedUserState.orders) && savedUserState.orders.length === 1, '用户状态保存后应返回订单');
  assert(savedUserState.cart[0].variantId === 'smoke_large', '用户购物车保存后应返回规格快照字段');
  assert(savedUserState.cart[0].variantLabel === '大份', '用户购物车保存后应返回规格名称');
  assert(savedUserState.cart[0].unitId === 'smoke_large_bag', '用户购物车保存后应返回单位快照字段');
  assert(savedUserState.cart[0].unitLabel === '袋装', '用户购物车保存后应返回单位名称');

  const refreshedUsers = await requestJson('/api/users');
  const refreshedSmokeUser = refreshedUsers.find(function (item) { return item.username === smokeUsername; });
  assert(refreshedSmokeUser && refreshedSmokeUser.selectedAddressId === 'addr_test', '重新获取用户列表后应保留默认收货地址');
  assert(refreshedSmokeUser && Array.isArray(refreshedSmokeUser.shippingAddresses) && refreshedSmokeUser.shippingAddresses.length === 1, '重新获取用户列表后应保留发货地址');
  assert(refreshedSmokeUser && refreshedSmokeUser.cart && refreshedSmokeUser.cart[0] && refreshedSmokeUser.cart[0].variantId === 'smoke_large', '重新获取用户列表后应保留购物车规格快照');
  assert(refreshedSmokeUser && refreshedSmokeUser.cart && refreshedSmokeUser.cart[0] && refreshedSmokeUser.cart[0].unitId === 'smoke_large_bag', '重新获取用户列表后应保留购物车单位快照');

  const roleUpdatedUser = await requestJson('/api/users/' + smokeUsername + '/role', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roleType: 'farmer' })
  });
  assert(roleUpdatedUser.roles && roleUpdatedUser.roles.isFarmer === true, '权限更新后应返回农户角色');

  const checkoutAddress = { name: '张三', phone: '13800000000', full: '测试地址' };
  const shippingSnapshot = { id: 'ship_test', name: '李四', phone: '13900000000', full: '测试发货地址' };
  const prepareLargeOrder = await requestJson('/api/orders/prepare-payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: smokeUsername,
      items: [{
        id: savedVariantProduct.id,
        productId: savedVariantProduct.id,
        name: savedVariantProduct.name,
        variantId: 'smoke_large',
        variantLabel: '大份',
        unitId: 'smoke_large_bag',
        unitLabel: '袋装',
        unit: '袋装',
        price: 999,
        qty: 2,
        img: savedVariantProduct.img,
        shippingAddressId: 'ship_test',
        shippingAddressSnapshot: shippingSnapshot
      }],
      address: checkoutAddress,
      subtotal: 0,
      deliveryFee: 5,
      discount: 0,
      total: 0,
      couponId: '',
      couponText: ''
    })
  });
  assert(prepareLargeOrder.status === 'pending', '确认订单后应创建待支付订单');
  assert(Number(prepareLargeOrder.reserveExpiresAt || 0) > Number(prepareLargeOrder.time || 0), '待支付订单应返回 reserveExpiresAt');
  assert(prepareLargeOrder.items[0].price === 21, '待支付订单项成交价应来自所选单位价格');
  assert(prepareLargeOrder.total === 47, '待支付订单总价应按单位价格重新计算');

  const productsAfterReserve = await requestJson('/api/products');
  const reservedProduct = productsAfterReserve.find(function (item) { return item.id === savedVariantProduct.id; });
  assert(reservedProduct, '预占库存后商品仍应存在');
  const reservedLargeVariant = (reservedProduct.variants || []).find(function (item) { return item.id === 'smoke_large'; });
  const reservedLargeUnit = reservedLargeVariant && (reservedLargeVariant.units || []).find(function (item) { return item.id === 'smoke_large_bag'; });
  assert(reservedLargeUnit && reservedLargeUnit.stock === 3, '待支付订单创建后应立即扣减单位库存');
  assert(reservedLargeVariant && reservedLargeVariant.stock === 5, '待支付订单创建后规格库存应同步减少');
  assert(reservedProduct.stock === 9, '待支付订单创建后商品总库存应同步减少');

  const pendingPaymentLogs = await requestJson('/api/payment-transactions?orderId=' + encodeURIComponent(prepareLargeOrder.id) + '&username=' + encodeURIComponent(smokeUsername) + '&status=pending');
  assert(Array.isArray(pendingPaymentLogs) && pendingPaymentLogs.some(function (item) { return item.orderId === prepareLargeOrder.id; }), '待支付订单应写入 pending 支付流水');

  const paidPendingOrder = await requestJson('/api/orders/' + encodeURIComponent(prepareLargeOrder.id) + '/pay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerUsername: smokeUsername })
  });
  assert(paidPendingOrder.status === 'paid', '待支付订单支付后应切换为 paid');

  const productsAfterPendingPay = await requestJson('/api/products');
  const paidReservedProduct = productsAfterPendingPay.find(function (item) { return item.id === savedVariantProduct.id; });
  const paidLargeVariant = (paidReservedProduct.variants || []).find(function (item) { return item.id === 'smoke_large'; });
  const paidLargeUnit = paidLargeVariant && (paidLargeVariant.units || []).find(function (item) { return item.id === 'smoke_large_bag'; });
  assert(paidLargeUnit && paidLargeUnit.stock === 3, '支付成功后不应再次扣减单位库存');
  assert(paidReservedProduct.sales === Number(savedVariantProduct.sales || 0) + 2, '待支付订单支付成功后应累计销量');

  const paidPendingLogs = await requestJson('/api/payment-transactions?orderId=' + encodeURIComponent(prepareLargeOrder.id) + '&username=' + encodeURIComponent(smokeUsername) + '&status=paid');
  assert(Array.isArray(paidPendingLogs) && paidPendingLogs.some(function (item) { return item.orderId === prepareLargeOrder.id; }), '待支付订单支付成功后应更新支付流水状态');

  const prepareCancelOrder = await requestJson('/api/orders/prepare-payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: smokeUsername,
      items: [{
        id: savedVariantProduct.id,
        productId: savedVariantProduct.id,
        name: savedVariantProduct.name,
        variantId: 'smoke_small',
        variantLabel: '小份',
        unitId: 'smoke_small_bag',
        unitLabel: '袋装',
        unit: '袋装',
        price: 999,
        qty: 1,
        img: savedVariantProduct.img,
        shippingAddressId: 'ship_test',
        shippingAddressSnapshot: shippingSnapshot
      }],
      address: checkoutAddress,
      subtotal: 0,
      deliveryFee: 5,
      discount: 0,
      total: 0,
      couponId: '',
      couponText: ''
    })
  });
  const cancelledPendingOrder = await requestJson('/api/orders/' + encodeURIComponent(prepareCancelOrder.id) + '/cancel-pending', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerUsername: smokeUsername })
  });
  assert(cancelledPendingOrder.status === 'cancelled', '待支付取消后订单应变为 cancelled');
  assert(cancelledPendingOrder.cancelReason === 'buyer_pending_cancel', '待支付取消应记录 buyer_pending_cancel');
  assert(cancelledPendingOrder.inventoryReleased === true, '待支付取消后应标记库存已释放');

  const productsAfterCancel = await requestJson('/api/products');
  const cancelledProduct = productsAfterCancel.find(function (item) { return item.id === savedVariantProduct.id; });
  const cancelledSmallVariant = (cancelledProduct.variants || []).find(function (item) { return item.id === 'smoke_small'; });
  const cancelledSmallUnit = cancelledSmallVariant && (cancelledSmallVariant.units || []).find(function (item) { return item.id === 'smoke_small_bag'; });
  assert(cancelledSmallUnit && cancelledSmallUnit.stock === 3, '待支付取消后应恢复单位库存');
  assert(cancelledSmallVariant && cancelledSmallVariant.stock === 4, '待支付取消后应恢复规格库存');
  assert(cancelledProduct.stock === 9, '待支付取消后商品总库存应恢复');

  const secondCancelError = await requestError('/api/orders/' + encodeURIComponent(prepareCancelOrder.id) + '/cancel-pending', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerUsername: smokeUsername })
  });
  assert(String(secondCancelError.body.message || '').indexOf('不能重复取消') >= 0, '待支付订单第二次取消应被拦截');

  const cancelAftersales = await requestJson('/api/aftersales?orderId=' + encodeURIComponent(prepareCancelOrder.id) + '&username=' + encodeURIComponent(smokeUsername));
  assert(Array.isArray(cancelAftersales) && cancelAftersales.length === 0, '未支付取消不应污染售后台账');

  const prepareExpireOrder = await requestJson('/api/orders/prepare-payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: smokeUsername,
      items: [{
        id: savedVariantProduct.id,
        productId: savedVariantProduct.id,
        name: savedVariantProduct.name,
        variantId: 'smoke_small',
        variantLabel: '小份',
        unitId: 'smoke_small_bag',
        unitLabel: '袋装',
        unit: '袋装',
        price: 999,
        qty: 1,
        img: savedVariantProduct.img,
        shippingAddressId: 'ship_test',
        shippingAddressSnapshot: shippingSnapshot
      }],
      address: checkoutAddress,
      subtotal: 0,
      deliveryFee: 5,
      discount: 0,
      total: 0,
      couponId: '',
      couponText: ''
    })
  });

  const smokeDb = openDatabase();
  try {
    await smokeDb.run('UPDATE orders SET reserveExpiresAt = ? WHERE sourceId = ? AND username = ?', [Date.now() - 1000, prepareExpireOrder.id, smokeUsername]);
  } finally {
    await smokeDb.close();
  }

  const orderSnapshotsAfterTimeoutCleanup = await requestJson('/api/orders');
  const timeoutOrder = orderSnapshotsAfterTimeoutCleanup.find(function (item) { return item.id === prepareExpireOrder.id && item.owner === smokeUsername; });
  assert(timeoutOrder && timeoutOrder.status === 'cancelled', '超时清理后订单应自动取消');
  assert(timeoutOrder && timeoutOrder.cancelReason === 'timeout_release', '超时清理后应记录 timeout_release');
  assert(timeoutOrder && timeoutOrder.inventoryReleased === true, '超时清理后应标记库存已释放');

  const productsAfterTimeout = await requestJson('/api/products');
  const timeoutProduct = productsAfterTimeout.find(function (item) { return item.id === savedVariantProduct.id; });
  const timeoutSmallVariant = (timeoutProduct.variants || []).find(function (item) { return item.id === 'smoke_small'; });
  const timeoutSmallUnit = timeoutSmallVariant && (timeoutSmallVariant.units || []).find(function (item) { return item.id === 'smoke_small_bag'; });
  assert(timeoutSmallUnit && timeoutSmallUnit.stock === 3, '超时取消后应恢复单位库存');
  assert(timeoutSmallVariant && timeoutSmallVariant.stock === 4, '超时取消后应恢复规格库存');
  assert(timeoutProduct.stock === 9, '超时取消后商品总库存应恢复');

  const expiredPaymentLogs = await requestJson('/api/payment-transactions?orderId=' + encodeURIComponent(prepareExpireOrder.id) + '&username=' + encodeURIComponent(smokeUsername) + '&status=expired');
  assert(Array.isArray(expiredPaymentLogs) && expiredPaymentLogs.some(function (item) { return item.orderId === prepareExpireOrder.id; }), '超时取消后支付流水应标记为 expired');

  const timeoutInventoryLogs = await requestJson('/api/inventory-logs?orderId=' + encodeURIComponent(prepareExpireOrder.id) + '&actionType=order_release_timeout');
  assert(Array.isArray(timeoutInventoryLogs) && timeoutInventoryLogs.length >= 1, '超时取消后应记录 order_release_timeout 库存流水');

  const payAfterCancelError = await requestError('/api/orders/' + encodeURIComponent(prepareCancelOrder.id) + '/pay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerUsername: smokeUsername })
  });
  assert(String(payAfterCancelError.body.message || '').indexOf('订单已超时取消') >= 0, '已取消订单不应允许继续支付');

  const payAfterExpireError = await requestError('/api/orders/' + encodeURIComponent(prepareExpireOrder.id) + '/pay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerUsername: smokeUsername })
  });
  assert(String(payAfterExpireError.body.message || '').indexOf('订单已超时取消') >= 0, '已超时订单不应允许继续支付');

  const orderSnapshots = await requestJson('/api/orders');
  const smokeOrderSnapshot = orderSnapshots.find(function (item) { return item.id === 'ORD_SMOKE' && item.owner === smokeUsername; });
  assert(smokeOrderSnapshot && smokeOrderSnapshot.status === 'paid', '订单快照接口应返回新保存的订单');
  assert(smokeOrderSnapshot && smokeOrderSnapshot.items && smokeOrderSnapshot.items[0] && smokeOrderSnapshot.items[0].variantId === 'smoke_large', '订单快照接口应返回规格 ID');
  assert(smokeOrderSnapshot && smokeOrderSnapshot.items && smokeOrderSnapshot.items[0] && smokeOrderSnapshot.items[0].variantLabel === '大份', '订单快照接口应返回规格名称');
  assert(smokeOrderSnapshot && smokeOrderSnapshot.items && smokeOrderSnapshot.items[0] && smokeOrderSnapshot.items[0].unitId === 'smoke_large_bag', '订单快照接口应返回单位 ID');
  assert(smokeOrderSnapshot && smokeOrderSnapshot.items && smokeOrderSnapshot.items[0] && smokeOrderSnapshot.items[0].unitLabel === '袋装', '订单快照接口应返回单位名称');
  assert(smokeOrderSnapshot && smokeOrderSnapshot.items && smokeOrderSnapshot.items[0] && smokeOrderSnapshot.items[0].price === 21, '订单快照接口应返回单位成交价');

  const shippedOrder = await requestJson('/api/orders/ORD_SMOKE/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerUsername: smokeUsername, status: 'shipped', trackingNo: 'SMOKE-TRACK-001' })
  });
  assert(shippedOrder.status === 'shipped', '订单状态更新接口应返回已发货状态');
  assert(shippedOrder.trackingNo === 'SMOKE-TRACK-001', '订单状态更新接口应返回物流编号');

  const refreshedUsersAfterShip = await requestJson('/api/users');
  const shippedSmokeUser = refreshedUsersAfterShip.find(function (item) { return item.username === smokeUsername; });
  const shippedTrackedOrder = shippedSmokeUser && Array.isArray(shippedSmokeUser.orders)
    ? shippedSmokeUser.orders.find(function (item) { return item.id === 'ORD_SMOKE'; })
    : null;
  assert(shippedTrackedOrder && shippedTrackedOrder.trackingNo === 'SMOKE-TRACK-001', '用户订单应同步保存物流编号');

  const refundRequest = await requestJson('/api/orders/ORD_SMOKE/refund-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerUsername: smokeUsername, reason: '烟测退款原因' })
  });
  assert(refundRequest.orderId === 'ORD_SMOKE', '退款申请接口应返回对应订单');
  assert(refundRequest.status === 'pending', '退款申请接口应返回待处理状态');

  const refundQuery = await requestJson('/api/refunds?status=pending&orderId=ORD_SMOKE&ownerUsername=' + encodeURIComponent(smokeUsername));
  assert(Array.isArray(refundQuery) && refundQuery.some(function (item) { return item.orderId === 'ORD_SMOKE' && item.ownerUsername === smokeUsername; }), '退款筛选接口应能返回刚提交的退款申请');

  const searchResults = await requestJson('/api/products/search?q=' + encodeURIComponent(searchKeyword));
  assert(Array.isArray(searchResults) && searchResults.length > 0, '搜索接口应返回匹配商品数组');
  assert(searchResults.some(function (item) { return String(item.name || '').indexOf(searchKeyword) >= 0; }), '搜索接口应返回名称匹配关键字的商品');

  const paymentLogs = await requestJson('/api/payment-transactions?orderId=ORD_SMOKE&username=' + encodeURIComponent(smokeUsername) + '&status=paid');
  assert(Array.isArray(paymentLogs) && paymentLogs.some(function (item) { return item.orderId === 'ORD_SMOKE' && item.username === smokeUsername; }), '支付流水接口应能按订单和用户筛选');

  const aftersalesLogs = await requestJson('/api/aftersales?orderId=ORD_SMOKE&username=' + encodeURIComponent(smokeUsername) + '&type=refund');
  assert(Array.isArray(aftersalesLogs) && aftersalesLogs.some(function (item) { return item.orderId === 'ORD_SMOKE' && item.username === smokeUsername; }), '售后记录接口应能返回退款相关记录');

  const inventoryLogs = await requestJson('/api/inventory-logs');
  assert(Array.isArray(inventoryLogs), '库存流水接口应返回数组');

  const updatedTemplates = originalCouponTemplates.map(function (item, index) {
    return Object.assign({}, item, index === 0 ? { name: '联调模板券' } : {});
  });
  const couponTemplateSaveResult = await requestJson('/api/coupon-templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updatedTemplates)
  });
  assert(couponTemplateSaveResult[0].name === '联调模板券', '优惠券模板保存后应返回最新内容');

  const updatedCategories = originalCategories.map(function (item, index) {
    return Object.assign({}, item, index === 0 ? { name: '联调分类', icon: item.icon || '🧺', showOnHome: false } : {});
  });
  const categorySaveResult = await requestJson('/api/categories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updatedCategories)
  });
  assert(categorySaveResult[0].name === '联调分类', '商品分类保存后应返回最新名称');
  assert(categorySaveResult[0].showOnHome === false, '商品分类保存后应返回首页展示开关');

  const updatedBanners = originalBanners.map(function (item, index) {
    return Object.assign({}, item, {
      title: index === 0 ? '联调 Banner 标题' : item.title,
      sub: index === 0 ? '联调 Banner 副标题' : item.sub,
      linkType: index === 0 ? 'product' : (item.linkType || 'none'),
      productId: index === 0 && products[0] ? products[0].id : Number(item.productId || 0),
      externalUrl: index === 0 ? '' : (item.externalUrl || ''),
      sortOrder: index
    });
  });

  const bannerSaveResult = await requestJson('/api/banners', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updatedBanners)
  });
  assert(bannerSaveResult[0].title === '联调 Banner 标题', 'Banner 保存后应返回最新标题');
  assert(bannerSaveResult[0].linkType === 'product', 'Banner 保存后应返回最新跳转类型');
  assert(Number(bannerSaveResult[0].productId || 0) === products[0].id, 'Banner 保存后应返回绑定商品');

  const updatedAnnouncements = (originalAnnouncements.length ? originalAnnouncements : [{ text: '默认公告', active: true }]).map(function (item, index) {
    return Object.assign({}, item, {
      text: index === 0 ? '联调公告内容' : item.text,
      active: index === 0 ? true : item.active,
      linkType: index === 0 ? 'external' : (item.linkType || 'none'),
      externalUrl: index === 0 ? 'https://example.com/promo' : (item.externalUrl || ''),
      productId: index === 0 ? 0 : Number(item.productId || 0),
      sortOrder: index
    });
  });

  const announcementSaveResult = await requestJson('/api/announcements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updatedAnnouncements)
  });
  assert(announcementSaveResult[0].text === '联调公告内容', '公告保存后应返回最新内容');
  assert(announcementSaveResult[0].linkType === 'external', '公告保存后应返回最新跳转类型');
  assert(announcementSaveResult[0].externalUrl === 'https://example.com/promo', '公告保存后应返回最新外链地址');

  await requestJson('/api/banners', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(originalBanners)
  });
  await requestJson('/api/announcements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(originalAnnouncements)
  });
  await requestJson('/api/coupon-templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(originalCouponTemplates)
  });
  await requestJson('/api/categories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(originalCategories)
  });
  await requestJson('/api/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseProduct)
  });

  const deleteResult = await requestJson('/api/users/' + smokeUsername, {
    method: 'DELETE'
  });
  assert(deleteResult.deleted === true, '删除用户接口应返回删除成功');
  assert(deleteResult.preservedOrders >= 1, '删除用户时应保留订单快照');

  const usersAfterDelete = await requestJson('/api/users');
  assert(!usersAfterDelete.some(function (item) { return item.username === smokeUsername; }), '删除用户后用户列表中不应再出现该账号');

  const orderSnapshotsAfterDelete = await requestJson('/api/orders');
  const preservedOrder = orderSnapshotsAfterDelete.find(function (item) { return item.id === 'ORD_SMOKE' && item.owner === smokeUsername; });
  assert(preservedOrder && preservedOrder.ownerDeleted === true, '删除用户后应保留订单快照并标记为已删除用户');
  assert(preservedOrder && preservedOrder.trackingNo === 'SMOKE-TRACK-001', '删除用户后订单快照仍应保留物流编号');

  console.log('Server smoke test passed.');
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
