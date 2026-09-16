// Orbit — the phone UI. It talks only to the relay: /api/state (polled while visible),
// /api/action, /api/installed and /api/icon/:bundleId. What it shows is the agent's latest
// snapshot; every change goes through /api/action and, on the Mac, the agent's allow-list.

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

const POLL_MS = 2500;
const FAVORITES_KEY = 'orbit.favorites';
// Seeded from the allow-list of the earlier 网页控制电脑 project; only installed apps show up.
const DEFAULT_FAVORITES = [
  'com.apple.Safari', 'com.google.Chrome', 'ru.keepcoder.Telegram', 'org.telegram.desktop',
  'com.apple.finder', 'com.apple.Notes', 'com.apple.Terminal', 'com.apple.calculator',
  'com.apple.iCal', 'com.apple.Music', 'com.apple.MobileSMS', 'com.apple.mail',
  'com.apple.Photos', 'com.apple.Preview', 'com.apple.TextEdit', 'com.apple.systempreferences',
];

const ERRORS = {
  'agent-offline': 'Mac 当前不在线',
  'agent-timeout': 'Mac 没有及时响应',
  'bad-params': '参数不合法',
  'no-such-app': '找不到这个应用',
  'no-such-device': '找不到这个输出设备',
  'clash-not-installed': '这台 Mac 上没有 Clash Verge',
  'clash-not-running': 'Clash Verge 没在运行，现在开系统代理会让 Mac 上不了网',
  'clash-pac-mode': 'Clash Verge 用的是 PAC 模式，暂不支持远程切换',
  'no-network-service': '找不到 Mac 当前使用的网络',
  'no-such-display': '找不到这个显示器',
  'no-ddc-display': '没有找到能用 DDC 控制的外接显示器',
  'ddc-write-failed': '显示器没有接受这条指令',
  'accessibility-not-granted': '需要先在 Mac 上授予「辅助功能」权限',
  'nightshift-unavailable': '这台 Mac 上夜览不可用',
  'slow-down': '操作太频繁了，稍等一下',
  timeout: 'Mac 上的命令超时了',
  unauthenticated: '登录已过期',
};

const TRANSPORT = { builtin: '内建', bluetooth: '蓝牙', display: '显示器', usb: 'USB', airplay: 'AirPlay', virtual: '虚拟', other: '' };

// Icons live in <template>s in index.html; cloning them keeps innerHTML out of the code.
const icon = (id) => document.getElementById(id).content.firstElementChild.cloneNode(true);

const view = { state: null, online: false, lastSeen: 0, stateAt: 0, installed: null };
const pendingToggles = new Set();
let favoritesLoaded = false;
let pollTimer = 0;

// ---- plumbing ------------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, body = {}) {
    super(body.message || body.error || `HTTP ${status}`);
    this.status = status;
    this.code = body.error;
    this.body = body;
  }
}

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401) {
    location.replace('/');
    throw new ApiError(401, { error: 'unauthenticated' });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new ApiError(response.status, data);
  return data;
}

function describe(error) {
  if (error.code === 'denied') return error.body?.message || '这个操作被 Mac 拒绝了';
  if (ERRORS[error.code]) return ERRORS[error.code];
  if (error.code === 'command-failed' && error.body?.message) return `执行失败：${error.body.message}`;
  return error instanceof ApiError ? '出错了，请重试' : '网络不通，请稍后再试';
}

// Runs an action on the Mac. Resolves to the result, or null when the user backs out of a
// confirmation the agent asked for. Failures are shown as a toast and rethrown.
async function act(action, params = {}, { confirmed = false } = {}) {
  let data;
  try {
    data = await request('/api/action', { method: 'POST', body: { action, params, confirmed } });
  } catch (error) {
    toast(describe(error), 'error');
    throw error;
  }
  if (data.result?.needsConfirm) {
    const yes = await sheet({
      title: '请确认',
      message: data.result.reason || '确定要这样做吗？',
      options: [{ label: '继续', value: true, danger: true }],
    });
    return yes ? act(action, params, { confirmed: true }) : null;
  }
  if (data.state) {
    view.state = data.state;
    view.stateAt = Date.now();
    render();
  }
  return data.result ?? {};
}

// ---- polling -------------------------------------------------------------------------------

async function poll() {
  clearTimeout(pollTimer);
  try {
    const data = await request('/api/state');
    view.online = data.online;
    view.lastSeen = data.lastSeen;
    view.stateAt = data.stateAt;
    if (data.state) view.state = data.state;
  } catch (error) {
    if (error.status === 401) return;
    view.online = false;
  }
  render();
  if (document.visibilityState === 'visible') pollTimer = setTimeout(poll, POLL_MS);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') poll();
  else clearTimeout(pollTimer);
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) poll();
});

