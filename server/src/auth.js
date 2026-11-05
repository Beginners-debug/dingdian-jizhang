// MintLite server · 鉴权层
// scrypt 加盐哈希 + HMAC-SHA256 自签 token（base64url(payload).base64url(sig)）
// 零第三方依赖：只用 node:crypto / node:fs / node:path
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 数据目录：DATA_DIR > (DB_PATH 所在目录) > server/data
export const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : process.env.DB_PATH
    ? path.dirname(path.resolve(process.env.DB_PATH))
    : path.resolve(HERE, '..', 'data');

export const secretPath = process.env.SECRET_PATH
  ? path.resolve(process.env.SECRET_PATH)
  : path.join(dataDir, 'secret.key');

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
export const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

/* ---------------------------------- 密钥 ---------------------------------- */

let cachedSecret = null;

export function getSecret() {
  if (cachedSecret) return cachedSecret;
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    const raw = fs.readFileSync(secretPath, 'utf8').trim();
    if (raw.length >= 32) {
      cachedSecret = Buffer.from(raw, 'utf8');
      return cachedSecret;
    }
  } catch {
    /* 文件不存在或读不动 → 下面重新生成 */
  }
  const fresh = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath, fresh, { encoding: 'utf8', mode: 0o600 });
  cachedSecret = Buffer.from(fresh, 'utf8');
  return cachedSecret;
}

/* --------------------------------- 口令哈希 -------------------------------- */

/** @returns {string} `scrypt$N$r$p$saltB64$hashB64` */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
  });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), hash.toString('base64')].join('$');
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || expected.length === 0) return false;
  let actual;
  try {
    actual = crypto.scryptSync(String(password), salt, expected.length, {
      N,
      r,
      p,
      maxmem: 256 * N * r * 2,
    });
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/* ---------------------------------- token --------------------------------- */

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function signToken(payload) {
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function createToken(uid, ttlMs = TOKEN_TTL_MS) {
  return signToken({ uid: String(uid), exp: Date.now() + ttlMs });
}

/** @returns {{uid:string,exp:number}|null} */
export function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.uid !== 'string' || !Number.isFinite(payload.exp)) return null;
  if (payload.exp <= Date.now()) return null;
  return { uid: payload.uid, exp: payload.exp };
}

/** 从 Authorization: Bearer xxx 取出 token 字符串 */
export function extractBearer(req) {
  const raw = req.headers.authorization || req.headers.Authorization || '';
  if (typeof raw !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1].trim() : null;
}
