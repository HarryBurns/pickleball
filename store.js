// Хранилище данных.
//  - remote: Firebase Realtime Database через REST API + SSE-стрим (без SDK).
//  - local:  только localStorage (если адрес базы не задан).
// Структура данных:
//   players/{id}:  { name, handle, walletId, archived, createdAt }
//   wallets/{id}:  { name, createdAt }  — общий кошелёк нескольких игроков
//   games/{id}:    { date, time, duration, place, cost, payerId, players: {id: true}, note, createdAt, updatedAt }
//   payments/{id}: { kind: "payment" | "debt", fromId, toId, amount, date, note, createdAt }
//   settings:      { currency }

const LS_DB_OVERRIDE = "pb:dbUrl";
const COLLECTIONS = ["players", "wallets", "games", "payments"];
const REQUEST_TIMEOUT = 15000;
const RETRY_MIN = 3000;
const RETRY_MAX = 60000;

const EMPTY = () => ({ players: {}, wallets: {}, games: {}, payments: {}, settings: {} });

function normalizeUrl(url) {
  return (url || "").trim().replace(/\/+$/, "");
}

export function getDatabaseUrl() {
  let override = null;
  try { override = localStorage.getItem(LS_DB_OVERRIDE); } catch {}
  if (override !== null) return { url: normalizeUrl(override), source: "local" };
  const cfg = (window.PICKLEBALL_CONFIG || {}).databaseURL;
  return { url: normalizeUrl(cfg), source: "config" };
}

export function setDatabaseUrlOverride(url) {
  try {
    if (url === null) localStorage.removeItem(LS_DB_OVERRIDE);
    else localStorage.setItem(LS_DB_OVERRIDE, normalizeUrl(url));
  } catch {}
}

