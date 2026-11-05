// web/js/store-local.js — IndexedDB 实现（离线优先，默认模式）
// v1.1：新增 tags / transaction_tags / recurring_rules 三个 store；
// accounts 增加 kind、credit_limit_cents；budgets 增加 rollover；transactions 增加 reimburse_state / tags。
// 约定：金额整数分；软删除用 deleted_at；每张业务表带 ledger_id。

import { uid, nowISO, isNewer } from './util.js';
import {
  summarize,
  groupByCategory,
  trend as calcTrend,
  accountBalances,
  dateOf,
  isLive,
  monthRange,
  monthOf,
  advanceDate,
  overview as calcOverview,
  groupByAccount,
  groupByTag,
  compare as calcCompare,
  calendar as calcCalendar,
  reimburseSummary,
  carryIn,
  filterTx,
  groupAccounts,
  reminders,
  monthlySeries,
  memberStats,
  byMemberTop,
  accountGroup,
  budgetView,
  warnPercentOf,
} from './stats.js';

export const DB_NAME = 'mintlite';
export const DB_VERSION = 4;
export const STORES = [
  'ledgers',
  'accounts',
  'categories',
  'transactions',
  'budgets',
  'meta',
  'tags',
  'transaction_tags',
  'recurring_rules',
  'members',
];

function req2promise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('事务被中止'));
  });
}

export function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // 只建缺的，老数据不丢（契约 §3：onupgradeneeded 幂等）
      if (!db.objectStoreNames.contains('ledgers')) {
        const s = db.createObjectStore('ledgers', { keyPath: 'id' });
        s.createIndex('user_id', 'user_id');
      }
      if (!db.objectStoreNames.contains('accounts')) {
        const s = db.createObjectStore('accounts', { keyPath: 'id' });
        s.createIndex('ledger_id', 'ledger_id');
        s.createIndex('ledger_kind', ['ledger_id', 'kind']);
      }
      if (!db.objectStoreNames.contains('categories')) {
        const s = db.createObjectStore('categories', { keyPath: 'id' });
        s.createIndex('ledger_id', 'ledger_id');
        s.createIndex('ledger_kind', ['ledger_id', 'kind']);
      }
      if (!db.objectStoreNames.contains('transactions')) {
        const s = db.createObjectStore('transactions', { keyPath: 'id' });
        // 契约要求：ledger_id、happened_at、[ledger_id+happened_at]
        s.createIndex('ledger_id', 'ledger_id');
        s.createIndex('happened_at', 'happened_at');
        s.createIndex('ledger_date', ['ledger_id', 'happened_at']);
        s.createIndex('category_id', 'category_id');
        s.createIndex('account_id', 'account_id');
        s.createIndex('external_id', 'external_id');
      }
      if (!db.objectStoreNames.contains('budgets')) {
        const s = db.createObjectStore('budgets', { keyPath: 'id' });
        s.createIndex('ledger_month', ['ledger_id', 'month']);
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('tags')) {
        const s = db.createObjectStore('tags', { keyPath: 'id' });
        s.createIndex('ledger_id', 'ledger_id');
        s.createIndex('ledger_name', ['ledger_id', 'name']);
      }
      if (!db.objectStoreNames.contains('transaction_tags')) {
        const s = db.createObjectStore('transaction_tags', { keyPath: ['transaction_id', 'tag_id'] });
        s.createIndex('transaction_id', 'transaction_id');
        s.createIndex('tag_id', 'tag_id');
      }
      if (!db.objectStoreNames.contains('recurring_rules')) {
        const s = db.createObjectStore('recurring_rules', { keyPath: 'id' });
        s.createIndex('ledger_id', 'ledger_id');
        s.createIndex('due', ['ledger_id', 'enabled', 'next_run']);
      }
      if (!db.objectStoreNames.contains('members')) {
        const s = db.createObjectStore('members', { keyPath: 'id' });
        s.createIndex('ledger_id', 'ledger_id');
        s.createIndex('ledger_self', ['ledger_id', 'is_self']);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      const err = request.error;
      // 库已经被更高版本的页面升过级（旧 JS 在新版页面之后重连）：
      // 不按老版本号硬开（会 VersionError），改为按当前版本打开，老表照样读写。
      if (err && err.name === 'VersionError') {
        const retry = indexedDB.open(DB_NAME);
        retry.onsuccess = () => resolve(retry.result);
        retry.onerror = () => reject(retry.error || err);
        retry.onblocked = () => reject(new Error('数据库被其它标签页占用，请关闭其它页面'));
        return;
      }
      reject(err);
    };
    request.onblocked = () => reject(new Error('数据库被其它标签页占用，请关闭其它页面'));
  });
}

const HIGH = '\uffff';
const ACCOUNT_TYPES = ['cash', 'bank', 'ewallet', 'credit', 'invest', 'receivable', 'payable', 'other'];
const FREQS = ['daily', 'weekly', 'monthly', 'yearly'];

function normKind(type, kind) {
  if (kind === 'liability' || kind === 'asset') return kind;
  return type === 'credit' || type === 'payable' ? 'liability' : 'asset';
}

function normMember(data = {}) {
  const now = nowISO();
  return {
    id: data.id || uid(),
    ledger_id: data.ledger_id,
    name: String(data.name || '成员').slice(0, 24),
    color: data.color || '#2f9e8f',
    is_self: Number(data.is_self) === 1 || data.is_self === true ? 1 : 0,
    sort: Number.isFinite(data.sort) ? data.sort : Date.now(),
    created_at: data.created_at || now,
    updated_at: now,
    deleted_at: null,
  };
}

