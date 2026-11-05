// v1.2 接口独立复验（按 docs/CONTRACT-v1.2.md §5 写，不看实现）
// 用法: node tools/verify/api-v12.mjs
// 自带服务：PORT=8801、DB_PATH=.tmp/api-v12.db（每次先删库，保证从种子起跑）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 以脚本位置为基准，不依赖调用时的 cwd
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PORT) || 8801;
const DB = path.join(ROOT, '.tmp', 'api-v12.db');
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const TODAY = new Date().toISOString().slice(0, 10);

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
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
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

try {
  const health = await waitUp();
  ok('health.version 形如 1.x.y', /^1\.\d+\.\d+$/.test(String(health.version)), health.version);

  const login = await req('POST', '/auth/login', { body: { username: 'demo', password: 'demo1234' } });
  ok('login 200 且有 token', login.status === 200 && !!login.json?.token, login.status);
  const token = login.json?.token;

  const leds = await req('GET', '/ledgers', { token });
  const ledgers = leds.json?.items || leds.json || [];
  ok('GET /ledgers 至少 1 本', Array.isArray(ledgers) && ledgers.length >= 1, `n=${ledgers?.length}`);
  const ledgerId = ledgers[0]?.id;
  const q = `?ledger_id=${ledgerId}`;

  // ---- accounts
  const acc = await req('GET', `/accounts${q}`, { token });
  const items = acc.json?.items || [];
  ok('GET /accounts 返回 {items,totals,groups}', !!acc.json?.items && !!acc.json?.totals && Array.isArray(acc.json?.groups), Object.keys(acc.json || {}).join(','));
  ok('每个账户都带派生 group', items.length > 0 && items.every((a) => typeof a.group === 'string' && a.group), items.slice(0, 3).map((a) => a.group).join(','));
  ok('groups 覆盖出现过的组', acc.json?.groups?.length >= 3, (acc.json?.groups || []).map((g) => g.key).join(','));
  ok(
    'totals.net_cents = asset_cents - liability_cents',
    Number(acc.json?.totals?.net_cents) === Number(acc.json?.totals?.asset_cents) - Number(acc.json?.totals?.liability_cents),
    JSON.stringify(acc.json?.totals),
  );

  const created = await req('POST', '/accounts', {
    token,
    body: {
      id: 'acc-v12-credit',
      ledger_id: ledgerId,
      name: '白条测试',
      type: 'credit',
      initial_cents: 0,
      credit_limit_cents: 300000,
      bill_day: 5,
      repay_day: 20,
    },
  });
  ok('POST /accounts 建信用卡账户', created.status === 201 || created.status === 200, created.status + ' ' + created.text.slice(0, 120));

  const patched = await req('PATCH', '/accounts/acc-v12-credit', { token, body: { repay_day: 25, hidden: 1 } });
  ok('PATCH /accounts 改还款日/隐藏', patched.status === 200, patched.status + ' ' + patched.text.slice(0, 120));
  const reread = await req('GET', `/accounts${q}`, { token });
  const acc2 = (reread.json?.items || []).find((a) => a.id === 'acc-v12-credit');
  ok('回读 repay_day=25 & hidden=1', Number(acc2?.repay_day) === 25 && Number(acc2?.hidden) === 1, `repay_day=${acc2?.repay_day} hidden=${acc2?.hidden}`);
  await req('PATCH', '/accounts/acc-v12-credit', { token, body: { hidden: 0 } });

  // ---- members
  const mems = await req('GET', `/members${q}`, { token });
  const members = mems.json?.items || [];
  const self = members.find((m) => Number(m.is_self) === 1 || m.is_self === true);
  ok('每个账本有 is_self 成员', !!self, members.map((m) => m.name).join(','));

  const newMem = await req('POST', '/members', { token, body: { id: 'mem-v12-wife', ledger_id: ledgerId, name: '老婆', color: '#e0658a' } });
  ok('POST /members 新增成员', newMem.status === 201 || newMem.status === 200, newMem.status);
  const delSelf = await req('DELETE', `/members/${self?.id}`, { token });
  ok('删除 is_self 成员 → 409', delSelf.status === 409, delSelf.status);

  // ---- 交易带 member_id
  const cats = await req('GET', `/categories${q}`, { token });
  const catItems = cats.json?.items || cats.json || [];
  const expenseCat = catItems.find((c) => c.kind === 'expense');
  const tx = await req('POST', '/transactions', {
    token,
    body: {
      id: 'tx-v12-member',
      ledger_id: ledgerId,
      type: 'expense',
      amount_cents: 50000,
      category_id: expenseCat?.id,
      account_id: 'acc-v12-credit',
      member_id: 'mem-v12-wife',
      note: '成员维度测试',
      happened_at: TODAY,
    },
  });
  ok('POST /transactions 带 member_id', tx.status === 201, tx.status + ' ' + tx.text.slice(0, 140));
  ok('返回出参带 member_name=老婆', tx.json?.item?.member_name === '老婆', tx.json?.item?.member_name);

  const listMine = await req('GET', `/transactions${q}&member_id=mem-v12-wife`, { token });
  const listItems = listMine.json?.items || [];
  ok('列表按 member_id 过滤', listItems.length === 1 && listItems[0].id === 'tx-v12-member', `n=${listItems.length}`);

  // ---- 提醒
  const rem = await req('GET', `/accounts/reminders${q}`, { token });
  const remItems = rem.json?.items || [];
  const mine = remItems.find((r) => r.account_id === 'acc-v12-credit');
  ok('reminders 里有欠款的信用卡', !!mine, remItems.map((r) => r.name).join(','));
  ok(
    'reminders 字段齐全（due_date/days_left/status）',
    !!mine && !!mine.due_date && Number.isFinite(Number(mine.days_left)) && ['overdue', 'today', 'soon', 'later'].includes(mine.status),
    mine ? `${mine.due_date} ${mine.days_left} ${mine.status}` : '',
  );
  ok('reminders 只含负债类', remItems.every((r) => !r.kind || r.kind === 'liability' || Number(r.used_cents) > 0), `n=${remItems.length}`);

  // ---- 统计
  const from = `${TODAY.slice(0, 8)}01`;
  const byMember = await req('GET', `/stats/by-member${q}&from=${from}&to=${TODAY}`, { token });
  const arr = Array.isArray(byMember.json) ? byMember.json : byMember.json?.items;
  ok('by-member 是裸数组', Array.isArray(byMember.json), typeof byMember.json);
  const wife = (arr || []).find((r) => r.member_id === 'mem-v12-wife');
  ok('by-member 里老婆有支出 50000', Number(wife?.expense_cents) === 50000, JSON.stringify(wife));

  const ov = await req('GET', `/stats/overview${q}&from=${from}&to=${TODAY}`, { token });
  const sumExpense = (arr || []).reduce((s, r) => s + Number(r.expense_cents || 0), 0);
  ok(
    'by-member 支出合计 = overview.expense_cents',
    sumExpense === Number(ov.json?.expense_cents),
    `${sumExpense} vs ${ov.json?.expense_cents}`,
  );
  ok('overview 带 by_member_top', Array.isArray(ov.json?.by_member_top), JSON.stringify(ov.json?.by_member_top)?.slice(0, 120));

  const monthly = await req('GET', `/stats/monthly${q}&months=12`, { token });
  const mArr = Array.isArray(monthly.json) ? monthly.json : monthly.json?.items;
  ok('monthly 是裸数组且长度 12', Array.isArray(monthly.json) && mArr.length === 12, `${Array.isArray(monthly.json)} n=${mArr?.length}`);
  const sorted = (mArr || []).map((m) => m.month);
  ok('monthly 按月份升序', JSON.stringify(sorted) === JSON.stringify([...sorted].sort()), sorted.join(','));
  ok(
    'monthly 每项有 expense/income 数字',
    (mArr || []).every((m) => Number.isFinite(Number(m.expense_cents)) && Number.isFinite(Number(m.income_cents))),
    JSON.stringify(mArr?.[0]),
  );

  // ---- 多账本
  const nb = await req('POST', '/ledgers', { token, body: { name: '测试账本', currency: 'CNY' } });
  ok('POST /ledgers 新建账本', nb.status === 201 || nb.status === 200, nb.status + ' ' + nb.text.slice(0, 120));
  const newId = nb.json?.item?.id || nb.json?.id;
  const afterNew = await req('GET', '/ledgers', { token });
  const afterItems = afterNew.json?.items || afterNew.json || [];
  ok('新账本出现在列表里', afterItems.some((l) => l.id === newId), `n=${afterItems.length}`);
  const delNew = await req('DELETE', `/ledgers/${newId}`, { token });
  ok('DELETE 非最后一个账本 → 2xx', delNew.status >= 200 && delNew.status < 300, delNew.status);

  // 删到只剩一本，再删应 409
  let cur = (await req('GET', '/ledgers', { token })).json?.items || [];
  while (cur.length > 1) {
    await req('DELETE', `/ledgers/${cur[cur.length - 1].id}`, { token });
    cur = (await req('GET', '/ledgers', { token })).json?.items || [];
  }
  const delLast = await req('DELETE', `/ledgers/${cur[0]?.id}`, { token });
  ok('删除最后一个账本 → 409', delLast.status === 409, delLast.status);
} catch (err) {
  ok('脚本执行未抛错', false, err.message);
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
