// web/js/money.js — 金额核心
// 1) 分 ↔ 元（整数分，禁止浮点存储）
// 2) 表达式求值：手写 tokenizer + 递归下降，支持 + - × ÷ 与括号、小数、连续运算
// 内部精度：把"元"放大 10000 倍做整数运算，最后除以 100 取整到分。
// 这样 0.1+0.2 得到 3000(1/10000 元) → 30 分 → 0.30，绝不会出现 0.30000000000000004。

const SCALE = 10000; // 1 元 = 10000 内部单位；1 分 = 100
const CENTS_PER_YUAN = 100;
const MAX_SCALED = 1e13; // 约 1 亿元，超出直接报错，避免精度溢出

/** 四舍五入整除（整数语义，负值对称处理） */
export function roundDiv(n, d) {
  if (!d) return NaN;
  const neg = n < 0 !== d < 0;
  const a = Math.abs(n);
  const b = Math.abs(d);
  const q = Math.floor((a + b / 2) / b);
  return neg ? -q : q;
}

/** "12.5" → 125000（内部放大单位）；失败返回 NaN */
export function toScaled(input) {
  if (input == null || input === '') return NaN;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return NaN;
    return Math.round(input * SCALE);
  }
  let s = String(input).trim().replace(/[,\s¥￥$]/g, '');
  if (!s) return NaN;
  let neg = false;
  if (s.startsWith('-')) {
    neg = true;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (!/^\d*(\.\d*)?$/.test(s)) return NaN;
  if (s === '' || s === '.') return NaN;
  const [ip = '', fp = ''] = s.split('.');
  const intPart = Number(ip || '0');
  if (!Number.isFinite(intPart)) return NaN;
  const frac = Number(`${fp}0000`.slice(0, 4) || '0');
  const scaled = intPart * SCALE + frac;
  return neg ? -scaled : scaled;
}

/** 内部放大单位 → 分 */
export function scaledToCents(scaled) {
  return roundDiv(scaled, SCALE / CENTS_PER_YUAN);
}

/** 分 → 内部放大单位 */
export function centsToScaled(cents) {
  return Math.round(Number(cents) || 0) * (SCALE / CENTS_PER_YUAN);
}

/** "12.5" / 12.5 / "¥1,234.56" → 1250 / 123456（分） */
export function parseCents(input) {
  const scaled = toScaled(input);
  return Number.isNaN(scaled) ? NaN : scaledToCents(scaled);
}

/**
 * 分 → 展示字符串
 * @param {number} cents
 * @param {{grouped?: boolean, showPlus?: boolean}} opts
 */
export function formatCents(cents, opts = {}) {
  const { grouped = true, showPlus = false } = opts;
  const n = Math.round(Number(cents) || 0);
  const neg = n < 0;
  const abs = Math.abs(n);
  const yuan = Math.floor(abs / 100);
  const frac = abs % 100;
  let s = String(yuan);
  if (grouped) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  s += `.${String(frac).padStart(2, '0')}`;
  if (neg) return `-${s}`;
  return showPlus ? `+${s}` : s;
}

/** 分 → 无分组纯数字（CSV / 输入框回填） */
export function formatPlain(cents) {
  return formatCents(cents, { grouped: false });
}

/** 分 → 人民币带符号文本："-¥12.50" */
export function formatMoney(cents, opts = {}) {
  const { symbol = '¥', showPlus = false, grouped = true } = opts;
  return symbol + formatCents(cents, { grouped, showPlus });
}

// ---------------------------------------------------------------- 表达式解析

const OP_ALIAS = {
  '×': '*',
  x: '*',
  X: '*',
  '*': '*',
  '÷': '/',
  '/': '/',
  '＋': '+',
  '－': '-',
  '−': '-',
  '+': '+',
  '-': '-',
};

/**
 * 词法分析：返回 [{t:'num',v:'12.5'} | {t:'op',v:'+'} | {t:'lp'} | {t:'rp'}]
 */
