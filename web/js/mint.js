// 导入/导出格式：本 App CSV、薄荷记账（UTF-16LE + TAB）、JSON
// 纯函数，不碰 DOM / IndexedDB，方便 node 里直接单测。
//
// 薄荷格式实测：UTF-16LE + BOM，TAB 分隔，19 列，行尾 CRLF，扩展名却常是 .csv。

export const MINT_HEADER = [
  '类型',
  '货币',
  '金额',
  '汇率（相对本位币）',
  '项目',
  '分类',
  '父类',
  '账户',
  '付款',
  '收款',
  '商家',
  '地址',
  '日期',
  '标签',
  '作者',
  '备注',
  '图一',
  '图二',
  '图三',
];

const COL = {
  type: 0,
  currency: 1,
  amount: 2,
  rate: 3,
  project: 4,
  category: 5,
  parent: 6,
  account: 7,
  pay: 8,
  receive: 9,
  merchant: 10,
  address: 11,
  date: 12,
  tags: 13,
  author: 14,
  note: 15,
  img1: 16,
  img2: 17,
  img3: 18,
};

export const UNSET_ACCOUNT = '未指定';
export const TRANSFER_CATEGORY = '账户互转';

// ------------------------------------------------------------------ 编码

/** 把字符串编成 UTF-16LE 字节（带 FF FE BOM）。TextEncoder 只出 UTF-8，这里自己按 code unit 拼。 */
export function encodeUtf16LE(text) {
  const s = String(text ?? '');
  const out = new Uint8Array(2 + s.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    out[2 + i * 2] = code & 0xff;
    out[3 + i * 2] = (code >> 8) & 0xff;
  }
  return out;
}

/** 判断 BOM → 解码文本。返回 { text, encoding }。 */
export function decodeBytes(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(b.subarray(2)), encoding: 'utf-16le' };
  }
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(b.subarray(2)), encoding: 'utf-16be' };
  }
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(b.subarray(3)), encoding: 'utf-8' };
  }
  return { text: new TextDecoder('utf-8').decode(b), encoding: 'utf-8' };
}

// ------------------------------------------------------------------ 识别

function firstLine(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) if (line.trim()) return line.trim();
  return '';
}

/** 契约 §5：BOM → mint；{ [ → json；表头含 类型/金额/日期 且 ≥15 列 → mint；含 日期/类型/金额 → csv。 */
export function detectFormat(bytes, text, explicit = 'auto') {
  if (explicit && explicit !== 'auto') return explicit;
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) return 'mint';
  const head = firstLine(text);
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  const byTab = head.split('\t');
  const looksMint = byTab.length >= 15 && /类型/.test(head) && /金额/.test(head) && /日期/.test(head);
  if (looksMint) return 'mint';
  if (/日期/.test(head) && /类型/.test(head) && /金额/.test(head)) return 'csv';
  return null;
}

// ------------------------------------------------------------------ 数字/日期

/** 分 → 薄荷金额字符串（支出带负号，去掉多余的 0，至少保留整数）。 */
export function centsToMint(cents, negative = false) {
  const n = Math.round(Number(cents) || 0);
  const abs = Math.abs(n);
  const yuan = Math.floor(abs / 100);
  const frac = abs % 100;
  let s = String(yuan);
  if (frac) s += `.${frac % 10 === 0 ? String(frac / 10) : String(frac).padStart(2, '0')}`;
  return negative ? `-${s}` : s;
}

/** 内部日期（YYYY-MM-DD / ISO）→ 薄荷 `YYYY-MM-DD HH:mm`。 */
export function toMintDate(value) {
  const s = String(value || '');
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
  if (!m) return s;
  return `${m[1]} ${m[2] || '00'}:${m[3] || '00'}`;
}

/** 单元格清洗：薄荷不做引号转义，TAB / 换行一律换成空格。 */
export function cell(value) {
  return String(value ?? '')
    .replace(/[\t\r\n]+/g, ' ')
    .trim();
}

const TYPE_IN = { 支出: 'expense', 收入: 'income', 转账: 'transfer' };
const TYPE_OUT = { expense: '支出', income: '收入', transfer: '转账' };

