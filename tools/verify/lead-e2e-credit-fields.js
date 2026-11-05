// 账户表单：额度/账单日/还款日只在「信用卡」下出现
(async () => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const ok = (name, pass, detail = '') => out.push({ name, pass: !!pass, detail });

  const idbAll = (storeName) =>
    new Promise((resolve) => {
      const req = indexedDB.open('mintlite');
      req.onerror = () => resolve([]);
      req.onsuccess = () => {
        const db = req.result;
        const q = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
        q.onerror = () => resolve([]);
        q.onsuccess = () => resolve(q.result || []);
      };
    });

  const visible = (name) => {
    const el = $(`[name="${name}"]`);
    if (!el) return false;
    const wrap = el.closest('.field');
    return !!wrap && wrap.getClientRects().length > 0;
  };
  const val = (name) => {
    const el = $(`[name="${name}"]`);
    return el ? el.value : null;
  };

  const openAccount = async (accName) => {
    location.hash = '#/assets';
    await sleep(700);
    $('#onboard')?.classList.remove('is-open');
    const row = $$('.asset-row').find((r) => r.textContent.includes(accName));
    if (!row) return false;
    row.click();
    await sleep(500);
    return !!$('#sheet-form');
  };

  const accounts = await idbAll('accounts');
  const bankAcc = accounts.find((a) => a.type === 'bank');
  const creditAcc = accounts.find((a) => a.type === 'credit');
  ok('种子里有银行卡', !!bankAcc, bankAcc ? bankAcc.name : '');
  ok('种子里有信用卡类', !!creditAcc, creditAcc ? `${creditAcc.name} limit=${creditAcc.credit_limit_cents}` : '');

  // 1) 银行卡：三个字段都不该出现
  ok('打开银行卡编辑', await openAccount(bankAcc.name));
  ok('银行卡无「额度」', !visible('limit'));
  ok('银行卡无「账单日」', !visible('bill_day'));
  ok('银行卡无「还款日」', !visible('repay_day'));
  ok('银行卡类型=bank', val('type') === 'bank', String(val('type')));

  // 2) 切到信用卡：三个字段出现，所属自动变负债
  const typeSel = $('[name="type"]');
  typeSel.value = 'credit';
  typeSel.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(200);
  ok('切信用卡后出现额度', visible('limit'));
  ok('切信用卡后出现账单日', visible('bill_day'));
  ok('切信用卡后出现还款日', visible('repay_day'));
  ok('所属自动变负债', val('kind') === 'liability', String(val('kind')));

  // 3) 再切回银行卡：隐藏且清空
  typeSel.value = 'bank';
  typeSel.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(200);
  ok('切回银行卡后三个字段都隐藏', !visible('limit') && !visible('bill_day') && !visible('repay_day'));
  ok('隐藏时清空额度', val('limit') === '', JSON.stringify(val('limit')));

  // 4) 保存后库里这三个值是 0
  $('[data-act="sheet-submit"]').click();
  await sleep(1400);
  const rows = await idbAll('accounts');
  const saved = rows.find((a) => a.name === bankAcc.name);
  ok('保存后额度=0', saved && Number(saved.credit_limit_cents) === 0, saved ? String(saved.credit_limit_cents) : 'missing');
  ok('保存后账单日=0', saved && Number(saved.bill_day) === 0, saved ? String(saved.bill_day) : '');
  ok('保存后还款日=0', saved && Number(saved.repay_day) === 0, saved ? String(saved.repay_day) : '');

  // 5) 信用卡类：字段在，且带出已有额度
  ok('打开信用卡编辑', await openAccount(creditAcc.name));
  ok('信用卡有额度字段', visible('limit'));
  ok('信用卡额度带出值', (val('limit') || '') !== '', String(val('limit')));
  ok('信用卡有账单日', visible('bill_day'));
  ok('信用卡有还款日', visible('repay_day'));

  await sleep(200);
  return { pass: out.filter((x) => x.pass).length, fail: out.filter((x) => !x.pass).length, items: out };
})();
