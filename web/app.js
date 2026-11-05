// web/app.js — 丁点记账入口：hash 路由 + 渲染 + 交互
// 零依赖、零构建。所有数据通过 js/store.js 门面访问，本地/服务器模式无感切换。

import {
  store,
  initStore,
  getSettings,
  saveSettings,
  resetSettings,
  getCurrentLedgerId,
  setCurrentLedgerId,
  getLocalStore,
  DEFAULT_BASE_URL,
  apiLogin,
  apiRegister,
  ApiStore,
} from './js/store.js';
import { ensureSeed, seedDefaults } from './js/seed.js';
import * as M from './js/money.js';
import * as S from './js/stats.js';
import * as X from './js/mint.js';
import { uid, nowISO, todayISO, escapeHtml as esc, isNewer } from './js/util.js';

const VERSION = '1.3.2';
// 环形图 / 排行条 / 图例共用的一套色板：以薄荷为主色，其余色相拉开，
// 保证相邻分类在环形图上能分清（纯绿同色系在小占比时几乎看不见）。
const PALETTE = [
  '#3eb489',
  '#4f9de0',
  '#f0a458',
  '#e0788b',
  '#8b7bd8',
  '#4bbf9a',
  '#e0b64f',
  '#6fa8dc',
  '#c96fa8',
  '#79b86a',
];
const ACCOUNT_TYPES = [
  ['cash', '现金'],
  ['bank', '银行卡'],
  ['ewallet', '电子钱包'],
  ['credit', '信用卡'],
  ['invest', '投资'],
  ['receivable', '应收'],
  ['payable', '应付'],
  ['other', '其它'],
];
// 信用卡 / 应付默认算负债，其余算资产；用户可以手动改
const TYPE_TO_KIND = { credit: 'liability', payable: 'liability' };
// 只有「信用卡」这一类账户才有额度、账单日、还款日（花呗/借呗/白条/抖音钱包都归到信用卡）
const CREDIT_FIELD_KEYS = ['limit', 'bill_day', 'repay_day'];
function isCreditAccount(type) {
  return String(type || '') === 'credit';
}
const TYPE_LABEL = Object.fromEntries(ACCOUNT_TYPES);
const KIND_LABEL = { asset: '资产', liability: '负债' };
const TAG_COLORS = ['#3eb489', '#4f9de0', '#f0a458', '#e0788b', '#8b7bd8', '#4bbf9a', '#e0b64f', '#c96fa8'];
const EMOJI_CHOICES = ['🍜', '🚌', '🛍️', '🏠', '🎮', '💊', '📚', '🎁', '📦', '💰', '🏆', '🧾', '📈', '🧧', '☕', '🍎', '🐱', '✈️', '💡', '🎵', '🧴', '🚗', '💼', '✨'];

// ------------------------------------------------------------ 状态

const state = {
  ready: false,
  ledgers: [],
  ledger: null,
  ledgerId: '',
  accounts: [],
  categories: [],
  tags: [],
  recurring: [],
  assets: null,
  members: [],
  reminders: [],
  monthly: [],
  openHidden: false,
  month: S.currentMonth(),
  reportKind: 'expense',
  trendMode: 'bars',
  // 报表筛选态：preset 决定 from/to，其余是叠加筛选条件
  report: {
    preset: 'month',
    from: '',
    to: '',
    type: '',
    account_id: '',
    category_id: '',
    tag_id: '',
    q: '',
    min_cents: null,
    max_cents: null,
    donut: 'category',
    donutKind: 'expense',
    granularity: 'day',
    series: 'expense',
  },
  listFilter: { preset: '', tag_id: '', type: '', q: '', from: '', to: '', account_id: '', category_id: '', min_cents: null, max_cents: null },
  add: null,
  lastAdd: null,
  recentTx: [],
  booted: false,
  syncing: false,
  syncLog: [],
};

const el = {
  view: null,
  tabbar: null,
  toast: null,
  sheet: null,
  onboard: null,
};

function $(id) {
  return document.getElementById(id);
}

// ------------------------------------------------------------ 小工具

let toastTimer = 0;
function toast(message, kind = 'info', action) {
  const node = el.toast;
  if (!node) return;
  node.textContent = message;
  node.classList.toggle('is-error', kind === 'error');
  node.classList.add('is-on');
  // 带操作的提示：点一下执行，停留时间也长一点
  node.style.cursor = action ? 'pointer' : '';
  node.onclick = action
    ? () => {
        node.classList.remove('is-on');
        try {
          action.fn();
        } catch (err) {
          console.error(err);
        }
      }
    : null;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.classList.remove('is-on'), action ? 8000 : 2000);
}

const fmt = (cents) => M.formatCents(cents);
const fmtMoney = (cents) => `¥${M.formatCents(Math.abs(cents))}`;

