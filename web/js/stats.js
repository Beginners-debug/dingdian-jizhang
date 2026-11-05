// web/js/stats.js — 纯聚合计算（不碰 DOM / IndexedDB，便于 node 单测）
// 契约 §3 的 summary/byCategory/trend 全部在这里实现，LocalStore 与 ApiStore 共用。
// 交易对象字段见契约 §1：amount_cents 整数分，happened_at 允许纯日期。

export function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

export function todayISO(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function currentMonth(date = new Date()) {
  return todayISO(date).slice(0, 7);
}

/** 任意 happened_at → 'YYYY-MM-DD' */
export function dateOf(tx) {
  return String((tx && tx.happened_at) || '').slice(0, 10);
}

export function monthOf(iso) {
  return String(iso || '').slice(0, 7);
}

/** 'YYYY-MM' → 该月首末日 */
export function monthRange(month) {
  const [y, m] = String(month).split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${pad2(days)}` };
}

/** 月份加减 */
export function addMonths(month, delta) {
  const [y, m] = String(month).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + Number(delta), 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/** 'YYYY-MM' → '2026年11月' */
export function monthLabel(month) {
  const [y, m] = String(month).split('-').map(Number);
  return `${y}年${m}月`;
}

/** 'YYYY-MM-DD' → '11月4日 周三' */
export function dateLabel(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][dt.getUTCDay()];
  return `${m}月${d}日 ${week}`;
}

/** 日期区间内的所有日期（含首末），UTC 计算避免时区漂移 */
export function daysBetween(from, to) {
  const out = [];
  if (!from || !to || from > to) return out;
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  let cur = Date.UTC(fy, fm - 1, fd);
  const end = Date.UTC(ty, tm - 1, td);
  let guard = 0;
  while (cur <= end && guard < 400) {
    const d = new Date(cur);
    out.push(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`);
    cur += 86400000;
    guard += 1;
  }
  return out;
}

export function isLive(tx) {
  return !!tx && !tx.deleted_at;
}

