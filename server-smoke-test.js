const assert = require('assert');
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

async function main() {
  const anonClient = new SessionClient();
  const homeResponse = await anonClient.request('/');
  assert(homeResponse.ok, '首页应可正常访问');
  const healthPayload = await anonClient.requestJson('/healthz');
  assert(healthPayload && healthPayload.ok === true, '健康检查接口应返回 ok=true');
  assert(healthPayload.service === 'cloud-store', '健康检查接口应返回服务标识');
  assert(healthPayload.storage && healthPayload.storage.database, '健康检查接口应返回最小运行状态');

  const publicProducts = await anonClient.requestJson('/api/products');
  const publicProductPage = await anonClient.requestJson('/api/products?page=1&pageSize=2&status=active');
  const publicProduct = publicProducts.find(function (item) {
    return item
      && item.id
      && item.shippingAddressId
      && item.shippingAddressSnapshot
      && item.shippingAddressSnapshot.full
      && Array.isArray(item.variants)
      && item.variants[0]
      && Array.isArray(item.variants[0].units)
      && item.variants[0].units[0];
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
  const buyerUsername = 'phase12_buyer_' + Date.now();
  const buyerPassword = 'buyer123456';
  const registeredBuyer = await buyerClient.requestJson('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: buyerUsername, password: buyerPassword })
  });
  assert(registeredBuyer.username === buyerUsername, '注册应返回新用户');
  assert(!Object.prototype.hasOwnProperty.call(registeredBuyer, 'password'), '注册返回不应暴露密码字段');

  const buyerSessionUser = await buyerClient.requestJson('/api/auth/me');
  assert(buyerSessionUser.username === buyerUsername, '注册后应自动建立会话');

  const buyerUsers = await buyerClient.requestJson('/api/users');
  assert(Array.isArray(buyerUsers) && buyerUsers.length === 1, '普通用户只应拿到自身资料');
  assert(buyerUsers[0].username === buyerUsername, '普通用户资料应是当前账号');
  assert(!Object.prototype.hasOwnProperty.call(buyerUsers[0], 'password'), '普通用户资料不应暴露密码字段');

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
  assert(fs.existsSync(path.join(__dirname, 'public', uploadResult.url.replace(/^\//, '').replace(/\//g, path.sep))), '上传文件应落盘成功');

  const adminLightStats = await adminClient.requestJson('/api/admin/light-stats');
  assert(typeof adminLightStats.productCount === 'number', '管理员应能读取轻量统计');

  const buyerOrderPrepare = await buyerClient.requestJson('/api/orders/prepare-payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{
        id: publicProduct.id,
        productId: publicProduct.id,
        name: publicProduct.name,
        variantId: publicProduct.variants[0].id,
        variantLabel: publicProduct.variants[0].label,
        unitId: publicProduct.variants[0].units[0].id,
        unitLabel: publicProduct.variants[0].units[0].label,
        unit: publicProduct.variants[0].units[0].label,
        price: 999,
        qty: 1,
        img: publicProduct.img,
        shippingAddressId: publicProduct.shippingAddressId || '',
        shippingAddressSnapshot: publicProduct.shippingAddressSnapshot || {}
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

  const buyerPaidOrder = await buyerClient.requestJson('/api/orders/' + encodeURIComponent(buyerOrderPrepare.id) + '/pay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert(buyerPaidOrder.status === 'paid', '买家应能支付自己的待支付订单');

  const adminOrdersPage = await adminClient.requestJson('/api/orders?page=1&pageSize=20&ownerUsername=' + encodeURIComponent(buyerUsername));
  assert(Array.isArray(adminOrdersPage.items) && adminOrdersPage.items.some(function (item) { return item.id === buyerOrderPrepare.id; }), '管理员应能查看指定买家订单');

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
