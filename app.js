import { createStore, newId, getDatabaseUrl, setDatabaseUrlOverride } from "./store.js";
import { computeLedger, computeStats, gamePlayerIds, splitCost, toCents, fromCents } from "./ledger.js";

const store = createStore();
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ui = {
  tab: localStorageGet("pb:tab") || "games",
  calMonth: null, // "YYYY-MM"
  dayFilter: null, // "YYYY-MM-DD"
  debtMode: localStorageGet("pb:debtMode2") || "direct",
  showArchived: false,
  showAllPast: false,
  statsPeriod: "all", // "all" | "YYYY" | "YYYY-MM"
};

// ---------- утилиты ----------

function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const pad = (n) => String(n).padStart(2, "0");
function isoDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayIso() { return isoDate(new Date()); }
function parseIso(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }

const WEEKDAYS = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

function fmtDate(s, withYear) {
  if (!s) return "";
  const d = parseIso(s);
  const y = withYear || d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : "";
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS_GEN[d.getMonth()]}${y}`;
}

function currency() { return (store.state.settings && store.state.settings.currency) ?? "₽"; }
const numFmt = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2, minimumFractionDigits: 0 });
function money(cents) {
  const c = currency();
  return `${numFmt.format(fromCents(cents))}${c ? " " + esc(c) : ""}`;
}

function players() { return store.state.players || {}; }
function wallets() { return store.state.wallets || {}; }
function playerName(id) { const p = players()[id]; return p ? p.name : "(удалён)"; }
function walletMembers(wid) {
  return sortedPlayers((p) => p.walletId === wid);
}
function walletName(wid) {
  const w = wallets()[wid];
  if (w && w.name) return w.name;
  const names = walletMembers(wid).map((p) => p.name);
  return names.length ? names.join(" + ") : "(пустой кошелёк)";
}
// Название участника расчётов по ключу "w:<id>" / "p:<id>"
function keyName(key) {
  return key.startsWith("w:") ? walletName(key.slice(2)) : playerName(key.slice(2));
}
// Игрок, от имени которого записываем перевод для кошелька
function keyRep(key) {
  if (!key.startsWith("w:")) return key.slice(2);
  const m = walletMembers(key.slice(2));
  return (m.find((p) => !p.archived) || m[0] || {}).id;
}
function hoursFmt(h) { return `${numFmt.format(Math.round(h * 10) / 10)} ч`; }
function endTime(time, duration) {
  if (!time || !duration) return "";
  const [h, m] = time.split(":").map(Number);
  const t = h * 60 + m + Math.round(duration * 60);
  return `${pad(Math.floor(t / 60) % 24)}:${pad(t % 60)}`;
}
function sortedPlayers(filter = () => true) {
  return Object.entries(players())
    .map(([id, p]) => ({ id, ...p }))
    .filter(filter)
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
}
function gamesList() {
  return Object.entries(store.state.games || {})
    .map(([id, g]) => ({ id, ...g }))
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.time || "").localeCompare(a.time || ""));
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2500);
}

// ---------- модальные окна ----------

const modal = $("#modal");
let modalResolve = null;

function openModal(html, onMount) {
  modal.innerHTML = html;
  if (!modal.open) modal.showModal();
  onMount && onMount(modal);
  return new Promise((res) => { modalResolve = res; });
}
function closeModal(result) {
  if (modal.open) modal.close();
  const r = modalResolve;
  modalResolve = null;
  r && r(result);
}
modal.addEventListener("cancel", (e) => { e.preventDefault(); closeModal(null); });
modal.addEventListener("click", (e) => {
  if (e.target === modal && !modal.querySelector("form")) closeModal(null);
  const btn = e.target.closest("[data-close]");
  if (btn) closeModal(btn.dataset.close === "ok" ? true : null);
});

function confirmDialog({ title, text, okText = "OK", danger = false }) {
  return openModal(`
    <div class="sheet">
      <h2>${esc(title)}</h2>
      ${text ? `<p class="muted">${text}</p>` : ""}
      <div class="row end">
        <button type="button" class="btn ghost" data-close="cancel">Отмена</button>
        <button type="button" class="btn ${danger ? "danger" : "primary"}" data-close="ok">${esc(okText)}</button>
      </div>
    </div>`, (m) => $("[data-close=ok]", m).focus());
}

async function doubleConfirm(title, text) {
  const first = await confirmDialog({ title, text, okText: "Удалить", danger: true });
  if (!first) return false;
  return !!(await confirmDialog({
    title: "Точно удалить?",
    text: "Это действие нельзя отменить. Все друзья увидят изменения.",
    okText: "Да, удалить навсегда",
    danger: true,
  }));
}

// ---------- действия с данными ----------

function addPlayer(name) {
  name = name.trim();
  if (!name) return null;
  const existing = sortedPlayers().find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    if (existing.archived) {
      store.write(`players/${existing.id}/archived`, false);
      toast(`«${existing.name}» возвращён из архива`);
    } else toast(`«${existing.name}» уже есть`);
    return existing.id;
  }
  const id = newId();
  store.write(`players/${id}`, { name, archived: false, createdAt: Date.now() });
  return id;
}

// ---------- синхронизация / баннер ----------

function renderSync() {
  const el = $("#sync");
  const map = {
    online: ["online", "Онлайн"],
    connecting: ["connecting", "Подключение…"],
    offline: ["offline", "Офлайн"],
    local: ["local", "Локально"],
  };
  const [cls, label] = map[store.status] || map.offline;
  el.className = `sync ${cls}`;
  el.innerHTML = `<i></i>${label}${store.pending ? ` · ${store.pending}` : ""}`;
  el.title = store.lastError || (store.mode === "local" ? "Данные хранятся только в этом браузере" : "Данные синхронизируются с общей базой");

  const banner = $("#banner");
  if (store.mode === "local") {
    banner.innerHTML = `<div class="banner warn">Общая база не подключена — данные видны только на этом устройстве. <a href="#" data-goto="settings">Подключить</a></div>`;
  } else if (store.status === "offline" && store.lastError) {
    banner.innerHTML = `<div class="banner err">${esc(store.lastError)}. Изменения сохранятся и отправятся позже.</div>`;
  } else banner.innerHTML = "";
}
$("#sync").addEventListener("click", () => { if (store.mode === "remote") store.reconnect(); else setTab("settings"); });
$("#banner").addEventListener("click", (e) => {
  const a = e.target.closest("[data-goto]");
  if (a) { e.preventDefault(); setTab(a.dataset.goto); }
});

// ---------- навигация ----------

function setTab(tab) {
  ui.tab = tab;
  localStorageSet("pb:tab", tab);
  render();
  window.scrollTo(0, 0);
}
$$(".tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

function render() {
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === ui.tab));
  renderSync();
  const view = $("#view");
  if (store.mode === "remote" && !store.loaded && !Object.keys(store.state.players).length) {
    view.innerHTML = `<div class="empty">Загрузка данных…</div>`;
    return;
  }
  const views = { games: renderGames, debts: renderDebts, players: renderPlayers, stats: renderStats, settings: renderSettings };
  (views[ui.tab] || renderGames)(view);
}

// ---------- игры ----------

function renderCalendar(games) {
  const today = todayIso();
  const month = ui.calMonth || today.slice(0, 7);
  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const startOffset = (first.getDay() + 6) % 7; // понедельник — первый
  const days = new Date(y, m, 0).getDate();
  const byDate = {};
  for (const g of games) (byDate[g.date] = byDate[g.date] || []).push(g);

  let cells = "";
  for (let i = 0; i < startOffset; i++) cells += `<span></span>`;
  for (let d = 1; d <= days; d++) {
    const iso = `${y}-${pad(m)}-${pad(d)}`;
    const n = (byDate[iso] || []).length;
    const cls = [
      "day",
      n ? (iso < today ? "past" : "future") : "",
      iso === today ? "today" : "",
      ui.dayFilter === iso ? "selected" : "",
    ].join(" ");
    cells += `<button type="button" class="${cls}" data-day="${iso}" title="${n ? `${n} ${plural(n, "игра", "игры", "игр")}` : ""}">${d}${n > 1 ? `<sup>${n}</sup>` : ""}</button>`;
  }
  return `
    <section class="card calendar">
      <div class="cal-head">
        <button type="button" class="icon" data-cal="-1" aria-label="Предыдущий месяц">‹</button>
        <strong>${MONTHS[m - 1]} ${y}</strong>
        <button type="button" class="icon" data-cal="1" aria-label="Следующий месяц">›</button>
      </div>
      <div class="cal-grid">
        ${["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((w) => `<span class="wd">${w}</span>`).join("")}
        ${cells}
      </div>
      <div class="cal-legend"><span class="dot past"></span>прошедшие <span class="dot future"></span>запланированные</div>
    </section>`;
}

function gameCard(g) {
  const ids = gamePlayerIds(g);
  const total = toCents(g.cost);
  const shares = splitCost(total, ids);
  const shareVals = Object.values(shares);
  const share = shareVals.length ? Math.max(...shareVals) : 0;
  const chips = ids
    .map((id) => ({ id, name: playerName(id) }))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"))
    .map((p) => `<span class="chip ${p.id === g.payerId ? "payer" : ""}">${esc(p.name)}</span>`)
    .join("");
  const payerPlays = ids.includes(g.payerId);
  return `
    <article class="card game ${g.date < todayIso() ? "is-past" : ""}">
      <div class="game-head">
        <div>
          <div class="game-date">${esc(fmtDate(g.date))}${g.time ? ` · ${esc(g.time)}${g.duration ? `–${endTime(g.time, g.duration)}` : ""}` : ""}</div>
          ${g.duration ? `<div class="muted small">⏱ ${hoursFmt(Number(g.duration))}</div>` : ""}
          ${g.place ? `<div class="muted small">📍 ${esc(g.place)}</div>` : ""}
        </div>
        <div class="game-cost">
          <strong>${money(total)}</strong>
          ${ids.length ? `<div class="muted small">по ${money(share)} × ${ids.length}</div>` : ""}
        </div>
      </div>
      <div class="muted small">Платил: <b>${esc(playerName(g.payerId))}</b>${payerPlays ? "" : " (не играл)"}</div>
      <div class="chips">${chips || `<span class="muted small">Игроки не выбраны</span>`}</div>
      ${g.note ? `<div class="note">${esc(g.note)}</div>` : ""}
      <div class="row end actions">
        <button type="button" class="btn ghost small" data-edit-game="${g.id}">Изменить</button>
        <button type="button" class="btn ghost small danger-text" data-del-game="${g.id}">Удалить</button>
      </div>
    </article>`;
}

function renderGames(view) {
  const all = gamesList();
  const today = todayIso();
  let list = all;
  if (ui.dayFilter) list = all.filter((g) => g.date === ui.dayFilter);
  const upcoming = list.filter((g) => g.date >= today).reverse();
  const past = list.filter((g) => g.date < today);
  const PAST_LIMIT = 10;
  const pastShown = ui.showAllPast || ui.dayFilter ? past : past.slice(0, PAST_LIMIT);

  view.innerHTML = `
    <button type="button" class="btn primary block big" id="new-game">＋ Новая игра</button>
    ${renderCalendar(all)}
    ${ui.dayFilter ? `<div class="filter">Игры за ${esc(fmtDate(ui.dayFilter, true))} <button type="button" class="btn ghost small" id="clear-filter">Показать все</button></div>` : ""}
    ${!all.length ? `<div class="empty">Пока нет ни одной игры.<br>Добавьте игроков и создайте первую игру.</div>` : ""}
    ${upcoming.length ? `<h2 class="section">Запланированные</h2>${upcoming.map(gameCard).join("")}` : ""}
    ${past.length ? `<h2 class="section">Прошедшие</h2>${pastShown.map(gameCard).join("")}` : ""}
    ${pastShown.length < past.length ? `<button type="button" class="btn ghost block" id="more-past">Показать ещё ${past.length - pastShown.length}</button>` : ""}
    ${ui.dayFilter && !list.length ? `<div class="empty">В этот день игр нет. <button type="button" class="btn ghost small" id="new-on-day">Создать игру на этот день</button></div>` : ""}
  `;

  $("#new-game").onclick = () => editGame(null, ui.dayFilter || undefined);
  $("#clear-filter") && ($("#clear-filter").onclick = () => { ui.dayFilter = null; render(); });
  $("#more-past") && ($("#more-past").onclick = () => { ui.showAllPast = true; render(); });
  $("#new-on-day") && ($("#new-on-day").onclick = () => editGame(null, ui.dayFilter));
  $$("[data-cal]", view).forEach((b) => b.onclick = () => {
    const [y, m] = (ui.calMonth || today.slice(0, 7)).split("-").map(Number);
    const d = new Date(y, m - 1 + Number(b.dataset.cal), 1);
    ui.calMonth = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    render();
  });
  $$("[data-day]", view).forEach((b) => b.onclick = () => {
    ui.dayFilter = ui.dayFilter === b.dataset.day ? null : b.dataset.day;
    render();
  });
  $$("[data-edit-game]", view).forEach((b) => b.onclick = () => editGame(b.dataset.editGame));
  $$("[data-del-game]", view).forEach((b) => b.onclick = async () => {
    const g = store.state.games[b.dataset.delGame];
    if (!g) return;
    const ok = await doubleConfirm("Удалить игру?", `${esc(fmtDate(g.date, true))}, ${money(toCents(g.cost))}, платил ${esc(playerName(g.payerId))}.`);
    if (ok) { store.write(`games/${b.dataset.delGame}`, null); toast("Игра удалена"); }
  });
}

function editGame(id, presetDate) {
  const existing = id ? store.state.games[id] : null;
  const g = existing
    ? { ...existing, players: { ...(existing.players || {}) } }
    : { date: presetDate || todayIso(), time: lastField("time"), duration: 1, place: lastField("place"), cost: "", payerId: "", players: {}, note: "" };
  const selected = new Set(gamePlayerIds(g));
  if (!(Number(g.duration) > 0)) g.duration = 1;
  g.end = endTime(g.time, g.duration);

  const draw = () => {
    // активные игроки + архивные, которые уже участвуют в этой игре
    const pool = sortedPlayers((p) => !p.archived || selected.has(p.id) || p.id === g.payerId);
    const payerOpts = pool
      .map((p) => `<option value="${p.id}" ${p.id === g.payerId ? "selected" : ""}>${esc(p.name)}${p.archived ? " (архив)" : ""}</option>`)
      .join("");
    const chips = pool
      .map((p) => `<button type="button" class="chip toggle ${selected.has(p.id) ? "on" : ""}" data-toggle="${p.id}" aria-pressed="${selected.has(p.id)}">${esc(p.name)}</button>`)
      .join("");
    const total = toCents(g.cost);
    const n = selected.size;
    return `
      <form class="sheet" id="game-form" novalidate>
        <h2>${existing ? "Изменить игру" : "Новая игра"}</h2>
        <label>Дата<input type="date" name="date" value="${esc(g.date)}" required></label>
        <div class="grid2">
          <label>Начало<input type="time" name="time" value="${esc(g.time || "")}"></label>
          <label>Конец<input type="time" name="end" value="${esc(g.end || "")}"></label>
        </div>
        <div class="dur-row">
          <span class="muted small">Длительность:</span>
          ${[1, 1.5, 2].map((h) => `<button type="button" class="chip toggle small ${Number(g.duration) === h ? "on" : ""}" data-dur="${h}">${hoursFmt(h)}</button>`).join("")}
          ${[1, 1.5, 2].includes(Number(g.duration)) ? "" : `<span class="chip on-static">${hoursFmt(Number(g.duration))}</span>`}
        </div>
        <label>Стоимость брони корта (${esc(currency() || "сумма")})
          <input type="number" name="cost" inputmode="decimal" min="0" step="0.01" value="${esc(g.cost)}" placeholder="0" required>
        </label>
        <label>Кто бронировал и платил
          <select name="payerId" required>
            <option value="">— выберите —</option>
            ${payerOpts}
          </select>
        </label>
        <div class="field">
          <div class="label-row">
            <span>Кто играет <b id="count">${n}</b></span>
            <span>
              <button type="button" class="link" id="sel-all">все</button> ·
              <button type="button" class="link" id="sel-none">никто</button>
            </span>
          </div>
          <div class="chips">${chips || `<span class="muted small">Сначала добавьте игроков</span>`}</div>
          <div class="row add-inline">
            <input type="text" id="new-player" placeholder="Новый игрок…" autocomplete="off">
            <button type="button" class="btn ghost" id="add-player">Добавить</button>
          </div>
        </div>
        <div class="hint" id="share-hint">${n && total ? `С каждого: ${money(Math.ceil(total / n))}` : ""}</div>
        <label><span>Место <span class="muted">(необяз.)</span></span><input type="text" name="place" value="${esc(g.place || "")}" placeholder="Корт / клуб"></label>
        <label><span>Заметка <span class="muted">(необяз.)</span></span><textarea name="note" rows="2">${esc(g.note || "")}</textarea></label>
        <div class="error" id="form-error"></div>
        <div class="row end">
          <button type="button" class="btn ghost" data-close="cancel">Отмена</button>
          <button type="submit" class="btn primary">${existing ? "Сохранить" : "Создать"}</button>
        </div>
      </form>`;
  };

  const readForm = (form) => {
    const fd = new FormData(form);
    g.date = fd.get("date");
    g.time = fd.get("time");
    g.end = fd.get("end");
    g.cost = fd.get("cost");
    g.payerId = fd.get("payerId");
    g.place = fd.get("place");
    g.note = fd.get("note");
  };

  const mount = (m) => {
    const form = $("#game-form", m);
    const redraw = () => {
      readForm(form);
      g.end = g.time ? endTime(g.time, g.duration) : g.end;
      const scroll = form.scrollTop;
      m.innerHTML = draw();
      mount(m);
      $("#game-form", m).scrollTop = scroll;
    };
    const minutes = (t) => { const [h, mm] = t.split(":").map(Number); return h * 60 + mm; };
    form.addEventListener("change", (e) => {
      if (e.target.name === "time") {
        // сдвигаем конец, сохраняя длительность
        readForm(form);
        if (g.time) { g.end = endTime(g.time, g.duration); redraw(); }
      } else if (e.target.name === "end") {
        readForm(form);
        if (g.time && g.end) {
          let d = minutes(g.end) - minutes(g.time);
          if (d <= 0) d += 24 * 60;
          g.duration = Math.round((d / 60) * 100) / 100;
          redraw();
        }
      }
    });
    $$("[data-dur]", m).forEach((b) => b.onclick = () => {
      readForm(form);
      g.duration = Number(b.dataset.dur);
      g.end = endTime(g.time, g.duration);
      redraw();
    });
    form.addEventListener("input", (e) => {
      if (e.target.name === "cost") {
        readForm(form);
        const total = toCents(g.cost), n = selected.size;
        $("#share-hint", m).innerHTML = n && total ? `С каждого: ${money(Math.ceil(total / n))}` : "";
      }
    });
    $$("[data-toggle]", m).forEach((b) => b.onclick = () => {
      const pid = b.dataset.toggle;
      selected.has(pid) ? selected.delete(pid) : selected.add(pid);
      redraw();
    });
    $("#sel-all", m).onclick = () => { sortedPlayers((p) => !p.archived).forEach((p) => selected.add(p.id)); redraw(); };
    $("#sel-none", m).onclick = () => { selected.clear(); redraw(); };
    const addNew = () => {
      const input = $("#new-player", m);
      const pid = addPlayer(input.value);
      if (pid) { selected.add(pid); redraw(); setTimeout(() => $("#new-player", m)?.focus(), 0); }
    };
    $("#add-player", m).onclick = addNew;
    $("#new-player", m).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addNew(); } });

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      readForm(form);
      const err = $("#form-error", m);
      const cost = Number(g.cost);
      if (!g.date) return (err.textContent = "Укажите дату");
      if (g.cost === "" || !Number.isFinite(cost) || cost < 0) return (err.textContent = "Укажите стоимость");
      if (!g.payerId) return (err.textContent = "Укажите, кто платил");
      if (!selected.size) return (err.textContent = "Выберите хотя бы одного игрока");
      const now = Date.now();
      const data = {
        date: g.date,
        time: g.time || "",
        duration: Math.max(0, Number(g.duration) || 0),
        place: (g.place || "").trim(),
        cost: Math.round(cost * 100) / 100,
        payerId: g.payerId,
        players: Object.fromEntries([...selected].map((pid) => [pid, true])),
        note: (g.note || "").trim(),
        createdAt: existing ? existing.createdAt || now : now,
        updatedAt: now,
      };
      store.write(`games/${id || newId()}`, data);
      closeModal(true);
      toast(existing ? "Игра сохранена" : "Игра создана");
    });
  };

  openModal(draw(), mount);
}

function lastField(name) {
  const g = gamesList().find((x) => x[name]);
  return (g && g[name]) || "";
}

// ---------- долги ----------

function renderDebts(view) {
  const L = computeLedger(store.state);
  const list = ui.debtMode === "direct" ? L.direct : L.simplified;
  const keys = new Set([...Object.keys(L.balance), ...Object.keys(L.paid), ...Object.keys(L.spent)]);
  const rows = [...keys]
    .map((k) => ({ k, name: keyName(k), paid: L.paid[k] || 0, spent: L.spent[k] || 0, bal: L.balance[k] || 0 }))
    .sort((a, b) => b.bal - a.bal || a.name.localeCompare(b.name, "ru"));
  const payments = Object.entries(store.state.payments || {})
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));

  view.innerHTML = `
    <section class="card">
      <h2>Кто кому должен</h2>
      <div class="seg" role="tablist">
        <button type="button" data-mode="direct" class="${ui.debtMode === "direct" ? "on" : ""}">Напрямую</button>
        <button type="button" data-mode="simplified" class="${ui.debtMode === "simplified" ? "on" : ""}">Минимум переводов</button>
      </div>
      <p class="muted small">${ui.debtMode === "simplified"
        ? "Долги взаимозачтены по всей компании — так переводов меньше всего."
        : "Каждый должен тому, кто платил за его игры (с зачётом встречных долгов)."} Игроки с общим кошельком считаются вместе.</p>
      ${list.length ? `
        <table class="debts">
          <thead><tr><th>Кто</th><th></th><th>Кому</th><th class="num">Сколько</th><th></th></tr></thead>
          <tbody>
          ${list.map((d, i) => `
            <tr>
              <td>${esc(keyName(d.from))}</td>
              <td class="arrow">→</td>
              <td>${esc(keyName(d.to))}</td>
              <td class="num"><b>${money(d.amount)}</b></td>
              <td class="num"><button type="button" class="btn ghost small" data-settle="${i}" title="Отметить, что долг оплачен">✓<span class="hide-xs"> Оплачено</span></button></td>
            </tr>`).join("")}
          </tbody>
        </table>` : `<div class="empty small">Все в расчёте 🎉</div>`}
      <div class="row two">
        <button type="button" class="btn ghost" data-new-entry="payment">＋ Перевод</button>
        <button type="button" class="btn ghost" data-new-entry="debt">＋ Долг вручную</button>
      </div>
    </section>

    <section class="card">
      <h2>Баланс</h2>
      ${rows.length ? `
      <table class="balances">
        <thead><tr><th>Кто</th><th class="num">Заплатил</th><th class="num">Доля</th><th class="num">Баланс</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${esc(r.name)}</td>
              <td class="num">${money(r.paid)}</td>
              <td class="num">${money(r.spent)}</td>
              <td class="num ${r.bal > 0 ? "pos" : r.bal < 0 ? "neg" : ""}"><b>${r.bal > 0 ? "+" : ""}${money(r.bal)}</b></td>
            </tr>`).join("")}
        </tbody>
      </table>
      <p class="muted small">«Заплатил» — сумма броней, «Доля» — стоимость своих игр. Плюс — им должны, минус — должны они. Баланс учитывает переводы и долги, внесённые вручную.</p>`
      : `<div class="empty small">Пока нет данных</div>`}
    </section>

    <section class="card">
      <h2>Переводы и ручные долги</h2>
      ${payments.length ? `<ul class="payments">${payments.map((p) => `
        <li>
          <div>
            ${p.kind === "debt"
              ? `<span class="tag">долг</span> <b>${esc(playerName(p.fromId))}</b> должен <b>${esc(playerName(p.toId))}</b>: ${money(toCents(p.amount))}`
              : `<span class="tag ok">перевод</span> <b>${esc(playerName(p.fromId))}</b> → <b>${esc(playerName(p.toId))}</b>: ${money(toCents(p.amount))}`}
            <div class="muted small">${esc(fmtDate(p.date, true))}${p.note ? ` · ${esc(p.note)}` : ""}</div>
          </div>
          <button type="button" class="btn ghost small danger-text" data-del-pay="${p.id}" aria-label="Удалить запись">✕</button>
        </li>`).join("")}</ul>` : `<div class="muted small">Пока пусто. Нажмите «✓», когда кто-то вернёт долг.</div>`}
    </section>
  `;

  $$("[data-mode]", view).forEach((b) => b.onclick = () => { ui.debtMode = b.dataset.mode; localStorageSet("pb:debtMode2", ui.debtMode); render(); });
  $$("[data-settle]", view).forEach((b) => b.onclick = async () => {
    const d = list[Number(b.dataset.settle)];
    const ok = await confirmDialog({
      title: "Долг оплачен?",
      text: `<b>${esc(keyName(d.from))}</b> → <b>${esc(keyName(d.to))}</b>: ${money(d.amount)}.`,
      okText: "Да, оплачено",
    });
    const from = keyRep(d.from), to = keyRep(d.to);
    if (ok && from && to) {
      store.write(`payments/${newId()}`, { kind: "payment", fromId: from, toId: to, amount: fromCents(d.amount), date: todayIso(), note: "", createdAt: Date.now() });
      toast("Перевод записан");
    }
  });
  $$("[data-new-entry]", view).forEach((b) => b.onclick = () => editPayment(b.dataset.newEntry));
  $$("[data-del-pay]", view).forEach((b) => b.onclick = async () => {
    const p = store.state.payments[b.dataset.delPay];
    if (!p) return;
    const ok = await doubleConfirm(p.kind === "debt" ? "Удалить долг?" : "Удалить перевод?",
      `${esc(playerName(p.fromId))} → ${esc(playerName(p.toId))}: ${money(toCents(p.amount))}. Балансы пересчитаются.`);
    if (ok) { store.write(`payments/${b.dataset.delPay}`, null); toast("Запись удалена"); }
  });
}

