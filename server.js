const express = require('express');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const sqlite3 = require('sqlite3').verbose();

// === SERVER_BOOTSTRAP ===
// [SERVER_BOOTSTRAP] Express、SQLite 路径和静态资源入口统一在文件头初始化。
const app = express();
const port = Number(process.env.PORT || 3000);
const dbPath = path.join(__dirname, 'cloud-store.sqlite');
const publicPath = path.join(__dirname, 'public');
const htmlPath = path.join(publicPath, 'index.html');
const uploadRootPath = path.join(publicPath, 'uploads');
const db = new sqlite3.Database(dbPath);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(publicPath));

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
  const uploadDir = ensureDirectory(path.join(uploadRootPath, sanitizeFileSegment(folderName || 'common')));
  const ext = mimeType === 'image/jpg' ? '.jpg' : getExtensionByMime(mimeType);
  const baseName = sanitizeFileSegment(path.parse(originalName || '').name || 'image');
  const fileName = Date.now() + '-' + baseName + ext;
  const filePath = path.join(uploadDir, fileName);
  fs.writeFileSync(filePath, matched[2], 'base64');
  return '/uploads/' + sanitizeFileSegment(folderName || 'common') + '/' + fileName;
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
    roles: normalizeRoleFlags(record && record.username, record && record.roles),
    addresses: Array.isArray(record && record.addresses) ? record.addresses : [],
    shippingAddresses: Array.isArray(record && record.shippingAddresses) ? record.shippingAddresses : [],
    coupons: Array.isArray(record && record.coupons) ? record.coupons : [],
    cart: Array.isArray(record && record.cart) ? record.cart : [],
    orders: Array.isArray(record && record.orders) ? record.orders : [],
    member: Object.assign({ levelId: 'normal', points: 0, totalSpent: 0 }, record && record.member || {})
  });
}

function publicUserRecord(record) {
  const user = normalizeUserRecord(record);
  delete user.password;
  return user;
}

