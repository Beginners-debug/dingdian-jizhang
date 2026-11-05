/* v1.3 前端独立复验（按 docs/CONTRACT-v1.3.md §5 的前端 14 条写）
 * 用法: node tools/verify/cdp.mjs "http://127.0.0.1:8787/" .tmp/v13.png tools/verify/lead-e2e-v13.js 430 900
 * 本地模式（IndexedDB），每次 cdp 起独立 profile，所以是干净的种子库。
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
    await sleep(900);
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
  const press = (el, ms) => {
    const opt = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 120, clientY: 300 };
    el.dispatchEvent(new PointerEvent('pointerdown', opt));
    return sleep(ms).then(() => {
      el.dispatchEvent(new PointerEvent('pointerup', opt));
      el.dispatchEvent(new PointerEvent('pointercancel', opt));
    });
  };

  const errs = [];
  window.addEventListener('error', (e) => errs.push(String(e.message || e)));
  window.addEventListener('unhandledrejection', (e) => errs.push('reject:' + String((e.reason && e.reason.message) || e.reason)));

  localStorage.setItem('mintlite:onboarded', '1');
  document.getElementById('onboard')?.classList.remove('is-open');
  await waitFor(() => $('#tabbar'));
  await sleep(1200);

  // ================= A. 周期记账 =================
  await go('#/recurring');
  await waitFor(() => $('[data-act="rec-add"]'));
  const n0 = $$('.rec-row').length;

  // 建一条规则
  $('[data-act="rec-add"]')?.click();
  await waitFor(() => $('#sheet-form'));
  const setVal = (name, v) => {
    const el = document.querySelector(`#sheet-form [name="${name}"]`);
    if (!el) return false;
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  setVal('amount', '1200');
  setVal('note', 'v13房租');
  setVal('start', new Date().toISOString().slice(0, 10));
  const catSel = document.querySelector('#sheet-form [name="category"]');
  if (catSel && catSel.options.length > 1) catSel.value = catSel.options[1].value;
  const accSel = document.querySelector('#sheet-form [name="account"]');
  if (accSel && accSel.options.length > 1) accSel.value = accSel.options[1].value;
  $('[data-act="sheet-submit"]')?.click();
  await waitFor(() => $$('.rec-row').length === n0 + 1, 6000);
  ok('新建周期规则后列表 +1', $$('.rec-row').length === n0 + 1, `${n0} → ${$$('.rec-row').length}`);

  const ruleRows = await idbAll('recurring_rules');
  const liveRule = ruleRows.filter((r) => !r.deleted_at).slice(-1)[0] || {};
  const ruleId = liveRule.id;
  ok('规则已落库且带 ledger_id', !!ruleId && !!liveRule.ledger_id, `id=${String(ruleId).slice(0, 8)} ledger=${String(liveRule.ledger_id).slice(0, 8)}`);

  // 关掉开关 = 暂停（行不能消失）
  const sw = $('[data-act="rec-toggle"]');
  if (sw) {
    sw.checked = false;
    sw.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(1500);
  }
  const rowAfter = $$('.rec-row').find((r) => r.dataset.id === ruleId || txt(r).includes('v13房租')) || $$('.rec-row')[0];
  ok('关掉开关后行还在（不是删除）', !!rowAfter, `rows=${$$('.rec-row').length}`);
  ok('行上有「已暂停」标记', !!$('.rec-off-badge') && txt($('.rec-off-badge')).includes('已暂停'), txt($('.rec-off-badge')));

  const afterRows = await idbAll('recurring_rules');
  const afterRule = afterRows.find((r) => r.id === ruleId) || {};
  ok('暂停后 enabled = 0', Number(afterRule.enabled) === 0, `enabled=${afterRule.enabled}`);
  ok(
    '暂停不清空 ledger_id / amount_cents / next_run',
    afterRule.ledger_id === liveRule.ledger_id && Number(afterRule.amount_cents) === Number(liveRule.amount_cents) && afterRule.next_run === liveRule.next_run,
    `ledger=${String(afterRule.ledger_id).slice(0, 8)} amount=${afterRule.amount_cents} next=${afterRule.next_run}`,
  );

  // 离开再回来（等价于刷新后的持久化）
  await go('#/list');
  await go('#/recurring');
  await sleep(600);
  ok('离开再回来规则仍在且仍是暂停态', $$('.rec-row').length >= 1 && !!$('.rec-off-badge'), `rows=${$$('.rec-row').length}`);

  // 短按 200ms 不弹删除
  const main = $('.rec-main');
  await press(main, 200);
  await sleep(300);
  ok('短按不弹动作面板', !visible($('[data-act="rec-del"]')), 'ok');

  // 长按 700ms 弹出删除
  await press(main, 750);
  await sleep(500);
  const sheet = $('.sheet');
  ok('长按 700ms 弹出动作面板', visible(sheet), `sheet=${visible(sheet)}`);
  ok('面板里有删除规则', visible($('[data-act="rec-del"]')), txt($('[data-act="rec-del"]')));
  ok('面板里有暂停/恢复', !!$('[data-act="rec-pause"]'), txt($('[data-act="rec-pause"]')));
  $('[data-act="sheet-close"]')?.click();
  await sleep(400);

  // 编辑表单里没有删除按钮
  $('.rec-main')?.click();
  await waitFor(() => $('#sheet-form'));
  await sleep(300);
  const delInForm = $('#sheet-form') ? $('#sheet-form').querySelector('[data-act="rec-del"]') : null;
  ok('编辑表单里没有删除按钮', !delInForm, delInForm ? 'still there' : 'ok');
  $('[data-act="sheet-close"]')?.click();
  await sleep(400);

  // 暂停的规则点「立即补记」不生成流水
  const tx0 = (await idbAll('transactions')).filter((t) => !t.deleted_at).length;
  $('[data-act="rec-run"]')?.click();
  await sleep(2000);
  const tx1 = (await idbAll('transactions')).filter((t) => !t.deleted_at).length;
  ok('暂停的规则补记不产生流水', tx1 === tx0, `${tx0} → ${tx1}`);

  // ================= B. 明细页预算条 =================
  // v1.3.2：预算功能默认关闭，先到预算页打开总开关
  await go('#/me/budgets');
  const enableBtn = await waitFor(() => $('[data-act="budget-enable-on"]'), 5000);
  if (enableBtn) {
    enableBtn.click();
    await waitFor(() => $('[data-budget="total"]'), 5000);
    await sleep(600);
  }
  ok('预算功能可从关闭态打开', !visible($('[data-block="budget-off"]')), `off=${visible($('[data-block="budget-off"]'))}`);

  await go('#/list');
  const strip = await waitFor(() => $('[data-block="budget-strip"]'), 5000);
  ok('#/list 顶部有预算条', !!strip, strip ? 'ok' : 'missing');
  ok('预算条显示剩余', txt($('.bs-left')).includes('还剩') || txt($('.bs-left')).includes('超支'), txt($('.bs-left')));
  ok('预算条显示总预算', /¥/.test(txt($('.bs-amount'))), txt($('.bs-amount')));
  ok('种子库预算条：剩 ¥1,624.50 且不预警', txt($('.bs-left')).includes('1,624.50') && !txt($('.bs-head')).includes('⚠'), `${txt($('.bs-head'))} | ${txt($('.bs-left'))}`);
  const barW = $('.bs-bar > i') ? $('.bs-bar > i').style.width : '';
  ok('进度条有宽度', !!barW, barW);

  $('[data-act="budget-strip-toggle"]')?.click();
  await sleep(500);
  const cats = $$('.bs-cat');
  ok('展开后列出已设预算的分类', cats.length >= 3, `n=${cats.length}`);
  ok('展开状态被记住', localStorage.getItem('mintlite:budget-strip-open') === '1', String(localStorage.getItem('mintlite:budget-strip-open')));
  ok('分类行显示剩余', cats.length > 0 && (txt(cats[0]).includes('还剩') || txt(cats[0]).includes('超支')), txt(cats[0]));

  // ================= C. 预算页（等式模型：总预算 = 明细合计 + 未分配） =================
  await go('#/me/budgets');
  await waitFor(() => $('[data-budget="total"]'));
  await sleep(500);
  const totalInput = $('[data-budget="total"]');
  ok('总预算输入框可编辑（不再只读）', !!totalInput && totalInput.readOnly === false, `readOnly=${totalInput?.readOnly}`);

  const budgets0 = await idbAll('budgets');
  const total0 = budgets0.find((b) => !b.category_id);
  const sum0 = budgets0.filter((b) => b.category_id).reduce((s, b) => s + Number(b.amount_cents || 0), 0);
  ok('种子库总预算仍是 4500（没被分类同步压成 2300）', Number(total0?.amount_cents) === 450000, `total=${total0?.amount_cents} sum=${sum0}`);

  const unallocInput = $('[data-budget="unallocated"]');
  ok('有「未分配」可编辑项', !!unallocInput, unallocInput ? `value=${unallocInput.value}` : 'missing');
  ok('未分配 = 总预算 − 明细合计 = 2200', Number(unallocInput?.value) === 2200, `value=${unallocInput?.value} total=${total0?.amount_cents} sum=${sum0}`);
  ok('页面出现等式「明细合计」', document.body.textContent.includes('明细合计'), 'ok');

  const warnInput = $('[data-warn-percent]');
  ok('有预警阈值输入框', !!warnInput, warnInput ? `value=${warnInput.value}` : 'missing');
  if (warnInput) {
    warnInput.value = '20';
    warnInput.dispatchEvent(new Event('change', { bubbles: true }));
    $('[data-act="budget-save"]')?.click();
    await sleep(1800);
    const budgets = await idbAll('budgets');
    const totalRow = budgets.find((b) => !b.category_id);
    ok('阈值 20 落库', Number(totalRow?.warn_percent) === 20, `warn=${totalRow?.warn_percent}`);
    await go('#/list');
    await go('#/me/budgets');
    await waitFor(() => $('[data-warn-percent]'));
    ok('重进页面阈值仍是 20', String($('[data-warn-percent]')?.value) === '20', String($('[data-warn-percent]')?.value));
  }

  // 改分类预算 → 总预算不变，差额进「未分配」
  const catInput = $$('[data-budget]').find((el) => el.dataset.budget !== 'total' && el.dataset.budget !== 'unallocated');
  if (catInput) {
    const before = Number((await idbAll('budgets')).find((b) => !b.category_id)?.amount_cents || 0);
    catInput.value = '1500';
    catInput.dispatchEvent(new Event('change', { bubbles: true }));
    $('[data-act="budget-save"]')?.click();
    await sleep(1800);
    const budgets = await idbAll('budgets');
    const total = budgets.find((b) => !b.category_id);
    const sum = budgets.filter((b) => b.category_id).reduce((s, b) => s + Number(b.amount_cents || 0), 0);
    ok('改分类预算后总预算不变（仍是 4500）', Number(total?.amount_cents) === before, `total=${total?.amount_cents} before=${before}`);
    ok('改分类后明细合计 = 2600（餐饮 1500 + 交通 300 + 购物 800）', sum === 260000, `sum=${sum}`);
  }

  // 明细合计超过总预算 → 弹确认，选「提高总预算」
  await go('#/me/budgets');
  await waitFor(() => $('[data-budget="total"]'));
  await sleep(400);
  const overInput = $$('[data-budget]').find((el) => el.dataset.budget !== 'total' && el.dataset.budget !== 'unallocated');
  if (overInput) {
    overInput.value = '5000';
    overInput.dispatchEvent(new Event('change', { bubbles: true }));
    $('[data-act="budget-save"]')?.click();
    await sleep(1500);
    const expandBtn = $('[data-act="budget-expand"]');
    const rebBtn = $('[data-act="budget-rebalance"]');
    ok('明细合计 > 总预算时弹确认（提高 / 压缩两个选项）', !!expandBtn && !!rebBtn, `expand=${!!expandBtn} rebalance=${!!rebBtn}`);
    if (expandBtn) {
      expandBtn.click();
      await sleep(1800);
      const budgets = await idbAll('budgets');
      const total = budgets.find((b) => !b.category_id);
      const sum = budgets.filter((b) => b.category_id).reduce((s, b) => s + Number(b.amount_cents || 0), 0);
      ok('选「提高总预算」后总预算 = 明细合计', Number(total?.amount_cents) === sum && sum > 450000, `total=${total?.amount_cents} sum=${sum}`);
    }
  }

  // 编辑「未分配」→ 总预算 = 明细合计 + 未分配
  await go('#/me/budgets');
  await waitFor(() => $('[data-budget="unallocated"]'));
  await sleep(400);
  const un2 = $('[data-budget="unallocated"]');
  if (un2) {
    un2.value = '300';
    un2.dispatchEvent(new Event('change', { bubbles: true }));
    $('[data-act="budget-save"]')?.click();
    await sleep(1800);
    const budgets = await idbAll('budgets');
    const total = budgets.find((b) => !b.category_id);
    const sum = budgets.filter((b) => b.category_id).reduce((s, b) => s + Number(b.amount_cents || 0), 0);
    ok('未分配填 300 → 总预算 = Σ + 30000', Number(total?.amount_cents) === sum + 30000, `total=${total?.amount_cents} sum=${sum}`);
  }

  ok('全程无 console error', errs.length === 0, errs.slice(0, 3).join(' | '));
  return { hash: location.hash, pass: R.filter((r) => r.pass).length, total: R.length, results: R };
})();
