// v1.3 接口独立复验（按 docs/CONTRACT-v1.3.md §5 写，只看契约不看实现）
// 用法: node tools/verify/api-v13.mjs
// 自带服务：PORT=8805、DB_PATH=.tmp/api-v13.db（每次先删库，从种子起跑）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PORT) || 8805;
const DB = path.join(ROOT, '.tmp', 'api-v13.db');
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const TODAY = new Date().toISOString().slice(0, 10);
const MONTH = '2026-11';

fs.mkdirSync(path.dirname(DB), { recursive: true });
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
  try {
    fs.unlinkSync(f);
  } catch {
    /* 不存在就算了 */
  }
}

const results = [];
const ok = (name, cond, detail = '') => results.push({ name, pass: !!cond, detail: String(detail) });

async function req(method, url, { token, body } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

const child = spawn(process.execPath, ['src/server.js'], {
  cwd: path.join(ROOT, 'server'),
  env: { ...process.env, PORT: String(PORT), DB_PATH: DB },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => (serverLog += d.toString()));
child.stderr.on('data', (d) => (serverLog += d.toString()));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return await r.json();
    } catch {
      /* 还没起 */
    }
    await sleep(150);
  }
  throw new Error('server never came up:\n' + serverLog);
}

const near = (a, b, eps = 0.15) => Math.abs(Number(a) - Number(b)) <= eps;