export function tokenize(src) {
  const s = String(src ?? '');
  const out = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t' || ch === ',' || ch === '\n') {
      i += 1;
      continue;
    }
    if (/[0-9]/.test(ch) || ch === '.') {
      let j = i;
      let dot = 0;
      while (j < s.length && (/[0-9]/.test(s[j]) || s[j] === '.')) {
        if (s[j] === '.') {
          dot += 1;
          if (dot > 1) throw new SyntaxError('小数点重复');
        }
        j += 1;
      }
      const lit = s.slice(i, j);
      if (lit === '.') throw new SyntaxError('小数点位置不对');
      out.push({ t: 'num', v: lit });
      i = j;
      continue;
    }
    if (ch === '(' || ch === '（') {
      out.push({ t: 'lp' });
      i += 1;
      continue;
    }
    if (ch === ')' || ch === '）') {
      out.push({ t: 'rp' });
      i += 1;
      continue;
    }
    const op = OP_ALIAS[ch];
    if (op) {
      out.push({ t: 'op', v: op });
      i += 1;
      continue;
    }
    throw new SyntaxError(`无法识别：${ch}`);
  }
  return out;
}

/** 宽容模式：补全右括号、去掉末尾悬挂的运算符（边输入边预览用） */
function trimTolerant(tokens) {
  let list = tokens.slice();
  // 去掉开头的二元运算符（保留负号）
  while (list.length && list[0].t === 'op' && list[0].v !== '-') list.shift();
  // 去掉末尾悬挂的运算符 / 左括号
  while (list.length) {
    const last = list[list.length - 1];
    if (last.t === 'op' || last.t === 'lp') list.pop();
    else break;
  }
  if (!list.length) return list;
  // 补齐未闭合的括号
  let open = 0;
  for (const tk of list) {
    if (tk.t === 'lp') open += 1;
    else if (tk.t === 'rp') open -= 1;
  }
  while (open > 0) {
    list.push({ t: 'rp' });
    open -= 1;
  }
  return list;
}

