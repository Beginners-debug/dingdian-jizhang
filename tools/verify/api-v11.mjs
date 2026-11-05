// 独立复核 v1.1 新增接口（对 8787 上正在跑的实例；只读 + 幂等的 recurring/run）
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) pass += 1;
  else fails.push(`${name} :: ${detail}`);
};
const j = async (path, opts = {}) => {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
};

const login = await j('/api/v1/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'demo', password: 'demo1234' }),
});
ok('login 200', login.status === 200, login.status);
const token = login.body.token;
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
ok('token 非空', typeof token === 'string' && token.length > 60, String(token).length);

const ledgers = await j('/api/v1/ledgers', { headers: H });
ok('ledgers 200', ledgers.status === 200);
const lid = ledgers.body.items[0].id;
const L = `ledger_id=${lid}`;
const R = 'from=2026-11-01&to=2026-11-30';

const ov = await j(`/api/v1/stats/overview?${L}&${R}`, { headers: H });
ok('overview 200', ov.status === 200, ov.status);
ok(
  'overview 字段齐',
  ['income_cents', 'expense_cents', 'net_cents', 'avg_expense_cents', 'max_expense_cents', 'count', 'days'].every(
    (k) => k in ov.body,
  ),
  Object.keys(ov.body).join(','),
);
ok('overview 净额自洽', ov.body.net_cents === ov.body.income_cents - ov.body.expense_cents, JSON.stringify(ov.body));

const cmp = await j(`/api/v1/stats/compare?${L}&${R}`, { headers: H });
ok('compare 200', cmp.status === 200, cmp.status);
const cmpKeys = Object.keys(cmp.body || {}).join(',');
ok('compare 有 current/previous/delta', !!(cmp.body.current && cmp.body.previous && cmp.body.delta), cmpKeys);
const pct = cmp.body.delta && cmp.body.delta.expense_pct;
ok('compare pct 是比率（|x|<100 或 null）', pct == null || Math.abs(pct) < 100, String(pct));

const cal = await j(`/api/v1/stats/calendar?${L}&month=2026-11`, { headers: H });
ok('calendar 200 且是数组', cal.status === 200 && Array.isArray(cal.body), `${cal.status} ${typeof cal.body}`);
ok(
  'calendar 每项有 date/expense_cents',
  Array.isArray(cal.body) && cal.body.every((d) => 'date' in d && 'expense_cents' in d),
  JSON.stringify(cal.body && cal.body[0]),
);

const byAcc = await j(`/api/v1/stats/by-account?${L}&${R}&kind=expense`, { headers: H });
ok('by-account 200 且是数组', byAcc.status === 200 && Array.isArray(byAcc.body), String(byAcc.status));

const byTag = await j(`/api/v1/stats/by-tag?${L}&${R}`, { headers: H });
ok('by-tag 200 且是数组', byTag.status === 200 && Array.isArray(byTag.body), String(byTag.status));

const acc = await j(`/api/v1/accounts?${L}`, { headers: H });
ok('accounts 是 {items,totals}', !!(acc.body.items && acc.body.totals), Object.keys(acc.body || {}).join(','));
ok(
  'net = asset - liability',
  acc.body.totals.net_cents === acc.body.totals.asset_cents - acc.body.totals.liability_cents,
  JSON.stringify(acc.body.totals),
);
ok(
  '有信用账户带额度',
  acc.body.items.some((a) => a.type === 'credit' && a.credit_limit_cents > 0),
  acc.body.items.map((a) => `${a.type}:${a.credit_limit_cents || 0}`).join(' '),
);
ok(
  '账户有 kind 字段',
  acc.body.items.every((a) => a.kind === 'asset' || a.kind === 'liability'),
  acc.body.items.map((a) => a.kind).join(','),
);

const bud = await j(`/api/v1/budgets?${L}&month=2026-11`, { headers: H });
const budList = Array.isArray(bud.body) ? bud.body : bud.body.items;
ok('budgets 200', bud.status === 200, bud.status);
ok(
  'budget 有 available_cents/carry_in_cents',
  Array.isArray(budList) && budList.every((b) => 'available_cents' in b && 'carry_in_cents' in b),
  JSON.stringify((budList && budList[0]) || {}).slice(0, 160),
);

const rec = await j(`/api/v1/recurring?${L}`, { headers: H });
const recList = Array.isArray(rec.body) ? rec.body : rec.body.items;
ok('recurring 200', rec.status === 200, rec.status);
ok('recurring 有 next_run', Array.isArray(recList) && recList.every((r) => 'next_run' in r), String((recList || []).length));

const run = await j(`/api/v1/recurring/run?${L}`, { method: 'POST', headers: H, body: '{}' });
ok('recurring/run 200', run.status === 200, run.status);
ok('run 返回 created 数组', Array.isArray(run.body.created), JSON.stringify(run.body).slice(0, 160));
const run2 = await j(`/api/v1/recurring/run?${L}`, { method: 'POST', headers: H, body: '{}' });
ok('重复补记幂等', run2.status === 200 && Array.isArray(run2.body.created) && run2.body.created.length === 0, JSON.stringify(run2.body.created));

const tags = await j(`/api/v1/tags?${L}`, { headers: H });
ok('tags 200', tags.status === 200, tags.status);

const reimb = await j(`/api/v1/stats/reimburse?${L}`, { headers: H });
ok('stats/reimburse 200', reimb.status === 200, reimb.status);

const health = await j('/health');
ok('health 200 且 version 是 1.x', health.status === 200 && /^1\.\d+\.\d+$/.test(String(health.body.version)), JSON.stringify(health.body));

console.log(`PASS ${pass}/${pass + fails.length}`);
if (fails.length) {
  console.log('FAILS:');
  for (const f of fails) console.log(' - ' + f);
  process.exit(1);
}
