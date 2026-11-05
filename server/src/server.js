// MintLite server · HTTP 层
// 零依赖：node:http 自写 router + node:sqlite 存取 + 静态托管 web/
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { db, initDb, applyTxEffect, tx, newId, nowIso, dbPath, createDefaultLedger } from './db.js';
import { hashPassword, verifyPassword, createToken, verifyToken, extractBearer, dataDir } from './auth.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, '..');
const WEB_DIR = path.resolve(SERVER_DIR, '..', 'web');
const PORT = Number(process.env.PORT || 8787);
const VERSION = '1.3.2';
const API_PREFIX = '/api/v1';
const BODY_LIMIT = 2 * 1024 * 1024;

initDb();

/* --------------------------------- 错误类型 --------------------------------- */

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const fail = (status, code, message, details) => {
  throw new HttpError(status, code, message, details);
};

/* --------------------------------- 响应工具 --------------------------------- */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'Access-Control-Max-Age': '86400',
  'Access-Control-Expose-Headers': 'Content-Disposition',
};

function sendJson(res, status, body, extra) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    // 接口响应绝不缓存：同源部署时浏览器/SW 缓存会把不同 ledger_id、不同筛选的 GET 混成一份旧数据
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(payload);
}

function sendRaw(res, status, headers, payload) {
  if (res.writableEnded) return;
  res.writeHead(status, { ...CORS, ...headers });
  res.end(payload);
}

const ok = (body) => ({ __http: true, status: 200, body });
const created = (body) => ({ __http: true, status: 201, body });
const raw = (status, headers, payload) => ({ __http: true, status, headers, payload, isRaw: true });

/* --------------------------------- 通用校验 --------------------------------- */

const pad2 = (n) => String(n).padStart(2, '0');

function asInt(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clampInt(value, min, max, fallback) {
  const n = asInt(value, fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const isNonEmptyString = (v, max = 200) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/** 跨账本导入时给被占用的 id 派生一个确定性 id → 重复导入仍然幂等 */
function stableId(kind, ledgerId, oldId) {
  const h = crypto.createHash('sha1').update(`${kind}:${ledgerId}:${oldId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/;

/* --------------------------------- 资源校验 --------------------------------- */

function getLedgerOrThrow(uid, ledgerId) {
  if (!ledgerId) fail(400, 'missing_ledger_id', '缺少 ledger_id');
  const row = db.prepare('SELECT * FROM ledgers WHERE id = ?').get(String(ledgerId));
  if (!row) fail(404, 'ledger_not_found', '账本不存在');
  if (row.user_id !== uid) fail(403, 'forbidden', '无权访问该账本');
  if (row.deleted_at) fail(404, 'ledger_not_found', '账本已删除');
  return row;
}

/** 给了 ledger_id 就校验归属；没给就用当前用户的默认账本。 */
function resolveLedgerId(uid, ledgerId) {
  if (ledgerId) return getLedgerOrThrow(uid, ledgerId).id;
  const row = db
    .prepare(
      "SELECT * FROM ledgers WHERE user_id = ? AND deleted_at IS NULL ORDER BY is_default DESC, created_at ASC LIMIT 1",
    )
    .get(uid);
  if (!row) fail(404, 'ledger_not_found', '你还没有账本，请先创建');
  return row.id;
}

function accountInLedger(ledgerId, accountId) {
  if (!accountId) return null;
  const row = db
    .prepare('SELECT * FROM accounts WHERE id = ? AND ledger_id = ? AND deleted_at IS NULL')
    .get(String(accountId), ledgerId);
  if (!row) fail(400, 'invalid_account', '账户不存在或不属于该账本');
  return row;
}

function categoryInLedger(ledgerId, categoryId) {
  if (!categoryId) return null;
  const row = db
    .prepare('SELECT * FROM categories WHERE id = ? AND ledger_id = ? AND deleted_at IS NULL')
    .get(String(categoryId), ledgerId);
  if (!row) fail(400, 'invalid_category', '分类不存在或不属于该账本');
  return row;
}

/* --------------------------------- 交易归一化 -------------------------------- */

const TX_TYPES = new Set(['expense', 'income', 'transfer']); // 可新建的业务类型
const TX_SOURCES = new Set(['manual', 'auto', 'import']);
const REIMBURSE_STATES = new Set(['pending', 'done']);
// 可筛选的类型：adjust 是余额校准流水，只读、不计收支
const FILTER_TYPES = new Set(['expense', 'income', 'transfer', 'adjust']);

const ALL_TIME_FROM = '0000-01-01';
const ALL_TIME_TO = '9999-12-31';

function normalizeTx(input, base, ledgerId) {
  const pick = (key, fallback) => (input[key] !== undefined ? input[key] : fallback);

  const type = pick('type', base?.type ?? 'expense');
  if (!TX_TYPES.has(type)) fail(400, 'invalid_type', "type 必须是 expense / income / transfer");

  const amountRaw = pick('amount_cents', base?.amount_cents);
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
    fail(400, 'invalid_amount', 'amount_cents 必须是大于 0 的整数（单位：分）');
  }

  const accountId = pick('account_id', base?.account_id ?? null);
  if (accountId) accountInLedger(ledgerId, accountId);

  let toAccountId = pick('to_account_id', base?.to_account_id ?? null);
  if (type === 'transfer') {
    if (!accountId) fail(400, 'invalid_transfer', '转账必须提供 account_id 与 to_account_id');
    if (!toAccountId) fail(400, 'invalid_transfer', '转账必须提供 account_id 与 to_account_id');
    if (String(toAccountId) === String(accountId)) fail(400, 'invalid_transfer', '转出与转入账户不能相同');
    accountInLedger(ledgerId, toAccountId);
  } else {
    toAccountId = null;
  }

  let categoryId = pick('category_id', base?.category_id ?? null);
  if (type === 'transfer') {
    categoryId = null;
  } else if (categoryId) {
    categoryInLedger(ledgerId, categoryId);
  }

  const note = pick('note', base?.note ?? null);
  if (note !== null && typeof note !== 'string') fail(400, 'invalid_note', 'note 必须是字符串');

  const happenedAt = String(pick('happened_at', base?.happened_at ?? todayLocal()) || '').trim();
  if (!DATE_RE.test(happenedAt)) fail(400, 'invalid_happened_at', 'happened_at 需为 ISO-8601 日期，如 2026-11-04');

  const source = pick('source', base?.source ?? 'manual');
  if (!TX_SOURCES.has(source)) fail(400, 'invalid_source', 'source 必须是 manual / auto / import');

  const externalIdRaw = pick('external_id', base?.external_id ?? null);
  const externalId = externalIdRaw === null || externalIdRaw === undefined || externalIdRaw === '' ? null : String(externalIdRaw);

  // v1.2 成员维度：空 = 「我」
  const memberRaw = pick('member_id', base?.member_id ?? null);
  const memberId = memberRaw === null || memberRaw === undefined || memberRaw === '' ? null : String(memberRaw);
  if (memberId && !memberInLedger(ledgerId, memberId)) {
    fail(400, 'invalid_member', '成员不存在或不属于该账本');
  }

  return {
    type,
    amount_cents: amount,
    category_id: categoryId ? String(categoryId) : null,
    account_id: accountId ? String(accountId) : null,
    to_account_id: toAccountId ? String(toAccountId) : null,
    note: note === null || note === undefined ? null : String(note).slice(0, 1000),
    happened_at: happenedAt,
    source,
    external_id: externalId,
    member_id: memberId,
  };
}

const TX_SELECT = `
  SELECT t.*,
         c.name AS category_name, c.icon AS category_icon,
         a.name AS account_name, ta.name AS to_account_name,
         m.name AS member_name, m.color AS member_color
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN accounts a ON a.id = t.account_id
    LEFT JOIN accounts ta ON ta.id = t.to_account_id
    LEFT JOIN members m ON m.id = t.member_id AND m.deleted_at IS NULL
`;

function loadTx(uid, id) {
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(String(id));
  if (!row) fail(404, 'transaction_not_found', '交易不存在');
  getLedgerOrThrow(uid, row.ledger_id);
  return row;
}

function txWithNames(id) {
  const row = db.prepare(`${TX_SELECT} WHERE t.id = ?`).get(String(id));
  return row ? withTags(row) : row;
}

/* --------------------------------- 标签工具 -------------------------------- */

const TAG_SELECT = 'SELECT * FROM tags WHERE ledger_id = ? AND deleted_at IS NULL ORDER BY created_at ASC';

function tagOut(row, usage = 0) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    usage_count: usage,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function tagList(ledgerId) {
  const rows = db.prepare(TAG_SELECT).all(ledgerId);
  const counts = new Map(
    db
      .prepare(
        `SELECT tt.tag_id AS tag_id, COUNT(*) AS n
           FROM transaction_tags tt
           JOIN transactions t ON t.id = tt.transaction_id
          WHERE t.ledger_id = ? AND t.deleted_at IS NULL
          GROUP BY tt.tag_id`,
      )
      .all(ledgerId)
      .map((r) => [r.tag_id, r.n]),
  );
  return rows.map((r) => tagOut(r, counts.get(r.id) ?? 0));
}

/** 批量取交易的标签：Map<transactionId, {ids, names}> */
function tagsOf(ids) {
  const map = new Map();
  if (!ids.length) return map;
  const ph = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT tt.transaction_id AS tid, g.id AS id, g.name AS name
         FROM transaction_tags tt
         JOIN tags g ON g.id = tt.tag_id
        WHERE tt.transaction_id IN (${ph}) AND g.deleted_at IS NULL
        ORDER BY g.created_at ASC`,
    )
    .all(...ids);
  for (const r of rows) {
    if (!map.has(r.tid)) map.set(r.tid, { ids: [], names: [] });
    const bucket = map.get(r.tid);
    bucket.ids.push(r.id);
    bucket.names.push(r.name);
  }
  return map;
}

function withTags(row) {
  const m = tagsOf([row.id]).get(row.id);
  return { ...row, tags: m?.ids ?? [], tag_names: m?.names ?? [] };
}

function withTagsBatch(rows) {
  const map = tagsOf(rows.map((r) => r.id));
  return rows.map((r) => {
    const m = map.get(r.id);
    return { ...r, tags: m?.ids ?? [], tag_names: m?.names ?? [] };
  });
}

/** 用 tags: string[] 整体替换关联（只保留本账本内存在且未删除的标签） */
function replaceTxTags(txId, ledgerId, tagIds) {
  db.prepare('DELETE FROM transaction_tags WHERE transaction_id = ?').run(txId);
  if (!Array.isArray(tagIds) || !tagIds.length) return [];
  const ins = db.prepare('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?,?)');
  const seen = new Set();
  for (const raw of tagIds) {
    if (raw === null || raw === undefined || raw === '') continue;
    const tagId = String(raw);
    if (seen.has(tagId)) continue;
    const hit = db.prepare('SELECT id FROM tags WHERE id = ? AND ledger_id = ? AND deleted_at IS NULL').get(tagId, ledgerId);
    if (!hit) continue;
    ins.run(txId, tagId);
    seen.add(tagId);
  }
  return [...seen];
}

/* ------------------------------- 统一筛选参数 ------------------------------- */

/**
 * 所有 /stats/* 与 GET /transactions 共用的筛选：
 * from,to,type,account_id,category_id,tag_id,q,min_cents,max_cents
 * @returns {{whereSql:string,args:any[],from:string,to:string}}
 */
function txFilter(ctx, ledgerId) {
  const where = ['t.ledger_id = ?', 't.deleted_at IS NULL'];
  const args = [ledgerId];
  const fromRaw = qs(ctx, 'from');
  const toRaw = qs(ctx, 'to');
  const from = fromRaw ? String(fromRaw).slice(0, 10) : ALL_TIME_FROM;
  const to = toRaw ? String(toRaw).slice(0, 10) : ALL_TIME_TO;
  where.push('substr(t.happened_at, 1, 10) >= ?', 'substr(t.happened_at, 1, 10) <= ?');
  args.push(from, to);

  const type = qs(ctx, 'type');
  if (type) {
    if (!FILTER_TYPES.has(type)) fail(400, 'invalid_type', 'type 必须是 expense/income/transfer/adjust');
    where.push('t.type = ?');
    args.push(type);
  }
  const categoryId = qs(ctx, 'category_id');
  if (categoryId) {
    where.push('t.category_id = ?');
    args.push(categoryId);
  }
  const accountId = qs(ctx, 'account_id');
  if (accountId) {
    where.push('(t.account_id = ? OR t.to_account_id = ?)');
    args.push(accountId, accountId);
  }
  const tagId = qs(ctx, 'tag_id');
  if (tagId) {
    where.push('EXISTS (SELECT 1 FROM transaction_tags xt WHERE xt.transaction_id = t.id AND xt.tag_id = ?)');
    args.push(tagId);
  }
  const q = qs(ctx, 'q');
  if (q) {
    // v1.2.2：搜索不再只看备注——分类名 / 账户名 / 成员名 / 标签名 都算命中，
    // 否则从薄荷导入的账单（备注多为空、分类才是语义）搜「通讯」一条都搜不到。
    const like = `%${q}%`;
    where.push(
      `(t.note LIKE ?
        OR EXISTS (SELECT 1 FROM categories qc WHERE qc.id = t.category_id AND qc.name LIKE ?)
        OR EXISTS (SELECT 1 FROM accounts qa WHERE qa.id IN (t.account_id, t.to_account_id) AND qa.name LIKE ?)
        OR EXISTS (SELECT 1 FROM members qm WHERE qm.id = t.member_id AND qm.name LIKE ?)
        OR EXISTS (SELECT 1 FROM transaction_tags qx JOIN tags qg ON qg.id = qx.tag_id
                    WHERE qx.transaction_id = t.id AND qg.name LIKE ?))`,
    );
    args.push(like, like, like, like, like);
  }
  // v1.2 成员筛选：member_id=self 表示「我」（含未挂成员的历史数据）
  const memberId = qs(ctx, 'member_id');
  if (memberId) {
    if (memberId === 'self' || memberId === '0') {
      const selfId =
        db
          .prepare('SELECT id FROM members WHERE ledger_id = ? AND is_self = 1 AND deleted_at IS NULL')
          .get(ledgerId)?.id ?? null;
      if (selfId) {
        where.push('(t.member_id = ? OR t.member_id IS NULL)');
        args.push(selfId);
      } else {
        where.push('t.member_id IS NULL');
      }
    } else {
      where.push('t.member_id = ?');
      args.push(memberId);
    }
  }
  const minCents = qs(ctx, 'min_cents');
  if (minCents !== undefined && minCents !== '') {
    where.push('t.amount_cents >= ?');
    args.push(asInt(minCents, 0));
  }
  const maxCents = qs(ctx, 'max_cents');
  if (maxCents !== undefined && maxCents !== '') {
    where.push('t.amount_cents <= ?');
    args.push(asInt(maxCents, 0));
  }
  return { whereSql: where.join(' AND '), args, from, to };
}

/* ---------------------------------- 鉴权 ---------------------------------- */

function requireUser(req) {
  const token = extractBearer(req);
  if (!token) fail(401, 'unauthorized', '缺少 Authorization: Bearer <token>');
  const payload = verifyToken(token);
  if (!payload) fail(401, 'invalid_token', 'token 无效或已过期');
  const user = db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(payload.uid);
  if (!user) fail(401, 'invalid_token', '用户不存在');
  return user;
}

/* ---------------------------------- 路由表 --------------------------------- */

const routes = [];

function on(method, pattern, handler, opts = {}) {
  const keys = [];
  const source = pattern.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, key) => {
    keys.push(key);
    return '([^/]+)';
  });
  routes.push({ method, re: new RegExp(`^${source}$`), keys, handler, auth: opts.auth !== false });
}

const qs = (ctx, key) => (ctx.query.has(key) ? ctx.query.get(key) : undefined);

/* --------------------------------- 基础接口 -------------------------------- */

on('GET', '/health', () => ok({ ok: true, version: VERSION, time: nowIso() }), { auth: false });

on(
  'POST',
  '/auth/register',
  (ctx) => {
    const body = ctx.body || {};
    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '');
    if (!/^[\w\u4e00-\u9fa5.@+-]{2,32}$/u.test(username)) {
      fail(400, 'invalid_username', '用户名需 2-32 位（字母 / 数字 / 中文 / . @ + -）');
    }
    if (password.length < 6 || password.length > 128) fail(400, 'invalid_password', '密码长度需 6-128 位');
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
      fail(409, 'username_taken', '用户名已被占用');
    }
    const id = newId();
    const at = nowIso();
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?,?,?,?)').run(
      id,
      username,
      hashPassword(password),
      at,
    );
    createDefaultLedger(id, { name: '日常账本' });
    return created({ token: createToken(id), user: { id, username, created_at: at } });
  },
  { auth: false },
);

on(
  'POST',
  '/auth/login',
  (ctx) => {
    const body = ctx.body || {};
    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '');
    if (!username || !password) fail(400, 'missing_credentials', '请输入用户名和密码');
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!row || !verifyPassword(password, row.password_hash)) {
      fail(401, 'invalid_credentials', '用户名或密码错误');
    }
    return ok({
      token: createToken(row.id),
      user: { id: row.id, username: row.username, created_at: row.created_at },
    });
  },
  { auth: false },
);

on('GET', '/me', (ctx) => ok(ctx.user));

/* ---------------------------------- 账本 ---------------------------------- */

function ledgerRow(row) {
  return {
    ...row,
    is_default: row.is_default ? 1 : 0,
    archived: row.archived ? 1 : 0,
    sort: Number(row.sort || 0),
    budget_enabled: row.budget_enabled ? 1 : 0,
  };
}

on('GET', '/ledgers', (ctx) => {
  const items = db
    .prepare('SELECT * FROM ledgers WHERE user_id = ? AND deleted_at IS NULL ORDER BY sort ASC, is_default DESC, created_at ASC')
    .all(ctx.user.id)
    .map(ledgerRow);
  // ?legacy=1：v1.1 之前前端直接拿数组
  if (qs(ctx, 'legacy') === '1') return ok(items);
  return ok({ items, total: items.length });
});