function makeParser(tokens) {
  let i = 0;
  const peek = () => tokens[i];
  const isOp = (v) => peek() && peek().t === 'op' && peek().v === v;

  function parsePrimary() {
    const tk = peek();
    if (!tk) throw new SyntaxError('表达式不完整');
    if (tk.t === 'num') {
      i += 1;
      const scaled = toScaled(tk.v);
      if (Number.isNaN(scaled)) throw new SyntaxError(`数字无效：${tk.v}`);
      return scaled;
    }
    if (tk.t === 'lp') {
      i += 1;
      const v = parseExpr();
      if (!peek() || peek().t !== 'rp') throw new SyntaxError('括号没闭合');
      i += 1;
      return v;
    }
    throw new SyntaxError('这里需要一个数字');
  }

  function parseUnary() {
    if (isOp('-')) {
      i += 1;
      return -parseUnary();
    }
    if (isOp('+')) {
      i += 1;
      return parseUnary();
    }
    return parsePrimary();
  }

  function parseTerm() {
    let left = parseUnary();
    while (peek() && peek().t === 'op' && (peek().v === '*' || peek().v === '/')) {
      const op = peek().v;
      i += 1;
      const right = parseUnary();
      if (op === '*') {
        if (Math.abs(left) > 1e13 || Math.abs(right) > 1e13) throw new RangeError('数值过大');
        left = roundDiv(left * right, SCALE);
      } else {
        if (right === 0) throw new RangeError('不能除以 0');
        if (Math.abs(left) > 1e11) throw new RangeError('数值过大');
        left = roundDiv(left * SCALE, right);
      }
    }
    return left;
  }

  function parseExpr() {
    let left = parseTerm();
    while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = peek().v;
      i += 1;
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  return {
    run() {
      const v = parseExpr();
      if (i < tokens.length) throw new SyntaxError('表达式有多余内容');
      return v;
    },
  };
}

/**
 * 求值
 * @param {string} src
 * @param {{tolerant?: boolean}} opts tolerant=true 时空表达式返回 0，悬挂运算符被忽略
 * @returns {{ok:boolean, scaled:number, cents:number, empty?:boolean, error?:string}}
 */
export function evaluate(src, opts = {}) {
  const { tolerant = true } = opts;
  let tokens;
  try {
    tokens = tokenize(src);
  } catch (err) {
    return { ok: false, error: err.message, scaled: NaN, cents: NaN };
  }
  if (tolerant) tokens = trimTolerant(tokens);
  if (!tokens.length) {
    return { ok: true, scaled: 0, cents: 0, empty: true };
  }
  try {
    const scaled = makeParser(tokens).run();
    if (!Number.isFinite(scaled)) throw new RangeError('结果是无穷大');
    if (Math.abs(scaled) > MAX_SCALED) throw new RangeError('数值过大');
    return { ok: true, scaled, cents: scaledToCents(scaled) };
  } catch (err) {
    return { ok: false, error: err.message, scaled: NaN, cents: NaN };
  }
}

/** 分 → 可继续编辑的数字串（"1850" → "18.50"） */
export function centsToEditString(cents) {
  return formatPlain(cents);
}

// ---------------------------------------------------------------- 键盘状态机

const OPERATORS = new Set(['+', '-', '×', '÷']);
const OP_CHARS = '+−-×÷*/xX';

function normalizeOp(key) {
  if (key === '*') return '×';
  if (key === '/') return '÷';
  if (key === '-') return '-';
  return key;
}

/** 末尾的数值片段（用于"大字显示当前正在输入的数"） */
function splitTail(expr) {
  const m = /(\d*\.?\d*)$/.exec(expr);
  const tail = m ? m[1] : '';
  return { head: expr.slice(0, expr.length - tail.length), tail };
}

/**
 * 计算器状态机：记账页键盘用，纯函数式状态（无 DOM），可单测。
 * 支持连续运算（按 = 后继续按运算符 / 继续按数字）与括号。
 */
export function createCalculator(initial = '') {
  let expr = String(initial || '');
  let settled = false; // 刚按过 =

  const api = {
    get expr() {
      return expr;
    },
    /** 大字显示：当前正在输入的片段；结算后显示结果 */
    get display() {
      if (!expr) return '0';
      const { tail } = splitTail(expr);
      if (tail === '') return settled ? formatPlain(0) : '0';
      return tail;
    },
    /** 上方的表达式小字 */
    get hint() {
      const { head } = splitTail(expr);
      return head.trim();
    },
    /** 当前值（分）；无效为 NaN */
    get cents() {
      const r = evaluate(expr);
      return r.ok ? r.cents : NaN;
    },
    get valid() {
      return evaluate(expr).ok;
    },
    reset() {
      expr = '';
      settled = false;
    },
    setCents(cents) {
      expr = centsToEditString(cents);
      settled = true;
    },
    setExpr(value) {
      expr = String(value || '');
      settled = false;
    },
    backspace() {
      settled = false;
      expr = expr.slice(0, -1);
    },
    press(key) {
      const k = String(key);
      if (k === 'C' || k === 'AC') {
        api.reset();
        return expr;
      }
      if (k === '=') {
        const r = evaluate(expr);
        if (r.ok) {
          expr = centsToEditString(r.cents);
          settled = true;
        }
        return expr;
      }
      if (k === '⌫' || k === 'backspace') {
        api.backspace();
        return expr;
      }
      if (k === '.') {
        if (settled) {
          expr = '0.';
          settled = false;
          return expr;
        }
        const { tail } = splitTail(expr);
        if (tail.includes('.')) return expr;
        if (tail === '') expr += '0.';
        else expr += '.';
        return expr;
      }
      if (/^[0-9]$/.test(k)) {
        if (settled) {
          expr = '';
          settled = false;
        }
        const { tail } = splitTail(expr);
        if (tail === '0') expr = expr.slice(0, -1);
        expr += k;
        return expr;
      }
      if (OPERATORS.has(k) || k === '*' || k === '/') {
        const op = normalizeOp(k);
        if (settled) {
          const prev = evaluate(expr);
          expr = centsToEditString(prev.ok ? prev.cents : 0);
          settled = false;
        }
        if (!expr) {
          if (op === '-') expr = '-';
          return expr;
        }
        const last = expr.slice(-1);
        if (OP_CHARS.includes(last)) {
          // 连续按运算符 → 替换；但保留负号能力："×-" 允许
          if (expr.length >= 2 && OP_CHARS.includes(expr.slice(-2, -1))) {
            expr = `${expr.slice(0, -2)}${op}`;
          } else {
            expr = `${expr.slice(0, -1)}${op}`;
          }
          return expr;
        }
        if (last === '(') {
          if (op === '-') expr += op;
          return expr;
        }
        expr += op;
        return expr;
      }
      if (k === '(' || k === ')') {
        if (settled) {
          expr = '';
          settled = false;
        }
        const last = expr.slice(-1);
        if (k === '(') {
          if (/[0-9.]$/.test(last)) expr += '×';
          expr += '(';
        } else {
          const depth = (expr.match(/\(/g) || []).length - (expr.match(/\)/g) || []).length;
          if (depth > 0 && !OP_CHARS.includes(last) && last !== '(') expr += ')';
        }
        return expr;
      }
      return expr;
    },
  };
  return api;
}
