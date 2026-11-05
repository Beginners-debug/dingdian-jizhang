const BASE = 'http://127.0.0.1:8787';
const j = async (m, p, b, t) => {
  const r = await fetch(BASE + p, {
    method: m,
    headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) },
    body: b === undefined ? undefined : JSON.stringify(b),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const t = (await j('POST', '/api/v1/auth/login', { username: 'demo', password: 'demo1234' })).json.token;
const lid = (await j('GET', '/api/v1/ledgers', undefined, t)).json.items[0].id;
const targets = [
  ['/accounts', '招商银行'],
  ['/accounts', '未指定'],
  ['/tags', '联调'],
  ['/categories', '旅行'],
];
for (const [path, name] of targets) {
  const list = await j('GET', `/api/v1${path}?ledger_id=${lid}`, undefined, t);
  const items = list.json?.items || list.json || [];
  const hit = items.find((x) => x.name === name);
  if (!hit) {
    console.log('skip', path, name);
    continue;
  }
  const d = await j('DELETE', `/api/v1${path}/${hit.id}?ledger_id=${lid}`, undefined, t);
  console.log('delete', path, name, '→', d.status, JSON.stringify(d.json));
}
const acc = (await j('GET', `/api/v1/accounts?ledger_id=${lid}`, undefined, t)).json;
console.log('accounts now', acc.total, 'net', acc.totals.net_cents);