on('POST', '/ledgers', (ctx) => {
  const body = ctx.body || {};
  const name = String(body.name ?? '').trim();
  if (!isNonEmptyString(name, 60)) fail(400, 'invalid_name', '账本名需 1-60 个字符');
  const currency = String(body.currency ?? 'CNY').trim().toUpperCase() || 'CNY';
  if (!/^[A-Z]{3}$/.test(currency)) fail(400, 'invalid_currency', 'currency 需为 3 位货币代码，如 CNY');
  const at = nowIso();
  const count = db.prepare('SELECT COUNT(*) AS n FROM ledgers WHERE user_id = ? AND deleted_at IS NULL').get(ctx.user.id).n;
  const isDefault = count === 0 || body.is_default === true || body.is_default === 1 ? 1 : 0;
  if (isDefault) {
    db.prepare('UPDATE ledgers SET is_default = 0, updated_at = ? WHERE user_id = ?').run(at, ctx.user.id);
  }
  // 新账本自带默认账户 / 分类 /「我」成员，切过去就能直接记账；
  // 标签属于个人高度自定义的部分，新账本不预置（避免与导入的同名标签互相遮挡）
  const { ledgerId } = tx(() =>
    createDefaultLedger(ctx.user.id, {
      name,
      currency,
      isDefault: !!isDefault,
      sort: asInt(body.sort, count),
      withTags: false,
    }),
  );
  return created(ledgerRow(db.prepare('SELECT * FROM ledgers WHERE id = ?').get(ledgerId)));
});

on('PATCH', '/ledgers/:id', (ctx) => {
  const row = getLedgerOrThrow(ctx.user.id, ctx.params.id);
  const body = ctx.body || {};
  const at = nowIso();
  const next = {
    name: body.name !== undefined ? String(body.name).trim() : row.name,
    currency: body.currency !== undefined ? String(body.currency).trim().toUpperCase() : row.currency,
    is_default: body.is_default !== undefined ? (body.is_default ? 1 : 0) : row.is_default,
    archived: body.archived !== undefined ? (body.archived ? 1 : 0) : row.archived,
    sort: body.sort !== undefined ? asInt(body.sort, row.sort) : Number(row.sort || 0),
    budget_enabled: body.budget_enabled !== undefined ? (body.budget_enabled ? 1 : 0) : Number(row.budget_enabled ? 1 : 0),
  };
  if (!isNonEmptyString(next.name, 60)) fail(400, 'invalid_name', '账本名需 1-60 个字符');
  if (!/^[A-Z]{3}$/.test(next.currency)) fail(400, 'invalid_currency', 'currency 需为 3 位货币代码');
  if (next.is_default) {
    db.prepare('UPDATE ledgers SET is_default = 0, updated_at = ? WHERE user_id = ? AND id <> ?').run(at, ctx.user.id, row.id);
  }
  db.prepare(
    'UPDATE ledgers SET name = ?, currency = ?, is_default = ?, archived = ?, sort = ?, budget_enabled = ?, updated_at = ? WHERE id = ?',
  ).run(
    next.name,
    next.currency,
    next.is_default,
    next.archived ? 1 : 0,
    next.sort,
    next.budget_enabled,
    at,
    row.id,
  );
  return ok(ledgerRow(db.prepare('SELECT * FROM ledgers WHERE id = ?').get(row.id)));
});

on('DELETE', '/ledgers/:id', (ctx) => {
  const row = getLedgerOrThrow(ctx.user.id, ctx.params.id);
  const alive = db
    .prepare('SELECT id FROM ledgers WHERE user_id = ? AND deleted_at IS NULL')
    .all(ctx.user.id)
    .filter((l) => l.id !== row.id);
  if (!alive.length) fail(409, 'last_ledger', '最后一个账本不能删除');
  const at = nowIso();
  tx(() => {
    db.prepare('UPDATE ledgers SET deleted_at = ?, updated_at = ? WHERE id = ?').run(at, at, row.id);
    db.prepare('UPDATE accounts SET deleted_at = ?, updated_at = ? WHERE ledger_id = ? AND deleted_at IS NULL').run(at, at, row.id);
    db.prepare('UPDATE categories SET deleted_at = ?, updated_at = ? WHERE ledger_id = ? AND deleted_at IS NULL').run(at, at, row.id);
    db.prepare('UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE ledger_id = ? AND deleted_at IS NULL').run(at, at, row.id);
    // 删的是默认账本：把默认标记挪到最早的一本，避免整站没有默认账本
    if (row.is_default && alive.length) {
      db.prepare('UPDATE ledgers SET is_default = 1, updated_at = ? WHERE id = ?').run(at, alive[0].id);
    }
  });
  return ok({ ok: true, id: row.id });
});

/* ---------------------------------- 成员 ---------------------------------- */

const MEMBER_SELECT = 'SELECT * FROM members WHERE ledger_id = ? AND deleted_at IS NULL ORDER BY sort ASC, created_at ASC';

function memberOut(row) {
  return {
    ...row,
    is_self: row.is_self ? 1 : 0,
    sort: Number(row.sort || 0),
  };
}

function memberInLedger(ledgerId, memberId) {
  if (memberId == null || memberId === '') return null;
  return (
    db
      .prepare('SELECT * FROM members WHERE id = ? AND ledger_id = ? AND deleted_at IS NULL')
      .get(String(memberId), ledgerId) ?? null
  );
}

on('GET', '/members', (ctx) => {
  const ledgerId = resolveLedgerId(ctx.user.id, qs(ctx, 'ledger_id'));
  const items = db.prepare(MEMBER_SELECT).all(ledgerId).map(memberOut);
  return ok({ items, total: items.length });
});

on('POST', '/members', (ctx) => {
  const body = ctx.body || {};
  const ledgerId = resolveLedgerId(ctx.user.id, body.ledger_id);
  const name = String(body.name ?? '').trim();
  if (!isNonEmptyString(name, 20)) fail(400, 'invalid_name', '成员名需 1-20 个字符');
  const color = body.color == null ? '#8C8C8C' : String(body.color).trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) fail(400, 'invalid_color', 'color 需为 #rrggbb');
  const clash = db
    .prepare('SELECT id FROM members WHERE ledger_id = ? AND name = ? AND deleted_at IS NULL')
    .get(ledgerId, name);
  if (clash) fail(409, 'member_exists', '成员名已存在');
  const isSelf = body.is_self === true || body.is_self === 1 ? 1 : 0;
  const at = nowIso();
  const id = body.id ? String(body.id) : newId();
  if (isSelf) db.prepare('UPDATE members SET is_self = 0, updated_at = ? WHERE ledger_id = ?').run(at, ledgerId);
  const nextSort =
    body.sort !== undefined
      ? asInt(body.sort, 0)
      : (db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM members WHERE ledger_id = ?').get(ledgerId).m ?? -1) + 1;
  db.prepare(
    `INSERT INTO members (id, ledger_id, name, color, is_self, sort, created_at, updated_at, deleted_at)
     VALUES (?,?,?,?,?,?,?,?,NULL)`,
  ).run(id, ledgerId, name, color, isSelf, nextSort, at, at);
  return created(memberOut(db.prepare('SELECT * FROM members WHERE id = ?').get(id)));
});

on('PATCH', '/members/:id', (ctx) => {
  const row = db.prepare('SELECT * FROM members WHERE id = ?').get(String(ctx.params.id));
  if (!row || row.deleted_at) fail(404, 'member_not_found', '成员不存在');
  getLedgerOrThrow(ctx.user.id, row.ledger_id);
  const body = ctx.body || {};
  const name = body.name !== undefined ? String(body.name).trim() : row.name;
  if (!isNonEmptyString(name, 20)) fail(400, 'invalid_name', '成员名需 1-20 个字符');
  const clash = db
    .prepare('SELECT id FROM members WHERE ledger_id = ? AND name = ? AND deleted_at IS NULL AND id <> ?')
    .get(row.ledger_id, name, row.id);
  if (clash) fail(409, 'member_exists', '成员名已存在');
  const color = body.color !== undefined ? String(body.color).trim() : row.color;
  if (color != null && !/^#[0-9a-fA-F]{6}$/.test(color)) fail(400, 'invalid_color', 'color 需为 #rrggbb');
  const sort = body.sort !== undefined ? asInt(body.sort, row.sort) : Number(row.sort || 0);
  db.prepare('UPDATE members SET name = ?, color = ?, sort = ?, updated_at = ? WHERE id = ?').run(
    name,
    color,
    sort,
    nowIso(),
    row.id,
  );
  return ok(memberOut(db.prepare('SELECT * FROM members WHERE id = ?').get(row.id)));
});

on('DELETE', '/members/:id', (ctx) => {
  const row = db.prepare('SELECT * FROM members WHERE id = ?').get(String(ctx.params.id));
  if (!row || row.deleted_at) fail(404, 'member_not_found', '成员不存在');
  getLedgerOrThrow(ctx.user.id, row.ledger_id);
  if (row.is_self) fail(409, 'self_member_undeletable', '「我」这个成员不能删除');
  const at = nowIso();
  tx(() => {
    db.prepare('UPDATE members SET deleted_at = ?, updated_at = ? WHERE id = ?').run(at, at, row.id);
    // 成员删了，历史交易退回「我」语义（member_id 置空）
    db.prepare('UPDATE transactions SET member_id = NULL, updated_at = ? WHERE member_id = ?').run(at, row.id);
  });
  return ok({ ok: true, id: row.id });
});

/* ---------------------------------- 账户 ---------------------------------- */

const ACCOUNT_TYPES = new Set(['cash', 'bank', 'credit', 'invest', 'receivable', 'payable', 'ewallet', 'other']);
const ACCOUNT_TYPE_HINT = 'type 必须是 cash/bank/ewallet/credit/invest/receivable/payable/other';
const ACCOUNT_KINDS = new Set(['asset', 'liability']);

const ACC_SELECT = 'SELECT * FROM accounts WHERE ledger_id = ? AND deleted_at IS NULL ORDER BY sort ASC, created_at ASC';

/* v1.2 资产分组：type → group 只读派生，前端不要自己再算 */
const ACCOUNT_GROUP_OF = {
  cash: 'cash',
  bank: 'bank',
  ewallet: 'ewallet',
  credit: 'credit',
  invest: 'invest',
  receivable: 'receivable',
  payable: 'payable',
  other: 'other',
};
const ACCOUNT_GROUPS = [
  { key: 'cash', title: '现金' },
  { key: 'bank', title: '储蓄卡' },
  { key: 'ewallet', title: '电子钱包' },
  { key: 'credit', title: '信用卡·信用付' },
  { key: 'invest', title: '投资' },
  { key: 'receivable', title: '应收' },
  { key: 'payable', title: '应付' },
  { key: 'other', title: '其他' },
];
const groupOf = (type) => ACCOUNT_GROUP_OF[type] ?? 'other';

/** 账单日 / 还款日：1–31 的整数，或 null */
function normalizeDayOfMonth(value, field) {
  if (value === null || value === '' || value === undefined) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 31) fail(400, 'invalid_day', `${field} 需为 1-31 的整数`);
  return n;
}

function accountOut(row) {
  // used_cents 只对信用类账户有意义：欠款 = 负余额的绝对值
  const used = row.type === 'credit' ? Math.max(0, -Number(row.balance_cents || 0)) : 0;
  return {
    ...row,
    include_in_net: !!row.include_in_net,
    credit_limit_cents: Number(row.credit_limit_cents || 0),
    used_cents: used,
    group: groupOf(row.type),
    bill_day: row.bill_day == null ? null : Number(row.bill_day),
    repay_day: row.repay_day == null ? null : Number(row.repay_day),
    hidden: row.hidden ? 1 : 0,
  };
}

/** 分组小计：资产组=余额和，负债组=负的欠款和（都是带符号的金额，负债为负） */
function accountGroups(rows) {
  const out = [];
  for (const g of ACCOUNT_GROUPS) {
    const hit = rows.filter((a) => a.group === g.key);
    if (!hit.length) continue;
    let sub = 0;
    for (const a of hit) {
      const bal = Number(a.balance_cents || 0);
      sub += a.kind === 'liability' ? -Math.max(0, -bal) : bal;
    }
    out.push({ key: g.key, title: g.title, count: hit.length, subtotal_cents: sub, hidden_count: hit.filter((a) => a.hidden).length });
  }
  return out;
}

/** 净资产口径：只统计 include_in_net=1 的账户；资产=正余额之和，负债=欠款绝对值之和 */
function accountTotals(rows) {
  let asset = 0;
  let liability = 0;
  for (const a of rows) {
    if (!a.include_in_net) continue;
    const bal = Number(a.balance_cents || 0);
    if (a.kind === 'liability') liability += Math.max(0, -bal);
    else asset += bal;
  }
  return { asset_cents: asset, liability_cents: liability, net_cents: asset - liability };
}

on('GET', '/accounts', (ctx) => {
  const ledgerId = resolveLedgerId(ctx.user.id, qs(ctx, 'ledger_id'));
  const all = db.prepare(ACC_SELECT).all(ledgerId).map(accountOut);
  const includeHidden = qs(ctx, 'include_hidden') !== '0';
  const items = includeHidden ? all : all.filter((a) => !a.hidden);
  const totals = accountTotals(items);
  // ?legacy=1 给还没适配的老前端：裸数组
  if (qs(ctx, 'legacy') === '1') return ok(items);
  return ok({
    items,
    total: items.length,
    totals,
    groups: accountGroups(items),
    hidden_count: items.filter((a) => a.hidden).length,
  });
});

/* 还款提醒：只关心「有欠款 + 有还款日」的负债账户 */
on('GET', '/accounts/reminders', (ctx) => {
  const ledgerId = resolveLedgerId(ctx.user.id, qs(ctx, 'ledger_id'));
  const today = todayLocal();
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const items = db
    .prepare(ACC_SELECT)
    .all(ledgerId)
    .map(accountOut)
    .filter((a) => a.kind === 'liability' && a.used_cents > 0 && a.repay_day != null)
    .map((a) => {
      const [y, m] = today.split('-').map(Number);
      const day = Math.min(a.repay_day, new Date(Date.UTC(y, m, 0)).getUTCDate());
      let due = `${y}-${pad2(m)}-${pad2(day)}`;
      if (Date.parse(`${due}T00:00:00Z`) < todayMs) {
        const ny = m === 12 ? y + 1 : y;
        const nm = m === 12 ? 1 : m + 1;
        const nd = Math.min(a.repay_day, new Date(Date.UTC(ny, nm, 0)).getUTCDate());
        due = `${ny}-${pad2(nm)}-${pad2(nd)}`;
      }
      const daysLeft = Math.round((Date.parse(`${due}T00:00:00Z`) - todayMs) / 86400000);
      const status = daysLeft < 0 ? 'overdue' : daysLeft === 0 ? 'today' : daysLeft <= 7 ? 'soon' : 'later';
      return {
        account_id: a.id,
        name: a.name,
        type: a.type,
        used_cents: a.used_cents,
        credit_limit_cents: a.credit_limit_cents,
        bill_day: a.bill_day,
        repay_day: a.repay_day,
        due_date: due,
        days_left: daysLeft,
        status,
      };
    })
    .sort((x, y) => x.days_left - y.days_left || x.name.localeCompare(y.name));
  return ok({ items, today });
});

