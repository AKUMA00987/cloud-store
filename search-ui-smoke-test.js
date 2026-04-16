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

function tokenizeSearchKeyword(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

const categories = [
  { id: 'veg', name: '新鲜蔬菜', icon: '🥬', sortOrder: 0, showOnHome: true },
  { id: 'fruit', name: '时令水果', icon: '🍎', sortOrder: 1, showOnHome: true }
];

const products = [
  {
    id: 1,
    name: '高山青菜',
    price: 12,
    orig: 15,
    unit: '500g',
    cat: 'veg',
    stock: 12,
    off: false,
    tags: ['有机'],
    sales: 18,
    farmer: '老李',
    farmerAccount: 'farmer_li',
    farmerUserId: 1,
    village: '青山村',
    harvest: '2026-04-06',
    dispatchHours: 8,
    img: 'https://example.com/veg.jpg',
    trace: []
  },
  {
    id: 2,
    name: '红富士苹果',
    price: 18,
    orig: 22,
    unit: '1斤',
    cat: 'fruit',
    stock: 9,
    off: false,
    tags: ['热销'],
    sales: 10,
    farmer: '王姐',
    farmerAccount: 'farmer_wang',
    farmerUserId: 2,
    village: '果香村',
    harvest: '2026-04-05',
    dispatchHours: 12,
    img: 'https://example.com/apple.jpg',
    trace: []
  }
];

function searchProductsByKeyword(keyword) {
  const categoryNameById = categories.reduce(function (result, item) {
    result[String(item.id || '')] = String(item.name || '');
    return result;
  }, {});
  const tokens = tokenizeSearchKeyword(keyword);
  if (!tokens.length) return products.filter(function (item) { return !item.off; });
  return products
    .filter(function (item) { return !item.off; })
    .map(function (item) {
      const haystacks = [
        item.name,
        item.farmer,
        item.village,
        categoryNameById[String(item.cat || '')] || '',
        Array.isArray(item.tags) ? item.tags.join(' ') : ''
      ].join(' ').toLowerCase();
      const matchCount = tokens.reduce(function (count, token) {
        return count + (haystacks.indexOf(token) >= 0 ? 1 : 0);
      }, 0);
      return { item: item, matchCount: matchCount };
    })
    .filter(function (entry) {
      return entry.matchCount > 0;
    })
    .sort(function (a, b) {
      if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
      if (Number(b.item.sales || 0) !== Number(a.item.sales || 0)) return Number(b.item.sales || 0) - Number(a.item.sales || 0);
      return Number(b.item.id || 0) - Number(a.item.id || 0);
    })
    .map(function (entry) { return entry.item; });
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
    'admin-panel',
    'farmer-panel',
    'admin-db',
    'admin-pd',
    'admin-od',
    'admin-coupon',
    'admin-banner',
    'admin-auth',
    'farmer-content',
    'atab-db',
    'atab-pd',
    'atab-od',
    'atab-coupon',
    'atab-banner',
    'atab-auth'
  ].forEach(function (id) {
    document.getElementById(id);
  });
  document.getElementById('nav').style.display = 'flex';

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
      history: { back() { } },
      prompt() { return ''; }
    },
    document,
    lucide: { createIcons() { } },
    FileReader: undefined,
    setTimeout() {
      return 0;
    },
    clearTimeout() { },
    fetch: async function (url) {
      const parsed = new URL(String(url), 'http://127.0.0.1:3000');
      if (parsed.pathname === '/api/products' && parsed.searchParams.get('page')) {
        return createJsonResponse({
          items: products,
          meta: { page: 1, pageSize: Number(parsed.searchParams.get('pageSize') || products.length || 1), totalCount: products.length, totalPages: 1, hasPrev: false, hasNext: false }
        });
      }
      if (parsed.pathname === '/api/products') return createJsonResponse(products);
      if (parsed.pathname === '/api/auth/me') return createJsonResponse({ message: '未登录' }, 401);
      if (parsed.pathname === '/api/categories') return createJsonResponse(categories);
      if (parsed.pathname === '/api/banners') return createJsonResponse([]);
      if (parsed.pathname === '/api/announcements') return createJsonResponse([]);
      if (parsed.pathname === '/api/coupon-templates') return createJsonResponse([]);
      if (parsed.pathname === '/api/users') return createJsonResponse([], parsed.search ? 200 : 401);
      if (parsed.pathname === '/api/orders') return createJsonResponse([]);
      if (parsed.pathname === '/api/refunds') return createJsonResponse([]);
      if (/^\/api\/products\/\d+$/.test(parsed.pathname)) {
        const productId = Number(parsed.pathname.split('/').pop() || 0);
        return createJsonResponse(products.find(function (item) { return Number(item.id || 0) === productId; }) || { message: 'not found' }, products.some(function (item) { return Number(item.id || 0) === productId; }) ? 200 : 404);
      }
      if (parsed.pathname === '/api/products/search') {
        return createJsonResponse(searchProductsByKeyword(parsed.searchParams.get('q')));
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

  let appHtml = document.getElementById('app').innerHTML;
  assert(appHtml.includes('搜索商品'), '首页应渲染正式搜索入口');
  assert(appHtml.includes('搜索'), '首页搜索入口应保留可点击操作');

  await execAsync('await setCat("veg");');
  await flush(6);
  appHtml = document.getElementById('app').innerHTML;
  assert(appHtml.includes('新鲜蔬菜') || appHtml.includes('全部分类'), '分类页应正常渲染当前分类标题');
  assert(appHtml.includes('>搜索</button>'), '分类页应渲染正式搜索入口按钮');

  await execAsync('await openSearchPage();');
  await flush(6);
  appHtml = document.getElementById('app').innerHTML;
  assert(appHtml.includes('输入关键字后可按商品名或标签查找。'), '搜索页初始态应提示搜索说明');

  await execAsync('await searchProducts("不存在测试");');
  await flush(6);
  appHtml = document.getElementById('app').innerHTML;
  assert(appHtml.includes('没有找到匹配商品，换个关键词再试试吧。'), '搜索页应渲染无结果空态');

  await execAsync('await searchProducts("老李");');
  await flush(6);
  appHtml = document.getElementById('app').innerHTML;
  assert(appHtml.includes('搜索结果'), '搜索成功后应显示结果区');
  assert(appHtml.includes('高山青菜'), '搜索结果应展示匹配商品');
  assert(appHtml.includes('最近搜索'), '搜索后应展示最近搜索区');
  assert(JSON.parse(storage.get('cs_search_history') || '[]')[0] === '老李', '搜索历史应写入本地缓存');

  await execAsync('await pushView("product", 1);');
  await flush(6);
  assert(String(sandbox.location.hash) === '/product/1', '从搜索结果进入详情后应切到商品详情路由');
  appHtml = document.getElementById('app').innerHTML;
  assert(appHtml.includes('高山青菜'), '商品详情页应渲染已进入的商品');

  await execAsync('await back();');
  await flush(6);
  assert(String(sandbox.location.hash) === '/search', '从商品详情返回后应回到搜索页');
  appHtml = document.getElementById('app').innerHTML;
  assert(appHtml.includes('搜索结果'), '返回搜索页后应保留结果区');
  assert(appHtml.includes('value="老李"'), '返回搜索页后应保留搜索关键字');

  console.log('Search UI smoke test passed.');
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