function hydrateUser(row) {
  return normalizeUserRecord({
    id: row.id,
    username: row.username,
    password: row.password,
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
    total: 0,
    subtotal: 0,
    deliveryFee: 0,
    discount: 0,
    status: 'pending',
    time: Date.now(),
    address: {},
    coupon: '',
    couponId: '',
    trackingNo: ''
  }, order || {}, {
    id: order && order.id ? String(order.id) : '',
    owner: order && (order.owner || order.username) ? String(order.owner || order.username) : '',
    ownerDeleted: !!(order && order.ownerDeleted),
    items: Array.isArray(order && order.items) ? order.items : [],
    total: Number(order && order.total || 0),
    subtotal: Number(order && order.subtotal || 0),
    deliveryFee: Number(order && order.deliveryFee || 0),
    discount: Number(order && order.discount || 0),
    status: order && order.status ? String(order.status) : 'pending',
    time: Number(order && order.time || Date.now()),
    address: order && order.address && typeof order.address === 'object' && !Array.isArray(order.address) ? order.address : {},
    coupon: order && order.coupon ? String(order.coupon) : '',
    couponId: order && order.couponId ? String(order.couponId) : '',
    trackingNo: order && order.trackingNo ? String(order.trackingNo) : ''
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

function normalizeOrderItem(item, index) {
  return Object.assign({
    id: 0,
    productId: 0,
    name: '',
    unit: '',
    price: 0,
    qty: 0,
    img: '',
    shippingAddressId: '',
    shippingAddressSnapshot: {}
  }, item || {}, {
    id: item && item.id ? Number(item.id) : index + 1,
    productId: Number(item && item.id || item && item.productId || 0),
    name: item && item.name ? String(item.name) : '',
    unit: item && item.unit ? String(item.unit) : '',
    price: Number(item && item.price || 0),
    qty: Number(item && item.qty || 0),
    img: item && item.img ? String(item.img) : '',
    shippingAddressId: item && item.shippingAddressId ? String(item.shippingAddressId) : '',
    shippingAddressSnapshot: item && item.shippingAddressSnapshot && typeof item.shippingAddressSnapshot === 'object' && !Array.isArray(item.shippingAddressSnapshot) ? item.shippingAddressSnapshot : {}
  });
}

function hydrateOrderRows(orderRow, itemRows) {
  const items = (itemRows || []).map(function (itemRow, index) {
    return normalizeOrderItem({
      id: itemRow.productId,
      productId: itemRow.productId,
      name: itemRow.name,
      unit: itemRow.unit,
      price: itemRow.price,
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
    trackingNo: orderRow.trackingNo
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
  await run('DELETE FROM order_items WHERE orderId IN (SELECT id FROM orders WHERE username = ?)', [username]);
  await run('DELETE FROM orders WHERE username = ?', [username]);
  const orderList = Array.isArray(orders) ? orders : [];
  for (let orderIndex = 0; orderIndex < orderList.length; orderIndex++) {
    const order = normalizeOrderRecord(orderList[orderIndex]);
    const relationOrderId = username + ':' + order.id;
    await run(
      'INSERT INTO orders (id, sourceId, username, status, total, subtotal, deliveryFee, discount, couponText, couponId, receiverName, receiverPhone, receiverFull, trackingNo, ownerDeleted, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
        order.time
      ]
    );
    for (let itemIndex = 0; itemIndex < order.items.length; itemIndex++) {
      const item = normalizeOrderItem(order.items[itemIndex], itemIndex);
      await run(
        'INSERT INTO order_items (orderId, productId, name, unit, price, qty, img, shippingAddressId, shippingName, shippingPhone, shippingFull, sortOrder) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          relationOrderId,
          item.productId,
          item.name,
          item.unit,
          item.price,
          item.qty,
          item.img,
          item.shippingAddressId,
          item.shippingAddressSnapshot && item.shippingAddressSnapshot.name ? item.shippingAddressSnapshot.name : '',
          item.shippingAddressSnapshot && item.shippingAddressSnapshot.phone ? item.shippingAddressSnapshot.phone : '',
          item.shippingAddressSnapshot && item.shippingAddressSnapshot.full ? item.shippingAddressSnapshot.full : '',
          itemIndex
        ]
      );
    }
  }
}

async function listUserOrderRelations(username) {
  const orderRows = await all('SELECT * FROM orders WHERE username = ? ORDER BY createdAt DESC, id DESC', [username]);
  const itemRows = await all(
    'SELECT oi.* FROM order_items oi INNER JOIN orders o ON o.id = oi.orderId WHERE o.username = ? ORDER BY oi.orderId ASC, oi.sortOrder ASC, oi.id ASC',
    [username]
  );
  const itemsByOrderId = itemRows.reduce(function (result, row) {
    if (!result[row.orderId]) result[row.orderId] = [];
    result[row.orderId].push(row);
    return result;
  }, {});
  return orderRows.map(function (row) {
    return hydrateOrderRows(row, itemsByOrderId[row.id] || []);
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
  const itemsByOrderId = itemRows.reduce(function (result, row) {
    if (!result[row.orderId]) result[row.orderId] = [];
    result[row.orderId].push(row);
    return result;
  }, {});
  return orderRows.map(function (row) {
    return hydrateOrderRows(Object.assign({}, row, {
      ownerDeleted: row.ownerDeleted || !activeUsers[row.username]
    }), itemsByOrderId[row.id] || []);
  });
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
    createdAt: Number(row && row.createdAt || 0),
    paidAt: Number(row && row.paidAt || 0)
  };
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
    price: Number(item && item.price || 0),
    unit: item && item.unit ? String(item.unit) : '',
    img: item && item.img ? String(item.img) : '',
    qty: Number(item && item.qty || 0),
    sortOrder: Number(item && item.sortOrder != null ? item.sortOrder : index || 0)
  };
}

function hydrateCartItem(row) {
  return {
    id: row.productId,
    name: row.name,
    price: row.price,
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
      'INSERT INTO cart_items (username, productId, name, price, unit, img, qty, sortOrder) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [username, item.productId, item.name, item.price, item.unit, item.img, item.qty, index]
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
    'INSERT OR IGNORE INTO payment_transactions (id, username, orderId, amount, status, channel, couponId, couponText, receiverName, receiverPhone, receiverFull, createdAt, paidAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
    const currentAftersaleType = getAftersaleTypeByStatus(currentOrder.status);
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
      if (getAftersaleTypeByStatus(order.status)) {
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
  return Object.assign({
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
    img: '',
    off: false,
    trace: []
  }, product || {}, {
    id: product && product.id ? Number(product.id) : undefined,
    price: Number(product && product.price || 0),
    orig: Number(product && (product.orig != null ? product.orig : product.price) || 0),
    stock: Number(product && product.stock || 0),
    sales: Number(product && product.sales || 0),
    dispatchHours: Number(product && product.dispatchHours || 4),
    off: !!(product && product.off),
    tags: Array.isArray(product && product.tags) ? product.tags : [],
    shippingAddressId: product && product.shippingAddressId ? String(product.shippingAddressId) : '',
    shippingAddressSnapshot: product && product.shippingAddressSnapshot && typeof product.shippingAddressSnapshot === 'object' && !Array.isArray(product.shippingAddressSnapshot) ? product.shippingAddressSnapshot : {},
    trace: Array.isArray(product && product.trace) ? product.trace : []
  });
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
    img: row.img,
    off: !!row.off,
    trace: parseJsonArray(row.trace)
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
    img: item.img || '',
    off: item.off ? 1 : 0,
    trace: JSON.stringify(item.trace || [])
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
    'INSERT INTO products (id, name, price, orig, unit, cat, tags, stock, sales, harvest, dispatchHours, farmer, farmerAccount, farmerUserId, village, shippingAddressId, shippingAddressSnapshot, img, off, "trace") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
      item.img,
      item.off,
      item.trace
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
    'UPDATE products SET name = ?, price = ?, orig = ?, unit = ?, cat = ?, tags = ?, stock = ?, sales = ?, harvest = ?, dispatchHours = ?, farmer = ?, farmerAccount = ?, farmerUserId = ?, village = ?, shippingAddressId = ?, shippingAddressSnapshot = ?, img = ?, off = ?, "trace" = ? WHERE id = ?',
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
      item.img,
      item.off,
      item.trace,
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

async function seedProductsIfNeeded() {
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
  const row = await get('SELECT COUNT(*) AS count FROM coupon_templates');
  if (row && row.count > 0) return;
  await saveCouponTemplateList(createDefaultCouponTemplates());
}

async function getCouponTemplateList() {
  await seedCouponTemplatesIfNeeded();
  const rows = await all('SELECT * FROM coupon_templates ORDER BY id ASC');
  return rows.map(hydrateCouponTemplate);
}

async function insertUser(record) {
  const user = toDbUser(record);
  const result = await run(
    'INSERT INTO users (username, password, roles, addresses, shippingAddresses, coupons, selectedAddressId, selectedCouponId, cart, orders, member, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [user.username, user.password, user.roles, user.addresses, user.shippingAddresses, user.coupons, user.selectedAddressId, user.selectedCouponId, user.cart, user.orders, user.member, user.createdAt]
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
    'UPDATE users SET password = ?, roles = ?, addresses = ?, shippingAddresses = ?, coupons = ?, selectedAddressId = ?, selectedCouponId = ?, cart = ?, orders = ?, member = ?, createdAt = ? WHERE username = ?',
    [user.password, user.roles, user.addresses, user.shippingAddresses, user.coupons, user.selectedAddressId, user.selectedCouponId, user.cart, user.orders, user.member, user.createdAt, user.username]
  );
  await syncUserAddressRelations(user.username, JSON.parse(user.addresses), JSON.parse(user.shippingAddresses));
  await syncUserOrderRelations(user.username, JSON.parse(user.orders));
  await syncUserCartRelations(user.username, JSON.parse(user.cart));
  await syncUserCouponRelations(user.username, JSON.parse(user.coupons));
  return result.changes;
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

async function restoreInventoryByRefund(refund, actorUsername) {
  const items = Array.isArray(refund && refund.itemsSnapshot) ? refund.itemsSnapshot : [];
  for (let index = 0; index < items.length; index++) {
    const item = normalizeOrderItem(items[index], index);
    const row = await get('SELECT * FROM products WHERE id = ?', [item.productId]);
    if (!row) throw new Error(item.name + ' 已不存在，无法完成退款回库');
    const product = hydrateProduct(row);
    await updateProduct(Object.assign({}, product, {
      stock: Number(product.stock || 0) + Number(item.qty || 0),
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
    const refundResult = await executeMockRefund(refund, actor.username);
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
    await updateUser(normalizedAdmin);
    return;
  }
  await insertUser(normalizeUserRecord({
    username: 'admin',
    password: 'admin123',
    roles: { isFarmer: true, isAdmin: true, isSuperAdmin: true, farmerName: '系统管理员' },
    addresses: [],
    coupons: [],
    cart: [],
    orders: [],
    member: { levelId: 'normal', points: 0, totalSpent: 680 },
    createdAt: new Date().toLocaleDateString('zh-CN')
  }));
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
      img TEXT NOT NULL DEFAULT '',
      off INTEGER NOT NULL DEFAULT 0,
      "trace" TEXT NOT NULL DEFAULT '[]'
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL DEFAULT '',
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
      createdAt INTEGER NOT NULL DEFAULT 0
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      orderId TEXT NOT NULL,
      productId INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL DEFAULT '',
      unit TEXT NOT NULL DEFAULT '',
      price REAL NOT NULL DEFAULT 0,
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
    CREATE TABLE IF NOT EXISTS cart_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      productId INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL DEFAULT '',
      price REAL NOT NULL DEFAULT 0,
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
    img: "TEXT NOT NULL DEFAULT ''",
    off: 'INTEGER NOT NULL DEFAULT 0',
    trace: "TEXT NOT NULL DEFAULT '[]'"
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
    ownerDeleted: 'INTEGER NOT NULL DEFAULT 0'
  };
  for (const key of Object.keys(orderDefinitions)) {
    if (!orderExisting[key]) await run('ALTER TABLE orders ADD COLUMN ' + key + ' ' + orderDefinitions[key]);
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
  await seedCategoriesIfNeeded();
  await seedCouponTemplatesIfNeeded();
  await seedAdminIfNeeded();
  await backfillUserRelationsFromJson();
  // 支付与售后都能从现有订单状态回填；库存流水缺少历史差值，只能从本次版本开始持续积累。
  await backfillOrderDerivedRelations();
}

// [API_PRODUCTS] 商品列表和商品按 ID 新增/覆盖都走这组接口。
app.get('/api/products', async function (req, res) {
  try {
    await seedProductsIfNeeded();
    const rows = await all('SELECT * FROM products ORDER BY id ASC');
    res.json(rows.map(hydrateProduct));
  } catch (error) {
    res.status(500).json({ message: '获取商品失败', error: error.message });
  }
});

app.post('/api/products', async function (req, res) {
  try {
    const payload = normalizeProduct(req.body || {});
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
    const payload = req.body || {};
    const imageUrl = writeDataUrlImage(payload.dataUrl, payload.folder, payload.fileName);
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
    const orders = await listAllOrderSnapshots();
    res.json(orders);
  } catch (error) {
    res.status(500).json({ message: '获取订单快照失败', error: error.message });
  }
});

app.get('/api/refunds', async function (req, res) {
  try {
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
    const sourceOrderId = String(req.params.orderId || '').trim();
    const ownerUsername = String(req.body && req.body.ownerUsername || '').trim();
    const reason = String(req.body && req.body.reason || '').trim();
    const refund = await createRefundRequestForOrder(ownerUsername, sourceOrderId, reason);
    res.json(refund);
  } catch (error) {
    res.status(400).json({ message: error.message || '退款申请提交失败', error: error.message });
  }
});

app.post('/api/orders/:orderId/status', async function (req, res) {
  try {
    const sourceOrderId = String(req.params.orderId || '').trim();
    const ownerUsername = String(req.body && req.body.ownerUsername || '').trim();
    const status = String(req.body && req.body.status || '').trim();
    const trackingNo = String(req.body && req.body.trackingNo || '').trim();
    if (!sourceOrderId || !ownerUsername || !status) return res.status(400).json({ message: '订单状态更新参数不完整' });
    if (status === 'shipped' && !trackingNo) return res.status(400).json({ message: '请先填写物流编号' });
    const updated = await updateOrderSnapshotStatus(ownerUsername, sourceOrderId, status, trackingNo);
    if (!updated) return res.status(404).json({ message: '订单不存在' });
    res.json(updated);
  } catch (error) {
    res.status(400).json({ message: error.message || '订单状态保存失败', error: error.message });
  }
});

app.post('/api/refunds/:refundId/reject', async function (req, res) {
  try {
    const refundId = String(req.params.refundId || '').trim();
    const actorUsername = String(req.body && req.body.actorUsername || '').trim();
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
    const actorUsername = String(req.body && req.body.actorUsername || '').trim();
    const refund = await completeRefundRequest(refundId, actorUsername);
    res.json(refund);
  } catch (error) {
    res.status(400).json({ message: error.message || '退款完成失败', error: error.message });
  }
});

// [API_USERS_AUTH] 用户列表、登录注册、状态落库、角色授权都集中在这里。
app.get('/api/users', async function (req, res) {
  try {
    const users = await listUsers();
    res.json(users.map(publicUserRecord));
  } catch (error) {
    res.status(500).json({ message: '获取用户失败', error: error.message });
  }
});

app.post('/api/auth/login', async function (req, res) {
  try {
    const payload = req.body || {};
    const user = await getUserByUsername(String(payload.username || '').trim());
    if (!user || user.password !== String(payload.password || '')) {
      return res.status(401).json({ message: '用户名或密码错误' });
    }
    res.json(publicUserRecord(user));
  } catch (error) {
    res.status(500).json({ message: '登录失败', error: error.message });
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
      password: password,
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
    res.json(publicUserRecord(created));
  } catch (error) {
    res.status(500).json({ message: '注册失败', error: error.message });
  }
});

app.post('/api/users/:username/state', async function (req, res) {
  try {
    const username = String(req.params.username || '').trim();
    const existing = await getUserByUsername(username);
    if (!existing) return res.status(404).json({ message: '用户不存在' });
    const payload = normalizeUserRecord(Object.assign({}, existing, req.body || {}, { username: username, password: existing.password }));
    await updateUser(payload);
    await syncOrderDerivedRelations(username, existing.orders, payload.orders, normalizeAuditMeta(req.body && req.body._audit, {
      operatorUsername: username,
      operatorRole: 'system',
      channel: 'mock_h5'
    }));
    const updated = await getUserByUsername(username);
    res.json(publicUserRecord(updated));
  } catch (error) {
    res.status(500).json({ message: '保存用户数据失败', error: error.message });
  }
});

app.post('/api/users/:username/role', async function (req, res) {
  try {
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
      return res.json(publicUserRecord(updatedAdmin));
    }
    const roleType = String(req.body && req.body.roleType || 'normal');
    existing.roles = { isFarmer: false, isAdmin: false, isSuperAdmin: false, farmerName: username };
    if (roleType === 'farmer') existing.roles.isFarmer = true;
    if (roleType === 'admin') existing.roles.isAdmin = true;
    await updateUser(existing);
    const updated = await getUserByUsername(username);
    res.json(publicUserRecord(updated));
  } catch (error) {
    res.status(500).json({ message: '保存用户权限失败', error: error.message });
  }
});

app.delete('/api/users/:username', async function (req, res) {
  try {
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
    app.listen(port, function () {
      console.log('cloud-store server running on port ' + port);
    });
  })
  .catch(function (error) {
    console.error('init database failed:', error);
    process.exit(1);
  });