export function inRange(date, from, to) {
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

/** 统计口径：转账不计入收支 */
export function affectsBalance(tx) {
  return isLive(tx) && (tx.type === 'expense' || tx.type === 'income');
}

/**
 * 契约 §3 summary → {income_cents, expense_cents, balance_cents, count}
 * count 只数收支笔数（不含转账）。
 */
export function summarize(txs, from, to) {
  let income = 0;
  let expense = 0;
  let count = 0;
  for (const tx of txs || []) {
    if (!affectsBalance(tx)) continue;
    if (!inRange(dateOf(tx), from, to)) continue;
    const amount = Math.round(Number(tx.amount_cents) || 0);
    count += 1;
    if (tx.type === 'income') income += amount;
    else expense += amount;
  }
  return {
    income_cents: income,
    expense_cents: expense,
    balance_cents: income - expense,
    count,
  };
}

/**
 * 契约 §3 byCategory → [{category_id,name,icon,amount_cents,ratio}]，按金额降序
 * @param {object[]} txs
 * @param {object[]} categories
 * @param {'expense'|'income'} kind
 */
export function groupByCategory(txs, categories = [], kind = 'expense', from, to) {
  const map = new Map();
  let total = 0;
  for (const tx of txs || []) {
    if (!affectsBalance(tx) || tx.type !== kind) continue;
    if (!inRange(dateOf(tx), from, to)) continue;
    const amount = Math.round(Number(tx.amount_cents) || 0);
    const key = tx.category_id || '__none__';
    const prev = map.get(key) || { category_id: tx.category_id || null, amount_cents: 0, count: 0 };
    prev.amount_cents += amount;
    prev.count += 1;
    map.set(key, prev);
    total += amount;
  }
  const byId = new Map((categories || []).map((c) => [c.id, c]));
  const items = [];
  for (const [key, value] of map) {
    const cat = byId.get(key);
    items.push({
      category_id: value.category_id,
      name: cat ? cat.name : '未分类',
      icon: cat ? cat.icon || '💸' : '💸',
      amount_cents: value.amount_cents,
      count: value.count,
      ratio: total > 0 ? value.amount_cents / total : 0,
    });
  }
  items.sort((a, b) => b.amount_cents - a.amount_cents);
  return items;
}

/** 只保留前 n 项，其余合并为「其他」 */
export function collapseOthers(items, n = 5) {
  if (items.length <= n) return { top: items.slice(), rest: null };
  const top = items.slice(0, n);
  const restItems = items.slice(n);
  const sum = restItems.reduce((acc, it) => acc + it.amount_cents, 0);
  const ratio = restItems.reduce((acc, it) => acc + it.ratio, 0);
  return {
    top,
    rest: { category_id: '__other__', name: '其他', icon: '…', amount_cents: sum, ratio, count: restItems.length },
  };
}

/**
 * 明细页：按日分组，日期倒序
 * @returns {{date:string, expense_cents:number, income_cents:number, items:object[]}[]}
 */
export function groupByDay(txs, from, to) {
  const map = new Map();
  for (const tx of txs || []) {
    if (!isLive(tx)) continue;
    const date = dateOf(tx);
    if (!inRange(date, from, to)) continue;
    if (!map.has(date)) map.set(date, { date, expense_cents: 0, income_cents: 0, items: [] });
    const bucket = map.get(date);
    bucket.items.push(tx);
    if (tx.type === 'expense') bucket.expense_cents += Math.round(Number(tx.amount_cents) || 0);
    if (tx.type === 'income') bucket.income_cents += Math.round(Number(tx.amount_cents) || 0);
  }
  const groups = [...map.values()];
  for (const g of groups) {
    g.items.sort((a, b) => {
      const ta = Date.parse(a.created_at || '') || 0;
      const tb = Date.parse(b.created_at || '') || 0;
      if (ta !== tb) return tb - ta;
      return String(b.id).localeCompare(String(a.id));
    });
  }
  groups.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return groups;
}

/** 'YYYY-MM-DD' → 所在周的周一（ISO 周，周一起算） */
export function weekStart(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = (dt.getUTCDay() + 6) % 7; // 周一 = 0
  dt.setUTCDate(dt.getUTCDate() - dow);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** 日期 → 该粒度下的桶 key */
export function bucketOf(date, granularity = 'day') {
  if (granularity === 'month') return monthOf(date);
  if (granularity === 'week') return weekStart(date);
  return date;
}

/** 'YYYY-MM-DD' 加减天数 */
export function addDays(iso, delta) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + Number(delta || 0));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** 月末夹取：1/31 + 1 月 → 2/28 */
export function clampMonthDay(year, month, day) {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Math.min(Math.max(1, day), days);
}

/**
 * 周期记账日期推进（契约 §2.4）
 * daily +interval 天；weekly +interval*7 天；monthly +interval 月（月末夹取）；yearly +interval 年
 */
export function advanceDate(iso, freq = 'monthly', interval = 1) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const step = Math.max(1, Math.round(Number(interval) || 1));
  if (freq === 'daily') return addDays(iso, step);
  if (freq === 'weekly') return addDays(iso, step * 7);
  if (freq === 'yearly') {
    const year = y + step;
    return `${year}-${pad2(m)}-${pad2(clampMonthDay(year, m, d))}`;
  }
  const base = new Date(Date.UTC(y, m - 1 + step, 1));
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth() + 1;
  return `${year}-${pad2(month)}-${pad2(clampMonthDay(year, month, d))}`;
}

/**
 * 统一筛选（契约 §2.6）。app.js 与 LocalStore 共用，保证本地/服务器口径一致。
 * filters: {type, account_id, category_id, tag_id, q, min_cents, max_cents, reimburse_state}
 */