on('POST', '/accounts', (ctx) => {
  const body = ctx.body || {};
  const ledgerId = resolveLedgerId(ctx.user.id, body.ledger_id);
  const name = String(body.name ?? '').trim();
  if (!isNonEmptyString(name, 40)) fail(400, 'invalid_name', '账户名需 1-40 个字符');
  const type = String(body.type ?? 'other');
  if (!ACCOUNT_TYPES.has(type)) fail(400, 'invalid_type', ACCOUNT_TYPE_HINT);
  // kind 省略时按 type 推导：credit/payable 是负债，其余是资产
  const kind = String(body.kind ?? (type === 'credit' || type === 'payable' ? 'liability' : 'asset'));
  if (!ACCOUNT_KINDS.has(kind)) fail(400, 'invalid_kind', 'kind 必须是 asset / liability');
  const id = body.id ? String(body.id) : newId();
  const at = nowIso();
  // 额度 / 账单日 / 还款日只对信用卡类账户有意义，其它类型即使传了也落 0 / NULL
  const isCredit = type === 'credit';
  const billDay = isCredit ? normalizeDayOfMonth(body.bill_day, 'bill_day') : null;
  const repayDay = isCredit ? normalizeDayOfMonth(body.repay_day, 'repay_day') : null;
  db.prepare(
    `INSERT INTO accounts (id, ledger_id, name, type, kind, balance_cents, credit_limit_cents, icon, sort, include_in_net,
       bill_day, repay_day, hidden, created_at, updated_at, deleted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
  ).run(
    id,
    ledgerId,
    name,
    type,
    kind,
    asInt(body.balance_cents ?? body.initial_cents, 0),
    isCredit ? Math.max(0, asInt(body.credit_limit_cents, 0)) : 0,
    body.icon == null ? null : String(body.icon).slice(0, 16),
    asInt(body.sort, 0),
    body.include_in_net === false || body.include_in_net === 0 ? 0 : 1,
    billDay,
    repayDay,
    body.hidden === true || body.hidden === 1 ? 1 : 0,
    at,
    at,
  );
  return created(accountOut(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id)));
});

on('PATCH', '/accounts/:id', (ctx) => {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(String(ctx.params.id));
  if (!row) fail(404, 'account_not_found', '账户不存在');
  getLedgerOrThrow(ctx.user.id, row.ledger_id);
  if (row.deleted_at) fail(404, 'account_not_found', '账户已删除');
  const body = ctx.body || {};
  const next = {
    name: body.name !== undefined ? String(body.name).trim() : row.name,
    type: body.type !== undefined ? String(body.type) : row.type,
    kind: body.kind !== undefined ? String(body.kind) : row.kind ?? (row.type === 'credit' ? 'liability' : 'asset'),
    balance_cents:
      body.balance_cents !== undefined
        ? asInt(body.balance_cents, row.balance_cents)
        : body.initial_cents !== undefined
          ? asInt(body.initial_cents, row.balance_cents)
          : row.balance_cents,
    credit_limit_cents:
      body.credit_limit_cents !== undefined
        ? Math.max(0, asInt(body.credit_limit_cents, row.credit_limit_cents))
        : Number(row.credit_limit_cents || 0),
    icon: body.icon !== undefined ? (body.icon == null ? null : String(body.icon).slice(0, 16)) : row.icon,
    sort: body.sort !== undefined ? asInt(body.sort, row.sort) : row.sort,
    include_in_net:
      body.include_in_net !== undefined
        ? body.include_in_net === false || body.include_in_net === 0
          ? 0
          : 1
        : row.include_in_net,
    bill_day: body.bill_day !== undefined ? normalizeDayOfMonth(body.bill_day, 'bill_day') : row.bill_day ?? null,
    repay_day: body.repay_day !== undefined ? normalizeDayOfMonth(body.repay_day, 'repay_day') : row.repay_day ?? null,
    hidden:
      body.hidden !== undefined
        ? body.hidden === true || body.hidden === 1 || body.hidden === '1'
          ? 1
          : 0
        : row.hidden
          ? 1
          : 0,
  };
  if (!isNonEmptyString(next.name, 40)) fail(400, 'invalid_name', '账户名需 1-40 个字符');
  if (!ACCOUNT_TYPES.has(next.type)) fail(400, 'invalid_type', ACCOUNT_TYPE_HINT);
  if (!ACCOUNT_KINDS.has(next.kind)) fail(400, 'invalid_kind', 'kind 必须是 asset / liability');
  // 额度 / 账单日 / 还款日只对信用卡类账户有意义（花呗、借呗、白条都归 credit），
  // 其它类型一律清零，避免出现「储蓄卡有还款日」这种脏数据。
  if (next.type !== 'credit') {
    next.credit_limit_cents = 0;
    next.bill_day = null;
    next.repay_day = null;
  }
  db.prepare(
    `UPDATE accounts SET name = ?, type = ?, kind = ?, balance_cents = ?, credit_limit_cents = ?, icon = ?, sort = ?,
       include_in_net = ?, bill_day = ?, repay_day = ?, hidden = ?, updated_at = ? WHERE id = ?`,
  ).run(
    next.name,
    next.type,
    next.kind,
    next.balance_cents,
    next.credit_limit_cents,
    next.icon,
    next.sort,
    next.include_in_net,
    next.bill_day,
    next.repay_day,
    next.hidden,
    nowIso(),
    row.id,
  );
  return ok(accountOut(db.prepare('SELECT * FROM accounts WHERE id = ?').get(row.id)));
});

on('DELETE', '/accounts/:id', (ctx) => {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(String(ctx.params.id));
  if (!row) fail(404, 'account_not_found', '账户不存在');
  getLedgerOrThrow(ctx.user.id, row.ledger_id);
  const at = nowIso();
  db.prepare('UPDATE accounts SET deleted_at = ?, updated_at = ? WHERE id = ?').run(at, at, row.id);
  return ok({ ok: true, id: row.id });
});

/* ------------------------------ 账户余额调整 ------------------------------ */

// 余额校准：直接把 balance_cents 设成目标值，并留下一条 type='adjust' 的审计流水。
// adjust 不计收支、不计笔数，也不走 applyTxEffect（余额由本接口自己写）。
on('POST', '/accounts/:id/adjust', (ctx) => {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(String(ctx.params.id));
  if (!row) fail(404, 'account_not_found', '账户不存在');
  getLedgerOrThrow(ctx.user.id, row.ledger_id);
  if (row.deleted_at) fail(404, 'account_not_found', '账户已删除');

  const body = ctx.body || {};
  const targetRaw = body.target_cents ?? body.balance_cents;
  const target = Number(targetRaw);
  if (!Number.isFinite(target) || !Number.isInteger(target)) {
    fail(400, 'invalid_amount', 'target_cents 必须是整数（单位：分），可为负');
  }

  const before = Number(row.balance_cents || 0);
  const delta = target - before;
  const date = String(body.date ?? todayLocal()).slice(0, 10);
  if (!DATE_RE.test(date)) fail(400, 'invalid_happened_at', 'date 需为 ISO-8601 日期，如 2026-11-04');
  const note = body.note == null ? '余额调整' : String(body.note).slice(0, 1000);
  const txId = body.id ? String(body.id) : newId();
  const at = nowIso();

  tx(() => {
    db.prepare(
      `INSERT INTO transactions (id, ledger_id, type, amount_cents, category_id, account_id, to_account_id, note, happened_at,
         source, external_id, reimburse_state, reimburse_at, created_at, updated_at, deleted_at)
       VALUES (?,?,'adjust',?,NULL,?,NULL,?,?,'manual',NULL,NULL,NULL,?,?,NULL)
       ON CONFLICT(id) DO NOTHING`,
    ).run(txId, row.ledger_id, Math.abs(delta), row.id, note, date, at, at);
    db.prepare('UPDATE accounts SET balance_cents = ?, updated_at = ? WHERE id = ?').run(target, at, row.id);
  });

  const account = accountOut(db.prepare('SELECT * FROM accounts WHERE id = ?').get(row.id));
  return ok({ account, transaction: txWithNames(txId), delta_cents: delta });
});

/* ---------------------------------- 分类 ---------------------------------- */

const CAT_SELECT =
  'SELECT * FROM categories WHERE ledger_id = ? AND (deleted_at IS NULL) ORDER BY kind ASC, sort ASC, created_at ASC';

on('GET', '/categories', (ctx) => {
  const ledgerId = resolveLedgerId(ctx.user.id, qs(ctx, 'ledger_id'));
  const kind = qs(ctx, 'kind');
  if (kind && kind !== 'expense' && kind !== 'income') fail(400, 'invalid_kind', 'kind 必须是 expense / income');
  const items = db.prepare(CAT_SELECT).all(ledgerId).filter((r) => !kind || r.kind === kind);
  return ok({ items, total: items.length });
});

on('POST', '/categories', (ctx) => {
  const body = ctx.body || {};
  const ledgerId = resolveLedgerId(ctx.user.id, body.ledger_id);
  const name = String(body.name ?? '').trim();
  if (!isNonEmptyString(name, 24)) fail(400, 'invalid_name', '分类名需 1-24 个字符');
  const kind = String(body.kind ?? 'expense');
  if (kind !== 'expense' && kind !== 'income') fail(400, 'invalid_kind', 'kind 必须是 expense / income');
  const id = body.id ? String(body.id) : newId();
  const at = nowIso();
  db.prepare(
    'INSERT INTO categories (id, ledger_id, name, kind, icon, sort, parent_id, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,NULL)',
  ).run(
    id,
    ledgerId,
    name,
    kind,
    body.icon == null ? null : String(body.icon).slice(0, 16),
    asInt(body.sort, 0),
    body.parent_id == null ? null : String(body.parent_id),
    at,
    at,
  );
  return created(db.prepare('SELECT * FROM categories WHERE id = ?').get(id));
});

on('PATCH', '/categories/:id', (ctx) => {
  const row = db.prepare('SELECT * FROM categories WHERE id = ?').get(String(ctx.params.id));
  if (!row) fail(404, 'category_not_found', '分类不存在');
  getLedgerOrThrow(ctx.user.id, row.ledger_id);
  if (row.deleted_at) fail(404, 'category_not_found', '分类已删除');
  const body = ctx.body || {};
  const next = {
    name: body.name !== undefined ? String(body.name).trim() : row.name,
    kind: body.kind !== undefined ? String(body.kind) : row.kind,
    icon: body.icon !== undefined ? (body.icon == null ? null : String(body.icon).slice(0, 16)) : row.icon,
    sort: body.sort !== undefined ? asInt(body.sort, row.sort) : row.sort,
    parent_id: body.parent_id !== undefined ? (body.parent_id == null ? null : String(body.parent_id)) : row.parent_id,
  };
  if (!isNonEmptyString(next.name, 24)) fail(400, 'invalid_name', '分类名需 1-24 个字符');
  if (next.kind !== 'expense' && next.kind !== 'income') fail(400, 'invalid_kind', 'kind 必须是 expense / income');
  db.prepare('UPDATE categories SET name = ?, kind = ?, icon = ?, sort = ?, parent_id = ?, updated_at = ? WHERE id = ?').run(
    next.name,
    next.kind,
    next.icon,
    next.sort,
    next.parent_id,
    nowIso(),
    row.id,
  );
  return ok(db.prepare('SELECT * FROM categories WHERE id = ?').get(row.id));
});

on('DELETE', '/categories/:id', (ctx) => {
  const row = db.prepare('SELECT * FROM categories WHERE id = ?').get(String(ctx.params.id));
  if (!row) fail(404, 'category_not_found', '分类不存在');
  getLedgerOrThrow(ctx.user.id, row.ledger_id);
  const at = nowIso();
  db.prepare('UPDATE categories SET deleted_at = ?, updated_at = ? WHERE id = ?').run(at, at, row.id);
  return ok({ ok: true, id: row.id });
});

/* ---------------------------------- 交易 ---------------------------------- */

on('GET', '/transactions', (ctx) => {
  const ledgerId = resolveLedgerId(ctx.user.id, qs(ctx, 'ledger_id'));
  const { whereSql, args } = txFilter(ctx, ledgerId);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM transactions t WHERE ${whereSql}`).get(...args).n;
  const limit = clampInt(qs(ctx, 'limit'), 1, 1000, 200);
  const offset = clampInt(qs(ctx, 'offset'), 0, 1_000_000, 0);
  const rows = db
    .prepare(`${TX_SELECT} WHERE ${whereSql} ORDER BY t.happened_at DESC, t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset);
  return ok({ items: withTagsBatch(rows), total });
});

function normalizeReimburse(value, fallback = null) {
  if (value === undefined) return fallback ?? null;
  if (value === null || value === '') return null;
  const state = String(value);
  if (!REIMBURSE_STATES.has(state)) fail(400, 'invalid_reimburse_state', 'reimburse_state 必须是 pending / done / null');
  return state;
}

on('POST', '/transactions', (ctx) => {
  const body = ctx.body || {};
  const ledgerId = resolveLedgerId(ctx.user.id, body.ledger_id);
  // `id` 与 `client_id` 都可作为客户端幂等键（契约里两种写法都出现过）
  const clientKey = body.id ?? body.client_id;
  const id = clientKey ? String(clientKey) : newId();
  const data = normalizeTx(body, null, ledgerId);
  const reimburseState = normalizeReimburse(body.reimburse_state, null);

  const existing = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  if (existing) {
    if (existing.ledger_id !== ledgerId) fail(403, 'forbidden', '该交易 id 属于其他账本');
  }

  // 导入幂等：external_id 命中即视为已导入，直接返回已有记录
  if (data.external_id) {
    const dup = db
      .prepare('SELECT * FROM transactions WHERE ledger_id = ? AND external_id = ?')
      .get(ledgerId, data.external_id);
    if (dup && dup.id !== id) {
      return ok({ item: txWithNames(dup.id), deduped: true, created: false });
    }
  }

  const at = nowIso();
  const reimburseAt = reimburseState === 'done' ? existing?.reimburse_at || data.happened_at : null;
  tx(() => {
    if (existing) applyTxEffect(existing, -1);
    db.prepare(
      `INSERT INTO transactions (id, ledger_id, type, amount_cents, category_id, account_id, to_account_id, note, happened_at,
         source, external_id, reimburse_state, reimburse_at, member_id, created_at, updated_at, deleted_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
       ON CONFLICT(id) DO UPDATE SET
         type = excluded.type,
         amount_cents = excluded.amount_cents,
         category_id = excluded.category_id,
         account_id = excluded.account_id,
         to_account_id = excluded.to_account_id,
         note = excluded.note,
         happened_at = excluded.happened_at,
         source = excluded.source,
         external_id = excluded.external_id,
         reimburse_state = excluded.reimburse_state,
         reimburse_at = excluded.reimburse_at,
         member_id = excluded.member_id,
         deleted_at = NULL,
         updated_at = excluded.updated_at`,
    ).run(
      id,
      ledgerId,
      data.type,
      data.amount_cents,
      data.category_id,
      data.account_id,
      data.to_account_id,
      data.note,
      data.happened_at,
      data.source,
      data.external_id,
      reimburseState,
      reimburseAt,
      data.member_id,
      existing ? existing.created_at : at,
      at,
    );
    const saved = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    applyTxEffect(saved, 1);
    if (body.tags !== undefined) replaceTxTags(id, ledgerId, body.tags);
  });

  return existing ? ok({ item: txWithNames(id), created: false }) : created({ item: txWithNames(id), created: true });
});

on('PATCH', '/transactions/:id', (ctx) => {
  const row = loadTx(ctx.user.id, ctx.params.id);
  if (row.deleted_at) fail(404, 'transaction_not_found', '交易已删除');
  const body = ctx.body || {};
  const merged = normalizeTx(body, row, row.ledger_id);
  const reimburseState = normalizeReimburse(body.reimburse_state, row.reimburse_state ?? null);
  const reimburseAt =
    reimburseState === 'done'
      ? body.reimburse_at != null
        ? String(body.reimburse_at).slice(0, 10)
        : row.reimburse_at || merged.happened_at
      : null;
  const at = nowIso();
  tx(() => {
    applyTxEffect(row, -1);
    db.prepare(
      `UPDATE transactions SET type = ?, amount_cents = ?, category_id = ?, account_id = ?, to_account_id = ?,
         note = ?, happened_at = ?, source = ?, external_id = ?, reimburse_state = ?, reimburse_at = ?, member_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      merged.type,
      merged.amount_cents,
      merged.category_id,
      merged.account_id,
      merged.to_account_id,
      merged.note,
      merged.happened_at,
      merged.source,
      merged.external_id,
      reimburseState,
      reimburseAt,
      merged.member_id,
      at,
      row.id,
    );
    applyTxEffect(db.prepare('SELECT * FROM transactions WHERE id = ?').get(row.id), 1);
    if (body.tags !== undefined) replaceTxTags(row.id, row.ledger_id, body.tags);
  });
  return ok({ item: txWithNames(row.id) });
});

on('DELETE', '/transactions/:id', (ctx) => {
  const row = loadTx(ctx.user.id, ctx.params.id);
  if (row.deleted_at) return ok({ ok: true, id: row.id, already: true });
  const at = nowIso();
  tx(() => {
    applyTxEffect(row, -1);
    db.prepare('UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE id = ?').run(at, at, row.id);
  });
  return ok({ ok: true, id: row.id });
});

/* ---------------------------------- 报销 ---------------------------------- */

on('POST', '/transactions/:id/reimburse', (ctx) => {
  const row = loadTx(ctx.user.id, ctx.params.id);
  if (row.deleted_at) fail(404, 'transaction_not_found', '交易已删除');
  if (row.type !== 'expense') fail(400, 'invalid_type', '只有支出可以报销');
  if (row.reimburse_state === 'done') fail(409, 'already_reimbursed', '该交易已报销');

  const body = ctx.body || {};
  const accountId = body.account_id ? String(body.account_id) : row.account_id;
  if (!accountId) fail(400, 'invalid_account', '报销需要 account_id（ reimbursement 收款账户）');
  accountInLedger(row.ledger_id, accountId);

  const date = String(body.date ?? todayLocal()).slice(0, 10);
  if (!DATE_RE.test(date)) fail(400, 'invalid_happened_at', 'date 需为 ISO-8601 日期，如 2026-11-04');
  const amount = body.amount_cents === undefined ? row.amount_cents : Number(body.amount_cents);
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
    fail(400, 'invalid_amount', 'amount_cents 必须是大于 0 的整数（单位：分）');
  }

  // 幂等键固定：一笔支出最多只能生成一条报销收入
  const externalId = `reimb:${row.id}`;
  const at = nowIso();
  let income = db
    .prepare('SELECT id FROM transactions WHERE ledger_id = ? AND external_id = ?')
    .get(row.ledger_id, externalId);

  tx(() => {
    if (!income) {
      const incomeId = stableId('reimb', row.ledger_id, row.id);
      db.prepare(
        `INSERT INTO transactions (id, ledger_id, type, amount_cents, category_id, account_id, to_account_id, note, happened_at,
           source, external_id, reimburse_state, reimburse_at, member_id, created_at, updated_at, deleted_at)
         VALUES (?,?,'income',?,NULL,?,NULL,?,?,'manual',?,NULL,NULL,?,?,?,NULL)
         ON CONFLICT(id) DO NOTHING`,
      ).run(incomeId, row.ledger_id, amount, accountId, '报销：' + (row.note || ''), date, externalId, row.member_id ?? null, at, at);
      const saved = db.prepare('SELECT * FROM transactions WHERE id = ?').get(incomeId);
      if (saved) applyTxEffect(saved, 1);
      income = { id: incomeId };
    }
    db.prepare('UPDATE transactions SET reimburse_state = ?, reimburse_at = ?, updated_at = ? WHERE id = ?').run(
      'done',
      date,
      at,
      row.id,
    );
  });

  return ok({ transaction: txWithNames(row.id), income: txWithNames(income.id) });
});

/* ---------------------------------- 标签 ---------------------------------- */

on('GET', '/tags', (ctx) => {
  const ledgerId = resolveLedgerId(ctx.user.id, qs(ctx, 'ledger_id'));
  return ok(tagList(ledgerId));
});

on('POST', '/tags', (ctx) => {
  const body = ctx.body || {};
  const ledgerId = resolveLedgerId(ctx.user.id, body.ledger_id);
  const name = String(body.name ?? '').trim();
  if (!isNonEmptyString(name, 24)) fail(400, 'invalid_name', '标签名需 1-24 个字符');
  const dup = db
    .prepare('SELECT id FROM tags WHERE ledger_id = ? AND name = ? AND deleted_at IS NULL')
    .get(ledgerId, name);
  if (dup) fail(409, 'tag_exists', '标签名已存在');
  const id = body.id ? String(body.id) : newId();
  const at = nowIso();
  db.prepare('INSERT INTO tags (id, ledger_id, name, color, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,NULL)').run(
    id,
    ledgerId,
    name,
    body.color == null ? null : String(body.color).slice(0, 24),
    at,
    at,
  );
  return created(tagOut(db.prepare('SELECT * FROM tags WHERE id = ?').get(id), 0));
});

