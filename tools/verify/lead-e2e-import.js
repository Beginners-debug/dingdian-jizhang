// v1.2.2 前端独立复验：导入/导出格式（默认 CSV）+ 薄荷记账兼容
// 用法: node tools/verify/cdp.mjs "http://127.0.0.1:8787/" .tmp/import.png tools/verify/lead-e2e-import.js 430 900
(async () => {
  const checks = [];
  const ok = (name, cond, detail) => checks.push({ name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const go = async (h, ms = 800) => {
    location.hash = h;
    await wait(ms);
  };
  const tap = async (node, ms = 300) => {
    if (node) node.click();
    await wait(ms);
  };
  const txt = (n) => (n ? n.textContent.trim() : '');

  // 引导层可能挡着，先关掉
  const ob = $('#onboard');
  if (ob) ob.classList.remove('is-open');

  // ---------------------------------------------------------------- 造一份 UTF-16LE 薄荷样本
  const HEADER = ['类型', '货币', '金额', '汇率（相对本位币）', '项目', '分类', '父类', '账户', '付款', '收款', '商家', '地址', '日期', '标签', '作者', '备注', '图一', '图二', '图三'];
  const ROWS = [
    ['支出', 'CNY', '-12.5', '1.0000', '', '餐饮', '', '微信', '', '', '', '', '2026-11-01 12:30', '午饭,同事', '萱萱', '', '', '', ''],
    ['收入', 'CNY', '3500', '1.0000', '', '工资', '', '支付宝', '', '', '', '', '2026-11-01 09:00', '', 'Jake', '十月工资', '', '', ''],
    ['转账', 'CNY', '500', '1.0000', '', '账户互转', '', '', '支付宝', '微信', '', '', '2026-11-02 08:15', '', 'Jake', '挪点钱', '', '', ''],
    ['支出', 'CNY', '-8', '1.0000', '', '零食', '', '', '', '', '', '', '2026-11-02 15:00', '', '萱萱', '楼下便利店', '', '', ''],
    ['支出', 'USD', '-2', '7.2000', '', '旅行', '', '', '', '', '', '', '2026-11-03 21:00', '', 'Jake', '咖啡', '', '', ''],
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

  const storeMod = await import('./js/store.js');
  const store = storeMod.store;
  const settings = storeMod.getSettings();
  const ledgerId = settings.ledgerId || (await store.listLedgers())[0].id;

  const counts = async () => {
    const { items } = await store.listTransactions({ ledger_id: ledgerId, limit: 5000 });
    const byType = items.reduce((a, t) => {
      a[t.type] = (a[t.type] || 0) + 1;
      return a;
    }, {});
    return { total: items.length, byType, items };
  };
  const before = await counts();

  // ---------------------------------------------------------------- 走真实 UI 导入
  const feed = async () => {
    await go('#/me/data', 900);
    const input = $('#import-file');
    if (!input) return 'no-input';
    const sel = $('#import-format');
    if (sel) sel.value = 'auto';
    const file = new File([bytes], 'mint-sample.csv', { type: 'text/csv' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(1200);
    // 预览确认框
    const confirmBtn = $('.confirm-actions [data-act="confirm-yes"], [data-act="confirm-yes"]');
    const sheetText = txt($('.sheet, .confirm-box, #sheet-root'));
    if (!confirmBtn) return `no-confirm: ${sheetText.slice(0, 120)}`;
    await tap(confirmBtn, 1600);
    return sheetText.slice(0, 160);
  };

  const preview1 = await feed();
  const after1 = await counts();
  const added1 = after1.total - before.total;
  ok('导入薄荷样本：5 条全部落库', added1 === 5, `added=${added1} preview=${preview1}`);
  ok(
    '导入后类型分布 = 支出3 / 收入1 / 转账1',
    after1.byType.expense - (before.byType.expense || 0) === 3 &&
      after1.byType.income - (before.byType.income || 0) === 1 &&
      after1.byType.transfer - (before.byType.transfer || 0) === 1,
    JSON.stringify(after1.byType),
  );

  // 幂等：同一文件再导一次
  const preview2 = await feed();
  const after2 = await counts();
  ok('同一文件再导一次新增 0 条（幂等）', after2.total === after1.total, `total ${after1.total} -> ${after2.total} preview=${preview2}`);

  const members = await store.listMembers(ledgerId);
  const names = members.map((m) => m.name);
  ok('成员出现 2 个（萱萱 / Jake）', names.includes('萱萱') && names.includes('Jake'), names.join(','));

  const assets = await store.listAssets(ledgerId);
  const unset = assets.items.find((a) => a.name === '未指定');
  ok(
    '「未指定」账户存在且不计入净值',
    !!unset && Number(unset.include_in_net) === 0 && unset.type === 'other',
    unset ? `type=${unset.type} include_in_net=${unset.include_in_net}` : 'missing',
  );

  const txs = (await store.listTransactions({ ledger_id: ledgerId, limit: 5000 })).items;
  const transfer = txs.find((t) => t.type === 'transfer' && Math.abs(t.amount_cents - 50000) < 1);
  ok(
    '转账只记两端账户、分类为空',
    !!transfer && !!transfer.account_id && !!transfer.to_account_id && transfer.category_id === null,
    transfer ? `cat=${transfer.category_id}` : 'missing',
  );
  const usd = txs.find((t) => t.note && t.note.includes('[货币 USD'));
  ok('非 CNY 备注带 [货币 USD 汇率 7.2000] 前缀', !!usd && /^\[货币 USD 汇率 7\.2000\]/.test(usd.note), usd ? usd.note : 'missing');
  const tagged = txs.find((t) => (t.tags || []).length >= 2);
  ok('标签按 , 拆成两个', !!tagged, tagged ? `${tagged.tags.length}` : 'missing');

  // ---------------------------------------------------------------- 导出：薄荷 / CSV
  const origCreate = URL.createObjectURL;
  const origClick = HTMLAnchorElement.prototype.click;
  let captured = null;
  URL.createObjectURL = (blob) => {
    captured = blob;
    return 'blob:captured';
  };
  HTMLAnchorElement.prototype.click = function noop() {};
  try {
    await go('#/me/data', 900);
    const sel = $('#export-format');
    if (sel) sel.value = 'mint';
    captured = null;
    await tap($('[data-act="export-run"]'), 900);
    const mintBytes = captured ? new Uint8Array(await captured.arrayBuffer()) : new Uint8Array();
    const isBom = mintBytes.length > 2 && mintBytes[0] === 0xff && mintBytes[1] === 0xfe;
    const mintText = isBom ? new TextDecoder('utf-16le').decode(mintBytes.subarray(2)) : '';
    const lines = mintText.split('\r\n').filter((l) => l.length);
    const colCounts = [...new Set(lines.slice(1).map((l) => l.split('\t').length))];
    ok('导出薄荷：字节以 FF FE 开头（UTF-16LE + BOM）', isBom, `len=${mintBytes.length}`);
    ok('导出薄荷：每行 19 列（TAB 分隔）', lines.length > 1 && colCounts.length === 1 && colCounts[0] === 19, `cols=${colCounts.join('/')} rows=${lines.length - 1}`);
    ok('导出薄荷：表头首列是「类型」', lines[0] && lines[0].split('\t')[0] === '类型', lines[0] ? lines[0].slice(0, 20) : '');

    const sel2 = $('#export-format');
    if (sel2) sel2.value = 'csv';
    captured = null;
    await tap($('[data-act="export-run"]'), 900);
    const csvBytes = captured ? new Uint8Array(await captured.arrayBuffer()) : new Uint8Array();
    const csvBom = csvBytes.length > 3 && csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf;
    const csvText = csvBom ? new TextDecoder('utf-8').decode(csvBytes.subarray(3)) : '';
    const csvHeader = csvText.split('\r\n')[0] || '';
    ok('导出 CSV（默认格式）：UTF-8 BOM + 逗号分隔', csvBom && csvHeader.includes(','), `head=${csvHeader.slice(0, 40)}`);
    ok(
      '导出下拉默认值是 CSV',
      (await (async () => {
        await go('#/me/data', 700);
        const s = $('#export-format');
        return s ? s.value : '';
      })()) === 'csv',
      'default=select#export-format',
    );
  } finally {
    URL.createObjectURL = origCreate;
    HTMLAnchorElement.prototype.click = origClick;
  }

  const passed = checks.filter((c) => c.pass).length;
  return { passed, total: checks.length, viewport: `${window.innerWidth}×${window.innerHeight}`, checks, hash: location.hash };
})();