function editPayment(kind) {
  const debt = kind === "debt";
  const opts = sortedPlayers((p) => !p.archived)
    .map((p) => `<option value="${p.id}">${esc(p.name)}${p.walletId ? ` (${esc(walletName(p.walletId))})` : ""}</option>`).join("");
  openModal(`
    <form class="sheet" id="pay-form" novalidate>
      <h2>${debt ? "Долг вручную" : "Перевод"}</h2>
      <p class="muted small">${debt
        ? "Например, старые долги до начала учёта в приложении."
        : "Кто-то вернул деньги — долг уменьшится."}</p>
      <label>${debt ? "Кто должен" : "Кто перевёл"}<select name="fromId" required><option value="">—</option>${opts}</select></label>
      <label>Кому<select name="toId" required><option value="">—</option>${opts}</select></label>
      <div class="grid2">
        <label>Сумма<input type="number" name="amount" inputmode="decimal" min="0" step="0.01" required></label>
        <label>Дата<input type="date" name="date" value="${todayIso()}" required></label>
      </div>
      <label><span>Заметка <span class="muted">(необяз.)</span></span><input type="text" name="note"></label>
      <div class="error" id="form-error"></div>
      <div class="row end">
        <button type="button" class="btn ghost" data-close="cancel">Отмена</button>
        <button type="submit" class="btn primary">Записать</button>
      </div>
    </form>`, (m) => {
    $("#pay-form", m).addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const err = $("#form-error", m);
      const amount = Number(fd.get("amount"));
      if (!fd.get("fromId") || !fd.get("toId")) return (err.textContent = "Выберите обоих игроков");
      if (fd.get("fromId") === fd.get("toId")) return (err.textContent = "Выберите разных игроков");
      if (!Number.isFinite(amount) || amount <= 0) return (err.textContent = "Укажите сумму");
      store.write(`payments/${newId()}`, {
        kind: debt ? "debt" : "payment",
        fromId: fd.get("fromId"), toId: fd.get("toId"), amount: Math.round(amount * 100) / 100,
        date: fd.get("date") || todayIso(), note: String(fd.get("note") || "").trim(), createdAt: Date.now(),
      });
      closeModal(true);
      toast("Записано");
    });
  });
}