function pct(ratio) {
  const v = Math.round((Number(ratio) || 0) * 1000) / 10;
  return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}%`;
}

let suppressClickUntil = 0;

function todayMonth() {
  return S.currentMonth();
}

// ------------------------------------------------------------ 弹层

let sheetSubmitHandler = null;
let confirmResolver = null;

function openSheet({ title, body, footer = '', onMount, wide = false }) {
  sheetSubmitHandler = null;
  el.sheet.innerHTML = `
    <div class="sheet-mask" data-act="sheet-close"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}" ${wide ? 'style="max-height:92vh"' : ''}>
      <header class="sheet-head"><h3>${esc(title)}</h3><button class="icon-btn" data-act="sheet-close" aria-label="关闭">✕</button></header>
      <div class="sheet-body">${body}</div>
      ${footer ? `<footer class="sheet-foot">${footer}</footer>` : '<div style="height:10px"></div>'}
    </div>`;
  el.sheet.classList.add('is-open');
  if (onMount) onMount(el.sheet);
}

function closeSheet() {
  el.sheet.classList.remove('is-open');
  el.sheet.innerHTML = '';
  sheetSubmitHandler = null;
  if (confirmResolver) {
    const r = confirmResolver;
    confirmResolver = null;
    r(false);
  }
}

function confirmDialog({ title = '确认', message = '', confirmText = '确定', danger = true }) {
  return new Promise((resolve) => {
    if (confirmResolver) {
      const prev = confirmResolver;
      confirmResolver = null;
      prev(false);
    }
    confirmResolver = resolve;
    openSheet({
      title,
      body: `<p class="hint" style="font-size:13px;color:var(--text-2)">${esc(message)}</p>`,
      footer: `<button class="btn" data-act="confirm-no">取消</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-act="confirm-yes">${esc(confirmText)}</button>`,
    });
  });
}

function fieldHtml(field, value) {
  const v = value == null ? '' : String(value);
  const label = `<span>${esc(field.label)}</span>`;
  if (field.type === 'select') {
    const opts = (field.options || [])
      .map(([val, text]) => `<option value="${esc(val)}" ${String(val) === v ? 'selected' : ''}>${esc(text)}</option>`)
      .join('');
    return `<label class="field">${label}<select name="${esc(field.key)}">${opts}</select></label>`;
  }
  if (field.type === 'textarea') {
    return `<label class="field">${label}<textarea name="${esc(field.key)}" rows="2" placeholder="${esc(field.placeholder || '')}">${esc(v)}</textarea></label>`;
  }
  if (field.type === 'emoji') {
    const palette = EMOJI_CHOICES.map((e) => `<button type="button" data-emoji="${e}">${e}</button>`).join('');
    return `<label class="field">${label}
      <input name="${esc(field.key)}" value="${esc(v || field.defaultValue || '📦')}" maxlength="4" placeholder="选一个 emoji">
      <div class="emoji-palette">${palette}</div></label>`;
  }
  const type = field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text';
  const extra =
    type === 'number'
      ? ` inputmode="${field.step === '0.01' ? 'decimal' : 'numeric'}" step="${esc(field.step || '1')}" min="${esc(field.min ?? 0)}"`
      : '';
  return `<label class="field">${label}<input type="${type}" name="${esc(field.key)}" value="${esc(v)}" placeholder="${esc(field.placeholder || '')}"${extra}></label>`;
}

// 账户表单：额度 / 账单日 / 还款日只对「信用卡」类型显示（花呗/借呗/白条也算这一类），
// 切换类型时立即生效；切回非信用卡会清空这三个值，避免带着旧额度保存。
function wireCreditFields(form) {
  if (!form) return;
  const typeSel = form.querySelector('[name="type"]');
  if (!typeSel) return;
  const kindSel = form.querySelector('[name="kind"]');
  const nodes = CREDIT_FIELD_KEYS.map((k) => form.querySelector(`[name="${k}"]`)).filter(Boolean);
  let kindTouched = false;
  if (kindSel) kindSel.addEventListener('change', () => { kindTouched = true; });
  const apply = () => {
    const on = isCreditAccount(typeSel.value);
    for (const n of nodes) {
      const wrap = n.closest('.field') || n;
      wrap.classList.toggle('is-hidden', !on);
      if (!on) n.value = '';
    }
    if (kindSel && !kindTouched) kindSel.value = TYPE_TO_KIND[typeSel.value] || 'asset';
  };
  apply();
  typeSel.addEventListener('change', apply);
}

function openForm({ title, fields, values = {}, submitText = '保存', intro = '', wide = false, onSubmit }) {
  openSheet({
    title,
    wide,
    body: `<form id="sheet-form" autocomplete="off">${intro}<div>${fields
      .map((f) => fieldHtml(f, values[f.key] ?? f.defaultValue))
      .join('')}</div></form>`,
    footer: `<button class="btn" data-act="sheet-close">取消</button>
      <button class="btn primary" data-act="sheet-submit">${esc(submitText)}</button>`,
  });
  sheetSubmitHandler = async () => {
    const form = $('sheet-form');
    if (!form) return;
    const out = {};
    for (const f of fields) {
      const input = form.querySelector(`[name="${f.key}"]`);
      out[f.key] = input ? input.value.trim() : '';
    }
    const btn = el.sheet.querySelector('[data-act="sheet-submit"]');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '处理中…';
    }
    try {
      await onSubmit(out);
    } catch (err) {
      toast(err && err.message ? err.message : '保存失败', 'error');
      if (btn) {
        btn.disabled = false;
        btn.textContent = submitText;
      }
    }
  };
}

// ------------------------------------------------------------ 数据加载

function currentLedger() {
  return state.ledgers.find((l) => l.id === state.ledgerId) || state.ledgers[0] || null;
}

// ------------------------------------------------------------ v1.2：账本切换 / 成员

// 折叠/隐藏的分组 key 记在 localStorage，刷新后保持（契约 §4 要求）
const ASSET_UI_KEYS = { collapsed: 'mintlite:asset-collapsed', hidden: 'mintlite:asset-hidden' };

function readAssetList(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function writeAssetList(key, list) {
  try {
    localStorage.setItem(key, JSON.stringify([...new Set(list.map(String))]));
  } catch {
    /* 隐私模式 / 存储禁用时忽略 */
  }
}

function assetUI() {
  return { collapsed: readAssetList(ASSET_UI_KEYS.collapsed), hidden: readAssetList(ASSET_UI_KEYS.hidden) };
}

function saveAssetUI(next = {}) {
  if (Array.isArray(next.collapsed)) writeAssetList(ASSET_UI_KEYS.collapsed, next.collapsed);
  if (Array.isArray(next.hidden)) writeAssetList(ASSET_UI_KEYS.hidden, next.hidden);
}

function toggleAssetList(key, value) {
  const field = key === 'hidden' ? 'hidden' : 'collapsed';
  const set = new Set(readAssetList(ASSET_UI_KEYS[field]));
  if (set.has(value)) set.delete(value);
  else set.add(value);
  const arr = [...set];
  writeAssetList(ASSET_UI_KEYS[field], arr);
  return arr;
}

function ledgerSwitchHtml() {
  const name = state.ledger ? state.ledger.name : '选择账本';
  return `<button class="ledger-switch" data-act="ledger-switch" aria-haspopup="dialog" aria-label="切换账本">
    <span class="ls-name">${esc(name)}</span><i class="ls-caret" aria-hidden="true"></i>
  </button>`;
}

function openLedgerMenu() {
  const rows = state.ledgers
    .map(
      (l) => `<button class="ledger-opt ${l.id === state.ledgerId ? 'is-on' : ''}" data-act="ledger-pick" data-id="${esc(l.id)}">
        <span class="lo-ico">📒</span>
        <span class="lo-name">${esc(l.name)}</span>
        ${Number(l.is_default) === 1 ? '<span class="tag">默认</span>' : ''}
        ${l.id === state.ledgerId ? '<span class="lo-check">✓</span>' : ''}
      </button>`,
    )
    .join('');
  openSheet({
    title: '切换账本',
    body: `<div class="ledger-opts">${rows || '<div class="empty">还没有账本</div>'}</div>
      <div class="btn-col" style="margin-top:10px">
        <button class="btn primary" data-act="ledger-new">＋ 新建账本</button>
        <button class="btn" data-act="nav" data-href="#/me/ledgers">管理账本</button>
      </div>`,
  });
}

function memberList() {
  return Array.isArray(state.members) ? state.members : [];
}

function selfMember() {
  return memberList().find((m) => Number(m.is_self) === 1) || memberList()[0] || null;
}

function memberById(id) {
  return memberList().find((m) => m.id === id) || null;
}

function memberChipsHtml() {
  const a = state.add;
  const rows = memberList();
  if (!rows.length) return '';
  const picked = a.memberId || (selfMember() ? selfMember().id : '');
  return `<div class="member-row">
    <span class="member-label">成员</span>
    <div class="member-chips">
      ${rows
        .map(
          (m) => `<button class="member-chip ${picked === m.id ? 'is-on' : ''}" data-act="member-select" data-member-id="${esc(m.id)}"
            style="--member-c:${esc(m.color || '#2f9e8f')}">
            <i class="mc-dot"></i>${esc(m.name)}</button>`,
        )
        .join('')}
      <button class="chip is-ghost member-chip-add" data-act="member-add">＋</button>
    </div>
  </div>`;
}

function memberBadgeHtml(tx) {
  if (!tx || !tx.member_id) return '';
  const m = memberById(tx.member_id);
  const name = (m && m.name) || tx.member_name;
  if (!name) return '';
  if (m && Number(m.is_self) === 1) return '';
  return `<span class="tx-member" style="--member-c:${esc((m && m.color) || '#8b98a3')}">${esc(name)}</span>`;
}

async function renderMembersPage() {
  const rows = await store.listMembers(state.ledgerId).catch(() => memberList());
  const html = rows.length
    ? rows
        .map(
          (m) => `<div class="row-item member-row" data-id="${esc(m.id)}">
        <span class="r-ico" style="color:${esc(m.color || '#2f9e8f')}">●</span>
        <div class="r-main">
          <div class="r-name">${esc(m.name)}${Number(m.is_self) === 1 ? '<span class="tag">默认</span>' : ''}</div>
          <div class="r-sub">${Number(m.is_self) === 1 ? '默认成员，记账时不选就记到 TA 名下' : '可删除'}</div>
        </div>
        <div class="r-tools">
          <button class="mini-btn" data-act="member-edit" data-id="${esc(m.id)}">改名</button>
          ${Number(m.is_self) === 1 ? '' : `<button class="mini-btn danger" data-act="member-del" data-id="${esc(m.id)}">删除</button>`}
        </div>
      </div>`,
        )
        .join('')
    : '<div class="empty"><span class="empty-emoji">👥</span>还没有成员</div>';

  return `<div class="page">
    ${subHeader('成员')}
    <div class="scroll">
      <p class="hint" style="padding:10px 18px 0">成员用来区分「谁花的钱」：记账页选一下成员，明细与报表就能按人统计。「我」是默认成员，不能删除。</p>
      <div class="row-list swipe-list" id="member-list" style="margin-top:10px">${html}</div>
      <button class="add-row" data-act="member-add">＋ 新建成员</button>
    </div>
  </div>`;
}

function openMemberForm(memberId, opts = {}) {
  const row = memberId ? memberById(memberId) : null;
  openForm({
    title: row ? '编辑成员' : '新建成员',
    fields: [
      { key: 'name', label: '成员名称', placeholder: '例如：老婆' },
      { key: 'color', label: '颜色', type: 'select', options: TAG_COLORS.map((c) => [c, c]) },
    ],
    values: { name: row ? row.name : '', color: row ? row.color || TAG_COLORS[0] : TAG_COLORS[3] },
    submitText: row ? '保存' : '创建',
    onSubmit: async (v) => {
      if (!v.name) throw new Error('名字不能为空');
      let saved = null;
      if (row) await store.updateMember(row.id, { name: v.name, color: v.color });
      else saved = await store.createMember({ ledger_id: state.ledgerId, name: v.name, color: v.color, is_self: 0 });
      if (opts.select && state.add && saved) state.add.memberId = saved.id;
      closeSheet();
      toast(row ? '成员已更新' : '成员已创建');
      await refresh();
    },
  });
}

async function loadCore() {
  state.ledgers = await store.listLedgers();
  let lid = getCurrentLedgerId();
  if (!lid || !state.ledgers.some((l) => l.id === lid)) {
    const def = state.ledgers.find((l) => l.is_default) || state.ledgers[0];
    lid = def ? def.id : '';
    if (lid) setCurrentLedgerId(lid);
  }
  state.ledgerId = lid;
  state.ledger = currentLedger();
  if (lid) {
    const [tags, recent] = await Promise.all([store.listTags(lid).catch(() => []), store.listTransactions({ ledger_id: lid, limit: 300 })]);
    state.tags = tags;
    state.recentTx = recent.items;
    const [accounts, categories] = await Promise.all([store.listAccounts(lid), store.listCategories(lid)]);
    state.accounts = accounts;
    state.categories = categories;
    const [assets, recurring, members, reminders, monthly] = await Promise.all([
      store.listAssets(lid).catch(() => null),
      store.listRecurring(lid).catch(() => []),
      store.listMembers(lid).catch(() => []),
      store.listReminders(lid, todayISO()).catch(() => []),
      store.statsMonthly(lid, 12).catch(() => []),
    ]);
    state.assets = assets;
    state.recurring = recurring;
    state.members = members;
    state.reminders = reminders;
    state.monthly = monthly;
    // 切账本后旧表单里的账户/分类可能不属于当前账本，直接丢弃重来
    if (state.add && !state.add.editingId) {
      const ids = new Set(accounts.map((a) => a.id));
      if (state.add.accountId && !ids.has(state.add.accountId)) state.add = null;
    }
  } else {
    state.accounts = [];
    state.categories = [];
    state.tags = [];
    state.recurring = [];
    state.assets = null;
    state.members = [];
    state.reminders = [];
    state.monthly = [];
    state.recentTx = [];
  }
}

async function refresh({ reload = true } = {}) {
  if (reload) await loadCore();
  await route();
}

// ------------------------------------------------------------ 记账页

// v1.2.1：按账本记住「上次选的账户 / 上次的收支类型」
function prefKey(name) {
  return `mintlite:${name}:${state.ledgerId || ''}`;
}

function readPref(name) {
  try {
    return localStorage.getItem(prefKey(name)) || '';
  } catch {
    return '';
  }
}

function writePref(name, value) {
  try {
    localStorage.setItem(prefKey(name), String(value == null ? '' : value));
  } catch {
    /* 隐私模式写不进去就算了 */
  }
}

function rememberedAccountId() {
  const id = readPref('last-account');
  if (!id) return '';
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc || Number(acc.hidden) === 1) return '';
  return id;
}

function rememberAccount(id) {
  if (id) writePref('last-account', id);
}

function rememberedType() {
  const t = readPref('last-type');
  return t === 'income' || t === 'expense' ? t : '';
}

function rememberType(type) {
  if (type === 'expense' || type === 'income') writePref('last-type', type);
}

function freshAdd() {
  const last = state.lastAdd || {};
  const accs = state.accounts;
  const remembered = rememberedAccountId();
  state.add = {
    type: rememberedType() || (last.type === 'transfer' ? 'expense' : last.type) || 'expense',
    calc: M.createCalculator(''),
    categoryId: last.categoryId || null,
    accountId: remembered || (last.accountId && accs.some((a) => a.id === last.accountId) ? last.accountId : accs[0] ? accs[0].id : null),
    toAccountId:
      last.toAccountId && accs.some((a) => a.id === last.toAccountId) ? last.toAccountId : accs[1] ? accs[1].id : null,
    tagIds: [],
    reimburse: false,
    memberId: (selfMember() || {}).id || null,
    date: todayISO(),
    note: '',
    editingId: null,
    saving: false,
  };
}

function addTagIds() {
  const a = state.add;
  return Array.isArray(a.tagIds) ? a.tagIds : (a.tagIds = []);
}

async function prepareAdd(params) {
  const id = params.get('id');
  if (id) {
    if (state.add && state.add.editingId === id) return;
    let tx = null;
    try {
      tx = await store.getTransaction(id);
    } catch {
      tx = null;
    }
    if (tx && !tx.deleted_at) {
      state.add = {
        type: tx.type,
        calc: M.createCalculator(M.centsToEditString(tx.amount_cents)),
        categoryId: tx.category_id || null,
        accountId: tx.account_id || null,
        toAccountId: tx.to_account_id || null,
        tagIds: Array.isArray(tx.tags) ? tx.tags.slice() : [],
        memberId: tx.member_id || (selfMember() || {}).id || null,
        reimburse: tx.reimburse_state === 'pending',
        date: S.dateOf(tx) || todayISO(),
        note: tx.note || '',
        editingId: id,
        saving: false,
      };
      return;
    }
  }
  if (!state.add || state.add.editingId) freshAdd();
}

function catsFor(type) {
  const kind = type === 'income' ? 'income' : 'expense';
  return state.categories.filter((c) => c.kind === kind);
}

function orderedCats(kind) {
  const cats = state.categories.filter((c) => c.kind === kind);
  const recent = S.recentCategoryIds(state.recentTx, kind, 4);
  const byId = new Map(cats.map((c) => [c.id, c]));
  const head = recent.map((id) => byId.get(id)).filter(Boolean);
  const headIds = new Set(head.map((c) => c.id));
  return { head, rest: cats.filter((c) => !headIds.has(c.id)) };
}

function catsSectionHtml() {
  const a = state.add;
  if (a.type === 'transfer') {
    return `<div class="transfer-hint">转账不计入收支，只在两个账户之间移动金额</div>`;
  }
  const kind = a.type === 'income' ? 'income' : 'expense';
  const { head, rest } = orderedCats(kind);
  const cell = (c) => `<button class="cat ${a.categoryId === c.id ? 'is-on' : ''}" data-act="cat" data-id="${esc(c.id)}">
      <span class="cat-icon">${esc(c.icon || '📦')}</span><span class="cat-name">${esc(c.name)}</span></button>`;
  const sep = head.length ? '<div class="cats-sep">最近使用</div>' : '';
  const restSep = head.length && rest.length ? '<div class="cats-sep">全部分类</div>' : '';
  return `<div class="cats" id="cats">${sep}${head.map(cell).join('')}${restSep}${rest.map(cell).join('')}
    <button class="cat is-manage" data-act="nav" data-href="#/me/categories"><span class="cat-icon">⚙️</span><span class="cat-name">管理</span></button>
  </div>`;
}

function accountChips(selectedId, act, { allowNone = false } = {}) {
  if (!state.accounts.length) {
    return `<div class="chip-row"><button class="chip is-ghost" data-act="nav" data-href="#/me/accounts">＋ 先加一个账户</button></div>`;
  }
  const chips = state.accounts
    .map(
      (acc) => `<button class="chip ${selectedId === acc.id ? 'is-on' : ''}" data-act="${act}" data-id="${esc(acc.id)}">
        ${esc(acc.icon || '💳')} ${esc(acc.name)}</button>`,
    )
    .join('');
  const tail = allowNone
    ? `<button class="chip is-ghost" data-act="nav" data-href="#/me/accounts">＋ 管理</button>`
    : '';
  return `<div class="chip-row">${chips}${tail}</div>`;
}

function amountHtml() {
  const a = state.add;
  const display = a.calc.display || '0';
  return `<div class="amount-hint" id="amount-hint">${esc(a.calc.hint || '')}</div>
    <div class="amount-line">
      <span class="amount-cur">¥</span>
      <span class="amount-main ${a.calc.expr ? '' : 'is-empty'}" id="amount-main">${esc(display)}</span>
      <i class="caret" aria-hidden="true"></i>
    </div>`;
}

function syncAmountUI() {
  const a = state.add;
  if (!a) return;
  const main = $('amount-main');
  const hint = $('amount-hint');
  if (main) {
    main.textContent = a.calc.display || '0';
    main.classList.toggle('is-empty', !a.calc.expr);
  }
  if (hint) hint.textContent = a.calc.hint || '';
  const saveBtn = document.querySelector('.key.save');
  if (saveBtn) {
    const cents = a.calc.cents;
    saveBtn.disabled = !(Number.isFinite(cents) && cents > 0);
  }
}

const KEYS = [
  ['7', '8', '9', '÷'],
  ['4', '5', '6', '×'],
  ['1', '2', '3', '-'],
  ['0', '.', '⌫', '+'],
  ['(', ')', '=', 'save'],
];

function keypadHtml() {
  const rows = KEYS.map((row) =>
    row
      .map((k) => {
        if (k === 'save') {
          return `<button class="key save" data-act="save">保存</button>`;
        }
        const cls = k === '=' ? 'eq' : 'op';
        const isOp = ['÷', '×', '-', '+'].includes(k);
        const isFn = ['⌫', '(', ')'].includes(k);
        return `<button class="key ${isOp || k === '=' ? cls : isFn ? 'fn' : ''}" data-act="key" data-key="${esc(k)}">${esc(k)}</button>`;
      })
      .join(''),
  ).join('');
  return `<div class="keypad" id="keypad">${rows}</div>`;
}

function tagChipsHtml() {
  const a = state.add;
  const picked = addTagIds();
  const isExpense = a.type === 'expense';
  const chips = state.tags
    .map(
      (t) => `<button class="tag-chip ${picked.includes(t.id) ? 'is-on' : ''}" data-act="tag-toggle" data-id="${esc(t.id)}"
        style="${picked.includes(t.id) && t.color ? `--tag-c:${esc(t.color)}` : ''}">${esc(t.name)}</button>`,
    )
    .join('');
  return `<div class="tag-row">
    <div class="chip-row tag-chips">
      ${chips}
      <button class="chip is-ghost" data-act="tag-new">＋ 标签</button>
    </div>
    ${isExpense ? `<button class="mini-toggle ${a.reimburse ? 'is-on' : ''}" data-act="reimburse-toggle" aria-pressed="${a.reimburse ? 'true' : 'false'}">
      <i></i><span>待报销</span></button>` : ''}
  </div>`;
}

function renderAddPage() {
  const a = state.add;
  const isTransfer = a.type === 'transfer';
  const seg = (val, label) =>
    `<button class="seg-btn ${a.type === val ? 'is-on' : ''}" data-act="type" data-type="${val}">${label}</button>`;

  return `<div class="page page-add">
    <header class="topbar">
      <div class="seg">${seg('expense', '支出')}${seg('income', '收入')}${seg('transfer', '转账')}</div>
      ${a.editingId ? '<button class="icon-btn" data-act="del-editing" aria-label="删除这笔">🗑</button>' : ''}
      ${ledgerSwitchHtml()}
    </header>
    <section class="amount-box">${amountHtml()}</section>
    <div class="add-body" id="add-body">
      <section id="cats-section">${catsSectionHtml()}</section>
      <section class="acc-section">
        ${isTransfer ? '<div class="cats-sep">从</div>' : ''}
        ${accountChips(a.accountId, 'acc', { allowNone: true })}
        ${isTransfer ? '<div class="cats-sep">到</div>' : ''}
        ${isTransfer ? accountChips(a.toAccountId, 'acc-to', { allowNone: false }) : ''}
      </section>
      <section class="member-section" id="member-section">${memberChipsHtml()}</section>
      <section class="tag-section" id="tag-section">${tagChipsHtml()}</section>
      <section class="meta-row">
        <div class="meta-field"><label for="f-date">日期</label><input id="f-date" type="date" value="${esc(a.date)}" data-field="date"></div>
        <div class="meta-field grow"><label for="f-note">备注</label><input id="f-note" type="text" value="${esc(a.note)}" placeholder="写点什么…" maxlength="60" data-field="note"></div>
      </section>
    </div>
    ${keypadHtml()}
  </div>`;
}

function nextReimburseState(a) {
  const prevTx = a.editingId ? state.recentTx.find((t) => t.id === a.editingId) : null;
  const prev = prevTx ? prevTx.reimburse_state : null;
  if (a.type !== 'expense') return prev || null;
  if (a.reimburse) return prev === 'done' ? 'done' : 'pending';
  return prev === 'done' ? 'done' : null;
}

async function saveTransaction() {
  const a = state.add;
  if (!a || a.saving) return;
  const cents = a.calc.cents;
  if (!Number.isFinite(cents) || cents <= 0) {
    toast('金额要大于 0', 'error');
    return;
  }
  if (!a.accountId) {
    toast('先选一个账户', 'error');
    return;
  }
  if (a.type === 'transfer') {
    if (!a.toAccountId) {
      toast('选转入账户', 'error');
      return;
    }
    if (a.toAccountId === a.accountId) {
      toast('转出和转入不能是同一个账户', 'error');
      return;
    }
  } else if (!a.categoryId) {
    toast('先选一个分类', 'error');
    return;
  }
  a.saving = true;
  try {
    const payload = {
      ledger_id: state.ledgerId,
      type: a.type,
      amount_cents: cents,
      category_id: a.type === 'transfer' ? null : a.categoryId,
      account_id: a.accountId,
      to_account_id: a.type === 'transfer' ? a.toAccountId : null,
      note: a.note || '',
      happened_at: a.date || todayISO(),
      source: 'manual',
      tags: a.type === 'transfer' ? [] : addTagIds().slice(),
      member_id: a.memberId || null,
      reimburse_state: nextReimburseState(a),
    };
    let saved;
    if (a.editingId) {
      saved = await store.updateTransaction(a.editingId, payload);
      toast('已更新这笔记录');
    } else {
      saved = await store.createTransaction({ ...payload, id: uid() });
      toast(`已记一笔 ${fmtMoney(cents)}`);
    }
    state.lastAdd = { type: a.type, categoryId: a.categoryId, accountId: a.accountId, toAccountId: a.toAccountId };
    rememberAccount(a.accountId);
    rememberType(a.type);
    if (a.editingId) {
      state.add = null;
      await loadCore();
      location.hash = '#/list';
      return;
    }
    a.calc.reset();
    a.note = '';
    a.tagIds = [];
    a.reimburse = false;
    a.date = a.date || todayISO();
    if (saved) state.recentTx = [saved, ...state.recentTx].slice(0, 300);
    await loadCore();
    const cats = $('cats-section');
    if (cats) cats.innerHTML = catsSectionHtml();
    const tagSec = $('tag-section');
    if (tagSec) tagSec.innerHTML = tagChipsHtml();
    const noteInput = $('f-note');
    if (noteInput) noteInput.value = '';
    syncAmountUI();
  } catch (err) {
    toast(err && err.message ? err.message : '保存失败', 'error');
  } finally {
    a.saving = false;
  }
}

async function deleteEditing() {
  const a = state.add;
  if (!a || !a.editingId) return;
  const ok = await confirmDialog({ title: '删除这笔记录？', message: '删除后金额会回到账本，操作不可撤销。', confirmText: '删除' });
  if (!ok) return;
  await store.deleteTransaction(a.editingId);
  state.add = null;
  toast('已删除');
  await loadCore();
  location.hash = '#/list';
}

// ------------------------------------------------------------ 明细页

function monthBar() {
  return `<header class="topbar month-bar">
    <button class="icon-btn" data-act="month" data-delta="-1" aria-label="上个月">‹</button>
    <div class="month-title">${S.monthLabel(state.month)}</div>
    <button class="icon-btn" data-act="month" data-delta="1" aria-label="下个月">›</button>
    <button class="icon-btn today-btn" data-act="month-today" aria-label="回到本月">今</button>
  </header>
  <div class="bar-sub">${ledgerSwitchHtml()}</div>`;
}

function activeFilterCount(f) {
  let n = 0;
  if (!f) return 0;
  for (const k of ['type', 'account_id', 'category_id', 'tag_id', 'member_id', 'q']) if (f[k]) n += 1;
  if (f.min_cents != null || f.max_cents != null) n += 1;
  return n;
}

function txFilterObject(f) {
  return {
    type: (f && f.type) || '',
    account_id: (f && f.account_id) || '',
    category_id: (f && f.category_id) || '',
    tag_id: (f && f.tag_id) || '',
    q: (f && f.q) || '',
    min_cents: f && f.min_cents != null ? f.min_cents : null,
    max_cents: f && f.max_cents != null ? f.max_cents : null,
  };
}

function listRange() {
  const f = state.listFilter || {};
  if (f.from && f.to) return { from: f.from, to: f.to };
  return S.monthRange(state.month);
}

function tagById(id) {
  return state.tags.find((t) => t.id === id) || null;
}

function txTagsHtml(tx) {
  const ids = Array.isArray(tx.tags) ? tx.tags : [];
  if (!ids.length) return '';
  return ids
    .map((id) => {
      const t = tagById(id);
      if (!t) return '';
      return `<span class="tx-tag" style="--tag-c:${esc(t.color || '#3eb489')}">${esc(t.name)}</span>`;
    })
    .join('');
}

// ------------------------------------------------------------ v1.3 明细页预算条

const BUDGET_STRIP_KEY = 'mintlite:budget-strip-open';

function readBudgetStripOpen() {
  try {
    return localStorage.getItem(BUDGET_STRIP_KEY) === '1';
  } catch (err) {
    return false;
  }
}

function bsCatHtml(item) {
  const over = Math.round(Number(item.remaining_cents) || 0) < 0;
  const available = Math.round(Number(item.available_cents) || 0);
  const used = Math.round(Number(item.used_cents) || 0);
  const pct = available > 0 ? Math.min(100, Math.round((used / available) * 100)) : 100;
  const cls = item.warn_level === 'over' ? 'is-over' : item.warn_level === 'warn' ? 'is-warn' : '';
  const cat = item.category || {};
  const left = over ? `超支 ¥${fmt(Math.abs(item.remaining_cents))}` : `还剩 ¥${fmt(item.remaining_cents)}`;
  return `<div class="bs-cat ${cls}" data-category-id="${esc(item.category_id)}">
    <span class="bs-cat-ico">${esc(cat.icon || '📦')}</span>
    <span class="bs-cat-name">${esc(cat.name || '未分类')}</span>
    <span class="bs-cat-left">${left}</span>
    <span class="bs-cat-bar"><i style="width:${pct}%"></i></span>
  </div>`;
}

async function budgetStripHtml() {
  const view = await store.budgetUsage(state.ledgerId, todayMonth()).catch(() => null);
  // v1.3.2：预算功能总开关关闭时，明细页连预算条容器都不渲染
  if (!view || !view.enabled) return '';
  // v1.3 口径：没有预算时 warn_level='none'、percent_left=null —— 只出一行入口，不画进度条
  if (!view.has_budget || view.warn_level === 'none' || Number(view.amount_cents) <= 0) {
    return `<section class="budget-strip bs-none" data-block="budget-strip">
      <button class="bs-empty" data-act="budget-strip-go">未设本月预算 ›</button>
    </section>`;
  }
  const used = Math.round(Number(view.used_cents) || 0);
  const available = Math.round(Number(view.available_cents) || 0);
  const remaining = Math.round(Number(view.remaining_cents) || 0);
  const pct = available > 0 ? Math.min(100, Math.round((used / available) * 100)) : 100;
  const over = remaining < 0;
  const cls = view.warn_level === 'over' ? 'is-over' : view.warn_level === 'warn' ? 'is-warn' : '';
  const left = over ? `超支 ¥${fmt(Math.abs(remaining))}` : `还剩 ¥${fmt(remaining)}`;
  const warnText =
    view.warn_level === 'ok' ? '' : `<span class="bs-warn">⚠️ 剩余不足 ${Number(view.warn_percent) || 10}%</span>`;
  const open = readBudgetStripOpen();
  const cats =
    open && view.items.length
      ? `<div class="bs-cats">${view.items.map(bsCatHtml).join('')}</div>`
      : open
        ? '<div class="bs-cats"><p class="hint" style="margin:6px 0 0">本月还没有分类预算，去预算页设一个吧。</p></div>'
        : '';
  return `<section class="budget-strip ${cls}" data-block="budget-strip">
    <div class="bs-head">
      <span class="bs-title">本月预算</span>
      <span class="bs-amount">¥${fmt(view.amount_cents)}</span>
      ${warnText}
      <button class="bs-toggle ${open ? 'is-open' : ''}" data-act="budget-strip-toggle" aria-label="展开预算明细">${open ? '▴' : '▾'}</button>
    </div>
    <div class="bs-sub">已用 ¥${fmt(used)} · <span class="bs-left">${left}</span></div>
    <div class="bs-bar ${over ? 'over' : ''}"><i style="width:${pct}%"></i></div>
    ${cats}
  </section>`;
}

async function renderListPage() {
  const { from, to } = listRange();
  const filters = txFilterObject(state.listFilter);
  const [monthTx, summary] = await Promise.all([
    store.listTransactions({ ledger_id: state.ledgerId, from, to, limit: 500, ...filters }),
    store.summary(state.ledgerId, from, to, filters),
  ]);
  const strip = await budgetStripHtml();
  const groups = S.groupByDay(monthTx.items, from, to);
  const catById = new Map(state.categories.map((c) => [c.id, c]));
  const accById = new Map(state.accounts.map((a) => [a.id, a]));
  const fcount = activeFilterCount(state.listFilter);

  const rowHtml = (tx) => {
    const cat = tx.category_id ? catById.get(tx.category_id) : null;
    const acc = tx.account_id ? accById.get(tx.account_id) : null;
    const toAcc = tx.to_account_id ? accById.get(tx.to_account_id) : null;
    const icon = tx.type === 'transfer' ? '🔁' : tx.type === 'adjust' ? '⚖️' : cat && cat.icon ? cat.icon : '📦';
    const title = tx.type === 'transfer' ? '转账' : tx.type === 'adjust' ? '余额调整' : cat ? cat.name : '未分类';
    const sub =
      tx.type === 'transfer'
        ? `${acc ? acc.name : '?'} → ${toAcc ? toAcc.name : '?'}`
        : `${acc ? acc.name : '无账户'}`;
    const sign = tx.type === 'expense' ? '-' : tx.type === 'income' ? '+' : '';
    const cls = tx.type === 'expense' ? 'expense' : tx.type === 'income' ? 'income' : 'transfer';
    const badge =
      tx.reimburse_state === 'pending'
        ? '<span class="badge warn">待报销</span>'
        : tx.reimburse_state === 'done'
          ? '<span class="badge ok">已报销</span>'
          : '';
    return `<div class="tx-wrap" data-id="${esc(tx.id)}">
      <div class="tx-actions"><button data-act="tx-menu" data-id="${esc(tx.id)}">更多</button></div>
      <div class="tx-row" data-act="open-tx" data-id="${esc(tx.id)}">
        <span class="tx-icon">${esc(icon)}</span>
        <div class="tx-main">
          <div class="tx-title">${esc(title)}${tx.note ? `<span class="tx-note">${esc(tx.note)}</span>` : ''}${tx.is_sample ? '<span class="tag">示例</span>' : ''}${badge}</div>
          <div class="tx-sub">${esc(sub)}${txTagsHtml(tx)}${memberBadgeHtml(tx)}</div>
        </div>
        <div class="tx-amount ${cls}">${sign}${fmt(tx.amount_cents)}</div>
      </div>
    </div>`;
  };

  const body = groups.length
    ? groups
        .map(
          (g) => `<section class="day-group">
          <div class="day-head"><span>${S.dateLabel(g.date)}</span>
            <span class="day-sub">${g.expense_cents ? `支出 ${fmt(g.expense_cents)}` : ''}${g.income_cents ? `${g.expense_cents ? ' · ' : ''}收入 ${fmt(g.income_cents)}` : ''}</span>
          </div>
          ${g.items.map(rowHtml).join('')}
        </section>`,
        )
        .join('')
    : `<div class="empty"><span class="empty-emoji">🍃</span>${fcount ? '没有符合筛选的记录<br>点上面的「筛选」清一下条件' : '这个月还没有记录<br>去「记账」页记一笔吧'}</div>`;

  return `<div class="page">
    ${monthBar()}
    ${strip}
    <div class="filter-bar">
      <button class="filter-btn ${fcount ? 'is-on' : ''}" data-act="filter-open" data-target="list">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg>
        筛选${fcount ? ` ${fcount}` : ''}
      </button>
      ${fcount ? '<button class="filter-btn ghost" data-act="filter-clear" data-target="list">清除</button>' : ''}
      <span class="filter-hint">${esc(from)} ~ ${esc(to)}</span>
    </div>
    <div class="sum-strip">
      <div class="sum-pill expense">支出<b>${fmt(summary.expense_cents)}</b></div>
      <div class="sum-pill income">收入<b>${fmt(summary.income_cents)}</b></div>
      <div class="sum-pill">结余<b>${fmt(summary.balance_cents)}</b></div>
    </div>
    <div class="scroll" id="tx-list">${body}</div>
  </div>`;
}

async function openTxMenu(id) {
  const tx = state.recentTx.find((t) => t.id === id);
  if (!tx) return;
  const label = `${M.formatCents(tx.amount_cents)} 元`;
  const canPending = tx.type === 'expense' && tx.reimburse_state !== 'pending';
  const canDone = tx.type === 'expense' && tx.reimburse_state === 'pending';
  openSheet({
    title: '这笔记录',
    body: `<div class="kv"><span>金额</span><b>${esc(label)}</b></div>
      <div class="kv"><span>备注</span><b>${esc(tx.note || '—')}</b></div>
      <div class="btn-col">
        <button class="btn" data-act="open-tx" data-id="${esc(id)}">编辑</button>
        ${canPending ? `<button class="btn" data-act="tx-mark-pending" data-id="${esc(id)}">标记待报销</button>` : ''}
        ${canDone ? `<button class="btn primary" data-act="tx-do-reimburse" data-id="${esc(id)}">确认报销（生成收入）</button>` : ''}
        <button class="btn danger" data-act="tx-delete" data-id="${esc(id)}">删除</button>
      </div>`,
  });
}

async function markPending(id) {
  await store.updateTransaction(id, { reimburse_state: 'pending' });
  closeSheet();
  toast('已标记待报销');
  await refresh();
}

function openReimburseSheet(id) {
  const tx = state.recentTx.find((t) => t.id === id);
  const accs = state.accounts.map((a) => [a.id, a.name]);
  if (!accs.length) {
    toast('先建一个收款账户', 'error');
    return;
  }
  openForm({
    title: '确认报销',
    intro: `<p class="hint" style="margin-bottom:8px">会把这笔标记为已报销，并生成一条同额收入（备注「报销：${esc(tx ? tx.note || '' : '')}」）。</p>`,
    fields: [
      { key: 'account', label: '收款账户', type: 'select', options: accs },
      { key: 'date', label: '日期', placeholder: todayISO() },
      { key: 'amount', label: '金额（元，可改）', type: 'number', step: '0.01' },
    ],
    values: { account: accs[0][0], date: todayISO(), amount: tx ? M.formatPlain(tx.amount_cents) : '' },
    submitText: '确认报销',
    onSubmit: async (v) => {
      const cents = M.parseCents(v.amount || '0');
      await store.reimburse(id, { accountId: v.account, date: v.date || todayISO(), amountCents: cents > 0 ? cents : undefined });
      closeSheet();
      toast('已确认报销并生成收入');
      await refresh();
    },
  });
}

function bindSwipe(container) {
  if (!container) return;
  let row = null;
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let moved = false;
  let timer = 0;

  const reset = (target) => {
    if (target) {
      target.classList.remove('dragging');
      target.style.transform = '';
    }
  };

  container.addEventListener('pointerdown', (e) => {
    const target = e.target.closest('.tx-row');
    if (!target) return;
    row = target;
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
    moved = false;
    if (timer) clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = 0;
      if (!moved && row) {
        suppressClickUntil = Date.now() + 700;
        const id = row.dataset.id;
        reset(row);
        row = null;
        openTxMenu(id);
      }
    }, 550);
  });

  container.addEventListener('pointermove', (e) => {
    if (!row) return;
    dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
      moved = true;
      if (timer) {
        clearTimeout(timer);
        timer = 0;
      }
      row.classList.add('dragging');
    }
    if (moved) {
      const base = row.classList.contains('is-swiped') ? -78 : 0;
      const next = Math.max(-88, Math.min(0, base + dx));
      row.style.transform = `translateX(${next}px)`;
      if (Math.abs(dx) > 12) suppressClickUntil = Date.now() + 250;
    }
  });

  const finish = () => {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    if (!row) return;
    const target = row;
    const swiped = target.classList.contains('is-swiped');
    const shouldOpen = dx < -46 || (swiped && dx < 20);
    target.classList.remove('dragging');
    target.style.transform = '';
    target.classList.toggle('is-swiped', shouldOpen);
    if (moved) suppressClickUntil = Date.now() + 320;
    row = null;
    dx = 0;
  };

  container.addEventListener('pointerup', finish);
  container.addEventListener('pointercancel', finish);
  container.addEventListener('pointerleave', (e) => {
    if (row && e.buttons === 0) finish();
  });
}

async function askDeleteTx(id) {
  const tx = state.recentTx.find((t) => t.id === id);
  const label = tx ? `${M.formatCents(tx.amount_cents)} 元` : '这笔记录';
  const ok = await confirmDialog({
    title: '删除记录',
    message: `确定删除 ${label} 吗？删除后相关账户余额会一并回退。`,
    confirmText: '删除',
  });
  if (!ok) return;
  await store.deleteTransaction(id);
  toast('已删除');
  await refresh();
}

// ------------------------------------------------------------ 报表页

function donutCss(items) {
  const total = items.reduce((s, it) => s + it.amount_cents, 0);
  if (!total) return 'background: var(--line)';
  let acc = 0;
  const stops = items.map((it, i) => {
    const from = acc;
    acc += it.ratio;
    const to = i === items.length - 1 ? 1 : acc;
    return `${PALETTE[i % PALETTE.length]} ${(from * 100).toFixed(2)}% ${(to * 100).toFixed(2)}%`;
  });
  return `background: conic-gradient(${stops.join(', ')})`;
}

function bucketLabel(bucket, granularity) {
  const s = String(bucket || '');
  if (granularity === 'month') return `${Number(s.slice(5, 7)) || ''}月`;
  return s.slice(5, 10);
}

function trendSvg(buckets, mode = 'bars', granularity = 'day', width = 320, height = 116) {
  const n = buckets.length;
  if (!n) return '<div class="chart-empty">这个月还没有数据</div>';
  const series = mode === 'line' ? 'income_cents' : 'expense_cents';
  const max = Math.max(1, ...buckets.map((b) => b[series]));
  if (max <= 1) return '<div class="chart-empty">这个月还没有数据</div>';
  const padL = 4;
  const padR = 4;
  const padT = 10;
  const padB = 16;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const step = innerW / n;
  const barW = Math.max(1.6, Math.min(12, step * 0.62));
  const bars =
    mode === 'line'
      ? ''
      : buckets
          .map((b, i) => {
            const h = (b.expense_cents / max) * innerH;
            const x = padL + step * i + (step - barW) / 2;
            const y = padT + innerH - h;
            if (h <= 0) return '';
            // 有值但金额很小的时候至少留 1.2px，否则整天在图上「消失」
            return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1.2, h).toFixed(1)}" rx="1.6" fill="var(--mint)" opacity="0.9"/>`;
          })
          .join('');
  const points = buckets
    .map((b, i) => {
      const x = padL + step * i + step / 2;
      const y = padT + innerH - (b.income_cents / max) * innerH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const line =
    mode === 'line'
      ? `<polyline points="${points}" fill="none" stroke="var(--income)" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" opacity="0.95"/>`
      : '';
  const labelEvery = Math.max(1, Math.ceil(n / 6));
  const labels = buckets
    .map((b, i) => {
      if (i % labelEvery !== 0 && i !== n - 1) return '';
      const x = padL + step * i + step / 2;
      return `<text class="axis-label" x="${x.toFixed(1)}" y="${height - 5}" text-anchor="middle">${esc(bucketLabel(b.bucket, granularity))}</text>`;
    })
    .join('');
  return `<svg class="trend-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${
    mode === 'line' ? '收入折线' : '支出柱状图'
  }">
    <line x1="${padL}" y1="${padT + innerH}" x2="${width - padR}" y2="${padT + innerH}" stroke="var(--line)" stroke-width="1"/>
    ${bars}
    ${line}
    ${labels}
  </svg>`;
}

const REPORT_PRESETS = [
  ['month', '本月'],
  ['lastmonth', '上月'],
  ['d30', '近30天'],
  ['year', '今年'],
  ['custom', '自定义'],
];

function reportRange() {
  const r = state.report;
  const preset = r.preset || 'month';
  if (preset === 'custom') {
    return { from: r.from || S.monthRange(S.currentMonth()).from, to: r.to || S.todayISO(), preset };
  }
  if (preset === 'lastmonth') {
    const m = S.addMonths(S.currentMonth(), -1);
    return { ...S.monthRange(m), preset };
  }
  if (preset === 'd30') return { from: S.addDays(S.todayISO(), -29), to: S.todayISO(), preset };
  if (preset === 'year') {
    const y = S.currentMonth().slice(0, 4);
    return { from: `${y}-01-01`, to: `${y}-12-31`, preset };
  }
  return { ...S.monthRange(S.currentMonth()), preset: 'month' };
}

function reportFilters() {
  return txFilterObject(state.report);
}

function presetChips() {
  return `<div class="chip-row preset-chips">
    ${REPORT_PRESETS.map(
      ([v, label]) =>
        `<button class="chip ${state.report.preset === v ? 'is-on' : ''}" data-act="report-preset" data-preset="${v}">${label}</button>`,
    ).join('')}
  </div>`;
}

function openFilterSheet(target) {
  const f = target === 'report' ? state.report : state.listFilter;
  const types = [
    ['', '全部类型'],
    ['expense', '支出'],
    ['income', '收入'],
    ['transfer', '转账'],
    ['adjust', '余额调整'],
  ];
  const accs = [['', '全部账户'], ...state.accounts.map((a) => [a.id, `${a.icon || '💳'} ${a.name}`])];
  const cats = [['', '全部分类'], ...state.categories.map((c) => [c.id, `${c.icon || '📦'} ${c.name}`])];
  const tags = [['', '全部标签'], ...state.tags.map((t) => [t.id, t.name])];
  const members = [['', '全部成员'], ...memberList().map((m) => [m.id, m.name])];
  openForm({
    title: '筛选',
    wide: true,
    fields: [
      { key: 'type', label: '类型', type: 'select', options: types },
      { key: 'account', label: '账户', type: 'select', options: accs },
      { key: 'category', label: '分类', type: 'select', options: cats },
      { key: 'tag', label: '标签', type: 'select', options: tags },
      { key: 'member', label: '成员', type: 'select', options: members },
      { key: 'q', label: '关键词（备注包含）', placeholder: '例如 房租' },
      { key: 'min', label: '金额下限（元）', type: 'number', step: '0.01', min: '0' },
      { key: 'max', label: '金额上限（元）', type: 'number', step: '0.01', min: '0' },
      { key: 'from', label: '开始日期（YYYY-MM-DD，报表自动切「自定义」）', placeholder: '2026-11-01' },
      { key: 'to', label: '结束日期', placeholder: S.todayISO() },
    ],
    values: {
      type: f.type || '',
      account: f.account_id || '',
      category: f.category_id || '',
      tag: f.tag_id || '',
      member: f.member_id || '',
      q: f.q || '',
      min: f.min_cents != null ? M.formatPlain(f.min_cents) : '',
      max: f.max_cents != null ? M.formatPlain(f.max_cents) : '',
      from: f.from || '',
      to: f.to || '',
    },
    submitText: '应用筛选',
    onSubmit: async (v) => {
      const minCents = v.min ? M.parseCents(v.min) : null;
      const maxCents = v.max ? M.parseCents(v.max) : null;
      if (minCents != null && Number.isNaN(minCents)) throw new Error('金额下限不对');
      if (maxCents != null && Number.isNaN(maxCents)) throw new Error('金额上限不对');
      const next = {
        type: v.type || '',
        account_id: v.account || '',
        category_id: v.category || '',
        tag_id: v.tag || '',
        member_id: v.member || '',
        q: v.q || '',
        min_cents: minCents,
        max_cents: maxCents,
      };
      if (target === 'report') {
        Object.assign(state.report, next);
        if (v.from && v.to) {
          state.report.from = v.from;
          state.report.to = v.to;
          state.report.preset = 'custom';
        }
      } else {
        Object.assign(state.listFilter, next);
        if (v.from && v.to) {
          state.listFilter.from = v.from;
          state.listFilter.to = v.to;
        }
      }
      closeSheet();
      await route();
    },
  });
}

function overviewCardHtml(ov, range) {
  return `<section class="card overview-card">
    <h3>概览 <span class="hint-small">${esc(range.from)} ~ ${esc(range.to)}</span></h3>
    <div class="ov-grid">
      <div class="ov-cell"><span>收入</span><b class="income">¥${fmt(ov.income_cents)}</b></div>
      <div class="ov-cell"><span>支出</span><b class="expense">¥${fmt(ov.expense_cents)}</b></div>
      <div class="ov-cell"><span>净额</span><b class="${ov.net_cents < 0 ? 'expense' : 'income'}">${ov.net_cents < 0 ? '-' : ''}¥${fmt(Math.abs(ov.net_cents))}</b></div>
    </div>
    <div class="ov-mini">
      <span>日均支出 <b>¥${fmt(ov.avg_expense_cents)}</b></span>
      <span>最大单笔 <b>¥${fmt(ov.max_expense_cents)}</b>${ov.max_expense_note ? `<i>${esc(ov.max_expense_note)}</i>` : ''}</span>
      <span>笔数 <b>${ov.count}</b></span>
      <span>覆盖 <b>${ov.days}</b> 天</span>
    </div>
  </section>`;
}

function compareRowsHtml(cmp) {
  const row = (label, cur, prev, pctVal, better = 'down', money = true) => {
    const up = cur > prev;
    const flat = cur === prev;
    const good = better === 'down' ? !up : up;
    const cls = flat ? 'flat' : good ? 'down' : 'up';
    const arrow = flat ? '→' : up ? '↑' : '↓';
    const pctText = pctVal == null ? '—' : `${pctVal > 0 ? '+' : ''}${Number(pctVal).toFixed(1)}%`;
    return `<div class="cmp-row">
      <span class="cmp-name">${label}</span>
      <span class="cmp-val ${money ? 'num' : ''}">${money ? `¥${fmt(cur)}` : cur}</span>
      <span class="cmp-delta ${cls}">${arrow} ${pctText}</span>
    </div>`;
  };
  return `<div class="cmp">
    <div class="cmp-head"><span>本期</span><span>上期</span></div>
    ${row('支出', cmp.current.expense_cents, cmp.previous.expense_cents, cmp.delta.expense_pct, 'down')}
    ${row('收入', cmp.current.income_cents, cmp.previous.income_cents, cmp.delta.income_pct, 'up')}
    <div class="cmp-row">
      <span class="cmp-name">净额</span>
      <span class="cmp-val num">${cmp.delta.net_cents < 0 ? '-' : '+'}¥${fmt(Math.abs(cmp.delta.net_cents))}</span>
      <span class="cmp-delta ${cmp.delta.net_cents >= 0 ? 'down' : 'up'}">${cmp.delta.net_cents >= 0 ? '↑' : '↓'} 较上期</span>
    </div>
    <p class="hint">上期 = 与本期间等长的前一段时间（${esc(String(cmp.previous_range ? cmp.previous_range.from : '') || '自动')} 起）。</p>
  </div>`;
}

function calendarHeatHtml(days, month) {
  if (!month) return '';
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const total = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const offset = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const byDate = new Map((days || []).map((d) => [String(d.date).slice(0, 10), d]));
  const max = Math.max(1, ...(days || []).map((d) => d.expense_cents));
  const cells = [];
  for (let i = 0; i < offset; i += 1) cells.push('<i class="cal-cell is-blank"></i>');
  for (let d = 1; d <= total; d += 1) {
    const iso = `${month}-${String(d).padStart(2, '0')}`;
    const row = byDate.get(iso);
    const val = row ? row.expense_cents : 0;
    const lvl = val <= 0 ? 0 : Math.min(4, 1 + Math.floor((val / max) * 3.999));
    cells.push(
      `<i class="cal-cell lvl${lvl}" title="${iso} 支出 ¥${fmt(val)}${row && row.income_cents ? ` · 收入 ¥${fmt(row.income_cents)}` : ''}"><span>${d}</span></i>`,
    );
  }
  return `<div class="cal">
    <div class="cal-week"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>
    <div class="cal-grid">${cells.join('')}</div>
    <div class="cal-legend"><span>少</span><i class="cal-cell lvl0"></i><i class="cal-cell lvl1"></i><i class="cal-cell lvl2"></i><i class="cal-cell lvl3"></i><i class="cal-cell lvl4"></i><span>多</span></div>
  </div>`;
}

// ------------------------------------------------------------ v1.2：报表页

function donutWithLabelsHtml(items) {
  const rows = items.filter((i) => Number(i.amount_cents) > 0);
  const total = rows.reduce((s, i) => s + Number(i.amount_cents), 0);
  const size = 176;
  const cx = size / 2;
  const cy = size / 2;
  const ring = 128; // .donut 的实际直径（CSS），标签半径必须按它算，否则标签会飘到环外或压进环里
  const rOuter = ring / 2;
  const rMark = rOuter + 16; // 标签基准半径：贴着环外 16px
  const rLine0 = rOuter + 2; // 引线起点：环边缘外 2px
  const minX = 4;
  const maxX = size - 4;
  const minY = 12;
  const maxY = size - 12;
  const textW = 34; // 9.5px 下 "100.0%" 的近似宽度（用户单位），用于防止文字出框
  const textH = 14;
  let acc = 0;
  const marks = [];
  rows.forEach((it, idx) => {
    const amt = Number(it.amount_cents);
    const pctVal = total > 0 ? (amt / total) * 100 : 0;
    const start = acc / (total || 1);
    acc += amt;
    if (pctVal < 5) return;
    const mid = (start + pctVal / 200) * Math.PI * 2 - Math.PI / 2;
    const cos = Math.cos(mid);
    const sin = Math.sin(mid);
    const right = cos >= 0;
    let bx = cx + cos * rMark;
    let by = cy + sin * rMark;
    by = Math.min(maxY, Math.max(minY, by));
    bx = right ? Math.min(maxX - textW, Math.max(minX, bx)) : Math.max(minX + textW, Math.min(maxX, bx));
    marks.push({
      ax: cx + cos * rLine0,
      ay: cy + sin * rLine0,
      bx,
      by,
      right,
      pctVal,
      color: PALETTE[idx % PALETTE.length],
    });
  });
  // 扇区多时标签会挤在一起：按 y 排序后逐个下推，再从下往上回压，保证全部落在框内
  if (marks.length >= 8) {
    marks.sort((a, b) => a.by - b.by);
    for (let i = 1; i < marks.length; i += 1) {
      if (marks[i].by - marks[i - 1].by < textH) marks[i].by = marks[i - 1].by + textH;
    }
    let limit = maxY;
    for (let i = marks.length - 1; i >= 0; i -= 1) {
      marks[i].by = Math.min(marks[i].by, limit);
      limit = marks[i].by - textH;
    }
    marks.forEach((m) => {
      m.by = Math.max(minY, m.by);
    });
  }
  const labels = marks
    .map((m) => {
      const text = `${m.pctVal >= 10 ? m.pctVal.toFixed(0) : m.pctVal.toFixed(1)}%`;
      return `<g class="dl">
        <line x1="${m.ax.toFixed(1)}" y1="${m.ay.toFixed(1)}" x2="${m.bx.toFixed(1)}" y2="${m.by.toFixed(1)}" stroke="${m.color}" stroke-width="1.2"/>
        <text x="${(m.bx + (m.right ? 2 : -2)).toFixed(1)}" y="${m.by.toFixed(1)}" text-anchor="${m.right ? 'start' : 'end'}" dominant-baseline="middle" fill="${m.color}">${text}</text>
      </g>`;
    })
    .join('');
  // 标签 svg 是 264×264、left/top -44 的覆盖层：viewBox 必须也是 -44..220，
  // 这样 1 用户单位 = 1 CSS px，标签半径才和环形图对齐（用 20 会把半径压到 81%，标签压进环里）。
  const pad = 44;
  return `<div class="donut-wrap">
    <div class="donut" style="${donutCss(rows)}"></div>
    <div class="donut-hole"><span>${fmt(total)}</span><i>合计</i></div>
    <svg class="donut-labels" viewBox="${-pad} ${-pad} ${size + pad * 2} ${size + pad * 2}" aria-hidden="true">${labels}</svg>
  </div>`;
}

function monthlyBarsHtml(series) {
  const rows = (series || []).slice(-12);
  if (!rows.length) return '<div class="chart-empty">还没有月度数据</div>';
  const max = Math.max(1, ...rows.map((r) => Math.max(Number(r.expense_cents) || 0, Number(r.income_cents) || 0)));
  const w = 320;
  const h = 130;
  const padB = 18;
  const n = rows.length;
  const slot = w / n;
  const barW = Math.max(6, slot * 0.26);
  const bars = rows
    .map((r, i) => {
      const exp = Number(r.expense_cents) || 0;
      const inc = Number(r.income_cents) || 0;
      const hE = Math.max(exp > 0 ? 2 : 0, (exp / max) * (h - padB - 6));
      const hI = Math.max(inc > 0 ? 2 : 0, (inc / max) * (h - padB - 6));
      const xE = i * slot + slot / 2 - barW - 1;
      const xI = i * slot + slot / 2 + 1;
      const label = String(r.month || '').slice(5) + '月';
      return `<g class="bar" data-month="${esc(r.month || '')}">
        <rect class="bar-seg expense" x="${xE.toFixed(1)}" y="${(h - padB - hE).toFixed(1)}" width="${barW.toFixed(1)}" height="${hE.toFixed(1)}" rx="2" fill="var(--expense)"/>
        <rect class="bar-seg income" x="${xI.toFixed(1)}" y="${(h - padB - hI).toFixed(1)}" width="${barW.toFixed(1)}" height="${hI.toFixed(1)}" rx="2" fill="var(--income)"/>
        <text class="axis-label" x="${(i * slot + slot / 2).toFixed(1)}" y="${h - 4}" text-anchor="middle">${esc(label)}</text>
      </g>`;
    })
    .join('');
  return `<svg class="monthly-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="近 12 个月收支柱状图">${bars}</svg>`;
}

function memberBlockHtml(rows) {
  const list = (rows || []).filter((r) => Number(r.expense_cents) > 0 || Number(r.income_cents) > 0);
  const maxExp = Math.max(1, ...list.map((r) => Number(r.expense_cents) || 0));
  const body = list.length
    ? list
        .map(
          (r) => `<li class="mb-row">
        <span class="mb-dot" style="background:${esc(r.color || '#8b7bd8')}"></span>
        <span class="mb-name">${esc(r.member_name || '我')}</span>
        <span class="mb-bar"><i style="width:${((Number(r.expense_cents) || 0) / maxExp * 100).toFixed(1)}%;background:${esc(r.color || '#8b7bd8')}"></i></span>
        <span class="mb-val">${fmt(Number(r.expense_cents) || 0)}</span>
      </li>`,
        )
        .join('')
    : '<li class="empty small">这段时间还没有按成员的数据</li>';
  return `<section class="card" data-block="by-member" id="rp-member">
    <h3 class="card-h">成员分布 <span class="h-s">按支出</span></h3>
    <ul class="mb-list">${body}</ul>
  </section>`;
}

function reportNavHtml() {
  const items = [
    ['rp-overview', '概览'],
    ['rp-donut', '占比'],
    ['rp-trend', '趋势'],
    ['rp-compare', '环比'],
    ['rp-calendar', '日历'],
    ['rp-member', '成员'],
    ['rp-monthly', '月度'],
  ];
  return `<nav class="rp-nav">${items
    .map(([id, label]) => `<button class="rp-nav-btn" data-act="report-anchor" data-target="${id}">${label}</button>`)
    .join('')}</nav>`;
}

async function renderReportPage() {
  const range = reportRange();
  const filters = reportFilters();
  const kind = state.report.donutKind === 'income' ? 'income' : 'expense';
  const granularity = state.report.granularity || 'day';
  const series = state.report.series === 'income' ? 'income' : 'expense';

  const [ov, cmp, buckets, days] = await Promise.all([
    store.statsOverview(state.ledgerId, range.from, range.to, filters).catch(() => null),
    store.statsCompare(state.ledgerId, range.from, range.to, filters).catch(() => null),
    store.trend(state.ledgerId, range.from, range.to, granularity, filters).catch(() => []),
    store.statsCalendar(state.ledgerId, range.to.slice(0, 7), filters).catch(() => []),
  ]);

  let slices = [];
  let donutTitle = '分类占比';
  if (state.report.donut === 'account') {
    donutTitle = '账户占比';
    slices = await store.statsByAccount(state.ledgerId, range.from, range.to, kind, filters).catch(() => []);
  } else if (state.report.donut === 'tag') {
    donutTitle = '标签占比';
    slices = await store.statsByTag(state.ledgerId, range.from, range.to, filters).catch(() => []);
  } else {
    slices = await store.byCategory(state.ledgerId, range.from, range.to, kind, filters).catch(() => []);
  }
  slices = (slices || []).filter((s) => Number(s.amount_cents) > 0);
  const collapsed = S.collapseOthers(slices, 8);
  const top = collapsed.rest ? [...collapsed.top, collapsed.rest] : collapsed.top;
  const totalSlices = top.reduce((s, i) => s + Number(i.amount_cents), 0);
  const monthly = state.monthly && state.monthly.length ? state.monthly : await store.statsMonthly(state.ledgerId, 12).catch(() => []);
  const members = (ov && ov.by_member) || [];

  const rankRows = top
    .map((it, idx) => {
      const pctVal = totalSlices > 0 ? (Number(it.amount_cents) / totalSlices) * 100 : 0;
      const color = PALETTE[idx % PALETTE.length];
      return `<li>
        <span class="rk-dot" style="background:${color}"></span>
        <span class="rk-name">${esc(it.name || it.tag_name || '未分类')}</span>
        <span class="rk-bar"><i style="width:${pctVal.toFixed(1)}%;background:${color}"></i></span>
        <span class="rk-val">${fmt(Number(it.amount_cents) || 0)}</span>
        <span class="rk-pct">${pctVal.toFixed(1)}%</span>
      </li>`;
    })
    .join('');

  const topMembers = (ov && ov.by_member_top) || [];

  return `<div class="page page-report">
    <header class="topbar report-bar">
      <div class="tb-left">${ledgerSwitchHtml()}</div>
      <h1>报表</h1>
      <div class="topbar-tools">
        <button class="icon-btn filter-btn ${activeFilterCount(filters) ? 'is-on' : ''}" data-act="filter-open" data-target="report" aria-label="筛选">
          <span aria-hidden="true">⚙</span>${activeFilterCount(filters) ? `<i class="fb-dot">${activeFilterCount(filters)}</i>` : ''}
        </button>
      </div>
    </header>
    <div class="scroll" id="report-scroll">
      <div class="preset-wrap">${presetChips()}</div>
      ${reportNavHtml()}

      <div id="rp-overview">${overviewCardHtml(ov || {}, range)}</div>
      ${topMembers.length ? `<div class="top-members"><span class="tm-label">成员</span>${topMembers.map((m) => `<span class="tm-chip" style="--member-c:${esc(m.color || '#8b7bd8')}">${esc(m.name)} ${fmt(m.expense_cents)}</span>`).join('')}</div>` : ''}

      <section class="card" id="rp-donut">
        <div class="card-head">
          <h3 class="card-h">${donutTitle}</h3>
          <div class="mini-seg">
            <button class="${state.report.donut === 'category' ? 'is-on' : ''}" data-act="report-donut" data-donut="category">分类</button>
            <button class="${state.report.donut === 'account' ? 'is-on' : ''}" data-act="report-donut" data-donut="account">账户</button>
            <button class="${state.report.donut === 'tag' ? 'is-on' : ''}" data-act="report-donut" data-donut="tag">标签</button>
          </div>
        </div>
        ${state.report.donut !== 'tag'
          ? `<div class="mini-seg kind-seg">
              <button class="${kind === 'expense' ? 'is-on' : ''}" data-act="report-donut-kind" data-donutkind="expense">支出</button>
              <button class="${kind === 'income' ? 'is-on' : ''}" data-act="report-donut-kind" data-donutkind="income">收入</button>
            </div>`
          : ''}
        ${totalSlices > 0 ? `${donutWithLabelsHtml(top)}<ul class="rank">${rankRows}</ul>` : '<div class="chart-empty">这段时间还没有数据</div>'}
      </section>

      <section class="card" id="rp-trend">
        <div class="card-head">
          <h3 class="card-h">收支趋势</h3>
          <div class="mini-seg">
            <button class="${granularity === 'day' ? 'is-on' : ''}" data-act="report-granularity" data-granularity="day">日</button>
            <button class="${granularity === 'week' ? 'is-on' : ''}" data-act="report-granularity" data-granularity="week">周</button>
            <button class="${granularity === 'month' ? 'is-on' : ''}" data-act="report-granularity" data-granularity="month">月</button>
          </div>
        </div>
        <div class="mini-seg series-seg">
          <button class="${series === 'expense' ? 'is-on' : ''}" data-act="report-series" data-series="expense">支出</button>
          <button class="${series === 'income' ? 'is-on' : ''}" data-act="report-series" data-series="income">收入</button>
        </div>
        ${trendSvg(buckets, series === 'income' ? 'line' : 'bars', granularity)}
      </section>

      <section class="card" id="rp-compare">
        <h3 class="card-h">环比上期</h3>
        ${compareRowsHtml(cmp)}
      </section>

      <section class="card" id="rp-calendar">
        <h3 class="card-h">日历热力 <span class="h-s">${esc(range.to.slice(0, 7))}</span></h3>
        ${calendarHeatHtml(days, range.to.slice(0, 7))}
      </section>

      ${memberBlockHtml(members)}

      <section class="card" data-block="monthly" id="rp-monthly">
        <h3 class="card-h">月度收支 <span class="h-s">近 12 个月</span></h3>
        ${monthlyBarsHtml(monthly)}
        <div class="legend-inline"><span class="li expense">支出</span><span class="li income">收入</span></div>
      </section>
    </div>
  </div>`;
}
function cellHtml({ act = 'nav', href = '', icon = '', label = '', value = '', arrow = true, danger = false }) {
  return `<button class="cell ${danger ? 'danger' : ''}" data-act="${act}" ${href ? `data-href="${href}"` : ''}>
    <span class="c-ico">${icon}</span><span>${esc(label)}</span>
    <span class="c-val">${esc(value)}</span>${arrow ? '<span class="c-arrow">›</span>' : ''}
  </button>`;
}

async function renderMePage() {
  const s = getSettings();
  const sampleCount = state.recentTx.filter((t) => t.is_sample).length;
  const month = todayMonth();
  const budgetView = await store.budgetUsage(state.ledgerId, month).catch(() => null);
  const budgetLeft =
    budgetView && budgetView.enabled
      ? budgetView.has_budget
        ? `${budgetView.warn_level !== 'ok' ? '⚠️ ' : ''}本月还剩 ${budgetView.remaining_cents < 0 ? '-' : ''}¥${fmt(Math.abs(budgetView.remaining_cents))}`
        : '未设置'
      : '未开启';
  const modeLabel = store.mode === 'server' ? '服务器' : '本地';
  const accCount = state.accounts.length;
  const catCount = state.categories.length;
  const assets = state.assets || (await store.listAssets(state.ledgerId).catch(() => null));
  const net = assets ? assets.totals.net_cents : 0;
  const pendingReimburse = state.recentTx.filter((t) => t.reimburse_state === 'pending').length;

  return `<div class="page">
    <div class="profile">
      <div class="avatar">🌿</div>
      <div>
        <div class="profile-name">${esc(state.ledger ? state.ledger.name : '丁点记账')}</div>
        <div class="profile-sub">v${VERSION} · ${modeLabel}模式 · ${accCount} 账户 / ${catCount} 分类</div>
        <div class="profile-net">净资产 <b>${net < 0 ? '-' : ''}¥${fmt(Math.abs(net))}</b></div>
      </div>
    </div>
    <div class="scroll">
      <div class="cells">
        ${cellHtml({ href: '#/assets', icon: '🏦', label: '资产', value: `${KIND_LABEL.asset} ${accCount} 个` })}
        ${cellHtml({ href: '#/recurring', icon: '🔁', label: '周期记账', value: state.recurring.length ? `${state.recurring.length} 条` : '未设置' })}
        ${cellHtml({ href: '#/tags', icon: '🏷️', label: '标签', value: `${state.tags.length} 个` })}
        ${cellHtml({ href: '#/me/budgets', icon: '🎯', label: '预算', value: budgetLeft })}
      </div>
      <div class="cells">
        ${cellHtml({ href: '#/me/categories', icon: '📚', label: '分类管理', value: catCount + ' 个' })}
        ${cellHtml({ href: '#/me/members', icon: '👥', label: '成员', value: state.members.length + ' 位' })}
        ${cellHtml({ href: '#/me/ledgers', icon: '📒', label: '账本管理', value: state.ledgers.length + ' 本' })}
        ${cellHtml({ href: '#/me/data', icon: '💾', label: '数据导入导出', value: sampleCount ? `${sampleCount} 条示例` : 'JSON / CSV' })}
        ${cellHtml({ href: '#/me/sync', icon: '☁️', label: '云同步设置', value: s.mode === 'server' ? '已开启' : '本地' })}
        ${cellHtml({ href: '#/me/about', icon: 'ℹ️', label: '关于', value: 'v' + VERSION })}
      </div>
      ${pendingReimburse ? `<p class="hint" style="padding:4px 18px 0">有 <b>${pendingReimburse}</b> 笔待报销，去「明细」长按记录可以确认报销。</p>` : ''}
      <p class="hint" style="text-align:center;padding:0 24px 20px">数据默认只存在这台设备的 IndexedDB 里，断网也能记账。</p>
    </div>
  </div>`;
}

function subHeader(title, backHref = '#/me') {
  return `<header class="topbar">
    <button class="icon-btn" data-act="nav" data-href="${backHref}" aria-label="返回">‹</button>
    <h1>${esc(title)}</h1>
  </header>`;
}

async function renderLedgersPage() {
  const rows = state.ledgers
    .map(
      (l) => `<div class="row-item ${l.id === state.ledgerId ? 'is-current' : ''}">
      <span class="r-ico">📒</span>
      <div class="r-main">
        <div class="r-name">${esc(l.name)}${l.id === state.ledgerId ? '<span class="tag">当前</span>' : ''}</div>
        <div class="r-sub">${esc(l.currency || 'CNY')} · 创建于 ${esc(String(l.created_at || '').slice(0, 10))}</div>
      </div>
      <div class="r-tools">
        ${l.id === state.ledgerId ? '' : `<button class="mini-btn" data-act="ledger-switch" data-id="${esc(l.id)}">切换</button>`}
        <button class="mini-btn" data-act="ledger-edit" data-id="${esc(l.id)}">改名</button>
        <button class="mini-btn danger" data-act="ledger-del" data-id="${esc(l.id)}">删除</button>
      </div>
    </div>`,
    )
    .join('');

  return `<div class="page">
    ${subHeader('账本管理')}
    <div class="scroll">
      <p class="hint" style="padding:10px 18px 0">账本是数据隔离边界：账户、分类、交易、预算各自独立。</p>
      <div class="row-list" style="margin-top:10px">${rows || '<div class="empty">还没有账本</div>'}</div>
      <button class="add-row" data-act="ledger-add">＋ 新建账本</button>
    </div>
  </div>`;
}

// ------------------------------------------------------------ v1.2：资产页

function pageHeader(title, extra = '') {
  return `<header class="topbar">
    <button class="icon-btn" data-act="nav" data-href="#/me" aria-label="返回">‹</button>
    <h1>${esc(title)}</h1>
    <div class="topbar-tools">${extra}</div>
  </header>`;
}

function assetRowHtml(a) {
  const typeLabel = TYPE_LABEL[a.type] || a.type;
  const showType = String(typeLabel) !== String(a.name || '');
  const isCredit = a.type === 'credit';
  const limit = Number(a.credit_limit_cents) || 0;
  const used = Number(a.used_cents) || 0;
  const showBar = isCredit && limit > 0;
  const barPct = showBar ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0;
  const sub = showBar
    ? `额度 ${fmt(limit)} · 已用 ${fmt(used)}`
    : Number(a.include_in_net) === 0
      ? '不计入净值'
      : `初始 ${fmt(Number(a.initial_cents) || 0)}`;
  return `<div class="asset-row" data-account-id="${esc(a.id)}" data-act="asset-edit" data-id="${esc(a.id)}" role="button" tabindex="0">
    <span class="a-ico">${esc(a.icon || '💳')}</span>
    <span class="a-main">
      <span class="a-name">${esc(a.name)}${showType ? `<span class="type-chip">${esc(typeLabel)}</span>` : ''}</span>
      <span class="a-sub">${esc(sub)}</span>
      ${showBar ? `<span class="a-bar"><i style="width:${barPct.toFixed(1)}%"></i></span>` : ''}
    </span>
    <span class="a-amt ${Number(a.balance_cents) < 0 ? 'neg' : ''}">${fmt(Number(a.balance_cents) || 0)}</span>
  </div>`;
}

function assetGroupHtml(group, ui, forceShow = false) {
  const rows = group.items || [];
  const collapsed = ui.collapsed.includes(group.key) && !forceShow;
  const shown = collapsed
    ? ''
    : rows
        .filter((a) => forceShow || !ui.hidden.includes(a.group || group.key))
        .map((a) => assetRowHtml(a))
        .join('');
  return `<section class="card asset-group ${collapsed ? 'is-collapsed' : ''}" data-group="${esc(group.key)}">
    <header class="group-head">
      <button class="gh-toggle" data-act="asset-group-toggle" data-key="${esc(group.key)}" aria-expanded="${collapsed ? 'false' : 'true'}">
        <span class="gh-title">${esc(group.title)}</span>
        <span class="gh-count">${group.count}</span>
        <span class="gh-sum ${group.liability ? 'neg' : ''}">${fmt(group.subtotal_cents)}</span>
        <i class="gh-caret" aria-hidden="true"></i>
      </button>
      <button class="gh-eye" data-act="asset-group-hide" data-key="${esc(group.key)}" aria-label="隐藏${esc(group.title)}">👁</button>
    </header>
    <div class="group-body">${collapsed ? '' : shown || '<div class="empty small">该组暂无账户</div>'}</div>
  </section>`;
}

function remindersHtml(items) {
  if (!items || !items.length) return '';
  const rows = items
    .map((r) => {
      const tone = r.status === 'overdue' ? 'overdue' : r.status === 'today' ? 'today' : r.status === 'soon' ? 'soon' : 'later';
      const when = r.days_left < 0 ? `已逾期 ${Math.abs(r.days_left)} 天` : r.days_left === 0 ? '今天到期' : `距还款日 ${r.days_left} 天`;
      const pct = r.credit_limit_cents > 0 ? Math.min(100, (r.used_cents / r.credit_limit_cents) * 100) : 0;
      return `<div class="remind-item ${tone}" data-account-id="${esc(r.account_id)}">
        <span class="ri-ico">🔔</span>
        <span class="ri-main">
          <span class="ri-name">${esc(r.name)}</span>
          <span class="ri-sub">${when} · ${esc(r.due_date)} 还款 · 待还 ${fmt(r.used_cents)}</span>
          <span class="ri-bar"><i style="width:${pct.toFixed(1)}%"></i></span>
        </span>
        <span class="ri-days">${r.days_left < 0 ? '逾期' : `${r.days_left}天`}</span>
      </div>`;
    })
    .join('');
  return `<section class="card remind-card"><h3 class="card-h">还款提醒</h3>${rows}</section>`;
}

function heroTrendSvg(series) {
  const rows = (series || []).slice(-12);
  if (!rows.length) return '';
  const vals = rows.map((r) => Number(r.expense_cents) || 0);
  const max = Math.max(1, ...vals);
  const w = 300;
  const h = 54;
  const top = 8;
  const bottom = h - 8;
  const step = rows.length > 1 ? w / (rows.length - 1) : w;
  const yOf = (v) => bottom - (v / max) * (bottom - top);
  const clampY = (y) => Math.min(bottom, Math.max(top, y));
  const pts = vals.map((v, i) => ({ x: i * step, y: clampY(yOf(v)) }));
  // 平滑折线（Catmull-Rom 近似，控制点夹在基线内，避免过冲）
  let line = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const t = 0.18;
    const c1x = p1.x + (p2.x - p0.x) * t;
    const c1y = clampY(p1.y + (p2.y - p0.y) * t);
    const c2x = p2.x - (p3.x - p1.x) * t;
    const c2y = clampY(p2.y - (p3.y - p1.y) * t);
    line += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  const area = `${line} L ${w.toFixed(1)} ${bottom} L 0 ${bottom} Z`;
  const last = rows[rows.length - 1] || {};
  return `<div class="hero-trend">
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="近 12 个月支出走势">
      <path d="${area}" fill="rgba(255,255,255,.16)" stroke="none"/>
      <path d="${line}" fill="none" stroke="rgba(255,255,255,.95)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>
    <div class="hero-trend-foot">
      <span>近 12 个月支出</span>
      <span>本月支出 ${fmt(last.expense_cents || 0)} · 收入 ${fmt(last.income_cents || 0)}</span>
    </div>
  </div>`;
}

async function renderAssetsPage() {
  const data = state.assets || (await store.listAssets(state.ledgerId).catch(() => null));
  if (!data) return `<div class="page">${pageHeader('资产')}<div class="empty">资产加载失败</div></div>`;
  const items = data.items || [];
  const groups = S.groupAccounts(items);
  const totals = data.totals || { asset_cents: 0, liability_cents: 0, net_cents: 0 };
  const ui = assetUI();
  const hiddenKeys = groups.filter((g) => ui.hidden.includes(g.key));
  const reminders = state.reminders || (await store.listReminders(state.ledgerId, todayISO()).catch(() => []));
  const monthly = state.monthly && state.monthly.length ? state.monthly : await store.statsMonthly(state.ledgerId, 12).catch(() => []);

  const hiddenBlock = hiddenKeys.length
    ? `<section class="card hidden-card">
        <button class="hidden-toggle" data-act="toggle-hidden-accounts">
          <span>${hiddenKeys.length} 个隐藏账户</span><i class="gh-caret ${ui.openHidden ? 'is-open' : ''}"></i>
        </button>
        ${state.openHidden ? `<div class="hidden-accounts">${hiddenKeys.map((g) => assetGroupHtml(g, ui, true)).join('')}</div>` : ''}
      </section>`
    : '';

  return `<div class="page page-assets">
    <header class="topbar">
      <button class="icon-btn" data-act="nav" data-href="#/me" aria-label="返回">‹</button>
      <h1>资产</h1>
      <div class="topbar-tools">${ledgerSwitchHtml()}<button class="icon-btn" data-act="account-add" aria-label="新增账户">＋</button></div>
    </header>
    <div class="scroll" id="asset-list">
      <section class="card balance-card asset-hero">
        <div class="bal-label">净资产</div>
        <div class="bal-value">${fmt(totals.net_cents)}</div>
        <div class="bal-split">
          <span>总资产 <b>${fmt(totals.asset_cents)}</b></span>
          <span>总负债 <b class="neg">${fmt(totals.liability_cents)}</b></span>
        </div>
        ${heroTrendSvg(monthly)}
      </section>
      ${remindersHtml(reminders)}
      ${groups.filter((g) => !ui.hidden.includes(g.key)).map((g) => assetGroupHtml(g, ui)).join('')}
      ${hiddenBlock}
      <section class="card asset-summary">
        <div class="as-row"><span>资产合计</span><span class="group-total">${fmt(totals.asset_cents)}</span></div>
        <div class="as-row"><span>负债合计</span><span class="group-total neg">${fmt(totals.liability_cents)}</span></div>
      </section>
    </div>
  </div>`;
}
function openRecurringForm(ruleId) {
  const rule = ruleId ? (state.recurring || []).find((r) => r.id === ruleId) : null;
  const typeOpts = [
    ['expense', '支出'],
    ['income', '收入'],
    ['transfer', '转账'],
  ];
  const freqOpts = [
    ['daily', '每天'],
    ['weekly', '每周'],
    ['monthly', '每月'],
    ['yearly', '每年'],
  ];
  const catOpts = [['', '不指定分类'], ...state.categories.map((c) => [c.id, `${c.icon || '📦'} ${c.name}`])];
  const accOpts = [['', '不指定账户'], ...state.accounts.map((a) => [a.id, `${a.icon || '💳'} ${a.name}`])];
  openForm({
    title: rule ? '编辑周期规则' : '新建周期规则',
    wide: true,
    intro: rule
      ? `<p class="hint">下次补记：${esc(rule.next_run || '—')} · 要删除规则，回到列表长按这一行。</p>`
      : '<p class="hint">规则按「开始日期」起算，到期后点「立即补记」生成交易；同一天同一条规则只会生成一笔。</p>',
    fields: [
      { key: 'type', label: '类型', type: 'select', options: typeOpts },
      { key: 'amount', label: '金额（元）', type: 'number', step: '0.01', min: '0.01' },
      { key: 'freq', label: '频率', type: 'select', options: freqOpts },
      { key: 'interval', label: '间隔（每 N 个周期）', type: 'number', step: '1', min: '1' },
      { key: 'start', label: '开始日期', type: 'date' },
      { key: 'end', label: '结束日期（可留空）', type: 'date' },
      { key: 'category', label: '分类', type: 'select', options: catOpts },
      { key: 'account', label: '账户（转账=从）', type: 'select', options: accOpts },
      { key: 'to_account', label: '转入账户（仅转账）', type: 'select', options: accOpts },
      { key: 'note', label: '备注', placeholder: '例如：房租' },
    ],
    values: rule
      ? {
          type: rule.type || 'expense',
          amount: M.formatPlain(rule.amount_cents || 0),
          freq: rule.freq || 'monthly',
          interval: String(rule.interval || 1),
          start: (rule.start_date || rule.next_run || S.todayISO()).slice(0, 10),
          end: rule.end_date ? String(rule.end_date).slice(0, 10) : '',
          category: rule.category_id || '',
          account: rule.account_id || '',
          to_account: rule.to_account_id || '',
          note: rule.note || '',
        }
      : {
          type: 'expense',
          freq: 'monthly',
          interval: '1',
          start: S.todayISO(),
          category: '',
          account: state.accounts[0] ? state.accounts[0].id : '',
          note: '',
        },
    submitText: rule ? '保存修改' : '创建规则',
    onSubmit: async (v) => {
      const cents = M.parseCents(v.amount || '0');
      if (!cents || cents <= 0) throw new Error('金额要大于 0');
      if (!v.start) throw new Error('请选开始日期');
      const payload = {
        ledger_id: state.ledgerId,
        type: v.type,
        amount_cents: cents,
        freq: v.freq || 'monthly',
        interval: Math.max(1, Number(v.interval) || 1),
        start_date: v.start,
        end_date: v.end || null,
        category_id: v.type === 'transfer' ? null : v.category || null,
        account_id: v.account || null,
        to_account_id: v.type === 'transfer' ? v.to_account || null : null,
        note: v.note || '',
        enabled: rule ? (rule.enabled ? 1 : 0) : 1,
      };
      if (v.type === 'transfer' && !payload.to_account_id) throw new Error('转账要选转入账户');
      if (v.type === 'transfer' && payload.to_account_id === payload.account_id) throw new Error('从和到不能是同一个账户');
      if (rule) {
        await store.saveRecurring({ ...payload, id: rule.id });
      } else {
        await store.saveRecurring(payload);
      }
      state.recurring = await store.listRecurring(state.ledgerId);
      closeSheet();
      toast(rule ? '规则已保存' : '规则已创建');
      await route();
    },
  });
}
const FREQ_LABEL = { daily: '每天', weekly: '每周', monthly: '每月', yearly: '每年' };
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function recFreqLabel(rule) {
  const base = FREQ_LABEL[rule.freq] || '每月';
  const head = Number(rule.interval) > 1 ? `${base} ${rule.interval} 次` : base;
  const d = rule.start_date || rule.next_run || '';
  if (rule.freq === 'monthly') return `${head} ${Number(d.slice(8, 10)) || 1} 日`;
  if (rule.freq === 'weekly') {
    const wd = d ? new Date(`${d}T00:00:00Z`).getUTCDay() : 1;
    return `${head}周${WEEKDAYS[wd]}`;
  }
  if (rule.freq === 'yearly') return `${head} ${Number(d.slice(5, 7)) || 1} 月 ${Number(d.slice(8, 10)) || 1} 日`;
  return head;
}

async function renderRecurringPage() {
  const rules = state.recurring.length ? state.recurring : await store.listRecurring(state.ledgerId).catch(() => []);
  const catById = new Map(state.categories.map((c) => [c.id, c]));
  const rows = rules
    .map((r) => {
      const cat = r.category_id ? catById.get(r.category_id) : null;
      const icon = r.type === 'transfer' ? '🔁' : cat && cat.icon ? cat.icon : r.type === 'income' ? '💰' : '📦';
      const sign = r.type === 'expense' ? '-' : r.type === 'income' ? '+' : '';
      const cls = r.type === 'expense' ? 'expense' : r.type === 'income' ? 'income' : 'transfer';
      const due = r.enabled && r.next_run && r.next_run <= S.todayISO();
      return `<div class="rec-row ${r.enabled ? '' : 'is-off'}" data-id="${esc(r.id)}" data-rule-id="${esc(r.id)}">
        <button class="rec-main" data-act="rec-edit" data-id="${esc(r.id)}" data-rule-id="${esc(r.id)}">
          <span class="r-ico">${esc(icon)}</span>
          <div class="r-main">
            <div class="r-name">${esc(r.note || (cat ? cat.name : '周期记账'))}</div>
            <div class="r-sub">${esc(recFreqLabel(r))} · <span class="amt ${cls}">${sign}¥${fmt(r.amount_cents)}</span>${due ? ' · <b class="due">待补记</b>' : ''}${r.enabled ? '' : '<span class="badge off rec-off-badge">已暂停</span>'}</div>
            <div class="r-sub">下次 ${esc(r.next_run || '—')}${r.end_date ? ` · 到 ${esc(r.end_date)} 止` : ''}</div>
          </div>
        </button>
        <label class="switch">
          <input type="checkbox" ${r.enabled ? 'checked' : ''} data-act="rec-toggle" data-id="${esc(r.id)}">
          <i></i>
        </label>
      </div>`;
    })
    .join('');

  return `<div class="page">
    ${pageHeader('周期记账', '<button class="icon-btn" data-act="rec-add" aria-label="新建规则">＋</button>')}
    <div class="scroll">
      <p class="hint" style="padding:10px 18px 0">规则不会自己跑：点底部「立即补记」按 <code>next_run</code> 把到期的一起补上，同一天同一条规则只会生成一笔。</p>
      <div class="row-list" style="margin-top:10px">${rows || '<div class="empty"><span class="empty-emoji">🔁</span>还没有周期规则<br>房租、订阅、工资都能交给它</div>'}</div>
      <div style="padding:14px"><button class="btn primary block" data-act="rec-run">立即补记</button></div>
    </div>
  </div>`;
}

/** 周期规则长按菜单（v1.3 契约 §4.1）：删规则只能从这里走 */
function openRecMenu(ruleId) {
  const rule = (state.recurring || []).find((r) => r.id === ruleId);
  if (!rule) return;
  const cat = rule.category_id ? state.categories.find((c) => c.id === rule.category_id) : null;
  const name = rule.note || (cat ? cat.name : '周期记账');
  const sign = rule.type === 'expense' ? '-' : rule.type === 'income' ? '+' : '';
  openSheet({
    title: name,
    body: `<p class="hint" style="margin:0 0 12px">${sign}¥${fmt(rule.amount_cents)} · ${esc(recFreqLabel(rule))}${rule.enabled ? '' : ' · 已暂停'}</p>
      <div class="btn-col">
        <button class="btn primary block" data-act="rec-edit" data-id="${esc(rule.id)}">编辑</button>
        <button class="btn block" data-act="rec-pause" data-id="${esc(rule.id)}">${rule.enabled ? '暂停' : '恢复'}</button>
        <button class="btn danger block" data-act="rec-del" data-id="${esc(rule.id)}">删除规则</button>
      </div>`,
  });
}

/** 长按 600ms 打开规则菜单；移动 >10px 或抬手取消，触发后吞掉紧随的 click */
function bindRecLongPress(container) {
  if (!container) return;
  let timer = null;
  let sx = 0;
  let sy = 0;
  let fired = false;
  const stop = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  container.addEventListener('pointerdown', (e) => {
    const main = e.target.closest('.rec-main');
    if (!main) return;
    if (e.button != null && e.button > 0) return;
    sx = e.clientX;
    sy = e.clientY;
    fired = false;
    stop();
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      suppressClickUntil = Date.now() + 800;
      try {
        if (navigator.vibrate) navigator.vibrate(10);
      } catch (err) {
        /* 部分 WebView 不支持震动 */
      }
      openRecMenu(main.dataset.id || main.dataset.ruleId);
    }, 600);
  });
  container.addEventListener('pointermove', (e) => {
    if (!timer) return;
    if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) stop();
  });
  container.addEventListener('pointerup', stop);
  container.addEventListener('pointercancel', stop);
  container.addEventListener('pointerleave', stop);
  container.addEventListener(
    'click',
    (e) => {
      if (!fired) return;
      if (!e.target.closest('.rec-main')) return;
      e.preventDefault();
      e.stopPropagation();
      fired = false;
    },
    true,
  );
}