on('PATCH', '/tags/:id', (ctx) => {
  const row = db.prepare('SELECT * FROM tags WHERE id = ?').get(String(ctx.params.id));
  if (!row) fail(404, 'tag_not_found', '标签不存在');
  getLedgerOrThrow(ctx.user.id, row.ledger_id);
  if (row.deleted_at) fail(404, 'tag_not_found', '标签已删除');
  const body = ctx.body || {};
  const name = body.name !== undefined ? String(body.name).trim() : row.name;
  if (!isNonEmptyString(name, 24)) fail(400, 'invalid_name', '标签名需 1-24 个字符');
  if (name !== row.name) {
    const dup = db
      .prepare('SELECT id FROM tags WHERE ledger_id = ? AND name = ? AND deleted_at IS NULL AND id <> ?')
      .get(row.ledger_id, name, row.id);
    if (dup) fail(409, 'tag_exists', '标签名已存在');
  }
  db.prepare('UPDATE tags SET name = ?, color = ?, updated_at = ? WHERE id = ?').run(
    name,
    body.color !== undefined ? (body.color == null ? null : String(body.color).slice(0, 24)) : row.color,
    nowIso(),
    row.id,
  );
  return ok(tagOut(db.prepare('SELECT * FROM tags WHERE id = ?').get(row.id)));
});

on('DELETE', '/tags/:id', (ctx) => {
  const row = db.prepare('SELECT * FROM tags WHERE id = ?').get(String(ctx.params.id));
  if (!row) fail(404, 'tag_not_found', '标签不存在');
  getLedgerOrThrow(ctx.user.id, row.ledger_id);
  const at = nowIso();
  tx(() => {
    db.prepare('DELETE FROM transaction_tags WHERE tag_id = ?').run(row.id);
    db.prepare('UPDATE tags SET deleted_at = ?, updated_at = ? WHERE id = ?').run(at, at, row.id);
  });
  return ok({ ok: true, id: row.id });
});

/* ---------------------------------- 统计 ---------------------------------- */

function balanceOf(ledgerId) {
  return db
    .prepare('SELECT COALESCE(SUM(balance_cents), 0) AS s FROM accounts WHERE ledger_id = ? AND deleted_at IS NULL')
    .get(ledgerId).s;
}

on('GET', '/stats/summary', (ctx) => {
  const ledgerId = resolveLedgerId(ctx.user.id, qs(ctx, 'ledger_id'));
  const { whereSql, args, from, to } = txFilter(ctx, ledgerId);
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount_cents END), 0) AS income_cents,
         COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount_cents END), 0) AS expense_cents,
         COALESCE(SUM(CASE WHEN t.type = 'transfer' THEN t.amount_cents END), 0) AS transfer_cents,
         COALESCE(SUM(CASE WHEN t.type = 'adjust' THEN t.amount_cents END), 0) AS adjust_cents,
         SUM(CASE WHEN t.type = 'adjust' THEN 0 ELSE 1 END) AS count
       FROM transactions t
       WHERE ${whereSql}`,
    )
    .get(...args);
  return ok({
    income_cents: row.income_cents,
    expense_cents: row.expense_cents,
    net_cents: row.income_cents - row.expense_cents,
    transfer_cents: row.transfer_cents,
    adjust_cents: row.adjust_cents,
    balance_cents: balanceOf(ledgerId),
    // adjust（余额校准）不算记账笔数
    count: row.count ?? 0,
    from,
    to,
  });
});

on('GET', '/stats/by-category', (ctx) => {
  const ledgerId = resolveLedgerId(ctx.user.id, qs(ctx, 'ledger_id'));
  const kind = qs(ctx, 'kind') || 'expense';
  if (kind !== 'expense' && kind !== 'income') fail(400, 'invalid_kind', 'kind 必须是 expense / income');
  const { whereSql, args } = txFilter(ctx, ledgerId);
  const rows = db
    .prepare(
      `SELECT t.category_id AS category_id,
              COALESCE(c.name, '未分类') AS name,
              COALESCE(c.icon, '❓') AS icon,
              SUM(t.amount_cents) AS amount_cents,
              COUNT(*) AS count
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE ${whereSql} AND t.type = ?
        GROUP BY t.category_id
        ORDER BY amount_cents DESC`,
    )
    .all(...args, kind);
  const total = rows.reduce((s, r) => s + r.amount_cents, 0);
  const items = rows.map((r) => ({
    category_id: r.category_id,
    name: r.name,
    icon: r.icon,
    amount_cents: r.amount_cents,
    count: r.count,
    ratio: total > 0 ? Math.round((r.amount_cents / total) * 10000) / 10000 : 0,
  }));
  return ok(items);
});

/** 一周的起点（周一），用于 granularity=week 分桶 */
function weekStart(dateStr) {
  const raw = String(dateStr || '').slice(0, 10);
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return raw;
  const dow = (d.getUTCDay() + 6) % 7; // 周一 = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

function bucketList(from, to, granularity) {
  const out = [];
  if (granularity === 'month') {
    let y = Number(from.slice(0, 4));
    let m = Number(from.slice(5, 7));
    const endY = Number(to.slice(0, 4));
    const endM = Number(to.slice(5, 7));
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(endY) || !Number.isFinite(endM)) return out;
    while ((y < endY || (y === endY && m <= endM)) && out.length < 600) {
      out.push(`${y}-${pad2(m)}`);
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    return out;
  }
  const end = new Date(`${to.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) return out;
  const isWeek = granularity === 'week';
  const cursor = new Date(`${(isWeek ? weekStart(from) : from.slice(0, 10))}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime())) return out;
  while (cursor <= end && out.length < 1000) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + (isWeek ? 7 : 1));
  }
  return out;
}

on('GET', '/stats/trend', (ctx) => {
  const ledgerId = resolveLedgerId(ctx.user.id, qs(ctx, 'ledger_id'));
  const g = qs(ctx, 'granularity');
  const granularity = g === 'month' ? 'month' : g === 'week' ? 'week' : 'day';
  const fromRaw = qs(ctx, 'from');
  const toRaw = qs(ctx, 'to');
  const { whereSql, args, from, to } = txFilter(ctx, ledgerId);
  const bucketExpr = granularity === 'month' ? 'substr(t.happened_at, 1, 7)' : 'substr(t.happened_at, 1, 10)';
  const rows = db
    .prepare(
      `SELECT ${bucketExpr} AS bucket,
              COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount_cents END), 0) AS income_cents,
              COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount_cents END), 0) AS expense_cents
         FROM transactions t
        WHERE ${whereSql}
        GROUP BY bucket
        ORDER BY bucket ASC`,
    )
    .all(...args);

  if (!rows.length && !fromRaw && !toRaw) return ok([]);

  let series = rows;
  if (granularity === 'week') {
    // 先按天聚合，再在 JS 里滚成「周一」为桶的周
    const acc = new Map();
    for (const r of rows) {
      const w = weekStart(r.bucket);
      const hit = acc.get(w) ?? { bucket: w, income_cents: 0, expense_cents: 0 };
      hit.income_cents += r.income_cents;
      hit.expense_cents += r.expense_cents;
      acc.set(w, hit);
    }
    series = [...acc.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
  }

  const map = new Map(series.map((r) => [r.bucket, r]));
  const buckets = fromRaw && toRaw ? bucketList(from, to, granularity) : series.map((r) => r.bucket);
  const items = buckets.map((b) => ({
    bucket: b,
    income_cents: map.get(b)?.income_cents ?? 0,
    expense_cents: map.get(b)?.expense_cents ?? 0,
  }));
  return ok(items);
});

/* ------------------------------- 扩展统计接口 ------------------------------- */

/** 区间收支汇总（compare 用；transfer 计入 count 但不计入收支） */
function rangeSummary(ledgerId, from, to) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount_cents END), 0) AS income_cents,
              COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_cents END), 0) AS expense_cents,
              COUNT(*) AS count
         FROM transactions
        WHERE ledger_id = ? AND deleted_at IS NULL AND type <> 'adjust'
          AND substr(happened_at, 1, 10) BETWEEN ? AND ?`,
    )
    .get(ledgerId, from, to);
  return {
    income_cents: row.income_cents,
    expense_cents: row.expense_cents,
    net_cents: row.income_cents - row.expense_cents,
    count: row.count,
  };
}

const pct = (cur, prev) => (prev ? Math.round(((cur - prev) / prev) * 10000) / 10000 : null);