/** 账户类型猜测（契约 §3）。 */
export function guessAccountType(name) {
  const s = String(name || '');
  if (!s) return 'other';
  if (/微信|支付宝|钱包|云闪付|余额宝|PayPal/i.test(s)) return /余额宝/.test(s) ? 'invest' : 'ewallet';
  if (/现金|零钱/.test(s)) return 'cash';
  if (/基金|股票|投资|理财|指数/.test(s)) return 'invest';
  if (/借款|白条|花呗|欠款|应付/.test(s)) return 'payable';
  if (/银行|储蓄卡|借记卡|卡/.test(s)) return 'bank';
  return 'other';
}

/** 标签拆分：`,` `，` `、` `|`。 */
export function splitTags(value) {
  return String(value || '')
    .split(/[,，、|]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i);
}

// ------------------------------------------------------------------ 解析：薄荷

/** 解析薄荷文本 → 结构化行。`raw` 保留原行（算 external_id 用）。 */
export function parseMint(text) {
  const rows = [];
  const warnings = [];
  const lines = String(text || '').split(/\r?\n/);
  let header = null;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].replace(/\r$/, '');
    if (!raw.trim()) continue;
    const cols = raw.split('\t');
    if (!header) {
      header = cols.map((c) => c.trim());
      if (!(header.length >= 15 && /类型/.test(header[0]))) {
        warnings.push(`第 ${i + 1} 行表头不认识，已按 19 列顺序解析`);
      }
      continue;
    }
    const at = (k) => (cols[COL[k]] === undefined ? '' : String(cols[COL[k]]).trim());
    const type = TYPE_IN[at('type')] || null;
    const amountRaw = at('amount').replace(/[,\s¥$]/g, '');
    const amount = Number(amountRaw);
    if (!type) {
      warnings.push(`第 ${i + 1} 行类型「${at('type')}」无法识别，已跳过`);
      continue;
    }
    if (!Number.isFinite(amount)) {
      warnings.push(`第 ${i + 1} 行金额无法解析，已跳过`);
      continue;
    }
    const currency = (at('currency') || 'CNY').toUpperCase();
    const rate = Number(at('rate')) || 1;
    const dateText = toMintDate(at('date'));
    rows.push({
      raw,
      index: i + 1,
      type,
      currency,
      rate,
      amountCents: Math.round(Math.abs(amount) * 100),
      categoryName: at('category'),
      accountName: at('account'),
      payName: at('pay'),
      receiveName: at('receive'),
      dateText,
      tagNames: splitTags(at('tags')),
      author: at('author'),
      note: at('note'),
      merchant: at('merchant'),
    });
  }
  return { rows, warnings, header };
}

/** 组合备注：商家拼接 + 非 CNY 前缀（契约 §3）。 */
export function mintNote(row) {
  let note = cell(row.note);
  const merchant = cell(row.merchant);
  if (merchant) note = note ? `${note} · ${merchant}` : merchant;
  if (row.currency && row.currency !== 'CNY') {
    const rate = Number(row.rate) || 1;
    note = `[货币 ${row.currency} 汇率 ${rate.toFixed(4)}] ${note}`.trim();
  }
  return note;
}

// ------------------------------------------------------------------ 解析：本 App CSV