// ---- rendering -----------------------------------------------------------------------------

function ago(ts) {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 5) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} 分钟前` : `${Math.round(minutes / 60)} 小时前`;
}

function render() {
  document.body.classList.remove('is-loading');
  document.body.dataset.link = view.online ? 'online' : 'offline';
  renderLink();
  const state = view.state;
  if (!state) return;
  renderHeader(state);
  renderToggles(state);
  renderMedia(state);
  renderBrightness(state);
  renderVolume(state);
  renderRunning(state.apps ?? []);
  if (view.online && !favoritesLoaded) renderFavorites();
}

function renderLink() {
  $('#beacon').dataset.link = view.online ? 'online' : view.state || view.lastSeen ? 'offline' : 'unknown';
  let text = '离线 · 等待 Mac 连接';
  if (view.online) text = view.stateAt ? `在线 · ${ago(view.stateAt)}同步` : '在线';
  else if (view.lastSeen) text = `离线 · 最后在线 ${ago(view.lastSeen)}`;
  $('#link-text').textContent = text;

  const banner = $('#offline-banner');
  banner.hidden = view.online || document.body.classList.contains('is-loading');
  banner.textContent = 'Mac 暂时不在线，恢复连接后会自动刷新';
}
setInterval(renderLink, 1000);

function renderHeader(state) {
  $('#host-name').textContent = state.host?.name || 'Mac';
  const battery = $('#battery');
  battery.hidden = !state.battery;
  if (state.battery) battery.textContent = `${state.battery.percent}%${state.battery.onAC ? ' ⚡︎' : ''}`;
}

// ---- toggles -------------------------------------------------------------------------------

const TOGGLES = {
  wifi: {
    on: (s) => Boolean(s.network?.wifi?.on),
    available: (s) => Boolean(s.network?.wifi),
    sub: (s) => {
      const wifi = s.network?.wifi;
      if (!wifi) return '不可用';
      if (!wifi.on) return '已关闭';
      return wifi.isUplink ? '已连接' : '已开启';
    },
    run: (next) => act('wifi.set', { on: next }),
    optimistic: false, // the owner's policy refuses "off": show the refusal, not a flicker
  },
  bluetooth: {
    on: (s) => Boolean(s.network?.bluetooth?.on),
    available: (s) => Boolean(s.capabilities?.bluetooth),
    sub: (s) => {
      if (!s.capabilities?.bluetooth) return '需要授权';
      return s.network.bluetooth.on ? '已开启' : '已关闭';
    },
    run: (next) => act('bluetooth.set', { on: next }),
  },
  proxy: {
    on: (s) => Boolean(s.network?.proxy?.on),
    available: (s) => Boolean(s.capabilities?.systemProxy) && !s.network?.proxy?.pac,
    sub: (s) => {
      const proxy = s.network?.proxy;
      if (!proxy) return '没有找到 Clash Verge';
      if (proxy.pac) return 'PAC 模式，暂不支持';
      if (proxy.on) return '已开启 · Clash Verge';
      return proxy.elsewhere ? '指向其他代理' : '已关闭';
    },
    run: (next) => act('proxy.set', { on: next }),
  },
  dark: {
    on: (s) => Boolean(s.display?.dark),
    available: () => true,
    run: (next) => act('display.dark.set', { on: next }),
  },
  nightShift: {
    on: (s) => Boolean(s.display?.nightShift?.enabled),
    available: (s) => Boolean(s.capabilities?.nightShift),
    run: (next) => act('display.nightShift.set', { on: next }),
  },
  stageManager: {
    on: (s) => Boolean(s.display?.stageManager),
    available: (s) => Boolean(s.capabilities?.stageManager),
    run: (next) => act('display.stageManager.set', { on: next }),
  },
  mute: {
    on: (s) => Boolean(s.sound?.muted),
    available: (s) => s.sound?.volume !== null && s.sound?.volume !== undefined,
    run: (next) => act('sound.mute.set', { on: next }),
  },
};

function renderToggles(state) {
  for (const button of $$('[data-toggle]')) {
    const key = button.dataset.toggle;
    const spec = TOGGLES[key];
    if (!pendingToggles.has(key)) button.setAttribute('aria-pressed', String(spec.on(state)));
    button.disabled = !spec.available(state);
    const sub = $('[data-sub]', button);
    if (sub && spec.sub) sub.textContent = spec.sub(state);
  }
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-toggle]');
  if (!button || button.disabled || pendingToggles.has(button.dataset.toggle)) return;
  const key = button.dataset.toggle;
  const spec = TOGGLES[key];
  const was = button.getAttribute('aria-pressed') === 'true';
  pendingToggles.add(key);
  button.classList.add('busy');
  if (spec.optimistic !== false) button.setAttribute('aria-pressed', String(!was));
  try {
    const result = await spec.run(!was);
    if (result === null) button.setAttribute('aria-pressed', String(was));
  } catch {
    button.setAttribute('aria-pressed', String(was));
  } finally {
    pendingToggles.delete(key);
    button.classList.remove('busy');
    if (view.state) renderToggles(view.state);
  }
});

// ---- media ---------------------------------------------------------------------------------

function renderMedia(state) {
  const ok = Boolean(state.capabilities?.mediaKeys);
  for (const button of $$('[data-media]')) button.disabled = !ok;
  $('#media-note').textContent = ok ? '控制 Mac 上正在播放的内容' : '需要在 Mac 上授予「辅助功能」权限';
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-media]');
  if (button && !button.disabled) act('media.key', { key: button.dataset.media }).catch(() => {});
});

// ---- faders --------------------------------------------------------------------------------

// A fader sends at most ~5 values per second while dragging and ignores polled values until
// shortly after the last interaction, so the bar never jumps back under the finger.
function fader(root, send) {
  const input = $('input', root);
  const readout = $('.fader-value', root);
  let holdUntil = 0;
  let inflight = 0;
  let queued = null;
  let timer = 0;

  const paint = (value) => {
    input.value = String(value);
    input.style.setProperty('--fill', `${value}%`);
    readout.textContent = `${value}%`;
    root.classList.toggle('lit', value >= 10);
    root.classList.toggle('full', value >= 86);
  };
  const hold = () => {
    holdUntil = Date.now() + 1500;
  };
  const flush = () => {
    clearTimeout(timer);
    timer = 0;
    if (queued === null) return;
    const value = queued;
    queued = null;
    inflight += 1;
    send(value).catch(() => {}).finally(() => {
      inflight -= 1;
      hold();
    });
  };

  input.addEventListener('pointerdown', hold);
  input.addEventListener('input', () => {
    hold();
    const value = Number(input.value);
    paint(value);
    queued = value;
    if (!timer) timer = setTimeout(flush, 180);
  });
  input.addEventListener('change', flush);

  return {
    root,
    set(value) {
      if (inflight > 0 || Date.now() < holdUntil || value === null || value === undefined) return;
      paint(value);
    },
    disable(disabled) {
      input.disabled = disabled;
      root.classList.toggle('is-disabled', disabled);
    },
  };
}

const volumeFader = fader($('#volume-fader'), (value) => act('sound.volume.set', { value }));

function renderVolume(state) {
  const { volume = null, muted = false, outputs = [] } = state.sound ?? {};
  volumeFader.disable(volume === null);
  volumeFader.set(volume ?? 0);
  volumeFader.root.classList.toggle('is-muted', Boolean(muted));
  $('#output-name').textContent = outputs.find((output) => output.current)?.name ?? '输出设备';
  $('#output-button').disabled = outputs.length < 2;
  const note = $('#volume-note');
  note.hidden = volume !== null;
  note.textContent = '当前输出设备不支持调节音量';
}

$('#output-button').addEventListener('click', async () => {
  const outputs = view.state?.sound?.outputs ?? [];
  const pick = await sheet({
    title: '声音输出',
    options: outputs.map((output) => ({ label: output.name, detail: TRANSPORT[output.transport] ?? '', value: output, checked: output.current })),
  });
  if (pick && !pick.current) {
    act('sound.output.set', { id: pick.id }).then((result) => result && toast(`已切换到「${pick.name}」`)).catch(() => {});
  }
});

// The monitor's own standby over DDC. Nothing reports that state back, so the button remembers
// what it last sent: after sending the monitor to standby, the same button wakes it again.
let displayAsleep = false;

function renderDisplayPower() {
  $('#display-off-name').textContent = displayAsleep ? '唤醒显示器' : '关闭显示器';
  $('#brightness-note').textContent = displayAsleep ? '显示器已待机。动鼠标不会点亮它；在 Mac 上敲一下键盘或点一下鼠标就会亮，也可以点上面的按钮。' : '';
}

$('#display-off')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    if (await act('display.awake.set', { on: displayAsleep })) {
      displayAsleep = !displayAsleep;
      toast(displayAsleep ? '显示器已进入待机' : '已唤醒显示器');
      renderDisplayPower();
    }
  } catch {
    // act() already explained the failure
  } finally {
    button.disabled = false;
  }
});

const screenFaders = new Map();

function renderBrightness(state) {
  const screens = state.display?.screens ?? [];
  $('#brightness-tile').hidden = screens.length === 0;
  $('#brightness-name').textContent = screens.length === 1 ? screens[0].name : '';
  const stack = $('#brightness-faders');
  for (const screen of screens) {
    let entry = screenFaders.get(screen.id);
    if (!entry) {
      const block = $('#screen-fader').content.firstElementChild.cloneNode(true);
      entry = fader($('.fader', block), (value) => act('display.brightness.set', { display: screen.id, value }));
      entry.block = block;
      screenFaders.set(screen.id, entry);
      stack.append(block);
    }
    $('.fader-caption', entry.block).textContent = screens.length > 1 ? screen.name : '';
    entry.set(screen.brightness);
  }
  for (const [id, entry] of screenFaders) {
    if (!screens.some((screen) => screen.id === id)) {
      entry.block.remove();
      screenFaders.delete(id);
    }
  }
}

// ---- apps ----------------------------------------------------------------------------------

function appIcon(bundleId, size) {
  const img = new Image(size, size);
  img.className = 'app-icon';
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  if (bundleId) img.src = `/api/icon/${encodeURIComponent(bundleId)}`;
  else img.classList.add('missing');
  img.addEventListener('error', () => img.classList.add('missing'), { once: true });
  return img;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const rows = new Map(); // pid -> row

function runningRow(initial) {
  let app = initial;
  const el = element('li', 'app-row');
  const main = element('button', 'app-main');
  main.type = 'button';
  const name = element('span', 'app-name');
  const meta = element('span', 'app-meta');
  const text = element('span', 'app-text');
  text.append(name, meta);
  main.append(appIcon(app.bundleId, 40), text);
  const more = element('button', 'app-more');
  more.type = 'button';
  more.setAttribute('aria-label', '更多操作');
  more.append(icon('icon-more'));
  el.append(main, more);

  main.addEventListener('click', () => {
    act('apps.activate', { bundleId: app.bundleId }).then((result) => result && toast(`已切到「${app.name}」`)).catch(() => {});
  });
  more.addEventListener('click', () => appActions(app));

  return {
    el,
    update(next) {
      app = next;
      name.textContent = next.name;
      meta.textContent = next.active ? '前台' : next.hidden ? '已隐藏' : '';
      main.disabled = !next.bundleId;
      el.classList.toggle('is-active', next.active);
    },
  };
}

function renderRunning(apps) {
  const list = $('#running');
  const sorted = [...apps].sort((a, b) => Number(b.active) - Number(a.active) || collator.compare(a.name, b.name));
  for (const app of sorted) {
    if (!rows.has(app.pid)) rows.set(app.pid, runningRow(app));
    rows.get(app.pid).update(app);
  }
  for (const [pid, row] of rows) {
    if (!sorted.some((app) => app.pid === pid)) {
      row.el.remove();
      rows.delete(pid);
    }
  }
  // Reorder only when needed, so rows (and their icons) are moved rather than rebuilt.
  const order = sorted.map((app) => rows.get(app.pid).el);
  if (order.length !== list.children.length || order.some((el, index) => list.children[index] !== el)) {
    list.replaceChildren(...order);
  }
  $('#running-count').textContent = `${apps.length} 个`;
}

async function appActions(app) {
  const choice = await sheet({
    title: app.name,
    options: [
      { label: '切到前台', value: 'activate' },
      { label: '隐藏', value: 'hide' },
      { label: '退出', value: 'quit' },
      { label: '强制退出', value: 'forceQuit', danger: true },
    ],
  });
  try {
    if (choice === 'activate') await act('apps.activate', { bundleId: app.bundleId });
    if (choice === 'hide') await act('apps.hide', { pid: app.pid });
    if (choice === 'quit') await quitApp(app);
    if (choice === 'forceQuit') await forceQuitApp(app);
  } catch {
    // already reported by act()
  }
}

async function quitApp(app) {
  const result = await act('apps.quit', { pid: app.pid });
  if (!result) return;
  if (!result.stillRunning) {
    toast(`已退出「${app.name}」`);
    return;
  }
  const force = await sheet({
    title: `「${app.name}」还没有退出`,
    message: '它可能正在等你保存文件。',
    options: [{ label: '强制退出…', value: true, danger: true }],
  });
  if (force) await forceQuitApp(app);
}

async function forceQuitApp(app) {
  const result = await act('apps.forceQuit', { pid: app.pid });
  if (result) toast(result.stillRunning ? `「${app.name}」仍在运行` : `已强制退出「${app.name}」`);
}

async function loadInstalled() {
  if (!view.installed) view.installed = (await request('/api/installed')).apps;
  return view.installed;
}

function favorites() {
  try {
    const saved = JSON.parse(localStorage.getItem(FAVORITES_KEY));
    if (Array.isArray(saved)) return saved;
  } catch {
    // storage unavailable: fall back to the defaults
  }
  return DEFAULT_FAVORITES;
}

function saveFavorites(list) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(list));
  } catch {
    // not persisted; still applied for this page view
  }
}

async function openApp(app) {
  const result = await act('apps.open', { bundleId: app.bundleId }).catch(() => null);
  if (result) toast(`已打开「${app.name}」`);
}

async function renderFavorites() {
  let apps;
  try {
    apps = await loadInstalled();
  } catch {
    return;
  }
  favoritesLoaded = true;
  const byId = new Map(apps.map((app) => [app.bundleId, app]));
  const items = favorites().map((id) => byId.get(id)).filter(Boolean).slice(0, 12);
  $('#favorites').replaceChildren(...items.map((app) => {
    const button = element('button', 'fav');
    button.type = 'button';
    button.append(appIcon(app.bundleId, 54), element('span', '', app.name));
    button.addEventListener('click', () => openApp(app));
    return button;
  }));
}

function resultRow(app) {
  const el = element('li', 'app-row');
  const main = element('button', 'app-main');
  main.type = 'button';
  const text = element('span', 'app-text');
  text.append(element('span', 'app-name', app.name), element('span', 'app-meta', app.bundleId));
  main.append(appIcon(app.bundleId, 40), text);
  main.addEventListener('click', () => openApp(app));

  const star = element('button', 'app-star');
  star.type = 'button';
  star.append(icon('icon-star'));
  const paintStar = () => {
    const pinned = favorites().includes(app.bundleId);
    star.setAttribute('aria-pressed', String(pinned));
    star.setAttribute('aria-label', pinned ? '从常用中移除' : '加入常用');
  };
  paintStar();
  star.addEventListener('click', () => {
    const list = favorites();
    saveFavorites(list.includes(app.bundleId) ? list.filter((id) => id !== app.bundleId) : [...list, app.bundleId]);
    paintStar();
    renderFavorites();
  });

  el.append(main, star);
  return el;
}

let searchTimer = 0;
$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 120);
});

async function runSearch() {
  const input = $('#search');
  const query = input.value.trim().toLowerCase();
  const results = $('#results');
  $('#favorites').hidden = Boolean(query);
  if (!query) {
    results.replaceChildren();
    return;
  }
  let apps;
  try {
    apps = await loadInstalled();
  } catch (error) {
    results.replaceChildren(element('li', 'empty', describe(error)));
    return;
  }
  if (input.value.trim().toLowerCase() !== query) return; // a newer search is on its way
  const hits = apps
    .filter((app) => app.name.toLowerCase().includes(query) || app.bundleId.toLowerCase().includes(query))
    .sort((a, b) => collator.compare(a.name, b.name))
    .slice(0, 30);
  results.replaceChildren(...(hits.length ? hits.map(resultRow) : [element('li', 'empty', `没有找到「${input.value.trim()}」`)]));
}

// ---- sheet, toast, logout ------------------------------------------------------------------

// Bottom sheet with a list of choices. Resolves to the chosen option's value, or null.
function sheet({ title, message = '', options }) {
  const dialog = $('#sheet');
  $('#sheet-title').textContent = title;
  $('#sheet-message').textContent = message;
  $('#sheet-options').replaceChildren(...options.map((option, index) => {
    const button = element('button', `sheet-option${option.danger ? ' danger' : ''}${option.checked ? ' checked' : ''}`);
    button.value = String(index);
    button.append(element('span', '', option.label));
    if (option.detail) button.append(element('small', '', option.detail));
    return button;
  }));
  dialog.returnValue = 'cancel';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      const index = Number(dialog.returnValue);
      resolve(Number.isInteger(index) && options[index] ? options[index].value : null);
    }, { once: true });
    dialog.showModal();
  });
}

$('#sheet').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close('cancel');
});

let toastTimer = 0;
function toast(text, tone = 'info') {
  const el = $('#toast');
  el.textContent = text;
  el.dataset.tone = tone;
  el.hidden = false;
  el.classList.remove('show');
  void el.offsetWidth; // restart the transition
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => {
      el.hidden = true;
    }, 260);
  }, 2800);
}

$('#logout').addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  location.replace('/');
});

poll();
