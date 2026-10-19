/**
 * 极简 CookieJar：按域名/路径保存并回放 Cookie。
 * 12306 的登录态分散在 kyfw.12306.cn / cx.12306.cn 两个域上，必须隔离保存。
 */

function defaultPath(pathname) {
  if (!pathname || pathname[0] !== '/') return '/';
  const idx = pathname.lastIndexOf('/');
  if (idx <= 0) return '/';
  return pathname.slice(0, idx);
}

function normalizeDomain(domain, hostname) {
  const d = (domain || hostname || '').trim().replace(/^\./, '').toLowerCase();
  return d || hostname.toLowerCase();
}

function domainMatches(hostname, cookie) {
  const host = hostname.toLowerCase();
  if (cookie.hostOnly) return host === cookie.domain;
  return host === cookie.domain || host.endsWith(`.${cookie.domain}`);
}

function pathMatches(pathname, cookiePath) {
  if (pathname === cookiePath) return true;
  if (!pathname.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || pathname[cookiePath.length] === '/';
}

function parseMaxAge(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export class CookieJar {
  constructor(cookies = []) {
    this.cookies = [];
    for (const cookie of cookies) {
      if (cookie && cookie.name) this.#upsert({ ...cookie });
    }
  }

  static fromJSON(json) {
    try {
      const parsed = typeof json === 'string' ? JSON.parse(json) : json;
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.cookies)
          ? parsed.cookies
          : [];
      return new CookieJar(list);
    } catch {
      return new CookieJar();
    }
  }

  toJSON() {
    return { cookies: this.cookies.map((c) => ({ ...c })) };
  }

  /** 读取某个域下某个 Cookie 的值（不区分 hostOnly 的细节，用于 RAIL_DEVICEID 等） */
  get(name, url) {
    const target = url ? new URL(url) : null;
    for (let i = this.cookies.length - 1; i >= 0; i -= 1) {
      const cookie = this.cookies[i];
      if (cookie.name !== name) continue;
      if (target) {
        if (!domainMatches(target.hostname, cookie)) continue;
        if (!pathMatches(target.pathname, cookie.path)) continue;
      }
      if (cookie.expires && cookie.expires <= Date.now()) continue;
      return cookie.value;
    }
    return undefined;
  }

  /** 生成发往 url 的 Cookie 请求头 */
  header(url) {
    const target = new URL(url);
    const now = Date.now();
    const matched = [];
    for (const cookie of this.cookies) {
      if (cookie.expires && cookie.expires <= now) continue;
      if (cookie.secure && target.protocol !== 'https:') continue;
      if (!domainMatches(target.hostname, cookie)) continue;
      if (!pathMatches(target.pathname, cookie.path)) continue;
      matched.push(cookie);
    }
    matched.sort((a, b) => b.path.length - a.path.length);
    return matched.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  /** 解析响应中的 Set-Cookie */
  absorb(response, requestUrl) {
    const url = new URL(requestUrl);
    let list = [];
    if (typeof response.headers.getSetCookie === 'function') {
      list = response.headers.getSetCookie();
    } else {
      const raw = response.headers.get('set-cookie');
      if (raw) list = [raw];
    }
    for (const raw of list) this.#parseAndSet(raw, url);
  }

  #parseAndSet(raw, url) {
    if (!raw) return;
    const segments = raw.split(';');
    const first = segments.shift() ?? '';
    const eq = first.indexOf('=');
    if (eq <= 0) return;

    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name) return;

    let domain;
    let cookiePath;
    let expires = null;
    let secure = false;
    let httpOnly = false;
    let hostOnly = true;

    for (const segment of segments) {
      const idx = segment.indexOf('=');
      const key = (idx === -1 ? segment : segment.slice(0, idx)).trim().toLowerCase();
      const val = idx === -1 ? '' : segment.slice(idx + 1).trim();
      if (key === 'domain' && val) {
        domain = normalizeDomain(val, url.hostname);
        hostOnly = false;
      } else if (key === 'path' && val.startsWith('/')) {
        cookiePath = val;
      } else if (key === 'expires') {
        const ts = Date.parse(val);
        if (!Number.isNaN(ts)) expires = ts;
      } else if (key === 'max-age') {
        const seconds = parseMaxAge(val);
        if (seconds !== null) expires = Date.now() + seconds * 1000;
      } else if (key === 'secure') {
        secure = true;
      } else if (key === 'httponly') {
        httpOnly = true;
      }
    }

    if (!domain) domain = url.hostname.toLowerCase();
    if (!cookiePath) cookiePath = defaultPath(url.pathname);

    // 过期即删除同名 Cookie
    if (expires !== null && expires <= Date.now()) {
      this.remove(name, domain, cookiePath);
      return;
    }

    this.#upsert({
      name,
      value,
      domain,
      path: cookiePath,
      expires,
      secure,
      httpOnly,
      hostOnly,
    });
  }

  #upsert(cookie) {
    const normalized = {
      name: cookie.name,
      value: String(cookie.value ?? ''),
      domain: normalizeDomain(cookie.domain),
      path: cookie.path || '/',
      expires: cookie.expires ?? null,
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
      hostOnly: cookie.hostOnly !== false,
    };
    const idx = this.cookies.findIndex(
      (c) =>
        c.name === normalized.name &&
        c.domain === normalized.domain &&
        c.path === normalized.path,
    );
    if (idx >= 0) this.cookies[idx] = normalized;
    else this.cookies.push(normalized);
  }

  remove(name, domain, pathname) {
    this.cookies = this.cookies.filter(
      (c) => !(c.name === name && c.domain === domain && c.path === pathname),
    );
  }

  /** 删除某个域（含子域）下的全部 Cookie */
  clearDomain(domain) {
    const d = domain.toLowerCase();
    this.cookies = this.cookies.filter(
      (c) => !(c.domain === d || c.domain.endsWith(`.${d}`)),
    );
  }

  clear() {
    this.cookies = [];
  }

  /** 调试用：只暴露 Cookie 名，不暴露值 */
  names() {
    return this.cookies.map((c) => `${c.name}@${c.domain}${c.path}`);
  }
}