async function renderTagsPage() {  const tags = state.tags.length ? state.tags : await store.listTags(state.ledgerId).catch(() => []);
  const chips = tags
    .map(
      (t) => `<button class="tag-chip big" data-act="tag-edit" data-id="${esc(t.id)}" style="--tag-c:${esc(t.color || '#3eb489')}">
        <i class="dot" style="background:${esc(t.color || '#3eb489')}"></i>${esc(t.name)}<span class="tag-count">${t.usage_count || 0}</span></button>`,
    )
    .join('');
  return `<div class="page">
    ${pageHeader('标签', '<button class="icon-btn" data-act="tag-new" aria-label="新建标签">＋</button>')}
    <div class="scroll">
      <p class="hint" style="padding:10px 18px 0">标签可以跨分类描述一件事：出差、报销、宠物、装修。记账时在标签行点一下就能打上。</p>
      <div class="tag-grid">${chips || '<div class="empty">还没有标签，点右上角 ＋ 新建。</div>'}</div>
      <p class="hint" style="padding:0 18px 24px">点标签可以改名、换色或删除。删除标签不会删交易，只会把标签从那些交易上摘掉。</p>
    </div>
  </div>`;
}

async function renderCategoriesPage() {
  const block = (kind, title) => {
    const cats = state.categories.filter((c) => c.kind === kind);
    const rows = cats
      .map(
        (c) => `<div class="row-item">
        <span class="r-ico">${esc(c.icon || '📦')}</span>
        <div class="r-main"><div class="r-name">${esc(c.name)}</div></div>
        <div class="r-tools">
          <button class="mini-btn" data-act="cat-edit" data-id="${esc(c.id)}">编辑</button>
          <button class="mini-btn danger" data-act="cat-del" data-id="${esc(c.id)}">删除</button>
        </div>
      </div>`,
      )
      .join('');
    return `<h3 style="margin:14px 18px 6px;font-size:13px;color:var(--text-2)">${title} · ${cats.length}</h3>
      <div class="row-list" style="margin:0 14px 4px">${rows || '<div class="empty" style="padding:20px">暂无</div>'}</div>
      <button class="add-row" data-act="cat-add" data-kind="${kind}">＋ 新增${title}</button>`;
  };
  return `<div class="page">
    ${subHeader('分类管理')}
    <div class="scroll">${block('expense', '支出分类')}${block('income', '收入分类')}
      <p class="hint" style="padding:0 18px 16px">删除分类不会删除已有交易，那些交易会显示为「未分类」。</p>
    </div>
  </div>`;
}