try {
  const health = await waitUp();
  ok('health.version 是 1.3.x', /^1\.3\.\d+$/.test(String(health.version)), health.version);

  // ---- §2.1 迁移：user_version=4 + warn_percent 列
  const db = new DatabaseSync(DB, { readOnly: true });
  const uv = db.prepare('PRAGMA user_version').get();
  const cols = db.prepare('PRAGMA table_info(budgets)').all().map((c) => c.name);
  const seededWarn = db.prepare('SELECT warn_percent FROM budgets WHERE category_id IS NULL LIMIT 1').get();
  const ledgerCols = db.prepare('PRAGMA table_info(ledgers)').all().map((c) => c.name);
  db.close();
  ok('迁移后 user_version >= 4', Number(uv?.user_version ?? uv?.['user_version']) >= 4, JSON.stringify(uv));
  ok('budgets 有 warn_percent 列', cols.includes('warn_percent'), cols.join(','));
  ok('ledgers 有 budget_enabled 列（v1.3.2）', ledgerCols.includes('budget_enabled'), ledgerCols.join(','));
  ok('存量总预算行 warn_percent = 10', !seededWarn || Number(seededWarn.warn_percent) === 10, JSON.stringify(seededWarn));

  const login = await req('POST', '/auth/login', { body: { username: 'demo', password: 'demo1234' } });
  const token = login.json?.token;
  ok('login 200 且有 token', login.status === 200 && !!token, login.status);

  // 用一本全新账本做预算实验，避免种子数据干扰
  const mk = await req('POST', '/ledgers', { token, body: { name: 'v13预算实验' } });
  const lid = mk.json?.id || mk.json?.ledger?.id;
  ok('POST /ledgers 建实验账本', !!lid, mk.status + ' ' + mk.text.slice(0, 120));

  const cats = (await req('GET', `/categories?ledger_id=${lid}`, { token })).json?.items || [];
  const expCats = cats.filter((c) => c.kind === 'expense').slice(0, 3);
  const [c1, c2] = expCats;
  ok('实验账本有支出分类', expCats.length >= 2, expCats.map((c) => c.name).join(','));

  const accs = (await req('GET', `/accounts?ledger_id=${lid}`, { token })).json?.items || [];
  const cash = accs.find((a) => a.type === 'cash') || accs[0];

  // ---- §2.3 新字段齐全（空账本也要有）
  const b0 = await req('GET', `/budgets?ledger_id=${lid}&month=${MONTH}`, { token });
  const need = ['categories_sum_cents', 'unallocated_cents', 'mismatch', 'warn_percent', 'percent_left', 'warn_level'];
  ok('GET /budgets 有 §2.3 六个新字段', b0.status === 200 && need.every((k) => k in (b0.json || {})), Object.keys(b0.json || {}).join(','));
  ok('空预算 warn_percent 默认 10', Number(b0.json?.warn_percent) === 10, String(b0.json?.warn_percent));
  ok(
    '零预算账本 warn_level=none / percent_left=null',
    b0.json?.warn_level === 'none' && b0.json?.percent_left === null,
    `warn_level=${b0.json?.warn_level} percent_left=${JSON.stringify(b0.json?.percent_left)}`,
  );

  // ---- §2.2 分类预算保存：不动总预算
  const p1 = await req('PUT', '/budgets', { token, body: { ledger_id: lid, month: MONTH, category_id: c1.id, amount_cents: 120000 } });
  const p2 = await req('PUT', '/budgets', { token, body: { ledger_id: lid, month: MONTH, category_id: c2.id, amount_cents: 80000 } });
  ok('保存两条分类预算 2xx', p1.status === 200 && p2.status === 200, `${p1.status}/${p2.status}`);
  const b1 = (await req('GET', `/budgets?ledger_id=${lid}&month=${MONTH}`, { token })).json || {};
  ok('分类保存后总预算回落 = Σ（200000），未被自动写成别的数', Number(b1.amount_cents) === 200000, `amount=${b1.amount_cents} sum=${b1.categories_sum_cents}`);
  ok('categories_sum_cents = 200000', Number(b1.categories_sum_cents) === 200000, String(b1.categories_sum_cents));
  ok('此时未分配 = 0 / mismatch = false', b1.mismatch === false && Number(b1.unallocated_cents) === 0, `mismatch=${b1.mismatch} unalloc=${b1.unallocated_cents}`);
  {
    const db2 = new DatabaseSync(DB, { readOnly: true });
    const n = db2.prepare('SELECT COUNT(*) AS c FROM budgets WHERE ledger_id = ? AND category_id IS NULL').get(lid);
    db2.close();
    ok('分类保存没有偷偷生成总预算行', Number(n?.c) === 0, `rows=${n?.c}`);
  }

  // ---- 总预算 > Σ：允许，差额进「未分配」
  const t1 = await req('PUT', '/budgets', { token, body: { ledger_id: lid, month: MONTH, amount_cents: 300000 } });
  const b1b = (await req('GET', `/budgets?ledger_id=${lid}&month=${MONTH}`, { token })).json || {};
  ok('总预算 300000 > Σ → 200', t1.status === 200, `${t1.status} ${t1.text.slice(0, 100)}`);
  ok('未分配 = 100000 / mismatch = true', Number(b1b.unallocated_cents) === 100000 && b1b.mismatch === true, `unalloc=${b1b.unallocated_cents} mismatch=${b1b.mismatch}`);
  ok('有未分配时 warn_level 仍是 ok（不是错误态）', b1b.warn_level === 'ok', String(b1b.warn_level));

  // ---- 总预算 < Σ → 409 budget_below_allocated
  const bad = await req('PUT', '/budgets', { token, body: { ledger_id: lid, month: MONTH, amount_cents: 150000 } });
  ok('总预算 < Σ 且不带 rebalance → 409', bad.status === 409 && bad.json?.error?.code === 'budget_below_allocated', `${bad.status} ${bad.json?.error?.code}`);
  ok(
    '409 details 给出两个数',
    Number(bad.json?.error?.details?.total_cents) === 150000 && Number(bad.json?.error?.details?.categories_sum_cents) === 200000,
    JSON.stringify(bad.json?.error?.details),
  );

  // ---- rebalance：把分类按比例缩进总预算，Σ 精确相等
  const reb = await req('PUT', '/budgets', { token, body: { ledger_id: lid, month: MONTH, amount_cents: 150000, rebalance: true } });
  ok('rebalance:true → 200', reb.status === 200, reb.status + ' ' + reb.text.slice(0, 120));
  const b2 = (await req('GET', `/budgets?ledger_id=${lid}&month=${MONTH}`, { token })).json || {};
  const catItems = (b2.items || []).filter((i) => i.category_id);
  const sum2 = catItems.reduce((s, i) => s + Number(i.amount_cents), 0);
  ok('rebalance 后 Σ 精确 = 150000', sum2 === 150000, `sum=${sum2}`);
  ok('rebalance 后总预算 = 150000 且未分配 0', Number(b2.amount_cents) === 150000 && Number(b2.unallocated_cents) === 0, `amount=${b2.amount_cents} unalloc=${b2.unallocated_cents}`);
  ok(
    'rebalance 按比例（120000/80000 → 90000/60000）',
    catItems.find((i) => i.category_id === c1.id)?.amount_cents === 90000 && catItems.find((i) => i.category_id === c2.id)?.amount_cents === 60000,
    catItems.map((i) => `${i.category_name}:${i.amount_cents}`).join(' '),
  );

  // ---- unallocated_cents 入参：总预算 = Σ + 未分配
  const un = await req('PUT', '/budgets', { token, body: { ledger_id: lid, month: MONTH, unallocated_cents: 50000 } });
  const b2b = (await req('GET', `/budgets?ledger_id=${lid}&month=${MONTH}`, { token })).json || {};
  ok('unallocated_cents=50000 → 总预算 = Σ + 50000 = 200000', un.status === 200 && Number(b2b.amount_cents) === 200000 && Number(b2b.unallocated_cents) === 50000, `${un.status} amount=${b2b.amount_cents} unalloc=${b2b.unallocated_cents}`);

  // ---- 最大余数法：压缩到奇数总额不丢分（rebalance 只在「总预算 < Σ」时触发）
  await req('PUT', '/budgets', { token, body: { ledger_id: lid, month: MONTH, category_id: c1.id, amount_cents: 33333 } });
  await req('PUT', '/budgets', { token, body: { ledger_id: lid, month: MONTH, category_id: c2.id, amount_cents: 66668 } });
  const odd = await req('PUT', '/budgets', { token, body: { ledger_id: lid, month: MONTH, amount_cents: 99999, rebalance: true } });
  const b3 = (await req('GET', `/budgets?ledger_id=${lid}&month=${MONTH}`, { token })).json || {};
  const oddItems = (b3.items || []).filter((i) => i.category_id);
  const sum3 = oddItems.reduce((s, i) => s + Number(i.amount_cents), 0);
  ok(
    '压缩到奇数总额 rebalance 不丢分（100001 → 99999）',
    odd.status === 200 && sum3 === 99999 && oddItems.every((i) => i.amount_cents > 0),
    `sum=${sum3} items=${oddItems.map((i) => i.amount_cents).join('/')}`,
  );

  // ---- warn_percent 校验与落库
  const w1 = await req('PUT', '/budgets', { token, body: { ledger_id: lid, month: MONTH, warn_percent: 15 } });
  const b4 = (await req('GET', `/budgets?ledger_id=${lid}&month=${MONTH}`, { token })).json || {};
  ok('只传 warn_percent 也能保存并回显 15', w1.status === 200 && Number(b4.warn_percent) === 15, `${w1.status} warn=${b4.warn_percent}`);
  const wBad = [];
  for (const v of [0, 101, 'abc']) {
    const r = await req('PUT', '/budgets', { token, body: { ledger_id: lid, month: MONTH, warn_percent: v } });
    wBad.push(`${v}:${r.status}`);
  }
  ok('warn_percent 非法值全部 400', wBad.every((s) => s.endsWith(':400')), wBad.join(' '));

  // ---- warn_level 三态（available=100001，阈值 15%）
  const spend = async (cents, catId) =>
    req('POST', '/transactions', {
      token,
      body: {
        ledger_id: lid,
        type: 'expense',
        amount_cents: cents,
        category_id: catId,
        account_id: cash?.id,
        happened_at: `${MONTH}-05T12:00`,
        note: `v13 warn ${cents}`,
      },
    });
  await spend(80000, c1.id);
  const b5 = (await req('GET', `/budgets?ledger_id=${lid}&month=${MONTH}`, { token })).json || {};
  ok('剩余 20% > 15% → ok', b5.warn_level === 'ok', `${b5.warn_level} left=${b5.percent_left}`);
  await spend(10000, c1.id);
  const b6 = (await req('GET', `/budgets?ledger_id=${lid}&month=${MONTH}`, { token })).json || {};
  ok('剩余 10% ≤ 15% → warn', b6.warn_level === 'warn', `${b6.warn_level} left=${b6.percent_left}`);
  await spend(20000, c1.id);
  const b7 = (await req('GET', `/budgets?ledger_id=${lid}&month=${MONTH}`, { token })).json || {};
  ok('超支 → over', b7.warn_level === 'over' && Number(b7.remaining_cents) < 0, `${b7.warn_level} remaining=${b7.remaining_cents}`);
  ok(
    'percent_left = round(remaining/available*100,1)',
    near(b7.percent_left, Math.round((Number(b7.remaining_cents) / Number(b7.available_cents)) * 1000) / 10, 0.11),
    `left=${b7.percent_left} calc=${Math.round((Number(b7.remaining_cents) / Number(b7.available_cents)) * 1000) / 10}`,
  );
  ok('items[] 也带 percent_left / warn_level', (b7.items || []).length > 0 && (b7.items || []).every((i) => 'percent_left' in i && 'warn_level' in i), 'ok');

  // ---- 旧字段零回归
  const legacy = ['amount_cents', 'carry_in_cents', 'available_cents', 'used_cents', 'remaining_cents', 'items'];
  ok('旧字段仍在（零回归）', legacy.every((k) => k in b7) && Array.isArray(b7.items), legacy.filter((k) => !(k in b7)).join(',') || 'ok');

  // ---- §3 PATCH /recurring 合并语义
  const rule = await req('POST', '/recurring', {
    token,
    body: {
      ledger_id: lid,
      type: 'expense',
      amount_cents: 12345,
      category_id: c1.id,
      account_id: cash?.id,
      note: '房租测试',
      freq: 'monthly',
      start_date: '2027-01-01',
    },
  });
  const rid = rule.json?.id;
  ok('POST /recurring 建规则', !!rid, rule.status + ' ' + rule.text.slice(0, 120));
  const before = (await req('GET', `/recurring?ledger_id=${lid}`, { token })).json;
  const beforeRule = (Array.isArray(before) ? before : before?.items || []).find((r) => r.id === rid);
  const patch = await req('PATCH', `/recurring/${rid}`, { token, body: { enabled: 0 } });
  ok('PATCH {enabled:0} → 200', patch.status === 200, patch.status + ' ' + patch.text.slice(0, 120));
  const afterList = (await req('GET', `/recurring?ledger_id=${lid}`, { token })).json;
  const afterRule = (Array.isArray(afterList) ? afterList : afterList?.items || []).find((r) => r.id === rid);
  ok('暂停后规则仍在列表里（不是删除）', !!afterRule, `n=${(Array.isArray(afterList) ? afterList : afterList?.items || []).length}`);
  ok(
    '暂停不清空其它字段',
    afterRule &&
      Number(afterRule.amount_cents) === 12345 &&
      afterRule.note === '房租测试' &&
      afterRule.freq === 'monthly' &&
      String(afterRule.next_run).slice(0, 10) === '2027-01-01' &&
      afterRule.ledger_id === lid &&
      afterRule.type === 'expense',
    JSON.stringify({ a: afterRule?.amount_cents, n: afterRule?.note, f: afterRule?.freq, nr: afterRule?.next_run, l: afterRule?.ledger_id, t: afterRule?.type }),
  );
  ok('暂停后 enabled = 0 且 due = false', Number(afterRule?.enabled) === 0 && afterRule?.due !== true, `enabled=${afterRule?.enabled} due=${afterRule?.due}`);
  ok('PATCH 前后 next_run 未变', beforeRule && String(beforeRule.next_run).slice(0, 10) === String(afterRule?.next_run).slice(0, 10), `${beforeRule?.next_run} → ${afterRule?.next_run}`);

  const txBefore = (await req('GET', `/transactions?ledger_id=${lid}&limit=500`, { token })).json;
  const nBefore = Array.isArray(txBefore) ? txBefore.length : txBefore?.total ?? 0;
  const run = await req('POST', '/recurring/run', { token, body: { ledger_id: lid, date: TODAY } });
  const madeRec = (run.json?.created || []).filter((c) => String(c.external_id || '').startsWith(`rec:${rid}:`));
  const txAfter = (await req('GET', `/transactions?ledger_id=${lid}&limit=500`, { token })).json;
  const nAfter = Array.isArray(txAfter) ? txAfter.length : txAfter?.total ?? 0;
  ok('暂停的规则补记不生成流水', madeRec.length === 0 && nAfter === nBefore, `rec=${madeRec.length} tx ${nBefore}→${nAfter}`);

  // 恢复后补记应能生成（证明开关是真生效，不是被写死）
  await req('PATCH', `/recurring/${rid}`, { token, body: { enabled: 1 } });
  const rule2 = await req('POST', '/recurring', {
    token,
    body: { ledger_id: lid, type: 'expense', amount_cents: 500, category_id: c1.id, account_id: cash?.id, note: '到期测试', freq: 'monthly', start_date: TODAY },
  });
  const run2 = await req('POST', '/recurring/run', { token, body: { ledger_id: lid, date: TODAY } });
  ok('启用且到期的规则能补记', (run2.json?.created || []).some((c) => String(c.external_id || '').startsWith(`rec:${rule2.json?.id}:`)), JSON.stringify(run2.json?.created?.map((c) => c.external_id)));
} catch (err) {
  ok('脚本执行未抛错', false, err.message + '\n' + serverLog.slice(-500));
} finally {
  child.kill();
  await sleep(200);
}

const passed = results.filter((r) => r.pass).length;
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`);
}
console.log(`\n${passed}/${results.length}`);
process.exit(passed === results.length ? 0 : 1);
