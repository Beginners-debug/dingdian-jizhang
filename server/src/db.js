// MintLite server · 数据层
// node:sqlite（DatabaseSync）单文件库 + WAL + 外键；首次启动自动建表与 demo 种子数据。
// v1.1：accounts 增加 kind/credit_limit_cents、budgets 增加 rollover、transactions 增加报销字段，
//       新增 tags / transaction_tags / recurring_rules。所有变更都走幂等迁移（PRAGMA table_info 判断后再 ALTER）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword, dataDir } from './auth.js';

export const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(dataDir, 'mintlite.db');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

/* --------------------------------- 小工具 --------------------------------- */

export const newId = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

/** 每个账本默认的「我」成员（seed / 新建账本 / 迁移回填共用） */
export const SELF_MEMBER = { name: '我', color: '#2f9e8f' };

/** 真实事务包装：BEGIN IMMEDIATE … COMMIT / ROLLBACK */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/* ---------------------------------- 表结构 --------------------------------- */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledgers (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  currency   TEXT NOT NULL DEFAULT 'CNY',
  is_default INTEGER NOT NULL DEFAULT 0,
  archived   INTEGER NOT NULL DEFAULT 0,
  sort       INTEGER NOT NULL DEFAULT 0,
  budget_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id                 TEXT PRIMARY KEY,
  ledger_id          TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  type               TEXT NOT NULL DEFAULT 'other',
  kind               TEXT NOT NULL DEFAULT 'asset',
  balance_cents      INTEGER NOT NULL DEFAULT 0,
  credit_limit_cents INTEGER NOT NULL DEFAULT 0,
  icon               TEXT,
  sort               INTEGER NOT NULL DEFAULT 0,
  include_in_net     INTEGER NOT NULL DEFAULT 1,
  bill_day           INTEGER,
  repay_day          INTEGER,
  hidden             INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  deleted_at         TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id         TEXT PRIMARY KEY,
  ledger_id  TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'expense',
  icon       TEXT,
  sort       INTEGER NOT NULL DEFAULT 0,
  parent_id  TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
  id              TEXT PRIMARY KEY,
  ledger_id       TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  amount_cents    INTEGER NOT NULL,
  category_id     TEXT,
  account_id      TEXT,
  to_account_id   TEXT,
  note            TEXT,
  happened_at     TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'manual',
  external_id     TEXT,
  reimburse_state TEXT,
  reimburse_at    TEXT,
  member_id       TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);