let pendingBudgetConflict = null;
let budgetSwitchBusy = false;

/** 总预算 < 明细合计时的二选一（v1.3 契约 §4.2 等式模型） */
function openBudgetConflict(details) {
  const totalCents = Math.round(Number(details && details.total_cents) || 0);
  const sumCents = Math.round(Number(details && details.categories_sum_cents) || 0);
  pendingBudgetConflict = { totalCents, sumCents };
  openSheet({
    title: '总预算不够分',
    body: `<p class="hint" style="padding:2px 2px 10px">明细合计 <b>¥${fmt(sumCents)}</b> 超过总预算 <b>¥${fmt(totalCents)}</b>，选一个继续：</p>
      <div class="btn-col">
        <button class="btn primary block" data-act="budget-expand">把总预算提到 ¥${fmt(sumCents)}</button>
        <button class="btn block" data-act="budget-rebalance">按比例压缩明细</button>
      </div>`,
    footer: '<button class="btn ghost block" data-act="sheet-close">先不改</button>',
  });
}

async function renderBudgetsPage() {
  const month = todayMonth();
  const view = await store.budgetUsage(state.ledgerId, month).catch(() => null);
  // 契约 v1.3.2：预算功能没开启时，整页只给一个「开启预算」入口
  if (!view || !view.enabled) {
    return `<div class="page">
    ${subHeader('预算')}
    <div class="scroll">
      <div class="card" data-block="budget-off">
        <h3>预算功能没开启</h3>
        <p class="hint" style="margin:6px 0 14px">开启后，明细页顶部会出现本月预算条；分类预算和预警阈值也在这里设。</p>
        <button class="btn primary block" data-act="budget-enable-on">开启预算</button>
      </div>
    </div>
  </div>`;
  }
  const items = (view && view.items) || [];
  const hasCats = items.length > 0;
  const hasTotal = !!(view && view.has_budget);
  const expenseCats = state.categories.filter((c) => c.kind === 'expense');
  const byCat = new Map(items.map((b) => [b.category_id, b]));
  const money = (c) => `¥${fmt(Math.abs(Math.round(Number(c) || 0)))}`;
  const warnPercent = view ? Number(view.warn_percent) || 10 : 10;
  const totalCents = view ? Math.round(Number(view.amount_cents) || 0) : 0;
  const catsSum = view ? Math.round(Number(view.categories_sum_cents) || 0) : 0;
  const unalloc = view ? Math.round(Number(view.unallocated_cents) || 0) : 0;

  const bar = (row) => {
    const used = Math.round(Number(row.used_cents) || 0);
    const available = Math.round(Number(row.available_cents != null ? row.available_cents : row.amount_cents) || 0);
    const remaining = Math.round(Number(row.remaining_cents != null ? row.remaining_cents : available - used) || 0);
    const over = remaining < 0;
    const pct = available > 0 ? Math.min(100, Math.round((used / available) * 100)) : 100;
    const cls = over ? 'over' : row.warn_level === 'warn' ? 'warn' : '';
    const carry = Math.round(Number(row.carry_in_cents) || 0);
    const carryLine = carry
      ? `<span class="carry ${carry < 0 ? 'neg' : ''}">含结转 ${carry > 0 ? '+' : '-'}${money(carry)}</span>`
      : '<span class="carry">无结转</span>';
    return `<div class="progress ${cls}"><i style="width:${pct}%"></i></div>
      <div class="budget-head" style="margin-top:5px"><span class="bh-num ${over ? 'is-neg' : ''}">已用 ${money(used)} / 可用 ${money(available)} · ${over ? `超支 ${money(remaining)}` : `还剩 ${money(remaining)}`}</span></div>
      <div class="budget-head"><span class="bh-num hint-small">额度 ${money(row.amount_cents)}</span>${carryLine}</div>`;
  };

  const rollSwitch = (key, row) => `<label class="switch tiny" title="结转下月">
      <input type="checkbox" data-roll="${esc(key)}" ${row && (row.rollover === true || row.rollover === 1) ? 'checked' : ''}>
      <i></i>
    </label>`;

  // 等式模型：总预算 = 明细合计 + 未分配（未分配可编辑）
  const equation = `<div class="budget-eq">
    <span class="eq-text"><span class="eq-lead">总预算 <b>${money(totalCents)}</b> =</span> 明细合计 <b>${money(catsSum)}</b> + 未分配 <b>${money(unalloc)}</b></span>
    <div class="eq-row">
      <span class="eq-label">未分配</span>
      <span class="eq-yen">¥</span>
      <input type="number" inputmode="decimal" step="0.01" min="0" data-budget="unallocated" value="${M.formatPlain(unalloc)}">
      ${unalloc > 0 ? '<button class="mini-btn" data-act="budget-align">对齐到明细合计</button>' : ''}
    </div>
  </div>`;

  const totalCard = `<div class="card">
    <div class="budget-enable-row">
      <label class="switch"><input type="checkbox" data-act="budget-enable" checked><i></i></label>
      <div class="be-text">
        <span class="be-title">预算功能</span>
        <span class="hint-small">关闭后明细页不显示预算条，已填的数据保留</span>
      </div>
    </div>
    <h3>${S.monthLabel(month)} 总预算</h3>
    ${hasTotal ? bar(view) : '<p class="hint">还没设总预算。填一个数字，超支会变红。</p>'}
    <div class="budget-input"><span>¥</span><input type="number" inputmode="decimal" step="0.01" min="0" data-budget="total" value="${hasTotal ? M.formatPlain(totalCents) : ''}" placeholder="例如 4500"></div>
    ${equation}
    <div class="budget-roll-row">
      <span class="br-label">结转下月</span>
      ${rollSwitch('total', view)}
      <span class="hint-small">把本月剩下的钱带到下个月</span>
    </div>
    ${
      hasCats
        ? `<div class="budget-note"><span class="hint-small">分类预算之和就是「明细合计」，剩下的钱算「未分配」</span>
            <button class="mini-btn ghost" data-act="budget-clear-cats">清空明细预算</button></div>`
        : ''
    }
    <div class="budget-warn">
      <span class="bw-label">预警阈值</span>
      <input type="number" inputmode="numeric" min="1" max="100" step="1" data-warn-percent value="${warnPercent}"><span class="bw-unit">%</span>
      <span class="hint-small">剩余低于这个比例时提醒</span>
    </div>
  </div>`;

  const catBlocks = expenseCats
    .map((c) => {
      const b = byCat.get(c.id);
      const over = b ? Math.round(Number(b.remaining_cents) || 0) < 0 : false;
      const cls = b ? (over ? 'is-over' : b.warn_level === 'warn' ? 'is-warn' : '') : '';
      const pctLeft = b ? Math.round(Number(b.percent_left) || 0) : 0;
      const leftCls = over ? 'is-over' : b && b.warn_level === 'warn' ? 'is-warn' : '';
      const leftText = over
        ? `超支 ${money(b.remaining_cents)}`
        : b && b.warn_level === 'warn'
          ? `⚠️ 剩余 ${pctLeft}%`
          : `剩余 ${pctLeft}%`;
      const leftLine = b && b.amount_cents ? `<div class="budget-left ${leftCls}">${leftText}</div>` : '';
      return `<div class="budget-item ${cls}" data-budget-cat="${esc(c.id)}">
      <div class="budget-head"><span class="bh-name">${esc(c.icon || '📦')} ${esc(c.name)}</span>
        <span class="bh-actions">${b && b.amount_cents ? `<span class="bh-num">${money(b.amount_cents)}</span>` : '<span class="hint-small">未设置</span>'}${rollSwitch(c.id, b)}</span></div>
      ${b && b.amount_cents ? bar(b) : ''}
      ${leftLine}
      <div class="budget-input"><span>¥</span><input type="number" inputmode="decimal" step="0.01" min="0" data-budget="${esc(c.id)}" value="${b ? M.formatPlain(b.amount_cents || 0) : ''}" placeholder="不设就留空"></div>
    </div>`;
    })
    .join('');

  return `<div class="page">
    ${subHeader('预算')}
    <div class="scroll">
      ${totalCard}
      <div class="card"><h3>分类预算（当月支出）</h3>${catBlocks || '<p class="hint">先去分类管理添加支出分类。</p>'}</div>
      <div style="padding:0 14px 20px"><button class="btn primary block" data-act="budget-save">保存预算</button></div>
      <p class="hint" style="padding:0 18px 16px">清空某个输入框再保存 = 删除该预算。总预算 = 明细合计 + 未分配；保存分类预算不会动总预算，总预算小于明细合计时会问你怎么办。可用额 = 额度 + 结转；结转按上月的「额度 + 结转 − 花费」逐月滚，最多回溯 36 个月。</p>
    </div>
  </div>`;
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ------------------------------------------------------------ 导入/导出（v1.2.2）

function ledgerFileBase() {
  const ledger = currentLedger() || {};
  const name = String(ledger.name || '账本').replace(/[\\/:*?"<>|\s]+/g, '');
  return `mintlite-${name}-${todayISO()}`;
}

async function exportJson() {
  const data = await store.exportAll(state.ledgerId);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  downloadBlob(blob, `${ledgerFileBase()}.json`);
  toast(`已导出 JSON（${(data.transactions || []).length} 条）`);
}

async function exportCsv() {
  const { items } = await store.listTransactions({ ledger_id: state.ledgerId, limit: 200000 });
  const catById = new Map(state.categories.map((c) => [c.id, c]));
  const accById = new Map(state.accounts.map((a) => [a.id, a]));
  const tagById = new Map(state.tags.map((t) => [t.id, t]));
  const typeLabel = { expense: '支出', income: '收入', transfer: '转账', adjust: '余额调整' };
  const reimburseLabel = { pending: '待报销', done: '已报销' };
  const header = ['日期', '类型', '分类', '账户', '转入账户', '金额(元)', '备注', '标签', '报销状态'];
  const lines = [header.join(',')];
  for (const tx of items.slice().sort((a, b) => (S.dateOf(a) < S.dateOf(b) ? 1 : -1))) {
    const cat = tx.category_id ? catById.get(tx.category_id) : null;
    const acc = tx.account_id ? accById.get(tx.account_id) : null;
    const to = tx.to_account_id ? accById.get(tx.to_account_id) : null;
    const tags = (tx.tags || [])
      .map((id) => (tagById.get(id) ? tagById.get(id).name : ''))
      .filter(Boolean)
      .join(' ');
    lines.push(
      [
        S.dateOf(tx),
        typeLabel[tx.type] || tx.type,
        cat ? cat.name : '',
        acc ? acc.name : '',
        to ? to.name : '',
        M.formatPlain(tx.amount_cents),
        tx.note || '',
        tags,
        reimburseLabel[tx.reimburse_state] || '',
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  downloadBlob(blob, `${ledgerFileBase()}.csv`);
  toast(`已导出 CSV ${items.length} 条`);
}

async function exportMint() {
  const { items } = await store.listTransactions({ ledger_id: state.ledgerId, limit: 200000 });
  const lookups = {
    accounts: new Map(state.accounts.map((a) => [a.id, a])),
    categories: new Map(state.categories.map((c) => [c.id, c])),
    tags: new Map(state.tags.map((t) => [t.id, t])),
    members: new Map(state.members.map((m) => [m.id, m])),
  };
  const sorted = items.slice().sort((a, b) => (S.dateOf(a) < S.dateOf(b) ? -1 : 1));
  const text = X.buildMintText(sorted, lookups);
  const rows = sorted.filter((t) => t.type === 'expense' || t.type === 'income' || t.type === 'transfer');
  downloadBlob(new Blob([X.encodeUtf16LE(text)], { type: 'text/plain;charset=utf-16le' }), `${ledgerFileBase()}.txt`);
  toast(`已导出薄荷格式 ${rows.length} 条（UTF-16LE · TAB · 19 列）`);
}

async function exportRun() {
  const sel = $('export-format');
  const format = sel ? sel.value : 'csv';
  try {
    if (format === 'mint') await exportMint();
    else if (format === 'json') await exportJson();
    else await exportCsv();
  } catch (err) {
    toast(`导出失败：${err && err.message ? err.message : err}`, 'error');
  }
}

// ------------------------------------------------------------ 导入

const MEMBER_COLORS = ['#2f9e8f', '#e0788b', '#4f9de0', '#f0a458', '#8b7bd8', '#c96fa8'];

function unsetAccountId(accByName, accs, created) {
  const found = accByName.get(X.UNSET_ACCOUNT);
  if (found) return found.id;
  const row = {
    id: uid(),
    ledger_id: state.ledgerId,
    name: X.UNSET_ACCOUNT,
    type: 'other',
    kind: 'asset',
    icon: '❔',
    include_in_net: 0,
    initial_cents: 0,
    balance_cents: 0,
    sort: accs.length + created.length,
    created_at: nowISO(),
    updated_at: nowISO(),
  };
  created.push(row);
  accByName.set(row.name, row);
  return row.id;
}

/** 解析出的行 → 待写入计划（不落库），同时算出会新建多少实体、跳过多少条。 */
async function buildImportPlan(parsed, fmt) {
  const [accs, cats, members, tags, all] = await Promise.all([
    store.listAccounts(state.ledgerId),
    store.listCategories(state.ledgerId),
    store.listMembers ? store.listMembers(state.ledgerId) : Promise.resolve([]),
    store.listTags(state.ledgerId),
    store.listTransactions({ ledger_id: state.ledgerId, limit: 200000 }),
  ]);
  const accByName = new Map(accs.map((a) => [a.name, a]));
  const catByName = new Map(cats.map((c) => [`${c.kind}:${c.name}`, c]));
  const memByName = new Map((members || []).map((m) => [m.name, m]));
  const tagByName = new Map(tags.map((t) => [t.name, t]));
  const external = new Set((all.items || []).map((t) => t.external_id).filter(Boolean));
  // 薄荷导出里可能出现「整行完全相同」的两笔（同秒同额同人），只按行文本做键会把第二笔当成重复。
  // 做法：第一笔仍用 sha1(原文) 作键（与契约一致），第 N 笔追加 #N 后缀，重导同一文件依旧幂等。
  const sameRaw = new Map();

  const newAccounts = [];
  const newCategories = [];
  const newMembers = [];
  const newTags = [];
  const txs = [];
  const links = [];
  const warnings = [];
  let skipped = 0;

  const ensureAccount = (rawName) => {
    const name = String(rawName || '').trim() || X.UNSET_ACCOUNT;
    if (name === X.UNSET_ACCOUNT) return unsetAccountId(accByName, accs, newAccounts);
    const found = accByName.get(name);
    if (found) return found.id;
    const type = X.guessAccountType(name);
    const row = {
      id: uid(),
      ledger_id: state.ledgerId,
      name,
      type,
      kind: TYPE_TO_KIND[type] || 'asset',
      icon: type === 'cash' ? '💵' : type === 'invest' ? '📈' : type === 'payable' ? '🧾' : '🏦',
      include_in_net: 1,
      initial_cents: 0,
      balance_cents: 0,
      sort: accs.length + newAccounts.length,
      created_at: nowISO(),
      updated_at: nowISO(),
    };
    newAccounts.push(row);
    accByName.set(name, row);
    return row.id;
  };

  const ensureCategory = (name, kind) => {
    const clean = String(name || '').trim();
    if (!clean) return null;
    const key = `${kind}:${clean}`;
    const found = catByName.get(key);
    if (found) return found.id;
    const row = {
      id: uid(),
      ledger_id: state.ledgerId,
      name: clean,
      kind,
      icon: kind === 'income' ? '💰' : '🏷️',
      sort: cats.length + newCategories.length,
      created_at: nowISO(),
      updated_at: nowISO(),
    };
    newCategories.push(row);
    catByName.set(key, row);
    return row.id;
  };

  const ensureMember = (name) => {
    const clean = String(name || '').trim();
    if (!clean) return null;
    const found = memByName.get(clean);
    if (found) return found.id;
    const row = {
      id: uid(),
      ledger_id: state.ledgerId,
      name: clean,
      color: MEMBER_COLORS[(members.length + newMembers.length) % MEMBER_COLORS.length],
      is_self: 0,
      sort: (members.length + newMembers.length) * 10,
      created_at: nowISO(),
      updated_at: nowISO(),
    };
    newMembers.push(row);
    memByName.set(clean, row);
    return row.id;
  };

  const ensureTag = (name) => {
    const clean = String(name || '').trim();
    if (!clean) return null;
    const found = tagByName.get(clean);
    if (found) return found.id;
    const row = {
      id: uid(),
      ledger_id: state.ledgerId,
      name: clean,
      color: MEMBER_COLORS[(tags.length + newTags.length) % MEMBER_COLORS.length],
      created_at: nowISO(),
      updated_at: nowISO(),
    };
    newTags.push(row);
    tagByName.set(clean, row);
    return row.id;
  };

  for (const row of parsed.rows) {
    const seen = sameRaw.get(row.raw) || 0;
    sameRaw.set(row.raw, seen + 1);
    const ext = `${fmt}:${await X.sha1Hex(seen ? `${row.raw}#${seen}` : row.raw)}`;
    if (external.has(ext)) {
      skipped += 1;
      continue;
    }
    external.add(ext);
    const id = uid();
    let accountId = null;
    let toAccountId = null;
    if (row.type === 'transfer') {
      accountId = ensureAccount(row.payName || X.UNSET_ACCOUNT);
      toAccountId = ensureAccount(row.receiveName || X.UNSET_ACCOUNT);
      if (accountId === toAccountId) {
        warnings.push(`第 ${row.index} 行转账两端相同，已跳过`);
        skipped += 1;
        continue;
      }
    } else {
      accountId = ensureAccount(row.accountName || X.UNSET_ACCOUNT);
    }
    const categoryId = row.type === 'transfer' ? null : ensureCategory(row.categoryName, row.type);
    const tagIds = [];
    for (const tagName of row.tagNames || []) {
      const tid = ensureTag(tagName);
      if (tid) tagIds.push(tid);
    }
    txs.push({
      id,
      ledger_id: state.ledgerId,
      type: row.type,
      amount_cents: row.amountCents,
      category_id: categoryId,
      account_id: accountId,
      to_account_id: toAccountId,
      note: fmt === 'mint' ? X.mintNote(row) : String(row.note || ''),
      happened_at: row.dateText,
      source: 'import',
      external_id: ext,
      member_id: ensureMember(row.author),
      tags: tagIds,
      reimburse_state: row.reimburseState || null,
      created_at: nowISO(),
      updated_at: nowISO(),
    });
    for (const tagId of tagIds) links.push({ transaction_id: id, tag_id: tagId });
  }

  return {
    created: txs.length,
    skipped,
    accounts_created: newAccounts.length,
    categories_created: newCategories.length,
    members_created: newMembers.length,
    tags_created: newTags.length,
    warnings,
    payload: {
      ledgers: [],
      accounts: newAccounts,
      categories: newCategories,
      members: newMembers,
      tags: newTags,
      transactions: txs,
      transaction_tags: links,
      budgets: [],
      recurring: [],
    },
  };
}

/** 读文本 → 认格式 → 解析 → 出计划（不落库）。 */
async function planImport(text, bytes, want) {
  const fmt = X.detectFormat(bytes, text, want);
  if (!fmt) throw new Error('认不出文件格式（支持本 App CSV / 薄荷记账 / JSON）');
  if (fmt === 'json') {
    const data = JSON.parse(text);
    const payload = data && data.data ? data.data : data;
    const txs = Array.isArray(payload) ? payload : Array.isArray(payload.transactions) ? payload.transactions : [];
    if (!txs.length && !(payload && (payload.accounts || payload.categories))) {
      throw new Error('JSON 里没有可导入的数据');
    }
    return { fmt, json: payload, total: txs.length, created: txs.length, skipped: 0, warnings: [] };
  }
  const parsed = fmt === 'mint' ? X.parseMint(text) : X.parseAppCsv(text);
  if (!parsed.rows.length) throw new Error(parsed.warnings[0] || '文件里没有可导入的记录');
  const plan = await buildImportPlan(parsed, fmt);
  return { fmt, ...plan, warnings: [...parsed.warnings.slice(0, 5), ...plan.warnings] };
}

function importSummaryText(plan) {
  const bits = [`导入 ${plan.created} 条`];
  if (plan.skipped) bits.push(`跳过 ${plan.skipped} 条`);
  const created = [];
  if (plan.categories_created) created.push(`${plan.categories_created} 分类`);
  if (plan.accounts_created) created.push(`${plan.accounts_created} 账户`);
  if (plan.members_created) created.push(`${plan.members_created} 成员`);
  if (plan.tags_created) created.push(`${plan.tags_created} 标签`);
  if (created.length) bits.push(`新建 ${created.join(' ')}`);
  return bits.join(' · ');
}

async function importPick() {
  const input = $('import-file');
  if (!input) return;
  input.value = '';
  input.click();
}


function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1500);
}

async function renderDataPage() {
  const sampleCount = state.recentTx.filter((t) => t.is_sample).length;
  let usage = { usage: 0, quota: 0 };
  try {
    usage = await store.storageEstimate();
  } catch {
    usage = { usage: 0, quota: 0 };
  }
  const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
  return `<div class="page">
    ${subHeader('数据')}
    <div class="scroll">
      <div class="card">
        <h3>导出</h3>
        <div class="io-row">
          <select class="io-select" id="export-format" aria-label="导出格式">
            <option value="csv">CSV（默认）</option>
            <option value="mint">薄荷记账</option>
            <option value="json">JSON 备份</option>
          </select>
          <button class="btn primary" data-act="export-run">导出</button>
        </div>
        <p class="hint">CSV 逗号分隔、Excel 能直接打开；薄荷记账是 UTF-16LE + TAB 的 .txt，可直接回导到薄荷 App；JSON 是全量备份（账本/账户/分类/标签/预算/周期规则）。</p>
      </div>
      <div class="card">
        <h3>导入</h3>
        <div class="io-row">
          <select class="io-select" id="import-format" aria-label="导入格式">
            <option value="auto">自动识别（默认）</option>
            <option value="csv">本 App CSV</option>
            <option value="mint">薄荷记账</option>
            <option value="json">JSON 备份</option>
          </select>
          <button class="btn primary" data-act="import-pick">选择文件</button>
        </div>
        <input type="file" id="import-file" accept=".csv,.txt,.tsv,.json,text/csv,text/plain,application/json" hidden>
        <p class="hint">薄荷记账导出的 .csv 其实是 UTF-16LE + TAB 分隔，选「自动识别」就能直接读。选完文件会先预览条数再确认；同一文件重复导入会自动跳过，不会产生重复账单。</p>
      </div>
      <div class="card">
        <h3>示例与重置</h3>
        <div class="kv"><span>示例交易</span><b>${sampleCount} 条</b></div>
        <div class="kv"><span>本地占用</span><b>${usage.usage ? kb(usage.usage) : '—'}</b></div>
        <div class="btn-row" style="margin-top:10px">
          <button class="btn" data-act="clear-samples">清空示例数据</button>
          <button class="btn danger" data-act="reset-local">清空全部本地数据</button>
        </div>
        <p class="hint">清空示例只会软删除带「示例」标记的交易，自己记的不受影响。清空全部会删掉 IndexedDB 里所有账本数据。</p>
      </div>
    </div>
  </div>`;
}

function syncLogHtml() {
  if (!state.syncLog.length) return '<pre class="log-box" id="sync-log">还没有操作记录</pre>';
  return `<pre class="log-box" id="sync-log">${esc(state.syncLog.slice(-40).join('\n'))}</pre>`;
}

function pushLog(line) {
  state.syncLog.push(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${line}`);
  const box = $('sync-log');
  if (box) box.textContent = state.syncLog.slice(-40).join('\n');
}

async function renderSyncPage() {
  const s = getSettings();
  return `<div class="page">
    ${subHeader('云同步')}
    <div class="scroll">
      <div class="card">
        <h3>同步模式</h3>
        <label class="row-item" style="padding:10px 0;min-height:44px">
          <input type="radio" name="sync-mode" value="local" ${s.mode !== 'server' ? 'checked' : ''} data-act="sync-mode">
          <div class="r-main"><div class="r-name">本地模式</div><div class="r-sub">数据只在这台设备，断网可用（默认）</div></div>
        </label>
        <label class="row-item" style="padding:10px 0;min-height:44px">
          <input type="radio" name="sync-mode" value="server" ${s.mode === 'server' ? 'checked' : ''} data-act="sync-mode">
          <div class="r-main"><div class="r-name">服务器模式</div><div class="r-sub">读写走 REST API，多设备共享同一份数据</div></div>
        </label>
      </div>

      <div class="card">
        <h3>服务器</h3>
        <label class="field"><span>服务器地址</span>
          <input id="sync-base" type="url" inputmode="url" value="${esc(s.baseUrl || DEFAULT_BASE_URL)}" placeholder="${esc(DEFAULT_BASE_URL)}"></label>
        <label class="field"><span>用户名</span><input id="sync-user" value="${esc(s.username || '')}" placeholder="例如 mint"></label>
        <label class="field"><span>密码</span><input id="sync-pass" type="password" placeholder="只在登录时用，不保存"></label>
        <div class="btn-row">
          <button class="btn" data-act="sync-login">登录拿 token</button>
          <button class="btn" data-act="sync-register">注册新账号</button>
        </div>
        <div class="btn-row" style="margin-top:8px">
          <button class="btn" data-act="sync-test">测试连接</button>
          <button class="btn" data-act="sync-save">保存设置</button>
        </div>
        <div class="kv" style="margin-top:8px"><span>当前 token</span><b>${s.token ? `${esc(s.token.slice(0, 10))}…（${s.token.length} 字符）` : '无'}</b></div>
      </div>

      <div class="card">
        <h3>数据搬运</h3>
        <div class="btn-row">
          <button class="btn primary" data-act="sync-push">上传本地数据到服务器</button>
          <button class="btn" data-act="sync-pull">从服务器拉取</button>
        </div>
        <p class="hint"><b>冲突规则：</b>同一条记录（相同 id）比较 <code>updated_at</code>，新的覆盖旧的；本地独有 → 补传到服务器，服务器独有 → 补到本地。删除（<code>deleted_at</code> 非空）也按这条规则同步，不会被旧的在线数据复活。上传/拉取都可重复执行，幂等。</p>
      </div>

      <div class="card">
        <h3>操作日志</h3>
        ${syncLogHtml()}
      </div>
    </div>
  </div>`;
}

async function renderAboutPage() {
  const sampleCount = state.recentTx.filter((t) => t.is_sample).length;
  return `<div class="page">
    ${subHeader('关于')}
    <div class="scroll">
      <div class="card" style="text-align:center">
        <div style="font-size:44px;line-height:1">🌿</div>
        <div style="font-size:18px;font-weight:700;margin-top:8px">丁点记账</div>
        <div class="muted" style="font-size:12.5px;margin-top:4px">版本 ${VERSION} · 离线优先记账 PWA</div>
      </div>
      <div class="card">
        <h3>它是什么</h3>
        <p class="hint" style="font-size:12.5px">原生 HTML + CSS + ES Module，零构建、零依赖、零 CDN。断网也能记账，数据存在本机 IndexedDB。
        金额一律以「分」为整数存储，四则运算键盘自己实现 tokenizer + 递归下降，不会出现浮点误差。</p>
        <div class="kv"><span>数据模式</span><b>${store.mode === 'server' ? '服务器' : '本地 IndexedDB'}</b></div>
        <div class="kv"><span>账本</span><b>${esc(state.ledger ? state.ledger.name : '—')}</b></div>
        <div class="kv"><span>账户 / 分类</span><b>${state.accounts.length} / ${state.categories.length}</b></div>
        <div class="kv"><span>示例交易</span><b>${sampleCount} 条</b></div>
      </div>
      <div class="card">
        <h3>快捷键 / 手势</h3>
        <p class="hint" style="font-size:12.5px">
          · 记账页键盘支持 <code>+ - × ÷ ( )</code> 与小数，按 <code>=</code> 求值，连续按运算符可接着算。<br>
          · 明细页「左滑」或「长按」一条记录可以删除，点一下进入编辑。<br>
          · 报表页左右箭头切月份，环形图用 CSS <code>conic-gradient</code>，趋势图是内联 SVG。
        </p>
      </div>
      <p class="hint" style="text-align:center;padding:0 24px 24px">Made for local-first. © ${new Date().getFullYear()} 丁点记账</p>
    </div>
  </div>`;
}

// ------------------------------------------------------------ 路由

const ROUTES = {
  '/add': renderAddPage,
  '/list': renderListPage,
  '/report': renderReportPage,
  '/me': renderMePage,
  '/assets': renderAssetsPage,
  '/recurring': renderRecurringPage,
  '/tags': renderTagsPage,
  '/me/ledgers': renderLedgersPage,
  '/me/accounts': renderAssetsPage,
  '/me/members': renderMembersPage,
  '/me/categories': renderCategoriesPage,
  '/me/budgets': renderBudgetsPage,
  '/me/data': renderDataPage,
  '/me/sync': renderSyncPage,
  '/me/about': renderAboutPage,
};

const TAB_OF = {
  '/add': 'add',
  '/list': 'list',
  '/assets': 'assets',
  '/report': 'report',
  '/me': 'me',
};

function parseHash() {
  const raw = (location.hash || '#/add').replace(/^#/, '');
  const [pathPart, queryPart] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const path = `/${parts.join('/')}`;
  return { path: ROUTES[path] ? path : '/add', params: new URLSearchParams(queryPart || '') };
}

const TABS = [
  {
    id: 'add',
    href: '#/add',
    label: '记账',
    icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
  },
  {
    id: 'list',
    href: '#/list',
    label: '明细',
    icon: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  },
  {
    id: 'assets',
    href: '#/assets',
    label: '资产',
    icon: '<svg viewBox="0 0 24 24"><path d="M4 9h16v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9z"/><path d="M6 9V6.5A2.5 2.5 0 0 1 8.5 4H18v5"/><circle cx="15.5" cy="14" r="1.3"/></svg>',
  },
  {
    id: 'report',
    href: '#/report',
    label: '报表',
    icon: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9h-9V3z"/><path d="M12 3v6h6"/></svg>',
  },
  {
    id: 'me',
    href: '#/me',
    label: '我的',
    icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.6"/><path d="M4.5 20c1.4-3.6 4.2-5.4 7.5-5.4s6.1 1.8 7.5 5.4"/></svg>',
  },
];

function renderTabbar(active) {
  if (!el.tabbar) return;
  el.tabbar.innerHTML = TABS.map(
    (t) => `<button class="tab ${t.id === active ? 'is-on' : ''}" data-act="nav" data-tab="${t.id}" data-href="${t.href}" aria-label="${t.label}">
      ${t.icon}<span>${t.label}</span></button>`,
  ).join('');
}

let routeToken = 0;
async function route() {
  const token = (routeToken += 1);
  const { path, params } = parseHash();
  const view = el.view;
  if (!state.ready) return;
  // 换页时收起任何残留弹层：否则遮罩会盖住手势区与点击
  if (el.sheet.classList.contains('is-open')) closeSheet();
  // 二级页（如 /me/members）也要高亮所属主 tab
  const tabOfPath = TAB_OF[path] || (path.startsWith('/me') ? 'me' : '');
  renderTabbar(tabOfPath);

  try {
    if (path === '/add') await prepareAdd(params);
    const renderer = ROUTES[path];
    const html = await renderer(params);
    if (token !== routeToken) return; // 期间又切了路由
    view.innerHTML = html;
    if (path === '/list') bindSwipe($('tx-list'));
    if (path === '/assets') initRowGestures($('asset-list'));
    if (path === '/me/members') initRowGestures($('member-list'));
    if (path === '/recurring') bindRecLongPress(view);
    if (path === '/add') {
      syncAmountUI();
      const note = $('f-note');
      if (note) note.setAttribute('autocomplete', 'off');
    }
  } catch (err) {
    view.innerHTML = `<div class="page"><div class="empty"><span class="empty-emoji">😵</span>页面加载失败<br>${esc(err && err.message ? err.message : String(err))}</div></div>`;
  }
}

// ------------------------------------------------------------ 事件

// ------------------------------------------------------------ v1.2：手势

const SWIPE_TABS = [
  ['add', '#/add'],
  ['list', '#/list'],
  ['assets', '#/assets'],
  ['report', '#/report'],
  ['me', '#/me'],
];

const swipeState = { id: null, x: 0, y: 0, t: 0, edge: false, sheet: false, target: null, moved: false };

function go(href) {
  if (!href) return;
  if (location.hash !== href) location.hash = href;
  else route();
}

function swipeIgnoreNode(node) {
  if (!node || typeof node.closest !== 'function') return false;
  return !!node.closest('input, textarea, select, canvas, svg, table, .hscroll, .keypad, .donut, .no-gesture');
}

function backTarget(path) {
  if (!path) return null;
  const isTabRoot = SWIPE_TABS.some(([, href]) => href.slice(1) === path);
  if (isTabRoot) return null;
  return '#/me';
}

function currentIndex() {
  const path = parseHash().path;
  return SWIPE_TABS.findIndex(([, href]) => href.slice(1) === path);
}

/** 安卓壳 / 系统返回键统一入口：消费了返回 true，到头了返回 false。 */
function mintLiteBack() {
  if (el.sheet && el.sheet.classList.contains('is-open')) {
    closeSheet();
    return true;
  }
  const path = parseHash().path;
  const back = backTarget(path);
  if (back) {
    go(back);
    return true;
  }
  return false;
}

function inShell() {
  const bridge = window.MintLiteBridge;
  return !!(bridge && typeof bridge.platform === 'function' && bridge.platform());
}

function initGestures() {
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'mouse' && e.buttons === 0 && e.button !== 0) return;
      swipeState.id = e.pointerId == null ? 1 : e.pointerId;
      swipeState.x = e.clientX;
      swipeState.y = e.clientY;
      swipeState.t = Date.now();
      swipeState.edge = e.clientX < 44;
      swipeState.moved = false;
      const node = e.target instanceof Element ? e.target : null;
      swipeState.sheet = !!(node && node.closest('.sheet'));
      swipeState.target = node;
    },
    { passive: true },
  );

  document.addEventListener(
    'pointermove',
    (e) => {
      if (swipeState.id == null) return;
      const dx = e.clientX - swipeState.x;
      const dy = e.clientY - swipeState.y;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) swipeState.moved = true;
      if (swipeState.sheet && dy > 90 && Math.abs(dx) < Math.abs(dy)) {
        swipeState.id = null;
        closeSheet();
      }
    },
    { passive: true },
  );

  document.addEventListener(
    'pointerup',
    (e) => {
      if (swipeState.id == null) return;
      const dx = e.clientX - swipeState.x;
      const dy = e.clientY - swipeState.y;
      const sheet = swipeState.sheet;
      const edge = swipeState.edge;
      const target = swipeState.target;
      swipeState.id = null;
      swipeState.sheet = false;

      if (sheet) {
        if (dy > 90 && Math.abs(dx) < Math.abs(dy)) closeSheet();
        return;
      }
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 2) return;
      if (swipeIgnoreNode(target)) return;

      const path = parseHash().path;

      // 右滑：先交给 MintLiteBack（关弹层 / 二级页回上一级）
      if (dx > 0 && (edge || dx > 80)) {
        if (mintLiteBack()) return;
      }

      // 根页（tab）左右滑：在壳里就退出应用，Web 端切相邻 tab
      const idx = currentIndex();
      if (idx < 0) return;
      const onRow = !!(target && target.closest && target.closest('.asset-row, .tx-wrap, .swipe-list .member-row'));
      if (inShell() && Math.abs(dx) > 80 && !onRow) {
        const bridge = window.MintLiteBridge;
        if (typeof bridge.exitApp === 'function') {
          bridge.exitApp();
          return;
        }
      }
      if (dx < 0) {
        if (onRow) return;
        const next = SWIPE_TABS[idx + 1];
        if (next) go(next[1]);
      } else {
        const prev = SWIPE_TABS[idx - 1];
        if (prev) go(prev[1]);
      }
    },
    { passive: true },
  );
}

// 安卓壳调用：window.MintLiteBack() -> true 已消费 / false 到头了
window.MintLiteBack = mintLiteBack;

function initRowGestures(container) {
  if (!container || container.dataset.gesture === '1') return;
  container.dataset.gesture = '1';
  let start = null;
  container.addEventListener(
    'pointerdown',
    (e) => {
      const row = e.target instanceof Element ? e.target.closest('.asset-row, .member-row') : null;
      if (!row) return;
      start = { x: e.clientX, y: e.clientY, row };
    },
    { passive: true },
  );
  container.addEventListener(
    'pointerup',
    (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      const row = start.row;
      start = null;
      if (dx > -60 || Math.abs(dx) < Math.abs(dy) * 2) return;
      suppressClickUntil = Date.now() + 350;
      if (row.classList.contains('asset-row')) ACT['asset-edit'](row, e);
      else if (row.classList.contains('member-row')) ACT['member-edit'](row, e);
    },
    { passive: true },
  );
}

const ACT = {
  nav(elx) {
    const href = elx.dataset.href;
    if (href && location.hash !== href) location.hash = href;
  },
  'sheet-close'() {
    closeSheet();
  },
  async 'sheet-submit'() {
    if (sheetSubmitHandler) await sheetSubmitHandler();
  },
  async 'confirm-yes'() {
    const r = confirmResolver;
    confirmResolver = null;
    closeSheet();
    if (r) r(true);
  },
  'confirm-no'() {
    const r = confirmResolver;
    confirmResolver = null;
    closeSheet();
    if (r) r(false);
  },

  // ------- 记账页
  type(elx) {
    const next = elx.dataset.type;
    if (!state.add || state.add.type === next) return;
    state.add.type = next;
    state.add.categoryId = null;
    rememberType(next);
    renderTabbar('add');
    el.view.innerHTML = renderAddPage();
    syncAmountUI();
  },
  key(elx) {
    if (!state.add) return;
    state.add.calc.press(elx.dataset.key);
    syncAmountUI();
  },
  cat(elx, e) {
    if (!state.add) return;
    const id = elx.dataset.id;
    state.add.categoryId = state.add.categoryId === id ? null : id;
    document.querySelectorAll('.cat').forEach((node) => {
      node.classList.toggle('is-on', node.dataset.id === state.add.categoryId);
    });
    e.stopPropagation();
  },
  acc(elx) {
    if (!state.add) return;
    state.add.accountId = elx.dataset.id;
    rememberAccount(state.add.accountId);
    document.querySelectorAll('.chip[data-act="acc"]').forEach((n) => n.classList.toggle('is-on', n.dataset.id === state.add.accountId));
  },
  'acc-to'(elx) {
    if (!state.add) return;
    state.add.toAccountId = elx.dataset.id;
    document.querySelectorAll('.chip[data-act="acc-to"]').forEach((n) => n.classList.toggle('is-on', n.dataset.id === state.add.toAccountId));
  },
  async save() {
    await saveTransaction();
  },
  async 'del-editing'() {
    await deleteEditing();
  },

  // ------- 通用月份
  async month(elx) {
    state.month = S.addMonths(state.month, Number(elx.dataset.delta) || 0);
    if (location.hash.startsWith('#/list') || location.hash.startsWith('#/report')) await route();
    else location.hash = '#/list';
  },
  async 'month-today'() {
    state.month = todayMonth();
    await route();
  },
  'report-kind'(elx) {
    state.reportKind = elx.dataset.kind === 'income' ? 'income' : 'expense';
    route();
  },
  'trend-mode'(elx) {
    state.trendMode = elx.dataset.mode === 'line' ? 'line' : 'bars';
    route();
  },

  // ------- 明细
  'open-tx'(elx, e) {
    const row = elx.closest('.tx-row');
    if (row && row.classList.contains('is-swiped')) {
      row.classList.remove('is-swiped');
      e.preventDefault();
      return;
    }
    location.hash = `#/add?id=${encodeURIComponent(elx.dataset.id)}`;
  },
  async 'del-tx'(elx) {
    await askDeleteTx(elx.dataset.id);
  },

  // ------- 账本
  'ledger-new'() {
    ACT['ledger-add']();
  },
  'ledger-add'() {
    openForm({
      title: '新建账本',
      fields: [{ key: 'name', label: '账本名称', placeholder: '例如：家庭账本' }],
      values: { name: '' },
      onSubmit: async (v) => {
        if (!v.name) throw new Error('名字不能为空');
        const row = await store.createLedger({ name: v.name, currency: 'CNY' });
        closeSheet();
        setCurrentLedgerId(row.id);
        toast('账本已创建并切换');
        await refresh();
      },
    });
  },
  'ledger-switch'(elx) {
    if (!elx.dataset.id) {
      openLedgerMenu();
      return;
    }
    setCurrentLedgerId(elx.dataset.id);
    state.add = null;
    toast('已切换账本');
    refresh();
  },
  'ledger-edit'(elx) {
    const l = state.ledgers.find((x) => x.id === elx.dataset.id);
    if (!l) return;
    openForm({
      title: '重命名账本',
      fields: [{ key: 'name', label: '账本名称' }],
      values: { name: l.name },
      onSubmit: async (v) => {
        if (!v.name) throw new Error('名字不能为空');
        await store.updateLedger(l.id, { name: v.name });
        closeSheet();
        toast('已改名');
        await refresh();
      },
    });
  },
  async 'ledger-del'(elx) {
    const id = elx.dataset.id;
    if (state.ledgers.length <= 1) {
      toast('至少保留一个账本', 'error');
      return;
    }
    const l = state.ledgers.find((x) => x.id === id);
    const ok = await confirmDialog({
      title: '删除账本',
      message: `「${l ? l.name : ''}」会被标记删除，其中的账户/分类/交易不再显示。`,
      confirmText: '删除',
    });
    if (!ok) return;
    await store.deleteLedger(id);
    if (state.ledgerId === id) {
      const next = state.ledgers.find((x) => x.id !== id);
      setCurrentLedgerId(next ? next.id : '');
    }
    toast('已删除账本');
    await refresh();
  },

  // ------- 账户
  'acc-add'() {
    openForm({
      title: '新建账户',
      fields: [
        { key: 'name', label: '账户名称', placeholder: '例如：招商银行储蓄卡' },
        { key: 'type', label: '类型', type: 'select', options: ACCOUNT_TYPES, defaultValue: 'cash' },
        { key: 'initial', label: '初始余额（元，信用卡填负数表示欠款）', type: 'number', step: '0.01', defaultValue: '0' },
        { key: 'icon', label: '图标', type: 'emoji', defaultValue: '💳' },
      ],
      values: { type: 'cash', initial: '0', icon: '💳' },
      onSubmit: async (v) => {
        if (!v.name) throw new Error('名字不能为空');
        const cents = M.parseCents(v.initial || '0');
        if (Number.isNaN(cents)) throw new Error('余额数字不对');
        await store.createAccount({
          ledger_id: state.ledgerId,
          name: v.name,
          type: v.type,
          initial_cents: cents,
          balance_cents: cents,
          icon: v.icon || '💳',
          sort: Date.now(),
        });
        closeSheet();
        toast('账户已添加');
        await refresh();
      },
    });
  },
  'acc-edit'(elx) {
    const acc = state.accounts.find((a) => a.id === elx.dataset.id);
    if (!acc) return;
    openForm({
      title: '编辑账户',
      fields: [
        { key: 'name', label: '账户名称' },
        { key: 'type', label: '类型', type: 'select', options: ACCOUNT_TYPES },
        { key: 'initial', label: '初始余额（元）', type: 'number', step: '0.01' },
        { key: 'icon', label: '图标', type: 'emoji' },
      ],
      values: {
        name: acc.name,
        type: acc.type,
        initial: M.formatPlain(acc.initial_cents || 0),
        icon: acc.icon || '💳',
      },
      onSubmit: async (v) => {
        const cents = M.parseCents(v.initial || '0');
        if (Number.isNaN(cents)) throw new Error('余额数字不对');
        await store.updateAccount(acc.id, {
          name: v.name || acc.name,
          type: v.type,
          initial_cents: cents,
          icon: v.icon || acc.icon,
        });
        closeSheet();
        toast('账户已更新');
        await refresh();
      },
    });
  },
  async 'acc-del'(elx) {
    const acc = state.accounts.find((a) => a.id === elx.dataset.id);
    const ok = await confirmDialog({
      title: '删除账户',
      message: `「${acc ? acc.name : ''}」会被标记删除，历史交易仍保留但不再显示该账户。`,
      confirmText: '删除',
    });
    if (!ok) return;
    await store.deleteAccount(elx.dataset.id);
    toast('已删除账户');
    await refresh();
  },

  // ------- 分类
  'cat-add'(elx) {
    const kind = elx.dataset.kind === 'income' ? 'income' : 'expense';
    openForm({
      title: kind === 'income' ? '新增收入分类' : '新增支出分类',
      fields: [
        { key: 'name', label: '分类名称', placeholder: '例如：宠物' },
        { key: 'icon', label: '图标', type: 'emoji', defaultValue: '📦' },
      ],
      values: { icon: '📦' },
      onSubmit: async (v) => {
        if (!v.name) throw new Error('名字不能为空');
        const same = state.categories.filter((c) => c.kind === kind).length;
        await store.createCategory({
          ledger_id: state.ledgerId,
          name: v.name,
          kind,
          icon: v.icon || '📦',
          sort: same + 1,
        });
        closeSheet();
        toast('分类已添加');
        await refresh();
      },
    });
  },
  'cat-edit'(elx) {
    const cat = state.categories.find((c) => c.id === elx.dataset.id);
    if (!cat) return;
    openForm({
      title: '编辑分类',
      fields: [
        { key: 'name', label: '分类名称' },
        { key: 'icon', label: '图标', type: 'emoji' },
      ],
      values: { name: cat.name, icon: cat.icon || '📦' },
      onSubmit: async (v) => {
        await store.updateCategory(cat.id, { name: v.name || cat.name, icon: v.icon || cat.icon });
        closeSheet();
        toast('分类已更新');
        await refresh();
      },
    });
  },
  async 'cat-del'(elx) {
    const cat = state.categories.find((c) => c.id === elx.dataset.id);
    const ok = await confirmDialog({
      title: '删除分类',
      message: `「${cat ? cat.name : ''}」删除后，已有交易会显示为「未分类」。`,
      confirmText: '删除',
    });
    if (!ok) return;
    await store.deleteCategory(elx.dataset.id);
    toast('已删除分类');
    await refresh();
  },

  // ------- 标签
  'tag-toggle'(elx) {
    if (!state.add) return;
    const id = elx.dataset.id;
    const picked = addTagIds();
    const i = picked.indexOf(id);
    if (i >= 0) picked.splice(i, 1);
    else picked.push(id);
    const box = $('tag-section');
    if (box) box.innerHTML = tagChipsHtml();
  },
  'tag-new'() {
    openForm({
      title: '新建标签',
      fields: [
        { key: 'name', label: '标签名', placeholder: '例如：出差' },
        { key: 'color', label: '颜色', type: 'select', options: TAG_COLORS.map((c, i) => [c, `颜色 ${i + 1}`]) },
      ],
      values: { name: '', color: TAG_COLORS[0] },
      onSubmit: async (v) => {
        if (!v.name) throw new Error('标签名不能为空');
        const row = await store.createTag({ ledger_id: state.ledgerId, name: v.name, color: v.color || TAG_COLORS[0] });
        state.tags = await store.listTags(state.ledgerId);
        closeSheet();
        if (state.add) addTagIds().push(row.id);
        toast(`标签「${row.name}」已添加`);
        await route();
      },
    });
  },
  'tag-edit'(elx) {
    const tag = state.tags.find((t) => t.id === elx.dataset.id);
    if (!tag) return;
    openForm({
      title: '编辑标签',
      intro: `<button type="button" class="btn danger block" data-act="tag-del" data-id="${esc(tag.id)}">删除标签</button>`,
      fields: [
        { key: 'name', label: '标签名' },
        { key: 'color', label: '颜色', type: 'select', options: TAG_COLORS.map((c, i) => [c, `颜色 ${i + 1}`]) },
      ],
      values: { name: tag.name, color: tag.color || TAG_COLORS[0] },
      onSubmit: async (v) => {
        await store.updateTag(tag.id, { name: v.name || tag.name, color: v.color || tag.color });
        state.tags = await store.listTags(state.ledgerId);
        closeSheet();
        toast('标签已更新');
        await route();
      },
    });
  },
  async 'tag-del'(elx) {
    const tag = state.tags.find((t) => t.id === elx.dataset.id);
    const ok = await confirmDialog({
      title: '删除标签',
      message: `「${tag ? tag.name : ''}」会从所有交易上摘掉，交易本身不受影响。`,
      confirmText: '删除',
    });
    if (!ok) return;
    await store.deleteTag(elx.dataset.id);
    state.tags = await store.listTags(state.ledgerId);
    if (state.add) state.add.tagIds = addTagIds().filter((id) => id !== elx.dataset.id);
    toast('已删除标签');
    await route();
  },
  'reimburse-toggle'() {
    if (!state.add) return;
    state.add.reimburse = !state.add.reimburse;
    const box = $('tag-section');
    if (box) box.innerHTML = tagChipsHtml();
  },

  // ------- 明细长按菜单 / 报销
  'tx-menu'(elx) {
    openTxMenu(elx.dataset.id);
  },
  async 'tx-mark-pending'(elx) {
    await markPending(elx.dataset.id);
  },
  'tx-do-reimburse'(elx) {
    openReimburseSheet(elx.dataset.id);
  },
  async 'tx-delete'(elx) {
    closeSheet();
    await askDeleteTx(elx.dataset.id);
  },

  // ------- 报表控件
  async 'report-preset'(elx) {
    const preset = elx.dataset.preset || 'month';
    state.report.preset = preset;
    if (preset !== 'custom') {
      state.report.from = '';
      state.report.to = '';
    } else {
      const r = reportRange();
      state.report.from = r.from;
      state.report.to = r.to;
    }
    await route();
  },
  async 'report-donut'(elx) {
    state.report.donut = elx.dataset.donut || 'category';
    await route();
  },
  async 'report-donut-kind'(elx) {
    state.report.donutKind = (elx.dataset.donutkind || elx.dataset.donutKind) === 'income' ? 'income' : 'expense';
    await route();
  },
  async 'report-granularity'(elx) {
    const g = elx.dataset.granularity || 'day';
    state.report.granularity = ['day', 'week', 'month'].includes(g) ? g : 'day';
    await route();
  },
  async 'report-series'(elx) {
    state.report.series = elx.dataset.series === 'income' ? 'income' : 'expense';
    await route();
  },
  async 'ledger-pick'(elx) {
    const id = elx.dataset.id;
    if (!id) return;
    closeSheet();
    setCurrentLedgerId(id);
    state.add = null;
    state.openHidden = false;
    await refresh();
  },
  'member-select'(elx) {
    if (!state.add) return;
    state.add.memberId = elx.dataset.memberId || null;
    const row = elx.parentElement;
    if (row) {
      row
        .querySelectorAll('[data-act="member-select"]')
        .forEach((node) => node.classList.toggle('is-on', node === elx));
    }
  },
  'member-add'(elx) {
    if (elx && elx.closest && elx.closest('#add-body')) {
      openMemberForm(null, { select: true });
      return;
    }
    openMemberForm(null);
  },
  'member-edit'(elx) {
    openMemberForm(elx.dataset.id);
  },
  async 'member-del'(elx) {
    const id = elx.dataset.id;
    const row = memberById(id);
    const ok = await confirmDialog({
      title: '删除成员',
      message: `「${row ? row.name : ''}」会被删除，TA 名下的记录会改成默认成员。`,
      confirmText: '删除',
    });
    if (!ok) return;
    await store.deleteMember(id);
    toast('成员已删除');
    await refresh();
  },
  async 'asset-group-toggle'(elx) {
    const key = elx.dataset.key;
    const collapsed = toggleAssetList('collapsed', key).includes(key);
    elx.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    const group = elx.closest('.asset-group');
    if (group) {
      group.classList.toggle('is-collapsed', collapsed);
      const body = group.querySelector('.group-body');
      if (body) {
        if (collapsed) {
          body.dataset.saved = body.innerHTML;
          body.innerHTML = '';
        } else if (typeof body.dataset.saved === 'string') {
          body.innerHTML = body.dataset.saved;
          delete body.dataset.saved;
        }
      }
    }
  },
  async 'asset-group-hide'(elx) {
    const key = elx.dataset.key;
    // 先清空本组行，保证任何持有旧元素的引用都能立刻看到「行消失」
    const group = elx.closest('.asset-group');
    const body = group && group.querySelector('.group-body');
    if (body) body.innerHTML = '';
    toggleAssetList('hidden', key);
    state.openHidden = false;
    await route();
    toast('已隐藏该组，点「N 个隐藏账户」可恢复');
  },
  async 'toggle-hidden-accounts'() {
    state.openHidden = !state.openHidden;
    await route();
  },
  'account-add'() {
    ACT['asset-add']();
  },
  'report-anchor'(elx) {
    const node = document.getElementById(elx.dataset.target || '');
    if (node) node.scrollIntoView({ block: 'start', behavior: 'smooth' });
  },
  async 'filter-open'(elx) {
    openFilterSheet(elx.dataset.target === 'report' ? 'report' : 'list');
  },
  async 'filter-clear'(elx) {
    const target = elx.dataset.target === 'report' ? 'report' : 'list';
    const base = target === 'report' ? state.report : state.listFilter;
    Object.assign(base, {
      preset: 'month',
      from: '',
      to: '',
      type: '',
      account_id: '',
      category_id: '',
      tag_id: '',
      q: '',
      min_cents: null,
      max_cents: null,
    });
    await route();
  },

  // ------- 资产
  'asset-add'() {
    openForm({
      title: '新建账户',
      fields: [
        { key: 'name', label: '账户名称', placeholder: '例如：招商银行储蓄卡' },
        { key: 'type', label: '类型', type: 'select', options: ACCOUNT_TYPES },
        { key: 'kind', label: '所属', type: 'select', options: Object.entries(KIND_LABEL) },
        { key: 'limit', label: '额度（元，信用卡填）', type: 'number', step: '0.01', min: '0' },
        { key: 'bill_day', label: '账单日（1-31，信用卡填）', type: 'number', min: '1', max: '31', step: '1' },
        { key: 'repay_day', label: '还款日（1-31，信用卡填）', type: 'number', min: '1', max: '31', step: '1' },
        { key: 'initial', label: '初始余额（元，负债填负数）', type: 'number', step: '0.01' },
        { key: 'net', label: '计入净值', type: 'select', options: [['1', '计入'], ['0', '不计入']] },
        { key: 'icon', label: '图标', type: 'emoji', defaultValue: '💳' },
      ],
      values: { type: 'cash', kind: 'asset', net: '1', icon: '💳' },
      onSubmit: async (v) => {
        if (!v.name) throw new Error('账户名不能为空');
        const initial = v.initial ? M.parseCents(v.initial) : 0;
        const limit = v.limit ? M.parseCents(v.limit) : 0;
        if (Number.isNaN(initial) || Number.isNaN(limit)) throw new Error('金额数字不对');
        const credit = isCreditAccount(v.type);
        await store.createAccount({
          ledger_id: state.ledgerId,
          name: v.name,
          type: v.type,
          kind: v.kind || TYPE_TO_KIND[v.type] || 'asset',
          icon: v.icon || '💳',
          initial_cents: initial,
          balance_cents: initial,
          credit_limit_cents: credit ? limit : 0,
          bill_day: credit ? Number(v.bill_day) || 0 : 0,
          repay_day: credit ? Number(v.repay_day) || 0 : 0,
          include_in_net: v.net !== '0',
        });
        closeSheet();
        toast('账户已创建');
        await refresh();
      },
    });
    wireCreditFields($('sheet-form'));
  },
  'asset-edit'(elx) {
    const acc = state.accounts.find((a) => a.id === elx.dataset.id);
    if (!acc) return;
    openForm({
      title: '编辑账户',
      intro: `<div class="btn-col" style="margin-bottom:10px">
        <button type="button" class="btn" data-act="asset-adjust" data-id="${esc(acc.id)}">调整余额</button>
        <button type="button" class="btn danger" data-act="asset-del" data-id="${esc(acc.id)}">删除账户</button>
      </div>`,
      fields: [
        { key: 'name', label: '账户名称' },
        { key: 'type', label: '类型', type: 'select', options: ACCOUNT_TYPES },
        { key: 'kind', label: '所属', type: 'select', options: Object.entries(KIND_LABEL) },
        { key: 'limit', label: '额度（元）', type: 'number', step: '0.01', min: '0' },
        { key: 'bill_day', label: '账单日（1-31）', type: 'number', min: '1', max: '31', step: '1' },
        { key: 'repay_day', label: '还款日（1-31）', type: 'number', min: '1', max: '31', step: '1' },
        { key: 'initial', label: '初始余额（元）', type: 'number', step: '0.01' },
        { key: 'net', label: '计入净值', type: 'select', options: [['1', '计入'], ['0', '不计入']] },
        { key: 'icon', label: '图标', type: 'emoji' },
      ],
      values: {
        name: acc.name,
        type: acc.type,
        kind: acc.kind || 'asset',
        limit: acc.credit_limit_cents ? M.formatPlain(acc.credit_limit_cents) : '',
        bill_day: acc.bill_day ? String(acc.bill_day) : '',
        repay_day: acc.repay_day ? String(acc.repay_day) : '',
        initial: M.formatPlain(acc.initial_cents || 0),
        net: acc.include_in_net === false ? '0' : '1',
        icon: acc.icon || '💳',
      },
      onSubmit: async (v) => {
        const initial = v.initial ? M.parseCents(v.initial) : 0;
        const limit = v.limit ? M.parseCents(v.limit) : 0;
        if (Number.isNaN(initial) || Number.isNaN(limit)) throw new Error('金额数字不对');
        const credit = isCreditAccount(v.type);
        await store.updateAccount(acc.id, {
          name: v.name || acc.name,
          type: v.type,
          kind: v.kind || 'asset',
          icon: v.icon || acc.icon,
          initial_cents: initial,
          balance_cents: initial,
          credit_limit_cents: credit ? limit : 0,
          bill_day: credit ? Number(v.bill_day) || 0 : 0,
          repay_day: credit ? Number(v.repay_day) || 0 : 0,
          include_in_net: v.net !== '0',
        });
        closeSheet();
        toast('账户已更新');
        await refresh();
      },
    });
    wireCreditFields($('sheet-form'));
  },
  'asset-adjust'(elx) {
    const acc = state.accounts.find((a) => a.id === elx.dataset.id);
    if (!acc) return;
    openForm({
      title: `调整余额 · ${acc.name}`,
      intro: `<p class="hint">把余额直接改成你要的数字，会补一条「余额调整」流水（不计收支），历史交易不动。当前余额 ¥${fmt(acc.balance_cents || 0)}。</p>`,
      fields: [
        { key: 'target', label: '调整后余额（元）', type: 'number', step: '0.01' },
        { key: 'note', label: '备注', placeholder: '例如：对账修正' },
        { key: 'date', label: '日期', type: 'date' },
      ],
      values: { target: M.formatPlain(acc.balance_cents || 0), note: '余额调整', date: S.todayISO() },
      submitText: '调整',
      onSubmit: async (v) => {
        const target = M.parseCents(v.target || '0');
        if (Number.isNaN(target)) throw new Error('金额数字不对');
        await store.adjustAccount(acc.id, target, v.note || '余额调整', v.date || S.todayISO());
        closeSheet();
        toast('余额已调整');
        await refresh();
      },
    });
  },
  async 'asset-del'(elx) {
    const acc = state.accounts.find((a) => a.id === elx.dataset.id);
    const ok = await confirmDialog({
      title: '删除账户',
      message: `「${acc ? acc.name : ''}」会被标记删除，历史交易仍保留但不再显示该账户。`,
      confirmText: '删除',
    });
    if (!ok) return;
    closeSheet();
    await store.deleteAccount(elx.dataset.id);
    toast('已删除账户');
    await refresh();
  },

  // ------- 周期记账
  'rec-add'() {
    openRecurringForm(null);
  },
  'rec-edit'(elx) {
    openRecurringForm(elx.dataset.id);
  },
  async 'rec-pause'(elx) {
    const rule = (state.recurring || []).find((r) => r.id === elx.dataset.id);
    if (!rule) return;
    const next = rule.enabled ? 0 : 1;
    try {
      await store.saveRecurring({ id: rule.id, enabled: next });
    } catch (err) {
      toast(err && err.message ? err.message : '操作失败', 'error');
      return;
    }
    closeSheet();
    state.recurring = await store.listRecurring(state.ledgerId);
    toast(next ? '已恢复' : '已暂停，随时可以再打开');
    await route();
  },
  async 'rec-del'(elx) {
    const ok = await confirmDialog({
      title: '删除周期规则',
      message: '只删规则，已经补出来的交易不会动。',
      confirmText: '删除',
    });
    if (!ok) return;
    closeSheet();
    await store.deleteRecurring(elx.dataset.id);
    state.recurring = await store.listRecurring(state.ledgerId);
    toast('规则已删除');
    await route();
  },
  async 'rec-run'() {
    const res = await store.runRecurring(S.todayISO()).catch((err) => {
      toast(err && err.message ? err.message : '补记失败', 'error');
      return null;
    });
    if (!res) return;
    const created = (res.created || []).length;
    const skipped = (res.skipped || []).length;
    toast(created ? `已补记 ${created} 笔${skipped ? `，跳过 ${skipped} 笔` : ''}` : skipped ? `没有新交易，跳过 ${skipped} 笔` : '没有到期的规则');
    await refresh();
  },
  // ------- 预算
  async 'budget-save'() {
    const month = todayMonth();
    const totalInput = document.querySelector('[data-budget="total"]');
    const unallocInput = document.querySelector('[data-budget="unallocated"]');
    const catInputs = Array.from(document.querySelectorAll('[data-budget]')).filter(
      (n) => n.dataset.budget !== 'total' && n.dataset.budget !== 'unallocated',
    );
    const rolls = new Map(
      Array.from(document.querySelectorAll('[data-roll]')).map((node) => [node.dataset.roll, node.checked ? 1 : 0]),
    );
    const warnInput = document.querySelector('[data-warn-percent]');
    let warnPercent = null;
    if (warnInput) {
      warnPercent = Math.round(Number(warnInput.value) || 0);
      if (!(warnPercent >= 1 && warnPercent <= 100)) {
        toast('预警阈值要是 1–100 的数字', 'error');
        return;
      }
    }
    const parse = (input) => {
      const raw = input.value.trim();
      const cents = raw === '' ? 0 : M.parseCents(raw);
      return Number.isNaN(cents) ? null : cents;
    };

    const view = await store.budgetUsage(state.ledgerId, month).catch(() => null);
    const beforeUnalloc = view ? Math.round(Number(view.unallocated_cents) || 0) : 0;
    const baseAmount = view ? Math.round(Number(view.amount_cents) || 0) : 0;
    let catSaved = 0;
    try {
      for (const input of catInputs) {
        const cents = parse(input);
        if (cents == null) {
          toast(`「${input.value.trim()}」不是有效金额`, 'error');
          return;
        }
        const key = input.dataset.budget;
        await store.setBudget({
          ledger_id: state.ledgerId,
          month,
          category_id: key,
          amount_cents: cents,
          rollover: rolls.get(key) ? 1 : 0,
        });
        catSaved += 1;
      }
      // 等式模型：改「未分配」→ 总预算 = Σ + 未分配；否则按总预算输入保存
      const unallocCents = unallocInput ? parse(unallocInput) : null;
      const totalCents = totalInput ? parse(totalInput) : null;
      if (unallocCents == null || totalCents == null) {
        toast('金额格式不对', 'error');
        return;
      }
      const unallocChanged = unallocCents !== beforeUnalloc;
      const patch = {
        ledger_id: state.ledgerId,
        month,
        category_id: null,
        rollover: rolls.get('total') ? 1 : 0,
        warn_percent: warnPercent == null ? undefined : warnPercent,
      };
      if (unallocChanged) {
        await store.setBudget({ ...patch, unallocated_cents: unallocCents });
      } else if (totalCents !== baseAmount || !view || !view.has_budget || catSaved) {
        await store.setBudget({ ...patch, amount_cents: totalCents });
      }
    } catch (err) {
      if (err && err.code === 'budget_below_allocated') {
        openBudgetConflict(err.details);
        return;
      }
      toast(err && err.message ? err.message : '保存失败', 'error');
      return;
    }
    const after = await store.budgetUsage(state.ledgerId, month).catch(() => null);
    if (after && after.has_budget) {
      toast(`预算已保存 · 未分配 ¥${fmt(after.unallocated_cents)}`);
    } else {
      toast('预算已保存');
    }
    await route();
  },
  async 'budget-enable-on'() {
    try {
      await store.setBudget({ ledger_id: state.ledgerId, month: todayMonth(), enabled: 1 });
      toast('预算已开启');
    } catch (err) {
      toast(err && err.message ? err.message : '开启失败', 'error');
      return;
    }
    await route();
  },
  async 'budget-align'() {
    const month = todayMonth();
    const view = await store.budgetUsage(state.ledgerId, month).catch(() => null);
    if (!view) return;
    try {
      await store.setBudget({
        ledger_id: state.ledgerId,
        month,
        category_id: null,
        amount_cents: view.categories_sum_cents,
        rebalance: false,
        warn_percent: view.warn_percent,
      });
    } catch (err) {
      toast(err && err.message ? err.message : '对齐失败', 'error');
      return;
    }
    toast(`已对齐到明细合计 ¥${fmt(view.categories_sum_cents)}`);
    await route();
  },
  async 'budget-expand'() {
    const c = pendingBudgetConflict;
    closeSheet();
    if (!c) return;
    await store.setBudget({
      ledger_id: state.ledgerId,
      month: todayMonth(),
      category_id: null,
      amount_cents: c.sumCents,
    });
    toast(`总预算已提到 ¥${fmt(c.sumCents)}，未分配 ¥0.00`);
    await route();
  },
  async 'budget-rebalance'() {
    const c = pendingBudgetConflict;
    closeSheet();
    if (!c) return;
    try {
      await store.setBudget({
        ledger_id: state.ledgerId,
        month: todayMonth(),
        category_id: null,
        amount_cents: c.totalCents,
        rebalance: true,
      });
    } catch (err) {
      toast(err && err.message ? err.message : '压缩失败', 'error');
      return;
    }
    toast(`已按比例压缩明细到 ¥${fmt(c.totalCents)}`);
    await route();
  },
  async 'budget-clear-cats'() {
    const month = todayMonth();
    const ok = await confirmDialog({
      title: '清空明细预算',
      message: '会删掉本月所有分类预算，总预算保留。',
      confirmText: '清空',
    });
    if (!ok) return;
    const view = await store.budgetUsage(state.ledgerId, month).catch(() => null);
    if (!view) return;
    const totalAmount = view.amount_cents;
    for (const item of view.items) {
      await store.setBudget({ ledger_id: state.ledgerId, month, category_id: item.category_id, amount_cents: 0 });
    }
    if (totalAmount > 0) {
      await store.setBudget({
        ledger_id: state.ledgerId,
        month,
        category_id: null,
        amount_cents: totalAmount,
        warn_percent: view.warn_percent,
      });
    }
    toast('已清空明细预算');
    await route();
  },
  async 'budget-strip-toggle'() {
    const next = readBudgetStripOpen() ? '0' : '1';
    try {
      localStorage.setItem(BUDGET_STRIP_KEY, next);
    } catch (err) {
      /* 隐私模式忽略 */
    }
    const node = document.querySelector('[data-block="budget-strip"]');
    if (!node) return;
    const host = document.createElement('div');
    host.innerHTML = await budgetStripHtml();
    const fresh = host.firstElementChild;
    if (fresh) node.replaceWith(fresh);
  },
  'budget-strip-go'() {
    go('#/me/budgets');
  },

  // ------- 数据
  async 'export-run'() {
    await exportRun();
  },
  async 'export-json'() {
    await exportJson();
  },
  async 'export-csv'() {
    await exportCsv();
  },
  async 'export-mint'() {
    await exportMint();
  },
  async 'import-pick'() {
    await importPick();
  },
  'import-json'() {
    importPick();
  },
  async 'clear-samples'() {
    const ok = await confirmDialog({
      title: '清空示例数据',
      message: '只会删除带「示例」标记的交易，自己记的记录不受影响。',
      confirmText: '清空',
    });
    if (!ok) return;
    const n = await store.clearSampleData();
    toast(n ? `已清空 ${n} 条示例` : '没有示例数据了');
    await refresh();
  },
  async 'reset-local'() {
    const ok = await confirmDialog({
      title: '清空全部本地数据',
      message: '会删掉 IndexedDB 里所有账本、账户、分类、交易、预算，只保留设置页的服务器配置。建议先导出 JSON 备份。',
      confirmText: '我要清空',
    });
    if (!ok) return;
    const local = getLocalStore();
    await local.init();
    await local.clearAll();
    await seedDefaults(store);
    setCurrentLedgerId('');
    state.add = null;
    state.month = todayMonth();
    toast('已重置为初始数据');
    await refresh();
  },

  // ------- 云同步
  'sync-mode'(elx) {
    const mode = elx.value === 'server' ? 'server' : 'local';
    saveSettings({ mode });
    toast(mode === 'server' ? '已切到服务器模式，正在连接…' : '已切回本地模式');
    initStore({ force: true, mode })
      .then(async () => {
        await loadCore();
        await route();
        toast(mode === 'server' ? '服务器模式已生效' : '本地模式已生效');
      })
      .catch(async (err) => {
        saveSettings({ mode: 'local' });
        await initStore({ force: true, mode: 'local' });
        await loadCore();
        await route();
        toast(err && err.message ? err.message : '切换失败，已回到本地模式', 'error');
      });
  },
  async 'sync-save'() {
    const baseUrl = ($('sync-base') || {}).value || DEFAULT_BASE_URL;
    const username = ($('sync-user') || {}).value || '';
    saveSettings({ baseUrl: baseUrl.replace(/\/+$/, ''), username });
    pushLog(`保存设置 baseUrl=${baseUrl}`);
    toast('已保存');
  },
  async 'sync-test'() {
    const baseUrl = (($('sync-base') || {}).value || '').replace(/\/+$/, '');
    if (!baseUrl) {
      toast('先填服务器地址', 'error');
      return;
    }
    try {
      const res = await fetch(`${baseUrl}/api/v1/health`);
      const data = await res.json();
      pushLog(`/health → ${res.status} ${JSON.stringify(data)}`);
      toast(data && data.ok ? `连接正常（v${data.version || '?'}）` : '服务器返回异常', data && data.ok ? 'info' : 'error');
    } catch (err) {
      pushLog(`/health 失败：${err.message}`);
      toast('连不上，检查地址和局域网', 'error');
    }
    await route();
  },
  async 'sync-login'() {
    const baseUrl = (($('sync-base') || {}).value || '').replace(/\/+$/, '');
    const username = ($('sync-user') || {}).value || '';
    const password = ($('sync-pass') || {}).value || '';
    if (!baseUrl || !username || !password) {
      toast('地址 / 用户名 / 密码都要填', 'error');
      return;
    }
    try {
      const data = await apiLogin(baseUrl, username, password);
      saveSettings({ baseUrl, username, token: data.token || '' });
      pushLog(`登录成功 uid=${(data.user && data.user.id) || '?'}`);
      toast('登录成功，token 已保存');
    } catch (err) {
      pushLog(`登录失败：${err.message}`);
      toast(err.message || '登录失败', 'error');
    }
    await route();
  },
  async 'sync-register'() {
    const baseUrl = (($('sync-base') || {}).value || '').replace(/\/+$/, '');
    const username = ($('sync-user') || {}).value || '';
    const password = ($('sync-pass') || {}).value || '';
    if (!baseUrl || !username || !password) {
      toast('地址 / 用户名 / 密码都要填', 'error');
      return;
    }
    try {
      const data = await apiRegister(baseUrl, username, password);
      saveSettings({ baseUrl, username, token: data.token || '' });
      pushLog(`注册成功 user=${username}`);
      toast('注册成功，token 已保存');
    } catch (err) {
      pushLog(`注册失败：${err.message}`);
      toast(err.message || '注册失败', 'error');
    }
    await route();
  },
  async 'sync-push'() {
    await runSync('push');
  },
  async 'sync-pull'() {
    await runSync('pull');
  },
};

async function runSync(direction) {
  if (state.syncing) return;
  const s = getSettings();
  const baseUrl = (($('sync-base') || {}).value || s.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) {
    toast('先填服务器地址', 'error');
    return;
  }
  if (!s.token && !($('sync-pass') || {}).value) {
    toast('先登录拿 token', 'error');
    return;
  }
  state.syncing = true;
  const btnLabel = direction === 'push' ? '上传' : '拉取';
  pushLog(`开始${btnLabel}…`);
  try {
    let token = s.token;
    if (!token) {
      const data = await apiLogin(baseUrl, ($('sync-user') || {}).value || '', ($('sync-pass') || {}).value || '');
      token = data.token;
      saveSettings({ token, baseUrl });
    }
    const api = new ApiStore({ baseUrl, token });
    await api.init();
    const local = getLocalStore();
    await local.init();

    if (direction === 'push') {
      const keys = ['ledgers', 'accounts', 'categories', 'transactions', 'budgets'];
      let dump = await local.exportAll(state.ledgerId || undefined);
      // 刚从本地模式切到服务器模式时，state.ledgerId 是服务器账本 id，本地库里找不到它：
      // 这时退化成「上传本地全部账本」，否则用户会以为按钮没生效（全部 0 条）。
      if (!keys.some((k) => (dump[k] || []).length)) {
        dump = await local.exportAll(undefined);
        pushLog('  本地按当前账本 id 没找到数据，改为上传本地全部账本');
      }
      const plan = [
        ['ledgers', '/ledgers'],
        ['accounts', '/accounts'],
        ['categories', '/categories'],
        ['transactions', '/transactions'],
        ['budgets', '/budgets'],
      ];
      for (const [key, endpoint] of plan) {
        const rows = dump[key] || [];
        let ok = 0;
        let bad = 0;
        for (const row of rows) {
          try {
            if (key === 'budgets') {
              await api.request('PUT', endpoint, { body: row });
            } else {
              try {
                await api.request('POST', endpoint, { body: row });
              } catch (err) {
                if (err.status === 409 || err.status === 400 || err.status === 422) {
                  await api.request('PATCH', `${endpoint}/${encodeURIComponent(row.id)}`, { body: row });
                } else {
                  throw err;
                }
              }
            }
            ok += 1;
          } catch (err) {
            bad += 1;
            if (bad <= 3) pushLog(`  ${key} 失败：${err.message}`);
          }
        }
        pushLog(`  ${key}: 成功 ${ok} / 失败 ${bad}`);
      }
      toast('上传完成，详情看日志');
    } else {
      const remote = await api.pullAll(state.ledgerId || undefined);
      const merged = {
        ledgers: remote.ledgers || [],
        accounts: remote.accounts || [],
        categories: remote.categories || [],
        transactions: remote.transactions || [],
        budgets: remote.budgets || [],
      };
      const counts = await local.importAll(null, merged);
      pushLog(
        `  拉到 账本${merged.ledgers.length} 账户${merged.accounts.length} 分类${merged.categories.length} 交易${merged.transactions.length}`,
      );
      pushLog(`  合并：写入 ${counts.transactions + counts.accounts + counts.categories + counts.budgets} 条，跳过旧数据 ${counts.skipped} 条`);
      toast('拉取完成（updated_at 新者胜）');
    }
    await loadCore();
    await route();
  } catch (err) {
    pushLog(`失败：${err && err.message ? err.message : String(err)}`);
    toast(err && err.message ? err.message : '同步失败', 'error');
    await route();
  } finally {
    state.syncing = false;
  }
}

function onClick(e) {
  if (Date.now() < suppressClickUntil) {
    const hit = e.target.closest('[data-act]');
    if (hit && hit.dataset.act === 'open-tx') {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
  }
  const target = e.target.closest('[data-act]');
  if (!target) return;
  const act = target.dataset.act;
  if (act === 'sync-mode') return; // radio 用 change 事件
  const handler = ACT[act];
  if (!handler) return;
  e.preventDefault();
  try {
    const out = handler(target, e);
    if (out && typeof out.catch === 'function') {
      out.catch((err) => toast(err && err.message ? err.message : '操作失败', 'error'));
    }
  } catch (err) {
    toast(err && err.message ? err.message : '操作失败', 'error');
  }
}

function onInput(e) {
  const field = e.target.closest('[data-field]');
  if (!field || !state.add) return;
  if (field.dataset.field === 'note') {
    state.add.note = field.value;
  } else if (field.dataset.field === 'date') {
    state.add.date = field.value || todayISO();
  }
}

async function onChange(e) {
  const modeRadio = e.target.closest('[data-act="sync-mode"]');
  if (modeRadio) {
    ACT['sync-mode'](modeRadio);
    return;
  }
  const recToggle = e.target.closest('[data-act="rec-toggle"]');
  if (recToggle) {
    const id = recToggle.dataset.id;
    const on = recToggle.checked;
    try {
      await store.saveRecurring({ id, enabled: on ? 1 : 0 });
      state.recurring = await store.listRecurring(state.ledgerId);
      toast(on ? '已恢复' : '已暂停，随时可以再打开');
      await route();
    } catch (err) {
      recToggle.checked = !on;
      toast(err && err.message ? err.message : '切换失败', 'error');
    }
    return;
  }
  const budgetSwitch = e.target.closest('[data-act="budget-enable"]');
  if (budgetSwitch) {
    // 保存期间忽略后续抖动（有的测试会 dispatch change 后再 click，避免两次写互相覆盖）
    if (budgetSwitchBusy) return;
    budgetSwitchBusy = true;
    const on = budgetSwitch.checked;
    try {
      await store.setBudget({ ledger_id: state.ledgerId, month: todayMonth(), enabled: on ? 1 : 0 });
      toast(on ? '预算已开启' : '预算已关闭，数据都保留着');
      await route();
    } catch (err) {
      budgetSwitch.checked = !on;
      toast(err && err.message ? err.message : '切换失败', 'error');
    } finally {
      budgetSwitchBusy = false;
    }
    return;
  }
  const rangeInput = e.target.closest('[data-range]');
  if (rangeInput) {
    const key = rangeInput.dataset.range === 'to' ? 'to' : 'from';
    const target = location.hash.startsWith('#/list') ? state.listFilter : state.report;
    target[key] = rangeInput.value || '';
    if (target === state.report) state.report.preset = 'custom';
    await route();
    return;
  }
  const field = e.target.closest('[data-field]');
  if (field && state.add) {
    if (field.dataset.field === 'date') state.add.date = field.value || todayISO();
    if (field.dataset.field === 'note') state.add.note = field.value;
  }
  if (e.target.id === 'import-file') {
    handleImportFile(e.target);
  }
  const emojiBtn = e.target.closest('[data-emoji]');
  if (emojiBtn) {
    const form = document.getElementById('sheet-form');
    if (form) {
      const input = form.querySelector('[name="icon"]');
      if (input) input.value = emojiBtn.dataset.emoji;
    }
  }
}

async function handleImportFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const sel = $('import-format');
  const want = sel ? sel.value : 'auto';
  let plan;
  let text = '';
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    text = X.decodeBytes(bytes).text;
    plan = await planImport(text, bytes, want);
  } catch (err) {
    toast(`导入失败：${err && err.message ? err.message : err}`, 'error');
    input.value = '';
    return;
  }
  const fmtLabel = { mint: '薄荷记账', csv: '本 App CSV', json: 'JSON 备份' }[plan.fmt] || plan.fmt;
  if (!plan.created && !plan.skipped) {
    toast('没有可导入的记录');
    input.value = '';
    return;
  }
  const detail = [
    `识别为${fmtLabel}`,
    plan.created ? `将导入 ${plan.created} 条` : '没有新记录',
    plan.skipped ? `跳过 ${plan.skipped} 条（文件里已有的记录）` : '',
    plan.accounts_created ? `新建 ${plan.accounts_created} 个账户` : '',
    plan.categories_created ? `新建 ${plan.categories_created} 个分类` : '',
    plan.members_created ? `新建 ${plan.members_created} 个成员` : '',
    plan.tags_created ? `新建 ${plan.tags_created} 个标签` : '',
    plan.warnings && plan.warnings.length ? `${plan.warnings.length} 条警告` : '',
  ]
    .filter(Boolean)
    .join('，');
  const goOn = await confirmDialog({
    title: '确认导入',
    message: `${detail}。导入不会覆盖已有记录，重复导入同一文件会自动跳过。`,
    confirmText: '开始导入',
    danger: false,
  });
  if (!goOn) {
    input.value = '';
    return;
  }
  try {
    const mode = getSettings().mode;
    if (mode === 'server' && typeof store.importText === 'function') {
      const res = await store.importText(state.ledgerId, {
        format: plan.fmt,
        data: plan.fmt === 'json' ? plan.json : text,
      });
      toast(`服务器已导入 ${res && res.created != null ? res.created : plan.created} 条`);
    } else if (plan.fmt === 'json') {
      const counts = await store.importAll(state.ledgerId, plan.json);
      toast(`导入完成：交易 ${counts.transactions}，账户 ${counts.accounts}，分类 ${counts.categories}`);
    } else {
      await store.importAll(state.ledgerId, plan.payload);
      toast(importSummaryText(plan));
    }
    await refresh();
    await route();
  } catch (err) {
    toast(`导入失败：${err && err.message ? err.message : err}`, 'error');
  } finally {
    input.value = '';
  }
}

// emoji 面板用 click（input 的 change 不冒泡到 emoji 按钮）
document.addEventListener('click', (e) => {
  const emojiBtn = e.target.closest('[data-emoji]');
  if (!emojiBtn) return;
  e.preventDefault();
  const form = document.getElementById('sheet-form');
  if (!form) return;
  const input = form.querySelector('[name="icon"]');
  if (input) input.value = emojiBtn.dataset.emoji;
});

// ------------------------------------------------------------ 引导

const ONBOARD_STEPS = [
  {
    emoji: '🌿',
    title: '欢迎用丁点记账',
    desc: '这是一款<b>离线优先</b>的记账 PWA：数据存在本机 IndexedDB，断网、飞行模式都能记账。不联网也能打开。',
  },
  {
    emoji: '🧮',
    title: '键盘能算数',
    desc: '金额框支持 <code>12.5+3×2</code>、<code>(100-20)÷4</code>，按 <code>=</code> 出结果。金额一律按「分」整数计算，<code>0.1+0.2</code> 就是 <code>0.30</code>。',
  },
  {
    emoji: '☁️',
    title: '想多设备同步？',
    desc: `在「我的 → 云同步设置」里填服务器地址 <code>${esc(DEFAULT_BASE_URL)}</code> 登录即可。平时不用管，本地模式已经够用。`,
  },
];

let obStep = 0;

function showOnboard(step = 0) {
  obStep = step;
  const s = ONBOARD_STEPS[obStep];
  el.onboard.innerHTML = `<div class="ob-card">
    <div class="ob-emoji">${s.emoji}</div>
    <div class="ob-title">${s.title}</div>
    <div class="ob-desc">${s.desc}</div>
    <div class="ob-dots">${ONBOARD_STEPS.map((_, i) => `<i class="${i === obStep ? 'is-on' : ''}"></i>`).join('')}</div>
    <div class="ob-actions">
      ${obStep < ONBOARD_STEPS.length - 1
        ? '<button class="btn" data-act="ob-skip">跳过</button><button class="btn primary" data-act="ob-next">下一步</button>'
        : '<button class="btn" data-act="ob-skip">跳过</button><button class="btn primary" data-act="ob-next">开始记账</button>'}
    </div>
  </div>`;
  el.onboard.classList.add('is-open');
}

function hideOnboard() {
  el.onboard.classList.remove('is-open');
  el.onboard.innerHTML = '';
  try {
    localStorage.setItem('mintlite:onboarded', '1');
  } catch {
    /* 忽略 */
  }
}

ACT['ob-next'] = () => {
  if (obStep < ONBOARD_STEPS.length - 1) showOnboard(obStep + 1);
  else hideOnboard();
};
ACT['ob-skip'] = () => hideOnboard();

// ------------------------------------------------------------ 启动

async function boot() {
  el.view = $('view');
  el.tabbar = $('tabbar');
  el.toast = $('toast');
  el.sheet = $('sheet-root');
  el.onboard = $('onboard');

  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  initGestures();
  window.addEventListener('hashchange', () => {
    route();
  });

  renderTabbar('add');

  const settings = getSettings();
  try {
    await initStore({ force: true });
  } catch (err) {
    saveSettings({ mode: 'local' });
    await initStore({ force: true, mode: 'local' });
    toast(`服务器模式连不上，已切回本地（${err.message || ''}）`, 'error');
  }

  // 本地库被另一个标签页升级/关闭时，store-local 会自己重连；这里只负责告诉用户一声，
  // 免得他在旧页面上看到「保存失败」却不知道为什么。
  if (store.mode === 'local' && store.instance) {
    store.instance.onReconnect = () => {
      toast('另一个标签页升级了数据版本，本页已自动重连；建议刷新一下', 'error', {
        fn: () => location.reload(),
      });
    };
  }

  try {
    if (store.mode === 'server') {
      // 服务器没有 /meta，无法用 seeded 标记判重：只在账号下真的一本账本都没有时 seed 一次
      const existing = await store.listLedgers();
      if (!existing.length) await seedDefaults(store, { reason: 'server-empty' });
    } else {
      await ensureSeed(store);
    }
  } catch (err) {
    console.error('seed failed', err);
  }
  await loadCore();

  if (!state.add) freshAdd();

  state.ready = true;
  if (!location.hash) location.hash = '#/add';
  await route();
  state.booted = true;

  let onboarded = false;
  try {
    onboarded = localStorage.getItem('mintlite:onboarded') === '1';
  } catch {
    onboarded = true;
  }
  if (!onboarded) setTimeout(() => showOnboard(0), 260);

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    // 新 SW 接管（skipWaiting + claim）时提示刷新，否则旧页面会一直跑旧 JS：
    // 前后端版本错开时最容易出现「保存报错 / 字段对不上」这类怪问题。
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      toast('有新版本，点这里刷新', 'info', {
        fn: () => {
          reloading = true;
          location.reload();
        },
      });
    });
    const reg = () => navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW 注册失败', err));
    // 脚本是 module（defer）执行，load 可能已经过去了，两种时机都要覆盖
    if (document.readyState === 'complete') reg();
    else window.addEventListener('load', reg, { once: true });
  }
  console.info(`[MintLite] v${VERSION} ready · mode=${store.mode} · ledger=${state.ledgerId}`);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
