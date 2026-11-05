// 独立复核 v1.2.2 薄荷记账导入/导出（Lead 自己写，不采信队友自报）
// 用法: node tools/verify/api-mint.mjs
//   依赖: tools/verify/fixtures/mint-sample.tsv（薄荷记账导出的原始字节：UTF-16LE + BOM、TAB 分隔）
//        也可用 MINT_SAMPLE=/path/to/export.csv 指定别的样本
//   自起服务: PORT=8803 + 独立临时库，不碰 server/data/mintlite.db
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 8803;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const SAMPLE = process.env.MINT_SAMPLE || path.join(ROOT, 'tools', 'verify', 'fixtures', 'mint-sample.tsv');
const DB = path.join(ROOT, '.tmp', 'v122-lead.db');

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fails.push(name);
    console.log(`  FAIL ${name}  ${detail}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return await res.json();
    } catch {
      /* not up */
    }
    await sleep(100);
  }
  throw new Error('server never came up');
}

let token = '';
async function api(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, raw: text };
}

function decodeUtf16(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  return buf.toString('utf8');
}

fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true });

const child = spawn(process.execPath, [path.join(ROOT, 'server', 'src', 'server.js')], {
  cwd: path.join(ROOT, 'server'),
  env: { ...process.env, PORT: String(PORT), DB_PATH: DB, HOST: '127.0.0.1' },
  stdio: 'ignore',
});

try {
  const health = await waitHealth();
  ok('服务启动 /health', health.ok === true, `version=${health.version}`);
  ok('/health 版本形如 1.x.y', /^1\.\d+\.\d+$/.test(String(health.version)), health.version);

  const login = await api('POST', '/auth/login', { username: 'demo', password: 'demo1234' });
  token = login.data?.token || '';
  ok('登录拿到 token', login.status === 200 && token.length > 100, `len=${token.length}`);

  const led = await api('POST', '/ledgers', { name: '薄荷导入' });
  const lid = led.data?.item?.id || led.data?.id;
  ok('新建账本', Boolean(lid), lid || JSON.stringify(led.data).slice(0, 80));

  const buf = fs.readFileSync(SAMPLE);
  ok('样本是 UTF-16LE + BOM', buf[0] === 0xff && buf[1] === 0xfe, `bytes=${buf.length}`);
  const text = decodeUtf16(buf);
  const srcLines = text.split(/\r?\n/).filter((l) => l.trim());
  ok('样本行数 = 2557（表头 + 2556）', srcLines.length === 2557, String(srcLines.length));

  // 1) 首次导入（auto 识别）
  const imp1 = await api('POST', '/import', { ledger_id: lid, format: 'auto', data: text });
  const r1 = imp1.data || {};
  ok('首次导入 status=200', imp1.status === 200, String(imp1.status));
  ok('识别为 mint', r1.format === 'mint', String(r1.format));
  ok('首次 created=2556', r1.created === 2556, `created=${r1.created} skipped=${r1.skipped}`);
  ok('首次 skipped=0', (r1.skipped || 0) === 0, String(r1.skipped));
  ok('新建成员 2（萱萱/Jake）', r1.members_created === 2, String(r1.members_created));

  // 2) 幂等
  const imp2 = await api('POST', '/import', { ledger_id: lid, format: 'auto', data: text });
  ok('二次导入 created=0', (imp2.data?.created || 0) === 0, JSON.stringify(imp2.data?.created));
  ok('二次导入 skipped=2556', (imp2.data?.skipped || 0) === 2556, String(imp2.data?.skipped));

  // 3) 落库口径
  const exp = await api('GET', `/transactions?ledger_id=${lid}&type=expense&limit=1`);
  ok('支出 2385 条', exp.data?.total === 2385, `total=${exp.data?.total}`);
  const inc = await api('GET', `/transactions?ledger_id=${lid}&type=income&limit=1`);
  ok('收入 132 条', inc.data?.total === 132, `total=${inc.data?.total}`);
  const tra = await api('GET', `/transactions?ledger_id=${lid}&type=transfer&limit=1`);
  ok('转账 39 条', tra.data?.total === 39, `total=${tra.data?.total}`);

  const mem = await api('GET', `/members?ledger_id=${lid}`);
  const memItems = mem.data?.items || mem.data || [];
  const names = memItems.map((m) => m.name).sort();
  ok('成员含 萱萱 与 Jake', names.includes('萱萱') && names.includes('Jake'), names.join(','));

  const acc = await api('GET', `/accounts?ledger_id=${lid}`);
  const accItems = acc.data?.items || [];
  const unset = accItems.find((a) => a.name === '未指定');
  ok('存在「未指定」账户', Boolean(unset), unset ? `id=${unset.id}` : 'missing');
  ok('「未指定」不计入净值', unset ? Number(unset.include_in_net) === 0 : false, String(unset?.include_in_net));

  // 4) 金额/日期/成员抽查：直接从样本里取第一条「支出」行做对照，不写死数字
  const header = srcLines[0].split('\t');
  const idx = (name) => header.indexOf(name);
  const sampleRow = srcLines
    .slice(1)
    .map((l) => l.split('\t'))
    .find((c) => c[idx('类型')] === '支出');
  const sAmt = Math.round(Math.abs(Number(sampleRow[idx('金额')])) * 100);
  const sDate = sampleRow[idx('日期')];
  const sCat = sampleRow[idx('分类')];
  const sAuthor = sampleRow[idx('作者')];
  ok('样本第一条支出可解析', Number.isFinite(sAmt) && sAmt > 0 && /^\d{4}-\d{2}-\d{2}/.test(sDate), `${sAmt} ${sDate} ${sCat} ${sAuthor}`);

  // 搜索按分类名命中（v1.2.2 起 q 也匹配分类/账户/成员/标签名）
  const one = await api('GET', `/transactions?ledger_id=${lid}&q=${encodeURIComponent(sCat)}&limit=400`);
  const items = one.data?.items || [];
  ok(`按分类名搜「${sCat}」有结果`, items.length > 0, `hits=${items.length}`);
  const hit = items.find(
    (t) => Number(t.amount_cents) === sAmt && String(t.happened_at).startsWith(sDate) && t.member_name === sAuthor,
  );
  ok('抽查金额/日期/成员与样本一致', Boolean(hit), hit ? `${hit.amount_cents} ${hit.happened_at} ${hit.member_name}` : `${sAmt} ${sDate} ${sAuthor}`);
  ok('抽查分类名正确', hit ? hit.category_name === sCat : false, String(hit?.category_name));
  ok('抽查日期保留时分', hit ? /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(String(hit.happened_at)) : false, String(hit?.happened_at));

  // 5) dry_run：必须落在「全新账本」上，否则每行都算重复，created 天然是 0
  const led3 = await api('POST', '/ledgers', { name: '薄荷预演' });
  const lid3 = led3.data?.item?.id || led3.data?.id;
  const dry = await api('POST', '/import', { ledger_id: lid3, format: 'auto', data: text, dry_run: true });
  ok('dry_run 报告 2556 条', dry.data?.created === 2556, String(dry.data?.created));
  const afterDry = (await api('GET', `/transactions?ledger_id=${lid3}&limit=1`)).data?.total;
  ok('dry_run 未落库', afterDry === 0, `total=${afterDry}`);

  // 6) 导出 mint
  const expMint = await fetch(`${BASE}/export?ledger_id=${lid}&format=mint`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const mintBuf = Buffer.from(await expMint.arrayBuffer());
  ok('导出 mint 首两字节 FF FE', mintBuf[0] === 0xff && mintBuf[1] === 0xfe, `${mintBuf[0]?.toString(16)} ${mintBuf[1]?.toString(16)}`);
  ok('导出 mint Content-Type 含 utf-16le', /utf-16le/i.test(expMint.headers.get('content-type') || ''), expMint.headers.get('content-type'));
  const mintText = mintBuf.subarray(2).toString('utf16le');
  const mintLines = mintText.split('\r\n').filter((l) => l.trim());
  ok('导出行数 = 2557', mintLines.length === 2557, String(mintLines.length));
  const cols = mintLines.map((l) => l.split('\t').length);
  ok('每行 19 列', cols.every((c) => c === 19), `distinct=${[...new Set(cols)].join(',')}`);
  ok('表头与薄荷一致', mintLines[0].startsWith('类型\t货币\t金额\t汇率（相对本位币）\t项目\t分类'), mintLines[0].slice(0, 40));
  const firstExpense = mintLines.find((l) => l.startsWith('支出\t'));
  const f = firstExpense ? firstExpense.split('\t') : [];
  ok('支出行金额为负', firstExpense ? f[2].startsWith('-') : false, f[2]);

  // 7) 回导到新账本
  const led2 = await api('POST', '/ledgers', { name: '薄荷回导' });
  const lid2 = led2.data?.item?.id || led2.data?.id;
  const back = await api('POST', '/import', { ledger_id: lid2, format: 'auto', data: mintText });
  ok('mint 导出可原样回导 2556 条', back.data?.created === 2556, JSON.stringify({ created: back.data?.created, format: back.data?.format }));

  const sum1 = await api('GET', `/stats/summary?ledger_id=${lid}`);
  const sum2 = await api('GET', `/stats/summary?ledger_id=${lid2}`);
  const pick = (s) => `${s.data?.expense_cents ?? s.data?.expense}/${s.data?.income_cents ?? s.data?.income}`;
  ok('两账本收支合计一致', pick(sum1) === pick(sum2), `${pick(sum1)} vs ${pick(sum2)}`);

  // 8) 默认导出仍是 CSV
  const expCsv = await fetch(`${BASE}/export?ledger_id=${lid}`, { headers: { Authorization: `Bearer ${token}` } });
  const csvBuf = Buffer.from(await expCsv.arrayBuffer());
  ok('默认导出为 CSV（UTF-8 BOM）', csvBuf[0] === 0xef && csvBuf[1] === 0xbb, `${csvBuf[0]?.toString(16)} ${csvBuf[1]?.toString(16)}`);

  // 9) 非法 format
  const bad = await api('GET', `/export?ledger_id=${lid}&format=xlsx`);
  ok('非法 format → 400', bad.status === 400, String(bad.status));
} catch (err) {
  fails.push(`EXCEPTION ${err.message}`);
  console.log('EXCEPTION', err.stack);
} finally {
  child.kill();
  await sleep(400);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true });
}

console.log(`\nPASS ${pass}/${pass + fails.length}`);
if (fails.length) {
  console.log('FAILED:', JSON.stringify(fails, null, 2));
  process.exit(1);
}
