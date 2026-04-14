#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const baseDir = path.resolve(process.env.BASE_DIR || path.join(__dirname, '..', '..'));
const dbPath = path.resolve(process.env.DB_FILE || path.join(baseDir, 'cloud-store.sqlite'));
const disableDefaultSeedMarkerPath = path.resolve(
  process.env.CLOUD_STORE_DISABLE_SAMPLE_DATA_FILE || path.join(baseDir, '.disable-default-seed')
);
const adminUsername = String(process.env.ADMIN_USERNAME || 'admin').trim() || 'admin';
const passwordBuyerPhone = String(process.env.STAGING_PASSWORD_BUYER_PHONE || '13800000001').trim();
const smsBuyerPhone = String(process.env.STAGING_SMS_BUYER_PHONE || '13800000002').trim();
const passwordBuyerPassword = String(process.env.STAGING_PASSWORD_BUYER_PASSWORD || 'Test@123456').trim() || 'Test@123456';
const now = Date.now();
const today = new Date().toLocaleDateString('zh-CN');

if (!fs.existsSync(dbPath)) {
  console.error('database file not found:', dbPath);
  process.exit(1);
}

const db = new sqlite3.Database(dbPath);

function run(sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params || [], function (error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

function get(sql, params) {
  return new Promise((resolve, reject) => {
    db.get(sql, params || [], function (error, row) {
      if (error) reject(error);
      else resolve(row);
    });
  });
}

function closeDb() {
  return new Promise((resolve, reject) => {
    db.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function hashPassword(password, salt) {
  const normalizedSalt = String(salt || crypto.randomBytes(16).toString('hex'));
  const hash = crypto.scryptSync(String(password || ''), normalizedSalt, 64).toString('hex');
  return ['scrypt', normalizedSalt, hash].join('$');
}

function buildCoupon(id, templateId, name, type, amount, minSpend, discountRate) {
  return {
    id: id,
    templateId: templateId,
    name: name,
    type: type,
    discountRate: Number(discountRate || 0),
    amount: Number(amount || 0),
    minSpend: Number(minSpend || 0),
    used: false
  };
}

function buildVariant(id, label, unitId, unitLabel, price, stock) {
  return {
    id: id,
    label: label,
    price: Number(price || 0),
    stock: Number(stock || 0),
    isDefault: true,
    sortOrder: 0,
    units: [{
      id: unitId,
      label: unitLabel,
      unit: unitLabel,
      price: Number(price || 0),
      stock: Number(stock || 0),
      isDefault: true,
      sortOrder: 0
    }]
  };
}

function buildMember(totalSpent) {
  return {
    levelId: 'normal',
    points: Number(totalSpent || 0) > 0 ? 128 : 0,
    totalSpent: Number(totalSpent || 0)
  };
}

async function countTable(tableName, whereClause, params) {
  const row = await get(`SELECT COUNT(*) AS count FROM ${tableName}${whereClause ? ' ' + whereClause : ''}`, params || []);
  return Number((row && row.count) || 0);
}

async function ensureAdminExists() {
  const row = await get('SELECT id, username, password FROM users WHERE username = ?', [adminUsername]);
  if (!row) {
    throw new Error(`required admin account not found: ${adminUsername}`);
  }
  return row;
}

async function insertCategory(id, name, icon, sortOrder, showOnHome) {
  await run(
    'INSERT INTO categories (id, name, icon, sortOrder, showOnHome) VALUES (?, ?, ?, ?, ?)',
    [id, name, icon, Number(sortOrder || 0), showOnHome ? 1 : 0]
  );
}

async function insertCouponTemplate(template) {
  await run(
    'INSERT INTO coupon_templates (templateId, name, type, discountRate, amount, minSpend) VALUES (?, ?, ?, ?, ?, ?)',
    [template.templateId, template.name, template.type, Number(template.discountRate || 0), Number(template.amount || 0), Number(template.minSpend || 0)]
  );
}

async function insertUser(record) {
  await run(
    'INSERT INTO users (username, password, nickname, phone, phoneVerifiedAt, roles, addresses, shippingAddresses, coupons, selectedAddressId, selectedCouponId, cart, orders, member, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      record.username,
      record.password,
      record.nickname,
      record.phone,
      Number(record.phoneVerifiedAt || 0),
      JSON.stringify(record.roles || {}),
      JSON.stringify(record.addresses || []),
      JSON.stringify(record.shippingAddresses || []),
      JSON.stringify(record.coupons || []),
      record.selectedAddressId || '',
      record.selectedCouponId || '',
      JSON.stringify(record.cart || []),
      JSON.stringify(record.orders || []),
      JSON.stringify(record.member || buildMember(0)),
      record.createdAt || today
    ]
  );
}

async function insertUserCoupon(username, coupon, sortOrder) {
  await run(
    'INSERT INTO user_coupons (id, sourceId, username, templateId, name, type, discountRate, amount, minSpend, used, sortOrder) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      coupon.id,
      coupon.id,
      username,
      coupon.templateId,
      coupon.name,
      coupon.type,
      Number(coupon.discountRate || 0),
      Number(coupon.amount || 0),
      Number(coupon.minSpend || 0),
      coupon.used ? 1 : 0,
      Number(sortOrder || 0)
    ]
  );
}

async function insertProduct(record) {
  await run(
    'INSERT INTO products (id, name, price, orig, unit, cat, tags, stock, sales, harvest, dispatchHours, farmer, farmerAccount, farmerUserId, village, shippingAddressId, shippingAddressSnapshot, imagesJson, img, off, "trace", variantsJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      record.id,
      record.name,
      Number(record.price || 0),
      Number(record.orig != null ? record.orig : record.price || 0),
      record.unit,
      record.cat,
      JSON.stringify(record.tags || []),
      Number(record.stock || 0),
      Number(record.sales || 0),
      record.harvest,
      Number(record.dispatchHours || 4),
      record.farmer,
      record.farmerAccount,
      Number(record.farmerUserId || 0),
      record.village,
      record.shippingAddressId || '',
      JSON.stringify(record.shippingAddressSnapshot || {}),
      JSON.stringify(record.images || []),
      record.img || '',
      record.off ? 1 : 0,
      JSON.stringify(record.trace || []),
      JSON.stringify(record.variants || [])
    ]
  );

  await run(
    'INSERT INTO inventory_logs (productId, productName, operatorUsername, operatorRole, actionType, deltaStock, deltaSales, beforeStock, afterStock, beforeSales, afterSales, orderId, note, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      record.id,
      record.name,
      adminUsername,
      'admin',
      'create',
      Number(record.stock || 0),
      Number(record.sales || 0),
      0,
      Number(record.stock || 0),
      0,
      Number(record.sales || 0),
      '',
      'staging baseline seeded',
      now
    ]
  );
}

async function main() {
  const summary = {};
  const passwordBuyerCoupon = buildCoupon('stg_coupon_new_user', 'staging-new-user', '测试环境新人券', 'full_reduction', 8, 49, 0);
  const smsBuyerCoupon = buildCoupon('stg_coupon_fresh_discount', 'staging-fresh-discount', '测试环境鲜享券', 'discount', 0, 0, 8.8);

  await run('BEGIN IMMEDIATE');
  try {
    const admin = await ensureAdminExists();

    summary.orders = await countTable('orders');
    summary.orderItems = await countTable('order_items');
    summary.shipments = await countTable('shipments');
    summary.shipmentItems = await countTable('shipment_items');
    summary.payments = await countTable('payment_transactions');
    summary.aftersales = await countTable('aftersales');
    summary.refunds = await countTable('refund_requests');
    summary.inventoryLogs = await countTable('inventory_logs');
    summary.cartItems = await countTable('cart_items');
    summary.userCoupons = await countTable('user_coupons');
    summary.userAddresses = await countTable('user_addresses');
    summary.products = await countTable('products');
    summary.banners = await countTable('banners');
    summary.announcements = await countTable('announcements');
    summary.couponTemplates = await countTable('coupon_templates');
    summary.categories = await countTable('categories');
    summary.sessions = await countTable('sessions');
    summary.smsCodes = await countTable('sms_verification_codes');
    summary.nonAdminUsers = await countTable('users', 'WHERE username <> ?', [adminUsername]);

    await run('DELETE FROM order_items');
    await run('DELETE FROM orders');
    await run('DELETE FROM shipment_items');
    await run('DELETE FROM shipments');
    await run('DELETE FROM payment_transactions');
    await run('DELETE FROM aftersales');
    await run('DELETE FROM refund_requests');
    await run('DELETE FROM inventory_logs');
    await run('DELETE FROM cart_items');
    await run('DELETE FROM user_coupons');
    await run('DELETE FROM user_addresses');
    await run('DELETE FROM sessions');
    await run('DELETE FROM sms_verification_codes');
    await run('DELETE FROM banners');
    await run('DELETE FROM announcements');
    await run('DELETE FROM products');
    await run('DELETE FROM coupon_templates');
    await run('DELETE FROM categories');
    await run('DELETE FROM users WHERE username <> ?', [adminUsername]);

    await run(
      'UPDATE users SET nickname = ?, phone = ?, phoneVerifiedAt = ?, roles = ?, addresses = ?, shippingAddresses = ?, coupons = ?, selectedAddressId = ?, selectedCouponId = ?, cart = ?, orders = ?, member = ? WHERE username = ?',
      [
        '系统管理员',
        '',
        0,
        JSON.stringify({ isFarmer: true, isAdmin: true, isSuperAdmin: true, farmerName: '系统管理员' }),
        JSON.stringify([]),
        JSON.stringify([]),
        JSON.stringify([]),
        '',
        '',
        JSON.stringify([]),
        JSON.stringify([]),
        JSON.stringify(buildMember(680)),
        adminUsername
      ]
    );

    await insertCategory('veg', '新鲜蔬菜', 'leaf', 0, true);
    await insertCategory('fruit', '当季水果', 'apple', 1, true);
    await insertCategory('grain', '粮油干货', 'basket', 2, true);

    await insertCouponTemplate({
      templateId: 'staging-new-user',
      name: '测试环境新人券',
      type: 'full_reduction',
      amount: 8,
      minSpend: 49
    });
    await insertCouponTemplate({
      templateId: 'staging-fresh-discount',
      name: '测试环境鲜享券',
      type: 'discount',
      discountRate: 8.8,
      minSpend: 0
    });

    await insertUser({
      username: 'stage-buyer-password',
      password: hashPassword(passwordBuyerPassword),
      nickname: '测试密码用户',
      phone: passwordBuyerPhone,
      phoneVerifiedAt: now,
      roles: { isFarmer: false, isAdmin: false, isSuperAdmin: false, farmerName: 'stage-buyer-password' },
      coupons: [passwordBuyerCoupon],
      member: buildMember(256),
      createdAt: today
    });

    await insertUser({
      username: 'stage-buyer-sms',
      password: '',
      nickname: '',
      phone: smsBuyerPhone,
      phoneVerifiedAt: now,
      roles: { isFarmer: false, isAdmin: false, isSuperAdmin: false, farmerName: 'stage-buyer-sms' },
      coupons: [smsBuyerCoupon],
      member: buildMember(0),
      createdAt: today
    });

    await insertUserCoupon('stage-buyer-password', passwordBuyerCoupon, 0);
    await insertUserCoupon('stage-buyer-sms', smsBuyerCoupon, 0);

    await insertProduct({
      id: 9001,
      name: '测试环境小番茄',
      price: 19.8,
      orig: 19.8,
      unit: '盒',
      cat: 'veg',
      tags: ['staging', 'sample'],
      stock: 96,
      sales: 12,
      harvest: '测试环境当日采摘',
      dispatchHours: 6,
      farmer: '测试农场',
      farmerAccount: adminUsername,
      farmerUserId: admin.id,
      village: '测试一号基地',
      images: [],
      img: '',
      off: false,
      trace: ['测试环境样品商品，仅用于联调'],
      variants: [buildVariant('stg-tomato-default', '默认规格', 'box', '盒', 19.8, 96)]
    });

    await insertProduct({
      id: 9002,
      name: '测试环境玉米礼盒',
      price: 39.9,
      orig: 39.9,
      unit: '箱',
      cat: 'grain',
      tags: ['staging', 'sample'],
      stock: 48,
      sales: 5,
      harvest: '测试环境预包装',
      dispatchHours: 12,
      farmer: '测试农场',
      farmerAccount: adminUsername,
      farmerUserId: admin.id,
      village: '测试二号基地',
      images: [],
      img: '',
      off: false,
      trace: ['测试环境样品商品，仅用于支付和物流联调'],
      variants: [buildVariant('stg-corn-gift', '礼盒装', 'case', '箱', 39.9, 48)]
    });

    await run('COMMIT');

    fs.writeFileSync(disableDefaultSeedMarkerPath, `${new Date().toISOString()}\n`, 'utf8');

    console.log('staging data reset complete');
    console.log(`admin kept: ${admin.username} (id=${admin.id})`);
    console.log(`password buyer: ${passwordBuyerPhone} / ${passwordBuyerPassword}`);
    console.log(`sms buyer: ${smsBuyerPhone} (login with sms code only until password is set)`);
    console.log(`default sample data disabled marker: ${disableDefaultSeedMarkerPath}`);
    console.log('reseeded baseline: categories=yes, coupon_templates=yes, products=yes, test_buyers=yes');
    console.log('cleared rows summary:');
    Object.entries(summary).forEach(([key, value]) => {
      console.log(`- ${key}: ${value}`);
    });
  } catch (error) {
    try {
      await run('ROLLBACK');
    } catch (rollbackError) {
      console.error('rollback failed:', rollbackError.message);
    }
    throw error;
  } finally {
    await closeDb();
  }
}

main().catch((error) => {
  console.error('staging data reset failed:', error.message);
  process.exit(1);
});
