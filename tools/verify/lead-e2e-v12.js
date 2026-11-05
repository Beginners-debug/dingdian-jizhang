// v1.2 前端独立复验（按 docs/CONTRACT-v1.2.md §5 写）
// 用法: node tools/verify/cdp.mjs "http://127.0.0.1:8787/" .tmp/v12.png tools/verify/lead-e2e-v12.js 430 900
(async () => {
  const checks = [];
  const ok = (name, cond, detail) => checks.push({ name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const go = async (h, ms = 650) => {
    location.hash = h;
    await wait(ms);
  };
  const swipe = async (fromX, toX, y = 400) => {
    const mk = (type, x) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'touch',
        isPrimary: true,
        clientX: x,
        clientY: y,
        buttons: type === 'pointerup' ? 0 : 1,
      });
    const target = document.elementFromPoint(fromX, y) || document.body;
    target.dispatchEvent(mk('pointerdown', fromX));
    for (let i = 1; i <= 6; i += 1) {
      const x = fromX + ((toX - fromX) * i) / 6;
      (document.elementFromPoint(x, y) || document.body).dispatchEvent(mk('pointermove', x));
      await wait(16);
    }
    (document.elementFromPoint(toX, y) || document.body).dispatchEvent(mk('pointerup', toX));
    await wait(500);
  };

  for (let i = 0; i < 80; i += 1) {
    if ($('#view')?.children.length) break;
    await wait(100);
  }
  await wait(400);
  $('#onboard')?.classList.remove('is-open');

  // 1. 底部 5 个 tab，顺序固定
  const tabs = $$('#tabbar [data-tab]').map((n) => n.dataset.tab);
  ok(
    '底部 5 个 tab 且顺序=记账/明细/资产/报表/我的',
    JSON.stringify(tabs) === JSON.stringify(['add', 'list', 'assets', 'report', 'me']),
    tabs.join(','),
  );

  // 2. 资产页大类分组 + 折叠
  await go('#/assets');
  const groups = $$('#view .asset-group');
  ok('资产页至少 5 个大类分组', groups.length >= 5, `n=${groups.length} keys=${groups.map((g) => g.dataset.group).join(',')}`);
  const credit = $('#view .asset-group[data-group="credit"]');
  ok('存在信用卡·信用付分组', !!credit);
  if (credit) {
    const before = $$('.asset-row', credit).length;
    $('[data-act="asset-group-toggle"]', credit)?.click();
    await wait(350);
    const after = $$('.asset-row', credit).length;
    ok('点组头可折叠（组内账户行减少）', after < before, `${before} -> ${after}`);
    let collapsed = '';
    try {
      collapsed = localStorage.getItem('mintlite:asset-collapsed') || '';
    } catch {
      collapsed = '';
    }
    ok('折叠状态写进 localStorage（刷新后保持）', collapsed.includes('credit'), collapsed.slice(0, 60));
    $('[data-act="asset-group-toggle"]', credit)?.click();
    await wait(300);
    ok('再点可展开', $$('.asset-row', credit).length === before, `${$$('.asset-row', credit).length} vs ${before}`);
  }

  // 3. 整组隐藏 → 进「N 个隐藏账户」
  const ewallet = $('#view .asset-group[data-group="ewallet"]');
  ok('存在电子钱包分组', !!ewallet);
  if (ewallet) {
    const n0 = $$('.asset-row', ewallet).length;
    $('[data-act="asset-group-hide"]', ewallet)?.click();
    await wait(400);
    const n1 = $$('.asset-row', ewallet).length;
    const hiddenToggle = $('[data-act="toggle-hidden-accounts"]');
    ok('隐藏整组后组内账户行消失', n1 < n0, `${n0} -> ${n1}`);
    ok('出现「N 个隐藏账户」入口', !!hiddenToggle, hiddenToggle?.textContent?.trim() || '');
    hiddenToggle?.click();
    await wait(300);
    const inHidden = $$('.hidden-accounts .asset-row').length;
    ok('展开后能看到被隐藏的账户', inHidden >= n0, `hidden rows=${inHidden} (原 ${n0})`);
    $('[data-act="asset-group-hide"]', ewallet)?.click();
    await wait(300);
  }

  // 4. 还款提醒条
  await go('#/assets', 800);
  const remind = $$('#view .remind-item');
  const remindText = remind.map((n) => n.textContent.replace(/\s+/g, ' ').trim()).join(' | ');
  ok('资产页有还款提醒', remind.length >= 1, remindText || '(无)');
  ok('提醒文案含「距还款日」或「已逾期」', /距还款日|已逾期|今天到期/.test(remindText), remindText);

  // 5. 账本切换器
  const switcher = $('[data-act="ledger-switch"]');
  ok('存在账本切换器', !!switcher, switcher?.textContent?.trim() || '');
  if (switcher) {
    switcher.click();
    await wait(400);
    const picks = $$('[data-act="ledger-pick"]');
    ok('下拉能列出账本', picks.length >= 1, `n=${picks.length}`);
    ok('下拉有「新建账本」入口', !!$('[data-act="ledger-new"]'));
    document.body.click();
    await wait(250);
  }

  // 6. 成员：默认选中「我」，可切换并落库
  await go('#/add', 900);
  const chips = $$('.member-chip');
  ok('记账页有成员 chips', chips.length >= 1, `n=${chips.length}`);
  ok('默认选中「我」', chips.some((c) => c.classList.contains('is-on') && /我/.test(c.textContent)), chips.map((c) => c.textContent.trim()).join(','));
  const other = chips.find((c) => !/我/.test(c.textContent));
  if (other) {
    other.click();
    await wait(200);
    ok('点第二个成员后切换选中态', other.classList.contains('is-on'), other.textContent.trim());
  }
  // 记一笔（先选分类，否则 saveTransaction 会拦）
  $('.cat[data-act="cat"]')?.click();
  await wait(200);
  for (const k of ['1', '2']) {
    $$('.key')
      .find((b) => b.dataset.key === k)
      ?.click();
    await wait(50);
  }
  $('[data-act="save"]')?.click();
  await wait(900);

  // 7. 明细里能看到成员标识
  await go('#/list', 900);
  const txMembers = $$('.tx-member').map((n) => n.textContent.trim());
  ok('明细行显示成员（.tx-member）', txMembers.length >= 1, txMembers.slice(0, 4).join(',') || '(无)');

  // 8. 报表：成员分布 + 月度收支 12 根柱
  await go('#/report', 1000);
  ok('报表有成员分布区块', !!$('[data-block="by-member"]'));
  const bars = $$('[data-block="monthly"] svg .bar');
  ok('月度收支有 12 根柱', bars.length === 12, `n=${bars.length}`);

  // 9. 手势：右滑返回、左滑切 tab
  await go('#/me', 800);
  await go('#/me/members', 800);
  const deepHash = location.hash;
  await swipe(8, 320, 400);
  ok('二级页右滑能返回上一页', location.hash !== deepHash && location.hash === '#/me', `now=${location.hash}`);

  await go('#/assets', 800);
  await swipe(330, 120, 400);
  ok('资产页左滑切到报表', location.hash === '#/report', `now=${location.hash}`);

  const passed = checks.filter((c) => c.pass).length;
  return { passed, total: checks.length, checks, hash: location.hash };
})();
