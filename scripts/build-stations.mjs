// 从 12306 的 station_name.js 生成「电报码 -> 站名」和「站名 -> 拼音」映射。
// 用法：node scripts/build-stations.mjs [station_name.js 路径或 URL]
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const source = process.argv[2] || 'https://cx.12306.cn/tlcx/js/framework/station_name_new.js';
const outFile = path.resolve(import.meta.dirname, '../src/data/stations.json');
const pinyinFile = path.resolve(import.meta.dirname, '../src/data/stations-pinyin.json');
const indexFile = path.resolve(import.meta.dirname, '../src/data/stations-index.json');

let text;
if (/^https?:\/\//.test(source)) {
  const res = await fetch(source, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      referer: 'https://cx.12306.cn/tlcx/jfinformation.html',
    },
  });
  if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`);
  text = await res.text();
} else {
  text = await readFile(source, 'utf8');
}

const match = text.match(/station_names\s*=\s*['"]([\s\S]*?)['"]\s*;?/);
if (!match) throw new Error('未找到 station_names 变量');

const map = {};
const pinyin = {};
const index = [];
for (const entry of match[1].split('@')) {
  if (!entry) continue;
  const parts = entry.split('|');
  const name = parts[1];
  const telecode = parts[2];
  const latin = parts[3];
  const short = parts[4] || '';
  if (!name || !telecode) continue;
  map[telecode] = name;
  if (latin && !pinyin[name]) {
    pinyin[name] = latin[0].toUpperCase() + latin.slice(1);
  }
  index.push({ name, pinyin: latin ? latin[0].toUpperCase() + latin.slice(1) : '', short, code: telecode });
}

await writeFile(outFile, JSON.stringify(map), 'utf8');
await writeFile(pinyinFile, JSON.stringify(pinyin), 'utf8');
index.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
await writeFile(indexFile, JSON.stringify(index), 'utf8');
console.log(`已写入 ${Object.keys(map).length} 个车站 -> ${outFile}`);
console.log(`已写入 ${Object.keys(pinyin).length} 个站名拼音 -> ${pinyinFile}`);
console.log(`已写入 ${index.length} 个车站索引 -> ${indexFile}`);
