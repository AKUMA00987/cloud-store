const assert = require('assert');
const fs = require('fs');
const path = require('path');

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

// [SMOKE_MAIN] 覆盖首页、商品、运营内容、登录注册、用户状态和上传链路的最小回归集合。
async function main() {
  const homeResponse = await fetch(baseUrl + '/');
  assert(homeResponse.ok, '首页应可正常访问');

  const originalBanners = await requestJson('/api/banners');
  const originalAnnouncements = await requestJson('/api/announcements');
  const products = await requestJson('/api/products');
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
  assert(Array.isArray(originalCategories) && originalCategories.length > 0, '商品分类接口应返回数据');
  assert(Array.isArray(originalBanners) && originalBanners.length > 0, 'Banner 接口应返回数据');
  assert(Array.isArray(originalAnnouncements), '公告接口应返回数组');
  assert(Array.isArray(originalCouponTemplates) && originalCouponTemplates.length > 0, '优惠券模板接口应返回数据');
  assert(Array.isArray(users) && users.some(function (item) { return item.username === 'admin'; }), '用户接口应返回管理员账号');
  assert(/^\/uploads\/smoke\//.test(uploadResult.url), '上传接口应返回可访问的图片路径');
  assert(fs.existsSync(path.join(__dirname, 'public', uploadResult.url.replace(/^\//, '').replace(/\//g, path.sep))), '上传后的图片文件应落到本地目录');

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
      cart: [{ id: products[0].id, name: products[0].name, price: products[0].price, unit: products[0].unit, img: products[0].img, qty: 1 }],
      orders: [{ id: 'ORD_SMOKE', items: [], total: 18, status: 'paid', time: Date.now(), address: { name: '张三' }, coupon: '' }],
      member: { levelId: 'normal', points: 0, totalSpent: 18 }
    }))
  });
  assert(savedUserState.selectedAddressId === 'addr_test', '用户状态保存后应返回最新地址选择');
  assert(Array.isArray(savedUserState.shippingAddresses) && savedUserState.shippingAddresses.length === 1, '用户状态保存后应返回发货地址');
  assert(Array.isArray(savedUserState.orders) && savedUserState.orders.length === 1, '用户状态保存后应返回订单');

  const refreshedUsers = await requestJson('/api/users');
  const refreshedSmokeUser = refreshedUsers.find(function (item) { return item.username === smokeUsername; });
  assert(refreshedSmokeUser && refreshedSmokeUser.selectedAddressId === 'addr_test', '重新获取用户列表后应保留默认收货地址');
  assert(refreshedSmokeUser && Array.isArray(refreshedSmokeUser.shippingAddresses) && refreshedSmokeUser.shippingAddresses.length === 1, '重新获取用户列表后应保留发货地址');

  const roleUpdatedUser = await requestJson('/api/users/' + smokeUsername + '/role', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roleType: 'farmer' })
  });
  assert(roleUpdatedUser.roles && roleUpdatedUser.roles.isFarmer === true, '权限更新后应返回农户角色');

  const orderSnapshots = await requestJson('/api/orders');
  const smokeOrderSnapshot = orderSnapshots.find(function (item) { return item.id === 'ORD_SMOKE' && item.owner === smokeUsername; });
  assert(smokeOrderSnapshot && smokeOrderSnapshot.status === 'paid', '订单快照接口应返回新保存的订单');

  const shippedOrder = await requestJson('/api/orders/ORD_SMOKE/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerUsername: smokeUsername, status: 'shipped', trackingNo: 'SMOKE-TRACK-001' })
  });
  assert(shippedOrder.status === 'shipped', '订单状态更新接口应返回已发货状态');
  assert(shippedOrder.trackingNo === 'SMOKE-TRACK-001', '订单状态更新接口应返回物流编号');

  const refreshedUsersAfterShip = await requestJson('/api/users');
  const shippedSmokeUser = refreshedUsersAfterShip.find(function (item) { return item.username === smokeUsername; });
  assert(shippedSmokeUser && shippedSmokeUser.orders && shippedSmokeUser.orders[0] && shippedSmokeUser.orders[0].trackingNo === 'SMOKE-TRACK-001', '用户订单应同步保存物流编号');

  const refundRequest = await requestJson('/api/orders/ORD_SMOKE/refund-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerUsername: smokeUsername, reason: '烟测退款原因' })
  });
  assert(refundRequest.orderId === 'ORD_SMOKE', '退款申请接口应返回对应订单');
  assert(refundRequest.status === 'pending', '退款申请接口应返回待处理状态');

  const refundQuery = await requestJson('/api/refunds?status=pending&orderId=ORD_SMOKE&ownerUsername=' + encodeURIComponent(smokeUsername));
  assert(Array.isArray(refundQuery) && refundQuery.some(function (item) { return item.orderId === 'ORD_SMOKE' && item.ownerUsername === smokeUsername; }), '退款筛选接口应能返回刚提交的退款申请');

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
