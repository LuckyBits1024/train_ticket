/**
 * 带 CookieJar 的 HTTP 客户端。只使用 Node 内置 fetch，无第三方依赖。
 */

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export class HttpError extends Error {
  constructor(message, { status = 0, url = '', body = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export class ApiError extends Error {
  constructor(message, { code = 'API_ERROR', payload = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.payload = payload;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HttpClient {
  constructor({ jar, userAgent = DEFAULT_UA, timeout = 20000 } = {}) {
    if (!jar) throw new Error('HttpClient 需要 CookieJar');
    this.jar = jar;
    this.userAgent = userAgent;
    this.timeout = timeout;
  }

  async request(url, options = {}) {
    const {
      method = 'GET',
      form,
      body,
      headers = {},
      timeout = this.timeout,
      redirect = 'manual',
      retries = 0,
    } = options;

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await this.#requestOnce(url, { method, form, body, headers, timeout, redirect });
      } catch (error) {
        const retryable =
          error instanceof HttpError &&
          (error.status === 0 || error.status === 429 || error.status >= 500);
        if (!retryable || attempt >= retries) throw error;
        attempt += 1;
        await sleep(400 * attempt);
      }
    }
  }

  async #requestOnce(startUrl, { method, form, body, headers, timeout, redirect }) {
    let current = new URL(startUrl);
    let currentMethod = method.toUpperCase();
    let payload = body;
    let currentForm = form;

    for (let hop = 0; hop < 6; hop += 1) {
      const requestHeaders = {
        'user-agent': this.userAgent,
        accept: 'application/json, text/javascript, */*; q=0.01',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        ...headers,
      };

      if (currentForm !== undefined && currentForm !== null) {
        payload = new URLSearchParams(currentForm).toString();
        requestHeaders['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        if (!requestHeaders['x-requested-with']) {
          requestHeaders['x-requested-with'] = 'XMLHttpRequest';
        }
      } else if (payload !== undefined) {
        requestHeaders['content-type'] =
          requestHeaders['content-type'] || 'application/json;charset=UTF-8';
      }

      const cookie = this.jar.header(current);
      if (cookie) requestHeaders.cookie = cookie;

      let response;
      try {
        response = await fetch(current, {
          method: currentMethod,
          headers: requestHeaders,
          body: currentMethod === 'GET' || currentMethod === 'HEAD' ? undefined : payload,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeout),
        });
      } catch (error) {
        const reason = error?.name === 'TimeoutError' ? '请求超时' : error?.message || '网络错误';
        throw new HttpError(`${reason}: ${current.host}`, { url: String(current) });
      }

      this.jar.absorb(response, current);

      if (redirect === 'manual' && REDIRECT_STATUS.has(response.status)) {
        const location = response.headers.get('location');
        if (!location) {
          throw new HttpError(`HTTP ${response.status} 但缺少 Location`, {
            status: response.status,
            url: String(current),
          });
        }
        const next = new URL(location, current);
        // 303 一律改 GET；301/302 对 POST 也按浏览器习惯改 GET
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod !== 'GET')) {
          currentMethod = 'GET';
          payload = undefined;
          currentForm = undefined;
        }
        current = next;
        continue;
      }

      return response;
    }

    throw new HttpError('重定向次数过多', { url: String(startUrl) });
  }

  async get(url, options = {}) {
    const { retries = 2, ...rest } = options;
    const response = await this.request(url, { method: 'GET', retries, ...rest });
    const text = await response.text();
    if (!response.ok) {
      throw new HttpError(`HTTP ${response.status}`, {
        status: response.status,
        url,
        body: text.slice(0, 500),
      });
    }
    return { response, text };
  }

  async postForm(url, data = {}, options = {}) {
    const { retries = 1, ...rest } = options;
    const response = await this.request(url, {
      method: 'POST',
      form: data,
      retries,
      ...rest,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new HttpError(`HTTP ${response.status}`, {
        status: response.status,
        url,
        body: text.slice(0, 500),
      });
    }
    return { response, text };
  }

  async postJson(url, data = {}, options = {}) {
    const { text, response } = await this.postForm(url, data, options);
    return { json: parseJson(text, response.status), response, text };
  }
}

export function parseJson(text, status = 200) {
  const cleaned = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .trim();
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    // 12306 在风控/维护时可能返回 HTML
    const hint = /<html|<!doctype/i.test(cleaned) ? '返回了 HTML 页面（可能被风控或需要重新登录）' : '返回内容不是合法 JSON';
    throw new HttpError(hint, { status, body: cleaned.slice(0, 300) });
  }
}
