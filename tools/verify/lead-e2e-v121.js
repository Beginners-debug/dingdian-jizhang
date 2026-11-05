// v1.2.1 前端独立复验：账户记忆 / 键盘高度 / 返回钩子
// 用法: node tools/verify/cdp.mjs "http://127.0.0.1:8787/" .tmp/v121.png tools/verify/lead-e2e-v121.js 430 900
//       node tools/verify/cdp.mjs "http://127.0.0.1:8787/" .tmp/v121s.png tools/verify/lead-e2e-v121.js 360 780
(async () => {
  const checks = [];
  const ok = (name, cond, detail) => checks.push({ name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const go = async (h, ms = 700) => {
    location.hash = h;
    await wait(ms);
  };
  const tap = async (node, ms = 260) => {
    if (node) node.click();
    await wait(ms);
  };
  const chip = (txt) => $$('.chip[data-act="acc"]').find((n) => n.textContent.includes(txt));
  const onChip = () => $('.chip[data-act="acc"].is-on');
  const press = async (k) => {
    const btn = $$('.keypad .key').find((b) => b.dataset.key === k) || $$('.keypad .key').find((b) => b.textContent.trim() === k);
    await tap(btn, 90);
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
    await wait(600);
  };
  const settings = () => {
    try {
      return JSON.parse(localStorage.getItem('mintlite:settings') || '{}');
    } catch {
      return {};
    }
  };

  for (let i = 0; i < 80; i += 1) {
    if ($('#view')?.children.length) break;
    await wait(100);
  }
  await wait(500);
  $('#onboard')?.classList.remove('is-open');

  // ---------------------------------------------------------------- 1. 账户记忆
  await go('#/add', 900);
  const alipayChip = chip('支付宝');
  const lid1 = settings().ledgerId || '';
  await tap(alipayChip, 200);
  await press('1');
  await press('2');
  await tap($('[data-act="save"]'), 1100);
  const storedAcc = localStorage.getItem(`mintlite:last-account:${lid1}`) || '';
  ok(
    '选支付宝→保存后 localStorage 记住账户',
    !!alipayChip && storedAcc === alipayChip.dataset.id,
    `key=mintlite:last-account:${lid1} value=${storedAcc.slice(0, 10)}… expect=${alipayChip ? alipayChip.dataset.id.slice(0, 10) : '(无)'}…`,
  );

  // 切账本再切回，强制重建表单（freshAdd 会去读 localStorage）
  await go('#/me/ledgers', 900);
  await tap($('[data-act="ledger-add"]'), 500);
  const nameInput = $('#sheet-form [name="name"]');
  if (nameInput) {
    nameInput.value = '旅行账本';
    await tap($('[data-act="sheet-submit"]'), 1400);
  }
  const lid2 = settings().ledgerId || '';
  ok('新账本已创建并切换', !!lid2 && lid2 !== lid1, `${lid1.slice(0, 8)} -> ${lid2.slice(0, 8)}`);

  await go('#/add', 1000);
  $('#onboard')?.classList.remove('is-open');
  const onAfterSwitch = onChip();
  const key2 = localStorage.getItem(`mintlite:last-account:${lid2}`) || '';
  ok(
    '切账本后账户记忆不串',
    !onAfterSwitch || onAfterSwitch.dataset.id !== storedAcc,
    `lid2 键=${key2 || '(空)'} 选中=${onAfterSwitch ? onAfterSwitch.textContent.trim() : '(无)'}`,
  );

  await go('#/me/ledgers', 900);
  await tap($(`[data-act="ledger-switch"][data-id="${lid1}"]`), 1400);
  await go('#/add', 1000);
  const onBack = onChip();
  ok(
    '切回原账本恢复记住的账户',
    !!onBack && onBack.dataset.id === storedAcc,
    `选中=${onBack ? onBack.textContent.trim() : '(无)'}`,
  );

  // ---------------------------------------------------------------- 2. 键盘高度 + 分类一屏可见
  const pad = $('.keypad')?.getBoundingClientRect();
  const ratio = pad ? pad.height / window.innerHeight : 1;
  const limit = window.innerHeight <= 800 ? 0.34 : 0.33;
  ok(
    `键盘高度 ≤ ${Math.round(limit * 100)}% 屏高（${window.innerWidth}×${window.innerHeight}）`,
    !!pad && ratio <= limit,
    `${pad ? Math.round(pad.height) : '?'}px / ${window.innerHeight}px = ${(ratio * 100).toFixed(1)}%`,
  );

  const cats = $$('.cats .cat');
  const lastCat = cats.length ? cats[cats.length - 1].getBoundingClientRect() : null;
  const body = $('.add-body');
  const noScroll = body ? body.scrollHeight - body.clientHeight <= 1 : false;
  ok(
    '分类（含管理）一屏可见、不用滚动',
    cats.length >= 8 && lastCat && pad && lastCat.bottom <= pad.top + 1 && noScroll,
    `cat=${cats.length} 最后一行 bottom=${lastCat ? Math.round(lastCat.bottom) : '?'} 键盘 top=${pad ? Math.round(pad.top) : '?'} 溢出=${body ? body.scrollHeight - body.clientHeight : '?'}`,
  );

  const keyMin = Math.min(...$$('.keypad .key').map((n) => n.getBoundingClientRect().height));
  ok('按键高度不低于 36px', keyMin >= 35.5, `min=${keyMin.toFixed(1)}px`);
  ok('保存键仍在键盘里', !!$('.keypad [data-act="save"]'));

  // ---------------------------------------------------------------- 3. MintLiteBack
  await go('#/me/members', 900);
  const deep = location.hash;
  const consumed = typeof window.MintLiteBack === 'function' ? window.MintLiteBack() : null;
  await wait(800);
  ok(
    'window.MintLiteBack() 二级页返回 true 并回上级',
    consumed === true && location.hash === '#/me',
    `from=${deep} ret=${consumed} now=${location.hash}`,
  );

  await go('#/add', 900);
  const atRoot = typeof window.MintLiteBack === 'function' ? window.MintLiteBack() : null;
  await wait(400);
  ok('window.MintLiteBack() 在 tab 根页返回 false', atRoot === false, `ret=${atRoot} hash=${location.hash}`);

  // ---------------------------------------------------------------- 4. 壳内根页左滑退出
  window.__exited = false;
  window.MintLiteBridge = {
    exitApp() {
      window.__exited = true;
    },
    platform() {
      return 'android';
    },
  };
  const beforeSwipe = location.hash;
  const swipeY = Math.max(90, Math.round(window.innerHeight * 0.17)); // 金额区，避开输入框/键盘
  await swipe(330, 120, swipeY);
  ok(
    '注入 MintLiteBridge 后根页左滑调用 exitApp',
    window.__exited === true && location.hash === beforeSwipe,
    `y=${swipeY} exited=${window.__exited} hash=${location.hash}`,
  );
  delete window.MintLiteBridge;

  const passed = checks.filter((c) => c.pass).length;
  return { passed, total: checks.length, viewport: `${window.innerWidth}×${window.innerHeight}`, checks, hash: location.hash };
})();
