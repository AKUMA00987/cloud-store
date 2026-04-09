#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const baseDir = path.resolve(process.env.BASE_DIR || path.join(__dirname, '..', '..'));
const dbPath = path.resolve(process.env.DB_FILE || path.join(baseDir, 'cloud-store.sqlite'));
const disableDefaultSeedMarkerPath = path.resolve(
  process.env.CLOUD_STORE_DISABLE_SAMPLE_DATA_FILE || path.join(baseDir, '.disable-default-seed')
);
const adminUsername = String(process.env.ADMIN_USERNAME || 'admin').trim() || 'admin';

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

async function ensureAdminExists() {
  const row = await get('SELECT id, username, password FROM users WHERE username = ?', [adminUsername]);
  if (!row) {
    throw new Error(`required admin account not found: ${adminUsername}`);
  }
  return row;
}

async function countTable(tableName, whereClause, params) {
  const row = await get(`SELECT COUNT(*) AS count FROM ${tableName}${whereClause ? ' ' + whereClause : ''}`, params || []);
  return Number((row && row.count) || 0);
}

async function main() {
  const summary = {};
  await run('BEGIN IMMEDIATE');
  try {
    const admin = await ensureAdminExists();

    summary.orders = await countTable('orders');
    summary.orderItems = await countTable('order_items');
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
    summary.sessions = await countTable('sessions');
    summary.nonAdminUsers = await countTable('users', 'WHERE username <> ?', [adminUsername]);

    await run('DELETE FROM order_items');
    await run('DELETE FROM orders');
    await run('DELETE FROM payment_transactions');
    await run('DELETE FROM aftersales');
    await run('DELETE FROM refund_requests');
    await run('DELETE FROM inventory_logs');
    await run('DELETE FROM cart_items');
    await run('DELETE FROM user_coupons');
    await run('DELETE FROM user_addresses');
    await run('DELETE FROM products');
    await run('DELETE FROM banners');
    await run('DELETE FROM announcements');
    await run('DELETE FROM coupon_templates');
    await run('DELETE FROM sessions');
    await run('DELETE FROM users WHERE username <> ?', [adminUsername]);

    const adminRoles = JSON.stringify({
      isFarmer: true,
      isAdmin: true,
      isSuperAdmin: true,
      farmerName: '系统管理员'
    });
    const emptyArray = '[]';
    const emptyString = '';
    const adminMember = JSON.stringify({
      levelId: 'normal',
      points: 0,
      totalSpent: 0
    });

    await run(
      'UPDATE users SET roles = ?, addresses = ?, shippingAddresses = ?, coupons = ?, selectedAddressId = ?, selectedCouponId = ?, cart = ?, orders = ?, member = ? WHERE username = ?',
      [adminRoles, emptyArray, emptyArray, emptyArray, emptyString, emptyString, emptyArray, emptyArray, adminMember, adminUsername]
    );

    await run('COMMIT');

    fs.writeFileSync(disableDefaultSeedMarkerPath, `${new Date().toISOString()}\n`, 'utf8');

    console.log('launch data reset complete');
    console.log(`admin kept: ${admin.username} (id=${admin.id})`);
    console.log(`default sample data disabled marker: ${disableDefaultSeedMarkerPath}`);
    console.log('categories preserved: yes');
    console.log('uploads preserved: yes');
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
  console.error('launch data reset failed:', error.message);
  process.exit(1);
});
