/* v1.3.2 前端独立复验：预算总开关（按 docs/CONTRACT-v1.3.2.md §4 写）
 * 用法: node tools/verify/cdp.mjs "http://127.0.0.1:8787/" .tmp/budget-switch.png tools/verify/lead-e2e-budget-switch.js 430 900
 * 本地模式（IndexedDB），每次 cdp 起独立 profile，所以是干净的种子库（种子账本 budget_enabled=0）。
 */
(async () => {
  const R = [];
  const ok = (name, cond, detail = '') => R.push({ name, pass: !!cond, detail: String(detail) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const txt = (n) => (n ? (n.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const visible = (n) => !!n && n.getClientRects().length > 0;
  async function waitFor(fn, timeout = 6000, step = 100) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        const v = await fn();
        if (v) return v;
      } catch {
        /* 继续等 */
      }
      await sleep(step);
    }
    return null;
  }
  const go = async (hash) => {
    location.hash = hash;
    await sleep(1000);
  };
  const idbAll = (storeName) =>
    new Promise((res) => {
      const req = indexedDB.open('mintlite');
      req.onsuccess = () => {
        const db = req.result;
        try {
          const all = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
          all.onsuccess = () => res(all.result || []);
          all.onerror = () => res([]);
        } catch {
          res([]);
        }
      };
      req.onerror = () => res([]);
    });
  const ledgerFlag = async () => {
    const rows = await idbAll('ledgers');
    const live = rows.filter((l) => !l.deleted_at);
    return live.length ? Number(live[0].budget_enabled || 0) : -1;
  };

  const errs = [];
  window.addEventListener('error', (e) => errs.push(String(e.message || e)));
  window.addEventListener('unhandledrejection', (e) => errs.push('reject:' + String((e.reason && e.reason.message) || e.reason)));

  localStorage.setItem('mintlite:onboarded', '1');
  document.getElementById('onboard')?.classList.remove('is-open');
  await waitFor(() => $('#tabbar'));
  await sleep(900);

  // ---------- 1. 默认关闭：明细页没有预算条 ----------
  await go('#/list');
  await waitFor(() => $('.tx-row') || $('.empty'), 8000);
  await sleep(1200);
  ok('默认关闭：明细页没有预算条', $$('[data-block="budget-strip"]').length === 0, `count=${$$('[data-block="budget-strip"]').length}`);
  ok('默认关闭：账本 budget_enabled = 0', (await ledgerFlag()) === 0, `flag=${await ledgerFlag()}`);

  // ---------- 2. 预算页显示「预算功能没开启」 ----------
  await go('#/me/budgets');
  const offCard = await waitFor(() => $('[data-block="budget-off"]'), 6000);
  ok('预算页出现「未开启」卡片', visible(offCard), offCard ? txt(offCard).slice(0, 40) : 'missing');
  ok('卡片文案说明会隐藏预算条', txt(offCard).includes('没开启') && txt(offCard).includes('明细页'), txt(offCard));
  ok('有「开启预算」按钮', visible($('[data-act="budget-enable-on"]')), txt($('[data-act="budget-enable-on"]')));
  ok('关闭态不渲染预算输入框', $$('[data-budget]').length === 0, `inputs=${$$('[data-budget]').length}`);
  ok('关闭态不渲染保存按钮', !visible($('[data-act="budget-save"]')), 'ok');

  // ---------- 3. 开启 ----------
  $('[data-act="budget-enable-on"]')?.click();
  const totalInput = await waitFor(() => $('[data-budget="total"]'), 6000);
  ok('开启后出现总预算输入框', visible(totalInput), totalInput ? `value=${totalInput.value}` : 'missing');
  ok('开启后未开启卡片消失', !visible($('[data-block="budget-off"]')), 'ok');
  ok('开启后账本 budget_enabled = 1', (await ledgerFlag()) === 1, `flag=${await ledgerFlag()}`);
  ok('总预算开关处于勾选态', !!$('[data-act="budget-enable"]') && $('[data-act="budget-enable"]').checked, `checked=${$('[data-act="budget-enable"]')?.checked}`);
  ok('种子总额 4500 还在（开启没清数据）', String(totalInput?.value || '').replace(/,/g, '').startsWith('4500'), totalInput?.value);
  ok('结转开关已挪出标题行', !$('.card h3 .switch'), 'h3.switch=' + !!$('.card h3 .switch'));
  ok('有「结转下月」文字行', /结转下月/.test(document.body.textContent || ''), 'ok');

  // ---------- 4. 明细页出现预算条 ----------
  await go('#/list');
  const strip = await waitFor(() => $('[data-block="budget-strip"]'), 6000);
  await sleep(600);
  ok('开启后明细页出现预算条', visible(strip), strip ? 'ok' : 'missing');
  ok('预算条显示本月预算 ¥4,500.00', txt($('.bs-amount')).includes('4,500.00'), txt($('.bs-amount')));
  ok('预算条显示还剩', /还剩|超支/.test(txt($('.bs-left'))), txt($('.bs-left')));

  // ---------- 5. 关闭：预算条消失 ----------
  await go('#/me/budgets');
  const sw = await waitFor(() => $('[data-act="budget-enable"]'), 6000);
  if (sw && sw.checked) {
    sw.checked = false;
    sw.dispatchEvent(new Event('change', { bubbles: true }));
    sw.click();
  }
  await waitFor(() => $('[data-block="budget-off"]'), 6000);
  await sleep(800);
  ok('关掉开关后回到未开启卡片', visible($('[data-block="budget-off"]')), 'ok');
  ok('关闭后账本 budget_enabled = 0', (await ledgerFlag()) === 0, `flag=${await ledgerFlag()}`);

  await go('#/list');
  await sleep(1200);
  ok('关闭后明细页预算条消失', $$('[data-block="budget-strip"]').length === 0, `count=${$$('[data-block="budget-strip"]').length}`);

  // ---------- 6. 离开再回来仍是关闭（持久化） ----------
  await go('#/me');
  await go('#/list');
  await sleep(1000);
  ok('重进明细页仍无预算条', $$('[data-block="budget-strip"]').length === 0, `count=${$$('[data-block="budget-strip"]').length}`);

  ok('全程无 console error', errs.length === 0, errs.slice(0, 3).join(' | '));
  return { hash: location.hash, pass: R.filter((r) => r.pass).length, total: R.length, results: R };
})();
