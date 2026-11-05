// web/js/seed.js — 首次启动写入默认数据 + 15 条示例交易
// 幂等：meta['seeded'] 存在就跳过。示例数据带 is_sample:true，设置页可一键清空。

import { uid, nowISO, todayISO } from './util.js';
import { addMonths } from './stats.js';

export const SEED_VERSION = 2;

export const DEFAULT_LEDGER = { name: '我的账本', currency: 'CNY', budget_enabled: 0 };

/** 账户：名称 / 类型 / 归属(kind) / 初始余额（分） / 图标 */
export const DEFAULT_ACCOUNTS = [
  { name: '现金', type: 'cash', kind: 'asset', initial_cents: 50000, icon: '💵' },
  { name: '微信', type: 'ewallet', kind: 'asset', initial_cents: 128000, icon: '💬' },
  { name: '支付宝', type: 'ewallet', kind: 'asset', initial_cents: 256000, icon: '🅿️' },
  {
    name: '招商银行信用卡',
    type: 'credit',
    kind: 'liability',
    initial_cents: -320000,
    credit_limit_cents: 2000000,
    bill_day: 5,
    repay_day: 20,
    icon: '💳',
  },
  { name: '招商银行储蓄卡', type: 'bank', kind: 'asset', initial_cents: 1250000, icon: '🏦' },
  { name: '余额宝', type: 'invest', kind: 'asset', initial_cents: 800000, icon: '📈' },
  { name: '借给小李', type: 'receivable', kind: 'asset', initial_cents: 50000, icon: '🤝' },
];

/** 默认成员：我（is_self，不可删）+ 老婆 */
export const DEFAULT_MEMBERS = [
  { name: '我', is_self: 1, color: '#2f9e8f' },
  { name: '老婆', is_self: 0, color: '#e0788b' },
];

/** 支出分类 */
export const DEFAULT_EXPENSE_CATEGORIES = [
  { name: '餐饮', icon: '🍜' },
  { name: '交通', icon: '🚌' },
  { name: '购物', icon: '🛍️' },
  { name: '居住', icon: '🏠' },
  { name: '娱乐', icon: '🎮' },
  { name: '医疗', icon: '💊' },
  { name: '学习', icon: '📚' },
  { name: '人情', icon: '🎁' },
  { name: '其他', icon: '📦' },
];

/** 收入分类 */
export const DEFAULT_INCOME_CATEGORIES = [
  { name: '工资', icon: '💰' },
  { name: '奖金', icon: '🏆' },
  { name: '兼职', icon: '🧾' },
  { name: '投资收益', icon: '📈' },
  { name: '红包', icon: '🧧' },
  { name: '其他', icon: '✨' },
];

/** 15 条示例交易：d-ago 天前 / 分类名 / 账户名 / 金额元 / 备注 */
const SAMPLE_ROWS = [
  { ago: 0, type: 'expense', cat: '餐饮', acc: '微信', yuan: '28.50', note: '午饭 麻辣烫' },
  { ago: 0, type: 'expense', cat: '交通', acc: '支付宝', yuan: '6.00', note: '地铁' },
  { ago: 1, type: 'expense', cat: '餐饮', acc: '微信', yuan: '42.00', note: '和朋友吃火锅' },
  { ago: 2, type: 'expense', cat: '购物', acc: '招商银行信用卡', yuan: '199.00', note: '跑鞋' },
  { ago: 3, type: 'income', cat: '红包', acc: '微信', yuan: '66.00', note: '同事随礼' },
  { ago: 4, type: 'expense', cat: '居住', acc: '招商银行信用卡', yuan: '2600.00', note: '房租' },
  { ago: 5, type: 'expense', cat: '娱乐', acc: '支付宝', yuan: '58.00', note: '电影票' },
  { ago: 6, type: 'expense', cat: '学习', acc: '微信', yuan: '129.00', note: '技术书' },
  { ago: 8, type: 'expense', cat: '餐饮', acc: '现金', yuan: '15.00', note: '早餐' },
  { ago: 9, type: 'income', cat: '工资', acc: '支付宝', yuan: '12000.00', note: '月薪' },
  { ago: 10, type: 'expense', cat: '医疗', acc: '支付宝', yuan: '86.40', note: '感冒药' },
  { ago: 12, type: 'expense', cat: '人情', acc: '微信', yuan: '200.00', note: '同事生日' },
  { ago: 15, type: 'income', cat: '投资收益', acc: '余额宝', yuan: '31.20', note: '七日年化' },
  { ago: 18, type: 'expense', cat: '交通', acc: '支付宝', yuan: '120.00', note: '打车去机场' },
  { ago: 21, type: 'expense', cat: '购物', acc: '招商银行信用卡', yuan: '328.00', note: '冬衣' },
];

function daysAgoISO(ago) {
  const d = new Date();
  d.setDate(d.getDate() - ago);
  return todayISO(d);
}