on('GET', '/stats/overview', (ctx) => {
  const ledgerId = resolveLedgerId(ctx.user.id, qs(ctx, 'ledger_id'));
  const { whereSql, args, from, to } = txFilter(ctx, ledgerId);
  const head = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount_cents END), 0) AS income_cents,
              COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount_cents END), 0) AS expense_cents,
              SUM(CASE WHEN t.type = 'expense' THEN 1 ELSE 0 END) AS expense_count,
              SUM(CASE WHEN t.type = 'income' THEN 1 ELSE 0 END) AS income_count,
              SUM(CASE WHEN t.type = 'transfer' THEN 1 ELSE 0 END) AS transfer_count,
              SUM(CASE WHEN t.type = 'adjust' THEN 1 ELSE 0 END) AS adjust_count,
              COUNT(*) AS count
         FROM transactions t WHERE ${whereSql}`,
    )
    .get(...args);
  const exp = db
    .prepare(
      `SELECT COUNT(DISTINCT substr(t.happened_at, 1, 10)) AS days,
              COALESCE(MAX(t.amount_cents), 0) AS max_cents
         FROM transactions t WHERE ${whereSql} AND t.type = 'expense'`,
    )
    .get(...args);
  const maxRow = db
    .prepare(
      `SELECT t.note AS note FROM transactions t WHERE ${whereSql} AND t.type = 'expense'
        ORDER BY t.amount_cents DESC, t.happened_at DESC LIMIT 1`,
    )
    .get(...args);
  const weekdayRows = db
    .prepare(
      `SELECT ((CAST(strftime('%w', substr(t.happened_at, 1, 10)) AS INTEGER) + 6) % 7) + 1 AS weekday,
              SUM(t.amount_cents) AS expense_cents,
              COUNT(*) AS count
         FROM transactions t WHERE ${whereSql} AND t.type = 'expense'
        GROUP BY weekday`,
    )
    .all(...args);
  const byWeekday = [];
  for (let i = 1; i <= 7; i += 1) {
    const hit = weekdayRows.find((r) => r.weekday === i);
    byWeekday.push({ weekday: i, expense_cents: hit?.expense_cents ?? 0, count: hit?.count ?? 0 });
  }
  const days = exp?.days ?? 0;
  // v1.2：成员维度前 3 名（按支出）
  const memberRows = db
    .prepare(
      `SELECT COALESCE(m.name, '我') AS name, SUM(t.amount_cents) AS expense_cents
         FROM transactions t
         LEFT JOIN members m ON m.id = t.member_id AND m.deleted_at IS NULL
        WHERE ${whereSql} AND t.type = 'expense'
        GROUP BY COALESCE(m.name, '我')
        ORDER BY expense_cents DESC
        LIMIT 3`,
    )
    .all(...args);
  return ok({
    income_cents: head.income_cents,
    expense_cents: head.expense_cents,
    net_cents: head.income_cents - head.expense_cents,
    count: head.count,
    days,
    avg_expense_cents: days ? Math.round(head.expense_cents / days) : 0,
    max_expense_cents: exp?.max_cents ?? 0,
    max_expense_note: maxRow?.note ?? null,
    by_weekday: byWeekday,
    // 各类型笔数
    by_type: {
      expense: head.expense_count ?? 0,
      income: head.income_count ?? 0,
      transfer: head.transfer_count ?? 0,
      adjust: head.adjust_count ?? 0,
    },
    by_member_top: memberRows.map((r) => ({ name: r.name, expense_cents: r.expense_cents })),
    from,
    to,
  });
});

/* 成员维度：支出/收入合计（「我」= member_id 为空的历史数据） */
on('GET', '/stats/by-member', (ctx) => {
  const ledgerId = resolveLedgerId(ctx.user.id, qs(ctx, 'ledger_id'));
  const { whereSql, args } = txFilter(ctx, ledgerId);
  const members = db.prepare(MEMBER_SELECT).all(ledgerId).map(memberOut);
  const rows = db
    .prepare(
      `SELECT t.member_id AS member_id,
              COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount_cents END), 0) AS expense_cents,
              COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount_cents END), 0) AS income_cents,
              COUNT(*) AS count
         FROM transactions t
        WHERE ${whereSql}
        GROUP BY t.member_id`,
    )
    .all(...args);
  const byId = new Map(rows.map((r) => [r.member_id ?? null, r]));
  const selfMember = members.find((m) => m.is_self) ?? null;
  const out = [];
  for (const m of members) {
    const hit = byId.get(m.id);
    out.push({
      member_id: m.id,
      member_name: m.name,
      color: m.color,
      expense_cents: hit?.expense_cents ?? 0,
      income_cents: hit?.income_cents ?? 0,
      count: hit?.count ?? 0,
    });
    byId.delete(m.id);
  }
  // 没挂成员（= 「我」语义）或成员已删的历史交易，合并进「我」这一行
  let orphanExpense = 0;
  let orphanIncome = 0;
  let orphanCount = 0;
  for (const hit of byId.values()) {
    orphanExpense += hit.expense_cents;
    orphanIncome += hit.income_cents;
    orphanCount += hit.count;
  }
  if (orphanCount > 0) {
    if (selfMember) {
      const line = out.find((r) => r.member_id === selfMember.id);
      if (line) {
        line.expense_cents += orphanExpense;
        line.income_cents += orphanIncome;
        line.count += orphanCount;
      }
    } else {
      out.push({
        member_id: null,
        member_name: '我',
        color: null,
        expense_cents: orphanExpense,
        income_cents: orphanIncome,
        count: orphanCount,
      });
    }
  }
  return ok(out);
});

/* 近 N 个月收支：按月份升序、缺月补 0 */
on('GET', '/stats/monthly', (ctx) => {
  const ledgerId = resolveLedgerId(ctx.user.id, qs(ctx, 'ledger_id'));
  const months = clampInt(qs(ctx, 'months'), 1, 60, 12);
  const { whereSql, args } = txFilter(ctx, ledgerId);
  const map = new Map(
    db
      .prepare(
        `SELECT substr(t.happened_at, 1, 7) AS month,
                COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount_cents END), 0) AS expense_cents,
                COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount_cents END), 0) AS income_cents,
                COUNT(*) AS count
           FROM transactions t
          WHERE ${whereSql}
          GROUP BY month`,
      )
      .all(...args)
      .map((r) => [r.month, r]),
  );
  const end = qs(ctx, 'to') ? String(qs(ctx, 'to')).slice(0, 7) : currentMonth();
  const list = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const month = monthShift(end, -i);
    const hit = map.get(month);
    list.push({
      month,
      expense_cents: hit?.expense_cents ?? 0,
      income_cents: hit?.income_cents ?? 0,
      count: hit?.count ?? 0,
    });
  }
  return ok(list);
});

on('GET', '/stats/by-account', (ctx) => {
  const ledgerId = resolveLedgerId(ctx.user.id, qs(ctx, 'ledger_id'));
  const kind = qs(ctx, 'kind') === 'income' ? 'income' : 'expense';
  const { whereSql, args } = txFilter(ctx, ledgerId);
  const rows = db
    .prepare(
      `SELECT t.account_id AS account_id, a.name AS name, a.icon AS icon, a.type AS type,
              SUM(t.amount_cents) AS amount_cents, COUNT(*) AS count
         FROM transactions t
         LEFT JOIN accounts a ON a.id = t.account_id
        WHERE ${whereSql} AND t.type = ? AND t.account_id IS NOT NULL
        GROUP BY t.account_id
        ORDER BY amount_cents DESC`,
    )
    .all(...args, kind);
  const total = rows.reduce((s, r) => s + r.amount_cents, 0);
  return ok(
    rows.map((r) => ({
      account_id: r.account_id,
      name: r.name ?? '未知账户',
      icon: r.icon ?? '❔',
      type: r.type ?? 'other',
      amount_cents: r.amount_cents,
      count: r.count,
      ratio: total > 0 ? Math.round((r.amount_cents / total) * 10000) / 10000 : 0,
    })),
  );
});

on('GET', '/stats/by-tag', (ctx) => {
  const ledgerId = resolveLedgerId(ctx.user.id, qs(ctx, 'ledger_id'));
  const { whereSql, args } = txFilter(ctx, ledgerId);
  // 一笔交易挂多个标签时只归到最早的那个，避免金额被重复累计
  const rows = db
    .prepare(
      `SELECT tg.tag_id AS tag_id, tg.name AS name, tg.color AS color,
              SUM(t.amount_cents) AS amount_cents, COUNT(*) AS count
         FROM transactions t
         LEFT JOIN (
           SELECT tt.transaction_id AS tid, g.id AS tag_id, g.name AS name, g.color AS color,
                  ROW_NUMBER() OVER (PARTITION BY tt.transaction_id ORDER BY g.created_at, g.id) AS rn
             FROM transaction_tags tt
             JOIN tags g ON g.id = tt.tag_id AND g.deleted_at IS NULL
         ) tg ON tg.tid = t.id AND tg.rn = 1
        WHERE ${whereSql} AND t.type = 'expense'
        GROUP BY tg.tag_id
        ORDER BY amount_cents DESC`,
    )
    .all(...args);
  const total = rows.reduce((s, r) => s + r.amount_cents, 0);
  return ok(
    rows.map((r) => ({
      tag_id: r.tag_id ?? null,
      name: r.name ?? '未打标签',
      color: r.color ?? null,
      amount_cents: r.amount_cents,
      count: r.count,
      ratio: total > 0 ? Math.round((r.amount_cents / total) * 10000) / 10000 : 0,
    })),
  );
});

on('GET', '/stats/compare', (ctx) => {
  const ledgerId = resolveLedgerId(ctx.user.id, qs(ctx, 'ledger_id'));
  const [year, mon] = currentMonth().split('-').map(Number);
  const thisStart = `${currentMonth()}-01`;
  const thisEnd = `${currentMonth()}-${pad2(new Date(year, mon, 0).getDate())}`;
  const from = (qs(ctx, 'from') || thisStart).slice(0, 10);
  const to = (qs(ctx, 'to') || thisEnd).slice(0, 10);
  const startMs = Date.parse(`${from}T00:00:00Z`);
  const endMs = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
    fail(400, 'invalid_range', 'from / to 需为合法日期且 from <= to');
  }
  const spanDays = Math.round((endMs - startMs) / 86400000) + 1;
  const prevEnd = new Date(startMs - 86400000).toISOString().slice(0, 10);
  const prevStart = new Date(startMs - spanDays * 86400000).toISOString().slice(0, 10);

  const current = rangeSummary(ledgerId, from, to);
  const previous = rangeSummary(ledgerId, prevStart, prevEnd);
  return ok({
    current: { ...current, from, to },
    previous: { ...previous, from: prevStart, to: prevEnd },
    delta: {
      income_pct: pct(current.income_cents, previous.income_cents),
      expense_pct: pct(current.expense_cents, previous.expense_cents),
      net_cents: current.net_cents - previous.net_cents,
    },
  });
});

on('GET', '/stats/calendar', (ctx) => {
  const ledgerId = resolveLedgerId(ctx.user.id, qs(ctx, 'ledger_id'));
  const month = qs(ctx, 'month') || currentMonth();
  if (!MONTH_RE.test(month)) fail(400, 'invalid_month', 'month 需为 YYYY-MM');
  const rows = db
    .prepare(
      `SELECT substr(happened_at, 1, 10) AS date,
              COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_cents END), 0) AS expense_cents,
              COALESCE(SUM(CASE WHEN type = 'income' THEN amount_cents END), 0) AS income_cents,
              COUNT(*) AS count
         FROM transactions
        WHERE ledger_id = ? AND deleted_at IS NULL AND substr(happened_at, 1, 10) LIKE ?
        GROUP BY date
        ORDER BY date ASC`,
    )
    .all(ledgerId, `${month}-%`);
  return ok(rows.map((r) => ({ date: r.date, expense_cents: r.expense_cents, income_cents: r.income_cents, count: r.count })));
});

on('GET', '/stats/reimburse', (ctx) => {
  const ledgerId = resolveLedgerId(ctx.user.id, qs(ctx, 'ledger_id'));
  const { whereSql, args } = txFilter(ctx, ledgerId);
  const agg = (state) =>
    db
      .prepare(
        `SELECT COALESCE(SUM(t.amount_cents), 0) AS cents, COUNT(*) AS n
           FROM transactions t WHERE ${whereSql} AND t.reimburse_state = ?`,
      )
      .get(...args, state);
  const pending = agg('pending');
  const done = agg('done');
  const items = db
    .prepare(
      `${TX_SELECT} WHERE ${whereSql} AND t.reimburse_state IS NOT NULL
        ORDER BY t.happened_at DESC, t.created_at DESC LIMIT 500`,
    )
    .all(...args);
  return ok({
    pending_cents: pending.cents,
    pending_count: pending.n,
    done_cents: done.cents,
    done_count: done.n,
    items: withTagsBatch(items),
  });
});

/* ---------------------------------- 预算 ---------------------------------- */

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

function monthShift(month, delta) {
  const [y, m] = String(month).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/** 某月某分类（categoryId 为 null 表示总预算）的已用金额 */
function monthSpent(ledgerId, month, categoryId) {
  const sql = categoryId
    ? `SELECT COALESCE(SUM(amount_cents), 0) AS s FROM transactions
        WHERE ledger_id = ? AND type = 'expense' AND deleted_at IS NULL
          AND category_id = ? AND substr(happened_at, 1, 7) = ?`
    : `SELECT COALESCE(SUM(amount_cents), 0) AS s FROM transactions
        WHERE ledger_id = ? AND type = 'expense' AND deleted_at IS NULL
          AND substr(happened_at, 1, 7) = ?`;
  const args = categoryId ? [ledgerId, categoryId, month] : [ledgerId, month];
  return db.prepare(sql).get(...args).s;
}

/**
 * 结转链（CONTRACT §2.3）：carry(m) = rollover ? (amount(m-1) + carry(m-1) - spent(m-1)) : 0
 * 从该预算项最早月份递推，最多回溯 36 个月，允许负数。
 */
function budgetCarry(ledgerId, month, categoryId, rollover) {
  if (!rollover) return 0;
  const startRow = categoryId
    ? db
        .prepare('SELECT MIN(month) AS m FROM budgets WHERE ledger_id = ? AND category_id = ? AND month <= ?')
        .get(ledgerId, categoryId, month)
    : db
        .prepare('SELECT MIN(month) AS m FROM budgets WHERE ledger_id = ? AND category_id IS NULL AND month <= ?')
        .get(ledgerId, month);
  let first = startRow?.m;
  if (!first || first >= month) return 0;
  const floor = monthShift(month, -36);
  if (first < floor) first = floor;
  const rowStmt = categoryId
    ? db.prepare('SELECT amount_cents, rollover FROM budgets WHERE ledger_id = ? AND month = ? AND category_id = ?')
    : db.prepare('SELECT amount_cents, rollover FROM budgets WHERE ledger_id = ? AND month = ? AND category_id IS NULL');
  // carry(首月) = 0；逐月推 carry(m) = R(m) ? (A(m-1) + carry(m-1) - spent(m-1)) : 0
  let carry = 0;
  let m = monthShift(first, 1);
  let guard = 0;
  while (m <= month && guard < 40) {
    const row = categoryId ? rowStmt.get(ledgerId, m, categoryId) : rowStmt.get(ledgerId, m);
    const prevMonth = monthShift(m, -1);
    const prev = categoryId ? rowStmt.get(ledgerId, prevMonth, categoryId) : rowStmt.get(ledgerId, prevMonth);
    // 该月没设 rollover（或压根没预算）→ 结转链在此归零
    carry = row?.rollover ? (prev?.amount_cents ?? 0) + carry - monthSpent(ledgerId, prevMonth, categoryId) : 0;
    m = monthShift(m, 1);
    guard += 1;
  }
  return carry;
}

/* 预算百分比/预警（CONTRACT v1.3 §2.3）：可用额度 <= 0 时百分比记 0，但超支状态仍按余额负值判断 */
const round1 = (x) => Math.round(x * 10) / 10;

function percentLeft(available, remaining) {
  if (!(available > 0)) return 0;
  return round1((remaining / available) * 100);
}

function warnLevel(remaining, percent, warnPercent) {
  if (remaining < 0) return 'over';
  if (percent <= warnPercent) return 'warn';
  return 'ok';
}

/**
 * 预算预警口径（v1.3）：完全没设预算 → 'none' 且 percent_left 为 null，
 * 「没设预算」不等于「超支」，避免老库/新账本一进来就报红。
 */
function budgetHeadline(amountCents, categoriesSumCents, available, remaining, warnPercent) {
  if (amountCents <= 0 && categoriesSumCents <= 0) return { percent_left: null, warn_level: 'none' };
  const percent = percentLeft(available, remaining);
  return { percent_left: percent, warn_level: warnLevel(remaining, percent, warnPercent) };
}

/** 该月所有分类预算行（金额 > 0） */
function budgetCategoryRows(ledgerId, month) {
  return db
    .prepare('SELECT * FROM budgets WHERE ledger_id = ? AND month = ? AND category_id IS NOT NULL ORDER BY created_at ASC')
    .all(ledgerId, month);
}

const budgetCategoriesSum = (ledgerId, month) =>
  budgetCategoryRows(ledgerId, month).reduce((s, b) => s + b.amount_cents, 0);

const budgetOverallRow = (ledgerId, month) =>
  db.prepare('SELECT * FROM budgets WHERE ledger_id = ? AND month = ? AND category_id IS NULL').get(ledgerId, month);

/**
 * 最大余数法把各分类预算按比例缩放到 target（Σ 必须精确等于 target）。
 * 取整后为 0 的分类行直接删除（0 = 未设置，沿用 v1.1 语义）。
 */
function rebalanceCategoryBudgets(rows, target, at) {
  const sum = rows.reduce((s, r) => s + r.amount_cents, 0);
  if (sum <= 0) return;
  if (target <= 0) {
    for (const r of rows) db.prepare('DELETE FROM budgets WHERE id = ?').run(r.id);
    return;
  }
  const raw = rows.map((r) => (r.amount_cents * target) / sum);
  const out = raw.map((x) => Math.floor(x));
  const rest = target - out.reduce((s, x) => s + x, 0);
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < rest; k += 1) out[order[k % order.length].i] += 1;
  rows.forEach((r, i) => {
    if (out[i] <= 0) db.prepare('DELETE FROM budgets WHERE id = ?').run(r.id);
    else db.prepare('UPDATE budgets SET amount_cents = ?, updated_at = ? WHERE id = ?').run(out[i], at, r.id);
  });
}

function budgetEnabled(ledgerId) {
  const row = db.prepare('SELECT budget_enabled FROM ledgers WHERE id = ?').get(ledgerId);
  return Number(row?.budget_enabled ?? 0) ? 1 : 0;
}

function setBudgetEnabled(ledgerId, value, at) {
  db.prepare('UPDATE ledgers SET budget_enabled = ?, updated_at = ? WHERE id = ?').run(value ? 1 : 0, at, ledgerId);
}

/**
 * v1.3.2：先应用显式开关，再对「写了正数预算」的情况自动开启
 * —— 避免用户设了预算却因为总开关是关的而看不到。
 */
function applyBudgetSwitch(ledgerId, enabledArg, writtenAmount, at) {
  if (enabledArg !== null) setBudgetEnabled(ledgerId, enabledArg, at);
  if (writtenAmount > 0 && !budgetEnabled(ledgerId)) setBudgetEnabled(ledgerId, 1, at);
}

function budgetView(ledgerId, month) {
  const budgets = db
    .prepare(
      `SELECT b.*, c.name AS category_name, c.icon AS category_icon
         FROM budgets b
         LEFT JOIN categories c ON c.id = b.category_id
        WHERE b.ledger_id = ? AND b.month = ?
        ORDER BY (b.category_id IS NULL) DESC, b.created_at ASC`,
    )
    .all(ledgerId, month);

  const usedRows = db
    .prepare(
      `SELECT category_id, SUM(amount_cents) AS used
         FROM transactions
        WHERE ledger_id = ? AND type = 'expense' AND deleted_at IS NULL
          AND substr(happened_at, 1, 10) LIKE ?
        GROUP BY category_id`,
    )
    .all(ledgerId, `${month}-%`);
  const usedByCat = new Map(usedRows.map((r) => [r.category_id, r.used]));
  const totalUsed = usedRows.reduce((s, r) => s + r.used, 0);
  // 分类额度合计（不含结转），items 与顶层共用
  const catAmount = budgets.filter((b) => b.category_id).reduce((s, b) => s + b.amount_cents, 0);

  const overall = budgets.find((b) => !b.category_id);
  const warnRaw = Number(overall?.warn_percent ?? 10);
  const warnPercent = Number.isInteger(warnRaw) && warnRaw >= 1 && warnRaw <= 100 ? warnRaw : 10;

  const items = budgets.map((b) => {
    const rollover = Number(b.rollover) === 1;
    const carryIn = budgetCarry(ledgerId, month, b.category_id, rollover);
    const used = b.category_id ? usedByCat.get(b.category_id) ?? 0 : totalUsed;
    const available = b.amount_cents + carryIn;
    const remaining = available - used;
    const head = budgetHeadline(b.amount_cents, b.category_id ? b.amount_cents : catAmount, available, remaining, warnPercent);
    return {
      id: b.id,
      category_id: b.category_id,
      category_name: b.category_name ?? null,
      category_icon: b.category_icon ?? null,
      amount_cents: b.amount_cents,
      rollover,
      carry_in_cents: carryIn,
      available_cents: available,
      used_cents: used,
      remaining_cents: remaining,
      percent_left: head.percent_left,
      warn_level: head.warn_level,
      created_at: b.created_at,
      updated_at: b.updated_at,
    };
  });
  // 顶部口径：有「总预算」行就用它；只设了分类预算时，顶部改用分类预算合计（含各自结转）
  const catItems = items.filter((i) => i.category_id);
  const catCarry = catItems.reduce((s, i) => s + i.carry_in_cents, 0);
  const catAvailable = catItems.reduce((s, i) => s + i.available_cents, 0);
  const topAmount = overall ? overall.amount_cents : catAmount;
  const topCarry = overall ? budgetCarry(ledgerId, month, null, Number(overall.rollover) === 1) : catCarry;
  const topAvailable = overall ? topAmount + topCarry : catAvailable;
  const topRemaining = topAvailable - totalUsed;
  const head = budgetHeadline(topAmount, catAmount, topAvailable, topRemaining, warnPercent);
  const unallocated = Math.max(0, topAmount - catAmount);
  // v1.3.2 预算功能总开关（按账本，0/1）
  const enabled = budgetEnabled(ledgerId);

  return {
    month,
    enabled,
    amount_cents: topAmount,
    carry_in_cents: topCarry,
    available_cents: topAvailable,
    used_cents: totalUsed,
    remaining_cents: topRemaining,
    // v1.3：预算条与预警
    categories_sum_cents: catAmount,
    unallocated_cents: unallocated,
    // 「有未分配额度」提示，不是错误状态，也不参与 warn_level
    mismatch: unallocated > 0,
    warn_percent: warnPercent,
    percent_left: head.percent_left,
    warn_level: head.warn_level,
    items,
  };
}

on('GET', '/budgets', (ctx) => {
  const ledgerId = resolveLedgerId(ctx.user.id, qs(ctx, 'ledger_id'));
  const month = qs(ctx, 'month') || currentMonth();
  if (!MONTH_RE.test(month)) fail(400, 'invalid_month', 'month 需为 YYYY-MM');
  return ok(budgetView(ledgerId, month));
});

on('PUT', '/budgets', (ctx) => {
  const body = ctx.body || {};
  const ledgerId = resolveLedgerId(ctx.user.id, body.ledger_id);
  const month = String(body.month ?? '').trim();
  if (!MONTH_RE.test(month)) fail(400, 'invalid_month', 'month 需为 YYYY-MM');
  let categoryId = body.category_id == null || body.category_id === '' ? null : String(body.category_id);
  if (categoryId) categoryInLedger(ledgerId, categoryId);

  // amount_cents 与 unallocated_cents 互斥（两者都给时直接 400，不做隐式取舍）
  const hasAmount = body.amount_cents !== undefined && body.amount_cents !== null && body.amount_cents !== '';
  const hasUnallocated =
    body.unallocated_cents !== undefined && body.unallocated_cents !== null && body.unallocated_cents !== '';
  if (hasAmount && hasUnallocated) fail(400, 'conflicting_amount', 'amount_cents 与 unallocated_cents 只能二选一');
  let unallocatedArg = null;
  if (hasUnallocated) {
    const u = Number(body.unallocated_cents);
    if (!Number.isInteger(u) || u < 0) fail(400, 'invalid_unallocated', 'unallocated_cents 必须是 >= 0 的整数');
    unallocatedArg = u;
  }

  // warn_percent：只作用于总预算行，1..100 的整数
  let nextWarn = null;
  if (body.warn_percent !== undefined && body.warn_percent !== null) {
    const n = Number(body.warn_percent);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      fail(400, 'invalid_warn_percent', 'warn_percent 需为 1..100 的整数');
    }
    nextWarn = n;
  }

  // v1.3.2 预算功能总开关：true|false|1|0，只改账本标志，不动预算行
  let enabledArg = null;
  if (body.enabled !== undefined && body.enabled !== null) {
    const raw = body.enabled;
    if (raw === true || raw === 1 || raw === '1' || raw === 'true') enabledArg = 1;
    else if (raw === false || raw === 0 || raw === '0' || raw === 'false') enabledArg = 0;
    else fail(400, 'invalid_enabled', 'enabled 需为 true / false / 1 / 0');
  }

  // 只带开关的请求（{ledger_id, month, enabled}）：只改账本标志，不建也不改任何预算行
  if (
    enabledArg !== null &&
    !hasAmount &&
    !hasUnallocated &&
    !categoryId &&
    nextWarn === null &&
    body.rollover === undefined
  ) {
    setBudgetEnabled(ledgerId, enabledArg, nowIso());
    return ok(budgetView(ledgerId, month));
  }

  const at = nowIso();
  const rollover = body.rollover === undefined ? null : body.rollover ? 1 : 0;
  const existing = db
    .prepare('SELECT * FROM budgets WHERE ledger_id = ? AND month = ? AND category_id IS ?')
    .get(ledgerId, month, categoryId);
  const rows = budgetCategoryRows(ledgerId, month);
  const sum = rows.reduce((s, r) => s + r.amount_cents, 0);
  const overall = budgetOverallRow(ledgerId, month);

  // amount_cents 可省略：只改 warn_percent / 只算「未分配」时沿用现值
  let amount;
  if (hasAmount) {
    amount = Number(body.amount_cents);
    if (!Number.isInteger(amount) || amount < 0) fail(400, 'invalid_amount', 'amount_cents 必须是 >= 0 的整数');
  } else if (existing) {
    amount = existing.amount_cents;
  } else {
    amount = categoryId ? 0 : sum;
  }

  const upsert = (targetCategoryId, value, warn) => {
    const row = db
      .prepare('SELECT * FROM budgets WHERE ledger_id = ? AND month = ? AND category_id IS ?')
      .get(ledgerId, month, targetCategoryId);
    if (row) {
      db.prepare(
        'UPDATE budgets SET amount_cents = ?, rollover = ?, warn_percent = COALESCE(?, warn_percent), updated_at = ? WHERE id = ?',
      ).run(value, rollover === null ? row.rollover : rollover, warn ?? null, at, row.id);
      return row.id;
    }
    const id = body.id ? String(body.id) : newId();
    db.prepare(
      'INSERT INTO budgets (id, ledger_id, month, category_id, amount_cents, rollover, warn_percent, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(id, ledgerId, month, targetCategoryId, value, rollover ?? 0, warn ?? 10, at, at);
    return id;
  };

  /* 分类预算：只写分类行，绝不改动总预算行（总预算 = 明细合计 + 未分配） */
  if (categoryId) {
    if (amount === 0) {
      if (existing) db.prepare('DELETE FROM budgets WHERE id = ?').run(existing.id);
      // 若同时带了 warn_percent，只更新阈值，不碰金额
      if (nextWarn !== null && overall) {
        db.prepare('UPDATE budgets SET warn_percent = ?, updated_at = ? WHERE id = ?').run(nextWarn, at, overall.id);
      }
      if (enabledArg !== null) setBudgetEnabled(ledgerId, enabledArg, at);
      const view = budgetView(ledgerId, month);
      return ok({ ...view, item: null, removed: true });
    }
    // 明细合计（改完这一行之后）不允许超过已有的总预算
    const prospective = sum - (existing?.amount_cents ?? 0) + amount;
    const cap = overall && overall.amount_cents > 0 ? overall.amount_cents : null;
    if (cap !== null && prospective > cap && !body.rebalance) {
      fail(
        409,
        'budget_below_allocated',
        `明细合计 ${prospective} 分超过总预算 ${cap} 分，需先提高总预算或带 rebalance 按比例压缩`,
        { total_cents: cap, categories_sum_cents: prospective },
      );
    }
    const id = upsert(categoryId, amount, null);
    if (cap !== null) {
      const after = budgetCategoryRows(ledgerId, month);
      const afterSum = after.reduce((s, r) => s + r.amount_cents, 0);
      if (afterSum > cap) rebalanceCategoryBudgets(after, cap, at);
    }
    if (nextWarn !== null && overall) {
      db.prepare('UPDATE budgets SET warn_percent = ?, updated_at = ? WHERE id = ?').run(nextWarn, at, overall.id);
    }
    applyBudgetSwitch(ledgerId, enabledArg, amount, at);
    const view = budgetView(ledgerId, month);
    return ok({ ...view, item: view.items.find((i) => i.id === id) ?? null, removed: false });
  }

  /* 总预算：= 明细合计 + 未分配；小于明细合计时 409 或按比例压缩分类 */
  if (unallocatedArg !== null && !hasAmount) amount = sum + unallocatedArg;
  if (amount < sum) {
    if (!body.rebalance) {
      fail(
        409,
        'budget_below_allocated',
        `总预算 ${amount} 分低于明细合计 ${sum} 分，需带 rebalance 按比例压缩分类`,
        { total_cents: amount, categories_sum_cents: sum },
      );
    }
    rebalanceCategoryBudgets(rows, amount, at);
  }
  const id = upsert(null, amount, nextWarn);
  applyBudgetSwitch(ledgerId, enabledArg, amount, at);
  const view = budgetView(ledgerId, month);
  return ok({ ...view, item: view.items.find((i) => i.id === id) ?? null, removed: false });
});

/* -------------------------------- 周期记账 -------------------------------- */

const FREQS = new Set(['daily', 'weekly', 'monthly', 'yearly']);

function isoDate(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function addDays(dateStr, n) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 加 n 个月，日号按目标月末夹取（1/31 + 1 月 → 2/28） */
function addMonthsClamped(dateStr, n) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  return isoDate(base.getUTCFullYear(), base.getUTCMonth() + 1, Math.min(d, last));
}

function advanceDate(dateStr, freq, interval) {
  const step = Math.max(1, Math.trunc(Number(interval) || 1));
  if (freq === 'daily') return addDays(dateStr, step);
  if (freq === 'weekly') return addDays(dateStr, step * 7);
  if (freq === 'monthly') return addMonthsClamped(dateStr, step);
  return addMonthsClamped(dateStr, step * 12);
}

function recurringOut(row) {
  const enabled = Number(row.enabled) === 1;
  const nextRun = String(row.next_run).slice(0, 10);
  return {
    id: row.id,
    ledger_id: row.ledger_id,
    type: row.type,
    amount_cents: row.amount_cents,
    category_id: row.category_id ?? null,
    account_id: row.account_id ?? null,
    to_account_id: row.to_account_id ?? null,
    note: row.note ?? null,
    freq: row.freq,
    interval: Number(row.interval) || 1,
    start_date: String(row.start_date).slice(0, 10),
    end_date: row.end_date == null ? null : String(row.end_date).slice(0, 10),
    next_run: nextRun,
    last_run: row.last_run == null ? null : String(row.last_run).slice(0, 10),
    enabled,
    due: enabled && nextRun <= todayLocal(),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeRule(body, existing, ledgerId) {
  if (!body || typeof body !== 'object') fail(400, 'invalid_body', '请求体需为对象');
  const src = existing ?? {
    type: null,
    amount_cents: null,
    category_id: null,
    account_id: null,
    to_account_id: null,
    note: null,
    freq: null,
    interval: 1,
    start_date: null,
    end_date: null,
    enabled: 1,
  };
  const pick = (key) => (body[key] === undefined ? src[key] : body[key]);

  const type = pick('type');
  if (!TX_TYPES.has(type)) fail(400, 'invalid_type', 'type 必须是 expense / income / transfer');
  const amount = Number(pick('amount_cents'));
  if (!Number.isInteger(amount) || amount <= 0) fail(400, 'invalid_amount', 'amount_cents 必须是正整数（分）');
  const freq = pick('freq');
  if (!FREQS.has(freq)) fail(400, 'invalid_freq', 'freq 必须是 daily / weekly / monthly / yearly');
  const interval = Number(pick('interval') ?? 1);
  if (!Number.isInteger(interval) || interval < 1 || interval > 366) {
    fail(400, 'invalid_interval', 'interval 需为 1~366 的整数');
  }
  const startDate = String(pick('start_date') || '').slice(0, 10);
  if (!DATE_RE.test(startDate)) fail(400, 'invalid_date', 'start_date 需为 YYYY-MM-DD');
  let endDate = pick('end_date');
  endDate = endDate == null || endDate === '' ? null : String(endDate).slice(0, 10);
  if (endDate && !DATE_RE.test(endDate)) fail(400, 'invalid_date', 'end_date 需为 YYYY-MM-DD');
  if (endDate && endDate < startDate) fail(400, 'invalid_range', 'end_date 不能早于 start_date');

  const accountRaw = pick('account_id');
  const accountId = accountRaw == null || accountRaw === '' ? null : String(accountRaw);
  if (!accountId) fail(400, 'invalid_account', 'account_id 必填');
  accountInLedger(ledgerId, accountId);
  const toRaw = pick('to_account_id');
  const toAccountId = toRaw == null || toRaw === '' ? null : String(toRaw);
  const catRaw = pick('category_id');
  let categoryId = catRaw == null || catRaw === '' ? null : String(catRaw);
  if (type === 'transfer') {
    if (!toAccountId) fail(400, 'invalid_account', '转账规则需要 to_account_id');
    if (toAccountId === accountId) fail(400, 'invalid_account', '转出与转入账户不能相同');
    accountInLedger(ledgerId, toAccountId);
    categoryId = null;
  } else if (categoryId) {
    categoryInLedger(ledgerId, categoryId);
  }
  const note = pick('note') == null ? null : String(pick('note')).slice(0, 1000);
  const enabledRaw = pick('enabled');
  const enabled = enabledRaw === false || enabledRaw === 0 || enabledRaw === '0' ? 0 : 1;

  let nextRun;
  if (existing) {
    nextRun = existing.next_run;
    const timingChanged =
      (body.freq !== undefined && body.freq !== existing.freq) ||
      (body.interval !== undefined && Number(body.interval) !== Number(existing.interval)) ||
      (body.start_date !== undefined && startDate !== String(existing.start_date).slice(0, 10));
    if (timingChanged || !nextRun) {
      if (existing.last_run) {
        let guard = 0;
        nextRun = advanceDate(existing.last_run, freq, interval);
        while (nextRun < startDate && guard < 500) {
          nextRun = advanceDate(nextRun, freq, interval);
          guard += 1;
        }
      } else {
        nextRun = startDate;
      }
    }
  } else {
    nextRun = startDate;
  }

  return {
    type,
    amount_cents: amount,
    category_id: type === 'transfer' ? null : categoryId,
    account_id: accountId,
    to_account_id: type === 'transfer' ? toAccountId : null,
    note,
    freq,
    interval,
    start_date: startDate,
    end_date: endDate,
    next_run: nextRun,
    enabled,
  };
}

const REC_SELECT = 'SELECT * FROM recurring_rules WHERE ledger_id = ? AND deleted_at IS NULL';

on('GET', '/recurring', (ctx) => {
  const ledgerId = resolveLedgerId(ctx.user.id, qs(ctx, 'ledger_id'));
  const rows = db.prepare(`${REC_SELECT} ORDER BY (next_run) ASC, created_at ASC`).all(ledgerId);
  return ok({ items: rows.map(recurringOut) });
});

on('POST', '/recurring', (ctx) => {
  const body = ctx.body || {};
  const ledgerId = resolveLedgerId(ctx.user.id, body.ledger_id);
  const data = normalizeRule(body, null, ledgerId);
  const at = nowIso();
  const id = body.id ? String(body.id) : newId();
  const taken = db.prepare('SELECT id, ledger_id FROM recurring_rules WHERE id = ?').get(id);
  if (taken) fail(409, 'id_exists', '该周期规则 id 已被占用');
  db.prepare(
    `INSERT INTO recurring_rules
       (id, ledger_id, type, amount_cents, category_id, account_id, to_account_id, note,
        freq, "interval", start_date, end_date, next_run, enabled, last_run, created_at, updated_at, deleted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,NULL)`,
  ).run(
    id,
    ledgerId,
    data.type,
    data.amount_cents,
    data.category_id,
    data.account_id,
    data.to_account_id,
    data.note,
    data.freq,
    data.interval,
    data.start_date,
    data.end_date,
    data.next_run,
    data.enabled,
    at,
    at,
  );
  const row = db.prepare('SELECT * FROM recurring_rules WHERE id = ?').get(id);
  return created(recurringOut(row));
});

on('PATCH', '/recurring/:id', (ctx) => {
  // 先按 id 找规则，再按其所属账本鉴权（客户端不必回传 ledger_id）
  const existing = db
    .prepare('SELECT * FROM recurring_rules WHERE id = ? AND deleted_at IS NULL')
    .get(ctx.params.id);
  if (!existing) fail(404, 'not_found', '周期规则不存在');
  getLedgerOrThrow(ctx.user.id, existing.ledger_id);
  const ledgerId = existing.ledger_id;
  const data = normalizeRule(ctx.body || {}, existing, ledgerId);
  db.prepare(
    `UPDATE recurring_rules SET type = ?, amount_cents = ?, category_id = ?, account_id = ?, to_account_id = ?,
            note = ?, freq = ?, "interval" = ?, start_date = ?, end_date = ?, next_run = ?, enabled = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    data.type,
    data.amount_cents,
    data.category_id,
    data.account_id,
    data.to_account_id,
    data.note,
    data.freq,
    data.interval,
    data.start_date,
    data.end_date,
    data.next_run,
    data.enabled,
    nowIso(),
    existing.id,
  );
  const row = db.prepare('SELECT * FROM recurring_rules WHERE id = ?').get(existing.id);
  return ok(recurringOut(row));
});