function matches(tx, filter) {
  if (!filter) return true;
  if (filter.ledger_id && tx.ledger_id !== filter.ledger_id) return false;
  if (filter.type && tx.type !== filter.type) return false;
  if (filter.category_id && tx.category_id !== filter.category_id) return false;
  if (filter.tag_id) {
    const tags = Array.isArray(tx.tags) ? tx.tags : [];
    if (!tags.includes(filter.tag_id)) return false;
  }
  if (filter.reimburse_state && tx.reimburse_state !== filter.reimburse_state) return false;
  if (filter.member_id && (tx.member_id || null) !== filter.member_id) return false;
  if (filter.account_id && tx.account_id !== filter.account_id && tx.to_account_id !== filter.account_id) {
    return false;
  }
  const date = dateOf(tx);
  if (filter.from && date < filter.from) return false;
  if (filter.to && date > filter.to) return false;
  if (filter.q) {
    const q = String(filter.q).toLowerCase();
    const hay = `${tx.note || ''}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  const amount = Math.round(Number(tx.amount_cents) || 0);
  if (filter.min_cents != null && filter.min_cents !== '' && amount < Number(filter.min_cents)) return false;
  if (filter.max_cents != null && filter.max_cents !== '' && amount > Number(filter.max_cents)) return false;
  return true;
}

export class LocalStore {
  constructor() {
    this.mode = 'local';
    this.db = null;
  }

  async init() {
    if (!this.db) this.db = await openDB();
    this._attach(this.db);
    await this._migrate();
    return this;
  }

  /**
   * 给连接挂上自愈钩子。
   * - onversionchange：另一个标签页把库升级到更高版本时触发。不处理的话本页连接会进入
   *   「closing」状态，之后再点保存就抛 InvalidStateError: The database connection is closing。
   * - onclose：连接被浏览器强制关闭（存储清理、进程回收）时触发。
   * 两种情况都只把引用置空，下次读写时 _conn() 会重开。
   */
  _attach(db) {
    if (!db) return;
    db.onversionchange = () => {
      this._closedBy = 'versionchange';
      this.close();
    };
    db.onclose = () => {
      this._closedBy = this._closedBy || 'close';
      this.db = null;
    };
  }

  /** 拿一个可用连接；连接被关掉过就重开（并补一次幂等迁移）。 */
  async _conn() {
    if (!this.db) {
      this.db = await openDB();
      this._attach(this.db);
      try {
        await this._migrate();
      } catch {
        /* 迁移失败不阻塞读写，下次再试 */
      }
      const why = this._closedBy;
      this._closedBy = null;
      if (why && typeof this.onReconnect === 'function') {
        try {
          this.onReconnect(why);
        } catch {
          /* 通知失败不影响读写 */
        }
      }
    }
    return this.db;
  }

  /** 开事务；遇到连接正在关闭就重开一次再试。 */
  async _txn(name, mode = 'readonly') {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const db = await this._conn();
      try {
        return db.transaction(name, mode);
      } catch (err) {
        if (err && (err.name === 'InvalidStateError' || /closing|closed/i.test(err.message || ''))) {
          this.close();
          continue;
        }
        throw err;
      }
    }
    throw new Error('本地数据库连接不可用，请刷新页面');
  }

  close() {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* 已经关了 */
      }
      this.db = null;
    }
  }

  // ------------------------------------------------------------ 底层读写

  async _all(name) {
    const tx = await this._txn(name, 'readonly');
    return req2promise(tx.objectStore(name).getAll());
  }

  async _get(name, id) {
    const tx = await this._txn(name, 'readonly');
    return req2promise(tx.objectStore(name).get(id));
  }

  async _put(name, value) {
    const tx = await this._txn(name, 'readwrite');
    tx.objectStore(name).put(value);
    await txDone(tx);
    return value;
  }

  async _putMany(name, values) {
    if (!values.length) return 0;
    const tx = await this._txn(name, 'readwrite');
    const store = tx.objectStore(name);
    for (const v of values) store.put(v);
    await txDone(tx);
    return values.length;
  }

  async _delete(name, key) {
    const tx = await this._txn(name, 'readwrite');
    tx.objectStore(name).delete(key);
    await txDone(tx);
  }

  /** 单事务写多表（交易 + 标签关联）。先只读拿到旧关联，再开读写事务，避免 await 打断事务。 */
  async _writeTx(row, tagIds) {
    let existing = [];
    if (Array.isArray(tagIds)) {
      const rtx = await this._txn('transaction_tags', 'readonly');
      existing = await req2promise(rtx.objectStore('transaction_tags').index('transaction_id').getAll(row.id));
    }
    const tx = await this._txn(['transactions', 'transaction_tags'], 'readwrite');
    tx.objectStore('transactions').put(row);
    const joins = tx.objectStore('transaction_tags');
    if (Array.isArray(tagIds)) {
      for (const j of existing) joins.delete([j.transaction_id, j.tag_id]);
      for (const tagId of Array.from(new Set(tagIds.filter(Boolean)))) {
        joins.put({ transaction_id: row.id, tag_id: tagId });
      }
    }
    await txDone(tx);
    return row;
  }

  // ------------------------------------------------------------ 迁移（幂等）

  async _migrate() {
    const [accounts, budgets, txs] = await Promise.all([
      this._all('accounts'),
      this._all('budgets'),
      this._all('transactions'),
    ]);
    const accPatch = [];
    for (const a of accounts) {
      const kind = normKind(a.type, a.kind);
      const limit = Number(a.credit_limit_cents) || 0;
      if (a.kind !== kind || a.credit_limit_cents == null) {
        accPatch.push({ ...a, kind, credit_limit_cents: limit });
      }
    }
    if (accPatch.length) await this._putMany('accounts', accPatch);

    const budgetPatch = [];
    for (const b of budgets) {
      const patch = { ...b };
      let dirty = false;
      if (b.rollover == null) {
        patch.rollover = 0;
        dirty = true;
      }
      // v4：存量总预算行补预警阈值（分类行保留但不参与预警）
      if (!b.category_id && b.warn_percent == null) {
        patch.warn_percent = 10;
        dirty = true;
      }
      if (dirty) budgetPatch.push(patch);
    }
    if (budgetPatch.length) await this._putMany('budgets', budgetPatch);

    const txPatch = [];
    for (const t of txs) {
      if (t.reimburse_state === undefined || t.tags === undefined) {
        txPatch.push({ ...t, reimburse_state: t.reimburse_state || null, reimburse_at: t.reimburse_at || null, tags: Array.isArray(t.tags) ? t.tags : [] });
      }
    }
    if (txPatch.length) await this._putMany('transactions', txPatch);

    // 老版本交易没有关联表记录，用行上的 tags 缓存补一遍
    const joins = await this._all('transaction_tags');
    const have = new Set(joins.map((j) => `${j.transaction_id}::${j.tag_id}`));
    const missing = [];
    for (const t of txs) {
      for (const tagId of Array.isArray(t.tags) ? t.tags : []) {
        const key = `${t.id}::${tagId}`;
        if (!have.has(key)) missing.push({ transaction_id: t.id, tag_id: tagId });
      }
    }
    if (missing.length) await this._putMany('transaction_tags', missing);

    // v3：每个账本恰好一条 is_self 成员；老交易的 member_id 回填成该账本的「我」
    const members = await this._all('members');
    const ledgers = await this._all('ledgers');
    const liveLedgers = ledgers.filter((l) => !l.deleted_at);
    const selfByLedger = new Map();
    for (const m of members) {
      if (Number(m.is_self) === 1 && !m.deleted_at) selfByLedger.set(m.ledger_id, m);
    }
    const fresh = [];
    for (const l of liveLedgers) {
      if (selfByLedger.has(l.id)) continue;
      const row = normMember({ ledger_id: l.id, name: '我', is_self: 1, color: '#2f9e8f' });
      fresh.push(row);
      selfByLedger.set(l.id, row);
    }
    if (fresh.length) await this._putMany('members', fresh);

    const memPatch = [];
    for (const t of txs) {
      if (t.member_id !== undefined) continue;
      const self = selfByLedger.get(t.ledger_id);
      memPatch.push({ ...t, member_id: self ? self.id : null });
    }
    if (memPatch.length) await this._putMany('transactions', memPatch);

    if (liveLedgers.length && !(await this.getMeta('migrated:v3'))) {
      await this.setMeta('migrated:v3', nowISO());
    }
  }

  // ------------------------------------------------------------ 账本

  async listLedgers(includeDeleted = false) {
    const rows = await this._all('ledgers');
    return rows
      .filter((r) => includeDeleted || !r.deleted_at)
      .sort(
        (a, b) =>
          (Number(b.is_default) || 0) - (Number(a.is_default) || 0) ||
          (a.sort || 0) - (b.sort || 0) ||
          (a.created_at || '').localeCompare(b.created_at || ''),
      );
  }

  async getLedger(id) {
    return this._get('ledgers', id);
  }

  async createLedger(data = {}) {
    const now = nowISO();
    const row = {
      id: data.id || uid(),
      user_id: data.user_id || 'local',
      name: data.name || '新账本',
      currency: data.currency || 'CNY',
      is_default: !!data.is_default,
      archived: Number(data.archived) === 1 ? 1 : 0,
      sort: Number.isFinite(data.sort) ? data.sort : Date.now(),
      created_at: data.created_at || now,
      updated_at: now,
      deleted_at: null,
    };
    await this._put('ledgers', row);
    return row;
  }

  async updateLedger(id, patch = {}) {
    const cur = await this._get('ledgers', id);
    if (!cur) throw new Error('账本不存在');
    const row = { ...cur, ...patch, id, updated_at: nowISO() };
    await this._put('ledgers', row);
    return row;
  }

  async deleteLedger(id) {
    const cur = await this._get('ledgers', id);
    if (!cur) return;
    const alive = (await this.listLedgers()).filter((l) => l.id !== id);
    if (!alive.length) {
      const err = new Error('至少保留一个账本');
      err.code = 'last_ledger';
      throw err;
    }
    await this._put('ledgers', { ...cur, deleted_at: nowISO(), updated_at: nowISO() });
    if (Number(cur.is_default) === 1) await this.setDefaultLedger(alive[0].id);
  }

  async setDefaultLedger(id) {
    const rows = await this._all('ledgers');
    const patch = rows
      .filter((r) => !r.deleted_at)
      .map((r) => (Number(r.is_default) === (r.id === id ? 1 : 0) ? null : { ...r, is_default: r.id === id ? 1 : 0 }))
      .filter(Boolean);
    if (patch.length) await this._putMany('ledgers', patch);
    return this.getLedger(id);
  }

  // ------------------------------------------------------------ 成员

  async listMembers(ledgerId) {
    const rows = await this._all('members');
    return rows
      .filter((r) => !r.deleted_at && (!ledgerId || r.ledger_id === ledgerId))
      .sort(
        (a, b) =>
          (Number(b.is_self) || 0) - (Number(a.is_self) || 0) ||
          (a.sort || 0) - (b.sort || 0) ||
          (a.created_at || '').localeCompare(b.created_at || ''),
      );
  }

  async ensureSelfMember(ledgerId) {
    const rows = await this.listMembers(ledgerId);
    const self = rows.find((m) => Number(m.is_self) === 1);
    if (self) return self;
    return this.createMember({ ledger_id: ledgerId, name: '我', is_self: 1, color: '#2f9e8f' });
  }

  async createMember(data = {}) {
    const row = normMember(data);
    const same = (await this.listMembers(row.ledger_id)).find(
      (m) => m.name === row.name && Number(m.is_self) === row.is_self,
    );
    if (same) {
      const err = new Error('成员已存在');
      err.code = 'member_exists';
      throw err;
    }
    if (row.is_self === 1) {
      const self = (await this.listMembers(row.ledger_id)).find((m) => Number(m.is_self) === 1);
      if (self) row.is_self = 0;
    }
    await this._put('members', row);
    return row;
  }

  async updateMember(id, patch = {}) {
    const cur = await this._get('members', id);
    if (!cur) throw new Error('成员不存在');
    const next = { ...cur, ...patch, id, is_self: cur.is_self, updated_at: nowISO() };
    if (patch.name) next.name = String(patch.name).slice(0, 24);
    await this._put('members', next);
    return next;
  }

  async deleteMember(id) {
    const cur = await this._get('members', id);
    if (!cur) return;
    if (Number(cur.is_self) === 1) {
      const err = new Error('「我」是默认成员，不能删除');
      err.code = 'member_is_self';
      throw err;
    }
    await this._put('members', { ...cur, deleted_at: nowISO(), updated_at: nowISO() });
    const txs = (await this._all('transactions')).filter((t) => t.member_id === id);
    if (txs.length) {
      await this._putMany(
        'transactions',
        txs.map((t) => ({ ...t, member_id: null, updated_at: nowISO() })),
      );
    }
  }

  // ------------------------------------------------------------ 账户

  _normalizeAccount(data = {}) {
    const now = nowISO();
    const type = ACCOUNT_TYPES.includes(data.type) ? data.type : 'cash';
    const initial = Number.isFinite(data.initial_cents)
      ? Math.round(data.initial_cents)
      : Math.round(Number(data.balance_cents) || 0);
    return {
      id: data.id || uid(),
      ledger_id: data.ledger_id,
      name: data.name || '新账户',
      type,
      kind: normKind(type, data.kind),
      balance_cents: Number.isFinite(data.balance_cents) ? Math.round(data.balance_cents) : initial,
      initial_cents: initial,
      credit_limit_cents: Math.round(Number(data.credit_limit_cents) || 0),
      bill_day: Math.min(31, Math.max(0, Math.round(Number(data.bill_day) || 0))),
      repay_day: Math.min(31, Math.max(0, Math.round(Number(data.repay_day) || 0))),
      hidden: Number(data.hidden) === 1 || data.hidden === true ? 1 : 0,
      group: accountGroup(type),
      icon: data.icon || '💳',
      sort: Number.isFinite(data.sort) ? data.sort : Date.now(),
      include_in_net: data.include_in_net !== false,
      created_at: data.created_at || now,
      updated_at: now,
      deleted_at: null,
    };
  }

  async listAccounts(ledgerId, includeDeleted = false) {
    const rows = await this._all('accounts');
    return rows
      .filter((r) => (includeDeleted || !r.deleted_at) && (!ledgerId || r.ledger_id === ledgerId))
      .sort((a, b) => (a.sort || 0) - (b.sort || 0) || (a.created_at || '').localeCompare(b.created_at || ''));
  }

  async createAccount(data = {}) {
    const row = this._normalizeAccount(data);
    await this._put('accounts', row);
    return row;
  }

  async updateAccount(id, patch = {}) {
    const cur = await this._get('accounts', id);
    if (!cur) throw new Error('账户不存在');
    const next = { ...cur, ...patch, id, updated_at: nowISO() };
    if (patch.type) next.type = patch.type;
    next.kind = normKind(next.type, patch.kind || next.kind);
    if (patch.initial_cents != null) next.initial_cents = Math.round(Number(patch.initial_cents) || 0);
    if (patch.credit_limit_cents != null) {
      next.credit_limit_cents = Math.round(Number(patch.credit_limit_cents) || 0);
    }
    await this._put('accounts', next);
    if (patch.initial_cents != null && cur.ledger_id) {
      await this.recomputeBalances(cur.ledger_id);
    }
    const fresh = await this._get('accounts', id);
    return fresh || next;
  }

  async deleteAccount(id) {
    const cur = await this._get('accounts', id);
    if (!cur) return;
    await this._put('accounts', { ...cur, deleted_at: nowISO(), updated_at: nowISO() });
  }

  /** 资产总览（契约 §2.2：{items, totals}） */
  async listAssets(ledgerId) {
    const items = await this.listAccounts(ledgerId);
    let asset = 0;
    let liability = 0;
    const rows = items.map((a) => {
      const balance = Math.round(Number(a.balance_cents) || 0);
      const kind = normKind(a.type, a.kind);
      const counted = a.include_in_net !== false;
      if (counted && kind === 'liability') liability += Math.abs(Math.min(0, balance)) || Math.abs(balance);
      else if (counted) asset += balance;
      const used = a.type === 'credit' || a.type === 'payable' ? Math.max(0, -balance) : 0;
      return {
        ...a,
        kind,
        group: accountGroup(a.group || a.type),
        bill_day: Number(a.bill_day) || 0,
        repay_day: Number(a.repay_day) || 0,
        hidden: Number(a.hidden) === 1 ? 1 : 0,
        used_cents: used,
      };
    });
    const groups = groupAccounts(rows).map((g) => ({
      key: g.key,
      title: g.title,
      count: g.count,
      subtotal_cents: g.subtotal_cents,
      liability: g.liability,
      items: g.items,
    }));
    return {
      items: rows,
      groups,
      totals: { asset_cents: asset, liability_cents: liability, net_cents: asset - liability },
    };
  }

  /** 契约 §4.7 还款提醒 */
  async listReminders(ledgerId, today) {
    const { items } = await this.listAssets(ledgerId);
    return reminders(items, today || todayFallback());
  }

  /** 余额调整：余额直接改成 target，并插一条 type='adjust' 流水（不计收支） */
  async adjustAccount(id, targetCents, note, date) {
    const cur = await this._get('accounts', id);
    if (!cur) throw new Error('账户不存在');
    const target = Math.round(Number(targetCents) || 0);
    const delta = target - Math.round(Number(cur.balance_cents) || 0);
    const day = date || todayFallback();
    const now = nowISO();
    const row = {
      ...cur,
      balance_cents: target,
      initial_cents: Math.round(Number(cur.initial_cents) || 0) + delta,
      updated_at: now,
    };
    const tx = {
      id: uid(),
      ledger_id: cur.ledger_id,
      type: 'adjust',
      amount_cents: Math.abs(delta),
      category_id: null,
      account_id: id,
      to_account_id: null,
      note: note || '余额调整',
      happened_at: day,
      source: 'manual',
      external_id: null,
      is_sample: false,
      reimburse_state: null,
      reimburse_at: null,
      tags: [],
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    await this._writeTx(tx, []);
    await this._put('accounts', row);
    return { account: row, transaction: tx };
  }

  /** 账户余额 = 初始余额 + 所有交易影响（契约：credit 账户负数表示欠款） */
  async recomputeBalances(ledgerId) {
    const accounts = await this.listAccounts(ledgerId, true);
    const txs = await this.listTransactions({ ledger_id: ledgerId, includeDeleted: false, unbounded: true });
    const balances = accountBalances(accounts, txs.items);
    const changed = [];
    for (const acc of accounts) {
      const next = balances.get(acc.id);
      if (next == null) continue;
      if (acc.balance_cents !== next) changed.push({ ...acc, balance_cents: next });
    }
    if (changed.length) await this._putMany('accounts', changed);
    return changed.length;
  }

  // ------------------------------------------------------------ 分类

  async listCategories(ledgerId, kind, includeDeleted = false) {
    const rows = await this._all('categories');
    return rows
      .filter(
        (r) =>
          (includeDeleted || !r.deleted_at) &&
          (!ledgerId || r.ledger_id === ledgerId) &&
          (!kind || r.kind === kind),
      )
      .sort((a, b) => (a.sort || 0) - (b.sort || 0) || (a.created_at || '').localeCompare(b.created_at || ''));
  }

  async createCategory(data = {}) {
    const now = nowISO();
    const row = {
      id: data.id || uid(),
      ledger_id: data.ledger_id,
      name: data.name || '新分类',
      kind: data.kind === 'income' ? 'income' : 'expense',
      icon: data.icon || '📦',
      sort: Number.isFinite(data.sort) ? data.sort : Date.now(),
      parent_id: data.parent_id || null,
      created_at: data.created_at || now,
      updated_at: now,
      deleted_at: null,
    };
    await this._put('categories', row);
    return row;
  }

  async updateCategory(id, patch = {}) {
    const cur = await this._get('categories', id);
    if (!cur) throw new Error('分类不存在');
    const row = { ...cur, ...patch, id, updated_at: nowISO() };
    await this._put('categories', row);
    return row;
  }

  async deleteCategory(id) {
    const cur = await this._get('categories', id);
    if (!cur) return;
    await this._put('categories', { ...cur, deleted_at: nowISO(), updated_at: nowISO() });
  }

  // ------------------------------------------------------------ 标签

  async listTags(ledgerId) {
    const [rows, txs, joins] = await Promise.all([
      this._all('tags'),
      this._all('transactions'),
      this._all('transaction_tags'),
    ]);
    const liveTx = new Set(txs.filter((t) => !t.deleted_at).map((t) => t.id));
    const usage = new Map();
    for (const j of joins) {
      if (!liveTx.has(j.transaction_id)) continue;
      usage.set(j.tag_id, (usage.get(j.tag_id) || 0) + 1);
    }
    return rows
      .filter((r) => !r.deleted_at && (!ledgerId || r.ledger_id === ledgerId))
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .map((r) => ({ ...r, usage_count: usage.get(r.id) || 0 }));
  }

  async createTag(data = {}) {
    const name = String(data.name || '').trim();
    if (!name) throw new Error('标签名不能为空');
    const rows = await this._all('tags');
    const dup = rows.find((r) => !r.deleted_at && r.ledger_id === data.ledger_id && r.name === name);
    if (dup) {
      const err = new Error('标签「' + name + '」已存在');
      err.code = 'tag_exists';
      throw err;
    }
    const now = nowISO();
    const row = {
      id: data.id || uid(),
      ledger_id: data.ledger_id,
      name,
      color: data.color || '#3eb489',
      created_at: data.created_at || now,
      updated_at: now,
      deleted_at: null,
    };
    await this._put('tags', row);
    return { ...row, usage_count: 0 };
  }

  async updateTag(id, patch = {}) {
    const cur = await this._get('tags', id);
    if (!cur) throw new Error('标签不存在');
    const row = { ...cur, ...patch, id, updated_at: nowISO() };
    if (patch.name) row.name = String(patch.name).trim();
    await this._put('tags', row);
    return row;
  }

  async deleteTag(id) {
    const cur = await this._get('tags', id);
    if (!cur) return;
    await this._put('tags', { ...cur, deleted_at: nowISO(), updated_at: nowISO() });
    const joins = await this._all('transaction_tags');
    const mine = joins.filter((j) => j.tag_id === id);
    if (mine.length) {
      const tx = await this._txn('transaction_tags', 'readwrite');
      const store = tx.objectStore('transaction_tags');
      for (const j of mine) store.delete([j.transaction_id, j.tag_id]);
      await txDone(tx);
    }
  }

  // ------------------------------------------------------------ 交易

  async _tagMap() {
    const joins = await this._all('transaction_tags');
    const map = new Map();
    for (const j of joins) {
      if (!map.has(j.transaction_id)) map.set(j.transaction_id, []);
      map.get(j.transaction_id).push(j.tag_id);
    }
    return map;
  }

  async listTransactions(filter = {}) {
    const tx = await this._txn('transactions', 'readonly');
    const store = tx.objectStore('transactions');
    let rows;
    if (filter.ledger_id && (filter.from || filter.to)) {
      const lower = [filter.ledger_id, filter.from || ''];
      const upper = [filter.ledger_id, (filter.to || HIGH) + (filter.to ? HIGH : '')];
      const range = IDBKeyRange.bound(lower, upper);
      rows = await req2promise(store.index('ledger_date').getAll(range));
    } else if (filter.ledger_id) {
      rows = await req2promise(store.index('ledger_id').getAll(filter.ledger_id));
    } else {
      rows = await req2promise(store.getAll());
    }
    const tagMap = await this._tagMap();
    const memberRows = await this._all('members');
    const memberName = new Map(memberRows.map((m) => [m.id, m.name]));
    const list = rows
      .map((r) => ({
        ...r,
        member_id: r.member_id || null,
        member_name: r.member_id ? memberName.get(r.member_id) || null : null,
        tags: tagMap.get(r.id) || [],
      }))
      .filter((r) => (filter.includeDeleted ? true : !r.deleted_at))
      .filter((r) => matches(r, filter))
      .sort((a, b) => {
        const da = dateOf(a);
        const db = dateOf(b);
        if (da !== db) return da < db ? 1 : -1;
        const ta = Date.parse(a.created_at || '') || 0;
        const tb = Date.parse(b.created_at || '') || 0;
        if (ta !== tb) return tb - ta;
        return String(b.id).localeCompare(String(a.id));
      });
    const total = list.length;
    const offset = Math.max(0, Number(filter.offset) || 0);
    const limit = Number.isFinite(filter.limit) && filter.limit > 0 ? filter.limit : list.length;
    return { items: list.slice(offset, offset + limit), total };
  }

  async getTransaction(id) {
    const row = await this._get('transactions', id);
    if (!row) return null;
    const tagMap = await this._tagMap();
    return { ...row, tags: tagMap.get(id) || [] };
  }

  _normalizeTx(data) {
    const now = nowISO();
    const type = ['expense', 'income', 'transfer', 'adjust'].includes(data.type) ? data.type : 'expense';
    return {
      id: data.id || uid(),
      ledger_id: data.ledger_id,
      type,
      amount_cents: Math.round(Number(data.amount_cents) || 0),
      category_id: type === 'transfer' || type === 'adjust' ? null : data.category_id || null,
      account_id: data.account_id || null,
      to_account_id: type === 'transfer' ? data.to_account_id || null : null,
      note: data.note || '',
      happened_at: data.happened_at || todayFallback(),
      source: data.source || 'manual',
      external_id: data.external_id || null,
      is_sample: data.is_sample === true,
      reimburse_state: ['pending', 'done'].includes(data.reimburse_state) ? data.reimburse_state : null,
      reimburse_at: data.reimburse_at || null,
      member_id: data.member_id || null,
      tags: Array.isArray(data.tags) ? data.tags.slice() : [],
      created_at: data.created_at || now,
      updated_at: now,
      deleted_at: null,
    };
  }

  async createTransaction(data = {}) {
    const row = this._normalizeTx(data);
    await this._writeTx(row, row.tags);
    if (row.ledger_id) await this.recomputeBalances(row.ledger_id);
    return row;
  }

  async updateTransaction(id, patch = {}) {
    const cur = await this._get('transactions', id);
    if (!cur) throw new Error('交易不存在');
    const next = { ...cur, ...patch, id, updated_at: nowISO() };
    next.amount_cents = Math.round(Number(next.amount_cents) || 0);
    if (next.type === 'transfer') {
      next.category_id = null;
    } else {
      next.to_account_id = null;
    }
    if (next.type === 'adjust') next.category_id = null;
    const tags = Array.isArray(patch.tags) ? patch.tags : null;
    if (tags) next.tags = tags.slice();
    await this._writeTx(next, tags);
    if (next.ledger_id) await this.recomputeBalances(next.ledger_id);
    return next;
  }

  async deleteTransaction(id) {
    const cur = await this._get('transactions', id);
    if (!cur) return;
    await this._put('transactions', { ...cur, deleted_at: nowISO(), updated_at: nowISO() });
    if (cur.ledger_id) await this.recomputeBalances(cur.ledger_id);
  }

  /** 报销：标记 pending → 确认后生成一条 type='income'（契约 §2.5） */
  async reimburse(txId, opts = {}) {
    const cur = await this._get('transactions', txId);
    if (!cur) throw new Error('交易不存在');
    if (cur.reimburse_state === 'done') {
      const err = new Error('这笔已经报销过了');
      err.code = 'already_reimbursed';
      throw err;
    }
    const day = opts.date || todayFallback();
    const amount = Math.round(Number(opts.amountCents != null ? opts.amountCents : cur.amount_cents) || 0);
    const now = nowISO();
    const done = { ...cur, reimburse_state: 'done', reimburse_at: day, updated_at: now };
    await this._put('transactions', done);
    const income = this._normalizeTx({
      ledger_id: cur.ledger_id,
      type: 'income',
      amount_cents: amount,
      category_id: null,
      account_id: opts.accountId || cur.account_id || null,
      note: '报销：' + (cur.note || ''),
      happened_at: day,
      source: 'auto',
      external_id: 'reimb:' + txId,
    });
    await this._writeTx(income, []);
    if (cur.ledger_id) await this.recomputeBalances(cur.ledger_id);
    return { transaction: done, income };
  }

  // ------------------------------------------------------------ 周期记账

  async listRecurring(ledgerId) {
    const rows = await this._all('recurring_rules');
    const today = todayFallback();
    return rows
      .filter((r) => !r.deleted_at && (!ledgerId || r.ledger_id === ledgerId))
      .sort((a, b) => String(a.next_run || '').localeCompare(String(b.next_run || '')))
      .map((r) => ({ ...r, due: !!r.enabled && !!r.next_run && r.next_run <= today }));
  }

  /**
   * 保存周期规则 —— **合并语义**（v1.3 契约 §1）。
   * 与服务端 PATCH /recurring/:id 的 normalizeRule 对齐：没传的字段沿用库里那行，
   * 因此 saveRecurring({ id, enabled: 0 }) 只改开关，不会把 ledger_id / amount_cents / next_run 冲掉。
   */
  async saveRecurring(data = {}) {
    const now = nowISO();
    const cur = data.id ? await this._get('recurring_rules', data.id) : null;
    const pick = (key, fallback) => (data[key] === undefined ? (cur && cur[key] !== undefined ? cur[key] : fallback) : data[key]);

    const ledgerId = pick('ledger_id', null) || null;
    if (!ledgerId) throw new Error('周期规则缺少账本');

    const type = ['expense', 'income', 'transfer'].includes(pick('type', 'expense')) ? pick('type', 'expense') : 'expense';
    const freq = FREQS.includes(pick('freq', 'monthly')) ? pick('freq', 'monthly') : 'monthly';
    const interval = Math.max(1, Math.round(Number(pick('interval', 1)) || 1));
    const start = pick('start_date', '') || todayFallback();
    // next_run 只在 freq / interval / start_date 真的变了时重算，暂停/改名不挪动排期
    const reschedule = !cur || start !== cur.start_date || freq !== cur.freq || interval !== cur.interval;
    const nextRun = reschedule ? start : cur.next_run || start;
    const enabledNum = Number(pick('enabled', 1));

    const row = {
      id: cur ? cur.id : data.id || uid(),
      ledger_id: ledgerId,
      type,
      amount_cents: Math.round(Number(pick('amount_cents', 0)) || 0),
      category_id: type === 'transfer' ? null : pick('category_id', null) || null,
      account_id: pick('account_id', null) || null,
      to_account_id: type === 'transfer' ? pick('to_account_id', null) || null : null,
      note: String(pick('note', '') || ''),
      freq,
      interval,
      start_date: start,
      end_date: pick('end_date', null) || null,
      next_run: nextRun,
      enabled: Number.isFinite(enabledNum) && enabledNum ? 1 : 0,
      last_run: cur ? cur.last_run || null : null,
      created_at: cur ? cur.created_at : now,
      updated_at: now,
      deleted_at: null,
    };
    await this._put('recurring_rules', row);
    return row;
  }

  async deleteRecurring(id) {
    const cur = await this._get('recurring_rules', id);
    if (!cur) return;
    await this._put('recurring_rules', { ...cur, deleted_at: nowISO(), updated_at: nowISO() });
  }

  /**
   * 补记到期周期账（契约 §2.4）：幂等键 external_id='rec:ruleId:date'，
   * 单条规则一次最多补 60 条；越界只推进不生成。
   */
  async runRecurring(date) {
    const day = date || todayFallback();
    const [rules, txs] = await Promise.all([this._all('recurring_rules'), this._all('transactions')]);
    const seen = new Set(txs.map((t) => t.external_id).filter(Boolean));
    const created = [];
    const skipped = [];
    const touched = [];
    for (const rule of rules) {
      if (rule.deleted_at || !Number(rule.enabled)) continue;
      let next = rule.next_run || rule.start_date;
      if (!next) continue;
      let made = 0;
      let guard = 0;
      while (next && next <= day && guard < 400) {
        if (rule.end_date && next > rule.end_date) break;
        if (made >= 60) {
          skipped.push({ rule_id: rule.id, note: rule.note, reason: '单次最多补 60 条，剩余留到下次' });
          break;
        }
        const external = `rec:${rule.id}:${next}`;
        if (seen.has(external)) {
          skipped.push({ rule_id: rule.id, note: rule.note, date: next, reason: '已存在' });
          next = advanceDate(next, rule.freq, rule.interval);
          guard += 1;
          continue;
        }
        const tx = this._normalizeTx({
          ledger_id: rule.ledger_id,
          type: rule.type,
          amount_cents: rule.amount_cents,
          category_id: rule.category_id,
          account_id: rule.account_id,
          to_account_id: rule.to_account_id,
          note: rule.note,
          happened_at: next,
          source: 'auto',
          external_id: external,
        });
        await this._writeTx(tx, []);
        seen.add(external);
        created.push(tx);
        made += 1;
        next = advanceDate(next, rule.freq, rule.interval);
        guard += 1;
      }
      if (rule.end_date && next > rule.end_date) next = rule.end_date;
      const updated = {
        ...rule,
        next_run: next,
        last_run: made ? day : rule.last_run || null,
        updated_at: nowISO(),
      };
      await this._put('recurring_rules', updated);
      touched.push(updated);
      if (rule.ledger_id && made) await this.recomputeBalances(rule.ledger_id);
    }
    return { created, skipped, rules: touched };
  }

  // ------------------------------------------------------------ 统计（复用 stats.js）

  async summary(ledgerId, from, to, filters = {}) {
    const { items } = await this.listTransactions({ ledger_id: ledgerId, ...filters, from, to });
    const base = summarize(items, from, to);
    const sumOf = (type) =>
      items.filter((t) => isLive(t) && t.type === type).reduce((acc, t) => acc + Math.round(Number(t.amount_cents) || 0), 0);
    return {
      ...base,
      net_cents: base.income_cents - base.expense_cents,
      transfer_cents: sumOf('transfer'),
      adjust_cents: sumOf('adjust'),
    };
  }

  async byCategory(ledgerId, from, to, kind = 'expense', filters = {}) {
    const [{ items }, categories] = await Promise.all([
      this.listTransactions({ ledger_id: ledgerId }),
      this.listCategories(ledgerId),
    ]);
    const list = filterTx(items, filters, from, to);
    return groupByCategory(list, categories, kind, from, to);
  }

  async trend(ledgerId, from, to, granularity = 'day', filters = {}) {
    const { items } = await this.listTransactions({ ledger_id: ledgerId });
    return calcTrend(filterTx(items, filters, from, to), from, to, granularity);
  }

  async statsOverview(ledgerId, from, to, filters = {}) {
    const [{ items }, members] = await Promise.all([
      this.listTransactions({ ledger_id: ledgerId }),
      this.listMembers(ledgerId),
    ]);
    const base = calcOverview(filterTx(items, filters, from, to), from, to);
    return { ...base, by_member_top: byMemberTop(items, members, from, to, 3), by_member: memberStats(items, members, from, to, filters) };
  }

  async statsByMember(ledgerId, from, to, filters = {}) {
    const [{ items }, members] = await Promise.all([
      this.listTransactions({ ledger_id: ledgerId }),
      this.listMembers(ledgerId),
    ]);
    return memberStats(items, members, from, to, filters);
  }

  async statsMonthly(ledgerId, months = 12, today) {
    const { items } = await this.listTransactions({ ledger_id: ledgerId });
    return monthlySeries(items, months, today || todayFallback());
  }

  async statsByAccount(ledgerId, from, to, kind = 'expense', filters = {}) {
    const [{ items }, accounts] = await Promise.all([
      this.listTransactions({ ledger_id: ledgerId }),
      this.listAccounts(ledgerId),
    ]);
    return groupByAccount(items, accounts, kind, from, to, filters);
  }

  async statsByTag(ledgerId, from, to, filters = {}) {
    const [{ items }, tags] = await Promise.all([
      this.listTransactions({ ledger_id: ledgerId }),
      this.listTags(ledgerId),
    ]);
    return groupByTag(items, tags, from, to, filters);
  }

  async statsCompare(ledgerId, from, to, filters = {}) {
    const { items } = await this.listTransactions({ ledger_id: ledgerId });
    const cur = summarize(items, from, to);
    const span = Math.max(1, daysBetweenLocal(from, to));
    const prevTo = addDaysLocal(from, -1);
    const prevFrom = addDaysLocal(prevTo, -(span - 1));
    const prev = summarize(items, prevFrom, prevTo);
    return { ...calcCompare(cur, prev), previous_range: { from: prevFrom, to: prevTo } };
  }

  async statsCalendar(ledgerId, month, filters = {}) {
    const { items } = await this.listTransactions({ ledger_id: ledgerId });
    return calcCalendar(items, month, filters);
  }

  async statsReimburse(ledgerId, from, to) {
    const { items } = await this.listTransactions({ ledger_id: ledgerId });
    return reimburseSummary(items, from, to);
  }

  // ------------------------------------------------------------ 预算

  budgetId(ledgerId, month, categoryId) {
    return `${ledgerId}:${month}:${categoryId || 'total'}`;
  }

  async getBudgets(ledgerId, month) {
    const rows = await this._all('budgets');
    const list = rows.filter((r) => (!ledgerId || r.ledger_id === ledgerId) && (!month || r.month === month));
    const out = list
      .map((r) => ({ rollover: 0, ...r }))
      .sort((a, b) => (a.category_id ? 1 : 0) - (b.category_id ? 1 : 0));
    // 契约 v1.3.2：预算总开关挂在账本上，数组上带一个 enabled（0/1）方便调用方判断
    out.enabled = await this.budgetFlag(ledgerId);
    return out;
  }

  /** 账本的预算总开关（缺省 0 = 关闭） */
  async budgetFlag(ledgerId) {
    if (!ledgerId) return 0;
    const led = await this._get('ledgers', ledgerId);
    return led && Number(led.budget_enabled) === 1 ? 1 : 0;
  }

  /** 只要写了金额就自动把总开关打开（避免「设了预算却看不到」） */
  async _ensureBudgetEnabled(ledgerId) {
    if (!ledgerId) return;
    const on = await this.budgetFlag(ledgerId);
    if (!on) await this.updateLedger(ledgerId, { budget_enabled: 1 });
  }

  /** 最大余数法按权重切分整数分（保证 Σ = total，不丢分） */
  _splitCents(total, weights) {
    const list = (weights || []).map((n) => Math.max(0, Math.round(Number(n) || 0)));
    if (!list.length) return [];
    const target = Math.max(0, Math.round(Number(total) || 0));
    const sum = list.reduce((a, b) => a + b, 0);
    if (!sum) {
      const base = Math.floor(target / list.length);
      const rest = target - base * list.length;
      return list.map((_, i) => base + (i < rest ? 1 : 0));
    }
    const raw = list.map((n) => (target * n) / sum);
    const out = raw.map((n) => Math.floor(n));
    let left = target - out.reduce((a, b) => a + b, 0);
    const order = raw
      .map((n, i) => ({ i, frac: n - Math.floor(n) }))
      .sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (let k = 0; left > 0 && k < order.length; k += 1) {
      out[order[k].i] += 1;
      left -= 1;
    }
    return out;
  }

  /**
   * 保存预算（v1.3 契约 §2.2 等式模型）：
   * 总预算 = 明细合计 + 未分配。保存分类不动总预算；
   * 总预算 < 明细合计时抛 budget_below_allocated，带 rebalance 则按最大余数法压缩明细；
   * 也可直接给 unallocated_cents（未分配），总预算按 Σ + 未分配 落库。
   */
  async setBudget(data = {}) {
    const ledgerId = data.ledger_id;
    const month = data.month;
    if (!ledgerId || !month) throw new Error('预算缺少账本或月份');

    // v1.3.2 预算总开关：只带 enabled 时改账本标志，不动任何预算行
    const onlySwitch =
      data.enabled !== undefined &&
      data.enabled !== null &&
      data.enabled !== '' &&
      data.amount_cents === undefined &&
      data.unallocated_cents === undefined &&
      !data.category_id;
    if (data.enabled !== undefined && data.enabled !== null && data.enabled !== '') {
      const on = data.enabled === true || Number(data.enabled) === 1 ? 1 : 0;
      await this.updateLedger(ledgerId, { budget_enabled: on });
      if (onlySwitch) return this.budgetUsage(ledgerId, month);
    }

    const categoryId = data.category_id || null;
    const id = this.budgetId(ledgerId, month, categoryId);
    const cur = await this._get('budgets', id);
    const now = nowISO();
    const amount = Math.max(0, Math.round(Number(data.amount_cents) || 0));

    let warnPercent = cur && cur.warn_percent != null ? warnPercentOf(cur.warn_percent) : 10;
    if (data.warn_percent !== undefined && data.warn_percent !== null && data.warn_percent !== '') {
      const w = Math.round(Number(data.warn_percent));
      if (!Number.isFinite(w) || w < 1 || w > 100) {
        const err = new Error('预警阈值要是 1–100');
        err.code = 'invalid_warn_percent';
        throw err;
      }
      warnPercent = w;
    }
    const rollover =
      data.rollover === undefined
        ? cur
          ? Number(cur.rollover) || 0
          : 0
        : data.rollover === true || Number(data.rollover) === 1
          ? 1
          : 0;

    const rows = await this.getBudgets(ledgerId, month);
    const catRows = rows.filter((r) => r.category_id);

    // ---- 分类预算：只写这一行，不动总预算（等式模型）
    if (categoryId) {
      if (amount <= 0) {
        if (cur) await this._delete('budgets', id);
        return null;
      }
      const row = {
        id,
        ledger_id: ledgerId,
        month,
        category_id: categoryId,
        amount_cents: amount,
        rollover,
        created_at: cur ? cur.created_at : now,
        updated_at: now,
      };
      await this._put('budgets', row);
      await this._ensureBudgetEnabled(ledgerId);
      return row;
    }

    // ---- 总预算
    const categoriesSum = catRows.reduce((acc, r) => acc + Math.max(0, Math.round(Number(r.amount_cents) || 0)), 0);
    const unallocGiven =
      data.unallocated_cents !== undefined && data.unallocated_cents !== null && data.unallocated_cents !== '';
    const unallocated = unallocGiven ? Math.max(0, Math.round(Number(data.unallocated_cents) || 0)) : null;
    let target = unallocGiven ? categoriesSum + unallocated : amount;

    const wantsShrink = categoriesSum > 0 && target < categoriesSum;
    if (wantsShrink && !data.rebalance) {
      const err = new Error(
        `明细合计 ¥${(categoriesSum / 100).toFixed(2)} 超过总预算 ¥${(target / 100).toFixed(2)}`,
      );
      err.code = 'budget_below_allocated';
      err.details = { total_cents: target, categories_sum_cents: categoriesSum };
      throw err;
    }
    if (wantsShrink && data.rebalance) {
      const shares = this._splitCents(target, catRows.map((r) => r.amount_cents));
      for (let i = 0; i < catRows.length; i += 1) {
        const row = catRows[i];
        const nextAmount = shares[i];
        if (nextAmount > 0) {
          await this._put('budgets', { ...row, amount_cents: nextAmount, updated_at: now });
        } else {
          await this._delete('budgets', row.id);
        }
      }
    }

    if (target <= 0) {
      if (cur) await this._delete('budgets', id);
      return null;
    }
    const row = {
      id,
      ledger_id: ledgerId,
      month,
      category_id: null,
      amount_cents: target,
      rollover,
      warn_percent: warnPercent,
      created_at: cur ? cur.created_at : now,
      updated_at: now,
    };
    await this._put('budgets', row);
    await this._ensureBudgetEnabled(ledgerId);
    return row;
  }

  /**
   * 预算 + 已用 + 结转（契约 §2.3）
   * carry(m) = R ? (A(m-1) + carry(m-1) - spent(m-1)) : 0，最多回溯 36 个月，允许负结转。
   */
  async budgetUsage(ledgerId, month) {
    const rows = await this._budgetRows(ledgerId, month);
    const view = budgetView(rows, month);
    view.has_budget = rows.some((r) => !r.category_id && Math.round(Number(r.amount_cents) || 0) > 0);
    // v1.3.2：预算功能总开关（账本级）
    view.enabled = await this.budgetFlag(ledgerId);
    return view;
  }

  async _budgetRows(ledgerId, month) {
    const { from, to } = monthRange(month);
    const monthBuds = await this.getBudgets(ledgerId, month);
    const [allBuds, txs, categories] = await Promise.all([
      this.getBudgets(ledgerId),
      this.listTransactions({ ledger_id: ledgerId }),
      this.listCategories(ledgerId),
    ]);
    const spentByCat = new Map();
    const spentByMonthTotal = new Map();
    const spentByCatMonth = new Map();
    let totalSpent = 0;
    for (const tx of txs.items) {
      if (!isLive(tx) || tx.type !== 'expense') continue;
      const d = dateOf(tx);
      const amount = Math.round(Number(tx.amount_cents) || 0);
      const m = monthOf(d);
      spentByMonthTotal.set(m, (spentByMonthTotal.get(m) || 0) + amount);
      if (!spentByCatMonth.has(tx.category_id)) spentByCatMonth.set(tx.category_id, new Map());
      const cm = spentByCatMonth.get(tx.category_id);
      cm.set(m, (cm.get(m) || 0) + amount);
      if (d < from || d > to) continue;
      totalSpent += amount;
      spentByCat.set(tx.category_id, (spentByCat.get(tx.category_id) || 0) + amount);
    }
    const catById = new Map(categories.map((c) => [c.id, c]));
    return monthBuds.map((b) => {
      const scope = b.category_id ? spentByCatMonth.get(b.category_id) || new Map() : spentByMonthTotal;
      const history = allBuds.filter((x) => (x.category_id || null) === (b.category_id || null));
      const carry = carryIn(history, scope, month, b.category_id || null);
      const amount = Math.round(Number(b.amount_cents) || 0);
      const used = b.category_id ? spentByCat.get(b.category_id) || 0 : totalSpent;
      return {
        ...b,
        rollover: Number(b.rollover) === 1 ? 1 : 0,
        carry_in_cents: carry,
        available_cents: amount + carry,
        remaining_cents: amount + carry - used,
        used_cents: used,
        category: b.category_id ? catById.get(b.category_id) || null : null,
      };
    });
  }

  // ------------------------------------------------------------ meta

  async getMeta(key, fallback = null) {
    const row = await this._get('meta', key);
    return row ? row.value : fallback;
  }

  async setMeta(key, value) {
    await this._put('meta', { key, value });
    return value;
  }

  // ------------------------------------------------------------ 导入导出

  async exportAll(ledgerId) {
    const [ledgers, accounts, categories, transactions, budgets, tags, joins, recurring, members] = await Promise.all([
      this._all('ledgers'),
      this._all('accounts'),
      this._all('categories'),
      this._all('transactions'),
      this._all('budgets'),
      this._all('tags'),
      this._all('transaction_tags'),
      this._all('recurring_rules'),
      this._all('members'),
    ]);
    const pick = (rows) => (ledgerId ? rows.filter((r) => r.ledger_id === ledgerId) : rows);
    const tagMap = new Map();
    for (const j of joins) {
      if (!tagMap.has(j.transaction_id)) tagMap.set(j.transaction_id, []);
      tagMap.get(j.transaction_id).push(j.tag_id);
    }
    return {
      app: 'MintLite',
      schema: 3,
      exported_at: nowISO(),
      ledgers: ledgerId ? ledgers.filter((r) => r.id === ledgerId) : ledgers,
      accounts: pick(accounts),
      categories: pick(categories),
      tags: pick(tags),
      transactions: pick(transactions).map((t) => ({ ...t, tags: tagMap.get(t.id) || t.tags || [] })),
      transaction_tags: pick(transactions).flatMap((t) =>
        (tagMap.get(t.id) || []).map((tagId) => ({ transaction_id: t.id, tag_id: tagId })),
      ),
      budgets: pick(budgets),
      recurring: pick(recurring),
      members: pick(members),
    };
  }

  /** 按 id upsert，updated_at 新者胜（与云同步同一条规则） */
  async importAll(ledgerId, data) {
    const payload = data && data.data ? data.data : data;
    if (!payload || typeof payload !== 'object') throw new Error('导入数据格式不对');
    const stats = {
      ledgers: 0,
      accounts: 0,
      categories: 0,
      transactions: 0,
      budgets: 0,
      tags: 0,
      recurring: 0,
      members: 0,
      skipped: 0,
    };
    const merge = async (name, rows, key = 'id') => {
      if (!Array.isArray(rows)) return;
      const existing = new Map((await this._all(name)).map((r) => [r[key], r]));
      const toWrite = [];
      for (const raw of rows) {
        if (!raw || !raw[key]) continue;
        const row = ledgerId && name !== 'ledgers' ? { ...raw, ledger_id: ledgerId } : { ...raw };
        const cur = existing.get(row[key]);
        if (cur && !isNewer(row.updated_at, cur.updated_at)) {
          stats.skipped += 1;
          continue;
        }
        toWrite.push(row);
        stats[name] += 1;
      }
      if (toWrite.length) await this._putMany(name, toWrite);
    };
    await merge('ledgers', payload.ledgers);
    await merge('accounts', payload.accounts);
    await merge('categories', payload.categories);
    await merge('tags', payload.tags);
    await merge('transactions', payload.transactions);
    await merge('budgets', payload.budgets);
    await merge('recurring_rules', payload.recurring);
    await merge('members', payload.members);

    // 标签关联：优先用 transaction_tags，退回交易行上的 tags 缓存
    const joins = Array.isArray(payload.transaction_tags)
      ? payload.transaction_tags
      : (payload.transactions || []).flatMap((t) =>
          (Array.isArray(t.tags) ? t.tags : []).map((tagId) => ({ transaction_id: t.id, tag_id: tagId })),
        );
    if (joins.length) await this._putMany('transaction_tags', joins);

    const ledgers = await this.listLedgers();
    for (const l of ledgers) await this.recomputeBalances(l.id);
    return stats;
  }

  // ------------------------------------------------------------ 维护

  async clearSampleData() {
    const rows = await this._all('transactions');
    const samples = rows.filter((r) => r.is_sample && !r.deleted_at);
    if (!samples.length) return 0;
    const stamp = nowISO();
    await this._putMany('transactions', samples.map((r) => ({ ...r, deleted_at: stamp, updated_at: stamp })));
    const ledgers = new Set(samples.map((r) => r.ledger_id));
    for (const id of ledgers) await this.recomputeBalances(id);
    return samples.length;
  }

  async clearAll() {
    for (const name of STORES) {
      const tx = await this._txn(name, 'readwrite');
      tx.objectStore(name).clear();
      await txDone(tx);
    }
  }

  async storageEstimate() {
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const { usage = 0, quota = 0 } = await navigator.storage.estimate();
        return { usage, quota };
      } catch {
        return { usage: 0, quota: 0 };
      }
    }
    return { usage: 0, quota: 0 };
  }
}

function todayFallback() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDaysLocal(iso, delta) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + Number(delta || 0));
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

function daysBetweenLocal(from, to) {
  const [y1, m1, d1] = String(from).split('-').map(Number);
  const [y2, m2, d2] = String(to).split('-').map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.round((b - a) / 86400000) + 1;
}

export function monthRangeLocal(month) {
  return monthRange(month);
}

export { monthOf };