function readJSON(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function splitPath(path) {
  return path.split("/").filter(Boolean);
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function withDefaults(root) {
  const d = EMPTY();
  if (isObj(root)) for (const k of Object.keys(d)) if (isObj(root[k])) d[k] = root[k];
  return d;
}

// Применяет значение по пути к объекту (мутирует). null — удаление.
function setAtPath(root, segments, value) {
  if (segments.length === 0) return value;
  let node = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const s = segments[i];
    if (!isObj(node[s])) node[s] = {};
    node = node[s];
  }
  const last = segments[segments.length - 1];
  if (value === null || value === undefined) delete node[last];
  else node[last] = value;
  return root;
}

// ---------- проверка данных ----------
// База открыта всем, поэтому всё, что пришло из неё, проверяем: кривая запись
// (например, полузаписанный игрок без имени) не должна ломать приложение.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const str = (v) => (typeof v === "string" ? v : "");
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function cleanCollection(src, fn) {
  const out = {};
  for (const [id, v] of Object.entries(src || {})) {
    if (!isObj(v)) continue;
    const c = fn(v);
    if (c) out[id] = c;
  }
  return out;
}

export function cleanState(raw) {
  const s = withDefaults(raw);
  const players = cleanCollection(s.players, (p) => {
    const name = str(p.name).trim();
    if (!name) return null;
    return { ...p, name, handle: str(p.handle), walletId: str(p.walletId), archived: p.archived === true };
  });
  const wallets = cleanCollection(s.wallets, (w) => ({ ...w, name: str(w.name) }));
  const games = cleanCollection(s.games, (g) => {
    if (!DATE_RE.test(str(g.date))) return null;
    const ids = isObj(g.players) ? Object.keys(g.players).filter((id) => g.players[id] === true) : [];
    return {
      ...g,
      time: TIME_RE.test(str(g.time)) ? g.time : "",
      duration: Math.max(0, num(g.duration)),
      cost: Math.max(0, num(g.cost)),
      payerId: str(g.payerId),
      players: Object.fromEntries(ids.map((id) => [id, true])),
      place: str(g.place),
      note: str(g.note),
    };
  });
  const payments = cleanCollection(s.payments, (p) => {
    const amount = num(p.amount);
    if (!str(p.fromId) || !str(p.toId) || amount <= 0) return null;
    return {
      ...p,
      kind: p.kind === "debt" ? "debt" : "payment",
      amount,
      date: DATE_RE.test(str(p.date)) ? p.date : "",
      note: str(p.note),
    };
  });
  return { players, wallets, games, payments, settings: s.settings };
}

// ---------- хранилище ----------

export function createStore() {
  const { url, source } = getDatabaseUrl();
  const mode = url ? "remote" : "local";
  // Кэш и очередь — свои для каждой базы, чтобы при смене адреса не смешивать данные.
  const scope = url || "local";
  const LS_CACHE = `pb:cache:${scope}`;
  const LS_QUEUE = `pb:queue:${scope}`;
  migrateOldKeys(LS_CACHE, LS_QUEUE, source);

  let state = withDefaults(readJSON(LS_CACHE, null));
  let data = null; // проверенная копия state, пересчитывается лениво
  let queue = readJSON(LS_QUEUE, []);
  if (!Array.isArray(queue)) queue = [];
  let status = mode === "remote" ? "connecting" : "local";
  let loaded = mode === "local";
  let lastError = "";
  const listeners = new Set();
  let es = null;
  let flushing = false;
  let retryTimer = null;
  let reconnectTimer = null;
  let reconnectDelay = RETRY_MIN;

  function emit() {
    data = null;
    for (const fn of listeners) fn();
  }

  function persist() {
    writeJSON(LS_CACHE, state);
  }

  function setStatus(s, err = "") {
    status = s;
    lastError = err;
    emit();
  }

  // Повторно накладываем ещё не отправленные изменения поверх данных с сервера,
  // чтобы оптимистичные правки не "мигали".
  function overlayQueue() {
    for (const op of queue) state = withDefaults(setAtPath(state, splitPath(op.path), op.value));
  }

  function applyRemote(path, value, isPatch) {
    const seg = splitPath(path);
    if (isPatch && isObj(value)) {
      for (const [k, v] of Object.entries(value)) {
        state = withDefaults(setAtPath(state, [...seg, ...splitPath(k)], v));
      }
    } else {
      state = withDefaults(setAtPath(state, seg, value));
    }
    overlayQueue();
    persist();
  }

  async function send(op) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
    try {
      return await fetch(`${url}/${op.path}.json`, op.value === null
        ? { method: "DELETE", signal: ctrl.signal }
        : { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(op.value), signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function dropFirst() {
    queue.shift();
    writeJSON(LS_QUEUE, queue);
  }

  async function flush() {
    if (mode !== "remote" || flushing) return;
    flushing = true;
    clearTimeout(retryTimer);
    let rejected = false;
    try {
      while (queue.length) {
        const res = await send(queue[0]);
        if (res.ok) { dropFirst(); continue; }
        // 4xx (кроме 408/429) — база отклонила запись: повторять бесполезно,
        // иначе очередь застрянет навсегда. Выбрасываем и берём данные с сервера.
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
          dropFirst();
          rejected = true;
          lastError = `База отклонила изменение (HTTP ${res.status})`;
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      if (rejected) { connect(); return; } // перечитать актуальные данные
      if (lastError.startsWith("База отклонила")) lastError = "";
      if (es && es.readyState === 1) setStatus("online", lastError);
      else emit();
    } catch (e) {
      setStatus("offline", e.name === "AbortError" ? "Сервер не отвечает" : "Нет соединения с базой");
      retryTimer = setTimeout(flush, RETRY_MIN * 2);
    } finally {
      flushing = false;
    }
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RETRY_MAX);
  }

  function connect() {
    if (mode !== "remote") return;
    clearTimeout(reconnectTimer);
    if (es) es.close();
    setStatus("connecting", lastError);
    try {
      es = new EventSource(`${url}/.json`);
    } catch (e) {
      setStatus("offline", String(e.message || e));
      scheduleReconnect();
      return;
    }
    const onEvent = (isPatch) => (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg.path !== "string") return;
      applyRemote(msg.path, msg.data, isPatch);
      loaded = true;
      reconnectDelay = RETRY_MIN;
      status = "online";
      if (!lastError.startsWith("База отклонила")) lastError = "";
      emit();
      if (queue.length) flush();
    };
    es.addEventListener("put", onEvent(false));
    es.addEventListener("patch", onEvent(true));
    // Сервер закрыл стрим (например, изменились правила доступа)
    es.addEventListener("cancel", () => {
      es.close();
      setStatus("offline", "Нет доступа к базе (проверьте правила Firebase)");
      scheduleReconnect();
    });
    es.addEventListener("auth_revoked", () => { es.close(); scheduleReconnect(); });
    es.onerror = () => {
      if (status !== "offline") setStatus("offline", "Нет соединения с базой");
      // При CLOSED браузер сам не переподключится
      if (es.readyState === 2) scheduleReconnect();
    };
  }

  function write(path, value) {
    state = withDefaults(setAtPath(state, splitPath(path), value));
    persist();
    if (mode === "remote") {
      queue.push({ path, value: value === undefined ? null : value });
      writeJSON(LS_QUEUE, queue);
      flush();
    }
    emit();
  }

  // Замена всех данных (восстановление из резервной копии) — по одной записи,
  // чтобы работало и при правилах базы, запрещающих запись коллекции целиком.
  function replaceAll(root) {
    const next = withDefaults(root);
    for (const k of COLLECTIONS) {
      for (const id of Object.keys(state[k])) if (!(id in next[k])) write(`${k}/${id}`, null);
      for (const [id, v] of Object.entries(next[k])) write(`${k}/${id}`, v);
    }
    for (const [k, v] of Object.entries(next.settings)) write(`settings/${k}`, v);
  }

  window.addEventListener("online", () => { connect(); flush(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || mode !== "remote") return;
    if (!es || es.readyState === 2) connect();
    if (queue.length) flush();
  });

  connect();
  if (queue.length) flush();

  return {
    mode,
    url,
    urlSource: source,
    get data() { return data || (data = cleanState(state)); },
    get raw() { return state; },
    get status() { return status; },
    get loaded() { return loaded; },
    get lastError() { return lastError; },
    get pending() { return queue.length; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    write,
    replaceAll,
    reconnect: connect,
  };
}

// До версии с отдельным кэшем на каждую базу ключи были общими.
function migrateOldKeys(cacheKey, queueKey, source) {
  try {
    const oldCache = localStorage.getItem("pb:cache");
    const oldQueue = localStorage.getItem("pb:queue");
    if (oldCache === null && oldQueue === null) return;
    if (source === "config") {
      if (oldCache !== null && localStorage.getItem(cacheKey) === null) localStorage.setItem(cacheKey, oldCache);
      if (oldQueue !== null && localStorage.getItem(queueKey) === null) localStorage.setItem(queueKey, oldQueue);
    }
    localStorage.removeItem("pb:cache");
    localStorage.removeItem("pb:queue");
  } catch {}
}

export function newId() {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${t}${r}`;
}
