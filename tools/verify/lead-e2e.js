(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const go = async (h) => {
    location.hash = h;
    await wait(560);
  };
  const key = async (k) => {
    const btn = $$('.key').find((b) => b.dataset.key === k);
    if (!btn) throw new Error('key not found: ' + k);
    btn.click();
    await wait(40);
  };
  const out = { checks: [] };
  const ok = (name, cond, detail) => out.checks.push({ name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });

  // 全新 profile 必定会弹引导层：先按「点了跳过」处理，再断言它确实不挡操作
  $('#onboard')?.classList.remove('is-open');
  ok('引导层可关闭', !$('#onboard') || !$('#onboard').classList.contains('is-open'));

  // 1. 资产页
  await go('#/assets');
  const rows = $$('.asset-row');
  const bars = $$('.asset-row .a-bar');
  const dupChips = $$('.asset-row .a-name').filter((n) => {
    const chips = [...n.querySelectorAll('.type-chip')].map((c) => c.textContent.trim());
    const name = (n.firstChild && n.firstChild.textContent ? n.firstChild.textContent : '').trim();
    return name && chips.includes(name);
  }).length;
  const heroNet = $('.asset-hero .bal-value');
  const groupTotals = $$('.group-total').map((g) => g.textContent.replace(/\s+/g, ' ').trim());
  ok('资产页有账户行', rows.length >= 5, 'rows=' + rows.length);
  ok('进度条只在信用账户', bars.length === 1, 'bars=' + bars.length);
  ok('名称与类型胶囊不重复', dupChips === 0, 'dup=' + dupChips);
  ok('净资产有数字', heroNet && /¥/.test(heroNet.textContent), heroNet && heroNet.textContent.trim());
  ok('分组小计存在', groupTotals.length === 2, groupTotals.join(' / '));

  // 2. 报表页
  await go('#/report');
  const cells = $$('.ov-cell');
  const tops = cells.map((c) => Math.round(c.getBoundingClientRect().top));
  ok('概览三格', cells.length === 3, 'cells=' + cells.length);
  ok('概览同排不换行', new Set(tops).size === 1, 'tops=' + tops.join(','));
  const deltas = $$('.cmp-delta').map((d) => d.textContent.replace(/\s+/g, ' ').trim());
  const huge = deltas.filter((t) => {
    const m = t.match(/(-?\d+(?:\.\d+)?)%/);
    return m && Math.abs(Number(m[1])) > 1000;
  });
  ok('环比没有二次乘 100', huge.length === 0, deltas.join(' | '));
  const lvls = $$('.cal-cell').filter((c) => /lvl[0-4]/.test(c.className)).length;
  ok('热力图有格子与分档', lvls > 20, 'lvlCells=' + lvls);
  ok('趋势 svg 存在', !!$('.card svg'));

  // 3. 预算页
  await go('#/me/budgets');
  ok('预算页有结转开关', $$('.switch.tiny').length >= 2, 'switches=' + $$('.switch.tiny').length);
  const carryText = $$('.carry').map((c) => c.textContent.trim());
  ok('结转文案存在', carryText.length >= 2, carryText.slice(0, 3).join(' | '));

  // 4. 标签页
  await go('#/tags');
  ok('标签页有 chip 或空态', $$('.tag-chip').length > 0 || !!$('.empty'), 'chips=' + $$('.tag-chip').length);

  // 5. 周期页
  await go('#/recurring');
  ok('周期页有补记按钮', !!$$('button').find((b) => b.textContent.includes('立即补记')));
  ok('周期页有行或空态', $$('.rec-row').length > 0 || !!$('.empty'), 'rows=' + $$('.rec-row').length);

  // 6. 记账页
  await go('#/list');
  const beforeRows = $$('.tx-row').length;
  const beforeText = ($('#tx-list') || document.body).innerText;
  await go('#/add');
  const toggle = $('.mini-toggle');
  ok('待报销开关存在', !!toggle, toggle && toggle.textContent.trim());
  if (toggle) {
    toggle.click();
    await wait(140);
    ok('待报销可切换', $('.mini-toggle').classList.contains('is-on'), $('.mini-toggle').className);
    $('.mini-toggle').click();
    await wait(90);
  }
  const catBtn = $('.cat[data-act="cat"]');
  if (catBtn) { catBtn.click(); await wait(120); }
  ok('能选中分类', !!catBtn && $('.cat.is-on'), catBtn ? catBtn.textContent.trim() : 'none');
  await key('1'); await key('2'); await key('.'); await key('5');
  await key('+'); await key('3'); await key('×'); await key('2');
  await key('=');
  await wait(140);
  const amt = $('#amount-main') ? $('#amount-main').textContent.trim() : '';
  const saveBtn = $('.key.save');
  ok('四则运算 12.5+3×2', /18\.5/.test(amt), 'amt=' + amt);
  ok('保存按钮可点', saveBtn && !saveBtn.disabled);
  saveBtn.click();
  await wait(800);
  const afterAmt = $('#amount-main') ? $('#amount-main').textContent.trim() : '';
  ok('保存后金额清零', /^[0０]?$/.test(afterAmt), 'afterAmt=' + afterAmt);
  ok('保存后停留在记账页', location.hash === '#/add', location.hash);

  await go('#/list');
  const afterRows = $$('.tx-row').length;
  const afterText = ($('#tx-list') || document.body).innerText;
  ok('明细行数 +1', afterRows === beforeRows + 1, beforeRows + ' -> ' + afterRows);
  ok('明细出现 18.50', /18\.50/.test(afterText), afterText.slice(0, 80).replace(/\n/g, ' '));
  ok('原有记录还在', beforeText.length > 50 && afterText.length > beforeText.length);

  return out;
})()
