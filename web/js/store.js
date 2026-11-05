// web/js/store.js — 统一入口：按设置选择 LocalStore / ApiStore
// 设置存 localStorage（契约 §3：两个实现，设置页切 baseUrl + token + 模式）。

import { LocalStore } from './store-local.js';
import { ApiStore, apiLogin, apiRegister } from './store-api.js';

/** 运行时推导默认服务器地址：
 *  - 网页从真后端（http/https）打开时，默认就是自己（同源），不用手填 IP；
 *  - APK / WebView 里的假源（appassets.androidplatform.net 之类）不能用，回退到局域网兜底地址；
 *  - 非浏览器环境（node 里跑单测）也走兜底。 */
export function defaultBaseUrl() {
  try {
    const { protocol, host, origin } = location;
    if (/^https?:$/.test(protocol) && !/^appassets\./.test(host)) return origin;
  } catch {
    /* 非浏览器环境，走下面的兜底 */
  }
  return 'http://192.168.1.135:8787'; // APK 内打开时的兜底：改成你电脑的局域网 IP
}

export const DEFAULT_BASE_URL = defaultBaseUrl();
export const SETTINGS_KEY = 'mintlite:settings';

const DEFAULTS = {
  mode: 'local', // 'local' | 'server'
  baseUrl: DEFAULT_BASE_URL,
  token: '',
  username: '',
  ledgerId: '',
};

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function getSettings() {
  return { ...DEFAULTS, ...readJSON(SETTINGS_KEY, {}) };
}

export function saveSettings(patch = {}) {
  const next = { ...getSettings(), ...patch };
  writeJSON(SETTINGS_KEY, next);
  return next;
}

export function resetSettings() {
  writeJSON(SETTINGS_KEY, { ...DEFAULTS });
  return { ...DEFAULTS };
}

/** 当前账本 id（跨 tab 复用同一个键） */
export function getCurrentLedgerId() {
  const s = getSettings();
  return s.ledgerId || '';
}

export function setCurrentLedgerId(id) {
  saveSettings({ ledgerId: id || '' });
  try {
    localStorage.setItem('mintlite:ledger', id || '');
  } catch {
    /* 忽略 */
  }
}

let activeStore = null;
let activeMode = null;
let localStoreSingleton = null;

/** 拿到本地库单例（云同步页要同时用本地 + 远端） */
export function getLocalStore() {
  if (!localStoreSingleton) localStoreSingleton = new LocalStore();
  return localStoreSingleton;
}

export async function createStore(mode) {
  if (mode === 'server') {
    const s = getSettings();
    const api = new ApiStore({ baseUrl: s.baseUrl, token: s.token });
    await api.init();
    return api;
  }
  const local = getLocalStore();
  await local.init();
  return local;
}

/**
 * 初始化当前模式的 store。
 * @param {{force?: boolean, mode?: 'local'|'server'}} opts
 */
export async function initStore(opts = {}) {
  const settings = getSettings();
  const mode = opts.mode || settings.mode || 'local';
  if (activeStore && activeMode === mode && !opts.force) return activeStore;
  const instance = await createStore(mode);
  activeStore = instance;
  activeMode = mode;
  return instance;
}

function need() {
  if (!activeStore) throw new Error('数据层还没初始化');
  return activeStore;
}

/** 统一门面：app.js 一律走这里，不关心当前是本地还是服务器 */
export const store = {
  get mode() {
    return activeMode;
  },
  get instance() {
    return activeStore;
  },
  init: (opts) => initStore(opts),

  // 账本
  listLedgers: (...a) => need().listLedgers(...a),
  createLedger: (...a) => need().createLedger(...a),
  updateLedger: (...a) => need().updateLedger(...a),
  deleteLedger: (...a) => need().deleteLedger(...a),
  setDefaultLedger: (...a) => need().setDefaultLedger(...a),

  // 成员
  listMembers: (...a) => need().listMembers(...a),
  ensureSelfMember: (...a) => need().ensureSelfMember(...a),
  createMember: (...a) => need().createMember(...a),
  updateMember: (...a) => need().updateMember(...a),
  deleteMember: (...a) => need().deleteMember(...a),

  // 账户
  listAccounts: (...a) => need().listAccounts(...a),
  listAssets: (...a) => need().listAssets(...a),
  createAccount: (...a) => need().createAccount(...a),
  updateAccount: (...a) => need().updateAccount(...a),
  deleteAccount: (...a) => need().deleteAccount(...a),
  adjustAccount: (...a) => need().adjustAccount(...a),
  listReminders: (...a) => need().listReminders(...a),

  // 标签
  listTags: (...a) => need().listTags(...a),
  createTag: (...a) => need().createTag(...a),
  updateTag: (...a) => need().updateTag(...a),
  deleteTag: (...a) => need().deleteTag(...a),

  // 分类
  listCategories: (...a) => need().listCategories(...a),
  createCategory: (...a) => need().createCategory(...a),
  updateCategory: (...a) => need().updateCategory(...a),
  deleteCategory: (...a) => need().deleteCategory(...a),

  // 交易
  listTransactions: (...a) => need().listTransactions(...a),
  getTransaction: (...a) => need().getTransaction(...a),
  createTransaction: (...a) => need().createTransaction(...a),
  updateTransaction: (...a) => need().updateTransaction(...a),
  deleteTransaction: (...a) => need().deleteTransaction(...a),
  reimburse: (...a) => need().reimburse(...a),

  // 周期记账
  listRecurring: (...a) => need().listRecurring(...a),
  saveRecurring: (...a) => need().saveRecurring(...a),
  deleteRecurring: (...a) => need().deleteRecurring(...a),
  runRecurring: (...a) => need().runRecurring(...a),

  // 统计
  summary: (...a) => need().summary(...a),
  byCategory: (...a) => need().byCategory(...a),
  trend: (...a) => need().trend(...a),
  statsOverview: (...a) => need().statsOverview(...a),
  statsByAccount: (...a) => need().statsByAccount(...a),
  statsByTag: (...a) => need().statsByTag(...a),
  statsCompare: (...a) => need().statsCompare(...a),
  statsCalendar: (...a) => need().statsCalendar(...a),
  statsReimburse: (...a) => need().statsReimburse(...a),
  statsByMember: (...a) => need().statsByMember(...a),
  statsMonthly: (...a) => need().statsMonthly(...a),

  // 预算
  getBudgets: (...a) => need().getBudgets(...a),
  setBudget: (...a) => need().setBudget(...a),
  saveBudget: (...a) => need().setBudget(...a),
  budgetUsage: (...a) => need().budgetUsage(...a),

  // 其它
  getMeta: (...a) => need().getMeta(...a),
  setMeta: (...a) => need().setMeta(...a),
  exportAll: (...a) => need().exportAll(...a),
  importAll: (...a) => need().importAll(...a),
  importText: (...a) => (need().importText ? need().importText(...a) : Promise.reject(new Error('当前数据源不支持按文本导入'))),
  clearSampleData: (...a) => need().clearSampleData(...a),
  storageEstimate: (...a) => need().storageEstimate(...a),
};

export { apiLogin, apiRegister, ApiStore, LocalStore };
