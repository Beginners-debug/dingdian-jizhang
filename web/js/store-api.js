// web/js/store-api.js — 契约 §2 REST API 的 fetch 实现（云同步模式）
// 与 LocalStore 保持同一套方法签名，app.js 不需要区分模式。

import {
  summarize,
  groupByCategory,
  trend as calcTrend,
  isLive,
  reminders as calcReminders,
  monthlySeries,
  memberStats,
  byMemberTop,
  accountGroup,
  groupAccounts,
  budgetView,
  warnPercentOf,
} from './stats.js';

const PREFIX = '/api/v1';

/** 后端约定：401 = 没登录/token 过期；403 = 账本不属于当前用户 */
export function explainError(status, err = {}) {
  const raw = err && err.message ? String(err.message) : '';
  if (status === 401) return raw ? `登录已过期：${raw}（去「云同步」重新登录）` : '登录已过期，去「云同步」重新登录';
  if (status === 403) return raw ? `无权限：${raw}` : '这个账本不属于当前账号，没有权限';
  if (status === 404) return raw || '服务器上没有这个资源';
  if (status === 0) return raw || '连不上服务器';
  return raw || `请求失败 ${status}`;
}

function codeOf(status) {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 422 || status === 400) return 'INVALID';
  return 'HTTP';
}

/** 统一把「裸数组 / {items:[]} / null」三种返回形态抹平成数组 */
function asArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 统一筛选参数 → query（契约 §2.6） */
/** 可选端点：服务器还没上线时（404/405/501）用本地算法兜底，不白屏 */
async function soft(promise, fallback) {
  try {
    return await promise;
  } catch (err) {
    const st = err && err.status;
    if (st === 404 || st === 405 || st === 501) return fallback;
    throw err;
  }
}

function filterQuery(f = {}) {
  return {
    type: f.type,
    account_id: f.account_id,
    category_id: f.category_id,
    tag_id: f.tag_id,
    member_id: f.member_id,
    q: f.q,
    min_cents: f.min_cents,
    max_cents: f.max_cents,
  };
}

/** 账户行规范化：补 kind / credit_limit_cents / used_cents，保证与本地模式同形 */
function normalizeAccount(a = {}) {
  const type = a.type || 'other';
  const kind = a.kind || (type === 'credit' || type === 'payable' ? 'liability' : 'asset');
  const balance = Math.round(num(a.balance_cents));
  return {
    ...a,
    type,
    kind,
    balance_cents: balance,
    initial_cents: a.initial_cents != null ? Math.round(num(a.initial_cents)) : null,
    credit_limit_cents: Math.round(num(a.credit_limit_cents)),
    bill_day: Math.round(num(a.bill_day)),
    repay_day: Math.round(num(a.repay_day)),
    hidden: Number(a.hidden) === 1 || a.hidden === true ? 1 : 0,
    group: a.group || accountGroup(a.type),
    used_cents: a.used_cents != null ? Math.round(num(a.used_cents)) : type === 'credit' ? Math.max(0, -balance) : 0,
    include_in_net: a.include_in_net !== 0 && a.include_in_net !== false,
  };
}

function normalizeTag(t = {}) {
  return {
    ...t,
    id: t.id,
    name: t.name || '标签',
    color: t.color || '#3eb489',
    usage_count: Math.round(num(t.usage_count)),
  };
}


/**
 * 后端写接口的信封不统一：POST/PATCH /transactions 返回 {item}，
 * 而 /ledgers、/accounts、/categories 直接返回行对象。这里统一抹平成行对象。
 */
function unwrap(data) {
  if (!data || typeof data !== 'object') return data;
  if (data.item && typeof data.item === 'object') return data.item;
  return data;
}

/**
 * 交易载荷规范化，满足后端硬约束：
 * - amount_cents 必须是正整数分
 * - transfer：必须有 account_id(转出) 与 to_account_id(转入)，category_id 必须为 null
 * - happened_at 只传 YYYY-MM-DD
 */
