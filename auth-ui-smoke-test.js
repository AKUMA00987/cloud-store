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
    className: '',
    src: '',
    files: [],
    disabled: false,
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
  let scheduledTimer = null;

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

  const categories = [{ id: 'veg', name: '新鲜蔬菜', icon: '🥬', sortOrder: 0, showOnHome: true }];
  const users = [
    {
      id: 0,
      username: 'admin',
      nickname: '系统管理员',
      hasPassword: true,
      phone: '',
      phoneVerifiedAt: 0,
      roles: { isFarmer: false, isAdmin: true, isSuperAdmin: true, farmerName: 'admin' },
      addresses: [],
      shippingAddresses: [],
      coupons: [],
      selectedAddressId: '',
      selectedCouponId: '',
      cart: [],
      orders: [],
      member: { levelId: 'normal', points: 0, totalSpent: 0 },
      createdAt: '2026/04/10',
      password: 'admin123456'
    },
    {
      id: 1,
      username: 'buyer1',
      nickname: '',
      hasPassword: true,
      phone: '',
      phoneVerifiedAt: 0,
      roles: { isFarmer: false, isAdmin: false, isSuperAdmin: false, farmerName: 'buyer1' },
      addresses: [{ id: 'addr1', name: '张三', phone: '13800000000', full: '测试收货地址' }],
      shippingAddresses: [],
      coupons: [],
      selectedAddressId: 'addr1',
      selectedCouponId: '',
      cart: [],
      orders: [],
      member: { levelId: 'normal', points: 0, totalSpent: 0 },
      createdAt: '2026/04/11',
      password: 'buyer123456'
    }
  ];
  const smsCodes = {};
  let currentAuthUsername = 'buyer1';

  function getUser(username) {
    return users.find(function (item) { return item.username === username; }) || null;
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
    confirm() { return true; },
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); }
    },
    location: { hash: '#/profile' },
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
    setTimeout(callback) {
      scheduledTimer = callback;
      return 1;
    },
    clearTimeout() {
      scheduledTimer = null;
    },
    fetch: async function (url, options) {
      const parsed = new URL(String(url), 'http://127.0.0.1:3000');
      const method = String(options && options.method || 'GET').toUpperCase();
      const payload = options && options.body ? JSON.parse(options.body) : {};

      if (parsed.pathname === '/api/auth/me' && method === 'GET') {
        const currentUser = getUser(currentAuthUsername);
        return currentUser ? createJsonResponse(cloneJson(currentUser)) : createJsonResponse({ message: '未登录' }, 401);
      }
      if (parsed.pathname === '/api/users' && method === 'GET' && !parsed.search) {
        const currentUser = getUser(currentAuthUsername);
        return currentUser ? createJsonResponse([cloneJson(currentUser)]) : createJsonResponse([], 401);
      }
      if (parsed.pathname === '/api/orders' && method === 'GET') return createJsonResponse([]);
      if (parsed.pathname === '/api/products' && method === 'GET') return createJsonResponse([]);
      if (parsed.pathname === '/api/categories' && method === 'GET') return createJsonResponse(categories);
      if (parsed.pathname === '/api/banners' && method === 'GET') return createJsonResponse([]);
      if (parsed.pathname === '/api/announcements' && method === 'GET') return createJsonResponse([]);
      if (parsed.pathname === '/api/coupon-templates' && method === 'GET') return createJsonResponse([]);
      if (parsed.pathname === '/api/refunds' && method === 'GET') return createJsonResponse([]);
      if (parsed.pathname === '/api/payment-transactions' && method === 'GET') return createJsonResponse([]);
      if (parsed.pathname === '/api/aftersales' && method === 'GET') return createJsonResponse([]);
      if (parsed.pathname === '/api/inventory-logs' && method === 'GET') return createJsonResponse([]);

      if (parsed.pathname === '/api/auth/send-sms-code' && method === 'POST') {
        const purpose = String(payload.purpose || 'bind_phone');
        const code = purpose === 'reset_password' ? '654321' : (purpose === 'login_or_register' ? '112233' : '123456');
        smsCodes[payload.phone + ':' + purpose] = code;
        return createJsonResponse({
          ok: true,
          message: '验证码已发送，请注意查收',
          autoRegisterOnVerify: purpose === 'login_or_register' && !users.some(function (item) { return item.phone === String(payload.phone || '').replace(/[^\d]/g, ''); }),
          sentAt: Date.now(),
          resendAfterSeconds: 60,
          expiresInSeconds: 300,
          debugCode: code,
          mock: true
        });
      }
      if (parsed.pathname === '/api/auth/login-sms' && method === 'POST') {
        var normalizedPhone = String(payload.phone || '').replace(/[^\d]/g, '');
        var expectedLoginCode = smsCodes[normalizedPhone + ':login_or_register'];
        if (!expectedLoginCode || String(payload.code || '') !== expectedLoginCode) {
          return createJsonResponse({ message: '验证码错误或已失效' }, 400);
        }
        var loginUser = users.find(function (item) { return item.phone === normalizedPhone; });
        var autoRegistered = false;
        if (!loginUser) {
          autoRegistered = true;
          loginUser = {
            id: users.length + 1,
            username: 'u_test_' + users.length,
            nickname: '',
            hasPassword: false,
            phone: normalizedPhone,
            phoneVerifiedAt: Date.now(),
            roles: { isFarmer: false, isAdmin: false, isSuperAdmin: false, farmerName: 'buyer' + users.length },
            addresses: [],
            shippingAddresses: [],
            coupons: [],
            selectedAddressId: '',
            selectedCouponId: '',
            cart: [],
            orders: [],
            member: { levelId: 'normal', points: 0, totalSpent: 0 },
            createdAt: '2026/04/13',
            password: ''
          };
          users.push(loginUser);
        }
        currentAuthUsername = loginUser.username;
        loginUser.hasPassword = !!String(loginUser.password || '');
        return createJsonResponse(Object.assign({ ok: true, autoRegistered: autoRegistered }, cloneJson(loginUser)));
      }
      if (parsed.pathname === '/api/auth/bind-phone' && method === 'POST') {
        const user = getUser(currentAuthUsername);
        const expected = smsCodes[payload.phone + ':bind_phone'];
        if (!user || !expected || String(payload.code || '') !== expected) {
          return createJsonResponse({ message: '验证码错误或已失效' }, 400);
        }
        user.phone = String(payload.phone || '').replace(/[^\d]/g, '');
        user.phoneVerifiedAt = Date.now();
        user.hasPassword = !!String(user.password || '');
        return createJsonResponse(cloneJson(user));
      }
      if (parsed.pathname === '/api/auth/change-password' && method === 'POST') {
        const user = getUser(currentAuthUsername);
        if (!user) {
          return createJsonResponse({ message: '当前用户不存在' }, 404);
        }
        const hadPassword = !!user.hasPassword;
        if (user.hasPassword && String(payload.currentPassword || '') !== user.password) {
          return createJsonResponse({ message: '当前密码错误' }, 400);
        }
        user.password = String(payload.newPassword || '');
        user.hasPassword = !!user.password;
        return createJsonResponse({ ok: true, message: hadPassword ? '密码修改成功' : '登录密码设置成功' });
      }
      if (parsed.pathname === '/api/auth/forgot-password/reset' && method === 'POST') {
        const expected = smsCodes[payload.phone + ':reset_password'];
        const user = users.find(function (item) { return item.phone === String(payload.phone || '').replace(/[^\d]/g, ''); });
        if (!expected || String(payload.code || '') !== expected || !user) {
          return createJsonResponse({ message: '验证码错误或已失效' }, 400);
        }
        user.password = String(payload.newPassword || '');
        user.hasPassword = true;
        return createJsonResponse({ ok: true, message: '密码重置成功，请重新登录' });
      }
      if (parsed.pathname === '/api/auth/login' && method === 'POST') {
        var normalizedLoginPhone = String(payload.phone || '').replace(/[^\d]/g, '');
        var passwordUser = normalizedLoginPhone
          ? users.find(function (item) { return item.phone === normalizedLoginPhone; })
          : getUser(payload.username);
        if (!passwordUser) {
          return createJsonResponse({ message: normalizedLoginPhone ? '手机号或密码错误' : '用户名或密码错误' }, 401);
        }
        if (normalizedLoginPhone && !passwordUser.hasPassword) {
          return createJsonResponse({ message: '该账号尚未设置登录密码，请先使用验证码登录' }, 401);
        }
        if (String(payload.password || '') !== passwordUser.password) {
          return createJsonResponse({ message: normalizedLoginPhone ? '手机号或密码错误' : '用户名或密码错误' }, 401);
        }
        currentAuthUsername = passwordUser.username;
        return createJsonResponse(cloneJson(passwordUser));
      }
      if (parsed.pathname === '/api/auth/register' && method === 'POST') {
        return createJsonResponse({ message: 'not needed' }, 500);
      }
      if (/^\/api\/users\/[^/]+\/state$/.test(parsed.pathname) && method === 'POST') {
        const matchedUsername = decodeURIComponent(parsed.pathname.split('/')[3] || '');
        const user = getUser(matchedUsername);
        if (!user) return createJsonResponse({ message: '用户不存在' }, 404);
        user.nickname = String(payload.nickname || '').trim();
        return createJsonResponse(cloneJson(user));
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

  async function execAsync(code) {
    return vm.runInContext('(async function(){' + code + '})()', sandbox);
  }

  function exec(code) {
    return vm.runInContext(code, sandbox);
  }

  await flush(8);

  await execAsync('await go("login");');
  await flush(3);
  let appHtml = document.getElementById('app').innerHTML;
  assert(appHtml.includes('验证码登录'), '登录页应默认展示验证码登录入口');
  assert(appHtml.includes('密码登录'), '登录页应提供密码登录切换入口');
  assert(appHtml.includes('手机号'), '登录页应使用手机号作为主身份输入');
  assert(!appHtml.includes('用户名'), '登录页不应再把用户名作为新主路径文案');
  assert(appHtml.includes('忘记密码'), '登录页应提供忘记密码入口');

  document.getElementById('login-phone').value = '13700137000';
  await execAsync('await sendLoginSmsCode();');
  await flush(2);
  appHtml = document.getElementById('app').innerHTML;
  assert(alerts[alerts.length - 1].includes('112233'), '登录验证码发送后应提示调试验证码');
  assert(/重新发送\(\d+s\)/.test(appHtml), '登录页发送验证码后应展示倒计时按钮');
  assert(appHtml.includes('disabled'), '登录页倒计时期间按钮应禁用');
  assert(document.getElementById('login-phone').value === '13700137000', '登录页发送验证码后不应清空手机号输入');
  exec("window.__authTimerRenderCount = 0; window.__originalAuthRender = render; render = function(){ window.__authTimerRenderCount += 1; return window.__originalAuthRender(); };");
  assert(typeof scheduledTimer === 'function', '登录验证码发送后应安排倒计时任务');
  scheduledTimer();
  await flush(2);
  assert(exec('window.__authTimerRenderCount') === 0, '验证码倒计时不应每秒触发整页 render');
  assert(/重新发送\(\d+s\)/.test(document.getElementById('auth-sms-button-login').textContent), '登录验证码按钮应在局部刷新时继续展示倒计时');
  assert(document.getElementById('auth-sms-button-login').disabled === true, '登录验证码按钮在局部刷新时应保持禁用');
  exec('render = window.__originalAuthRender;');

  await execAsync("setLoginMode('password');");
  await flush(2);
  appHtml = document.getElementById('app').innerHTML;
  assert(appHtml.includes('账号密码登录'), '切到密码模式后应展示账号密码登录按钮');
  assert(appHtml.includes('手机号或管理员账号'), '切到密码模式后应提示手机号或管理员账号均可登录');
  assert(!appHtml.includes('未注册手机号会在验证通过后自动创建账号'), '密码模式下不应继续展示验证码登录说明');

  document.getElementById('login-phone').value = '13700137000';
  document.getElementById('login-password').value = 'password-not-ready';
  await execAsync('await doPhonePasswordLogin();');
  await flush(2);
  assert(alerts[alerts.length - 1].includes('手机号或密码错误'), '新手机号未注册时密码登录应直接失败');

  document.getElementById('login-phone').value = 'admin';
  document.getElementById('login-password').value = 'admin123456';
  await execAsync('await doPhonePasswordLogin();');
  await flush(4);
  assert(currentAuthUsername === 'admin', '管理员账号应能通过账号密码模式登录');

  await execAsync('await go("register");');
  await flush(3);
  appHtml = document.getElementById('app').innerHTML;
  assert(appHtml.includes('手机号注册'), '注册页应明确为手机号注册');
  assert(appHtml.includes('注册并登录'), '注册页应保留注册并登录主按钮');
  assert(!appHtml.includes('用户名'), '注册页不应再展示用户名字段');
  assert(!appHtml.includes('密码登录'), '注册页不应混入密码注册路径');
  assert(!/重新发送\(\d+s\)/.test(appHtml), '切到注册页后不应恢复登录页的倒计时状态');

  document.getElementById('register-phone').value = '13700137000';
  await execAsync('await sendRegisterSmsCode();');
  await flush(2);
  appHtml = document.getElementById('app').innerHTML;
  assert(alerts[alerts.length - 1].includes('112233'), '注册验证码发送后应提示调试验证码');
  assert(/重新发送\(\d+s\)/.test(appHtml), '注册页发送验证码后应展示倒计时按钮');
  assert(document.getElementById('register-phone').value === '13700137000', '注册页发送验证码后不应清空手机号输入');

  await execAsync('await go("home");');
  await flush(2);
  await execAsync('await go("register");');
  await flush(3);
  appHtml = document.getElementById('app').innerHTML;
  assert(appHtml.includes('发送验证码'), '切页后重新进入注册页时按钮应恢复默认文案');
  assert(!/重新发送\(\d+s\)/.test(appHtml), '切页后不应恢复注册页倒计时状态');
  document.getElementById('register-phone').value = '13700137000';

  document.getElementById('register-code').value = '112233';
  await execAsync('await doRegisterBySms();');
  await flush(4);
  assert(currentAuthUsername !== 'buyer1', '手机号验证码注册后应切到新账号');
  const phoneFirstUser = getUser(currentAuthUsername);
  assert(phoneFirstUser, '手机号验证码注册后应创建账号');
  assert(phoneFirstUser.phone === '13700137000', '手机号验证码注册后应自动绑定手机号');
  assert(phoneFirstUser.phoneVerifiedAt > 0, '手机号验证码注册后应记录验证时间');
  assert(phoneFirstUser.hasPassword === false, '首次验证码注册后默认不应带密码');
  assert(phoneFirstUser.nickname === '', '新手机号账号默认昵称应保持为空');
  assert(alerts[alerts.length - 1].includes('注册成功'), '首次验证码注册后应提示注册成功');

  await execAsync('await go("security");');
  await flush(3);
  appHtml = document.getElementById('app').innerHTML;
  assert(appHtml.includes('设置登录密码'), '首次验证码注册后账号安全页应提示设置登录密码');
  assert(appHtml.includes('手机号已自动绑定'), '已自动绑定手机号的账号应展示自动绑定说明');
  assert(!appHtml.includes('当前密码'), '首次设密前不应要求填写当前密码');
  assert(appHtml.includes('手机号说明'), '账号安全页应补充手机号自动绑定说明');
  assert(!appHtml.includes('换绑手机号'), '账号安全页不应再展示换绑手机号入口');
  assert(!appHtml.includes('确认绑定手机号'), '账号安全页不应再展示手动绑定手机号入口');

  document.getElementById('security-new-password').value = 'new223344';
  document.getElementById('security-confirm-password').value = 'new223344';
  await execAsync('await changePasswordFromProfile();');
  await flush(3);
  assert(phoneFirstUser.password === 'new223344', '首次设密后应保存新密码');
  assert(phoneFirstUser.hasPassword === true, '首次设密后账号应切换为可密码登录');
  assert(alerts[alerts.length - 1].includes('设置成功'), '首次设密后应给出设置成功提示');

  await execAsync('await logout();');
  await flush(3);
  await execAsync('await go("login");');
  await flush(2);
  await execAsync("setLoginMode('password');");
  await flush(2);
  document.getElementById('login-phone').value = '13700137000';
  document.getElementById('login-password').value = 'new223344';
  await execAsync('await doPhonePasswordLogin();');
  await flush(4);
  assert(currentAuthUsername === phoneFirstUser.username, '手机号 + 密码应能重新登录首次验证码注册账号');

  await execAsync('await go("profile");');
  await flush(3);
  appHtml = document.getElementById('app').innerHTML;
  assert(appHtml.includes('账号安全'), '我的页应展示账号安全入口');
  assert(appHtml.includes('137****7000'), '昵称为空时个人卡片应展示脱敏手机号');
  assert(appHtml.includes('修改昵称'), '我的页应提供修改昵称入口');

  sandbox.window.prompt = function () { return '山野买家'; };
  await execAsync('await editNicknameFromProfile();');
  await flush(4);
  assert(phoneFirstUser.nickname === '山野买家', '修改昵称后应写回用户资料');
  appHtml = document.getElementById('app').innerHTML;
  assert(appHtml.includes('山野买家'), '修改昵称后个人卡片应优先展示昵称');

  currentAuthUsername = 'buyer1';
  users[0].phone = '13800138000';
  users[0].phoneVerifiedAt = Date.now();
  await execAsync('await go("forgotPassword");');
  await flush(3);
  appHtml = document.getElementById('app').innerHTML;
  assert(appHtml.includes('短信验证码'), '找回密码页应展示短信验证码输入框');
  assert(appHtml.includes('确认重置密码'), '找回密码页应展示重置密码按钮');

  document.getElementById('fp-phone').value = '13800138000';
  await execAsync('await sendForgotPasswordCode();');
  await flush(2);
  appHtml = document.getElementById('app').innerHTML;
  assert(alerts[alerts.length - 1].includes('654321'), '找回密码发送验证码后应提示调试验证码');
  assert(/重新发送\(\d+s\)/.test(appHtml), '找回密码页发送验证码后应展示倒计时按钮');
  assert(document.getElementById('fp-phone').value === '13800138000', '找回密码发送验证码后不应清空手机号输入');

  document.getElementById('fp-code').value = '654321';
  document.getElementById('fp-password').value = 'reset9988';
  document.getElementById('fp-password-confirm').value = 'reset9988';
  await execAsync('await resetPasswordBySms();');
  await flush(3);
  assert(String(sandbox.location.hash).indexOf('/login') >= 0, '找回密码成功后应返回登录页');
  assert(users[0].password === 'reset9988', '找回密码应更新密码');
  assert(users[0].hasPassword === true, '找回密码后旧账号应保持可密码登录');

  console.log('Auth UI smoke test passed.');
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
