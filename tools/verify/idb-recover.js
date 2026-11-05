// 复现并验证 IndexedDB「The database connection is closing」修复
// 用法: node tools/verify/cdp.mjs "http://127.0.0.1:8787/" .tmp/idb.png tools/verify/idb-recover.js 430 900
// 原理: 页面里用 indexedDB.open('mintlite', 3) 模拟「另一个标签页把库升级了」，
//       旧连接必须被自动关掉并在下一次读写时无感重连；随后走真实 UI 新增一个分类。
(async () => {
  const out = [];
  const rec = (name, ok, extra) => out.push({ name, ok: !!ok, ...(extra === undefined ? {} : { extra }) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 等 App 起来
  for (let i = 0; i < 80; i += 1) {
    if (document.querySelector('#view') && document.querySelector('#view').children.length) break;
    await sleep(100);
  }
  await sleep(400);
  document.getElementById('onboard')?.classList.remove('is-open');

  const version = await new Promise((resolve) => {
    const req = indexedDB.open('mintlite');
    req.onsuccess = () => {
      const v = req.result.version;
      req.result.close();
      resolve(v);
    };
    req.onerror = () => resolve(-1);
  });
  rec('当前库版本=2', version === 2, `v${version}`);

  // ① 模拟另一个标签页升级库版本：旧连接收到 versionchange 必须自己关掉
  const bump = await new Promise((resolve) => {
    const req = indexedDB.open('mintlite', 3);
    req.onupgradeneeded = () => {};
    req.onsuccess = () => {
      const v = req.result.version;
      req.result.close();
      resolve(`v${v}`);
    };
    req.onerror = () => resolve(`error:${req.error?.name || '?'}`);
    req.onblocked = () => resolve('blocked');
    setTimeout(() => resolve('timeout'), 6000);
  });
  rec('模拟另一标签页升级到 v3（旧连接自动让位）', bump === 'v3', bump);

  // ② 走真实 UI：分类管理 → 新增支出分类 → 填名字 → 保存
  location.hash = '#/me/categories';
  await sleep(700);
  const addBtn = document.querySelector('[data-act="cat-add"][data-kind="expense"]');
  rec('分类页有「新增支出分类」按钮', !!addBtn);
  if (addBtn) addBtn.click();
  await sleep(450);

  const nameInput = document.querySelector('#sheet-form [name="name"]');
  rec('弹窗有名称输入框', !!nameInput);
  if (nameInput) {
    nameInput.value = '旅游';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const submit = document.querySelector('[data-act="sheet-submit"]');
  rec('弹窗有保存按钮', !!submit);
  if (submit) submit.click();
  await sleep(1400);

  const toastNode = document.getElementById('toast');
  const toastText = (toastNode?.textContent || '').trim();
  const toastErr = !!toastNode?.classList.contains('is-error');
  rec('保存未弹错误提示', !toastErr, toastText || '(无提示)');
  rec('提示文案=分类已添加', toastText === '分类已添加', toastText);

  // ③ 数据真的落库了（用当前版本重新开一条只读连接去查）
  const rows = await new Promise((resolve) => {
    const req = indexedDB.open('mintlite');
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction('categories', 'readonly');
        const all = tx.objectStore('categories').getAll();
        all.onsuccess = () => {
          const hit = all.result.filter((c) => c.name === '旅游');
          db.close();
          resolve(hit.length);
        };
        all.onerror = () => {
          db.close();
          resolve(-1);
        };
      } catch (err) {
        db.close();
        resolve(-2);
      }
    };
    req.onerror = () => resolve(-3);
  });
  rec('库里查到「旅游」分类（1 条）', rows === 1, String(rows));

  const after = await new Promise((resolve) => {
    const req = indexedDB.open('mintlite');
    req.onsuccess = () => {
      const v = req.result.version;
      req.result.close();
      resolve(v);
    };
    req.onerror = () => resolve(-1);
  });
  rec('重连后库版本仍为 3（不降级）', after === 3, `v${after}`);

  // ④ 列表上真的出现了这一行
  await sleep(400);
  const viewText = (document.querySelector('#view')?.textContent || '').replace(/\s+/g, ' ');
  rec('列表上出现「旅游」', viewText.includes('旅游'), viewText.slice(0, 60));

  const passed = out.filter((r) => r.ok).length;
  return {
    passed,
    total: out.length,
    items: out,
    debug: {
      hash: location.hash,
      viewChildren: document.querySelector('#view')?.children.length ?? -1,
      viewText: (document.querySelector('#view')?.textContent || '').replace(/\s+/g, ' ').slice(0, 160),
    },
  };
})();