/** 极简 CSV 解析（支持双引号转义、CRLF）。 */
export function parseCsv(text) {
  const s = String(text || '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim()));
}

const CSV_ALIAS = {
  date: ['日期', 'date', '日期时间'],
  type: ['类型', 'type'],
  category: ['分类', 'category'],
  account: ['账户', 'account'],
  to: ['转入账户', 'to_account', '目标账户'],
  amount: ['金额(元)', '金额', 'amount'],
  note: ['备注', 'note'],
  tags: ['标签', 'tags'],
  reimburse: ['报销状态', 'reimburse'],
};

function pick(map, keys) {
  for (const k of keys) if (map[k] !== undefined) return map[k];
  return '';
}

/** 解析本 App CSV → 与薄荷行同构的结构（type/amountCents/…/raw）。 */
export function parseAppCsv(text) {
  const table = parseCsv(text);
  if (!table.length) return { rows: [], warnings: ['文件是空的'] };
  const header = table[0].map((c) => String(c).trim());
  const idx = {};
  for (const [k, aliases] of Object.entries(CSV_ALIAS)) {
    const at = header.findIndex((h) => aliases.includes(h));
    if (at >= 0) idx[k] = at;
  }
  if (idx.amount === undefined && idx.date === undefined) {
    return { rows: [], warnings: ['表头不认识：至少需要「日期」「金额」两列'] };
  }
  const rows = [];
  const warnings = [];
  for (let i = 1; i < table.length; i += 1) {
    const cells = table[i];
    const get = (k) => (idx[k] === undefined ? '' : String(cells[idx[k]] ?? '').trim());
    const type = TYPE_IN[get('type')] || (get('type') === '余额调整' ? 'adjust' : null);
    const amount = Number(get('amount').replace(/[,\s¥$]/g, ''));
    if (!type || !Number.isFinite(amount)) {
      warnings.push(`第 ${i + 1} 行无法解析，已跳过`);
      continue;
    }
    const reimburse = get('reimburse');
    rows.push({
      raw: cells.join(','),
      index: i + 1,
      type,
      currency: 'CNY',
      rate: 1,
      amountCents: Math.round(Math.abs(amount) * 100),
      categoryName: get('category'),
      accountName: get('account'),
      payName: get('pay') || get('account'),
      receiveName: get('to'),
      dateText: toMintDate(get('date')),
      tagNames: splitTags(get('tags').replace(/\s+/g, ',')),
      author: '',
      note: get('note'),
      merchant: '',
      reimburseState: reimburse === '待报销' ? 'pending' : reimburse === '已报销' ? 'done' : null,
    });
  }
  return { rows, warnings, header };
}

// ------------------------------------------------------------------ 导出：薄荷

/**
 * 内部交易 → 薄荷 19 列文本。
 * @param {Array} txs 交易（含 category_id/account_id/to_account_id/tags/member_id）
 * @param {{accounts:Map,categories:Map,tags:Map,members:Map}} lookups
 */
export function buildMintText(txs, lookups) {
  const { accounts = new Map(), categories = new Map(), tags = new Map(), members = new Map() } = lookups || {};
  const name = (map, id) => (id && map.get(id) ? map.get(id).name || '' : '');
  const lines = [MINT_HEADER.join('\t')];
  for (const tx of txs) {
    const type = TYPE_OUT[tx.type];
    if (!type) continue; // 余额调整不进薄荷格式
    const isExpense = tx.type === 'expense';
    const cat = tx.type === 'transfer' ? TRANSFER_CATEGORY : name(categories, tx.category_id);
    const acc = tx.type === 'transfer' ? '' : name(accounts, tx.account_id);
    const tagNames = (tx.tags || []).map((id) => name(tags, id)).filter(Boolean).join(',');
    const cols = [
      type,
      'CNY',
      centsToMint(tx.amount_cents, isExpense),
      '1.0000',
      '',
      cat,
      '',
      acc,
      tx.type === 'transfer' ? name(accounts, tx.account_id) : '',
      tx.type === 'transfer' ? name(accounts, tx.to_account_id) : '',
      '',
      '',
      toMintDate(tx.happened_at),
      tagNames,
      name(members, tx.member_id),
      cell(tx.note),
      '',
      '',
      '',
    ].map(cell);
    while (cols.length < 19) cols.push('');
    lines.push(cols.join('\t'));
  }
  return `${lines.join('\r\n')}\r\n`;
}

// ------------------------------------------------------------------ 幂等键

/** SHA-1（hex，40 位）。crypto.subtle 在 https / localhost / appassets 下可用；否则退回 FNV-1a。 */
export async function sha1Hex(input) {
  const text = String(input ?? '');
  const subtle = typeof crypto !== 'undefined' && crypto.subtle;
  if (subtle && typeof subtle.digest === 'function') {
    try {
      const buf = new TextEncoder().encode(text);
      const digest = await subtle.digest('SHA-1', buf);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      /* 落到 FNV */
    }
  }
  return fnvHex(text);
}

/** 非安全上下文兜底：FNV-1a 32 位拼两轮，长度撑到 40 位保持形状一致。 */
export function fnvHex(text) {
  const s = String(text ?? '');
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i += 1) {
    h1 ^= s.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + s.charCodeAt(i) * (i + 7)) >>> 0;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  const part = (n) => n.toString(16).padStart(8, '0');
  return `${part(h1)}${part(h2)}${part(h1 ^ h2)}${part((h1 + h2) >>> 0)}${part(h1 >>> 3)}`.slice(0, 40);
}