// ---------- игроки ----------

function renderPlayers(view) {
  const L = computeLedger(store.state);
  const used = new Set();
  for (const g of Object.values(store.state.games || {})) { gamePlayerIds(g).forEach((id) => used.add(id)); used.add(g.payerId); }
  for (const p of Object.values(store.state.payments || {})) { used.add(p.fromId); used.add(p.toId); }

  const active = sortedPlayers((p) => !p.archived);
  const archived = sortedPlayers((p) => p.archived);
  const walletIds = Object.keys(wallets()).sort((a, b) => walletName(a).localeCompare(walletName(b), "ru"));
  const row = (p) => {
    const n = L.games[p.id] || 0;
    return `
      <li class="player">
        <div class="pinfo">
          <b>${esc(p.name)}${p.handle ? ` <span class="muted handle">${esc(p.handle)}</span>` : ""}</b>
          <span class="muted small">${n} ${plural(n, "игра", "игры", "игр")}${p.walletId && wallets()[p.walletId] ? ` · 👛 ${esc(walletName(p.walletId))}` : ""}</span>
        </div>
        <div class="pact">
          <button type="button" class="btn ghost small" data-rename="${p.id}" aria-label="Изменить">✎</button>
          ${p.archived
            ? `<button type="button" class="btn ghost small" data-unarchive="${p.id}">Вернуть</button>`
            : `<button type="button" class="btn ghost small" data-archive="${p.id}">В архив</button>`}
          ${!used.has(p.id) ? `<button type="button" class="btn ghost small danger-text" data-del-player="${p.id}" aria-label="Удалить">✕</button>` : ""}
        </div>
      </li>`;
  };

  view.innerHTML = `
    <section class="card">
      <h2>Игроки</h2>
      <form class="row add-inline" id="add-form">
        <input type="text" name="name" placeholder="Имя нового игрока" autocomplete="off" required>
        <button type="submit" class="btn primary">Добавить</button>
      </form>
      ${active.length ? `<ul class="players">${active.map(row).join("")}</ul>` : `<div class="empty small">Добавьте первого игрока</div>`}
    </section>

    <section class="card">
      <h2>Общие кошельки</h2>
      <p class="muted small">Игроки с общим кошельком играют каждый за себя, но в долгах считаются как один участник: внутри кошелька долгов нет.</p>
      ${walletIds.length ? `<ul class="players">${walletIds.map((wid) => {
        const bal = L.balance[`w:${wid}`] || 0;
        return `
        <li>
          <div class="pinfo">
            <b>👛 ${esc(walletName(wid))}</b>
            <span class="muted small">${walletMembers(wid).map((p) => esc(p.name)).join(", ")}${bal ? ` · <span class="${bal > 0 ? "pos" : "neg"}">${bal > 0 ? "+" : ""}${money(bal)}</span>` : ""}</span>
          </div>
          <div class="pact"><button type="button" class="btn ghost small" data-edit-wallet="${wid}">Изменить</button></div>
        </li>`;
      }).join("")}</ul>` : ""}
      <button type="button" class="btn ghost block" id="new-wallet">＋ Объединить кошельки</button>
    </section>

    ${archived.length ? `
    <section class="card">
      <button type="button" class="link" id="toggle-arch">${ui.showArchived ? "▾" : "▸"} Архив (${archived.length})</button>
      <p class="muted small">Архивные игроки не показываются при создании игры, но их история и долги сохраняются.</p>
      ${ui.showArchived ? `<ul class="players">${archived.map(row).join("")}</ul>` : ""}
    </section>` : ""}
  `;

  $("#add-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = e.target.elements.name;
    if (addPlayer(input.value)) { input.value = ""; render(); $("#add-form input")?.focus(); }
  });
  $("#toggle-arch") && ($("#toggle-arch").onclick = () => { ui.showArchived = !ui.showArchived; render(); });
  $("#new-wallet").onclick = () => editWallet(null);
  $$("[data-edit-wallet]", view).forEach((b) => b.onclick = () => editWallet(b.dataset.editWallet));
  $$("[data-archive]", view).forEach((b) => b.onclick = () => {
    const id = b.dataset.archive;
    store.write(`players/${id}/archived`, true);
    toast(`${playerName(id)} в архиве`);
  });
  $$("[data-unarchive]", view).forEach((b) => b.onclick = () => store.write(`players/${b.dataset.unarchive}/archived`, false));
  $$("[data-rename]", view).forEach((b) => b.onclick = () => renamePlayer(b.dataset.rename));
  $$("[data-del-player]", view).forEach((b) => b.onclick = async () => {
    const id = b.dataset.delPlayer;
    const ok = await doubleConfirm("Удалить игрока?", `«${esc(playerName(id))}» ещё не участвовал в играх, его можно удалить совсем.`);
    if (ok) { store.write(`players/${id}`, null); cleanupWallets(); }
  });
}

