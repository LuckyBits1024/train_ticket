/**
 * 读取 assets/ticket-template/v2/manifest.json，并提供底图/缩略图加载缓存。
 * 渲染器与 UI 共用同一份 manifest，禁止在代码里另写一套尺寸。
 */

const MANIFEST_URL = '/assets/ticket-template/v2/manifest.json';
const ASSET_ROOT = '/assets/ticket-template/v2/';

let manifestPromise = null;
const imageCache = new Map();

export async function loadTemplates() {
  if (!manifestPromise) {
    manifestPromise = fetch(MANIFEST_URL, { cache: 'no-cache' })
      .then((response) => {
        if (!response.ok) throw new Error(`模板清单加载失败（HTTP ${response.status}）`);
        return response.json();
      })
      .then((manifest) => {
        if (!Array.isArray(manifest.templates) || manifest.templates.length !== 8) {
          throw new Error('模板清单不完整：期望 8 款');
        }
        const byKey = new Map(manifest.templates.map((item) => [item.key, item]));
        return { ...manifest, byKey };
      })
      .catch((error) => {
        manifestPromise = null;
        throw error;
      });
  }
  return manifestPromise;
}

export function getTemplate(manifest, key) {
  const template = manifest?.byKey?.get(key) || manifest?.templates?.[0];
  if (!template) throw new Error(`未知模板：${key}`);
  return template;
}

export function assetUrl(relativePath) {
  return ASSET_ROOT + relativePath.replace(/^\/+/, '');
}

export function templateThumb(template) {
  return assetUrl(template.thumb);
}

export function loadImage(url) {
  if (imageCache.has(url)) return imageCache.get(url);
  const promise = new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => {
      imageCache.delete(url);
      reject(new Error(`图片加载失败：${url}`));
    };
    image.src = url;
  });
  imageCache.set(url, promise);
  return promise;
}

export function loadTemplateImage(template) {
  return loadImage(assetUrl(template.background.src));
}

export function clearImageCache() {
  imageCache.clear();
}