function normalizeTx(data) {
  const out = { ...data };
  if (out.amount_cents != null) {
    const cents = Math.round(num(out.amount_cents));
    if (!(cents > 0)) throw new ApiError('金额必须是大于 0 的整数分', 400, 'INVALID_AMOUNT');
    out.amount_cents = cents;
  }
  if (out.happened_at) out.happened_at = String(out.happened_at).slice(0, 10);
  if (out.type === 'transfer') {
    out.category_id = null;
    if (!out.account_id) throw new ApiError('转账要指定转出账户', 400, 'INVALID_TRANSFER');
    if (!out.to_account_id) throw new ApiError('转账要指定转入账户', 400, 'INVALID_TRANSFER');
    if (out.to_account_id === out.account_id) throw new ApiError('转出和转入不能是同一个账户', 400, 'INVALID_TRANSFER');
  }
  return out;
}

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export class ApiStore {
  constructor({ baseUrl, token } = {}) {
    this.mode = 'server';
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.token = token || '';
  }

  async init() {
    if (!this.baseUrl) throw new Error('还没设置服务器地址');
    const health = await this.health();
    if (!health || !health.ok) throw new Error('服务器未就绪');
    return this;
  }

  setCredentials({ baseUrl, token } = {}) {
    if (baseUrl != null) this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    if (token != null) this.token = token;
  }

  url(path, query) {
    let full = `${this.baseUrl}${PREFIX}${path}`;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v == null || v === '') continue;
        qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) full += `?${s}`;
    }
    return full;
  }

  async request(method, path, { body, query, raw = false } = {}) {
    const headers = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(this.url(path, query), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ApiError(`连不上服务器（${this.baseUrl}）`, 0, 'NETWORK');
    }
    if (raw) {
      if (!res.ok) throw new ApiError(`请求失败 ${res.status}`, res.status, 'HTTP');
      return res;
    }
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const err = (data && data.error) || {};
      throw new ApiError(explainError(res.status, err), res.status, err.code || codeOf(res.status));
    }
    return data;
  }

  health() {
    return fetch(`${this.baseUrl}${PREFIX}/health`).then((r) => r.json());
  }

  // ---------------------------------------------------------------- 账本

  async listLedgers() {
    return asArray(await this.request('GET', '/ledgers'));
  }

  async createLedger(data = {}) {
    return unwrap(await this.request('POST', '/ledgers', { body: data }));
  }

  async updateLedger(id, patch = {}) {
    return unwrap(await this.request('PATCH', `/ledgers/${encodeURIComponent(id)}`, { body: patch }));
  }

  deleteLedger(id) {
    return this.request('DELETE', `/ledgers/${encodeURIComponent(id)}`);
  }

  async setDefaultLedger(id) {
    return unwrap(await this.request('PATCH', `/ledgers/${encodeURIComponent(id)}`, { body: { is_default: 1 } }));
  }

  // ---------------------------------------------------------------- 成员

  async listMembers(ledgerId) {
    const data = await soft(this.request('GET', '/members', { query: { ledger_id: ledgerId } }), []);
    return asArray(data).map((m) => ({
      id: m.id,
      ledger_id: m.ledger_id || ledgerId,
      name: m.name || '成员',
      color: m.color || '#2f9e8f',
      is_self: Number(m.is_self) === 1 || m.is_self === true ? 1 : 0,
      sort: Number(m.sort) || 0,
    }));
  }

  async createMember(data = {}) {
    return unwrap(await this.request('POST', '/members', { body: data }));
  }

  async updateMember(id, patch = {}) {
    return unwrap(await this.request('PATCH', `/members/${encodeURIComponent(id)}`, { body: patch }));
  }

  deleteMember(id) {
    return this.request('DELETE', `/members/${encodeURIComponent(id)}`);
  }

  async ensureSelfMember(ledgerId) {
    const rows = await this.listMembers(ledgerId);
    return rows.find((m) => Number(m.is_self) === 1) || { id: null, name: '我', is_self: 1, color: '#2f9e8f' };
  }

  // ---------------------------------------------------------------- 账户

  /** 契约 §2.2：GET /accounts → {items, totals} */
  async listAssets(ledgerId) {
    const data = await this.request('GET', '/accounts', { query: { ledger_id: ledgerId } });
    const items = asArray(data).map(normalizeAccount);
    const totals = (data && data.totals) || {};
    const asset = totals.asset_cents != null
      ? Math.round(num(totals.asset_cents))
      : items.filter((a) => a.include_in_net && a.kind === 'asset').reduce((s, a) => s + a.balance_cents, 0);
    const liability = totals.liability_cents != null
      ? Math.round(num(totals.liability_cents))
      : items.filter((a) => a.include_in_net && a.kind === 'liability').reduce((s, a) => s + Math.abs(Math.min(0, a.balance_cents) || a.balance_cents), 0);
    const groups =
      Array.isArray(data && data.groups) && data.groups.length
        ? data.groups.map((g) => ({
            key: g.key,
            title: g.title,
            count: Math.round(num(g.count)),
            subtotal_cents: Math.round(num(g.subtotal_cents)),
            liability: g.key === 'credit' || g.key === 'payable',
          }))
        : groupAccounts(items).map((g) => ({
            key: g.key,
            title: g.title,
            count: g.count,
            subtotal_cents: g.subtotal_cents,
            liability: g.liability,
          }));
    return {
      items,
      groups,
      totals: {
        asset_cents: asset,
        liability_cents: liability,
        net_cents: totals.net_cents != null ? Math.round(num(totals.net_cents)) : asset - liability,
      },
    };
  }

  /** 契约 §4.7：GET /accounts/reminders；服务器没上线就按同一算法本地算 */
  async listReminders(ledgerId, today) {
    const day = today || new Date().toISOString().slice(0, 10);
    const fallback = async () => calcReminders((await this.listAssets(ledgerId)).items, day);
    try {
      const data = await this.request('GET', '/accounts/reminders', { query: { ledger_id: ledgerId } });
      const items = asArray(data);
      if (!items.length && !(data && Array.isArray(data.items))) return fallback();
      return items.map((it) => ({
        account_id: it.account_id,
        name: it.name || '信用卡',
        type: it.type || 'credit',
        icon: it.icon || '💳',
        used_cents: Math.round(num(it.used_cents)),
        credit_limit_cents: Math.round(num(it.credit_limit_cents)),
        bill_day: Math.round(num(it.bill_day)),
        repay_day: Math.round(num(it.repay_day)),
        due_date: it.due_date || '',
        days_left: Math.round(num(it.days_left)),
        status: it.status || 'later',
      }));
    } catch (err) {
      const st = err && err.status;
      if (st === 404 || st === 405 || st === 501) return fallback();
      throw err;
    }
  }

  async listAccounts(ledgerId) {
    return (await this.listAssets(ledgerId)).items;
  }

  async createAccount(data = {}) {
    return normalizeAccount(unwrap(await this.request('POST', '/accounts', { body: data })));
  }

  async updateAccount(id, patch = {}) {
    return normalizeAccount(unwrap(await this.request('PATCH', `/accounts/${encodeURIComponent(id)}`, { body: patch })));
  }

  deleteAccount(id) {
    return this.request('DELETE', `/accounts/${encodeURIComponent(id)}`);
  }

  /** 契约 §2.2：余额直接改成 target，并生成一条 type='adjust' 流水 */
  async adjustAccount(id, targetCents, note, date) {
    const data = await this.request('POST', `/accounts/${encodeURIComponent(id)}/adjust`, {
      body: { target_cents: Math.round(num(targetCents)), note: note || undefined, date: date || undefined },
    });
    const account = normalizeAccount((data && data.account) || {});
    return { account, transaction: (data && data.transaction) || null };
  }

  // ---------------------------------------------------------------- 标签

  async listTags(ledgerId) {
    return asArray(await this.request('GET', '/tags', { query: { ledger_id: ledgerId } })).map(normalizeTag);
  }

  async createTag(data = {}) {
    return normalizeTag(unwrap(await this.request('POST', '/tags', { body: data })));
  }

  async updateTag(id, patch = {}) {
    return normalizeTag(unwrap(await this.request('PATCH', `/tags/${encodeURIComponent(id)}`, { body: patch })));
  }

  deleteTag(id) {
    return this.request('DELETE', `/tags/${encodeURIComponent(id)}`);
  }

  // ---------------------------------------------------------------- 分类

  async listCategories(ledgerId, kind) {
    return asArray(await this.request('GET', '/categories', { query: { ledger_id: ledgerId, kind } }));
  }

  async createCategory(data = {}) {
    return unwrap(await this.request('POST', '/categories', { body: data }));
  }

  async updateCategory(id, patch = {}) {
    return unwrap(await this.request('PATCH', `/categories/${encodeURIComponent(id)}`, { body: patch }));
  }

  deleteCategory(id) {
    return this.request('DELETE', `/categories/${encodeURIComponent(id)}`);
  }

  // ---------------------------------------------------------------- 交易

  async listTransactions(filter = {}) {
    const data = await this.request('GET', '/transactions', {
      query: {
        ledger_id: filter.ledger_id,
        from: filter.from,
        to: filter.to,
        ...filterQuery(filter),
        limit: filter.limit,
        offset: filter.offset,
      },
    });
    const items = ((data && data.items) || []).map((it) => ({
      ...it,
      amount_cents: Math.round(num(it.amount_cents)),
      tags: Array.isArray(it.tags) ? it.tags : [],
      tag_names: Array.isArray(it.tag_names) ? it.tag_names : [],
      reimburse_state: it.reimburse_state || null,
      member_id: it.member_id || null,
      member_name: it.member_name || null,
    }));
    return { items, total: data && Number.isFinite(data.total) ? data.total : items.length };
  }

  async getTransaction(id) {
    // RESTful 实现通常有单条查询；没有就退回到列表里找
    try {
      const one = await this.request('GET', `/transactions/${encodeURIComponent(id)}`);
      const row = one && one.transaction ? one.transaction : one;
      if (row && row.id) return row;
    } catch (err) {
      if (!err || err.status === 0) throw err;
    }
    const list = asArray(await this.request('GET', '/transactions', { query: { limit: 500 } }));
    return list.find((it) => it.id === id) || null;
  }

  async createTransaction(data = {}) {
    // id / client_id 都可作为幂等键：重复提交同一条不会在服务端产生两条
    const body = normalizeTx({ ...data, client_id: data.client_id || data.id || undefined });
    return unwrap(await this.request('POST', '/transactions', { body }));
  }

  async updateTransaction(id, patch = {}) {
    return unwrap(await this.request('PATCH', `/transactions/${encodeURIComponent(id)}`, { body: normalizeTx(patch) }));
  }

  deleteTransaction(id) {
    return this.request('DELETE', `/transactions/${encodeURIComponent(id)}`);
  }

  /** 契约 §2.5：确认报销 → 原交易 pending→done，并生成一条 income */
  async reimburse(txId, opts = {}) {
    const data = await this.request('POST', `/transactions/${encodeURIComponent(txId)}/reimburse`, {
      body: {
        account_id: opts.accountId || undefined,
        date: opts.date || undefined,
        amount_cents: opts.amountCents != null ? Math.round(num(opts.amountCents)) : undefined,
      },
    });
    return { transaction: (data && data.transaction) || null, income: (data && data.income) || null };
  }

  // ---------------------------------------------------------------- 周期记账

  async listRecurring(ledgerId) {
    const data = await this.request('GET', '/recurring', { query: { ledger_id: ledgerId } });
    return asArray(data).map((r) => ({
      ...r,
      amount_cents: Math.round(num(r.amount_cents)),
      interval: Math.max(1, Math.round(num(r.interval) || 1)),
      enabled: r.enabled === false || r.enabled === 0 ? 0 : 1,
      due: r.due != null ? !!r.due : false,
    }));
  }

  async saveRecurring(data = {}) {
    const id = data.id;
    if (id) return unwrap(await this.request('PATCH', `/recurring/${encodeURIComponent(id)}`, { body: data }));
    return unwrap(await this.request('POST', '/recurring', { body: data }));
  }

  deleteRecurring(id) {
    return this.request('DELETE', `/recurring/${encodeURIComponent(id)}`);
  }

  async runRecurring(date) {
    const data = await this.request('POST', '/recurring/run', { body: date ? { date } : {} });
    return {
      created: (data && data.created) || [],
      skipped: (data && data.skipped) || [],
      rules: (data && data.rules) || [],
    };
  }

  // ---------------------------------------------------------------- 统计

  async summary(ledgerId, from, to, filters = {}) {
    const data = await this.request('GET', '/stats/summary', {
      query: { ledger_id: ledgerId, from, to, ...filterQuery(filters) },
    });
    if (data && (Number.isFinite(Number(data.expense_cents)) || Number.isFinite(Number(data.income_cents)))) {
      const income = Math.round(num(data.income_cents));
      const expense = Math.round(num(data.expense_cents));
      return {
        income_cents: income,
        expense_cents: expense,
        balance_cents: Math.round(num(data.balance_cents != null ? data.balance_cents : income - expense)),
        net_cents: Math.round(num(data.net_cents != null ? data.net_cents : income - expense)),
        count: Math.round(num(data.count)),
        transfer_cents: Math.round(num(data.transfer_cents)),
        adjust_cents: Math.round(num(data.adjust_cents)),
      };
    }
    return { ...summarize([], from, to), net_cents: 0, transfer_cents: 0, adjust_cents: 0 };
  }

  // 后端约定：/stats/summary 返回对象；/stats/by-category 与 /stats/trend 返回**裸数组**
  async byCategory(ledgerId, from, to, kind = 'expense', filters = {}) {
    const data = await this.request('GET', '/stats/by-category', {
      query: { ledger_id: ledgerId, from, to, kind, ...filterQuery(filters) },
    });
    return asArray(data).map((it) => ({
      category_id: it.category_id || it.id || null,
      name: it.name || '未分类',
      icon: it.icon || '📦',
      amount_cents: Math.round(num(it.amount_cents)),
      count: Math.round(num(it.count)) || 0,
      ratio: num(it.ratio),
    }));
  }

  async trend(ledgerId, from, to, granularity = 'day', filters = {}) {
    const data = await this.request('GET', '/stats/trend', {
      query: { ledger_id: ledgerId, from, to, granularity, ...filterQuery(filters) },
    });
    return asArray(data).map((it) => ({
      bucket: it.bucket || it.date || it.month,
      income_cents: Math.round(num(it.income_cents)),
      expense_cents: Math.round(num(it.expense_cents)),
    }));
  }

  async statsOverview(ledgerId, from, to, filters = {}) {
    const data = await this.request('GET', '/stats/overview', {
      query: { ledger_id: ledgerId, from, to, ...filterQuery(filters) },
    });
    const byWeekday = Array.from({ length: 7 }, (_, i) => {
      const row = ((data && data.by_weekday) || []).find((x) => Math.round(num(x.weekday)) === i) || {};
      return { weekday: i, expense_cents: Math.round(num(row.expense_cents)), count: Math.round(num(row.count)) };
    });
    return {
      income_cents: Math.round(num(data && data.income_cents)),
      expense_cents: Math.round(num(data && data.expense_cents)),
      net_cents: Math.round(num(data && data.net_cents)),
      count: Math.round(num(data && data.count)),
      days: Math.round(num(data && data.days)),
      avg_expense_cents: Math.round(num(data && data.avg_expense_cents)),
      max_expense_cents: Math.round(num(data && data.max_expense_cents)),
      max_expense_note: (data && data.max_expense_note) || '',
      by_weekday: byWeekday,
      by_type: (data && data.by_type) || {},
      by_member_top: Array.isArray(data && data.by_member_top)
        ? data.by_member_top.map((r) => ({
            name: r.name || '我',
            expense_cents: Math.round(num(r.expense_cents)),
            color: r.color || null,
          }))
        : [],
      by_member: Array.isArray(data && data.by_member) ? data.by_member : null,
    };
  }

  /** 契约 §2.3：GET /stats/by-member（裸数组）；服务器没上线就本地算 */
  async statsByMember(ledgerId, from, to, filters = {}) {
    const fallback = async () => {
      const [{ items }, members] = await Promise.all([this.listTransactions({ ledger_id: ledgerId }), this.listMembers(ledgerId)]);
      return memberStats(items, members, from, to, filters);
    };
    try {
      const data = await this.request('GET', '/stats/by-member', {
        query: { ledger_id: ledgerId, from, to, ...filterQuery(filters) },
      });
      const rows = asArray(data);
      if (!rows.length) return fallback();
      return rows.map((it) => ({
        member_id: it.member_id || null,
        member_name: it.member_name || '我',
        color: it.color || '#2f9e8f',
        expense_cents: Math.round(num(it.expense_cents)),
        income_cents: Math.round(num(it.income_cents)),
        count: Math.round(num(it.count)),
        ratio: num(it.ratio),
      }));
    } catch (err) {
      const st = err && err.status;
      if (st === 404 || st === 405 || st === 501) return fallback();
      throw err;
    }
  }

  /** 契约 §2.3：GET /stats/monthly?months=12（裸数组，升序补 0） */
  async statsMonthly(ledgerId, months = 12, today) {
    const fallback = async () => monthlySeries((await this.listTransactions({ ledger_id: ledgerId })).items, months, today);
    try {
      const data = await this.request('GET', '/stats/monthly', { query: { ledger_id: ledgerId, months } });
      const rows = asArray(data);
      if (!rows.length) return fallback();
      return rows.map((r) => ({
        month: r.month,
        expense_cents: Math.round(num(r.expense_cents)),
        income_cents: Math.round(num(r.income_cents)),
      }));
    } catch (err) {
      const st = err && err.status;
      if (st === 404 || st === 405 || st === 501) return fallback();
      throw err;
    }
  }

  async statsByAccount(ledgerId, from, to, kind = 'expense', filters = {}) {
    const data = await this.request('GET', '/stats/by-account', {
      query: { ledger_id: ledgerId, from, to, kind, ...filterQuery(filters) },
    });
    return asArray(data).map((it) => ({
      account_id: it.account_id || null,
      name: it.name || '未指定账户',
      icon: it.icon || '💳',
      type: it.type || 'other',
      kind: it.kind || 'asset',
      amount_cents: Math.round(num(it.amount_cents)),
      count: Math.round(num(it.count)),
      ratio: num(it.ratio),
    }));
  }

  async statsByTag(ledgerId, from, to, filters = {}) {
    const data = await this.request('GET', '/stats/by-tag', {
      query: { ledger_id: ledgerId, from, to, ...filterQuery(filters) },
    });
    return asArray(data).map((it) => ({
      tag_id: it.tag_id || null,
      name: it.name || '未打标签',
      color: it.color || null,
      icon: it.icon || '🏷️',
      amount_cents: Math.round(num(it.amount_cents)),
      count: Math.round(num(it.count)),
      ratio: num(it.ratio),
    }));
  }

  async statsCompare(ledgerId, from, to, filters = {}) {
    const data = await this.request('GET', '/stats/compare', {
      query: { ledger_id: ledgerId, from, to, ...filterQuery(filters) },
    });
    const cur = (data && data.current) || {};
    const prev = (data && data.previous) || {};
    const delta = (data && data.delta) || {};
    const norm = (o) => ({
      income_cents: Math.round(num(o.income_cents)),
      expense_cents: Math.round(num(o.expense_cents)),
      net_cents: Math.round(num(o.net_cents)),
      count: Math.round(num(o.count)),
    });
    return {
      current: norm(cur),
      previous: norm(prev),
      delta: {
        income_pct: delta.income_pct != null ? Number(delta.income_pct) : null,
        expense_pct: delta.expense_pct != null ? Number(delta.expense_pct) : null,
        net_cents: Math.round(num(delta.net_cents)),
      },
    };
  }

  async statsCalendar(ledgerId, month, filters = {}) {
    const data = await this.request('GET', '/stats/calendar', {
      query: { ledger_id: ledgerId, month, ...filterQuery(filters) },
    });
    return asArray(data).map((it) => ({
      date: it.date,
      expense_cents: Math.round(num(it.expense_cents)),
      income_cents: Math.round(num(it.income_cents)),
      count: Math.round(num(it.count)),
    }));
  }

  async statsReimburse(ledgerId, from, to) {
    const data = await this.request('GET', '/stats/reimburse', { query: { ledger_id: ledgerId, from, to } });
    return {
      pending_cents: Math.round(num(data && data.pending_cents)),
      pending_count: Math.round(num(data && data.pending_count)),
      done_cents: Math.round(num(data && data.done_cents)),
      done_count: Math.round(num(data && data.done_count)),
      items: (data && data.items) || [],
    };
  }

  // ---------------------------------------------------------------- 预算

  async budgetUsage(ledgerId, month) {
    const data = await this.request('GET', '/budgets', { query: { ledger_id: ledgerId, month } });
    const raw = asArray(data);
    const rows = raw.map((b) => {
      const amount = Math.round(num(b.amount_cents));
      const carry = Math.round(num(b.carry_in_cents));
      const used = Math.round(num(b.used_cents));
      const available = b.available_cents != null ? Math.round(num(b.available_cents)) : amount + carry;
      return {
        ...b,
        amount_cents: amount,
        used_cents: used,
        rollover: b.rollover === true || b.rollover === 1 ? 1 : 0,
        carry_in_cents: carry,
        available_cents: available,
        remaining_cents: b.remaining_cents != null ? Math.round(num(b.remaining_cents)) : available - used,
        category_id: b.category_id || null,
      };
    });
    // 服务端 v1.3 会直接给齐视图字段；旧服务端只给行数组，这里统一由 budgetView 兜底算
    const view = budgetView(rows, month);
    const hasServerField = data && typeof data === 'object' && !Array.isArray(data) && data.warn_level != null;
    if (hasServerField) {
      view.month = data.month || view.month;
      if (data.amount_cents != null) view.amount_cents = Math.round(num(data.amount_cents));
      if (data.used_cents != null) view.used_cents = Math.round(num(data.used_cents));
      if (data.available_cents != null) view.available_cents = Math.round(num(data.available_cents));
      if (data.remaining_cents != null) view.remaining_cents = Math.round(num(data.remaining_cents));
      if (data.carry_in_cents != null) view.carry_in_cents = Math.round(num(data.carry_in_cents));
      if (data.categories_sum_cents != null) view.categories_sum_cents = Math.round(num(data.categories_sum_cents));
      if (data.unallocated_cents != null) view.unallocated_cents = Math.round(num(data.unallocated_cents));
      if (data.mismatch != null) view.mismatch = !!data.mismatch;
      if (data.warn_percent != null) view.warn_percent = warnPercentOf(data.warn_percent);
      if (data.percent_left != null) view.percent_left = Number(data.percent_left);
      view.warn_level = data.warn_level;
    }
    view.has_budget = view.amount_cents > 0;
    // v1.3.2：预算功能总开关（服务端 GET /budgets 的 enabled，缺省 0 = 关闭）
    const flag = data && typeof data === 'object' && !Array.isArray(data) ? data.enabled : undefined;
    view.enabled = flag === true || Number(flag) === 1 ? 1 : 0;
    return view;
  }

  async getBudgets(ledgerId, month) {
    const view = await this.budgetUsage(ledgerId, month);
    const items = view.items || [];
    items.enabled = view.enabled;
    return items;
  }

  async setBudget(data = {}) {
    const body = { ...data };
    if (body.warn_percent === '' || body.warn_percent == null) delete body.warn_percent;
    if (body.unallocated_cents === '' || body.unallocated_cents == null) delete body.unallocated_cents;
    if (!body.rebalance) delete body.rebalance;
    if (body.enabled !== undefined && body.enabled !== null && body.enabled !== '') {
      body.enabled = body.enabled === true || Number(body.enabled) === 1 ? 1 : 0;
    }
    return unwrap(await this.request('PUT', '/budgets', { body }));
  }

  /** 契约里叫 saveBudget，两个名字都留 */
  async saveBudget(data = {}) {
    return this.setBudget(data);
  }

  // ---------------------------------------------------------------- 导入导出

  async exportAll(ledgerId) {
    const data = await this.request('GET', '/export', { query: { ledger_id: ledgerId, format: 'json' } });
    const d = data && data.data ? data.data : data || {};
    // 服务端导出是 {ledger:{...}, accounts, categories, ...}，抹平成和 LocalStore 一致的 ledgers 数组
    return {
      app: d.app || 'MintLite',
      schema: d.version || 2,
      exported_at: d.exported_at || new Date().toISOString(),
      ledgers: d.ledgers || (d.ledger ? [d.ledger] : []),
      accounts: asArray(d.accounts),
      categories: asArray(d.categories),
      tags: asArray(d.tags),
      transactions: asArray(d.transactions),
      transaction_tags: asArray(d.transaction_tags),
      budgets: asArray(d.budgets),
      recurring: asArray(d.recurring),
    };
  }

  async importAll(ledgerId, data) {
    return this.request('POST', '/import', { body: { ledger_id: ledgerId, data } });
  }

  /** v1.2.2：按原始文本导入（csv / mint / json），format=auto 时交给服务端识别。 */
  async importText(ledgerId, { format = 'auto', data, dryRun = false } = {}) {
    return this.request('POST', '/import', {
      body: { ledger_id: ledgerId, format, data, dry_run: !!dryRun },
    });
  }

  // ---------------------------------------------------------------- 维护

  async getMeta(key, fallback = null) {
    try {
      const data = await this.request('GET', '/meta', { query: { key } });
      return data ? data.value : fallback;
    } catch {
      return fallback;
    }
  }

  async setMeta() {
    return null;
  }

  async clearSampleData() {
    return 0;
  }

  async storageEstimate() {
    return { usage: 0, quota: 0 };
  }

  // ---------------------------------------------------------------- 全量搬运（同步页用）

  async pullAll(ledgerId) {
    const [ledgers, assets, categories, transactions, budgets, tags, recurring] = [
      await this.listLedgers(),
      await this.listAssets(ledgerId),
      await this.listCategories(ledgerId),
      (await this.listTransactions({ ledger_id: ledgerId, limit: 100000 })).items,
      await this.getBudgets(ledgerId, monthKey(new Date())),
      await this.listTags(ledgerId),
      await this.listRecurring(ledgerId),
    ];
    return {
      app: 'MintLite',
      schema: 2,
      exported_at: new Date().toISOString(),
      ledgers,
      accounts: assets.items,
      categories,
      tags,
      transactions,
      transaction_tags: transactions.flatMap((t) => (t.tags || []).map((tagId) => ({ transaction_id: t.id, tag_id: tagId }))),
      budgets,
      recurring,
    };
  }

  /** 供同步页兜底：本地算出统计（服务端统计接口挂了也不至于白屏） */
  localSummary(txs, from, to) {
    return summarize(txs.filter(isLive), from, to);
  }

  localByCategory(txs, categories, kind, from, to) {
    return groupByCategory(txs, categories, kind, from, to);
  }

  localTrend(txs, from, to, granularity) {
    return calcTrend(txs, from, to, granularity);
  }
}

function monthKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
}

/** 登录：POST /auth/login → {token, user} */
export async function apiLogin(baseUrl, username, password) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  const res = await fetch(`${root}${PREFIX}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `登录失败 ${res.status}`;
    throw new ApiError(msg, res.status, (data && data.error && data.error.code) || 'AUTH');
  }
  return data;
}

/** 注册：POST /auth/register */
export async function apiRegister(baseUrl, username, password) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  const res = await fetch(`${root}${PREFIX}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `注册失败 ${res.status}`;
    throw new ApiError(msg, res.status, (data && data.error && data.error.code) || 'AUTH');
  }
  return data;
}
