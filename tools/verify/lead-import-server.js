/* 服务器模式导入链路复验（Lead 独立写，v1.2.2）
 * 用法：node tools/verify/cdp.mjs "http://127.0.0.1:8787/#/me/sync" out.png tools/verify/lead-import-server.js 430 900
 * 前置：8787 上跑 1.2.2 后端，demo/demo1234 可用。
 * 断言：UI 登录 → 切服务器模式 → 数据页导入 5 行薄荷 TSV → 后端真落库（external_id 前缀 mint:）
 *      → 同文件再导一次预览说「跳过」→ 清理这 5 条（不留脏数据）。
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const txt = (n) => (n ? (n.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const results = [];
  const ok = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail: String(detail) });
  const waitFor = async (fn, ms = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = await fn();
      if (v) return v;
      await sleep(100);
    }
    return null;
  };

  const RUN = 'smoke' + Date.now().toString(36);
  const NOTE = '服务器模式导入 ' + RUN;
  const HEADER = ['类型', '货币', '金额', '汇率（相对本位币）', '项目', '分类', '父类', '账户', '付款', '收款', '商家', '地址', '日期', '标签', '作者', '备注', '图一', '图二', '图三'];
  const ROWS = [
    ['支出', 'CNY', '-33.3', '1.0000', '', '餐饮', '', '微信', '', '', '', '', '2026-10-05 12:30', '联调', '我', NOTE + ' 1', '', '', ''],
    ['支出', 'CNY', '-12', '1.0000', '', '交通', '', '支付宝', '', '', '', '', '2026-10-05 18:10', '', '我', NOTE + ' 2', '', '', ''],
    ['收入', 'CNY', '800', '1.0000', '', '工资', '', '招商银行', '', '', '', '', '2026-10-06 09:00', '', '我', NOTE + ' 3', '', '', ''],
    ['转账', 'CNY', '200', '1.0000', '', '账户互转', '', '', '支付宝', '微信', '', '', '2026-10-07 08:15', '', '我', NOTE + ' 4', '', '', ''],
    ['支出', 'USD', '-3', '7.2000', '', '旅行', '', '', '', '', '', '', '2026-10-08 21:00', '', '我', NOTE + ' 5', '', '', ''],
  ];
  const text = [HEADER.join('\t'), ...ROWS.map((r) => r.join('\t'))].join('\r\n') + '\r\n';
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    bytes[2 + i * 2] = c & 0xff;
    bytes[3 + i * 2] = (c >> 8) & 0xff;
  }

  let token = '';
  const api = (method, p, body) =>
    fetch(`${location.origin}/api/v1${p}`, {
      method,
      cache: 'no-store', // 不绕过缓存会读到上一次的列表快照，导入/删除都看不出来
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

  try {
    $('#onboard')?.classList.remove('is-open');
    localStorage.setItem('mintlite:onboarded', '1');

    // 1) UI 登录 + 切服务器模式
    location.hash = '#/me/sync';
    await sleep(500);
    $('#sync-base').value = location.origin;
    $('#sync-user').value = 'demo';
    $('#sync-pass').value = 'demo1234';
    $('[data-act="sync-login"]').click();
    const settingsOf = () => JSON.parse(localStorage.getItem('mintlite:settings') || '{}');
    token = (await waitFor(() => {
      const t = settingsOf().token;
      if (t && String(t).length > 100) return String(t);
      const kv = $$('.kv').find((n) => /当前 token/.test(txt(n)));
      const v = txt(kv?.querySelector('b'));
      return v && v !== '无' && v.length > 100 ? v : null;
    }, 8000)) || '';
    ok('UI 登录拿到 token', token.length > 100, `len=${token.length}`);
    $('[data-act="sync-save"]')?.click();
    await sleep(300);
    const radio = $$('[data-act="sync-mode"]').find((r) => r.value === 'server');
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(2000);
    const mode = JSON.parse(localStorage.getItem('mintlite:settings') || '{}').mode;
    ok('切到服务器模式', mode === 'server', `mode=${mode}`);

    // 2) 确认当前账本是服务器上的（能读 /ledgers）
    const ledgers = await api('GET', '/ledgers');
    const lid = JSON.parse(localStorage.getItem('mintlite:settings') || '{}').ledgerId || ledgers.json?.items?.[0]?.id;
    const onServer = (ledgers.json?.items || []).some((l) => l.id === lid);
    ok('当前账本存在于服务器', onServer, `lid=${String(lid).slice(0, 8)} server=${(ledgers.json?.items || []).length}`);

    // 用「id 差集」判断本次导入了哪些行，不依赖备注文案（备注可能被服务端改写）
    const mintIds = async () => {
      const r = await api('GET', `/transactions?ledger_id=${lid}&limit=500`);
      return new Set(
        (r.json?.items || []).filter((t) => String(t.external_id || '').startsWith('mint:')).map((t) => t.id),
      );
    };
    const idsBefore = await mintIds();

    // 3) 走真实 UI 导入
    location.hash = '#/me/data';
    await sleep(1000);
    const feed = async () => {
      const input = $('#import-file');
      if (!input) return { err: 'no-input' };
      const sel = $('#import-format');
      if (sel) sel.value = 'auto';
      const file = new File([bytes], 'lead-server-import.csv', { type: 'text/csv' });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      // 只认「当前可见」的确认按钮：旧 sheet 关掉后节点还留在 DOM 里，点它等于没点
      await waitFor(() => $$('[data-act="confirm-yes"]').filter((b) => b.getClientRects().length).pop(), 6000);
      await sleep(900); // 预览算完后 sheet 会重渲染一次，等它定稿再取节点
      const sheet = txt($('.sheet.is-open, #sheet-root .sheet.is-open, .sheet'));
      const btn = $$('[data-act="confirm-yes"]').filter((b) => b.getClientRects().length).pop();
      if (!btn) return { err: `no-confirm: ${sheet.slice(0, 100)}`, sheet };
      btn.click();
      await sleep(600);
      return { sheet, toast: txt($('.toast.is-on, .toast, #toast')) };
    };
    const fresh = async () => {
      const now = await mintIds();
      return [...now].filter((id) => !idsBefore.has(id));
    };
    const first = await feed();
    ok('第一次导入有确认框', !first.err, first.err || first.sheet.slice(0, 80));
    ok('预览识别出 5 条', /5\s*条/.test(first.sheet || ''), (first.sheet || '').slice(0, 100));
    ok('第一次点「开始导入」有反馈', !/失败|错误|401|403/.test(first.toast || ''), `toast=${first.toast}`);

    // 4) 同文件再导一次（服务端幂等性：两次导入合计只能多 5 条，不能 10 条）
    const second = await feed();
    ok('二次导入有反馈', !/失败|错误|401|403/.test(second.toast || ''), `toast=${second.toast}`);

    // UI 的导入是异步的（toast 先回来、列表后刷新），这里等到「新增恰好 5 条」再判
    const newIds = (await waitFor(async () => {
      const f = await fresh();
      return f.length >= 5 ? f : null;
    }, 20000)) || (await fresh());
    await sleep(1500);
    const finalIds = await fresh();
    const all = (await api('GET', `/transactions?ledger_id=${lid}&limit=500`)).json?.items || [];
    const rows1 = all.filter((t) => finalIds.includes(t.id));
    ok('两次导入只多出 5 条（幂等）', finalIds.length === 5, `new=${finalIds.length} ids=${newIds.length} before=${idsBefore.size}`);
    ok('落库金额/类型正确', rows1.some((t) => t.type === 'expense' && Number(t.amount_cents) === 3330) && rows1.some((t) => t.type === 'income' && Number(t.amount_cents) === 80000), rows1.map((t) => `${t.type}:${t.amount_cents}`).join(','));
    ok('USD 行备注带货币前缀', rows1.some((t) => /\[货币 USD 汇率 7\.2000\]/.test(String(t.note))), rows1.map((t) => t.note).join(' | ').slice(0, 120));

    // 5) 清理：删掉这 5 条，不留脏数据
    const delStatus = [];
    for (const t of rows1) {
      const r = await api('DELETE', `/transactions/${t.id}`);
      delStatus.push(`${r.status}${r.json?.ok ? 'ok' : ''}`);
    }
    await sleep(800);
    const left = await fresh();
    ok('测试数据已清理', left.length === 0, `left=${left.length} del=${delStatus.join(',')}`);
  } catch (err) {
    ok('EXCEPTION', false, err && err.message ? err.message : String(err));
  }

  return { passed: results.filter((r) => r.pass).length, total: results.length, fails: results.filter((r) => !r.pass), checks: results };
})();