export function filterTx(txs, filters = {}, from, to) {
  const f = filters || {};
  const q = f.q ? String(f.q).trim().toLowerCase() : '';
  const min = f.min_cents != null && f.min_cents !== '' ? Math.round(Number(f.min_cents)) : null;
  const max = f.max_cents != null && f.max_cents !== '' ? Math.round(Number(f.max_cents)) : null;
  return (txs || []).filter((tx) => {
    if (!isLive(tx)) return false;
    const date = dateOf(tx);
    if (from && date < from) return false;
    if (to && date > to) return false;
    if (f.type && tx.type !== f.type) return false;
    if (f.account_id && tx.account_id !== f.account_id && tx.to_account_id !== f.account_id) return false;
    if (f.category_id && tx.category_id !== f.category_id) return false;
    if (f.tag_id) {
      const tags = Array.isArray(tx.tags) ? tx.tags : [];
      if (!tags.includes(f.tag_id)) return false;
    }
    if (f.reimburse_state && tx.reimburse_state !== f.reimburse_state) return false;
    const amount = Math.round(Number(tx.amount_cents) || 0);
    if (min != null && Number.isFinite(min) && amount < min) return false;
    if (max != null && Number.isFinite(max) && amount > max) return false;
    if (q) {
      const hay = `${tx.note || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/**
 * 报表概览（契约 §2.6 /stats/overview）
 * 转账、余额调整都不计入收支，但分别计数在 by_type 里。
 */
export function overview(txs, from, to) {
  const list = filterTx(txs, {}, from, to);
  const byType = { expense: 0, income: 0, transfer: 0, adjust: 0 };
  const byWeekday = Array.from({ length: 7 }, (_, i) => ({ weekday: i, expense_cents: 0, count: 0 }));
  let income = 0;
  let expense = 0;
  let count = 0;
  let maxExpense = 0;
  let maxNote = '';
  for (const tx of list) {
    const amount = Math.round(Number(tx.amount_cents) || 0);
    if (Object.prototype.hasOwnProperty.call(byType, tx.type)) byType[tx.type] += 1;
    const date = dateOf(tx);
    const [y, m, d] = date.split('-').map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (tx.type === 'expense') {
      income += 0;
      expense += amount;
      count += 1;
      byWeekday[dow].expense_cents += amount;
      byWeekday[dow].count += 1;
      if (amount > maxExpense) {
        maxExpense = amount;
        maxNote = tx.note || '';
      }
    } else if (tx.type === 'income') {
      income += amount;
      count += 1;
    }
  }
  const days = from && to ? daysBetween(from, to).length : 0;
  return {
    income_cents: income,
    expense_cents: expense,
    net_cents: income - expense,
    count,
    days,
    avg_expense_cents: days > 0 ? Math.round(expense / days) : 0,
    max_expense_cents: maxExpense,
    max_expense_note: maxNote,
    by_weekday: byWeekday,
    by_type: byType,
    transfer_cents: 0,
    adjust_cents: 0,
  };
}

/** 按账户分组（契约 §2.6 /stats/by-account，转账/调整不计入） */
export function groupByAccount(txs, accounts = [], kind = 'expense', from, to, filters = {}) {
  const list = filterTx(txs, { ...filters, type: kind }, from, to);
  const map = new Map();
  let total = 0;
  for (const tx of list) {
    const amount = Math.round(Number(tx.amount_cents) || 0);
    const key = tx.account_id || '__none__';
    const prev = map.get(key) || { account_id: tx.account_id || null, amount_cents: 0, count: 0 };
    prev.amount_cents += amount;
    prev.count += 1;
    map.set(key, prev);
    total += amount;
  }
  const byId = new Map((accounts || []).map((a) => [a.id, a]));
  const items = [];
  for (const [key, v] of map) {
    const acc = byId.get(key);
    items.push({
      account_id: v.account_id,
      name: acc ? acc.name : '未指定账户',
      icon: acc ? acc.icon || '💳' : '💳',
      type: acc ? acc.type : 'other',
      kind: acc ? acc.kind || 'asset' : 'asset',
      amount_cents: v.amount_cents,
      count: v.count,
      ratio: total > 0 ? v.amount_cents / total : 0,
    });
  }
  items.sort((a, b) => b.amount_cents - a.amount_cents);
  return items;
}

/** 按标签分组（契约 §2.6 /stats/by-tag，只统计支出，未打标签归 null） */
export function groupByTag(txs, tags = [], from, to, filters = {}) {
  const list = filterTx(txs, { ...filters, type: 'expense' }, from, to);
  const byId = new Map((tags || []).map((t) => [t.id, t]));
  const map = new Map();
  let total = 0;
  for (const tx of list) {
    const amount = Math.round(Number(tx.amount_cents) || 0);
    const ids = Array.isArray(tx.tags) && tx.tags.length ? tx.tags : [null];
    // 一条交易带多个标签时按标签数均摊，保证占比合计不超过 100%
    const share = amount / ids.length;
    for (const id of ids) {
      const prev = map.get(id) || { tag_id: id, amount_cents: 0, count: 0 };
      prev.amount_cents += share;
      prev.count += 1;
      map.set(id, prev);
      total += share;
    }
  }
  const items = [];
  for (const [id, v] of map) {
    const tag = byId.get(id);
    items.push({
      tag_id: id,
      name: tag ? tag.name : '未打标签',
      color: tag ? tag.color || null : null,
      icon: tag ? '🏷️' : '➖',
      amount_cents: Math.round(v.amount_cents),
      count: v.count,
      ratio: total > 0 ? v.amount_cents / total : 0,
    });
  }
  items.sort((a, b) => b.amount_cents - a.amount_cents);
  return items;
}

/** 涨跌幅：分母为 0 时返回 null（前端显示「—」） */
export function pctChange(current, previous) {
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (prev === 0) return cur === 0 ? 0 : null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

/** 环比（契约 §2.6 /stats/compare）：previous = 等长的前一个区间 */
export function compare(current, previous) {
  const cur = current || { income_cents: 0, expense_cents: 0, net_cents: 0, count: 0 };
  const prev = previous || { income_cents: 0, expense_cents: 0, net_cents: 0, count: 0 };
  return {
    current: cur,
    previous: prev,
    delta: {
      income_pct: pctChange(cur.income_cents, prev.income_cents),
      expense_pct: pctChange(cur.expense_cents, prev.expense_cents),
      net_cents: (Number(cur.net_cents) || 0) - (Number(prev.net_cents) || 0),
    },
  };
}

/** 日历热力（契约 §2.6 /stats/calendar）：只返回有数据的日期 */
export function calendar(txs, month, filters = {}) {
  const { from, to } = monthRange(month);
  const list = filterTx(txs, filters, from, to);
  const map = new Map();
  for (const tx of list) {
    const date = dateOf(tx);
    const prev = map.get(date) || { date, expense_cents: 0, income_cents: 0, count: 0 };
    if (tx.type === 'expense') prev.expense_cents += Math.round(Number(tx.amount_cents) || 0);
    if (tx.type === 'income') prev.income_cents += Math.round(Number(tx.amount_cents) || 0);
    prev.count += 1;
    map.set(date, prev);
  }
  return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** 报销统计（契约 §2.5 /stats/reimburse） */
export function reimburseSummary(txs, from, to) {
  const list = filterTx(txs, {}, from, to);
  let pendingCents = 0;
  let pendingCount = 0;
  let doneCents = 0;
  let doneCount = 0;
  const items = [];
  for (const tx of list) {
    if (tx.type !== 'expense' || !tx.reimburse_state) continue;
    const amount = Math.round(Number(tx.amount_cents) || 0);
    if (tx.reimburse_state === 'pending') {
      pendingCents += amount;
      pendingCount += 1;
    } else if (tx.reimburse_state === 'done') {
      doneCents += amount;
      doneCount += 1;
    }
    items.push(tx);
  }
  return { pending_cents: pendingCents, pending_count: pendingCount, done_cents: doneCents, done_count: doneCount, items };
}

/**
 * 预算结转（契约 §2.3）
 * carry(m) = R ? (A(m-1) + carry(m-1) - spent(m-1)) : 0，从该项最早月份递推到目标月，最多回溯 36 个月。
 * @param {object[]} budgets 全部预算行（含 rollover / month / category_id / amount_cents）
 * @param {Map<string, number>} spentByMonth  month → 已用金额（同口径：该分类 or 全部支出）
 */
export function carryIn(budgets, spentByMonth, month, categoryId = null) {
  const cid = categoryId || null;
  const rows = (budgets || []).filter((b) => (b.category_id || null) === cid);
  if (!rows.length) return 0;
  // spentByMonth 允许 Map 或普通对象（{ 'YYYY-MM': cents }）
  const spentOf = (m) => {
    if (!spentByMonth) return 0;
    if (typeof spentByMonth.get === 'function') return spentByMonth.get(m);
    return spentByMonth[m];
  };
  const byMonth = new Map(rows.map((b) => [b.month, b]));
  const earliest = rows.reduce((acc, b) => (acc && acc <= b.month ? acc : b.month), '');
  const target = String(month);
  let cur = earliest;
  let guard = 0;
  let carry = 0;
  while (cur < target && guard < 36) {
    const row = byMonth.get(cur);
    const rollover = row ? Number(row.rollover) === 1 : false;
    const amount = row ? Math.round(Number(row.amount_cents) || 0) : 0;
    const spent = Math.round(Number(spentOf(cur)) || 0);
    carry = rollover ? amount + carry - spent : 0;
    cur = addMonths(cur, 1);
    guard += 1;
  }
  return carry;
}

/**
 * 契约 §3 trend → [{bucket, income_cents, expense_cents}]，按时间升序，空桶补 0
 * @param {'day'|'week'|'month'} granularity
 */
export function trend(txs, from, to, granularity = 'day') {
  const buckets = new Map();
  const keys = [];
  if (granularity === 'month') {
    const start = monthOf(from);
    const end = monthOf(to || from);
    let cur = start;
    let guard = 0;
    while (cur <= end && guard < 240) {
      keys.push(cur);
      buckets.set(cur, { bucket: cur, income_cents: 0, expense_cents: 0 });
      cur = addMonths(cur, 1);
      guard += 1;
    }
  } else if (granularity === 'week') {
    const end = to || from;
    let cur = weekStart(from);
    let guard = 0;
    while (cur <= end && guard < 400) {
      keys.push(cur);
      buckets.set(cur, { bucket: cur, income_cents: 0, expense_cents: 0 });
      cur = addDays(cur, 7);
      guard += 1;
    }
  } else {
    for (const day of daysBetween(from, to)) {
      keys.push(day);
      buckets.set(day, { bucket: day, income_cents: 0, expense_cents: 0 });
    }
  }
  for (const tx of txs || []) {
    if (!affectsBalance(tx)) continue;
    const date = dateOf(tx);
    if (!inRange(date, from, to)) continue;
    const key = bucketOf(date, granularity);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    const amount = Math.round(Number(tx.amount_cents) || 0);
    if (tx.type === 'income') bucket.income_cents += amount;
    else bucket.expense_cents += amount;
  }
  return keys.map((k) => buckets.get(k));
}

/**
 * 预算进度
 * @returns {{used_cents:number, amount_cents:number, ratio:number, overspent:boolean, remaining_cents:number}}
 */
export function budgetProgress(usedCents, amountCents) {
  const used = Math.round(Number(usedCents) || 0);
  const amount = Math.round(Number(amountCents) || 0);
  const ratio = amount > 0 ? used / amount : 0;
  return {
    used_cents: used,
    amount_cents: amount,
    ratio,
    overspent: amount > 0 && used > amount,
    remaining_cents: amount - used,
  };
}

/** 预警阈值夹取到 1..100，缺失默认 10（v1.3 契约 §2.1） */
export function warnPercentOf(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return 10;
  return n > 100 ? 100 : n;
}

/** 剩余比例：available<=0 时记 0，可为负（v1.3 契约 §2.3） */
export function percentLeft(remainingCents, availableCents) {
  const remaining = Math.round(Number(remainingCents) || 0);
  const available = Math.round(Number(availableCents) || 0);
  if (available <= 0) return 0;
  return Math.round((remaining / available) * 1000) / 10;
}

/** warn_level：超支 > 剩余不足 > 正常 */
export function warnLevelOf(remainingCents, availableCents, warnPercent) {
  const remaining = Math.round(Number(remainingCents) || 0);
  if (remaining < 0) return 'over';
  return percentLeft(remaining, availableCents) <= warnPercentOf(warnPercent) ? 'warn' : 'ok';
}

/**
 * 预算视图（v1.3 契约 §2.3）：把每月的预算行（含总预算行与分类行）拼成一份视图。
 * 顶层：amount/used/available/remaining/carry、categories_sum、unallocated、mismatch、warn_percent、percent_left、warn_level
 * items：仅分类行，逐行补 percent_left / warn_level
 */
export function budgetView(rows = [], month = '') {
  const list = (rows || []).map((r) => ({ ...r }));
  const total = list.find((r) => !r.category_id) || null;
  const cats = list.filter((r) => !!r.category_id);
  const warnPercent = warnPercentOf(total ? total.warn_percent : 10);
  const categoriesSum = cats.reduce((acc, r) => acc + Math.max(0, Math.round(Number(r.amount_cents) || 0)), 0);
  const amount = total ? Math.max(0, Math.round(Number(total.amount_cents) || 0)) : 0;
  const unallocated = Math.max(0, amount - categoriesSum);
  const available = total
    ? Math.round(Number(total.available_cents != null ? total.available_cents : amount) || 0)
    : 0;
  const used = total ? Math.round(Number(total.used_cents) || 0) : 0;
  const remaining = total
    ? Math.round(Number(total.remaining_cents != null ? total.remaining_cents : available - used) || 0)
    : 0;
  // v1.3 口径：没有预算时 warn_level = 'none'、percent_left = null（不画进度、不出红橙状态）
  const hasTotal = !!total && amount > 0;
  return {
    month: month || (total ? total.month : '') || '',
    amount_cents: amount,
    used_cents: used,
    carry_in_cents: total ? Math.round(Number(total.carry_in_cents) || 0) : 0,
    available_cents: available,
    remaining_cents: remaining,
    rollover: total && (total.rollover === true || Number(total.rollover) === 1) ? 1 : 0,
    categories_sum_cents: categoriesSum,
    unallocated_cents: unallocated,
    mismatch: categoriesSum > 0 && unallocated > 0,
    warn_percent: warnPercent,
    percent_left: hasTotal ? percentLeft(remaining, available) : null,
    warn_level: hasTotal ? warnLevelOf(remaining, available, warnPercent) : 'none',
    items: cats
      .map((r) => {
        const itemAvailable = Math.round(
          Number(r.available_cents != null ? r.available_cents : r.amount_cents) || 0,
        );
        const itemUsed = Math.round(Number(r.used_cents) || 0);
        const itemRemaining = Math.round(
          Number(r.remaining_cents != null ? r.remaining_cents : itemAvailable - itemUsed) || 0,
        );
        const itemHasBudget = itemAvailable > 0;
        return {
          ...r,
          amount_cents: Math.max(0, Math.round(Number(r.amount_cents) || 0)),
          used_cents: itemUsed,
          available_cents: itemAvailable,
          remaining_cents: itemRemaining,
          percent_left: itemHasBudget ? percentLeft(itemRemaining, itemAvailable) : null,
          warn_level: itemHasBudget ? warnLevelOf(itemRemaining, itemAvailable, warnPercent) : 'none',
        };
      })
      .sort((a, b) => (a.percent_left == null ? 1e6 : a.percent_left) - (b.percent_left == null ? 1e6 : b.percent_left)),
    has_budget: hasTotal,
  };
}

/** 最近使用过的分类 id（记账页"最近 4 个"） */export function recentCategoryIds(txs, kind, limit = 4) {
  const seen = [];
  const sorted = (txs || [])
    .filter((tx) => isLive(tx) && tx.type === kind && tx.category_id)
    .sort((a, b) => {
      const ta = Date.parse(a.created_at || a.happened_at || '') || 0;
      const tb = Date.parse(b.created_at || b.happened_at || '') || 0;
      return tb - ta;
    });
  for (const tx of sorted) {
    if (!seen.includes(tx.category_id)) seen.push(tx.category_id);
    if (seen.length >= limit) break;
  }
  return seen;
}

/**
 * 账户余额重算（LocalStore 用）：初始余额 + 该账户所有交易影响
 * @param {object[]} accounts
 * @param {object[]} txs
 * @returns {Map<string, number>} accountId → balance_cents
 */
export function accountBalances(accounts, txs) {
  const effects = new Map();
  for (const acc of accounts || []) effects.set(acc.id, 0);
  for (const tx of txs || []) {
    if (!isLive(tx)) continue;
    const amount = Math.round(Number(tx.amount_cents) || 0);
    if (tx.type === 'expense') {
      if (effects.has(tx.account_id)) effects.set(tx.account_id, effects.get(tx.account_id) - amount);
    } else if (tx.type === 'income') {
      if (effects.has(tx.account_id)) effects.set(tx.account_id, effects.get(tx.account_id) + amount);
    } else if (tx.type === 'transfer') {
      if (effects.has(tx.account_id)) effects.set(tx.account_id, effects.get(tx.account_id) - amount);
      if (tx.to_account_id && effects.has(tx.to_account_id)) {
        effects.set(tx.to_account_id, effects.get(tx.to_account_id) + amount);
      }
    }
  }
  const out = new Map();
  for (const acc of accounts || []) {
    const initial = Number.isFinite(acc.initial_cents) ? acc.initial_cents : 0;
    out.set(acc.id, Math.round(initial + (effects.get(acc.id) || 0)));
  }
  return out;
}

// ------------------------------------------------------------ v1.2：账户分组 / 还款提醒 / 成员 / 月度

/** 契约 §4.1：分组顺序固定 */
export const GROUP_ORDER = ['cash', 'bank', 'ewallet', 'credit', 'invest', 'receivable', 'payable', 'other'];
export const GROUP_TITLE = {
  cash: '现金',
  bank: '储蓄卡',
  ewallet: '电子钱包',
  credit: '信用卡·信用付',
  invest: '投资',
  receivable: '应收',
  payable: '应付',
  other: '其他',
};

/** account.type → 分组 key（契约：只读派生字段 group） */
export function accountGroup(type) {
  return GROUP_ORDER.includes(type) ? type : 'other';
}

/**
 * 把账户按契约顺序分组。
 * @param {object[]} items listAssets().items
 * @returns {{key,title,items,subtotal_cents,count,liability:boolean}[]} 只返回有账户的组
 */
export function groupAccounts(items = []) {
  const buckets = new Map();
  for (const acc of items) {
    const key = accountGroup(acc.group || acc.type);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(acc);
  }
  const out = [];
  for (const key of GROUP_ORDER) {
    const rows = buckets.get(key);
    if (!rows || !rows.length) continue;
    const subtotal = rows.reduce((sum, a) => sum + Math.round(Number(a.balance_cents) || 0), 0);
    out.push({
      key,
      title: GROUP_TITLE[key] || '其他',
      items: rows,
      count: rows.length,
      subtotal_cents: subtotal,
      liability: key === 'credit' || key === 'payable',
    });
  }
  return out;
}

function shiftMonthDay(month, day) {
  const [y, m] = String(month).split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const d = Math.min(Math.max(Number(day) || 1, 1), last);
  return `${month}-${pad2(d)}`;
}

/**
 * 契约 §4.7：还款提醒。只算 kind=liability、used_cents>0、有 repay_day 的账户。
 * due_date 取本月还款日；已过则下月。days_left = due - today。
 */
export function reminders(accounts = [], today = todayISO()) {
  const out = [];
  for (const acc of accounts) {
    const kind = acc.kind || (acc.type === 'credit' || acc.type === 'payable' ? 'liability' : 'asset');
    const used = Math.max(0, Math.round(Number(acc.used_cents) || 0));
    const repayDay = Number(acc.repay_day) || 0;
    if (kind !== 'liability' || used <= 0 || !repayDay) continue;
    const month = monthOf(today);
    let due = shiftMonthDay(month, repayDay);
    if (due < today) due = shiftMonthDay(addMonths(month, 1), repayDay);
    // daysBetween 返回日期数组，这里要的是天数差：due 与 today 之间隔了几天
    const daysLeft = due < today ? -daysBetween(due, today).length : daysBetween(today, due).length - 1;
    const status = daysLeft < 0 ? 'overdue' : daysLeft === 0 ? 'today' : daysLeft <= 3 ? 'soon' : 'later';
    out.push({
      account_id: acc.id,
      name: acc.name,
      type: acc.type,
      icon: acc.icon,
      used_cents: used,
      credit_limit_cents: Math.round(Number(acc.credit_limit_cents) || 0),
      bill_day: Number(acc.bill_day) || 0,
      repay_day: repayDay,
      due_date: due,
      days_left: daysLeft,
      status,
    });
  }
  return out.sort((a, b) => a.days_left - b.days_left);
}

/** 最近 N 个自然月的收支（含当月，升序，空月补 0） */
export function monthlySeries(txs = [], months = 12, today = todayISO()) {
  const now = monthOf(today);
  const keys = [];
  for (let i = months - 1; i >= 0; i -= 1) keys.push(addMonths(now, -i));
  const map = new Map(keys.map((k) => [k, { month: k, expense_cents: 0, income_cents: 0 }]));
  for (const tx of txs) {
    if (!isLive(tx)) continue;
    if (tx.type !== 'expense' && tx.type !== 'income') continue;
    const bucket = map.get(monthOf(dateOf(tx)));
    if (!bucket) continue;
    const amount = Math.round(Number(tx.amount_cents) || 0);
    if (tx.type === 'expense') bucket.expense_cents += amount;
    else bucket.income_cents += amount;
  }
  return keys.map((k) => map.get(k));
}

/** 成员维度聚合（支出 + 收入 + 笔数），未指定成员的归到 name 为「我」的那条 */
export function memberStats(txs = [], members = [], from, to, filters = {}) {
  const rows = filterTx(txs, filters, from, to);
  const byId = new Map();
  const selfMember = (members || []).find((m) => Number(m.is_self) === 1) || null;
  for (const m of members || []) {
    byId.set(m.id, { member_id: m.id, member_name: m.name, color: m.color || '#2f9e8f', expense_cents: 0, income_cents: 0, count: 0 });
  }
  for (const tx of rows) {
    if (tx.type !== 'expense' && tx.type !== 'income') continue;
    const mid = tx.member_id || (selfMember ? selfMember.id : null);
    const key = mid || '__none__';
    if (!byId.has(key)) {
      byId.set(key, { member_id: mid || null, member_name: tx.member_name || (mid ? '未知成员' : '我'), color: '#8b98a3', expense_cents: 0, income_cents: 0, count: 0 });
    }
    const bucket = byId.get(key);
    const amount = Math.round(Number(tx.amount_cents) || 0);
    if (tx.type === 'expense') bucket.expense_cents += amount;
    else bucket.income_cents += amount;
    bucket.count += 1;
  }
  const list = [...byId.values()].filter((r) => r.count > 0 || r.member_id);
  const total = list.reduce((sum, r) => sum + r.expense_cents, 0);
  for (const r of list) r.ratio = total > 0 ? r.expense_cents / total : 0;
  return list.sort((a, b) => b.expense_cents - a.expense_cents || b.count - a.count);
}

/** 概览用：支出前 N 的成员 */
export function byMemberTop(txs = [], members = [], from, to, limit = 3) {
  return memberStats(txs, members, from, to)
    .filter((r) => r.expense_cents > 0)
    .slice(0, limit)
    .map((r) => ({ name: r.member_name, expense_cents: r.expense_cents, color: r.color }));
}
