/** 全国车站索引：站名 / 全拼 / 首字母联想。 */

let cache = null;
let loading = null;

export async function loadStations() {
  if (cache) return cache;
  if (!loading) {
    loading = fetch('/api/ticket/stations', { cache: 'force-cache' })
      .then((response) => {
        if (!response.ok) throw new Error('车站数据加载失败');
        return response.json();
      })
      .then((payload) => {
        const list = Array.isArray(payload.stations) ? payload.stations : [];
        cache = list.map((item) => ({
          ...item,
          nameLower: String(item.name || '').toLowerCase(),
          pinyinLower: String(item.pinyin || '').toLowerCase(),
          shortLower: String(item.short || '').toLowerCase(),
        }));
        return cache;
      })
      .catch((error) => {
        loading = null;
        throw error;
      });
  }
  return loading;
}

export function searchStations(list, query, limit = 8) {
  const q = String(query || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!q || !Array.isArray(list)) return [];
  const scored = [];
  for (const item of list) {
    let score = -1;
    if (item.nameLower === q || item.pinyinLower === q || item.shortLower === q) score = 0;
    else if (item.nameLower.startsWith(q)) score = 1;
    else if (item.pinyinLower.startsWith(q)) score = 2;
    else if (item.shortLower.startsWith(q)) score = 3;
    else if (item.nameLower.includes(q)) score = 4;
    else if (item.pinyinLower.includes(q)) score = 5;
    if (score >= 0) scored.push({ item, score });
  }
  scored.sort((a, b) => a.score - b.score || a.item.name.length - b.item.name.length);
  return scored.slice(0, limit).map((entry) => entry.item);
}

export function findStation(list, name) {
  const target = String(name || '').trim().replace(/站$/, '');
  return (list || []).find((item) => item.name === target) || null;
}

export function pinyinFor(list, name) {
  return findStation(list, name)?.pinyin || '';
}

/**
 * 绑定一个输入框的联想菜单。
 * onSelect({name, pinyin, code})
 */
export function attachStationAutocomplete({ input, pinyinInput, getList, onSelect }) {
  if (!input) return () => {};
  const menu = document.createElement('div');
  menu.className = 'ac-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'listbox');
  document.body.appendChild(menu);

  let items = [];
  let active = -1;

  const close = () => {
    menu.hidden = true;
    active = -1;
    menu.innerHTML = '';
  };

  const position = () => {
    const rect = input.getBoundingClientRect();
    const maxWidth = Math.max(180, rect.width);
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - maxWidth - 8))}px`;
    menu.style.top = `${rect.bottom + 6}px`;
    menu.style.width = `${maxWidth}px`;
  };

  const choose = (item) => {
    input.value = item.name;
    if (pinyinInput) pinyinInput.value = item.pinyin || '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (pinyinInput) pinyinInput.dispatchEvent(new Event('input', { bubbles: true }));
    close();
    onSelect?.(item);
  };

  const render = () => {
    if (!items.length) return close();
    menu.innerHTML = '';
    items.forEach((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `ac-item${index === active ? ' is-active' : ''}`;
      button.setAttribute('role', 'option');
      button.innerHTML = `<span class="ac-name"></span><span class="ac-py"></span>`;
      button.querySelector('.ac-name').textContent = item.name;
      button.querySelector('.ac-py').textContent = item.pinyin || item.short || '';
      button.addEventListener('mousedown', (event) => {
        event.preventDefault();
        choose(item);
      });
      menu.appendChild(button);
    });
    menu.hidden = false;
    position();
  };

  const update = async () => {
    const query = input.value.trim();
    if (!query) return close();
    let list = [];
    try {
      list = await getList();
    } catch {
      return close();
    }
    items = searchStations(list, query);
    active = items.length ? 0 : -1;
    render();
  };

  input.addEventListener('input', update);
  input.addEventListener('focus', update);
  input.addEventListener('keydown', (event) => {
    if (menu.hidden) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      active = (active + delta + items.length) % items.length;
      render();
    } else if (event.key === 'Enter') {
      if (active >= 0 && items[active]) {
        event.preventDefault();
        choose(items[active]);
      }
    } else if (event.key === 'Escape') {
      close();
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  window.addEventListener('resize', () => {
    if (!menu.hidden) position();
  });

  return close;
}