// Кошелёк, в котором меньше двух игроков, не нужен.
function cleanupWallets() {
  for (const wid of Object.keys(wallets())) {
    const members = walletMembers(wid);
    if (members.length < 2) {
      members.forEach((p) => store.write(`players/${p.id}/walletId`, null));
      store.write(`wallets/${wid}`, null);
    }
  }
}

function editWallet(wid) {
  const w = wid ? wallets()[wid] : null;
  const selected = new Set(wid ? walletMembers(wid).map((p) => p.id) : []);
  let name = (w && w.name) || "";

  const draw = () => {
    const pool = sortedPlayers((p) => !p.archived || selected.has(p.id));
    return `
    <form class="sheet" id="wallet-form" novalidate>
      <h2>${w ? "Общий кошелёк" : "Объединить кошельки"}</h2>
      <div class="field">
        <div class="label-row"><span>Кто в кошельке <b>${selected.size}</b></span></div>
        <div class="chips">${pool.map((p) => {
          const other = p.walletId && p.walletId !== wid && wallets()[p.walletId];
          return `<button type="button" class="chip toggle ${selected.has(p.id) ? "on" : ""}" data-toggle="${p.id}" aria-pressed="${selected.has(p.id)}">${esc(p.name)}${other && !selected.has(p.id) ? " 👛" : ""}</button>`;
        }).join("")}</div>
        <p class="muted small">👛 — уже в другом кошельке (будет перенесён сюда).</p>
      </div>
      <label><span>Название <span class="muted">(необяз.)</span></span><input type="text" name="name" value="${esc(name)}" placeholder="${esc(sortedPlayers((p) => selected.has(p.id)).map((p) => p.name).join(" + ") || "Например: Семья")}"></label>
      ${w ? `<button type="button" class="link danger-text" id="split-wallet">Разъединить кошелёк</button>` : ""}
      <div class="error" id="form-error"></div>
      <div class="row end">
        <button type="button" class="btn ghost" data-close="cancel">Отмена</button>
        <button type="submit" class="btn primary">Сохранить</button>
      </div>
    </form>`;
  };
  const mount = (m) => {
    const form = $("#wallet-form", m);
    $$("[data-toggle]", m).forEach((b) => b.onclick = () => {
      name = form.elements.name.value;
      const id = b.dataset.toggle;
      selected.has(id) ? selected.delete(id) : selected.add(id);
      m.innerHTML = draw();
      mount(m);
    });
    $("#split-wallet", m) && ($("#split-wallet", m).onclick = async () => {
      closeModal(null);
      const ok = await confirmDialog({ title: "Разъединить кошелёк?", text: "Игроки снова будут считаться в долгах по отдельности. Игры и переводы не удаляются.", okText: "Разъединить", danger: true });
      if (!ok) return;
      walletMembers(wid).forEach((p) => store.write(`players/${p.id}/walletId`, null));
      store.write(`wallets/${wid}`, null);
      toast("Кошелёк разъединён");
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (selected.size < 2) return ($("#form-error", m).textContent = "Выберите хотя бы двух игроков");
      const id = wid || newId();
      store.write(`wallets/${id}`, { name: form.elements.name.value.trim(), createdAt: (w && w.createdAt) || Date.now() });
      for (const p of sortedPlayers()) {
        if (selected.has(p.id) && p.walletId !== id) store.write(`players/${p.id}/walletId`, id);
        if (!selected.has(p.id) && p.walletId === id) store.write(`players/${p.id}/walletId`, null);
      }
      cleanupWallets();
      closeModal(true);
      toast("Кошелёк сохранён");
    });
  };
  openModal(draw(), mount);
}