on('DELETE', '/recurring/:id', (ctx) => {
  const existing = db
    .prepare('SELECT * FROM recurring_rules WHERE id = ? AND deleted_at IS NULL')
    .get(ctx.params.id);
  if (!existing) fail(404, 'not_found', '周期规则不存在');
  getLedgerOrThrow(ctx.user.id, existing.ledger_id);
  db.prepare('UPDATE recurring_rules SET deleted_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), existing.id);
  return ok({ ok: true, id: existing.id });
});

on('POST', '/recurring/run', (ctx) => {
  const body = ctx.body || {};
  const ledgerId = resolveLedgerId(ctx.user.id, body.ledger_id);
  const target = (body.date ? String(body.date).slice(0, 10) : todayLocal());
  if (!DATE_RE.test(target)) fail(400, 'invalid_date', 'date 需为 YYYY-MM-DD');

  const rules = db
    .prepare(`${REC_SELECT} AND enabled = 1 ORDER BY next_run ASC, created_at ASC`)
    .all(ledgerId);

  const createdList = [];
  const skipped = [];
  const touched = [];
  const MAX_PER_RUN = 60;
  const at = nowIso();

  tx(() => {
    for (const rule of rules) {
      let nextRun = String(rule.next_run).slice(0, 10);
      let lastRun = rule.last_run == null ? null : String(rule.last_run).slice(0, 10);
      const endDate = rule.end_date == null ? null : String(rule.end_date).slice(0, 10);
      let made = 0;
      let guard = 0;
      let clampedToEnd = false;

      while (guard < 400) {
        guard += 1;
        if (nextRun > target) break;
        if (endDate && nextRun > endDate) {
          // 已越过 end_date：停在 end_date，enabled 保持不变
          nextRun = endDate;
          clampedToEnd = true;
          break;
        }
        const externalId = `rec:${rule.id}:${nextRun}`;
        const dup = db
          .prepare('SELECT id FROM transactions WHERE ledger_id = ? AND external_id = ?')
          .get(ledgerId, externalId);
        const next = advanceDate(nextRun, rule.freq, rule.interval);
        if (dup) {
          skipped.push({ rule_id: rule.id, date: nextRun, reason: 'already_exists' });
          nextRun = next;
          if (endDate && nextRun > endDate) {
            nextRun = endDate;
            clampedToEnd = true;
            break;
          }
          continue;
        }
        if (made >= MAX_PER_RUN) {
          skipped.push({ rule_id: rule.id, date: nextRun, reason: 'max_per_run_reached' });
          break;
        }
        const txId = stableId('rec', ledgerId, `${rule.id}:${nextRun}`);
        const row = {
          id: txId,
          ledger_id: ledgerId,
          type: rule.type,
          amount_cents: rule.amount_cents,
          category_id: rule.type === 'transfer' ? null : rule.category_id ?? null,
          account_id: rule.account_id ?? null,
          to_account_id: rule.type === 'transfer' ? rule.to_account_id ?? null : null,
          note: rule.note ?? null,
          happened_at: nextRun,
          source: 'auto',
          external_id: externalId,
        };
        db.prepare(
          `INSERT INTO transactions
             (id, ledger_id, type, amount_cents, category_id, account_id, to_account_id, note, happened_at,
              source, external_id, created_at, updated_at, deleted_at, reimburse_state, reimburse_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL)
           ON CONFLICT(id) DO NOTHING`,
        ).run(
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
          at,
          at,
        );
        applyTxEffect(row, 1);
        made += 1;
        lastRun = nextRun;
        createdList.push(txWithNames(row.id));
        nextRun = next;
        if (endDate && nextRun > endDate) {
          nextRun = endDate;
          clampedToEnd = true;
          break;
        }
      }

      if (!clampedToEnd && endDate && nextRun > endDate) nextRun = endDate;
      db.prepare('UPDATE recurring_rules SET next_run = ?, last_run = ?, updated_at = ? WHERE id = ?').run(
        nextRun,
        lastRun,
        at,
        rule.id,
      );
      touched.push(rule.id);
    }
  });

  const items = touched.length
    ? db
        .prepare(`SELECT * FROM recurring_rules WHERE id IN (${touched.map(() => '?').join(',')})`)
        .all(...touched)
        .map(recurringOut)
    : [];
  return ok({ date: target, created: createdList, skipped, rules: items, created_count: createdList.length, skipped_count: skipped.length });
});

/* --------------------------------- 导入导出 -------------------------------- */

const TYPE_LABEL = { expense: '支出', income: '收入', transfer: '转账' };

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* ---------------------- 导入格式：薄荷记账 / 本 App CSV / JSON ---------------------- */

const IMPORT_FORMATS = new Set(['auto', 'csv', 'mint', 'json']);
const MINT_COLUMNS = [
  '类型', '货币', '金额', '汇率（相对本位币）', '项目', '分类', '父类', '账户',
  '付款', '收款', '商家', '地址', '日期', '标签', '作者', '备注', '图一', '图二', '图三',
];
const MINT_TRANSFER_CATEGORY = '账户互转';
const UNSET_ACCOUNT_NAME = '未指定';
const MEMBER_COLORS = ['#4C9AFF', '#FF8B00', '#FF5630', '#36B37E', '#6554C0', '#00B8D9', '#FFAB00', '#8777D9'];
const MINT_TYPE_OF = { 支出: 'expense', 收入: 'income', 转账: 'transfer' };

/** 分 → 薄荷金额（支出为负），去掉多余的 0，至少保留整数部分 */
function mintAmount(cents) {
  const n = Number(cents) || 0;
  const text = (Math.abs(n) / 100).toFixed(2).replace(/\.?0+$/, '');
  const body = text === '' ? '0' : text;
  return n < 0 ? `-${body}` : body;
}

/** 内部时间 → 薄荷的 `YYYY-MM-DD HH:mm`（只有日期就补 00:00） */
function mintDate(value) {
  const s = String(value ?? '').trim();
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(s);
  if (!m) return s.slice(0, 16).replace('T', ' ');
  return `${m[1]} ${m[2] || '00:00'}`;
}

/** 薄荷不做引号转义：字段内的 TAB / 换行必须抹平 */
const sanitizeMintCell = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');

/** 客户端可能把 UTF-16LE 文件当二进制字符串塞进 JSON，这里按字节还原 */
function repairUtf16Text(text) {
  if (!String(text).includes('\u0000')) return String(text);
  const bytes = Buffer.alloc(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes.toString('utf16le');
}

function firstNonEmptyLine(text) {
  for (const line of String(text).split(/\r?\n/)) if (line.trim()) return line;
  return '';
}

/** 契约 §5：BOM → json → 15 列以上表头 → csv → 400 */
function detectImportFormat(data) {
  if (data && typeof data === 'object') return 'json';
  if (typeof data !== 'string' || !data.trim()) fail(400, 'invalid_data', 'data 不能为空');
  if (/^[\uFEFF\uFFFE]/.test(data) || /^[\u00ff\u00fe]{2}/.test(data) || data.includes('\u0000')) return 'mint';
  const head = data.replace(/^\uFEFF/, '').trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  const line = firstNonEmptyLine(data);
  if (!line) fail(400, 'unrecognized_format', '无法识别导入格式：内容为空');
  const byTab = line.split('\t').length;
  const byComma = line.split(',').length;
  const cols = Math.max(byTab, byComma);
  if (line.includes('类型') && line.includes('金额') && line.includes('日期') && cols >= 15) return 'mint';
  if (line.includes('日期') && line.includes('类型') && line.includes('金额')) return 'csv';
  fail(400, 'unrecognized_format', '无法识别导入格式，请显式指定 format=mint / csv / json');
}

/** RFC 4180 解析（引号内的逗号、换行都安全） */
function parseCsvTable(text) {
  const src = String(text).replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

const sha1Hex = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

/** 本 App CSV → 统一的导入行 */
function parseCsvRows(text) {
  const table = parseCsvTable(text);
  if (!table.length) return [];
  const header = table[0].map((h) => h.trim());
  const col = (name) => header.indexOf(name);
  const ix = {
    date: col('日期'),
    type: col('类型'),
    amount: col('金额'),
    category: col('分类'),
    account: col('账户'),
    to: col('转入账户'),
    note: col('备注'),
    ext: col('外部ID'),
    tags: col('标签'),
    reimb: col('报销状态'),
  };
  if (ix.date < 0 || ix.type < 0 || ix.amount < 0) fail(400, 'invalid_csv_header', 'CSV 缺少 日期 / 类型 / 金额 列');
  const rows = [];
  const seen = new Map();
  for (let i = 1; i < table.length; i += 1) {
    const cells = table[i];
    const pick = (idx) => (idx >= 0 && cells[idx] !== undefined ? String(cells[idx]).trim() : '');
    const rawType = pick(ix.type);
    const type = MINT_TYPE_OF[rawType] ?? (TX_TYPES.has(rawType) ? rawType : null);
    const amount = Number(pick(ix.amount).replace(/[,，\s]/g, ''));
    const raw = cells.join(',');
    // 完全相同的行在导出里可能出现多次（两笔同额同刻消费），用出现序号区分，避免被幂等键吞掉
    const base = sha1Hex(raw);
    const dup = seen.get(base) || 0;
    seen.set(base, dup + 1);
    const external = pick(ix.ext) || `csv:${base}${dup ? `#${dup}` : ''}`;
    const tags = pick(ix.tags).split(/[,，、|]/).map((s) => s.trim()).filter(Boolean);
    const reimb = REIMBURSE_STATES.has(pick(ix.reimb)) ? pick(ix.reimb) : null;
    let error = null;
    if (!type) error = '类型无法识别';
    else if (!Number.isFinite(amount) || amount === 0) error = '金额无法解析';
    rows.push({
      line: i + 1,
      input: {
        error,
        type,
        amount_cents: Number.isFinite(amount) ? Math.round(Math.abs(amount) * 100) : 0,
        category_name: pick(ix.category),
        account_name: pick(ix.account),
        to_account_name: pick(ix.to),
        note: pick(ix.note),
        happened_at: pick(ix.date) || todayLocal(),
        member_name: '',
        tags,
        external_id: external,
        reimburse_state: reimb,
      },
    });
  }
  return rows;
}

/** 薄荷记账（TAB 分隔，19 列表头，尾列常被裁掉）→ 统一的导入行 */
function parseMintRows(text) {
  const src = repairUtf16Text(text).replace(/^\uFEFF/, '').replace(/^\uFFFE/, '');
  const lines = src.split(/\r?\n/);
  const rows = [];
  const seen = new Map();
  let headerSeen = false;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].replace(/\r$/, '');
    if (!raw.trim()) continue;
    const cells = raw.split('\t');
    if (!headerSeen) {
      headerSeen = true;
      if (/类型/.test(cells[0] || '') && /金额/.test(raw) && /日期/.test(raw)) continue;
    }
    const c = cells.map((x) => String(x ?? '').trim());
    const type = MINT_TYPE_OF[c[0]];
    let error = null;
    if (!type) error = '类型无法识别';
    const amount = Number(String(c[2] ?? '').replace(/[,，\s]/g, ''));
    if (!error && (!Number.isFinite(amount) || amount === 0)) error = '金额无法解析';
    const currency = (c[1] || 'CNY').toUpperCase();
    const rateRaw = String(c[3] ?? '').trim();
    const rate = Number(rateRaw);
    let note = c[15] || '';
    const merchant = c[10] || '';
    if (merchant) note = note ? `${note} · ${merchant}` : merchant;
    if (currency && currency !== 'CNY') {
      const rateText = Number.isFinite(rate) && rate > 0 ? rate.toFixed(4) : rateRaw || '1.0000';
      note = `[货币 ${currency} 汇率 ${rateText}] ${note}`.trimEnd();
    }
    const tags = String(c[13] || '').split(/[,，、|]/).map((s) => s.trim()).filter(Boolean);
    // 同一行原文可能在样本里出现多次（两笔一模一样的消费），用出现序号区分保证都能落库且可重复导入
    const base = sha1Hex(raw);
    const dup = seen.get(base) || 0;
    seen.set(base, dup + 1);
    rows.push({
      line: i + 1,
      raw,
      input: {
        error,
        type,
        amount_cents: Number.isFinite(amount) ? Math.round(Math.abs(amount) * 100) : 0,
        category_name: type === 'transfer' ? '' : c[5] || '',
        account_name: type === 'transfer' ? c[8] || '' : c[7] || '',
        to_account_name: type === 'transfer' ? c[9] || '' : '',
        note,
        happened_at: mintDate(c[12]),
        member_name: c[14] || '',
        tags,
        external_id: type ? `mint:${base}${dup ? `#${dup}` : ''}` : null,
        reimburse_state: null,
      },
    });
  }
  return rows;
}

/** 账号/分类/成员/标签按名字自动建，交易按 external_id 幂等 */
function importFlatRows(rows, ledgerId, stats, warnings, at) {
  const warn = (msg) => {
    if (warnings.length < 20) warnings.push(msg);
  };
  const accountCache = new Map();
  const categoryCache = new Map();
  const memberCache = new Map();
  const tagCache = new Map();

  const nextSort = (table) =>
    Number(db.prepare(`SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM ${table} WHERE ledger_id = ?`).get(ledgerId)?.n) || 1;

  const guessAccountType = (name) => {
    if (/微信|支付宝/.test(name)) return 'ewallet';
    if (/现金/.test(name)) return 'cash';
    if (/基金|理财/.test(name)) return 'invest';
    if (/借呗|花呗|白条|借款|信用卡/.test(name)) return 'payable';
    if (/银行|招行|建行|工行|农行/.test(name)) return 'bank';
    return 'other';
  };

  const ensureAccount = (name) => {
    const key = name || '';
    if (accountCache.has(key)) return accountCache.get(key);
    const target = name || UNSET_ACCOUNT_NAME;
    const hit = db
      .prepare('SELECT id FROM accounts WHERE ledger_id = ? AND name = ? AND deleted_at IS NULL')
      .get(ledgerId, target);
    let id = hit?.id ?? null;
    if (!id) {
      id = newId();
      const type = name ? guessAccountType(name) : 'other';
      const kind = type === 'payable' || type === 'credit' ? 'liability' : 'asset';
      db.prepare(
        `INSERT INTO accounts (id, ledger_id, name, type, kind, balance_cents, credit_limit_cents, icon, sort, include_in_net, created_at, updated_at, deleted_at)
         VALUES (?,?,?,?,?,0,0,?,?,?,?,?,NULL)`,
      ).run(id, ledgerId, target, type, kind, name ? null : '❔', nextSort('accounts'), name ? 1 : 0, at, at);
      stats.accounts += 1;
    }
    accountCache.set(key, id);
    return id;
  };

  const ensureCategory = (name, kind) => {
    const key = `${kind}:${name}`;
    if (categoryCache.has(key)) return categoryCache.get(key);
    const hit = db
      .prepare('SELECT id FROM categories WHERE ledger_id = ? AND name = ? AND deleted_at IS NULL')
      .get(ledgerId, name);
    let id = hit?.id ?? null;
    if (!id) {
      id = newId();
      db.prepare(
        `INSERT INTO categories (id, ledger_id, name, kind, icon, sort, parent_id, created_at, updated_at, deleted_at)
         VALUES (?,?,?,?,NULL,?,NULL,?,?,NULL)`,
      ).run(id, ledgerId, name.slice(0, 24), kind, nextSort('categories'), at, at);
      stats.categories += 1;
    }
    categoryCache.set(key, id);
    return id;
  };

  const ensureMember = (name) => {
    if (memberCache.has(name)) return memberCache.get(name);
    const hit = db
      .prepare('SELECT id FROM members WHERE ledger_id = ? AND name = ? AND deleted_at IS NULL')
      .get(ledgerId, name);
    let id = hit?.id ?? null;
    if (!id) {
      id = newId();
      const count = Number(db.prepare('SELECT COUNT(*) AS n FROM members WHERE ledger_id = ?').get(ledgerId)?.n) || 0;
      db.prepare(
        `INSERT INTO members (id, ledger_id, name, color, is_self, sort, created_at, updated_at, deleted_at)
         VALUES (?,?,?,?,0,?,?,?,NULL)`,
      ).run(id, ledgerId, name.slice(0, 20), MEMBER_COLORS[count % MEMBER_COLORS.length], nextSort('members'), at, at);
      stats.members += 1;
    }
    memberCache.set(name, id);
    return id;
  };

  const ensureTag = (name) => {
    if (tagCache.has(name)) return tagCache.get(name);
    const hit = db
      .prepare('SELECT id FROM tags WHERE ledger_id = ? AND name = ? AND deleted_at IS NULL')
      .get(ledgerId, name);
    let id = hit?.id ?? null;
    if (!id) {
      id = newId();
      db.prepare('INSERT INTO tags (id, ledger_id, name, color, created_at, updated_at, deleted_at) VALUES (?,?,?,NULL,?,?,NULL)').run(
        id,
        ledgerId,
        name.slice(0, 24),
        at,
        at,
      );
      stats.tags += 1;
    }
    tagCache.set(name, id);
    return id;
  };

  const insTx = db.prepare(
    `INSERT INTO transactions
       (id, ledger_id, type, amount_cents, category_id, account_id, to_account_id, note, happened_at,
        source, external_id, member_id, created_at, updated_at, deleted_at, reimburse_state, reimburse_at)
     VALUES (?,?,?,?,?,?,?,?,?,'import',?,?,?,?,NULL,?,NULL)`,
  );
  const insTxTag = db.prepare('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?,?)');
  const findExternal = db.prepare('SELECT id FROM transactions WHERE ledger_id = ? AND external_id = ?');
  const findTxId = db.prepare('SELECT 1 AS ok FROM transactions WHERE id = ?');

  for (const row of rows) {
    const input = row.input;
    const skip = (reason) => {
      stats.skipped.transactions += 1;
      stats.skipped_rows += 1;
      warn(`第 ${row.line} 行${reason ? `：${reason}` : ''}，已跳过`);
    };
    if (!input || input.error) {
      skip(input?.error || '格式不完整');
      continue;
    }
    const amount = Math.trunc(Number(input.amount_cents));
    if (!Number.isFinite(amount) || amount <= 0) {
      skip('金额无效');
      continue;
    }
    if (input.external_id && findExternal.get(ledgerId, input.external_id)) {
      skip('');
      continue;
    }
    const id = input.external_id ? stableId('mint', ledgerId, input.external_id) : newId();
    if (findTxId.get(id)) {
      skip('id 冲突');
      continue;
    }
    const accountId = ensureAccount(input.account_name);
    const toAccountId = input.type === 'transfer' ? ensureAccount(input.to_account_name) : null;
    const categoryId =
      input.type === 'transfer'
        ? null
        : input.category_name
          ? ensureCategory(input.category_name, input.type === 'income' ? 'income' : 'expense')
          : null;
    const memberId = input.member_name ? ensureMember(input.member_name) : null;
    const txRow = {
      id,
      ledger_id: ledgerId,
      type: input.type,
      amount_cents: amount,
      category_id: categoryId,
      account_id: accountId,
      to_account_id: toAccountId,
      note: input.note ? String(input.note).slice(0, 1000) : null,
      happened_at: String(input.happened_at || todayLocal()).slice(0, 40),
      source: 'import',
      external_id: input.external_id || null,
    };
    insTx.run(
      txRow.id,
      txRow.ledger_id,
      txRow.type,
      txRow.amount_cents,
      txRow.category_id,
      txRow.account_id,
      txRow.to_account_id,
      txRow.note,
      txRow.happened_at,
      txRow.external_id,
      memberId,
      at,
      at,
      input.reimburse_state || null,
    );
    applyTxEffect(txRow, 1);
    stats.transactions += 1;
    for (const tagName of input.tags || []) {
      const tagId = ensureTag(tagName);
      insTxTag.run(id, tagId);
      stats.tag_links += 1;
    }
  }
}

on('GET', '/export', (ctx) => {
  const ledgerId = resolveLedgerId(ctx.user.id, qs(ctx, 'ledger_id'));
  const ledger = db.prepare('SELECT * FROM ledgers WHERE id = ?').get(ledgerId);
  const accounts = db.prepare(ACC_SELECT).all(ledgerId).map(accountOut);
  const categories = db.prepare(CAT_SELECT).all(ledgerId);
  const rawTx = db
    .prepare(`${TX_SELECT} WHERE t.ledger_id = ? AND t.deleted_at IS NULL ORDER BY t.happened_at ASC, t.created_at ASC`)
    .all(ledgerId);
  // 导出时 tags 给名称数组（可读、可跨库迁移），tag_ids 给 id 数组（精确恢复关联）
  const transactions = withTagsBatch(rawTx).map((t) => ({
    ...t,
    tag_ids: t.tags,
    tags: t.tag_names,
  }));
  const tags = db.prepare(TAG_SELECT).all(ledgerId);
  const transactionTags = db
    .prepare(
      `SELECT tt.transaction_id AS transaction_id, tt.tag_id AS tag_id
         FROM transaction_tags tt
         JOIN transactions t ON t.id = tt.transaction_id AND t.ledger_id = ? AND t.deleted_at IS NULL
         JOIN tags g ON g.id = tt.tag_id AND g.ledger_id = ? AND g.deleted_at IS NULL`,
    )
    .all(ledgerId, ledgerId);
  const recurring = db.prepare(`${REC_SELECT} ORDER BY created_at ASC`).all(ledgerId).map(recurringOut);
  const budgets = db.prepare('SELECT * FROM budgets WHERE ledger_id = ? ORDER BY month ASC').all(ledgerId);
  const format = (qs(ctx, 'format') || 'csv').toLowerCase();

  if (format === 'csv') {
    const header = ['日期', '类型', '金额', '分类', '账户', '转入账户', '备注', '来源', '外部ID', '标签', '报销状态'];
    const lines = [header.join(',')];
    for (const t of transactions) {
      lines.push(
        [
          String(t.happened_at).slice(0, 10),
          TYPE_LABEL[t.type] || t.type,
          (t.amount_cents / 100).toFixed(2),
          t.category_name || '',
          t.account_name || '',
          t.to_account_name || '',
          t.note || '',
          t.source || '',
          t.external_id || '',
          (t.tag_names || []).join('|'),
          t.reimburse_state || '',
        ]
          .map(csvCell)
          .join(','),
      );
    }
    const csv = `\uFEFF${lines.join('\r\n')}\r\n`;
    // HTTP 头只能是 ASCII：filename 用纯 ASCII 兜底，中文名走 RFC 5987 的 filename*
    const prettyName = `mintlite-${String(ledger.name || 'ledger').replace(/[\\/:*?"<>|\r\n]+/g, '_')}-${todayLocal()}.csv`;
    const asciiName = `mintlite-export-${todayLocal()}.csv`;
    return raw(
      200,
      {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(prettyName)}`,
      },
      csv,
    );
  }

  if (format === 'mint') {
    const rows = [MINT_COLUMNS.join('\t')];
    for (const t of transactions) {
      const transfer = t.type === 'transfer';
      const amount = t.type === 'expense' ? -Math.abs(t.amount_cents) : Math.abs(t.amount_cents);
      rows.push(
        [
          TYPE_LABEL[t.type] || '支出',
          'CNY',
          mintAmount(amount),
          '1.0000',
          '',
          transfer ? MINT_TRANSFER_CATEGORY : t.category_name || '',
          '',
          transfer ? '' : t.account_name || '',
          transfer ? t.account_name || '' : '',
          transfer ? t.to_account_name || '' : '',
          '',
          '',
          mintDate(t.happened_at),
          (t.tag_names || []).join(','),
          t.member_name || '',
          t.note || '',
          '',
          '',
          '',
        ]
          .map(sanitizeMintCell)
          .join('\t'),
      );
    }
    const body = Buffer.from(`\uFEFF${rows.join('\r\n')}\r\n`, 'utf16le');
    const prettyName = `mintlite-${String(ledger.name || 'ledger').replace(/[\\/:*?"<>|\r\n]+/g, '_')}-${todayLocal()}.txt`;
    const asciiName = `mintlite-export-${todayLocal()}.txt`;
    return raw(
      200,
      {
        'Content-Type': 'text/plain; charset=utf-16le',
        'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(prettyName)}`,
      },
      body,
    );
  }

  if (format !== 'json') fail(400, 'invalid_format', 'format 必须是 csv / mint / json');

  return ok({
    version: 2,
    app: 'mintlite',
    exported_at: nowIso(),
    ledger: ledgerRow(ledger),
    accounts,
    categories,
    tags,
    transactions,
    transaction_tags: transactionTags,
    recurring,
    budgets,
  });
});

on('POST', '/import', (ctx) => {
  const body = ctx.body || {};
  const ledgerId = resolveLedgerId(ctx.user.id, body.ledger_id);
  const dryRun = body.dry_run === true || body.dry_run === 1 || body.dry_run === 'true';
  const requested = String(body.format || 'auto').toLowerCase();
  if (!IMPORT_FORMATS.has(requested)) fail(400, 'invalid_format', 'format 必须是 auto / csv / mint / json');
  const format = requested === 'auto' ? detectImportFormat(body.data) : requested;

  let data = body.data;
  if (format === 'json') {
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data.replace(/^\uFEFF/, ''));
      } catch {
        fail(400, 'invalid_json', 'data 不是合法 JSON 字符串');
      }
    }
    if (Array.isArray(data)) data = { transactions: data };
    if (!data || typeof data !== 'object') fail(400, 'invalid_data', 'data 需为导出对象或交易数组');
  } else if (typeof data !== 'string' || !data.trim()) {
    fail(400, 'invalid_data', 'data 需为文件原文');
  }

  const stats = {
    accounts: 0,
    categories: 0,
    tags: 0,
    transactions: 0,
    tag_links: 0,
    recurring: 0,
    budgets: 0,
    members: 0,
    skipped_rows: 0,
    skipped: { accounts: 0, categories: 0, tags: 0, transactions: 0, recurring: 0, budgets: 0 },
  };
  const warnings = [];
  const at = nowIso();

  // 跨账本导入：同一 id 可能已被别的账本占用 → 重新分配 id 并重映射外键
  const accountMap = new Map();
  const categoryMap = new Map();
  const tagMap = new Map(); // 旧 id → 新 id
  const tagByName = new Map(); // 名称（小写）→ 新 id
  const mapId = (map, id) => (id === null || id === undefined ? null : map.get(String(id)) ?? String(id));

  const insAccount = db.prepare(
    'INSERT INTO accounts (id, ledger_id, name, type, balance_cents, icon, sort, include_in_net, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)',
  );
  const insCategory = db.prepare(
    'INSERT INTO categories (id, ledger_id, name, kind, icon, sort, parent_id, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,NULL)',
  );
  const existsInLedger = (table, id) =>
    !!id && !!db.prepare(`SELECT 1 AS ok FROM ${table} WHERE id = ? AND ledger_id = ?`).get(String(id), ledgerId);

  const importJsonData = (data) => {
    for (const a of Array.isArray(data.accounts) ? data.accounts : []) {
      if (!a || !a.id || !a.name) {
        stats.skipped.accounts += 1;
        continue;
      }
      const oldId = String(a.id);
      const hit = db.prepare('SELECT id, ledger_id FROM accounts WHERE id = ?').get(oldId);
      if (hit && hit.ledger_id === ledgerId) {
        accountMap.set(oldId, oldId);
        stats.skipped.accounts += 1;
        continue;
      }
      const accountId = hit ? stableId('account', ledgerId, oldId) : oldId;
      if (db.prepare('SELECT 1 AS ok FROM accounts WHERE id = ?').get(accountId)) {
        accountMap.set(oldId, accountId);
        stats.skipped.accounts += 1;
        continue;
      }
      const type = ACCOUNT_TYPES.has(a.type) ? a.type : 'other';
      insAccount.run(
        accountId,
        ledgerId,
        String(a.name).slice(0, 40),
        type,
        asInt(a.balance_cents, 0),
        a.icon == null ? null : String(a.icon).slice(0, 16),
        asInt(a.sort, 0),
        a.include_in_net === false || a.include_in_net === 0 ? 0 : 1,
        a.created_at || at,
        a.updated_at || at,
      );
      accountMap.set(oldId, accountId);
      stats.accounts += 1;
    }

    for (const c of Array.isArray(data.categories) ? data.categories : []) {
      if (!c || !c.id || !c.name) {
        stats.skipped.categories += 1;
        continue;
      }
      const oldId = String(c.id);
      const hit = db.prepare('SELECT id, ledger_id FROM categories WHERE id = ?').get(oldId);
      if (hit && hit.ledger_id === ledgerId) {
        categoryMap.set(oldId, oldId);
        stats.skipped.categories += 1;
        continue;
      }
      const categoryId = hit ? stableId('category', ledgerId, oldId) : oldId;
      if (db.prepare('SELECT 1 AS ok FROM categories WHERE id = ?').get(categoryId)) {
        categoryMap.set(oldId, categoryId);
        stats.skipped.categories += 1;
        continue;
      }
      const kind = c.kind === 'income' ? 'income' : 'expense';
      insCategory.run(
        categoryId,
        ledgerId,
        String(c.name).slice(0, 24),
        kind,
        c.icon == null ? null : String(c.icon).slice(0, 16),
        asInt(c.sort, 0),
        c.parent_id == null ? null : mapId(categoryMap, c.parent_id),
        c.created_at || at,
        c.updated_at || at,
      );
      categoryMap.set(oldId, categoryId);
      stats.categories += 1;
    }

    const insTag = db.prepare(
      'INSERT INTO tags (id, ledger_id, name, color, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,NULL)',
    );
    const existingTagByName = (name) =>
      db
        .prepare('SELECT id FROM tags WHERE ledger_id = ? AND name = ? AND deleted_at IS NULL')
        .get(ledgerId, name)?.id ?? null;

    for (const g of Array.isArray(data.tags) ? data.tags : []) {
      if (!g || !g.name) {
        stats.skipped.tags += 1;
        continue;
      }
      const name = String(g.name).slice(0, 24);
      const oldId = g.id ? String(g.id) : null;
      const dup = existingTagByName(name);
      if (dup) {
        if (oldId) tagMap.set(oldId, dup);
        tagByName.set(name.toLowerCase(), dup);
        stats.skipped.tags += 1;
        continue;
      }
      let tagId = oldId ?? newId();
      if (db.prepare('SELECT 1 AS ok FROM tags WHERE id = ?').get(tagId)) {
        tagId = oldId ? stableId('tag', ledgerId, oldId) : newId();
        if (db.prepare('SELECT 1 AS ok FROM tags WHERE id = ?').get(tagId)) {
          stats.skipped.tags += 1;
          continue;
        }
      }
      insTag.run(tagId, ledgerId, name, g.color == null ? null : String(g.color).slice(0, 16), g.created_at || at, at);
      if (oldId) tagMap.set(oldId, tagId);
      tagByName.set(name.toLowerCase(), tagId);
      stats.tags += 1;
    }

    const insTx = db.prepare(
      'INSERT INTO transactions (id, ledger_id, type, amount_cents, category_id, account_id, to_account_id, note, happened_at, source, external_id, created_at, updated_at, deleted_at, reimburse_state, reimburse_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)',
    );
    const insTxTag = db.prepare('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?,?)');

    for (const t of Array.isArray(data.transactions) ? data.transactions : []) {
      if (!t || !TX_TYPES.has(t.type) || !Number.isInteger(Number(t.amount_cents)) || Number(t.amount_cents) <= 0) {
        stats.skipped.transactions += 1;
        continue;
      }
      const oldId = t.id ? String(t.id) : null;
      const externalId = t.external_id == null || t.external_id === '' ? null : String(t.external_id);
      const hit = oldId ? db.prepare('SELECT id, ledger_id FROM transactions WHERE id = ?').get(oldId) : null;
      const dupExternal = externalId
        ? db.prepare('SELECT id FROM transactions WHERE ledger_id = ? AND external_id = ?').get(ledgerId, externalId)
        : null;
      if ((hit && hit.ledger_id === ledgerId) || dupExternal) {
        stats.skipped.transactions += 1;
        continue;
      }
      const id = hit ? stableId('tx', ledgerId, oldId) : oldId || newId();
      if (db.prepare('SELECT 1 AS ok FROM transactions WHERE id = ?').get(id)) {
        stats.skipped.transactions += 1;
        continue;
      }
      const categoryId = t.type === 'transfer' ? null : mapId(categoryMap, t.category_id);
      const accountId = mapId(accountMap, t.account_id);
      const toAccountId = t.type === 'transfer' ? mapId(accountMap, t.to_account_id) : null;
      const row = {
        id,
        ledger_id: ledgerId,
        type: t.type,
        amount_cents: Math.trunc(Number(t.amount_cents)),
        // 引用了目标账本里不存在的账户/分类 → 置空，避免跨账本改余额
        category_id: existsInLedger('categories', categoryId) ? categoryId : null,
        account_id: existsInLedger('accounts', accountId) ? accountId : null,
        to_account_id: existsInLedger('accounts', toAccountId) ? toAccountId : null,
        note: t.note == null ? null : String(t.note).slice(0, 1000),
        happened_at: String(t.happened_at || todayLocal()).slice(0, 40),
        source: TX_SOURCES.has(t.source) ? t.source : 'import',
        external_id: externalId,
      };
      const reimburseState = REIMBURSE_STATES.has(t.reimburse_state) ? t.reimburse_state : null;
      const reimburseAt = reimburseState === 'done'
        ? String(t.reimburse_at || row.happened_at).slice(0, 10)
        : null;
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
        t.created_at || at,
        at,
        reimburseState,
        reimburseAt,
      );
      applyTxEffect(row, 1);
      stats.transactions += 1;

      // 标签关联：tags 支持名称数组（CSV/JSON v2），tag_ids 支持旧 id 数组
      const wantedNames = Array.isArray(t.tags) ? t.tags : Array.isArray(t.tag_names) ? t.tag_names : [];
      const linkIds = new Set();
      for (const nm of wantedNames) {
        const name = String(nm).slice(0, 24);
        const hitId = tagByName.get(name.toLowerCase()) ?? existingTagByName(name);
        if (hitId) linkIds.add(hitId);
      }
      if (Array.isArray(t.tag_ids)) {
        for (const oldTagId of t.tag_ids) {
          const mapped = tagMap.get(String(oldTagId));
          if (mapped) linkIds.add(mapped);
        }
      }
      for (const tagId of linkIds) {
        insTxTag.run(row.id, tagId);
        stats.tag_links += 1;
      }
    }

    for (const b of Array.isArray(data.budgets) ? data.budgets : []) {
      if (!b || !MONTH_RE.test(String(b.month || ''))) {
        stats.skipped.budgets += 1;
        continue;
      }
      const month = String(b.month);
      const categoryId = b.category_id == null || b.category_id === '' ? null : String(b.category_id);
      const dup = db
        .prepare('SELECT id FROM budgets WHERE ledger_id = ? AND month = ? AND category_id IS ?')
        .get(ledgerId, month, categoryId);
      if (dup) {
        stats.skipped.budgets += 1;
        continue;
      }
      const wantedId = b.id ? String(b.id) : null;
      const idTaken = wantedId ? db.prepare('SELECT id FROM budgets WHERE id = ?').get(wantedId) : null;
      db.prepare(
        'INSERT INTO budgets (id, ledger_id, month, category_id, amount_cents, rollover, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run(
        idTaken || !wantedId ? newId() : wantedId,
        ledgerId,
        month,
        categoryId,
        asInt(b.amount_cents, 0),
        b.rollover ? 1 : 0,
        at,
        at,
      );
      stats.budgets += 1;
    }

    // 周期规则：以 (type, freq, start_date, amount, account) 判重，避免重复导入翻倍
    for (const r of Array.isArray(data.recurring) ? data.recurring : []) {
      if (!r || !TX_TYPES.has(r.type) || !FREQS.has(r.freq) || !DATE_RE.test(String(r.start_date || ''))) {
        stats.skipped.recurring += 1;
        continue;
      }
      const accountId = mapId(accountMap, r.account_id);
      if (!existsInLedger('accounts', accountId)) {
        stats.skipped.recurring += 1;
        continue;
      }
      const startDate = String(r.start_date).slice(0, 10);
      const amount = asInt(r.amount_cents, 0);
      const dup = db
        .prepare(
          `SELECT id FROM recurring_rules
            WHERE ledger_id = ? AND deleted_at IS NULL AND type = ? AND freq = ?
              AND start_date = ? AND amount_cents = ? AND account_id = ?`,
        )
        .get(ledgerId, r.type, r.freq, startDate, amount, accountId);
      if (dup) {
        stats.skipped.recurring += 1;
        continue;
      }
      const wantedId = r.id ? String(r.id) : null;
      let ruleId = wantedId ?? newId();
      if (db.prepare('SELECT 1 AS ok FROM recurring_rules WHERE id = ?').get(ruleId)) {
        ruleId = wantedId ? stableId('rule', ledgerId, wantedId) : newId();
        if (db.prepare('SELECT 1 AS ok FROM recurring_rules WHERE id = ?').get(ruleId)) {
          stats.skipped.recurring += 1;
          continue;
        }
      }
      const toAccountId = r.type === 'transfer' ? mapId(accountMap, r.to_account_id) : null;
      const endDate = r.end_date == null || r.end_date === '' ? null : String(r.end_date).slice(0, 10);
      db.prepare(
        `INSERT INTO recurring_rules
           (id, ledger_id, type, amount_cents, category_id, account_id, to_account_id, note,
            freq, "interval", start_date, end_date, next_run, enabled, last_run, created_at, updated_at, deleted_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,NULL)`,
      ).run(
        ruleId,
        ledgerId,
        r.type,
        amount,
        r.type === 'transfer' ? null : existsInLedger('categories', mapId(categoryMap, r.category_id)) ? mapId(categoryMap, r.category_id) : null,
        accountId,
        existsInLedger('accounts', toAccountId) ? toAccountId : null,
        r.note == null ? null : String(r.note).slice(0, 1000),
        r.freq,
        Math.max(1, asInt(r.interval, 1)),
        startDate,
        endDate,
        DATE_RE.test(String(r.next_run || '')) ? String(r.next_run).slice(0, 10) : startDate,
        r.enabled === false || r.enabled === 0 ? 0 : 1,
        at,
        at,
      );
      stats.recurring += 1;
    }
  };

  const runImport = () => {
    if (format === 'json') {
      importJsonData(data);
      return;
    }
    const rows = format === 'mint' ? parseMintRows(data) : parseCsvRows(data);
    importFlatRows(rows, ledgerId, stats, warnings, at);
  };

  if (dryRun) {
    db.exec('BEGIN IMMEDIATE');
    try {
      runImport();
    } finally {
      db.exec('ROLLBACK');
    }
  } else {
    tx(runImport);
  }

  const skippedTotal = stats.skipped_rows + (format === 'json' ? stats.skipped.transactions : 0);
  return ok({
    ...stats,
    ok: true,
    ledger_id: ledgerId,
    format,
    dry_run: dryRun,
    created: stats.transactions,
    updated: 0,
    skipped: skippedTotal,
    accounts_created: stats.accounts,
    categories_created: stats.categories,
    members_created: stats.members,
    tags_created: stats.tags,
    warnings,
    imported: stats,
  });
});

/* --------------------------------- 静态文件 -------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let rel = pathname;
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.resolve(WEB_DIR, `.${rel}`);
  if (full !== WEB_DIR && !full.startsWith(WEB_DIR + path.sep)) return false;
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const ext = path.extname(full).toLowerCase();
  const body = req.method === 'HEAD' ? Buffer.alloc(0) : fs.readFileSync(full);
  res.writeHead(200, {
    ...CORS,
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': req.method === 'HEAD' ? stat.size : body.length,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
  });
  res.end(body);
  return true;
}

/* ---------------------------------- 分发器 --------------------------------- */

function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        settled = true;
        reject(new HttpError(413, 'payload_too_large', '请求体超过 2MB 限制'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'invalid_json', '请求体不是合法 JSON'));
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

async function handle(req, res) {
  let url;
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendJson(res, 400, { error: { code: 'bad_url', message: '请求 URL 非法' } });
  }
  const pathname = safeDecode(url.pathname);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  let apiPath = pathname.replace(/\/+$/, '') || '/';
  if (apiPath === API_PREFIX) apiPath = '/';
  else if (apiPath.startsWith(`${API_PREFIX}/`)) apiPath = apiPath.slice(API_PREFIX.length) || '/';

  for (const route of routes) {
    if (route.method !== req.method) continue;
    const m = route.re.exec(apiPath);
    if (!m) continue;
    const params = {};
    route.keys.forEach((key, i) => {
      params[key] = safeDecode(m[i + 1]);
    });
    const ctx = { req, res, params, query: url.searchParams, body: null, user: null };
    if (route.auth) ctx.user = requireUser(req);
    ctx.body = await readBody(req);
    const result = await route.handler(ctx);
    if (result && result.__http) {
      if (result.isRaw) return sendRaw(res, result.status, result.headers || {}, result.payload);
      return sendJson(res, result.status, result.body, result.headers);
    }
    return sendJson(res, 200, result ?? {});
  }

  if (serveStatic(req, res, pathname)) return;

  if (pathname.startsWith('/api/') || pathname === '/health') {
    return sendJson(res, 404, { error: { code: 'not_found', message: `接口不存在：${req.method} ${pathname}` } });
  }
  return sendJson(res, 404, { error: { code: 'not_found', message: '资源不存在' } });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (res.writableEnded) return;
    if (err instanceof HttpError) {
      const error = { code: err.code, message: err.message };
      if (err.details !== undefined) error.details = err.details;
      return sendJson(res, err.status, { error });
    }
    console.error('[internal-error]', req.method, req.url, err);
    return sendJson(res, 500, { error: { code: 'internal_error', message: '服务器内部错误' } });
  });
});

server.keepAliveTimeout = 30_000;

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push({ name, address: iface.address });
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  const lines = [
    `MintLite server v${VERSION} 已启动，监听 0.0.0.0:${PORT}`,
    `  本机:   http://127.0.0.1:${PORT}`,
    `  接口:   http://127.0.0.1:${PORT}${API_PREFIX}/health`,
  ];
  for (const { name, address } of lanAddresses()) {
    lines.push(`  局域网: http://${address}:${PORT}  (${name} · 手机同 Wi-Fi 可直接访问)`);
  }
  lines.push(`  静态:   ${WEB_DIR}${fs.existsSync(WEB_DIR) ? '' : ' (尚未创建，GET / 返回 404)'}`);
  lines.push(`  数据库: ${dbPath}`);
  lines.push(`  密钥:   ${path.join(dataDir, 'secret.key')}`);
  lines.push(`  demo:   demo / demo1234`);
  console.log(lines.join('\n'));
});

server.on('error', (err) => {
  console.error('[server-error]', err.message);
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
