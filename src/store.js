/**
 * 本地会话存储：把 Cookie 和用户信息写入 data/session.json（权限 600）。
 * 文件只在本机使用，README 中提醒不要提交/分享。
 */
import { mkdir, readFile, rename, writeFile, chmod, unlink } from 'node:fs/promises';
import path from 'node:path';
import { CookieJar } from './cookies.js';

export class SessionStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.jar = new CookieJar();
    this.user = null;
    this.updatedAt = null;
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return this;
    this.loaded = true;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const data = JSON.parse(raw);
      this.jar = CookieJar.fromJSON(data.cookies ?? []);
      this.user = data.user ?? null;
      this.updatedAt = data.updatedAt ?? null;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('[session] 读取失败，将以未登录状态启动:', error.message);
      }
    }
    return this;
  }

  async save() {
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    const payload = JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        user: this.user,
        cookies: this.jar.toJSON().cookies,
      },
      null,
      2,
    );
    await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.filePath);
    await chmod(this.filePath, 0o600);
    this.updatedAt = new Date().toISOString();
  }

  async clear() {
    this.user = null;
    this.jar.clear();
    try {
      await unlink(this.filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