/**
 * 首次启动 seed。已 seed 过直接返回 null。
 * @param {object} st store 门面（需 createLedger/createAccount/createCategory/createTransaction）
 */
export async function ensureSeed(st) {
  const done = await st.getMeta('seeded', null);
  if (done) return null;
  return seedDefaults(st, { reason: 'first-run' });
}

/**
 * 写入默认账本 / 账户 / 分类 / 示例交易。
 * @param {object} st
 * @param {{onlyIfEmpty?: boolean, reason?: string}} opts
 */
export async function seedDefaults(st, opts = {}) {
  const existing = await st.listLedgers();
  if (opts.onlyIfEmpty && existing.length) return null;

  const now = nowISO();
  let ledger = existing.find((l) => l.is_default) || existing[0];
  if (!ledger) {
    ledger = await st.createLedger({ ...DEFAULT_LEDGER, is_default: true, created_at: now });
  }
  const ledgerId = ledger.id;

  // 成员：每个账本恰好一条 is_self（契约 §1）
  let selfMember = null;
  if (typeof st.ensureSelfMember === 'function') selfMember = await st.ensureSelfMember(ledgerId);
  if (typeof st.listMembers === 'function') {
    const have = await st.listMembers(ledgerId);
    for (const def of DEFAULT_MEMBERS) {
      if (have.some((m) => m.name === def.name)) continue;
      await st.createMember({ ...def, ledger_id: ledgerId });
    }
  }

  const accounts = [];
  for (let i = 0; i < DEFAULT_ACCOUNTS.length; i += 1) {
    const def = DEFAULT_ACCOUNTS[i];
    const row = await st.createAccount({
      ledger_id: ledgerId,
      name: def.name,
      type: def.type,
      kind: def.kind,
      initial_cents: def.initial_cents,
      balance_cents: def.initial_cents,
      credit_limit_cents: def.credit_limit_cents || 0,
      bill_day: def.bill_day || 0,
      repay_day: def.repay_day || 0,
      icon: def.icon,
      sort: i,
      include_in_net: true,
    });
    accounts.push(row);
  }

  const categories = [];
  let sort = 0;
  for (const def of DEFAULT_EXPENSE_CATEGORIES) {
    categories.push(
      await st.createCategory({
        ledger_id: ledgerId,
        name: def.name,
        kind: 'expense',
        icon: def.icon,
        sort: sort += 1,
      }),
    );
  }
  sort = 0;
  for (const def of DEFAULT_INCOME_CATEGORIES) {
    categories.push(
      await st.createCategory({
        ledger_id: ledgerId,
        name: def.name,
        kind: 'income',
        icon: def.icon,
        sort: sort += 1,
      }),
    );
  }

  const accByName = new Map(accounts.map((a) => [a.name, a]));
  const catByKey = new Map(categories.map((c) => [`${c.kind}:${c.name}`, c]));

  let inserted = 0;
  for (const row of SAMPLE_ROWS) {
    const cat = catByKey.get(`${row.type}:${row.cat}`);
    const acc = accByName.get(row.acc);
    if (!cat || !acc) continue;
    const cents = Math.round(Number(row.yuan) * 100);
    await st.createTransaction({
      ledger_id: ledgerId,
      type: row.type,
      amount_cents: cents,
      category_id: cat.id,
      account_id: acc.id,
      to_account_id: null,
      note: row.note,
      happened_at: daysAgoISO(row.ago),
      source: 'auto',
      member_id: selfMember ? selfMember.id : null,
      is_sample: true,
    });
    inserted += 1;
  }

  // 当月预算：总预算 4500 元，餐饮 1200，交通 300，购物 800
  const month = todayISO().slice(0, 7);
  await st.setBudget({ ledger_id: ledgerId, month, category_id: null, amount_cents: 450000 });
  const budgetCats = ['餐饮', '交通', '购物'];
  const budgetAmounts = [120000, 30000, 80000];
  for (let i = 0; i < budgetCats.length; i += 1) {
    const cat = catByKey.get(`expense:${budgetCats[i]}`);
    if (cat) {
      await st.setBudget({ ledger_id: ledgerId, month, category_id: cat.id, amount_cents: budgetAmounts[i] });
    }
  }

  // 契约 v1.3.2：种子数据带预算金额，但总开关保持关闭（用户自己去「预算」页开）
  await st.updateLedger(ledgerId, { budget_enabled: 0 });

  await st.setMeta('seeded', { at: now, version: SEED_VERSION, ledger_id: ledgerId });
  await st.setMeta('sample_transactions', inserted);
  return { ledgerId, accounts: accounts.length, categories: categories.length, transactions: inserted };
}

/** 清空示例交易（软删） */
export async function clearSampleData(st) {
  return st.clearSampleData();
}

/** 上月/本月字符串，报表页月份切换用 */
export function shiftMonth(month, delta) {
  return addMonths(month, delta);
}
