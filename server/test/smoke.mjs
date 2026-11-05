// MintLite server · 零依赖冒烟测试
// 起真实子进程（端口 8799 / 独立 DB_PATH），跑完整 REST 流程。
// 运行：node test/smoke.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, '..');
const TMP_DIR = path.join(SERVER_DIR, '.tmp');
const DB_FILE = path.join(TMP_DIR, 'test.db');
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const API = `${BASE}/api/v1`;

const pad2 = (n) => String(n).padStart(2, '0');
const now = new Date();
const TODAY = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
const MONTH = TODAY.slice(0, 7);
function daysAgo(n) {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 相对当前月往前推 n 个月的 YYYY-MM */
function monthsAgo(n) {
  const d = new Date(now.getFullYear(), now.getMonth() - n, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** 与服务端一致的月末夹取：加 n 个月，日号超出按月末取 */
function nextMonthly(dateStr, n = 1) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  return `${base.getUTCFullYear()}-${pad2(base.getUTCMonth() + 1)}-${pad2(Math.min(d, last))}`;
}

function addDaysStr(dateStr, n) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* --------------------------------- 起服务 --------------------------------- */

fs.rmSync(TMP_DIR, { recursive: true, force: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

let logs = '';
const child = spawn(process.execPath, [path.join(SERVER_DIR, 'src', 'server.js')], {
  cwd: SERVER_DIR,
  env: { ...process.env, PORT: String(PORT), DB_PATH: DB_FILE, NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => {
  logs += d.toString('utf8');
});
child.stderr.on('data', (d) => {
  logs += d.toString('utf8');
});
child.on('exit', (code) => {
  logs += `\n[server exit ${code}]\n`;
});

async function stopServer() {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 3000;
  while (child.exitCode === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function waitHealth() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务进程提前退出\n${logs}`);
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return res.json();
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`服务 20s 内未就绪\n${logs}`);
}

/* -------------------------------- HTTP 帮助 -------------------------------- */

async function req(method, p, opts = {}) {
  const url = p.startsWith('http') ? p : `${API}${p}`;
  const headers = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function balances(token, ledgerId) {
  const r = await req('GET', `/accounts?ledger_id=${encodeURIComponent(ledgerId)}`, { token });
  assert.equal(r.status, 200, `拉账户失败: ${r.text}`);
  const out = {};
  for (const a of r.json.items) out[a.name] = a.balance_cents;
  return out;
}

async function txCount(token, ledgerId) {
  const r = await req('GET', `/transactions?ledger_id=${encodeURIComponent(ledgerId)}`, { token });
  assert.equal(r.status, 200, `拉交易失败: ${r.text}`);
  return r.json.total;
}

/* -------------------------------- 用例运行器 ------------------------------- */

let pass = 0;
const failed = [];

async function step(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed.push(name);
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err && err.message).replace(/\n/g, '\n       ')}`);
  }
}

const A = {}; // alice 上下文
const B = {}; // bob 上下文

async function main() {
  console.log(`\nMintLite smoke · ${BASE} · db=${DB_FILE}\n`);

  /* ------------------------------- 0. 健康检查 ------------------------------ */

  let health = null;
  await step('GET /health 就绪且免鉴权', async () => {
    health = await waitHealth();
    assert.equal(health.ok, true);
    assert.ok(health.version, 'health 应带 version');
    assert.ok(health.time, 'health 应带 time');
  });
  if (!health) throw new Error('服务未就绪，后续用例无法继续');

  /* -------------------------------- 1. 鉴权 -------------------------------- */

  await step('GET /me 无 token → 401', async () => {
    const r = await req('GET', '/me');
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, 'unauthorized');
  });

  await step('POST /auth/register 建号 → 201 + token', async () => {
    const r = await req('POST', '/auth/register', { body: { username: 'alice', password: 'alice123' } });
    assert.equal(r.status, 201, r.text);
    assert.ok(r.json.token, '应返回 token');
    assert.equal(r.json.user.username, 'alice');
    A.token = r.json.token;
    A.userId = r.json.user.id;
  });

  await step('重复注册同名 → 409', async () => {
    const r = await req('POST', '/auth/register', { body: { username: 'alice', password: 'alice123' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'username_taken');
  });

  await step('错误密码登录 → 401', async () => {
    const r = await req('POST', '/auth/login', { body: { username: 'alice', password: 'wrong-pass' } });
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, 'invalid_credentials');
  });

  await step('正确登录 → 200 + token', async () => {
    const r = await req('POST', '/auth/login', { body: { username: 'alice', password: 'alice123' } });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.token);
    A.token2 = r.json.token;
  });

  await step('GET /me 带 token → 返回当前用户', async () => {
    const r = await req('GET', '/me', { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.username, 'alice');
    assert.equal(r.json.id, A.userId);
    assert.ok(!('password_hash' in r.json), '不得泄露 password_hash');
  });

  /* ------------------------------- 2. 账本 -------------------------------- */

  await step('GET /ledgers 注册后自带默认账本', async () => {
    const r = await req('GET', '/ledgers', { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.total, 1);
    assert.equal(r.json.items[0].name, '日常账本');
    // v1.2 契约 §2.2：is_default 统一为 0/1
    assert.equal(r.json.items[0].is_default, 1);
    assert.equal(r.json.items[0].currency, 'CNY');
    A.ledgerId = r.json.items[0].id;
  });

  await step('POST /ledgers 新建「旅行账本」→ 201', async () => {
    const r = await req('POST', '/ledgers', { token: A.token, body: { name: '旅行账本', currency: 'CNY' } });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.name, '旅行账本');
    A.tripLedgerId = r.json.id;
  });

  await step('PATCH /ledgers/:id 改名 → 200', async () => {
    const r = await req('PATCH', `/ledgers/${A.tripLedgerId}`, { token: A.token, body: { name: '旅行账本 2026' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.name, '旅行账本 2026');
  });

  /* ------------------------------- 3. 账户 -------------------------------- */

  await step('GET /accounts 默认 9 个账户（含 kind / totals）', async () => {
    const r = await req('GET', `/accounts?ledger_id=${A.ledgerId}`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.total, 9, `实际 ${JSON.stringify(r.json.items.map((i) => i.name))}`);
    const credit = r.json.items.find((a) => a.type === 'credit');
    assert.ok(credit, '应有 credit 类型账户');
    assert.equal(credit.name, '招商银行信用卡');
    assert.equal(credit.kind, 'liability', 'credit 应为负债账户');
    assert.ok(credit.credit_limit_cents > 0, '信用卡应有额度');
    assert.equal(typeof credit.used_cents, 'number');
    for (const a of r.json.items) {
      assert.equal(a.balance_cents, 0, '新用户账户余额应为 0');
      assert.ok(['asset', 'liability'].includes(a.kind), `kind 非法: ${a.kind}`);
    }
    const totals = r.json.totals;
    assert.ok(totals, '缺 totals');
    assert.equal(totals.net_cents, totals.asset_cents - totals.liability_cents, '净资产 = 资产 - 负债');
    A.cashId = r.json.items.find((a) => a.name === '现金').id;
    A.wechatId = r.json.items.find((a) => a.name === '微信').id;
    A.alipayId = r.json.items.find((a) => a.name === '支付宝').id;
    A.creditId = credit.id;
  });

  await step('POST /accounts 新建账户 → 201', async () => {
    const r = await req('POST', '/accounts', {
      token: A.token,
      body: { ledger_id: A.ledgerId, name: '测试卡', type: 'cash', balance_cents: 100000, sort: 9 },
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.name, '测试卡');
    A.testAccountId = r.json.id;
  });

  await step('PATCH /accounts/:id 改余额 → 200', async () => {
    const r = await req('PATCH', `/accounts/${A.testAccountId}`, { token: A.token, body: { balance_cents: 0 } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.balance_cents, 0);
  });

  await step('非信用卡账户的额度/账单日/还款日被清零（POST 与 PATCH 都拦）', async () => {
    const created = await req('POST', '/accounts', {
      token: A.token,
      body: {
        ledger_id: A.ledgerId,
        name: '不该有还款日的储蓄卡',
        type: 'bank',
        credit_limit_cents: 888800,
        bill_day: 5,
        repay_day: 20,
      },
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.credit_limit_cents, 0, '储蓄卡不该有额度');
    assert.equal(created.json.bill_day, null, '储蓄卡不该有账单日');
    assert.equal(created.json.repay_day, null, '储蓄卡不该有还款日');

    const patched = await req('PATCH', `/accounts/${created.json.id}`, {
      token: A.token,
      body: { credit_limit_cents: 500000, bill_day: 8, repay_day: 28 },
    });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.json.credit_limit_cents, 0);
    assert.equal(patched.json.bill_day, null);
    assert.equal(patched.json.repay_day, null);

    const credit = await req('POST', '/accounts', {
      token: A.token,
      body: { ledger_id: A.ledgerId, name: '正经信用卡', type: 'credit', credit_limit_cents: 500000, bill_day: 8, repay_day: 28 },
    });
    assert.equal(credit.status, 201, credit.text);
    assert.equal(credit.json.credit_limit_cents, 500000, '信用卡额度要保留');
    assert.equal(credit.json.bill_day, 8);
    assert.equal(credit.json.repay_day, 28);
  });

  /* ------------------------------- 4. 分类 -------------------------------- */

  await step('GET /categories?kind=expense → 9 个支出分类', async () => {
    const r = await req('GET', `/categories?ledger_id=${A.ledgerId}&kind=expense`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.total, 9, `实际 ${r.json.total}`);
    assert.ok(r.json.items.every((c) => c.kind === 'expense'));
    A.foodId = r.json.items.find((c) => c.name === '餐饮').id;
  });

  await step('GET /categories?kind=income → 6 个收入分类', async () => {
    const r = await req('GET', `/categories?ledger_id=${A.ledgerId}&kind=income`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.total, 6, `实际 ${r.json.total}`);
    A.salaryId = r.json.items.find((c) => c.name === '工资').id;
  });

  await step('POST /categories 新建分类 → 201', async () => {
    const r = await req('POST', '/categories', {
      token: A.token,
      body: { ledger_id: A.ledgerId, name: '宠物', kind: 'expense', icon: '🐱' },
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.kind, 'expense');
    A.petId = r.json.id;
  });

  /* ------------------------------- 5. 交易 -------------------------------- */

  await step('POST /transactions 支出 100 元 → 现金 -10000 分', async () => {
    const r = await req('POST', '/transactions', {
      token: A.token,
      body: {
        id: 'tx-expense-1',
        ledger_id: A.ledgerId,
        type: 'expense',
        amount_cents: 10000,
        category_id: A.foodId,
        account_id: A.cashId,
        note: '测试午饭',
        happened_at: TODAY,
      },
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.item.amount_cents, 10000);
    assert.equal(r.json.item.category_name, '餐饮');
    assert.equal(r.json.created, true);
    const bal = await balances(A.token, A.ledgerId);
    assert.equal(bal['现金'], -10000, `现金余额 ${bal['现金']}`);
  });

  await step('POST /transactions 收入 500 元 → 现金 40000 分', async () => {
    const r = await req('POST', '/transactions', {
      token: A.token,
      body: {
        id: 'tx-income-1',
        ledger_id: A.ledgerId,
        type: 'income',
        amount_cents: 50000,
        category_id: A.salaryId,
        account_id: A.cashId,
        note: '测试工资',
        happened_at: TODAY,
      },
    });
    assert.equal(r.status, 201, r.text);
    const bal = await balances(A.token, A.ledgerId);
    assert.equal(bal['现金'], 40000);
  });

  await step('POST /transactions 转账 200 元 现金→微信', async () => {
    const r = await req('POST', '/transactions', {
      token: A.token,
      body: {
        id: 'tx-transfer-1',
        ledger_id: A.ledgerId,
        type: 'transfer',
        amount_cents: 20000,
        account_id: A.cashId,
        to_account_id: A.wechatId,
        note: '测试转账',
        happened_at: TODAY,
      },
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.item.category_id, null, '转账不应带分类');
    const bal = await balances(A.token, A.ledgerId);
    assert.equal(bal['现金'], 20000);
    assert.equal(bal['微信'], 20000);
  });

  await step('转账缺 to_account_id → 400', async () => {
    const r = await req('POST', '/transactions', {
      token: A.token,
      body: { ledger_id: A.ledgerId, type: 'transfer', amount_cents: 100, account_id: A.cashId },
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'invalid_transfer');
  });

  await step('GET /transactions 按 type 过滤', async () => {
    const exp = await req('GET', `/transactions?ledger_id=${A.ledgerId}&type=expense`, { token: A.token });
    assert.equal(exp.status, 200, exp.text);
    assert.equal(exp.json.total, 1);
    const tr = await req('GET', `/transactions?ledger_id=${A.ledgerId}&type=transfer`, { token: A.token });
    assert.equal(tr.json.total, 1);
    const all = await req('GET', `/transactions?ledger_id=${A.ledgerId}`, { token: A.token });
    assert.equal(all.json.total, 3);
  });

  await step('GET /transactions 按 from/to 与 q 过滤', async () => {
    const inRange = await req(
      'GET',
      `/transactions?ledger_id=${A.ledgerId}&from=${daysAgo(3)}&to=${TODAY}`,
      { token: A.token },
    );
    assert.equal(inRange.json.total, 3, '近 3 天应有 3 条');
    const outRange = await req(
      'GET',
      `/transactions?ledger_id=${A.ledgerId}&from=${daysAgo(30)}&to=${daysAgo(10)}`,
      { token: A.token },
    );
    assert.equal(outRange.json.total, 0);
    const q = await req('GET', `/transactions?ledger_id=${A.ledgerId}&q=${encodeURIComponent('午饭')}`, {
      token: A.token,
    });
    assert.equal(q.json.total, 1);
  });

  await step('GET /transactions limit/offset 分页正确', async () => {
    const page = await req('GET', `/transactions?ledger_id=${A.ledgerId}&limit=2&offset=0`, { token: A.token });
    assert.equal(page.status, 200);
    assert.equal(page.json.items.length, 2);
    assert.equal(page.json.total, 3);
    const page2 = await req('GET', `/transactions?ledger_id=${A.ledgerId}&limit=2&offset=2`, { token: A.token });
    assert.equal(page2.json.items.length, 1);
  });

  /* ------------------------------- 6. 统计 -------------------------------- */

  await step('GET /stats/summary 收支/余额/笔数', async () => {
    const r = await req('GET', `/stats/summary?ledger_id=${A.ledgerId}&from=${daysAgo(3)}&to=${TODAY}`, {
      token: A.token,
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.income_cents, 50000);
    assert.equal(r.json.expense_cents, 10000);
    assert.equal(r.json.count, 3);
    assert.equal(r.json.balance_cents, 40000, `总余额 ${r.json.balance_cents}`);
  });

  await step('GET /stats/by-category 分类占比 ratio 4 位小数', async () => {
    const r = await req('GET', `/stats/by-category?ledger_id=${A.ledgerId}&kind=expense`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.ok(Array.isArray(r.json), '应直接返回数组');
    assert.equal(r.json.length, 1);
    assert.equal(r.json[0].name, '餐饮');
    assert.equal(r.json[0].amount_cents, 10000);
    assert.equal(r.json[0].ratio, 1);
    const inc = await req('GET', `/stats/by-category?ledger_id=${A.ledgerId}&kind=income`, { token: A.token });
    assert.equal(inc.json.length, 1);
    assert.equal(inc.json[0].ratio, 1);
  });

  await step('GET /stats/trend 按日分桶且缺桶补 0', async () => {
    const r = await req(
      'GET',
      `/stats/trend?ledger_id=${A.ledgerId}&from=${daysAgo(3)}&to=${TODAY}&granularity=day`,
      { token: A.token },
    );
    assert.equal(r.status, 200, r.text);
    assert.ok(Array.isArray(r.json));
    assert.equal(r.json.length, 4, `应补满 4 天，实际 ${r.json.length}`);
    const last = r.json[r.json.length - 1];
    assert.equal(last.bucket, TODAY);
    assert.equal(last.expense_cents, 10000);
    assert.equal(last.income_cents, 50000);
    assert.equal(r.json[0].income_cents, 0, '空白桶应补 0');
  });

  await step('GET /stats/trend 按月分桶', async () => {
    const r = await req('GET', `/stats/trend?ledger_id=${A.ledgerId}&granularity=month`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.length >= 1);
    assert.equal(r.json[r.json.length - 1].bucket, MONTH);
  });

  /* ------------------------------- 7. 预算 -------------------------------- */

  await step('PUT /budgets 总预算 upsert（同键覆盖）', async () => {
    const first = await req('PUT', '/budgets', {
      token: A.token,
      body: { ledger_id: A.ledgerId, month: MONTH, category_id: null, amount_cents: 500000 },
    });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.amount_cents, 500000);
    assert.equal(first.json.used_cents, 10000);
    const second = await req('PUT', '/budgets', {
      token: A.token,
      body: { ledger_id: A.ledgerId, month: MONTH, category_id: null, amount_cents: 800000 },
    });
    assert.equal(second.status, 200, second.text);
    assert.equal(second.json.amount_cents, 800000);
    assert.equal(second.json.items.filter((i) => i.category_id === null).length, 1, '同键不应产生第二条');
  });

  await step('PUT /budgets 分类预算 + GET /budgets 读取', async () => {
    const r = await req('PUT', '/budgets', {
      token: A.token,
      body: { ledger_id: A.ledgerId, month: MONTH, category_id: A.foodId, amount_cents: 120000 },
    });
    assert.equal(r.status, 200, r.text);
    const view = await req('GET', `/budgets?ledger_id=${A.ledgerId}&month=${MONTH}`, { token: A.token });
    assert.equal(view.status, 200, view.text);
    assert.equal(view.json.month, MONTH);
    // v1.3 修订：保存分类预算**不再改动总预算行**（总预算 = 明细合计 + 未分配）
    assert.equal(view.json.amount_cents, 800000, '总预算保持 800000 不变');
    assert.equal(view.json.categories_sum_cents, 120000, '分类合计');
    assert.equal(view.json.unallocated_cents, 680000, '未分配 = 800000 - 120000');
    assert.equal(view.json.mismatch, true, '有未分配额度（不是错误）');
    assert.equal(view.json.used_cents, 10000, '当月已用');
    assert.equal(view.json.items.length, 2);
    const food = view.json.items.find((i) => i.category_id === A.foodId);
    assert.equal(food.amount_cents, 120000);
    assert.equal(food.used_cents, 10000);
    assert.equal(typeof food.percent_left, 'number');
    assert.ok(['ok', 'warn', 'over'].includes(food.warn_level));
  });

  /* --------------------------- 8. 幂等与回滚 ------------------------------- */

  await step('POST /transactions 同 id 覆盖为 30000（余额只算新值）', async () => {
    const r = await req('POST', '/transactions', {
      token: A.token,
      body: {
        id: 'tx-expense-1',
        ledger_id: A.ledgerId,
        type: 'expense',
        amount_cents: 30000,
        category_id: A.foodId,
        account_id: A.cashId,
        note: '测试午饭（改）',
        happened_at: TODAY,
      },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.created, false);
    assert.equal(r.json.item.amount_cents, 30000);
    const bal = await balances(A.token, A.ledgerId);
    assert.equal(bal['现金'], 0, `现金应为 0，实际 ${bal['现金']}`);
    assert.equal(await txCount(A.token, A.ledgerId), 3, '不应产生新交易');
  });

  await step('PATCH /transactions/:id 改金额 → 余额只体现差额', async () => {
    const r = await req('PATCH', '/transactions/tx-expense-1', {
      token: A.token,
      body: { amount_cents: 50000 },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.item.amount_cents, 50000);
    const bal = await balances(A.token, A.ledgerId);
    assert.equal(bal['现金'], -20000, `现金应为 -20000，实际 ${bal['现金']}`);
  });

  await step('DELETE /transactions/:id 软删并回滚余额', async () => {
    const r = await req('DELETE', '/transactions/tx-expense-1', { token: A.token });
    assert.equal(r.status, 200, r.text);
    const bal = await balances(A.token, A.ledgerId);
    assert.equal(bal['现金'], 30000, `现金应回到 30000，实际 ${bal['现金']}`);
    assert.equal(await txCount(A.token, A.ledgerId), 2);
    const again = await req('DELETE', '/transactions/tx-expense-1', { token: A.token });
    assert.equal(again.status, 200, '重复删除应幂等');
    const bal2 = await balances(A.token, A.ledgerId);
    assert.equal(bal2['现金'], 30000, '重复删除不得再次改余额');
  });

  await step('external_id 冲突视为已导入', async () => {
    const first = await req('POST', '/transactions', {
      token: A.token,
      body: {
        id: 'tx-ext-1',
        ledger_id: A.ledgerId,
        type: 'expense',
        amount_cents: 1500,
        account_id: A.alipayId,
        note: '导入样例',
        happened_at: TODAY,
        external_id: 'sms-2026-0001',
      },
    });
    assert.equal(first.status, 201, first.text);
    const before = await txCount(A.token, A.ledgerId);
    const second = await req('POST', '/transactions', {
      token: A.token,
      body: {
        id: 'tx-ext-2',
        ledger_id: A.ledgerId,
        type: 'expense',
        amount_cents: 1500,
        account_id: A.alipayId,
        note: '导入样例',
        happened_at: TODAY,
        external_id: 'sms-2026-0001',
      },
    });
    assert.equal(second.status, 200, second.text);
    assert.equal(second.json.deduped, true);
    assert.equal(await txCount(A.token, A.ledgerId), before, '外部 id 冲突不应新增');
  });

  /* ----------------------------- 9. 导入导出 ------------------------------- */

  await step('GET /export?format=json 全量导出', async () => {
    const r = await req('GET', `/export?ledger_id=${A.ledgerId}&format=json`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.ok(Array.isArray(r.json.accounts) && r.json.accounts.length >= 6);
    assert.ok(Array.isArray(r.json.categories) && r.json.categories.length >= 15);
    assert.ok(Array.isArray(r.json.transactions) && r.json.transactions.length >= 3);
    assert.ok(Array.isArray(r.json.budgets) && r.json.budgets.length === 2);
    assert.ok(r.json.ledger && r.json.ledger.id === A.ledgerId);
    A.exportData = r.json;
  });

  await step('GET /export?format=csv 带 UTF-8 BOM 与中文表头', async () => {
    // 注意：fetch().text() 会按规范剥掉 BOM，必须看原始字节
    const res = await fetch(`${API}/export?ledger_id=${encodeURIComponent(A.ledgerId)}&format=csv`, {
      headers: { Authorization: `Bearer ${A.token}` },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/csv/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'CSV 必须以 UTF-8 BOM 开头');
    const text = buf.toString('utf8');
    assert.ok(text.includes('日期'), '表头应为中文');
    assert.ok(text.includes('支出'), '应含类型中文标签');
    assert.ok(text.includes('金额'), '应含金额列');
  });

  await step('POST /import 同账本重复导入 → 全部跳过（幂等）', async () => {
    const before = await txCount(A.token, A.ledgerId);
    const r = await req('POST', '/import', {
      token: A.token,
      body: { ledger_id: A.ledgerId, data: A.exportData },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.imported.transactions, 0, '不应新增交易');
    assert.ok(r.json.imported.skipped.transactions > 0);
    assert.equal(await txCount(A.token, A.ledgerId), before, '交易数不变');
  });

  await step('POST /import 到空账本 → 账户/分类/交易完整恢复', async () => {
    const r = await req('POST', '/import', {
      token: A.token,
      body: { ledger_id: A.tripLedgerId, data: A.exportData },
    });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.imported.accounts >= 6, `账户 ${r.json.imported.accounts}`);
    assert.ok(r.json.imported.categories >= 15, `分类 ${r.json.imported.categories}`);
    assert.ok(r.json.imported.transactions >= 3, `交易 ${r.json.imported.transactions}`);
    const imported = await txCount(A.token, A.tripLedgerId);
    assert.ok(imported >= 3, `目标账本交易 ${imported}`);
    // 再导一次仍幂等
    const again = await req('POST', '/import', {
      token: A.token,
      body: { ledger_id: A.tripLedgerId, data: A.exportData },
    });
    assert.equal(again.json.imported.transactions, 0);
    assert.equal(await txCount(A.token, A.tripLedgerId), imported);
  });

  /* ------------------------------- 10. 越权 ------------------------------- */

  await step('注册 bob 用于越权测试', async () => {
    const r = await req('POST', '/auth/register', { body: { username: 'bob', password: 'bob12345' } });
    assert.equal(r.status, 201, r.text);
    B.token = r.json.token;
    const ledgers = await req('GET', '/ledgers', { token: B.token });
    B.ledgerId = ledgers.json.items[0].id;
  });

  await step('bob 读 alice 交易列表 → 403', async () => {
    const r = await req('GET', `/transactions?ledger_id=${A.ledgerId}`, { token: B.token });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'forbidden');
  });

  await step('bob 读 alice 账户 → 403', async () => {
    const r = await req('GET', `/accounts?ledger_id=${A.ledgerId}`, { token: B.token });
    assert.equal(r.status, 403);
  });

  await step('bob 统计 alice 账本 → 403', async () => {
    const r = await req('GET', `/stats/summary?ledger_id=${A.ledgerId}`, { token: B.token });
    assert.equal(r.status, 403);
  });

  await step('bob 改 alice 交易 → 403', async () => {
    const r = await req('PATCH', '/transactions/tx-income-1', { token: B.token, body: { amount_cents: 1 } });
    assert.equal(r.status, 403);
  });

  await step('bob 删 alice 账本 → 403', async () => {
    const r = await req('DELETE', `/ledgers/${A.ledgerId}`, { token: B.token });
    assert.equal(r.status, 403);
  });

  await step('bob 向 alice 账本写交易 → 403', async () => {
    const r = await req('POST', '/transactions', {
      token: B.token,
      body: { ledger_id: A.ledgerId, type: 'expense', amount_cents: 100, account_id: A.cashId },
    });
    assert.equal(r.status, 403);
  });

  /* ------------------------------ 11. 其他边界 ----------------------------- */

  await step('无 token 写交易 → 401', async () => {
    const r = await req('POST', '/transactions', {
      body: { ledger_id: A.ledgerId, type: 'expense', amount_cents: 100 },
    });
    assert.equal(r.status, 401);
  });

  await step('伪造 token → 401', async () => {
    const r = await req('GET', '/me', { token: 'ZmFrZQ.ZmFrZQ' });
    assert.equal(r.status, 401);
  });

  await step('金额非法（小数/负数）→ 400', async () => {
    const r = await req('POST', '/transactions', {
      token: A.token,
      body: { ledger_id: A.ledgerId, type: 'expense', amount_cents: 12.5, account_id: A.cashId },
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'invalid_amount');
  });

  await step('未知路由 → 404 JSON', async () => {
    const r = await req('GET', '/nope/nothing', { token: A.token });
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, 'not_found');
  });

  await step('OPTIONS 预检 → 204 + CORS 头', async () => {
    const res = await fetch(`${API}/transactions`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('access-control-allow-headers') || '', /Authorization/i);
  });

  await step('demo 账号可直接登录并已有种子数据', async () => {
    const login = await req('POST', '/auth/login', { body: { username: 'demo', password: 'demo1234' } });
    assert.equal(login.status, 200, login.text);
    const ledgers = await req('GET', '/ledgers', { token: login.json.token });
    A.demoLedgerId = ledgers.json.items[0].id;
    const txs = await req('GET', `/transactions?ledger_id=${A.demoLedgerId}&limit=100`, { token: login.json.token });
    assert.ok(txs.json.total >= 20, `种子交易应 >= 20，实际 ${txs.json.total}`);
    const summary = await req('GET', `/stats/summary?ledger_id=${A.demoLedgerId}`, { token: login.json.token });
    assert.ok(summary.json.income_cents > 0, '种子应有收入');
    assert.ok(summary.json.expense_cents > 0, '种子应有支出');
    assert.ok(summary.json.balance_cents !== 0, '种子应让总余额非 0');
  });

  /* --------------------------- 12. v1.1 账户增量 ---------------------------- */

  await step('GET /accounts?legacy=1 返回裸数组（兼容旧前端）', async () => {
    const r = await req('GET', `/accounts?ledger_id=${A.ledgerId}&legacy=1`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.ok(Array.isArray(r.json), 'legacy 模式应直接返回数组');
    assert.ok(r.json.length >= 9, `legacy 数组至少 9 个账户，实际 ${r.json.length}`);
  });

  await step('POST /accounts/:id/adjust 校准余额并生成 adjust 流水', async () => {
    const before = await req('GET', `/stats/summary?ledger_id=${A.ledgerId}`, { token: A.token });
    const r = await req('POST', `/accounts/${A.testAccountId}/adjust`, {
      token: A.token,
      body: { ledger_id: A.ledgerId, target_cents: 5000, note: '校准一下' },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.account.balance_cents, 5000);
    assert.equal(r.json.transaction.type, 'adjust');
    assert.equal(r.json.transaction.amount_cents, 5000);
    assert.equal(r.json.delta_cents, 5000);
    const after = await req('GET', `/stats/summary?ledger_id=${A.ledgerId}`, { token: A.token });
    assert.equal(after.json.expense_cents, before.json.expense_cents, 'adjust 不计支出');
    assert.equal(after.json.count, before.json.count, 'adjust 不计笔数');
    assert.ok(after.json.adjust_cents >= 5000, 'summary 应体现 adjust 金额');
    A.adjustTxId = r.json.transaction.id;
  });

  await step('POST /accounts/:id/adjust 支持负余额（信用卡欠款）', async () => {
    const r = await req('POST', `/accounts/${A.creditId}/adjust`, {
      token: A.token,
      body: { ledger_id: A.ledgerId, target_cents: -30000 },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.account.balance_cents, -30000);
    assert.equal(r.json.account.used_cents, 30000, '信用卡 used_cents = 欠款');
    const list = await req('GET', `/accounts?ledger_id=${A.ledgerId}`, { token: A.token });
    assert.equal(list.json.totals.liability_cents >= 30000, true, '负债合计应含信用卡欠款');
  });

  await step('POST /accounts/:id/adjust 缺 target_cents → 400', async () => {
    const r = await req('POST', `/accounts/${A.testAccountId}/adjust`, {
      token: A.token,
      body: { ledger_id: A.ledgerId },
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'invalid_amount');
  });

  await step('bob 校准 alice 账户 → 403', async () => {
    const r = await req('POST', `/accounts/${A.testAccountId}/adjust`, {
      token: B.token,
      body: { ledger_id: A.ledgerId, target_cents: 1 },
    });
    assert.equal(r.status, 403);
  });

  /* ------------------------------ 13. 标签 ------------------------------- */

  await step('GET /tags 默认 3 个标签', async () => {
    const r = await req('GET', `/tags?ledger_id=${A.ledgerId}`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.ok(Array.isArray(r.json), '应返回裸数组');
    const names = r.json.map((t) => t.name);
    for (const n of ['家庭', '出差', '待报销']) assert.ok(names.includes(n), `缺默认标签 ${n}`);
    assert.equal(typeof r.json[0].usage_count, 'number');
    A.tagFamilyId = r.json.find((t) => t.name === '家庭').id;
    A.tagTripId = r.json.find((t) => t.name === '出差').id;
  });

  await step('POST /tags 新建「旅行」→ 201', async () => {
    const r = await req('POST', '/tags', {
      token: A.token,
      body: { ledger_id: A.ledgerId, name: '旅行', color: '#00B8D9' },
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.name, '旅行');
    assert.equal(r.json.color, '#00B8D9');
    A.tagTravelId = r.json.id;
  });

  await step('POST /tags 重名 → 409 tag_exists', async () => {
    const r = await req('POST', '/tags', { token: A.token, body: { ledger_id: A.ledgerId, name: '旅行' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'tag_exists');
  });

  await step('PATCH /tags/:id 改名改色 → 200', async () => {
    const r = await req('PATCH', `/tags/${A.tagTravelId}`, {
      token: A.token,
      body: { name: '旅行出差', color: '#36B37E' },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.name, '旅行出差');
    assert.equal(r.json.color, '#36B37E');
  });

  await step('POST /transactions 带 tags → 回读 tags / tag_names', async () => {
    const r = await req('POST', '/transactions', {
      token: A.token,
      body: {
        id: 'tx-tag-1',
        ledger_id: A.ledgerId,
        type: 'expense',
        amount_cents: 8800,
        category_id: A.foodId,
        account_id: A.alipayId,
        note: '带标签的午饭',
        happened_at: TODAY,
        tags: [A.tagTravelId, A.tagFamilyId, '不存在的标签'],
      },
    });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual(r.json.item.tags.sort(), [A.tagFamilyId, A.tagTravelId].sort(), '只保留本账本有效标签');
    assert.deepEqual(r.json.item.tag_names.sort(), ['家庭', '旅行出差'].sort());
    assert.equal(r.json.item.tags.length, 2, '不存在的标签应被忽略');
  });

  await step('PATCH /transactions/:id 的 tags 为整体替换', async () => {
    const r = await req('PATCH', '/transactions/tx-tag-1', {
      token: A.token,
      body: { tags: [A.tagTravelId] },
    });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.item.tags, [A.tagTravelId]);
    const cleared = await req('PATCH', '/transactions/tx-tag-1', { token: A.token, body: { tags: [] } });
    assert.deepEqual(cleared.json.item.tags, [], '空数组应清空标签');
  });

  await step('GET /transactions?tag_id= 过滤', async () => {
    const tagged = await req('POST', '/transactions', {
      token: A.token,
      body: {
        id: 'tx-tag-2',
        ledger_id: A.ledgerId,
        type: 'expense',
        amount_cents: 12000,
        account_id: A.cashId,
        note: '家庭采购',
        happened_at: TODAY,
        tags: [A.tagFamilyId],
      },
    });
    assert.equal(tagged.status, 201, tagged.text);
    const r = await req('GET', `/transactions?ledger_id=${A.ledgerId}&tag_id=${A.tagFamilyId}`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.total, 1, '只应命中 tx-tag-2');
    assert.equal(r.json.items[0].id, 'tx-tag-2');
    const tags = await req('GET', `/tags?ledger_id=${A.ledgerId}`, { token: A.token });
    const family = tags.json.find((t) => t.id === A.tagFamilyId);
    assert.equal(family.usage_count, 1, 'usage_count 应统计关联交易数');
  });

  await step('DELETE /tags/:id 软删并解除关联', async () => {
    const del = await req('DELETE', `/tags/${A.tagTravelId}`, { token: A.token });
    assert.equal(del.status, 200, del.text);
    const tags = await req('GET', `/tags?ledger_id=${A.ledgerId}`, { token: A.token });
    assert.ok(!tags.json.some((t) => t.id === A.tagTravelId), '已删标签不应再返回');
    const tx = await req('GET', `/transactions?ledger_id=${A.ledgerId}&q=${encodeURIComponent('带标签的午饭')}`, {
      token: A.token,
    });
    assert.deepEqual(tx.json.items[0].tags, [], '关联应被清除');
  });

  await step('bob 删 alice 标签 → 403', async () => {
    const r = await req('DELETE', `/tags/${A.tagFamilyId}`, { token: B.token });
    assert.equal(r.status, 403);
  });

  /* --------------------------- 14. 预算结转 ------------------------------ */

  await step('新建「结转账本」+ 账户', async () => {
    const led = await req('POST', '/ledgers', { token: A.token, body: { name: '结转账本' } });
    assert.equal(led.status, 201, led.text);
    A.carryLedgerId = led.json.id;
    const acc = await req('POST', '/accounts', {
      token: A.token,
      body: { ledger_id: A.carryLedgerId, name: '现金', type: 'cash' },
    });
    assert.equal(acc.status, 201, acc.text);
    A.carryAccountId = acc.json.id;
  });

  await step('PUT /budgets 写入 3 个月 rollover 预算', async () => {
    for (const m of [monthsAgo(2), monthsAgo(1), MONTH]) {
      const r = await req('PUT', '/budgets', {
        token: A.token,
        body: { ledger_id: A.carryLedgerId, month: m, category_id: null, amount_cents: 100000, rollover: true },
      });
      assert.equal(r.status, 200, r.text);
      const item = r.json.items.find((i) => i.category_id === null);
      assert.equal(item.rollover, true, '应保存 rollover 标记');
    }
  });

  await step('造 3 个月流水（60000 / 150000）', async () => {
    const mk = async (id, amount, date) => {
      const r = await req('POST', '/transactions', {
        token: A.token,
        body: {
          id,
          ledger_id: A.carryLedgerId,
          type: 'expense',
          amount_cents: amount,
          account_id: A.carryAccountId,
          note: `结转样本 ${id}`,
          happened_at: date,
        },
      });
      assert.equal(r.status, 201, r.text);
    };
    await mk('carry-tx-1', 60000, `${monthsAgo(2)}-05`);
    await mk('carry-tx-2', 150000, `${monthsAgo(1)}-10`);
  });

  await step('GET /budgets 结转链 M-1：carry = 100000 - 60000', async () => {
    const r = await req('GET', `/budgets?ledger_id=${A.carryLedgerId}&month=${monthsAgo(1)}`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    const item = r.json.items.find((i) => i.category_id === null);
    assert.equal(item.carry_in_cents, 40000, `carry_in 应为 40000，实际 ${item.carry_in_cents}`);
    assert.equal(item.available_cents, 140000);
    assert.equal(item.used_cents, 150000);
    assert.equal(item.remaining_cents, -10000, '允许负数');
  });

  await step('GET /budgets 结转链 M：carry = 100000 + 40000 - 150000 = -10000', async () => {
    const r = await req('GET', `/budgets?ledger_id=${A.carryLedgerId}&month=${MONTH}`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.carry_in_cents, -10000, `顶层 carry 应为 -10000，实际 ${r.json.carry_in_cents}`);
    assert.equal(r.json.available_cents, 90000);
    assert.equal(r.json.used_cents, 0);
    const item = r.json.items.find((i) => i.category_id === null);
    assert.equal(item.carry_in_cents, -10000);
    assert.equal(item.available_cents, 90000);
  });

  await step('rollover=false 时不再结转', async () => {
    const put = await req('PUT', '/budgets', {
      token: A.token,
      body: { ledger_id: A.carryLedgerId, month: MONTH, category_id: null, amount_cents: 100000, rollover: false },
    });
    assert.equal(put.status, 200, put.text);
    const r = await req('GET', `/budgets?ledger_id=${A.carryLedgerId}&month=${MONTH}`, { token: A.token });
    assert.equal(r.json.carry_in_cents, 0);
    assert.equal(r.json.available_cents, 100000);
    assert.equal(r.json.items.find((i) => i.category_id === null).rollover, false);
  });

  /* --------------------------- 15. 周期记账 ------------------------------ */

  await step('新建「周期账本」+ 账户', async () => {
    const led = await req('POST', '/ledgers', { token: A.token, body: { name: '周期账本' } });
    assert.equal(led.status, 201, led.text);
    A.recLedgerId = led.json.id;
    const acc = await req('POST', '/accounts', {
      token: A.token,
      body: { ledger_id: A.recLedgerId, name: '零钱', type: 'cash' },
    });
    assert.equal(acc.status, 201, acc.text);
    A.recAccountId = acc.json.id;
    const empty = await req('GET', `/recurring?ledger_id=${A.recLedgerId}`, { token: A.token });
    assert.equal(empty.status, 200, empty.text);
    assert.deepEqual(empty.json.items, []);
  });

  await step('POST /recurring 新建月度规则 → 201', async () => {
    const r = await req('POST', '/recurring', {
      token: A.token,
      body: {
        ledger_id: A.recLedgerId,
        type: 'expense',
        amount_cents: 1999,
        account_id: A.recAccountId,
        note: '会员订阅',
        freq: 'monthly',
        start_date: TODAY,
      },
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.next_run, TODAY);
    assert.equal(r.json.interval, 1);
    assert.equal(r.json.enabled, true);
    A.ruleMonthly = r.json.id;
  });

  await step('GET /recurring 返回 due 标记', async () => {
    const r = await req('GET', `/recurring?ledger_id=${A.recLedgerId}`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.items.length, 1);
    assert.equal(r.json.items[0].due, true, 'next_run <= 今天应 due');
  });

  await step('POST /recurring/run 生成流水并推进 next_run', async () => {
    const r = await req('POST', '/recurring/run', { token: A.token, body: { ledger_id: A.recLedgerId, date: TODAY } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.created.length, 1, `实际 ${JSON.stringify(r.json)}`);
    const tx = r.json.created[0];
    assert.equal(tx.type, 'expense');
    assert.equal(tx.amount_cents, 1999);
    assert.equal(tx.source, 'auto');
    assert.equal(tx.external_id, `rec:${A.ruleMonthly}:${TODAY}`);
    const rule = r.json.rules.find((x) => x.id === A.ruleMonthly);
    assert.equal(rule.last_run, TODAY);
    assert.equal(rule.next_run, nextMonthly(TODAY), '应推进到下个月同日');
    const list = await req('GET', `/transactions?ledger_id=${A.recLedgerId}`, { token: A.token });
    assert.equal(list.json.total, 1);
  });

  await step('POST /recurring/run 幂等：external_id 已存在则跳过', async () => {
    const rule = await req('POST', '/recurring', {
      token: A.token,
      body: {
        ledger_id: A.recLedgerId,
        type: 'expense',
        amount_cents: 500,
        account_id: A.recAccountId,
        note: '每日咖啡',
        freq: 'daily',
        start_date: TODAY,
      },
    });
    assert.equal(rule.status, 201, rule.text);
    A.ruleDaily = rule.json.id;
    const seed = await req('POST', '/transactions', {
      token: A.token,
      body: {
        id: 'dup-rec-tx',
        ledger_id: A.recLedgerId,
        type: 'expense',
        amount_cents: 500,
        account_id: A.recAccountId,
        note: '已存在',
        happened_at: TODAY,
        external_id: `rec:${A.ruleDaily}:${TODAY}`,
      },
    });
    assert.equal(seed.status, 201, seed.text);
    const r = await req('POST', '/recurring/run', { token: A.token, body: { ledger_id: A.recLedgerId, date: TODAY } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.created.length, 0, '不应重复生成');
    const hit = r.json.skipped.find((s) => s.rule_id === A.ruleDaily);
    assert.ok(hit, '应记录 skipped');
    assert.equal(hit.reason, 'already_exists');
  });

  await step('月末夹取：1/31 月度规则 → 2/28', async () => {
    const rule = await req('POST', '/recurring', {
      token: A.token,
      body: {
        ledger_id: A.recLedgerId,
        type: 'expense',
        amount_cents: 3000,
        account_id: A.recAccountId,
        note: '月末规则',
        freq: 'monthly',
        start_date: '2026-01-31',
      },
    });
    assert.equal(rule.status, 201, rule.text);
    A.ruleEom = rule.json.id;
    const r = await req('POST', '/recurring/run', {
      token: A.token,
      body: { ledger_id: A.recLedgerId, date: '2026-01-31' },
    });
    assert.equal(r.status, 200, r.text);
    const pushed = r.json.rules.find((x) => x.id === A.ruleEom);
    assert.equal(pushed.next_run, '2026-02-28', `实际 ${pushed.next_run}`);
  });

  await step('单规则单次最多补 60 条', async () => {
    const rule = await req('POST', '/recurring', {
      token: A.token,
      body: {
        ledger_id: A.recLedgerId,
        type: 'expense',
        amount_cents: 100,
        account_id: A.recAccountId,
        note: '每日小额',
        freq: 'daily',
        start_date: daysAgo(70),
      },
    });
    assert.equal(rule.status, 201, rule.text);
    A.ruleBulk = rule.json.id;
    const r = await req('POST', '/recurring/run', { token: A.token, body: { ledger_id: A.recLedgerId, date: TODAY } });
    assert.equal(r.status, 200, r.text);
    const mine = r.json.created.filter((c) => String(c.external_id || '').startsWith(`rec:${A.ruleBulk}:`));
    assert.equal(mine.length, 60, `应恰好补 60 条，实际 ${mine.length}`);
    assert.ok(
      r.json.skipped.some((s) => s.rule_id === A.ruleBulk && s.reason === 'max_per_run_reached'),
      '应记录上限跳过原因',
    );
  });

  await step('end_date 之后不再生成，next_run 停在 end_date', async () => {
    const rule = await req('POST', '/recurring', {
      token: A.token,
      body: {
        ledger_id: A.recLedgerId,
        type: 'expense',
        amount_cents: 700,
        account_id: A.recAccountId,
        note: '一次性周期',
        freq: 'monthly',
        start_date: TODAY,
        end_date: TODAY,
      },
    });
    assert.equal(rule.status, 201, rule.text);
    A.ruleEnd = rule.json.id;
    const run = await req('POST', '/recurring/run', { token: A.token, body: { ledger_id: A.recLedgerId, date: TODAY } });
    assert.equal(run.status, 200, run.text);
    const after = run.json.rules.find((x) => x.id === A.ruleEnd);
    assert.equal(after.next_run, TODAY, 'next_run 应停在 end_date');
    assert.equal(after.enabled, true, 'enabled 不变');
    const again = await req('POST', '/recurring/run', {
      token: A.token,
      body: { ledger_id: A.recLedgerId, date: nextMonthly(TODAY, 2) },
    });
    assert.equal(again.json.created.filter((c) => String(c.external_id || '').startsWith(`rec:${A.ruleEnd}:`)).length, 0);
  });

  await step('PATCH /recurring/:id 改 freq → next_run 重算', async () => {
    // 前面的 run 已经把 last_run 推到较晚日期，期望值必须基于当前 last_run
    const before = await req('GET', `/recurring?ledger_id=${A.recLedgerId}`, { token: A.token });
    const rule = before.json.items.find((i) => i.id === A.ruleMonthly);
    assert.ok(rule && rule.last_run, '规则应已有 last_run');
    const r = await req('PATCH', `/recurring/${A.ruleMonthly}`, {
      token: A.token,
      body: { freq: 'daily' },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.freq, 'daily');
    assert.equal(r.json.next_run, addDaysStr(rule.last_run, 1), '从 last_run 之后按新频率算');
  });

  await step('PATCH /recurring/:id 非法 freq → 400', async () => {
    const r = await req('PATCH', `/recurring/${A.ruleMonthly}`, { token: A.token, body: { freq: 'hourly' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'invalid_freq');
  });

  await step('DELETE /recurring/:id 软删', async () => {
    const del = await req('DELETE', `/recurring/${A.ruleEom}`, { token: A.token });
    assert.equal(del.status, 200, del.text);
    const list = await req('GET', `/recurring?ledger_id=${A.recLedgerId}`, { token: A.token });
    assert.ok(!list.json.items.some((i) => i.id === A.ruleEom), '已删规则不应返回');
    const again = await req('DELETE', `/recurring/${A.ruleEom}`, { token: A.token });
    assert.equal(again.status, 404);
  });

  await step('bob 读 alice 周期规则 → 403', async () => {
    const r = await req('GET', `/recurring?ledger_id=${A.recLedgerId}`, { token: B.token });
    assert.equal(r.status, 403);
  });

  /* ----------------------------- 16. 报销 -------------------------------- */

  await step('POST /transactions 支出标记 pending 报销', async () => {
    const r = await req('POST', '/transactions', {
      token: A.token,
      body: {
        id: 'tx-reimb-1',
        ledger_id: A.ledgerId,
        type: 'expense',
        amount_cents: 20000,
        category_id: A.foodId,
        account_id: A.alipayId,
        note: '出差打车',
        happened_at: TODAY,
        reimburse_state: 'pending',
      },
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.item.reimburse_state, 'pending');
  });

  await step('POST /transactions/:id/reimburse 生成收入并置 done', async () => {
    const r = await req('POST', '/transactions/tx-reimb-1/reimburse', {
      token: A.token,
      body: { ledger_id: A.ledgerId, account_id: A.alipayId, date: TODAY },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.transaction.reimburse_state, 'done');
    assert.equal(r.json.transaction.reimburse_at, TODAY);
    assert.equal(r.json.income.type, 'income');
    assert.equal(r.json.income.amount_cents, 20000);
    assert.equal(r.json.income.account_id, A.alipayId);
    assert.equal(r.json.income.external_id, 'reimb:tx-reimb-1');
    assert.equal(r.json.income.note, '报销：出差打车');
    A.reimbIncomeId = r.json.income.id;
  });

  await step('二次报销 → 409 already_reimbursed', async () => {
    const r = await req('POST', '/transactions/tx-reimb-1/reimburse', {
      token: A.token,
      body: { ledger_id: A.ledgerId, account_id: A.alipayId },
    });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'already_reimbursed');
  });

  await step('GET /stats/reimburse 汇总 pending / done', async () => {
    const r = await req('GET', `/stats/reimburse?ledger_id=${A.ledgerId}`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.done_count >= 1, 'done_count 应 >= 1');
    assert.ok(r.json.done_cents >= 20000, 'done_cents 应 >= 20000');
    assert.ok(Array.isArray(r.json.items));
    assert.ok(r.json.items.every((i) => i.reimburse_state), 'items 应带状态');
  });

  await step('PATCH reimburse_state 可回退 pending', async () => {
    const r = await req('PATCH', '/transactions/tx-reimb-1', { token: A.token, body: { reimburse_state: 'pending' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.item.reimburse_state, 'pending');
    assert.equal(r.json.item.reimburse_at, null, '非 done 应清空 reimburse_at');
    const stats = await req('GET', `/stats/reimburse?ledger_id=${A.ledgerId}`, { token: A.token });
    assert.ok(stats.json.pending_count >= 1);
    await req('PATCH', '/transactions/tx-reimb-1', { token: A.token, body: { reimburse_state: 'done' } });
  });

  await step('PATCH 非法 reimburse_state → 400', async () => {
    const r = await req('PATCH', '/transactions/tx-reimb-1', { token: A.token, body: { reimburse_state: 'maybe' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'invalid_reimburse_state');
  });

  await step('收入交易报销 → 400 invalid_type', async () => {
    const r = await req('POST', '/transactions/tx-income-1/reimburse', {
      token: A.token,
      body: { ledger_id: A.ledgerId, account_id: A.alipayId },
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'invalid_type');
  });

  await step('bob 报销 alice 交易 → 403', async () => {
    const r = await req('POST', '/transactions/tx-reimb-1/reimburse', {
      token: B.token,
      body: { ledger_id: A.ledgerId, account_id: A.alipayId },
    });
    assert.equal(r.status, 403);
  });

  /* ---------------------------- 17. 新统计接口 ---------------------------- */

  await step('GET /stats/overview 形状正确', async () => {
    const r = await req('GET', `/stats/overview?ledger_id=${A.ledgerId}`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.net_cents, r.json.income_cents - r.json.expense_cents);
    assert.equal(r.json.by_weekday.length, 7, '应固定 7 个 weekday');
    assert.deepEqual(
      r.json.by_weekday.map((w) => w.weekday),
      [1, 2, 3, 4, 5, 6, 7],
    );
    for (const k of ['expense', 'income', 'transfer', 'adjust']) {
      assert.equal(typeof r.json.by_type[k], 'number', `by_type.${k} 应为笔数`);
    }
    assert.ok(r.json.by_type.adjust >= 2, '应统计 adjust 笔数');
    assert.ok(r.json.days >= 1);
    assert.ok(r.json.avg_expense_cents >= 0);
    assert.ok(r.json.max_expense_cents > 0, '应有单笔最大支出');
  });

  await step('GET /stats/by-account 只统计收支、不含转账', async () => {
    const exp = await req('GET', `/stats/by-account?ledger_id=${A.ledgerId}&kind=expense`, { token: A.token });
    assert.equal(exp.status, 200, exp.text);
    assert.ok(Array.isArray(exp.json), '应返回裸数组');
    assert.ok(exp.json.every((i) => i.account_id && i.type && typeof i.ratio === 'number'));
    const alipay = exp.json.find((i) => i.account_id === A.alipayId);
    assert.ok(alipay && alipay.amount_cents > 0, '支付宝应有支出');
    const inc = await req('GET', `/stats/by-account?ledger_id=${A.ledgerId}&kind=income`, { token: A.token });
    assert.ok(inc.json.every((i) => i.amount_cents > 0));
    const sum = exp.json.reduce((s, i) => s + i.amount_cents, 0);
    const summary = await req('GET', `/stats/summary?ledger_id=${A.ledgerId}`, { token: A.token });
    assert.equal(sum, summary.json.expense_cents, '分类账户合计应等于总支出');
  });

  await step('GET /stats/by-tag 只算支出并含未打标签', async () => {
    const r = await req('GET', `/stats/by-tag?ledger_id=${A.ledgerId}`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.ok(Array.isArray(r.json));
    const untagged = r.json.find((i) => i.tag_id === null);
    assert.ok(untagged, '应有未打标签桶');
    assert.equal(untagged.name, '未打标签');
    const total = r.json.reduce((s, i) => s + i.amount_cents, 0);
    const summary = await req('GET', `/stats/summary?ledger_id=${A.ledgerId}`, { token: A.token });
    assert.equal(total, summary.json.expense_cents, '标签合计应等于总支出');
  });

  await step('GET /stats/compare 对比等长前一区间', async () => {
    const r = await req('GET', `/stats/compare?ledger_id=${A.ledgerId}`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.current && r.json.previous && r.json.delta);
    assert.equal(r.json.current.from, `${MONTH}-01`);
    assert.ok(r.json.previous.to < r.json.current.from, 'previous 应紧邻前一区间');
    assert.equal(typeof r.json.delta.net_cents, 'number');
    assert.ok(r.json.delta.income_pct === null || typeof r.json.delta.income_pct === 'number');
  });

  await step('GET /stats/calendar?month= 只返回有数据的日期', async () => {
    const r = await req('GET', `/stats/calendar?ledger_id=${A.ledgerId}&month=${MONTH}`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.ok(Array.isArray(r.json));
    assert.ok(r.json.length >= 1);
    const today = r.json.find((d) => d.date === TODAY);
    assert.ok(today, '应包含今天');
    assert.ok(today.expense_cents > 0);
    assert.ok(today.count >= 1);
    assert.ok(r.json.every((d) => d.date.startsWith(MONTH)));
  });

  await step('GET /stats/calendar 非法 month → 400', async () => {
    const r = await req('GET', `/stats/calendar?ledger_id=${A.ledgerId}&month=2026-13`, { token: A.token });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'invalid_month');
  });

  await step('GET /stats/trend?granularity=week 按周一分桶', async () => {
    const r = await req('GET', `/stats/trend?ledger_id=${A.ledgerId}&granularity=week&from=${daysAgo(20)}&to=${TODAY}`, {
      token: A.token,
    });
    assert.equal(r.status, 200, r.text);
    assert.ok(Array.isArray(r.json) && r.json.length >= 2);
    for (const b of r.json) assert.equal(new Date(`${b.bucket}T00:00:00Z`).getUTCDay(), 1, `桶应为周一: ${b.bucket}`);
    assert.equal(r.json.reduce((s, b) => s + b.expense_cents, 0) > 0, true);
  });

  await step('统一筛选 min_cents / max_cents', async () => {
    const r = await req('GET', `/transactions?ledger_id=${A.ledgerId}&min_cents=10000&max_cents=25000`, {
      token: A.token,
    });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.total >= 1);
    for (const t of r.json.items) assert.ok(t.amount_cents >= 10000 && t.amount_cents <= 25000);
    const none = await req('GET', `/transactions?ledger_id=${A.ledgerId}&min_cents=999999999`, { token: A.token });
    assert.equal(none.json.total, 0);
  });

  await step('GET /transactions?type=adjust 可筛余额校准流水', async () => {
    const r = await req('GET', `/transactions?ledger_id=${A.ledgerId}&type=adjust`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.total >= 2, `应至少 2 条 adjust，实际 ${r.json.total}`);
    assert.ok(r.json.items.every((t) => t.type === 'adjust'));
  });

  await step('GET /stats/summary 带 net / transfer / adjust 字段', async () => {
    const r = await req('GET', `/stats/summary?ledger_id=${A.ledgerId}`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.net_cents, r.json.income_cents - r.json.expense_cents);
    assert.equal(typeof r.json.transfer_cents, 'number');
    assert.equal(typeof r.json.adjust_cents, 'number');
    assert.ok(r.json.transfer_cents >= 20000, '应统计转账金额');
  });

  await step('GET /stats/by-category 带 count', async () => {
    const r = await req('GET', `/stats/by-category?ledger_id=${A.ledgerId}&kind=expense`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.every((i) => typeof i.count === 'number' && i.count >= 1));
    assert.ok(r.json.some((i) => i.name === '餐饮'));
  });

  /* ----------------------- 18. 导出导入 v1.1 兼容 ------------------------- */

  await step('GET /export?format=json 含 tags / transaction_tags / recurring', async () => {
    const r = await req('GET', `/export?ledger_id=${A.ledgerId}&format=json`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.version, 2, '导出格式版本应为 2');
    assert.ok(Array.isArray(r.json.tags) && r.json.tags.length >= 3);
    assert.ok(Array.isArray(r.json.transaction_tags) && r.json.transaction_tags.length >= 1);
    assert.ok(Array.isArray(r.json.recurring));
    assert.ok(Array.isArray(r.json.transactions[0].tags), '交易应带 tags 数组');
    assert.ok(r.json.transactions.every((t) => 'reimburse_state' in t), '交易应带报销状态');
    A.exportV2 = r.json;
  });

  await step('GET /export?format=csv 含「标签」「报销状态」列', async () => {
    const res = await fetch(`${API}/export?ledger_id=${encodeURIComponent(A.ledgerId)}&format=csv`, {
      headers: { Authorization: `Bearer ${A.token}` },
    });
    const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
    const header = text.replace(/^\uFEFF/, '').split('\r\n')[0];
    assert.ok(header.includes('标签'), `表头: ${header}`);
    assert.ok(header.includes('报销状态'), `表头: ${header}`);
    assert.ok(text.includes('家庭'), '应导出标签名');
  });

  await step('POST /import v2 → 标签与关联一起恢复', async () => {
    const led = await req('POST', '/ledgers', { token: A.token, body: { name: '归档账本' } });
    A.archiveLedgerId = led.json.id;
    const r = await req('POST', '/import', { token: A.token, body: { ledger_id: A.archiveLedgerId, data: A.exportV2 } });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.imported.tags >= 3, `导入标签 ${r.json.imported.tags}`);
    assert.ok(r.json.imported.tag_links >= 1, `导入标签关联 ${r.json.imported.tag_links}`);
    const tags = await req('GET', `/tags?ledger_id=${A.archiveLedgerId}`, { token: A.token });
    assert.ok(tags.json.some((t) => t.name === '家庭'));
    const txs = await req('GET', `/transactions?ledger_id=${A.archiveLedgerId}&tag_id=${tags.json.find((t) => t.name === '家庭').id}`, {
      token: A.token,
    });
    assert.ok(txs.json.total >= 1, '关联交易应能按标签筛出');
  });

  await step('POST /import v2 → 周期规则一起恢复', async () => {
    const exp = await req('GET', `/export?ledger_id=${A.recLedgerId}&format=json`, { token: A.token });
    assert.ok(exp.json.recurring.length >= 2, `周期规则 ${exp.json.recurring.length}`);
    const led = await req('POST', '/ledgers', { token: A.token, body: { name: '周期归档' } });
    const r = await req('POST', '/import', { token: A.token, body: { ledger_id: led.json.id, data: exp.json } });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.imported.recurring >= 2, `导入周期 ${r.json.imported.recurring}`);
    const list = await req('GET', `/recurring?ledger_id=${led.json.id}`, { token: A.token });
    assert.ok(list.json.items.length >= 2);
    // 重复导入仍幂等
    const again = await req('POST', '/import', { token: A.token, body: { ledger_id: led.json.id, data: exp.json } });
    assert.equal(again.json.imported.recurring, 0, '重复导入不应新增规则');
  });

  /* ------------------------------- 19. v1.2 ------------------------------- */

  await step('GET /health version = 1.3.2', async () => {
    const r = await req('GET', `${BASE}/health`);
    assert.equal(r.status, 200);
    assert.equal(r.json.version, '1.3.2');
  });

  await step('GET /accounts 每项带 group，groups 覆盖全部账户', async () => {
    const r = await req('GET', `/accounts?ledger_id=${A.ledgerId}`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    const groups = r.json.groups;
    assert.ok(Array.isArray(groups) && groups.length >= 3, `groups ${JSON.stringify(groups)}`);
    for (const a of r.json.items) {
      assert.ok(typeof a.group === 'string' && a.group.length > 0, `账户 ${a.name} 缺 group`);
    }
    const sum = groups.reduce((n, g) => n + g.count, 0);
    assert.equal(sum, r.json.items.length, 'groups 的 count 之和应等于账户数');
    for (const g of groups) {
      assert.equal(typeof g.title, 'string');
      assert.equal(typeof g.subtotal_cents, 'number');
    }
    // 固定顺序：现金 → 储蓄卡 → 电子钱包 → 信用卡 → 投资 → 应收 → 应付 → 其他
    const order = ['cash', 'bank', 'ewallet', 'credit', 'invest', 'receivable', 'payable', 'other'];
    const idx = groups.map((g) => order.indexOf(g.key));
    assert.deepEqual(idx, [...idx].sort((x, y) => x - y), `分组顺序错: ${groups.map((g) => g.key)}`);
  });

  await step('PATCH /accounts/:id 账单日 / 还款日 / 隐藏', async () => {
    const r = await req('PATCH', `/accounts/${A.creditId}`, {
      token: A.token,
      body: { bill_day: 5, repay_day: 20, hidden: 1 },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.bill_day, 5);
    assert.equal(r.json.repay_day, 20);
    assert.equal(r.json.hidden, 1);
    const shown = await req('GET', `/accounts?ledger_id=${A.ledgerId}&include_hidden=0`, { token: A.token });
    assert.ok(!shown.json.items.some((a) => a.id === A.creditId), 'include_hidden=0 时不应返回隐藏账户');
    const all = await req('GET', `/accounts?ledger_id=${A.ledgerId}`, { token: A.token });
    assert.ok(all.json.items.some((a) => a.id === A.creditId && a.hidden === 1), '默认应含隐藏账户并标 hidden=1');
    const back = await req('PATCH', `/accounts/${A.creditId}`, { token: A.token, body: { hidden: 0 } });
    assert.equal(back.json.hidden, 0);
  });

  await step('PATCH /accounts 非法 bill_day → 400', async () => {
    const r = await req('PATCH', `/accounts/${A.creditId}`, { token: A.token, body: { bill_day: 32 } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'invalid_day');
  });

  await step('GET /accounts/reminders 只列有欠款的负债账户', async () => {
    const dayNum = Number(TODAY.slice(8, 10));
    const acc = await req('POST', '/accounts', {
      token: A.token,
      body: {
        ledger_id: A.ledgerId,
        name: '花呗测试',
        type: 'credit',
        credit_limit_cents: 500000,
        balance_cents: -30000,
        bill_day: 10,
        repay_day: dayNum,
      },
    });
    assert.equal(acc.status, 201, acc.text);
    A.payId = acc.json.id;
    assert.equal(acc.json.kind, 'liability');
    assert.equal(acc.json.used_cents, 30000);

    const r = await req('GET', `/accounts/reminders?ledger_id=${A.ledgerId}`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.json.today), `today ${r.json.today}`);
    const hit = r.json.items.find((i) => i.account_id === A.payId);
    assert.ok(hit, '有欠款且有还款日的账户应出现在提醒里');
    assert.equal(hit.used_cents, 30000);
    assert.equal(hit.repay_day, dayNum);
    assert.ok(['overdue', 'today', 'soon', 'later'].includes(hit.status), `status ${hit.status}`);
    const diff = Math.round(
      (Date.parse(`${hit.due_date}T00:00:00Z`) - Date.parse(`${r.json.today}T00:00:00Z`)) / 86400000,
    );
    assert.equal(hit.days_left, diff, 'days_left 应等于 due_date - today');
    const expect = diff < 0 ? 'overdue' : diff === 0 ? 'today' : diff <= 7 ? 'soon' : 'later';
    assert.equal(hit.status, expect, 'status 分级不符合 <0/0/1-7/>7');
    assert.ok(
      !r.json.items.some((i) => i.used_cents <= 0),
      '无欠款的账户不应出现在提醒里',
    );
  });

  await step('PATCH repay_day 后 reminders 的 due_date 跟着变', async () => {
    const before = await req('GET', `/accounts/reminders?ledger_id=${A.ledgerId}`, { token: A.token });
    const old = before.json.items.find((i) => i.account_id === A.payId);
    const nextDay = old.repay_day === 28 ? 27 : 28;
    const p = await req('PATCH', `/accounts/${A.payId}`, { token: A.token, body: { repay_day: nextDay } });
    assert.equal(p.status, 200, p.text);
    const after = await req('GET', `/accounts/reminders?ledger_id=${A.ledgerId}`, { token: A.token });
    const now = after.json.items.find((i) => i.account_id === A.payId);
    assert.equal(now.repay_day, nextDay);
    assert.ok(now.days_left !== old.days_left, `days_left 应变: ${old.days_left} → ${now.days_left}`);
  });

  await step('GET /ledgers?legacy=1 返回裸数组', async () => {
    const r = await req('GET', '/ledgers?legacy=1', { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.ok(Array.isArray(r.json), 'legacy=1 应为裸数组');
    assert.ok(r.json.length >= 1);
  });

  await step('POST /ledgers 自带账户 / 分类 /「我」成员', async () => {
    const led = await req('POST', '/ledgers', { token: A.token, body: { name: '家庭账本' } });
    assert.equal(led.status, 201, led.text);
    A.famLedgerId = led.json.id;
    assert.equal(led.json.archived, 0);
    assert.equal(led.json.is_default, 0);
    const accs = await req('GET', `/accounts?ledger_id=${A.famLedgerId}`, { token: A.token });
    assert.equal(accs.json.total, 9, `新账本账户数 ${accs.json.total}`);
    A.famCashId = accs.json.items.find((a) => a.name === '现金').id;
    assert.equal(accs.json.totals.net_cents, 0, '新账本余额应为 0');
    const cats = await req('GET', `/categories?ledger_id=${A.famLedgerId}`, { token: A.token });
    assert.equal(cats.json.total, 15, `新账本分类数 ${cats.json.total}`);
    const mem = await req('GET', `/members?ledger_id=${A.famLedgerId}`, { token: A.token });
    assert.equal(mem.json.total, 1);
    assert.equal(mem.json.items[0].name, '我');
    assert.equal(mem.json.items[0].is_self, 1);
  });

  await step('DELETE 最后一本账本 → 409 last_ledger', async () => {
    const r = await req('DELETE', `/ledgers/${B.ledgerId}`, { token: B.token });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error.code, 'last_ledger');
    const still = await req('GET', '/ledgers', { token: B.token });
    assert.equal(still.json.total, 1, '409 后账本应还在');
  });

  await step('GET /members 默认带「我」is_self=1', async () => {
    const r = await req('GET', `/members?ledger_id=${A.ledgerId}`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    const self = r.json.items.find((m) => m.is_self === 1);
    assert.ok(self, '应有 is_self 成员');
    assert.equal(self.name, '我');
    assert.ok(r.json.total >= 1);
  });

  await step('POST /members 新建成员 + 重名 409', async () => {
    const r = await req('POST', '/members', {
      token: A.token,
      body: { ledger_id: A.famLedgerId, name: '小明', color: '#FF5630' },
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.name, '小明');
    assert.equal(r.json.is_self, 0);
    assert.equal(r.json.color, '#FF5630');
    A.memberId = r.json.id;
    const dup = await req('POST', '/members', { token: A.token, body: { ledger_id: A.famLedgerId, name: '小明' } });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error.code, 'member_exists');
    const bad = await req('POST', '/members', {
      token: A.token,
      body: { ledger_id: A.famLedgerId, name: '小红', color: 'red' },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'invalid_color');
  });

  await step('DELETE is_self 成员 → 409 self_member_undeletable', async () => {
    const list = await req('GET', `/members?ledger_id=${A.famLedgerId}`, { token: A.token });
    const self = list.json.items.find((m) => m.is_self === 1);
    const r = await req('DELETE', `/members/${self.id}`, { token: A.token });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error.code, 'self_member_undeletable');
  });

  await step('POST /transactions 带 member_id → 回读 member_name', async () => {
    const r = await req('POST', '/transactions', {
      token: A.token,
      body: {
        ledger_id: A.famLedgerId,
        type: 'expense',
        amount_cents: 12300,
        account_id: A.famCashId,
        member_id: A.memberId,
        note: '成员测试支出',
      },
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.item.member_id, A.memberId);
    assert.equal(r.json.item.member_name, '小明');
    A.memberTxId = r.json.item.id;
    const bad = await req('POST', '/transactions', {
      token: A.token,
      body: {
        ledger_id: A.famLedgerId,
        type: 'expense',
        amount_cents: 100,
        account_id: A.famCashId,
        member_id: 'ghost',
      },
    });
    assert.equal(bad.status, 400, bad.text);
    assert.equal(bad.json.error.code, 'invalid_member');
  });

  await step('GET /transactions?member_id= 过滤（含 self 语义）', async () => {
    const mine = await req('GET', `/transactions?ledger_id=${A.famLedgerId}&member_id=${A.memberId}`, {
      token: A.token,
    });
    assert.equal(mine.json.total, 1, `按成员筛出 ${mine.json.total} 条`);
    assert.equal(mine.json.items[0].note, '成员测试支出');
    const self = await req('GET', `/transactions?ledger_id=${A.famLedgerId}&member_id=self`, { token: A.token });
    assert.equal(self.json.total, 0, 'self 语义不应把别人的交易算进来');
    const other = await req('GET', `/transactions?ledger_id=${A.ledgerId}&member_id=${A.memberId}`, {
      token: A.token,
    });
    assert.equal(other.json.total, 0, '跨账本的成员 id 不应命中');
  });

  await step('GET /stats/by-member 合计与 overview 一致', async () => {
    const byMember = await req('GET', `/stats/by-member?ledger_id=${A.ledgerId}`, { token: A.token });
    assert.equal(byMember.status, 200, byMember.text);
    assert.ok(Array.isArray(byMember.json), 'by-member 应为裸数组');
    const ov = await req('GET', `/stats/overview?ledger_id=${A.ledgerId}`, { token: A.token });
    const sumExp = byMember.json.reduce((n, r) => n + r.expense_cents, 0);
    const sumInc = byMember.json.reduce((n, r) => n + r.income_cents, 0);
    assert.equal(sumExp, ov.json.expense_cents, '各成员支出之和应等于 overview 支出');
    assert.equal(sumInc, ov.json.income_cents, '各成员收入之和应等于 overview 收入');
    for (const r of byMember.json) {
      assert.ok('member_id' in r && typeof r.member_name === 'string');
      assert.equal(typeof r.expense_cents, 'number');
      assert.equal(typeof r.income_cents, 'number');
      assert.equal(typeof r.count, 'number');
    }
    const fam = await req('GET', `/stats/by-member?ledger_id=${A.famLedgerId}`, { token: A.token });
    const xiaoming = fam.json.find((r) => r.member_id === A.memberId);
    assert.equal(xiaoming.expense_cents, 12300);
    assert.equal(xiaoming.count, 1);
  });

  await step('GET /stats/monthly?months=12 升序补 0', async () => {
    const r = await req('GET', `/stats/monthly?ledger_id=${A.ledgerId}&months=12`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.ok(Array.isArray(r.json), 'monthly 应为裸数组');
    assert.equal(r.json.length, 12, `长度 ${r.json.length}`);
    const months = r.json.map((x) => x.month);
    assert.deepEqual(months, [...months].sort(), '月份应升序');
    assert.equal(months[11], MONTH, `最后一个月应为当月: ${months[11]}`);
    assert.equal(months[0], monthsAgo(11), `最早一个月应为 11 个月前: ${months[0]}`);
    for (const x of r.json) {
      assert.equal(typeof x.expense_cents, 'number');
      assert.equal(typeof x.income_cents, 'number');
      assert.equal(typeof x.count, 'number');
    }
    const cur = r.json[11];
    const ov = await req('GET', `/stats/overview?ledger_id=${A.ledgerId}&from=${MONTH}-01&to=${MONTH}-31`, {
      token: A.token,
    });
    assert.equal(cur.expense_cents, ov.json.expense_cents, '当月支出应与 overview 对齐');
    const wide = await req('GET', `/stats/monthly?ledger_id=${A.ledgerId}&months=999`, { token: A.token });
    assert.equal(wide.json.length, 60, 'months 应被夹到 60');
  });

  await step('GET /stats/overview 带 by_member_top', async () => {
    const r = await req('GET', `/stats/overview?ledger_id=${A.ledgerId}`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.ok(Array.isArray(r.json.by_member_top), 'by_member_top 应为数组');
    assert.ok(r.json.by_member_top.length <= 3, `最多 3 条: ${r.json.by_member_top.length}`);
    for (const m of r.json.by_member_top) {
      assert.ok(typeof m.name === 'string' && m.name.length > 0, `成员名: ${JSON.stringify(m)}`);
      assert.equal(typeof m.expense_cents, 'number');
    }
    assert.ok(r.json.by_member_top.length >= 1, '至少有「我」这一条');
  });

  await step('bob 读 alice 的 members → 403', async () => {
    const r = await req('GET', `/members?ledger_id=${A.ledgerId}`, { token: B.token });
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.error.code, 'forbidden');
  });

  /* ---------------------- 19. 薄荷记账兼容（v1.2.2） ---------------------- */

  const MINT_COLS = [
    '类型', '货币', '金额', '汇率（相对本位币）', '项目', '分类', '父类', '账户', '付款', '收款',
    '商家', '地址', '日期', '标签', '作者', '备注', '图一', '图二', '图三',
  ];
  const mintLine = (cells) => cells.concat(new Array(MINT_COLS.length - cells.length).fill('')).join('\t');
  const MINT_ROWS = [
    ['支出', 'CNY', '-25.50', '1.0000', '', '餐饮', '', '', '', '', '真功夫', '', '2026-10-02 12:30', '家庭,待报销', '萱萱', '午饭'],
    ['收入', 'CNY', '8000.00', '1.0000', '', '工资', '', '微信', '', '', '', '', '2026-10-05 09:00', '', 'Jake', '十月工资'],
    ['转账', 'CNY', '2000.00', '1.0000', '', '账户互转', '', '', '支付宝', '微信', '', '', '2025-02-13 04:42', '', 'Jake', ''],
    ['支出', 'USD', '-5.00', '7.1234', '', '餐饮', '', '', '', '', 'Blue Bottle', '', '2026-10-06 08:00', '', '萱萱', '美金咖啡'],
  ];
  const mintText = [MINT_COLS.join('\t'), ...MINT_ROWS.map(mintLine)].join('\n');
  let mintLedgerId = '';

  await step('POST /import auto 识别薄荷 TSV 并落库', async () => {
    const led = await req('POST', '/ledgers', { token: A.token, body: { name: '薄荷账本' } });
    assert.equal(led.status, 201, led.text);
    mintLedgerId = led.json.item ? led.json.item.id : led.json.id;
    const r = await req('POST', '/import', { token: A.token, body: { ledger_id: mintLedgerId, data: mintText } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.format, 'mint', `应识别为 mint: ${r.text}`);
    assert.equal(r.json.created, 4, `created=${r.json.created}`);
    assert.equal(r.json.skipped, 0, `skipped=${r.json.skipped}`);
    assert.ok(r.json.accounts_created >= 1, '应自动建「未指定」账户');
    assert.ok(r.json.members_created >= 1, '应自动建成员');
    assert.equal(typeof r.json.updated, 'number');
    assert.ok(Array.isArray(r.json.warnings));
  });

  await step('薄荷导入字段落库正确（金额/标签/成员/商家）', async () => {
    const r = await req('GET', `/transactions?ledger_id=${mintLedgerId}&limit=50`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.total, 4);
    const food = r.json.items.find((t) => (t.note || '').startsWith('午饭'));
    assert.ok(food, `应有午饭那条: ${JSON.stringify(r.json.items.map((t) => t.note))}`);
    assert.equal(food.type, 'expense');
    assert.equal(food.amount_cents, 2550, '支出应取绝对值并转分');
    assert.equal(food.note, '午饭 · 真功夫', `商家应拼进备注: ${food.note}`);
    assert.deepEqual([...food.tag_names].sort(), ['家庭', '待报销'].sort(), `标签: ${JSON.stringify(food.tag_names)}`);
    assert.equal(food.member_name, '萱萱', '作者应落成成员');
    assert.equal(food.happened_at, '2026-10-02 12:30', '日期原样保存');
    const income = r.json.items.find((t) => t.type === 'income');
    assert.equal(income.amount_cents, 800000);
    assert.equal(income.account_name, '微信');
    const tr = r.json.items.find((t) => t.type === 'transfer');
    assert.equal(tr.amount_cents, 200000);
    assert.equal(tr.account_name, '支付宝');
    assert.equal(tr.to_account_name, '微信');
    assert.equal(tr.category_id, null, '转账不应挂分类');
    const unset = (await req('GET', `/accounts?ledger_id=${mintLedgerId}`, { token: A.token })).json.items;
    const acc = unset.find((a) => a.name === '未指定');
    assert.ok(acc, '空账户应落到「未指定」');
    assert.ok(acc.include_in_net === false || acc.include_in_net === 0, '未指定不计净资产');
  });

  await step('薄荷非 CNY 行备注加货币前缀', async () => {
    const r = await req('GET', `/transactions?ledger_id=${mintLedgerId}&q=${encodeURIComponent('美金咖啡')}`, {
      token: A.token,
    });
    const tx = r.json.items[0];
    assert.ok(tx, r.text);
    assert.equal(tx.note, '[货币 USD 汇率 7.1234] 美金咖啡 · Blue Bottle');
  });

  await step('薄荷重复导入幂等 created=0', async () => {
    const r = await req('POST', '/import', { token: A.token, body: { ledger_id: mintLedgerId, format: 'mint', data: mintText } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.created, 0, `created=${r.json.created}`);
    assert.equal(r.json.skipped, 4, `skipped=${r.json.skipped}`);
  });

  await step('POST /import dry_run 不落库', async () => {
    const before = (await req('GET', `/transactions?ledger_id=${mintLedgerId}`, { token: A.token })).json.total;
    const line = mintLine(['支出', 'CNY', '-9.90', '1.0000', '', '餐饮', '', '', '', '', '', '', '2026-10-07 08:00', '', 'Jake', '试探']);
    const r = await req('POST', '/import', {
      token: A.token,
      body: { ledger_id: mintLedgerId, dry_run: true, data: `${MINT_COLS.join('\t')}\n${line}` },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.dry_run, true);
    assert.equal(r.json.created, 1, `dry_run 也应给出将创建条数: ${r.text}`);
    const after = (await req('GET', `/transactions?ledger_id=${mintLedgerId}`, { token: A.token })).json.total;
    assert.equal(after, before, 'dry_run 不应写库');
  });

  await step('GET /export?format=mint 为 UTF-16LE + BOM + 19 列', async () => {
    const res = await fetch(`${API}/export?ledger_id=${encodeURIComponent(mintLedgerId)}&format=mint`, {
      headers: { Authorization: `Bearer ${A.token}` },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /utf-16le/i, 'Content-Type 应为 utf-16le');
    assert.match(res.headers.get('content-disposition') || '', /\.txt/i, '文件名应为 .txt');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf[0], 0xff, `BOM 首字节: ${buf[0]}`);
    assert.equal(buf[1], 0xfe, `BOM 次字节: ${buf[1]}`);
    const text = buf.toString('utf16le').replace(/^\uFEFF/, '');
    assert.ok(text.includes('\r\n'), '应用 CRLF');
    const lines = text.split(/\r?\n/).filter((l, i, arr) => !(i === arr.length - 1 && l === ''));
    assert.equal(lines.length, 5, `表头 + 4 行: ${lines.length}`);
    assert.equal(lines[0], MINT_COLS.join('\t'), '表头应固定 19 列');
    for (const l of lines.slice(1)) assert.equal(l.split('\t').length, 19, `每行 19 列: ${l}`);
    const cells = lines[1].split('\t');
    assert.equal(cells.length, 19);
    const expenseLine = lines.slice(1).map((l) => l.split('\t')).find((c) => c[0] === '支出' && c[5] === '餐饮');
    assert.ok(expenseLine, `应有一条支出行: ${JSON.stringify(lines.slice(1))}`);
    assert.equal(expenseLine[2], '-25.5', `支出导出为负: ${expenseLine[2]}`);
    assert.deepEqual([...expenseLine[13].split(',')].sort(), ['家庭', '待报销'].sort(), `标签用逗号连接: ${expenseLine[13]}`);
    const trLine = lines.find((l) => l.split('\t')[0] === '转账').split('\t');
    assert.equal(trLine[7], '', '转账时「账户」列留空');
    assert.equal(trLine[8] || trLine[9], '支付宝', '付款列应为转出账户');
  });

  await step('薄荷导出可原样回导', async () => {
    const res = await fetch(`${API}/export?ledger_id=${encodeURIComponent(mintLedgerId)}&format=mint`, {
      headers: { Authorization: `Bearer ${A.token}` },
    });
    const text = Buffer.from(await res.arrayBuffer()).toString('utf16le').replace(/^\uFEFF/, '');
    const led = await req('POST', '/ledgers', { token: A.token, body: { name: '薄荷回导' } });
    const backId = led.json.item ? led.json.item.id : led.json.id;
    const r = await req('POST', '/import', { token: A.token, body: { ledger_id: backId, data: text } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.format, 'mint');
    assert.equal(r.json.created, 4, `回导条数: ${r.text}`);
    const s1 = await req('GET', `/stats/summary?ledger_id=${mintLedgerId}`, { token: A.token });
    const s2 = await req('GET', `/stats/summary?ledger_id=${backId}`, { token: A.token });
    assert.equal(s2.json.expense_cents, s1.json.expense_cents, '回导后支出合计应一致');
    assert.equal(s2.json.income_cents, s1.json.income_cents, '回导后收入合计应一致');
  });

  await step('auto 识别自家 CSV', async () => {
    const srcTotal = (await req('GET', `/transactions?ledger_id=${A.ledgerId}`, { token: A.token })).json.total;
    const res = await fetch(`${API}/export?ledger_id=${encodeURIComponent(A.ledgerId)}&format=csv`, {
      headers: { Authorization: `Bearer ${A.token}` },
    });
    const text = Buffer.from(await res.arrayBuffer()).toString('utf8').replace(/^\uFEFF/, '');
    const led = await req('POST', '/ledgers', { token: A.token, body: { name: 'CSV 回导' } });
    const csvId = led.json.item ? led.json.item.id : led.json.id;
    const r = await req('POST', '/import', { token: A.token, body: { ledger_id: csvId, data: text } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.format, 'csv', `应识别为 csv: ${r.text.slice(0, 200)}`);
    assert.ok(r.json.created > 0, '应导入若干条');
    assert.equal(r.json.created + r.json.skipped, srcTotal, `CSV 行数应守恒（源 ${srcTotal}）`);
  });

  await step('auto 识别 JSON 导出', async () => {
    const exp = await req('GET', `/export?ledger_id=${mintLedgerId}&format=json`, { token: A.token });
    const led = await req('POST', '/ledgers', { token: A.token, body: { name: 'JSON 回导' } });
    const jsonId = led.json.item ? led.json.item.id : led.json.id;
    const r = await req('POST', '/import', { token: A.token, body: { ledger_id: jsonId, data: exp.json } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.format, 'json');
    assert.ok(r.json.created >= 4, `应导入 4 条以上: ${r.text.slice(0, 200)}`);
  });

  await step('GET /export 默认格式为 csv', async () => {
    const res = await fetch(`${API}/export?ledger_id=${encodeURIComponent(mintLedgerId)}`, {
      headers: { Authorization: `Bearer ${A.token}` },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/csv/i, `默认应为 CSV: ${res.headers.get('content-type')}`);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'CSV 应带 UTF-8 BOM');
  });

  await step('POST /import 非法 format → 400', async () => {
    const r = await req('POST', '/import', { token: A.token, body: { ledger_id: mintLedgerId, format: 'xml', data: 'x' } });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.error.code, 'invalid_format');
  });

  await step('POST /import 无法识别的内容 → 400', async () => {
    const r = await req('POST', '/import', { token: A.token, body: { ledger_id: mintLedgerId, data: '这就是一段随便的文本' } });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.error.code, 'unrecognized_format');
  });

  /* --------------------- 20. v1.3 预算不变式与预警 --------------------- */

  const V3 = {}; // 预算不变式账本
  const V4 = {}; // 预警分级账本
  const V5 = {}; // 零预算账本（none 口径）

  await step('v1.3 准备：两个独立账本 + 账户/分类', async () => {
    for (const [key, name] of [['v3', '预算不变式账本'], ['v4', '预警分级账本']]) {
      const led = await req('POST', '/ledgers', { token: A.token, body: { name } });
      assert.ok(led.status === 201 || led.status === 200, led.text);
      const ctx = key === 'v3' ? V3 : V4;
      ctx.ledgerId = led.json.id;
      const accs = await req('GET', `/accounts?ledger_id=${ctx.ledgerId}`, { token: A.token });
      assert.equal(accs.status, 200, accs.text);
      ctx.cashId = accs.json.items.find((a) => a.name === '现金').id;
      const cats = await req('GET', `/categories?ledger_id=${ctx.ledgerId}&kind=expense`, { token: A.token });
      assert.equal(cats.status, 200, cats.text);
      ctx.foodId = cats.json.items.find((c) => c.name === '餐饮').id;
      ctx.trafficId = cats.json.items.find((c) => c.name === '交通').id;
      ctx.funId = cats.json.items.find((c) => c.name === '娱乐').id;
      ctx.shopId = cats.json.items.find((c) => c.name === '购物').id;
      assert.ok(
        ctx.ledgerId && ctx.cashId && ctx.foodId && ctx.trafficId && ctx.funId && ctx.shopId,
        `${key} 准备失败`,
      );
    }
  });

  await step('GET /budgets 空态补齐 v1.3 六个新字段', async () => {
    const r = await req('GET', `/budgets?ledger_id=${V3.ledgerId}&month=${MONTH}`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    for (const k of ['categories_sum_cents', 'unallocated_cents', 'mismatch', 'warn_percent', 'percent_left', 'warn_level']) {
      assert.ok(k in r.json, `缺字段 ${k}`);
    }
    assert.equal(r.json.categories_sum_cents, 0, '无分类预算');
    assert.equal(r.json.unallocated_cents, 0);
    assert.equal(r.json.mismatch, false);
    assert.equal(r.json.warn_percent, 10, '无总预算行时默认 10');
    // v1.3 修订：完全没设预算 → none（不是 over），percent_left 为 null
    assert.equal(r.json.percent_left, null, '没设预算时 percent_left 为 null');
    assert.equal(r.json.warn_level, 'none', '没设预算时 warn_level=none');
    // 旧字段一个不能少
    for (const k of ['month', 'amount_cents', 'carry_in_cents', 'available_cents', 'used_cents', 'remaining_cents', 'items']) {
      assert.ok(k in r.json, `旧字段丢失 ${k}`);
    }
  });

  await step('零预算账本有支出 → 仍为 none（不误报 over）', async () => {
    const led = await req('POST', '/ledgers', { token: A.token, body: { name: '零预算账本' } });
    assert.ok(led.status === 201 || led.status === 200, led.text);
    const ledgerId = led.json.id;
    const accs = await req('GET', `/accounts?ledger_id=${ledgerId}`, { token: A.token });
    const cashId = accs.json.items.find((a) => a.name === '现金').id;
    const cats = await req('GET', `/categories?ledger_id=${ledgerId}&kind=expense`, { token: A.token });
    const foodId = cats.json.items.find((c) => c.name === '餐饮').id;
    const tx = await req('POST', '/transactions', {
      token: A.token,
      body: { ledger_id: ledgerId, type: 'expense', amount_cents: 8888, category_id: foodId, account_id: cashId, note: '无预算消费', happened_at: TODAY },
    });
    assert.equal(tx.status, 201, tx.text);
    V5.ledgerId = ledgerId;
    const r = await req('GET', `/budgets?ledger_id=${ledgerId}&month=${MONTH}`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.used_cents, 8888, '支出已计入');
    assert.equal(r.json.remaining_cents, -8888, '余额为负');
    assert.equal(r.json.warn_level, 'none', '没设预算不报超支');
    assert.equal(r.json.percent_left, null);
  });

  await step('同一账本设预算 1000 元 → none 转为 ok（91.1%）', async () => {
    const r = await req('PUT', '/budgets', {
      token: A.token,
      body: { ledger_id: V5.ledgerId, month: MONTH, amount_cents: 100000 },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.amount_cents, 100000);
    assert.equal(r.json.remaining_cents, 91112);
    assert.equal(r.json.percent_left, 91.1);
    assert.equal(r.json.warn_level, 'ok', '一旦设了预算就参与预警');
    const view = await req('GET', `/budgets?ledger_id=${V5.ledgerId}&month=${MONTH}`, { token: A.token });
    assert.equal(view.json.warn_level, 'ok');
  });

  await step('PUT /budgets 总预算 4000 → percent_left=100 / warn_level=ok', async () => {
    const r = await req('PUT', '/budgets', {
      token: A.token,
      body: { ledger_id: V3.ledgerId, month: MONTH, amount_cents: 400000 },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.amount_cents, 400000);
    assert.equal(r.json.percent_left, 100);
    assert.equal(r.json.warn_level, 'ok');
    assert.equal(r.json.warn_percent, 10);
  });

  await step('PUT /budgets 保存分类预算不再改动总预算（4000 仍是 4000）', async () => {
    const r = await req('PUT', '/budgets', {
      token: A.token,
      body: { ledger_id: V3.ledgerId, month: MONTH, category_id: V3.foodId, amount_cents: 200000 },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.amount_cents, 400000, '总预算保持不变');
    assert.equal(r.json.categories_sum_cents, 200000);
    assert.equal(r.json.unallocated_cents, 200000, '未分配 = 总额 - 明细合计');
    assert.equal(r.json.mismatch, true, '有未分配只是状态，不是错误');
    const food = r.json.items.find((i) => i.category_id === V3.foodId);
    assert.equal(food.amount_cents, 200000);
    assert.equal(food.percent_left, 100);
    assert.equal(food.warn_level, 'ok');
  });

  await step('PUT /budgets 第二个分类 → Σ=3000，总预算仍是 4000', async () => {
    const r = await req('PUT', '/budgets', {
      token: A.token,
      body: { ledger_id: V3.ledgerId, month: MONTH, category_id: V3.trafficId, amount_cents: 100000 },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.amount_cents, 400000);
    assert.equal(r.json.categories_sum_cents, 300000);
    assert.equal(r.json.unallocated_cents, 100000);
    assert.equal(r.json.items.length, 3, '总预算行 + 2 个分类行');
  });

  await step('PUT /budgets 第三个分类 333.33 → Σ=3333.33 / 未分配 666.67', async () => {
    const r = await req('PUT', '/budgets', {
      token: A.token,
      body: { ledger_id: V3.ledgerId, month: MONTH, category_id: V3.funId, amount_cents: 33333 },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.amount_cents, 400000);
    assert.equal(r.json.categories_sum_cents, 333333);
    assert.equal(r.json.unallocated_cents, 66667);
    assert.equal(r.json.items.length, 4);
  });

  await step('PUT /budgets 总预算 2500 < Σ 3333.33 → 409 budget_below_allocated 且 details 精确', async () => {
    const r = await req('PUT', '/budgets', {
      token: A.token,
      body: { ledger_id: V3.ledgerId, month: MONTH, amount_cents: 250000 },
    });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error.code, 'budget_below_allocated');
    assert.deepEqual(r.json.error.details, { total_cents: 250000, categories_sum_cents: 333333 });
    const view = await req('GET', `/budgets?ledger_id=${V3.ledgerId}&month=${MONTH}`, { token: A.token });
    assert.equal(view.json.amount_cents, 400000, '409 后总预算未被改写');
    assert.equal(view.json.categories_sum_cents, 333333, '409 后分类也未被改写');
  });

  await step('PUT /budgets rebalance:true → 按比例把分类压进 2500，Σ 精确不丢分', async () => {
    const before = await req('GET', `/budgets?ledger_id=${V3.ledgerId}&month=${MONTH}`, { token: A.token });
    const beforeMap = new Map(
      before.json.items.filter((i) => i.category_id).map((i) => [i.category_id, i.amount_cents]),
    );
    const beforeSum = [...beforeMap.values()].reduce((s, v) => s + v, 0);
    const r = await req('PUT', '/budgets', {
      token: A.token,
      body: { ledger_id: V3.ledgerId, month: MONTH, amount_cents: 250000, rebalance: true },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.amount_cents, 250000);
    assert.equal(r.json.categories_sum_cents, 250000, 'Σ 精确等于新总额，不丢分');
    assert.equal(r.json.unallocated_cents, 0);
    assert.equal(r.json.mismatch, false);
    const after = new Map(r.json.items.filter((i) => i.category_id).map((i) => [i.category_id, i.amount_cents]));
    assert.equal(after.size, beforeMap.size, '分类行数不变');
    for (const [cid, oldVal] of beforeMap) {
      const expected = (oldVal * 250000) / beforeSum;
      assert.ok(Math.abs(after.get(cid) - expected) <= 1, `分类 ${cid} 比例偏差：${after.get(cid)} vs ${expected}`);
      assert.ok(after.get(cid) > 0, `分类 ${cid} 仍应有额度`);
    }
    assert.equal([...after.values()].reduce((s, v) => s + v, 0), 250000);
  });

  await step('PUT /budgets 分类明细超出总预算 → 409 budget_below_allocated（不落库）', async () => {
    const r = await req('PUT', '/budgets', {
      token: A.token,
      body: { ledger_id: V3.ledgerId, month: MONTH, category_id: V3.shopId, amount_cents: 250000 },
    });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error.code, 'budget_below_allocated');
    assert.equal(r.json.error.details.total_cents, 250000);
    assert.equal(r.json.error.details.categories_sum_cents, 500000);
    const view = await req('GET', `/budgets?ledger_id=${V3.ledgerId}&month=${MONTH}`, { token: A.token });
    assert.equal(view.json.categories_sum_cents, 250000, '失败请求未落库');
    assert.equal(view.json.items.filter((i) => i.category_id === V3.shopId).length, 0);
  });

  await step('PUT /budgets 分类 + rebalance → 自动压回总预算内', async () => {
    const r = await req('PUT', '/budgets', {
      token: A.token,
      body: { ledger_id: V3.ledgerId, month: MONTH, category_id: V3.shopId, amount_cents: 250000, rebalance: true },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.amount_cents, 250000, '总预算不动');
    assert.equal(r.json.categories_sum_cents, 250000, 'Σ 精确压回总预算');
    assert.equal(r.json.unallocated_cents, 0);
    assert.equal(r.json.items.length, 5, '总预算行 + 4 个分类行');
  });

  await step('PUT /budgets unallocated_cents=500 元 → 总预算 = Σ + 未分配', async () => {
    const r = await req('PUT', '/budgets', {
      token: A.token,
      body: { ledger_id: V3.ledgerId, month: MONTH, unallocated_cents: 50000 },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.amount_cents, 300000, '2500 + 500');
    assert.equal(r.json.categories_sum_cents, 250000, 'Σ 不动');
    assert.equal(r.json.unallocated_cents, 50000);
    assert.equal(r.json.mismatch, true);
    assert.equal(r.json.warn_level, 'ok', 'mismatch 不影响预警档位');
  });

  await step('PUT /budgets amount_cents 与 unallocated_cents 同传 → 400 conflicting_amount', async () => {
    const r = await req('PUT', '/budgets', {
      token: A.token,
      body: { ledger_id: V3.ledgerId, month: MONTH, amount_cents: 100000, unallocated_cents: 1000 },
    });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.error.code, 'conflicting_amount');
  });

  await step('PUT /budgets warn_percent=15 → 落库回显且不改金额', async () => {
    const r = await req('PUT', '/budgets', {
      token: A.token,
      body: { ledger_id: V3.ledgerId, month: MONTH, warn_percent: 15 },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.warn_percent, 15);
    assert.equal(r.json.amount_cents, 300000, '只传 warn_percent 时金额取现值');
    assert.equal(r.json.categories_sum_cents, 250000);
    const view = await req('GET', `/budgets?ledger_id=${V3.ledgerId}&month=${MONTH}`, { token: A.token });
    assert.equal(view.json.warn_percent, 15, 'GET 回读一致');
  });

  await step('PUT /budgets warn_percent 边界 1 / 100 均接受', async () => {
    for (const v of [1, 100]) {
      const r = await req('PUT', '/budgets', {
        token: A.token,
        body: { ledger_id: V3.ledgerId, month: MONTH, warn_percent: v },
      });
      assert.equal(r.status, 200, `${v}: ${r.text}`);
      assert.equal(r.json.warn_percent, v);
    }
  });

  await step('PUT /budgets warn_percent 非法 0 / 101 / "abc" → 400 invalid_warn_percent', async () => {
    for (const v of [0, 101, 'abc', 1.5]) {
      const r = await req('PUT', '/budgets', {
        token: A.token,
        body: { ledger_id: V3.ledgerId, month: MONTH, warn_percent: v },
      });
      assert.equal(r.status, 400, `${JSON.stringify(v)}: ${r.text}`);
      assert.equal(r.json.error.code, 'invalid_warn_percent');
    }
  });

  await step('预算 percent_left 四舍五入到 1 位（58.86 → 58.9）', async () => {
    const put = await req('PUT', '/budgets', {
      token: A.token,
      body: { ledger_id: V4.ledgerId, month: MONTH, amount_cents: 300000 },
    });
    assert.equal(put.status, 200, put.text);
    const tx = await req('POST', '/transactions', {
      token: A.token,
      body: {
        ledger_id: V4.ledgerId,
        type: 'expense',
        amount_cents: 123420,
        category_id: V4.foodId,
        account_id: V4.cashId,
        note: '预警测试 1',
        happened_at: TODAY,
      },
    });
    assert.equal(tx.status, 201, tx.text);
    const view = await req('GET', `/budgets?ledger_id=${V4.ledgerId}&month=${MONTH}`, { token: A.token });
    assert.equal(view.json.remaining_cents, 176580);
    assert.equal(view.json.percent_left, 58.9, '四舍五入（截断会得 58.8）');
    assert.equal(view.json.warn_level, 'ok', '58.9 > 默认 10');
  });

  await step('warn_percent=60 → percent 58.9 触发 warn', async () => {
    const r = await req('PUT', '/budgets', {
      token: A.token,
      body: { ledger_id: V4.ledgerId, month: MONTH, warn_percent: 60 },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.percent_left, 58.9);
    assert.equal(r.json.warn_level, 'warn');
    const food = r.json.items.find((i) => i.category_id === null);
    assert.equal(food.warn_level, 'warn', '顶层口径同步');
  });

  await step('warn_percent=50 → 同一数据回落 ok', async () => {
    const r = await req('PUT', '/budgets', {
      token: A.token,
      body: { ledger_id: V4.ledgerId, month: MONTH, warn_percent: 50 },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.warn_level, 'ok');
  });

  await step('超支 → warn_level=over 且 percent_left 为负', async () => {
    const tx = await req('POST', '/transactions', {
      token: A.token,
      body: {
        ledger_id: V4.ledgerId,
        type: 'expense',
        amount_cents: 200000,
        category_id: V4.foodId,
        account_id: V4.cashId,
        note: '预警测试 2',
        happened_at: TODAY,
      },
    });
    assert.equal(tx.status, 201, tx.text);
    const view = await req('GET', `/budgets?ledger_id=${V4.ledgerId}&month=${MONTH}`, { token: A.token });
    assert.equal(view.json.remaining_cents, -23420);
    assert.ok(view.json.percent_left < 0, `percent_left=${view.json.percent_left}`);
    assert.equal(view.json.warn_level, 'over');
  });

  await step('分类额度改 0 → 删除该行，总预算不被同步下调', async () => {
    const before = await req('GET', `/budgets?ledger_id=${V3.ledgerId}&month=${MONTH}`, { token: A.token });
    const sumBefore = before.json.categories_sum_cents;
    const traffic = before.json.items.find((i) => i.category_id === V3.trafficId);
    assert.ok(traffic, '改 0 之前交通分类行存在');
    const r = await req('PUT', '/budgets', {
      token: A.token,
      body: { ledger_id: V3.ledgerId, month: MONTH, category_id: V3.trafficId, amount_cents: 0 },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.removed, true);
    assert.equal(r.json.items.filter((i) => i.category_id === V3.trafficId).length, 0, '分类行已删除');
    assert.equal(r.json.categories_sum_cents, sumBefore - traffic.amount_cents, 'Σ 只减去被删的额度');
    assert.equal(r.json.amount_cents, 300000, '总预算不随 Σ 下降');
    assert.equal(r.json.unallocated_cents, 300000 - (sumBefore - traffic.amount_cents));
    const cats = r.json.items.filter((i) => i.category_id).map((i) => i.category_id);
    assert.deepEqual(cats.sort(), [V3.foodId, V3.funId, V3.shopId].sort());
  });

  /* ------------- 20.0b lead 场景：明细先于总额（等式模型） ------------- */

  const V6 = {};

  await step('lead 场景 A：先只设分类 1200/300/800 → 顶部总额自动 = Σ = 2300', async () => {
    const led = await req('POST', '/ledgers', { token: A.token, body: { name: '等式模型账本' } });
    assert.ok(led.status === 201 || led.status === 200, led.text);
    V6.ledgerId = led.json.id;
    const cats = await req('GET', `/categories?ledger_id=${V6.ledgerId}&kind=expense`, { token: A.token });
    assert.equal(cats.status, 200, cats.text);
    V6.foodId = cats.json.items.find((c) => c.name === '餐饮').id;
    V6.trafficId = cats.json.items.find((c) => c.name === '交通').id;
    V6.shopId = cats.json.items.find((c) => c.name === '购物').id;
    for (const [cid, amount] of [
      [V6.foodId, 120000],
      [V6.trafficId, 30000],
      [V6.shopId, 80000],
    ]) {
      const r = await req('PUT', '/budgets', {
        token: A.token,
        body: { ledger_id: V6.ledgerId, month: MONTH, category_id: cid, amount_cents: amount },
      });
      assert.equal(r.status, 200, r.text);
    }
    const view = await req('GET', `/budgets?ledger_id=${V6.ledgerId}&month=${MONTH}`, { token: A.token });
    assert.equal(view.json.categories_sum_cents, 230000, 'Σ = 1200 + 300 + 800');
    assert.equal(view.json.amount_cents, 230000, '无总预算行时顶部总额取 Σ（不是 0）');
    assert.equal(view.json.unallocated_cents, 0);
    assert.equal(view.json.mismatch, false);
    assert.equal(view.json.warn_level, 'ok', '全新账本未支出 → ok');
  });

  await step('lead 场景 B：再设总预算 4500 → 未分配 2200 / mismatch 但不报警', async () => {
    const r = await req('PUT', '/budgets', {
      token: A.token,
      body: { ledger_id: V6.ledgerId, month: MONTH, amount_cents: 450000 },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.amount_cents, 450000);
    assert.equal(r.json.categories_sum_cents, 230000, '分类预算不被改写');
    assert.equal(r.json.unallocated_cents, 220000, '4500 - 2300');
    assert.equal(r.json.mismatch, true, '有未分配 → mismatch=true（仅状态）');
    assert.equal(r.json.warn_level, 'ok', 'warn_level 只看 remaining / 阈值');
    assert.equal(r.json.percent_left, 100);
    const view = await req('GET', `/budgets?ledger_id=${V6.ledgerId}&month=${MONTH}`, { token: A.token });
    assert.equal(view.json.amount_cents, 450000, '再次读取仍是 450000（不被 Σ 覆盖）');
    assert.equal(view.json.unallocated_cents, 220000);
  });

  /* ------------- 20.0c v1.3.2 预算功能总开关（按账本，0/1） ------------- */

  const V7 = {};

  await step('v1.3.2 新账本 budget_enabled === 0（POST 与 GET /ledgers 一致）', async () => {
    const led = await req('POST', '/ledgers', { token: A.token, body: { name: '预算开关账本' } });
    assert.ok(led.status === 201 || led.status === 200, led.text);
    assert.equal(led.json.budget_enabled, 0, 'POST /ledgers 出参带 budget_enabled=0');
    V7.ledgerId = led.json.id;
    const list = await req('GET', '/ledgers?legacy=1', { token: A.token });
    const mine = list.json.find((l) => l.id === V7.ledgerId);
    assert.equal(mine.budget_enabled, 0, 'GET /ledgers 里也是 0');
    assert.equal(typeof mine.budget_enabled, 'number', '是 0/1 数字，不是 boolean');
  });

  await step('v1.3.2 GET /budgets 出参 enabled === 0（默认关闭）', async () => {
    const r = await req('GET', `/budgets?ledger_id=${V7.ledgerId}&month=${MONTH}`, { token: A.token });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.enabled, 0);
    assert.equal(r.json.items.length, 0, '还没设任何预算');
  });

  await step('v1.3.2 PUT /budgets {enabled:true} → 1，且不建预算行', async () => {
    const r = await req('PUT', '/budgets', {
      token: A.token,
      body: { ledger_id: V7.ledgerId, month: MONTH, enabled: true },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.enabled, 1);
    assert.equal(r.json.items.length, 0, '只带开关的请求不创建预算行');
    assert.equal(r.json.amount_cents, 0);
    const view = await req('GET', `/budgets?ledger_id=${V7.ledgerId}&month=${MONTH}`, { token: A.token });
    assert.equal(view.json.enabled, 1, '再 GET 仍是 1');
    const list = await req('GET', '/ledgers?legacy=1', { token: A.token });
    assert.equal(list.json.find((l) => l.id === V7.ledgerId).budget_enabled, 1, '账本上也落库了');
  });

  await step('v1.3.2 PUT /budgets {enabled:false} → 0，数据保留', async () => {
    const r = await req('PUT', '/budgets', {
      token: A.token,
      body: { ledger_id: V7.ledgerId, month: MONTH, enabled: false },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.enabled, 0);
    const view = await req('GET', `/budgets?ledger_id=${V7.ledgerId}&month=${MONTH}`, { token: A.token });
    assert.equal(view.json.enabled, 0, '再 GET 仍是 0');
  });

  await step('v1.3.2 关闭态写入 amount_cents>0 → 自动置 enabled=1', async () => {
    const r = await req('PUT', '/budgets', {
      token: A.token,
      body: { ledger_id: V7.ledgerId, month: MONTH, amount_cents: 500000 },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.amount_cents, 500000);
    assert.equal(r.json.enabled, 1, '写了正数预算就自动开启');
    const view = await req('GET', `/budgets?ledger_id=${V7.ledgerId}&month=${MONTH}`, { token: A.token });
    assert.equal(view.json.enabled, 1);
  });

  await step('v1.3.2 PUT /budgets {enabled:1|0} 兼容数字写法', async () => {
    const on = await req('PUT', '/budgets', {
      token: A.token,
      body: { ledger_id: V7.ledgerId, month: MONTH, enabled: 0 },
    });
    assert.equal(on.status, 200, on.text);
    assert.equal(on.json.enabled, 0, 'enabled:0 关闭');
    const off = await req('PUT', '/budgets', {
      token: A.token,
      body: { ledger_id: V7.ledgerId, month: MONTH, enabled: 1 },
    });
    assert.equal(off.status, 200, off.text);
    assert.equal(off.json.enabled, 1, 'enabled:1 开启');
    const bad = await req('PUT', '/budgets', {
      token: A.token,
      body: { ledger_id: V7.ledgerId, month: MONTH, enabled: 'yes' },
    });
    assert.equal(bad.status, 400, bad.text);
    assert.equal(bad.json.error.code, 'invalid_enabled');
  });

  /* ---------------------- 20.1 周期记账：暂停不清字段 ---------------------- */

  const pausedRule = {};

  await step('新建周期规则（下月起每月）', async () => {
    const start = nextMonthly(TODAY, 1);
    const r = await req('POST', '/recurring', {
      token: A.token,
      body: {
        ledger_id: A.recLedgerId,
        type: 'expense',
        amount_cents: 12345,
        account_id: A.recAccountId,
        note: '暂停测试',
        freq: 'monthly',
        interval: 1,
        start_date: start,
      },
    });
    assert.equal(r.status, 201, r.text);
    pausedRule.id = r.json.id;
    pausedRule.snapshot = { ...r.json };
    assert.equal(r.json.ledger_id, A.recLedgerId, 'recurringOut 必须带 ledger_id');
    assert.equal(Number(r.json.enabled), 1);
  });

  await step('PATCH /recurring/:id {enabled:0} → 其它字段一个不变', async () => {
    const r = await req('PATCH', `/recurring/${pausedRule.id}`, { token: A.token, body: { enabled: 0 } });
    assert.equal(r.status, 200, r.text);
    assert.equal(Number(r.json.enabled), 0, '已暂停');
    for (const k of ['amount_cents', 'note', 'freq', 'interval', 'next_run', 'ledger_id', 'type', 'start_date']) {
      assert.equal(r.json[k], pausedRule.snapshot[k], `字段 ${k} 被清空/改写`);
    }
    const view = await req('GET', `/recurring?ledger_id=${A.recLedgerId}`, { token: A.token });
    assert.equal(view.status, 200, view.text);
    const row = view.json.items.find((i) => i.id === pausedRule.id);
    assert.ok(row, '暂停的规则仍应出现在列表里（不是删除）');
    assert.equal(Number(row.enabled), 0);
    assert.equal(row.due, false, '暂停后 due 恒 false');
  });

  await step('POST /recurring/run 不为暂停规则生成流水', async () => {
    const r = await req('POST', '/recurring/run', {
      token: A.token,
      body: { ledger_id: A.recLedgerId, date: nextMonthly(TODAY, 2) },
    });
    assert.equal(r.status, 200, r.text);
    assert.ok(Array.isArray(r.json.created));
    assert.equal(
      r.json.created.some((t) => String(t.external_id || '').includes(pausedRule.id)),
      false,
      '暂停规则不应生成流水',
    );
    const list = await req('GET', `/transactions?ledger_id=${A.recLedgerId}&limit=1000`, { token: A.token });
    assert.equal(list.json.items.some((t) => String(t.external_id || '').includes(pausedRule.id)), false);
  });
}

/* ---------------------------------- 收尾 ---------------------------------- */

let exitCode = 0;
try {
  await main();
} catch (err) {
  console.error('\n[FATAL]', err && err.stack ? err.stack : err);
  console.error('\n--- server log ---\n' + logs);
  exitCode = 1;
} finally {
  await stopServer();
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

const total = pass + failed.length;
console.log(`\nPASS ${pass}/${total}`);
if (failed.length) {
  console.log(`失败用例：\n${failed.map((n) => ` - ${n}`).join('\n')}`);
  console.log(`\n--- server log ---\n${logs}`);
  exitCode = 1;
}
process.exit(exitCode);