CREATE TABLE IF NOT EXISTS budgets (
  id           TEXT PRIMARY KEY,
  ledger_id    TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  month        TEXT NOT NULL,
  category_id  TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  rollover     INTEGER NOT NULL DEFAULT 0,
  warn_percent INTEGER NOT NULL DEFAULT 10,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id         TEXT PRIMARY KEY,
  ledger_id  TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS transaction_tags (
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  tag_id         TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (transaction_id, tag_id)
);

CREATE TABLE IF NOT EXISTS recurring_rules (
  id            TEXT PRIMARY KEY,
  ledger_id     TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL,
  category_id   TEXT,
  account_id    TEXT,
  to_account_id TEXT,
  note          TEXT,
  freq          TEXT NOT NULL,
  interval      INTEGER NOT NULL DEFAULT 1,
  start_date    TEXT NOT NULL,
  end_date      TEXT,
  next_run      TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_run      TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);

CREATE TABLE IF NOT EXISTS members (
  id         TEXT PRIMARY KEY,
  ledger_id  TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT,
  is_self    INTEGER NOT NULL DEFAULT 0,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_ledgers_user ON ledgers (user_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_accounts_ledger ON accounts (ledger_id, sort, created_at);
CREATE INDEX IF NOT EXISTS idx_categories_ledger ON categories (ledger_id, kind, sort, created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_ledger_happened ON transactions (ledger_id, happened_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_ledger_deleted ON transactions (ledger_id, deleted_at, happened_at);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions (ledger_id, category_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_external
  ON transactions (ledger_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_budgets_ledger_month ON budgets (ledger_id, month);
CREATE UNIQUE INDEX IF NOT EXISTS uq_budgets ON budgets (ledger_id, month, category_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_ledger_name ON tags (ledger_id, name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_transaction_tags_tag ON transaction_tags (tag_id);
CREATE INDEX IF NOT EXISTS idx_recurring_due ON recurring_rules (ledger_id, enabled, next_run);
CREATE INDEX IF NOT EXISTS idx_members_ledger ON members (ledger_id, sort, created_at);
CREATE INDEX IF NOT EXISTS idx_members_ledger_self ON members (ledger_id, is_self);
`;

/* --------------------------------- 幂等迁移 -------------------------------- */

function tableColumns(table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
  } catch {
    return [];
  }
}

/** 缺列才 ALTER，返回是否真的改了结构 */
function addColumn(table, column, ddl) {
  if (tableColumns(table).includes(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}

/**
 * 老库原地升级（幂等，可反复执行）。
 * 整个迁移包在一个事务里：要么全成功，要么原样回滚，绝不会留下半升级的库。
 * @returns {{upgraded:boolean, changed:string[], membersAdded:number, fromVersion:number, toVersion:number}}
 */
export function migrate() {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = migrateSchema();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function migrateSchema() {
  const changed = [];
  if (addColumn('accounts', 'kind', "kind TEXT NOT NULL DEFAULT 'asset'")) changed.push('accounts.kind');
  if (addColumn('accounts', 'credit_limit_cents', 'credit_limit_cents INTEGER NOT NULL DEFAULT 0')) {
    changed.push('accounts.credit_limit_cents');
  }
  if (addColumn('budgets', 'rollover', 'rollover INTEGER NOT NULL DEFAULT 0')) changed.push('budgets.rollover');
  if (addColumn('transactions', 'reimburse_state', 'reimburse_state TEXT')) changed.push('transactions.reimburse_state');
  if (addColumn('transactions', 'reimburse_at', 'reimburse_at TEXT')) changed.push('transactions.reimburse_at');

  // v1.2：资产体系（账单日/还款日/隐藏）+ 多账本（archived/sort）+ 成员维度
  if (addColumn('accounts', 'sort', 'sort INTEGER NOT NULL DEFAULT 0')) changed.push('accounts.sort');
  if (addColumn('accounts', 'bill_day', 'bill_day INTEGER')) changed.push('accounts.bill_day');
  if (addColumn('accounts', 'repay_day', 'repay_day INTEGER')) changed.push('accounts.repay_day');
  if (addColumn('accounts', 'hidden', 'hidden INTEGER NOT NULL DEFAULT 0')) changed.push('accounts.hidden');
  if (addColumn('ledgers', 'is_default', 'is_default INTEGER NOT NULL DEFAULT 0')) changed.push('ledgers.is_default');
  if (addColumn('ledgers', 'archived', 'archived INTEGER NOT NULL DEFAULT 0')) changed.push('ledgers.archived');
  if (addColumn('ledgers', 'sort', 'sort INTEGER NOT NULL DEFAULT 0')) changed.push('ledgers.sort');
  if (addColumn('ledgers', 'budget_enabled', 'budget_enabled INTEGER NOT NULL DEFAULT 0')) {
    changed.push('ledgers.budget_enabled');
  }
  if (addColumn('transactions', 'member_id', 'member_id TEXT')) changed.push('transactions.member_id');

  // v1.3：预算预警阈值（只对总预算行生效，1..100）
  if (addColumn('budgets', 'warn_percent', 'warn_percent INTEGER NOT NULL DEFAULT 10')) {
    changed.push('budgets.warn_percent');
  }

  // 老库兜底：user_version 可能是 0（v1.1 之前从未写过）
  const prevVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0) || 0;

  // 新表 / 新索引（IF NOT EXISTS 天然幂等）
  db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_ledger_name ON tags (ledger_id, name) WHERE deleted_at IS NULL;
    CREATE TABLE IF NOT EXISTS transaction_tags (
      transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (transaction_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_transaction_tags_tag ON transaction_tags (tag_id);
    CREATE TABLE IF NOT EXISTS recurring_rules (
      id TEXT PRIMARY KEY,
      ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      category_id TEXT,
      account_id TEXT,
      to_account_id TEXT,
      note TEXT,
      freq TEXT NOT NULL,
      interval INTEGER NOT NULL DEFAULT 1,
      start_date TEXT NOT NULL,
      end_date TEXT,
      next_run TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_recurring_due ON recurring_rules (ledger_id, enabled, next_run);
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT,
      is_self INTEGER NOT NULL DEFAULT 0,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_members_ledger ON members (ledger_id, sort, created_at);
    CREATE INDEX IF NOT EXISTS idx_members_ledger_self ON members (ledger_id, is_self);
    CREATE INDEX IF NOT EXISTS idx_transactions_member ON transactions (ledger_id, member_id);
  `);

  // 信用卡语义不变：仍是负债
  db.exec("UPDATE accounts SET kind = 'liability' WHERE type = 'credit' AND kind = 'asset'");

  // v1.2：每个账本必须有且仅有一条 is_self 成员，并把历史交易的 member_id 回填到它
  const membersAdded = ensureSelfMembers();

  // 结构 / 成员都对齐后把版本号推到 4（重复执行为空操作）
  if (prevVersion < 5) db.exec('PRAGMA user_version = 5');
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0) || 0;

  const upgraded = changed.length > 0;
  if (upgraded) {
    // 一次性数据整备：v0.1 里微信 / 支付宝记成 other，v1.1 归到 ewallet
    db.exec("UPDATE accounts SET type = 'ewallet' WHERE type = 'other' AND name IN ('微信', '支付宝')");
  }
  // 每次启动都跑一遍：纯增量补齐（缺默认账户 / 标签、信用卡额度为 0），已存在的不动
  ensureDemoAccounts();
  return { upgraded, changed, membersAdded, fromVersion: prevVersion, toVersion: version };
}

/**
 * 每个账本补一条 `{name:'我', is_self:1}`，并把 member_id 为空的交易挂到它上面。
 * 幂等：已有 is_self 成员就复用，不再新增。
 */
export function ensureSelfMembers() {
  const at = nowIso();
  const ledgers = db.prepare('SELECT id FROM ledgers').all();
  const findSelf = db.prepare('SELECT id FROM members WHERE ledger_id = ? AND is_self = 1 AND deleted_at IS NULL LIMIT 1');
  const insSelf = db.prepare(
    `INSERT INTO members (id, ledger_id, name, color, is_self, sort, created_at, updated_at, deleted_at)
     VALUES (?,?,?,?,1,0,?,?,NULL)`,
  );
  const backfill = db.prepare('UPDATE transactions SET member_id = ? WHERE ledger_id = ? AND member_id IS NULL');
  let added = 0;
  for (const l of ledgers) {
    let selfId = findSelf.get(l.id)?.id;
    if (!selfId) {
      selfId = newId();
      insSelf.run(selfId, l.id, SELF_MEMBER.name, SELF_MEMBER.color, at, at);
      added += 1;
    }
    backfill.run(selfId, l.id);
  }
  return added;
}

/* --------------------------------- 默认模板 --------------------------------- */

const DEFAULT_ACCOUNTS = [
  { name: '现金', type: 'cash', kind: 'asset', icon: '💵', sort: 0, demoBalance: 30000 },
  { name: '微信', type: 'ewallet', kind: 'asset', icon: '💬', sort: 1, demoBalance: 150000 },
  { name: '支付宝', type: 'ewallet', kind: 'asset', icon: '🔷', sort: 2, demoBalance: 50000 },
  {
    name: '招商银行信用卡',
    type: 'credit',
    kind: 'liability',
    icon: '💳',
    sort: 3,
    demoBalance: 0,
    creditLimit: 2000000,
    billDay: 5,
    repayDay: 20,
  },
  { name: '余额宝', type: 'invest', kind: 'asset', icon: '📈', sort: 4, demoBalance: 1200000 },
  {
    name: '花呗',
    type: 'credit',
    kind: 'liability',
    icon: '🌸',
    sort: 5,
    demoBalance: 0,
    creditLimit: 500000,
    billDay: 1,
    repayDay: 10,
  },
  {
    name: '借呗',
    type: 'credit',
    kind: 'liability',
    icon: '🏦',
    sort: 6,
    demoBalance: 0,
    creditLimit: 1000000,
    billDay: 1,
    repayDay: 10,
  },
  { name: '应收款', type: 'receivable', kind: 'asset', icon: '🧾', sort: 7, demoBalance: 0 },
  { name: '应付款', type: 'payable', kind: 'liability', icon: '📄', sort: 8, demoBalance: 0 },
];

const DEFAULT_CATEGORIES = [
  { name: '餐饮', kind: 'expense', icon: '🍜' },
  { name: '交通', kind: 'expense', icon: '🚌' },
  { name: '购物', kind: 'expense', icon: '🛍️' },
  { name: '居住', kind: 'expense', icon: '🏠' },
  { name: '娱乐', kind: 'expense', icon: '🎮' },
  { name: '医疗', kind: 'expense', icon: '💊' },
  { name: '学习', kind: 'expense', icon: '📚' },
  { name: '人情', kind: 'expense', icon: '🎁' },
  { name: '其他', kind: 'expense', icon: '📦' },
  { name: '工资', kind: 'income', icon: '💰' },
  { name: '奖金', kind: 'income', icon: '🏆' },
  { name: '兼职', kind: 'income', icon: '🧑‍💻' },
  { name: '投资收益', kind: 'income', icon: '📈' },
  { name: '红包', kind: 'income', icon: '🧧' },
  { name: '其他', kind: 'income', icon: '📦' },
];

const DEFAULT_TAGS = [
  { name: '家庭', color: '#4C9AFF' },
  { name: '出差', color: '#FF8B00' },
  { name: '待报销', color: '#FF5630' },
];

/**
 * 建一个默认账本（含默认账户 / 分类）。
 * @param {string} userId
 * @param {{name?:string, currency?:string, withBalances?:boolean, isDefault?:boolean, sort?:number, withTags?:boolean}} [opts]
 * @returns {{ledgerId:string, accounts:Map<string,string>, categories:Map<string,Map<string,string>>, tags:Map<string,string>, selfMemberId:string}}
 */
export function createDefaultLedger(userId, opts = {}) {
  const {
    name = '日常账本',
    currency = 'CNY',
    withBalances = false,
    isDefault = true,
    sort = 0,
    withTags = true,
  } = opts;
  const at = nowIso();
  const ledgerId = newId();

  // 预算总开关默认关闭（v1.3.2）：新账本 / 种子账本都显式写 0
  db.prepare(
    'INSERT INTO ledgers (id, user_id, name, currency, is_default, archived, sort, budget_enabled, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,0,?,0,?,?,NULL)',
  ).run(ledgerId, userId, name, currency, isDefault ? 1 : 0, sort, at, at);

  const insAccount = db.prepare(
    `INSERT INTO accounts (id, ledger_id, name, type, kind, balance_cents, credit_limit_cents, icon, sort, include_in_net,
       bill_day, repay_day, hidden, created_at, updated_at, deleted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,NULL)`,
  );
  const accounts = new Map();
  for (const a of DEFAULT_ACCOUNTS) {
    const id = newId();
    accounts.set(a.name, id);
    insAccount.run(
      id,
      ledgerId,
      a.name,
      a.type,
      a.kind,
      withBalances ? a.demoBalance : 0,
      a.creditLimit ?? 0,
      a.icon,
      a.sort,
      1,
      a.billDay ?? null,
      a.repayDay ?? null,
      at,
      at,
    );
  }

  const insCategory = db.prepare(
    'INSERT INTO categories (id, ledger_id, name, kind, icon, sort, parent_id, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,NULL,?,?,NULL)',
  );
  const categories = new Map([
    ['expense', new Map()],
    ['income', new Map()],
  ]);
  for (const c of DEFAULT_CATEGORIES) {
    const bucket = categories.get(c.kind);
    if (!bucket) continue;
    // 同名不同 kind 的（「其他」）各存一份；同名同 kind 只留第一个
    if (bucket.has(c.name)) continue;
    const id = newId();
    bucket.set(c.name, id);
    insCategory.run(id, ledgerId, c.name, c.kind, c.icon, bucket.size - 1, at, at);
  }

  const insTag = db.prepare(
    'INSERT INTO tags (id, ledger_id, name, color, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,NULL)',
  );
  const tags = new Map();
  for (const t of withTags ? DEFAULT_TAGS : []) {
    const id = newId();
    tags.set(t.name, id);
    insTag.run(id, ledgerId, t.name, t.color, at, at);
  }

  // v1.2：每个账本自带一个「我」成员
  const insMember = db.prepare(
    `INSERT INTO members (id, ledger_id, name, color, is_self, sort, created_at, updated_at, deleted_at)
     VALUES (?,?,?,?,1,0,?,?,NULL)`,
  );
  const selfMemberId = newId();
  insMember.run(selfMemberId, ledgerId, SELF_MEMBER.name, SELF_MEMBER.color, at, at);

  return { ledgerId, accounts, categories, tags, selfMemberId };
}

/**
 * 老库升级时补种子账户：只补「默认清单里还没有」的，不动用户已有数据。
 * 只对 demo 用户的账本执行（其他用户的删卡行为不该被复活）。
 */
export function ensureDemoAccounts() {
  const demo = db.prepare("SELECT id FROM users WHERE username = 'demo'").get();
  if (!demo) return 0;
  const ledgers = db.prepare('SELECT id FROM ledgers WHERE user_id = ? AND deleted_at IS NULL').all(demo.id);
  const ins = db.prepare(
    `INSERT INTO accounts (id, ledger_id, name, type, kind, balance_cents, credit_limit_cents, icon, sort, include_in_net,
       bill_day, repay_day, hidden, created_at, updated_at, deleted_at)
     VALUES (?,?,?,?,?,?,?,?,?,1,?,?,0,?,?,NULL)`,
  );
  const at = nowIso();
  let added = 0;
  for (const { id: ledgerId } of ledgers) {
    const names = new Set(
      db.prepare('SELECT name FROM accounts WHERE ledger_id = ? AND deleted_at IS NULL').all(ledgerId).map((r) => r.name),
    );
    for (const a of DEFAULT_ACCOUNTS) {
      if (names.has(a.name)) {
        // 已存在的默认账户：老库 credit_limit_cents 刚 ALTER 出来是 0，补成默认额度
        if (Number(a.creditLimit) > 0) {
          db.prepare(
            'UPDATE accounts SET credit_limit_cents = ?, updated_at = ? WHERE ledger_id = ? AND name = ? AND credit_limit_cents = 0 AND deleted_at IS NULL',
          ).run(Number(a.creditLimit), at, ledgerId, a.name);
        }
        // v1.2：老库信用账户没有账单日/还款日，补默认值（还款提醒才不是空）
        if (a.repayDay != null) {
          db.prepare(
            `UPDATE accounts SET bill_day = COALESCE(bill_day, ?), repay_day = COALESCE(repay_day, ?), updated_at = ?
              WHERE ledger_id = ? AND name = ? AND deleted_at IS NULL`,
          ).run(Number(a.billDay ?? null), Number(a.repayDay), at, ledgerId, a.name);
        }
        continue;
      }
      ins.run(
        newId(),
        ledgerId,
        a.name,
        a.type,
        a.kind,
        0,
        a.creditLimit ?? 0,
        a.icon,
        a.sort,
        a.billDay ?? null,
        a.repayDay ?? null,
        at,
        at,
      );
      added += 1;
    }
    // 老库升级时标签表是空的，给 demo 账本补上默认标签，前端标签筛选才不是空列表
    const tagNames = new Set(
      db.prepare('SELECT name FROM tags WHERE ledger_id = ? AND deleted_at IS NULL').all(ledgerId).map((r) => r.name),
    );
    for (const t of DEFAULT_TAGS) {
      if (tagNames.has(t.name)) continue;
      db.prepare(
        'INSERT INTO tags (id, ledger_id, name, color, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,NULL)',
      ).run(newId(), ledgerId, t.name, t.color, at, at);
      added += 1;
    }
    // 老库没有周期规则，周期页会空着：只要该账本一条规则都没有（含已删）就补一条演示用房租
    const anyRule = db.prepare('SELECT 1 AS x FROM recurring_rules WHERE ledger_id = ? LIMIT 1').get(ledgerId);
    if (!anyRule) {
      const now = new Date();
      const y = now.getUTCFullYear();
      const m = now.getUTCMonth(); // 0-based
      const thisMonth = `${y}-${pad2(m + 1)}-01`;
      const nextMonth = `${m === 11 ? y + 1 : y}-${pad2(m === 11 ? 1 : m + 2)}-01`;
      const account = db
        .prepare("SELECT id FROM accounts WHERE ledger_id = ? AND name = '支付宝' AND deleted_at IS NULL")
        .get(ledgerId);
      const category = db
        .prepare("SELECT id FROM categories WHERE ledger_id = ? AND name = '居住' AND kind = 'expense' AND deleted_at IS NULL")
        .get(ledgerId);
      db.prepare(
        `INSERT INTO recurring_rules (id, ledger_id, type, amount_cents, category_id, account_id, to_account_id, note,
                                      freq, "interval", start_date, end_date, next_run, enabled, last_run, created_at, updated_at, deleted_at)
         VALUES (?,?,?,?,?,?,NULL,?,?,1,?,NULL,?,1,NULL,?,?,NULL)`,
      ).run(
        newId(),
        ledgerId,
        'expense',
        350000,
        category?.id ?? null,
        account?.id ?? null,
        '房租',
        'monthly',
        thisMonth,
        nextMonth,
        at,
        at,
      );
      added += 1;
    }
  }
  return added;
}

/* ------------------------------- 账户余额影响 ------------------------------- */

/**
 * 把一条交易对账户余额的影响施加到 accounts.balance_cents。
 * expense 减 account_id / income 加 account_id / transfer 减 account_id 加 to_account_id。
 * type='adjust' 是「余额直接改成目标值」的审计流水，由 /accounts/:id/adjust 自己写余额，这里不动。
 * @param {object} t 交易行（需要 type, amount_cents, account_id, to_account_id）
 * @param {1|-1} sign 1=施加，-1=回滚
 */
export function applyTxEffect(t, sign = 1) {
  const base = Number(t.amount_cents);
  if (!Number.isFinite(base)) return;
  const amt = Math.trunc(base) * (sign < 0 ? -1 : 1);
  const at = nowIso();
  const upd = db.prepare('UPDATE accounts SET balance_cents = balance_cents + ?, updated_at = ? WHERE id = ?');
  if (t.type === 'income') {
    if (t.account_id) upd.run(amt, at, t.account_id);
  } else if (t.type === 'expense') {
    if (t.account_id) upd.run(-amt, at, t.account_id);
  } else if (t.type === 'transfer') {
    if (t.account_id) upd.run(-amt, at, t.account_id);
    if (t.to_account_id) upd.run(amt, at, t.to_account_id);
  }
}

/* ---------------------------------- 种子 ---------------------------------- */

const pad2 = (n) => String(n).padStart(2, '0');

function localDate(daysAgo) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// [daysAgo, type, amount_cents, category, account, toAccount, note, extra?]
const DEMO_TRANSACTIONS = [
  [0, 'expense', 2350, '餐饮', '微信', null, '午饭 牛肉面'],
  [0, 'expense', 600, '交通', '支付宝', null, '地铁通勤'],
  [1, 'expense', 12900, '购物', '招商银行信用卡', null, '秋装卫衣'],
  [1, 'expense', 1800, '餐饮', '微信', null, '早餐豆浆油条'],
  [2, 'expense', 5800, '餐饮', '微信', null, '同事聚餐 AA', { tags: ['家庭'] }],
  [2, 'income', 1850000, '工资', '支付宝', null, '11 月工资'],
  [3, 'expense', 990, '交通', '支付宝', null, '共享单车月卡'],
  [3, 'expense', 26800, '居住', '招商银行信用卡', null, '水电燃气', { tags: ['家庭'] }],
  [4, 'expense', 4500, '娱乐', '微信', null, '电影票两张'],
  [4, 'expense', 32000, '学习', '支付宝', null, '技术书两本', { reimburse: 'pending', tags: ['待报销'] }],
  [5, 'expense', 1200, '餐饮', '现金', null, '楼下早餐'],
  [5, 'transfer', 50000, null, '支付宝', '余额宝', '转入余额宝'],
  [6, 'expense', 19800, '医疗', '招商银行信用卡', null, '感冒药 + 挂号'],
  [7, 'expense', 6600, '餐饮', '微信', null, '周末早茶'],
  [8, 'income', 20000, '红包', '微信', null, '朋友生日红包'],
  [9, 'expense', 15800, '人情', '微信', null, '同事结婚随礼'],
  [10, 'expense', 38800, '购物', '招商银行信用卡', null, '空气炸锅'],
  [12, 'expense', 150000, '居住', '支付宝', null, '房租', { tags: ['家庭'] }],
  [14, 'income', 30000, '兼职', '支付宝', null, '设计外包尾款'],
  [16, 'expense', 2500, '交通', '支付宝', null, '打车', { tags: ['出差'] }],
  [18, 'expense', 8800, '餐饮', '微信', null, '火锅'],
  [20, 'income', 150000, '投资收益', '余额宝', null, '基金分红'],
  [22, 'expense', 9900, '娱乐', '招商银行信用卡', null, '剧本杀'],
  [25, 'expense', 4200, '其他', '现金', null, '停车费'],
  [28, 'expense', 7600, '学习', '支付宝', null, '网课订阅'],
];

function seedDemo() {
  const at = nowIso();
  const userId = newId();
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?,?,?,?)').run(
    userId,
    'demo',
    hashPassword('demo1234'),
    at,
  );

  const { ledgerId, accounts, categories, tags } = createDefaultLedger(userId, {
    name: '日常账本',
    withBalances: true,
  });

  const insTx = db.prepare(
    `INSERT INTO transactions (id, ledger_id, type, amount_cents, category_id, account_id, to_account_id, note, happened_at,
       source, external_id, reimburse_state, reimburse_at, created_at, updated_at, deleted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
  );
  const insTxTag = db.prepare('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?,?)');

  for (const [daysAgo, type, amount, catName, accName, toAccName, note, extra] of DEMO_TRANSACTIONS) {
    const date = localDate(daysAgo);
    const row = {
      id: newId(),
      ledger_id: ledgerId,
      type,
      amount_cents: amount,
      category_id: type === 'transfer' ? null : categories.get(type)?.get(catName) ?? null,
      account_id: accounts.get(accName) ?? null,
      to_account_id: toAccName ? accounts.get(toAccName) ?? null : null,
      note,
      happened_at: date,
      source: 'manual',
      external_id: null,
    };
    insTx.run(
      row.id,
      row.ledger_id,
      row.type,
      row.amount_cents,
      row.category_id,
      row.account_id,
      row.to_account_id,
      row.note,
      row.happened_at,
      row.source,
      row.external_id,
      extra?.reimburse ?? null,
      extra?.reimburse === 'done' ? date : null,
      `${date}T12:00:00.000Z`,
      `${date}T12:00:00.000Z`,
    );
    applyTxEffect(row, 1);
    for (const tagName of extra?.tags ?? []) {
      const tagId = tags.get(tagName);
      if (tagId) insTxTag.run(row.id, tagId);
    }
  }

  // 一条周期记账样例：每月 1 号房租，下次执行放下个月 1 号
  const d = new Date();
  const next = new Date(d.getFullYear(), d.getMonth() + 1, 1, 12, 0, 0, 0);
  const nextRun = `${next.getFullYear()}-${pad2(next.getMonth() + 1)}-01`;
  db.prepare(
    `INSERT INTO recurring_rules (id, ledger_id, type, amount_cents, category_id, account_id, to_account_id, note, freq, interval,
       start_date, end_date, next_run, enabled, last_run, created_at, updated_at, deleted_at)
     VALUES (?,?,?,?,?,?,NULL,?,?,1,?,NULL,?,1,NULL,?,?,NULL)`,
  ).run(
    newId(),
    ledgerId,
    'expense',
    150000,
    categories.get('expense')?.get('居住') ?? null,
    accounts.get('支付宝') ?? null,
    '房租',
    'monthly',
    nextRun,
    nextRun,
    at,
    at,
  );
}

/* ---------------------------------- 初始化 --------------------------------- */

let initialized = false;

export function initDb() {
  if (initialized) return db;
  db.exec(SCHEMA);
  migrate();
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (!n) {
    tx(() => seedDemo());
  }
  // 种子 / 老库都过一遍：每个账本有「我」成员，交易 member_id 不为空
  ensureSelfMembers();
  initialized = true;
  return db;
}

export const DEMO_CREDENTIALS = { username: 'demo', password: 'demo1234' };