function renamePlayer(id) {
  const p = players()[id];
  if (!p) return;
  openModal(`
    <form class="sheet" id="rename-form">
      <h2>Игрок</h2>
      <label>Имя<input type="text" name="name" value="${esc(p.name)}" required autocomplete="off"></label>
      <label><span>Ник <span class="muted">(необяз.)</span></span><input type="text" name="handle" value="${esc(p.handle || "")}" placeholder="@telegram" autocomplete="off"></label>
      <div class="row end">
        <button type="button" class="btn ghost" data-close="cancel">Отмена</button>
        <button type="submit" class="btn primary">Сохранить</button>
      </div>
    </form>`, (m) => {
    const input = $("input", m);
    input.focus(); input.select();
    $("#rename-form", m).addEventListener("submit", (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      let handle = e.target.elements.handle.value.trim();
      if (handle && !handle.startsWith("@")) handle = "@" + handle;
      store.write(`players/${id}`, { ...players()[id], name, handle });
      closeModal(true);
    });
  });
}

// ---------- статистика ----------

function renderStats(view) {
  const today = todayIso();
  const played = gamesList().filter((g) => g.date && g.date <= today);
  const years = [...new Set(played.map((g) => g.date.slice(0, 4)))].sort().reverse();
  const months = [...new Set(played.map((g) => g.date.slice(0, 7)))].sort().reverse();
  const valid = ["all", ...years, ...months];
  if (!valid.includes(ui.statsPeriod)) ui.statsPeriod = "all";
  const period = ui.statsPeriod;
  const games = period === "all" ? played : played.filter((g) => g.date.startsWith(period));
  const S = computeStats(games);
  const monthLabel = (ym) => { const [y, m] = ym.split("-").map(Number); return `${MONTHS[m - 1]} ${y}`; };
  const shortMonth = (ym) => { const [y, m] = ym.split("-").map(Number); return `${MONTHS[m - 1].slice(0, 3)}${y !== new Date().getFullYear() ? ` ${String(y).slice(2)}` : ""}`; };

  const rows = Object.entries(S.per)
    .map(([id, s]) => ({ id, name: playerName(id), ...s }))
    .filter((r) => r.games || r.booked)
    .sort((a, b) => b.hours - a.hours || b.games - a.games || a.name.localeCompare(b.name, "ru"));
  const maxHours = Math.max(1, ...rows.map((r) => r.hours));
  const noHours = S.total.games && !S.total.hours;

  // Помесячный график для «всё время» и для года
  let chart = "";
  if (period.length !== 7 && games.length) {
    let keys;
    if (period === "all") {
      const first = games[games.length - 1].date.slice(0, 7);
      keys = [];
      const d = new Date(Number(first.slice(0, 4)), Number(first.slice(5, 7)) - 1, 1);
      const last = today.slice(0, 7);
      while (isoDate(d).slice(0, 7) <= last && keys.length < 120) { keys.push(isoDate(d).slice(0, 7)); d.setMonth(d.getMonth() + 1); }
      keys = keys.slice(-12);
    } else keys = Array.from({ length: 12 }, (_, i) => `${period}-${pad(i + 1)}`);
    const maxG = Math.max(1, ...keys.map((k) => (S.byMonth[k] || {}).games || 0));
    chart = `
      <section class="card">
        <h2>Игры по месяцам</h2>
        <div class="bars" role="img" aria-label="Количество игр по месяцам">
          ${keys.map((k) => {
            const b = S.byMonth[k] || { games: 0, hours: 0, cost: 0 };
            const tip = `${monthLabel(k)}: ${b.games} ${plural(b.games, "игра", "игры", "игр")}, ${hoursFmt(b.hours)}, ${fromCents(b.cost).toLocaleString("ru-RU")} ${currency()}`;
            return `<button type="button" class="bar" data-period="${b.games ? k : ""}" title="${esc(tip)}" aria-label="${esc(tip)}">
              <span class="bar-val">${b.games || ""}</span>
              <span class="bar-fill" style="height:${(b.games / maxG) * 100}%"></span>
              <span class="bar-label">${shortMonth(k)}</span>
            </button>`;
          }).join("")}
        </div>
        <p class="muted small">Нажмите на столбик — откроется статистика за месяц.</p>
      </section>`;
  }

  view.innerHTML = `
    <section class="card">
      <label>Период
        <select id="period">
          <option value="all" ${period === "all" ? "selected" : ""}>Всё время</option>
          ${years.length ? `<optgroup label="Год">${years.map((y) => `<option value="${y}" ${period === y ? "selected" : ""}>${y}</option>`).join("")}</optgroup>` : ""}
          ${months.length ? `<optgroup label="Месяц">${months.map((m) => `<option value="${m}" ${period === m ? "selected" : ""}>${monthLabel(m)}</option>`).join("")}</optgroup>` : ""}
        </select>
      </label>
      <div class="tiles">
        <div class="tile"><span>Игр</span><b>${S.total.games}</b></div>
        <div class="tile"><span>Часов</span><b>${numFmt.format(Math.round(S.total.hours * 10) / 10)}</b></div>
        <div class="tile wide"><span>Потрачено всего</span><b>${money(S.total.cost)}</b></div>
        <div class="tile"><span>Средняя игра</span><b>${S.total.games ? money(Math.round(S.total.cost / S.total.games)) : "—"}</b></div>
        <div class="tile"><span>Игроков в среднем</span><b>${S.total.games ? numFmt.format(Math.round((S.total.seats / S.total.games) * 10) / 10) : "—"}</b></div>
      </div>
      <p class="muted small">Учитываются только сыгранные игры (до сегодня включительно). Долги, внесённые вручную, в статистику не входят.${noHours ? " У игр не указана длительность — часы не посчитаны." : ""}</p>
    </section>

    ${chart}

    <section class="card">
      <h2>По игрокам</h2>
      ${rows.length ? `
      <table class="stats">
        <thead><tr><th>Игрок</th><th class="num">Игр</th><th>Часов</th><th class="num">Потратил</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${esc(r.name)}${r.booked ? `<div class="muted small">бронировал ${r.booked}×</div>` : ""}</td>
              <td class="num">${r.games}</td>
              <td class="hbar"><span class="hbar-fill" style="width:${(r.hours / maxHours) * 100}%"></span><span class="hbar-val">${numFmt.format(Math.round(r.hours * 10) / 10)}</span></td>
              <td class="num">${money(r.spent)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
      <p class="muted small">«Потратил» — доля игрока в стоимости кортов (кто бы ни платил за бронь).</p>`
      : `<div class="empty small">За этот период игр нет</div>`}
    </section>
  `;

  $("#period").onchange = (e) => { ui.statsPeriod = e.target.value; render(); };
  $$("[data-period]", view).forEach((b) => b.onclick = () => { if (b.dataset.period) { ui.statsPeriod = b.dataset.period; render(); } });
}

// ---------- настройки ----------

let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; if (ui.tab === "settings") render(); });

