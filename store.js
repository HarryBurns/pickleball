// Хранилище данных.
//  - remote: Firebase Realtime Database через REST API + SSE-стрим (без SDK).
//  - local:  только localStorage (если адрес базы не задан).
// Структура данных:
//   players/{id}:  { name, archived, createdAt }
//   games/{id}:    { date, time, place, cost, payerId, players: {id: true}, note, createdAt, updatedAt }
//   payments/{id}: { fromId, toId, amount, date, note, createdAt }
//   settings:      { currency }

const LS_CACHE = "pb:cache";
const LS_QUEUE = "pb:queue";
const LS_DB_OVERRIDE = "pb:dbUrl";

const EMPTY = () => ({ players: {}, games: {}, payments: {}, settings: {} });

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

function withDefaults(root) {
  const d = EMPTY();
  if (root && typeof root === "object") {
    for (const k of Object.keys(d)) if (root[k] && typeof root[k] === "object") d[k] = root[k];
  }
  return d;
}

// Применяет значение по пути к объекту (мутирует). null — удаление.
function setAtPath(root, segments, value) {
  if (segments.length === 0) return value;
  let node = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const s = segments[i];
    if (!node[s] || typeof node[s] !== "object") node[s] = {};
    node = node[s];
  }
  const last = segments[segments.length - 1];
  if (value === null || value === undefined) delete node[last];
  else node[last] = value;
  return root;
}

export function createStore() {
  const { url, source } = getDatabaseUrl();
  const mode = url ? "remote" : "local";
  let state = withDefaults(readJSON(LS_CACHE, null));
  let queue = readJSON(LS_QUEUE, []);
  let status = mode === "remote" ? "connecting" : "local";
  let loaded = mode === "local";
  let lastError = "";
  const listeners = new Set();
  let es = null;
  let flushing = false;
  let retryTimer = null;

  function emit() {
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

  function applyRemote(path, data, isPatch) {
    const seg = splitPath(path);
    if (isPatch && data && typeof data === "object") {
      for (const [k, v] of Object.entries(data)) {
        state = withDefaults(setAtPath(state, [...seg, ...splitPath(k)], v));
      }
    } else {
      state = withDefaults(setAtPath(state, seg, data));
    }
    overlayQueue();
    persist();
  }

  async function flush() {
    if (mode !== "remote" || flushing) return;
    flushing = true;
    try {
      while (queue.length) {
        const op = queue[0];
        const endpoint = `${url}/${op.path}.json`;
        const res = await fetch(endpoint, op.value === null
          ? { method: "DELETE" }
          : { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(op.value) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        queue.shift();
        writeJSON(LS_QUEUE, queue);
      }
      if (status !== "online" && es && es.readyState === 1) setStatus("online");
      else emit();
    } catch (e) {
      setStatus("offline", String(e.message || e));
      clearTimeout(retryTimer);
      retryTimer = setTimeout(flush, 5000);
    } finally {
      flushing = false;
    }
  }

  function connect() {
    if (mode !== "remote") return;
    if (es) es.close();
    setStatus("connecting");
    try {
      es = new EventSource(`${url}/.json`);
    } catch (e) {
      setStatus("offline", String(e.message || e));
      return;
    }
    const onEvent = (isPatch) => (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg.path !== "string") return;
      applyRemote(msg.path, msg.data, isPatch);
      loaded = true;
      status = "online";
      lastError = "";
      emit();
      if (queue.length) flush();
    };
    es.addEventListener("put", onEvent(false));
    es.addEventListener("patch", onEvent(true));
    es.addEventListener("cancel", () => setStatus("offline", "Нет доступа к базе (проверьте правила Firebase)"));
    es.onerror = () => {
      if (status !== "offline") setStatus("offline", "Нет соединения с базой");
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

  function replaceAll(root) {
    const data = withDefaults(root);
    if (mode === "remote") {
      for (const k of Object.keys(EMPTY())) write(k, Object.keys(data[k]).length ? data[k] : null);
    } else {
      state = data;
      persist();
      emit();
    }
  }

  window.addEventListener("online", () => { connect(); flush(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && mode === "remote" && (!es || es.readyState === 2)) connect();
  });

  connect();
  if (queue.length) flush();

  return {
    mode,
    url,
    urlSource: source,
    get state() { return state; },
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

export function newId() {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${t}${r}`;
}
