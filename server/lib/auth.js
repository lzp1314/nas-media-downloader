import crypto from 'node:crypto';

/**
 * 访问账号：密码校验、会话令牌、登录限流。
 * 零依赖（只用 node:crypto），全部是纯函数/无状态工厂，方便离线断言覆盖。
 * 密码本身永远不落盘：settings.json 里只存随机 salt + scrypt 哈希。
 */

const KEY_LEN = 32;
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;

/** scrypt 慢哈希：默认 N=16384/r=8/p=1，单次约 40~80ms，能挡住离线爆破又不拖慢登录 */
export function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), String(salt), KEY_LEN, (err, key) => {
      if (err) reject(err);
      else resolve(key.toString('hex'));
    });
  });
}

/** 常数时间比对，避免用 === 泄露时序信息 */
export async function verifyPassword(password, salt, expectedHex) {
  const actual = await hashPassword(password, salt);
  let expected;
  try {
    expected = Buffer.from(String(expectedHex || ''), 'hex');
  } catch {
    return false;
  }
  const a = Buffer.from(actual, 'hex');
  if (a.length !== expected.length || expected.length === 0) return false;
  return crypto.timingSafeEqual(a, expected);
}

export function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}

export function makeSecret() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * 决定当前用哪套认证。优先级：面板显式关闭 > 面板账号密码 > YAML 环境变量 > 免登录。
 * 面板只要做过一次设置（含「关闭」）就压过 YAML，否则改完密码一重启又被旧值顶回来。
 */
export function resolveAuth(auth, envPassword) {
  const a = auth && typeof auth === 'object' ? auth : {};
  if (a.disabled === true) return { mode: 'off', enabled: false, needUsername: false };
  if (a.username && a.hash && a.salt) {
    return {
      mode: 'panel', enabled: true, needUsername: true,
      username: String(a.username), hash: String(a.hash), salt: String(a.salt),
      sessionSecret: String(a.sessionSecret || ''),
    };
  }
  const env = String(envPassword || '');
  if (env) return { mode: 'env', enabled: true, needUsername: false, password: env };
  return { mode: 'none', enabled: false, needUsername: false };
}

/**
 * 会话令牌：面板模式用 HMAC(随机 secret, 密码哈希)。
 * 改密码 → 哈希变 → 所有旧 Cookie 立即作废；secret 持久化，容器重启也不会把人踢下线。
 * 环境变量模式沿用旧的 sha256 派生式，保证升级后已有的登录态不失效。
 */
export function authToken(auth) {
  if (!auth || !auth.enabled) return '';
  if (auth.mode === 'panel') {
    return crypto.createHmac('sha256', auth.sessionSecret || auth.hash)
      .update(`nas-downloader::${auth.hash}`).digest('hex');
  }
  return crypto.createHash('sha256').update(`${auth.password}::nas-downloader`).digest('hex').slice(0, 32);
}

/** 前端提交的账号/密码规则；返回 { ok, error }，清空密码不走这里 */
export function validateCredential(username, password) {
  const u = String(username || '').trim();
  const p = String(password || '');
  if (!u) return { ok: false, error: '请填登录账号' };
  if (u.length > 32) return { ok: false, error: '登录账号最多 32 个字符' };
  // 账号名会在设置页回显，控制字符和尖括号一律挡掉（前端另有 esc 兜底）
  if (/[\u0000-\u001f<>\"'&]/.test(u)) return { ok: false, error: '登录账号不能包含空格以外的特殊字符' };
  if (p.length < 8) return { ok: false, error: '密码至少 8 位' };
  if (p.length > 128) return { ok: false, error: '密码最多 128 位' };
  if (!p.trim()) return { ok: false, error: '密码不能全是空格' };
  return { ok: true, username: u, password: p };
}

/**
 * 登录失败限流：同一来源连错 5 次锁 5 分钟。
 * 内存态即可（重启清零是可接受的），不引依赖、不写盘。
 */
export function createLimiter({ max = MAX_FAILS, windowMs = LOCK_MS, now = () => Date.now() } = {}) {
  const state = new Map();
  const keyOf = (k) => String(k || 'unknown');
  return {
    check(key) {
      const k = keyOf(key);
      const rec = state.get(k);
      if (!rec) return { blocked: false, retryAfter: 0 };
      if (rec.until && rec.until > now()) return { blocked: true, retryAfter: Math.ceil((rec.until - now()) / 1000) };
      if (rec.until) state.delete(k); // 锁定到期，重新开始计数
      return { blocked: false, retryAfter: 0 };
    },
    fail(key) {
      const k = keyOf(key);
      const t = now();
      const rec = state.get(k);
      const fails = rec && !rec.until ? rec.fails + 1 : 1;
      const locked = fails >= max;
      state.set(k, { fails, until: locked ? t + windowMs : 0 });
      return { locked, fails, retryAfter: locked ? Math.ceil(windowMs / 1000) : 0 };
    },
    reset(key) { state.delete(keyOf(key)); },
    get size() { return state.size; },
  };
}