function renderSettings(view) {
  const { url, source } = getDatabaseUrl();
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  view.innerHTML = `
    <section class="card">
      <h2>Общая база данных</h2>
      ${store.mode === "remote"
        ? `<p>Подключено к <code>${esc(url)}</code>${source === "local" ? " <span class=\"muted\">(задано только на этом устройстве)</span>" : ""}.</p>
           <p class="muted small">Статус: ${esc(store.status)}${store.pending ? `, не отправлено изменений: ${store.pending}` : ""}${store.lastError ? ` — ${esc(store.lastError)}` : ""}</p>`
        : `<p>База не подключена — данные хранятся только в этом браузере.</p>
           <p class="muted small">Чтобы данные были общими для всех друзей, создайте бесплатную Firebase Realtime Database и пропишите её адрес в <code>config.js</code> (инструкция в README репозитория). Для проверки можно ввести адрес ниже — он сохранится только на этом устройстве.</p>`}
      <form id="db-form" class="stack">
        <input type="url" name="url" placeholder="https://xxx-default-rtdb.firebasedatabase.app" value="${source === "local" ? esc(url) : ""}">
        <div class="row">
          <button type="submit" class="btn ghost">Применить на этом устройстве</button>
          ${source === "local" ? `<button type="button" class="btn ghost" id="db-reset">Сбросить</button>` : ""}
        </div>
      </form>
    </section>

    <section class="card">
      <h2>Валюта</h2>
      <form id="cur-form" class="row add-inline">
        <input type="text" name="currency" value="${esc(currency())}" maxlength="5" placeholder="₽, €, $…">
        <button type="submit" class="btn ghost">Сохранить</button>
      </form>
    </section>

    <section class="card">
      <h2>Установить на телефон</h2>
      ${standalone ? `<p>Приложение уже установлено ✅</p>` : `
        ${installPrompt ? `<button type="button" class="btn primary" id="install">Установить приложение</button>` : ""}
        <ul class="muted small">
          <li><b>iPhone (Safari):</b> «Поделиться» → «На экран „Домой“».</li>
          <li><b>Android (Chrome):</b> меню ⋮ → «Установить приложение» / «Добавить на главный экран».</li>
        </ul>`}
    </section>

    <section class="card">
      <h2>Резервная копия</h2>
      <p class="muted small">База открыта для всех, поэтому иногда стоит сохранять копию.</p>
      <div class="row">
        <button type="button" class="btn ghost" id="export">Скачать JSON</button>
        <label class="btn ghost file">Восстановить из JSON<input type="file" id="import" accept="application/json,.json" hidden></label>
      </div>
    </section>

    <p class="muted small center">Пиклбол · игры и долги · <a href="https://github.com/HarryBurns/pickleball" target="_blank" rel="noopener">GitHub</a></p>
  `;

  $("#db-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = e.target.elements.url.value.trim();
    if (v && !/^https:\/\//.test(v)) return toast("Адрес должен начинаться с https://");
    setDatabaseUrlOverride(v);
    location.reload();
  });
  $("#db-reset") && ($("#db-reset").onclick = () => { setDatabaseUrlOverride(null); location.reload(); });
  $("#cur-form").addEventListener("submit", (e) => {
    e.preventDefault();
    store.write("settings/currency", e.target.elements.currency.value.trim());
    toast("Сохранено");
  });
  $("#install") && ($("#install").onclick = async () => { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; render(); });
  $("#export").onclick = () => {
    const blob = new Blob([JSON.stringify(store.state, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `pickleball-${todayIso()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $("#import").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch { return toast("Не удалось прочитать файл"); }
    if (!data || typeof data !== "object" || !data.players) return toast("Файл не похож на резервную копию");
    const ok = await doubleConfirm("Заменить все данные?", "Текущие игроки, игры и переводы будут заменены данными из файла — у всех.");
    if (ok) { store.replaceAll(data); toast("Данные восстановлены"); }
    e.target.value = "";
  });
}

// ---------- начальные данные (один раз) ----------

// Идентификаторы фиксированы, поэтому если несколько человек откроют приложение одновременно,
// они запишут одно и то же, без дублей.
const SEED_VERSION = 3;
let seeding = false;
function seedOnce() {
  const v = (store.state.settings || {}).seedVersion || 0;
  if (seeding || v >= SEED_VERSION) return;
  seeding = true;
  store.write("settings/seedVersion", SEED_VERSION);
  if (v < 1) seedV1();
  if (v < 2) seedV2();
  if (v < 3) seedV3();
  seeding = false;
}

function findPlayerId(name, fallback) {
  const e = Object.entries(players()).find(([, x]) => x.name.trim().toLowerCase() === name.toLowerCase());
  return e ? e[0] : fallback;
}

// v1: игроки, кошельки и долги на 03.11.2026
function seedV1() {
  const st = store.state;
  const people = [
    { key: "olga", name: "Ольга", handle: "@ogorodkova", wallet: "w_olga_alexey" },
    { key: "alexey", name: "Алексей", handle: "@Ktykhy", wallet: "w_olga_alexey" },
    { key: "harry", name: "Алексей Толкачев", handle: "@HarryBurns" },
    { key: "vera", name: "Вера", wallet: "w_vera_igor" },
    { key: "igor", name: "Игорь", wallet: "w_vera_igor" },
  ];
  const ids = {};
  const now = Date.now();
  for (const p of people) {
    const existing = Object.entries(st.players || {}).find(([, x]) => x.name.trim().toLowerCase() === p.name.toLowerCase());
    const id = existing ? existing[0] : `seed_${p.key}`;
    ids[p.key] = id;
    const prev = existing ? existing[1] : { archived: false, createdAt: now };
    store.write(`players/${id}`, { ...prev, name: p.name, handle: p.handle || prev.handle || "", walletId: p.wallet || prev.walletId || null });
  }
  store.write("wallets/w_olga_alexey", { name: "Леша + Оля", createdAt: now });
  store.write("wallets/w_vera_igor", { name: "Вера + Игорь", createdAt: now });
  const date = todayIso();
  store.write("payments/seed_debt_1", { kind: "debt", fromId: ids.vera, toId: ids.olga, amount: 45000, date, note: "Долг до начала учёта", createdAt: now });
  store.write("payments/seed_debt_2", { kind: "debt", fromId: ids.olga, toId: ids.harry, amount: 77000, date, note: "Долг до начала учёта", createdAt: now + 1 });
  store.write("settings/currency", "₫");
}

// v2: вместо двух ручных долгов — все игры с 20.10.2026 и переводы между ними
function seedV2() {
  const now = Date.now();
  const H = findPlayerId("Алексей Толкачев", "seed_harry");
  const O = findPlayerId("Ольга", "seed_olga");
  const A = findPlayerId("Алексей", "seed_alexey");
  const V = findPlayerId("Вера", "seed_vera");
  const I = findPlayerId("Игорь", "seed_igor");
  const Vl = findPlayerId("Владимир", "seed_vladimir");
  const N = findPlayerId("Анастасия", "seed_anastasia");
  if (!players()[Vl]) store.write(`players/${Vl}`, { name: "Владимир", archived: true, createdAt: now });
  if (!players()[N]) store.write(`players/${N}`, { name: "Анастасия", archived: true, createdAt: now });

  store.write("payments/seed_debt_1", null);
  store.write("payments/seed_debt_2", null);

  const game = (id, date, time, duration, cost, payerId, ids, note = "") =>
    store.write(`games/${id}`, {
      date, time, duration, place: "", cost, payerId, note,
      players: Object.fromEntries(ids.map((x) => [x, true])),
      createdAt: now, updatedAt: now,
    });
  game("seed_g_1020", "2026-10-20", "20:30", 1, 110000, H, [H, Vl, N, O]);
  game("seed_g_1023", "2026-10-23", "08:00", 1, 60000, H, [H, Vl]);
  game("seed_g_1027a", "2026-10-27", "08:00", 1, 60000, H, [H, O, A, V, I]);
  game("seed_g_1027b", "2026-10-27", "09:00", 0.5, 55000, A, [H, O, A, V, I], "Продление на 30 минут");
  game("seed_g_1029", "2026-10-29", "07:30", 1.5, 90000, H, [O, A, V, I]);
  game("seed_g_1103", "2026-11-03", "07:30", 1.5, 90000, O, [H, A, V, I]);

  const pay = (id, fromId, toId, amount, date, note) =>
    store.write(`payments/${id}`, { kind: "payment", fromId, toId, amount, date, note, createdAt: now });
  pay("seed_pay_vl", Vl, H, 57500, "2026-10-23", "Владимир вернул долг");
  pay("seed_pay_n", N, H, 27500, "2026-10-20", "Анастасия вернула долг");
  // Вера + Игорь отдали Леше + Оле 91 000: 67 000 — их долг Леше + Оле за 27.10 и 03.11,
  // 24 000 — долг Алексею Т., который теперь висит на Леше + Оле.
  pay("seed_pay_vi_lo", V, O, 67000, "2026-11-03", "Часть из 91 000, отданных Леше + Оле");
  pay("seed_pay_vi_h", V, H, 24000, "2026-11-03", "Часть из 91 000 — через Лешу + Олю");
  store.write("payments/seed_debt_lo_h", { kind: "debt", fromId: O, toId: H, amount: 24000, date: "2026-11-03", note: "Леша + Оля получили эти деньги от Веры + Игоря", createdAt: now });
  pay("seed_pay_lo_h", O, H, 55000, "2026-11-03", "Расчёты до начала учёта");
}

// v3: 91 000 от Веры + Игоря — это их долг Алексею Т. (69 000) и Леше + Оле (22 000).
// Деньги получили Леша + Оля, поэтому 69 000 теперь должны Алексею Т. они.
// Итог «напрямую»: Вера + Игорь → Леша + Оля 45 000, Леша + Оля → Алексей Т. 77 000.
function seedV3() {
  const now = Date.now();
  const H = findPlayerId("Алексей Толкачев", "seed_harry");
  const O = findPlayerId("Ольга", "seed_olga");
  const V = findPlayerId("Вера", "seed_vera");
  const pay = (id, kind, fromId, toId, amount, note) =>
    store.write(`payments/${id}`, { kind, fromId, toId, amount, date: "2026-11-03", note, createdAt: now });
  pay("seed_pay_vi_h", "payment", V, H, 69000, "Вера + Игорь вернули долг Алексею Т. через Лешу + Олю (из 91 000)");
  pay("seed_debt_lo_h", "debt", O, H, 69000, "Леша + Оля получили для Алексея Т. от Веры + Игоря");
  pay("seed_pay_vi_lo", "payment", V, O, 22000, "Вера + Игорь вернули долг Леше + Оле (из 91 000)");
}

// ---------- старт ----------

store.subscribe(() => {
  if (store.loaded) seedOnce();
  // не перерисовываем страницу под открытой формой, чтобы не терять ввод
  if (modal.open) { renderSync(); return; }
  render();
});
modal.addEventListener("close", () => render());
if (store.loaded) seedOnce();
render();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
