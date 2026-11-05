/* 服务器模式页面级复验（Lead 独立写，v1.2）
 * 用法：node tools/verify/cdp.mjs "http://127.0.0.1:8787/#/me/sync" out.png tools/verify/lead-server-mode.js
 * 前置：8787 上跑 1.2.0 后端，库里有 demo/demo1234 与 9 个账户。
 * 断言点：UI 登录拿 token → 切服务器模式 → 资产页净资产等于后端 totals.net_cents → 还款提醒来自 /accounts/reminders。
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const txt = (n) => (n ? (n.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const results = [];
  const ok = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail: String(detail) });
  const waitFor = async (fn, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = fn();
      if (v) return v;
      await sleep(80);
    }
    return null;
  };

  try {
    // 引导层会挡住点击
    $('#onboard')?.classList.remove('is-open');
    localStorage.setItem('mintlite:onboarded', '1');

    // 1) 直达云同步页
    location.hash = '#/me/sync';
    await sleep(400);
    ok('云同步页可打开', !!$('#sync-base'), txt($('#sync-base')?.parentElement));

    // 2) 填地址/账号密码 → 点登录
    $('#sync-base').value = location.origin;
    $('#sync-user').value = 'demo';
    $('#sync-pass').value = 'demo1234';
    $('[data-act="sync-login"]').click();
    const tokenShown = await waitFor(() => {
      const kv = $$('.kv').find((n) => /当前 token/.test(txt(n)));
      const v = txt(kv?.querySelector('b'));
      return v && v !== '无' ? v : null;
    }, 5000);
    ok('UI 登录拿到 token', !!tokenShown, tokenShown || txt($$('.kv').find((n) => /当前 token/.test(txt(n)))));

    // 3) 保存 baseUrl/username，防重渲染把输入框清掉
    $('[data-act="sync-save"]')?.click();
    await sleep(300);

    // 4) 切服务器模式（radio value=server）；模式落盘在 mintlite:settings
    const readMode = () => JSON.parse(localStorage.getItem('mintlite:settings') || '{}').mode || 'local';
    const radio = $$('[data-act="sync-mode"]').find((r) => r.value === 'server');
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(1500);
    ok('数据模式切到服务器', readMode() === 'server', `settings.mode=${readMode()}`);

    // 5) 资产页取后端数字
    location.hash = '#/assets';
    await sleep(1500);
    const shown = await waitFor(() => $('.bal-value'), 5000);
    const shownNet = txt(shown);
    const res = await fetch(`${location.origin}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'demo', password: 'demo1234' }),
    }).then((r) => r.json());
    const token = res.token;
    const ledgers = await fetch(`${location.origin}/api/v1/ledgers`, {
      headers: { authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    const lid = (ledgers.items || ledgers)[0].id;
    const acc = await fetch(`${location.origin}/api/v1/accounts?ledger_id=${lid}`, {
      headers: { authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    const netCents = Number(acc.totals?.net_cents);
    const want = (netCents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    ok('资产页净资产 = 后端 totals.net_cents', shownNet.replace(/,/g, '') === want.replace(/,/g, ''), `页面 ${shownNet} / 后端 ${want}`);

    // 6) 还款提醒来自 /accounts/reminders
    const rem = await fetch(`${location.origin}/api/v1/accounts/reminders?ledger_id=${lid}`, {
      headers: { authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    const remNodes = $$('.remind-item');
    ok('还款提醒条数与后端一致', remNodes.length === (rem.items || []).length, `页面 ${remNodes.length} / 后端 ${(rem.items || []).length}`);
    ok('提醒文案含后端账户名', rem.items?.[0] ? txt(remNodes[0]).includes(rem.items[0].name) : true, txt(remNodes[0]));

    // 7) 明细页行数（v1.2 每笔是 .tx-row，每日一个 .day-group）
    location.hash = '#/list';
    await sleep(2500);
    const rowNodes = await waitFor(() => ($$('.tx-row').length ? $$('.tx-row') : null), 6000);
    const rows = rowNodes ? rowNodes.length : 0;
    ok('明细页能渲染交易行', rows > 0, `rows=${rows} dayGroups=${$$('.day-group').length}`);

    // 8) 切回本地模式，避免把演示环境留在服务器模式
    location.hash = '#/me/sync';
    await sleep(400);
    const localRadio = $$('[data-act="sync-mode"]').find((r) => r.value === 'local');
    if (localRadio) {
      localRadio.checked = true;
      localRadio.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(800);
    }
    const back = $$('.kv').find((n) => /数据模式/.test(txt(n)));
    ok('可切回本地模式', readMode() === 'local', `settings.mode=${readMode()} ${txt(back)}`.trim());
  } catch (err) {
    ok('脚本执行无异常', false, err && err.message);
  }

  const passed = results.filter((r) => r.pass).length;
  return { passed, total: results.length, checks: results, hash: location.hash };
})();
