import { createStore, newId, getDatabaseUrl, setDatabaseUrlOverride } from "./store.js";
import { computeLedger, gamePlayerIds, splitCost, toCents, fromCents } from "./ledger.js";

const store = createStore();
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ui = {
  tab: localStorageGet("pb:tab") || "games",
  calMonth: null, // "YYYY-MM"
  dayFilter: null, // "YYYY-MM-DD"
  debtMode: localStorageGet("pb:debtMode") || "simplified",
  showArchived: false,
  showAllPast: false,
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
function playerName(id) { const p = players()[id]; return p ? p.name : "(удалён)"; }
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
  const views = { games: renderGames, debts: renderDebts, players: renderPlayers, settings: renderSettings };
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
          <div class="game-date">${esc(fmtDate(g.date))}${g.time ? ` · ${esc(g.time)}` : ""}</div>
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
    : { date: presetDate || todayIso(), time: "", place: lastPlace(), cost: "", payerId: "", players: {}, note: "" };
  const selected = new Set(gamePlayerIds(g));

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
        <div class="grid2">
          <label>Дата<input type="date" name="date" value="${esc(g.date)}" required></label>
          <label><span>Время <span class="muted">(необяз.)</span></span><input type="time" name="time" value="${esc(g.time || "")}"></label>
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
    g.cost = fd.get("cost");
    g.payerId = fd.get("payerId");
    g.place = fd.get("place");
    g.note = fd.get("note");
  };

  const mount = (m) => {
    const form = $("#game-form", m);
    const redraw = () => {
      readForm(form);
      const scroll = form.scrollTop;
      m.innerHTML = draw();
      mount(m);
      $("#game-form", m).scrollTop = scroll;
    };
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

function lastPlace() {
  const g = gamesList()[0];
  return (g && g.place) || "";
}

// ---------- долги ----------

function renderDebts(view) {
  const L = computeLedger(store.state);
  const list = ui.debtMode === "direct" ? L.direct : L.simplified;
  const ids = new Set([...Object.keys(L.balance), ...Object.keys(L.paid)]);
  const rows = [...ids]
    .map((id) => ({ id, name: playerName(id), paid: L.paid[id] || 0, spent: L.spent[id] || 0, bal: L.balance[id] || 0, games: L.games[id] || 0 }))
    .sort((a, b) => b.bal - a.bal || a.name.localeCompare(b.name, "ru"));
  const payments = Object.entries(store.state.payments || {})
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));

  view.innerHTML = `
    <section class="card">
      <div class="label-row">
        <h2>Кто кому должен</h2>
      </div>
      <div class="seg" role="tablist">
        <button type="button" data-mode="simplified" class="${ui.debtMode === "simplified" ? "on" : ""}">Минимум переводов</button>
        <button type="button" data-mode="direct" class="${ui.debtMode === "direct" ? "on" : ""}">Напрямую</button>
      </div>
      <p class="muted small">${ui.debtMode === "simplified"
        ? "Долги взаимозачтены по всей компании — так переводов меньше всего."
        : "Каждый должен тому, кто платил за его игры (с зачётом встречных долгов)."}</p>
      ${list.length ? `
        <table class="debts">
          <thead><tr><th>Кто</th><th></th><th>Кому</th><th class="num">Сколько</th><th></th></tr></thead>
          <tbody>
          ${list.map((d, i) => `
            <tr>
              <td>${esc(playerName(d.from))}</td>
              <td class="arrow">→</td>
              <td>${esc(playerName(d.to))}</td>
              <td class="num"><b>${money(d.amount)}</b></td>
              <td class="num"><button type="button" class="btn ghost small" data-settle="${i}" title="Отметить, что долг оплачен">✓ Оплачено</button></td>
            </tr>`).join("")}
          </tbody>
        </table>` : `<div class="empty small">Все в расчёте 🎉</div>`}
      <button type="button" class="btn ghost block" id="add-payment">＋ Записать перевод вручную</button>
    </section>

    <section class="card">
      <h2>Баланс игроков</h2>
      ${rows.length ? `
      <table class="balances">
        <thead><tr><th>Игрок</th><th class="num">Игр</th><th class="num">Заплатил</th><th class="num">Доля</th><th class="num">Баланс</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${esc(r.name)}</td>
              <td class="num">${r.games}</td>
              <td class="num">${money(r.paid)}</td>
              <td class="num">${money(r.spent)}</td>
              <td class="num ${r.bal > 0 ? "pos" : r.bal < 0 ? "neg" : ""}"><b>${r.bal > 0 ? "+" : ""}${money(r.bal)}</b></td>
            </tr>`).join("")}
        </tbody>
      </table>
      <p class="muted small">«Заплатил» — сумма броней, «Доля» — стоимость его игр. Плюс — ему должны, минус — должен он. Переводы учитываются в балансе.</p>`
      : `<div class="empty small">Пока нет данных</div>`}
    </section>

    <section class="card">
      <h2>История переводов</h2>
      ${payments.length ? `<ul class="payments">${payments.map((p) => `
        <li>
          <div>
            <b>${esc(playerName(p.fromId))}</b> → <b>${esc(playerName(p.toId))}</b>: ${money(toCents(p.amount))}
            <div class="muted small">${esc(fmtDate(p.date, true))}${p.note ? ` · ${esc(p.note)}` : ""}</div>
          </div>
          <button type="button" class="btn ghost small danger-text" data-del-pay="${p.id}" aria-label="Удалить перевод">✕</button>
        </li>`).join("")}</ul>` : `<div class="muted small">Переводов пока не было. Нажмите «✓ Оплачено», когда кто-то вернёт долг.</div>`}
    </section>
  `;

  $$("[data-mode]", view).forEach((b) => b.onclick = () => { ui.debtMode = b.dataset.mode; localStorageSet("pb:debtMode", ui.debtMode); render(); });
  $$("[data-settle]", view).forEach((b) => b.onclick = async () => {
    const d = list[Number(b.dataset.settle)];
    const ok = await confirmDialog({
      title: "Долг оплачен?",
      text: `<b>${esc(playerName(d.from))}</b> перевёл(а) <b>${esc(playerName(d.to))}</b> ${money(d.amount)}.`,
      okText: "Да, оплачено",
    });
    if (ok) {
      store.write(`payments/${newId()}`, { fromId: d.from, toId: d.to, amount: fromCents(d.amount), date: todayIso(), note: "", createdAt: Date.now() });
      toast("Перевод записан");
    }
  });
  $("#add-payment").onclick = () => editPayment();
  $$("[data-del-pay]", view).forEach((b) => b.onclick = async () => {
    const p = store.state.payments[b.dataset.delPay];
    if (!p) return;
    const ok = await doubleConfirm("Удалить перевод?", `${esc(playerName(p.fromId))} → ${esc(playerName(p.toId))}: ${money(toCents(p.amount))}. Долг снова появится.`);
    if (ok) { store.write(`payments/${b.dataset.delPay}`, null); toast("Перевод удалён"); }
  });
}

function editPayment() {
  const opts = sortedPlayers((p) => !p.archived).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  openModal(`
    <form class="sheet" id="pay-form" novalidate>
      <h2>Перевод</h2>
      <label>Кто перевёл<select name="fromId" required><option value="">—</option>${opts}</select></label>
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
      if (fd.get("fromId") === fd.get("toId")) return (err.textContent = "Нельзя перевести самому себе");
      if (!Number.isFinite(amount) || amount <= 0) return (err.textContent = "Укажите сумму");
      store.write(`payments/${newId()}`, {
        fromId: fd.get("fromId"), toId: fd.get("toId"), amount: Math.round(amount * 100) / 100,
        date: fd.get("date") || todayIso(), note: String(fd.get("note") || "").trim(), createdAt: Date.now(),
      });
      closeModal(true);
      toast("Перевод записан");
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
  const row = (p) => {
    const bal = L.balance[p.id] || 0;
    return `
      <li class="player">
        <div class="pinfo">
          <b>${esc(p.name)}</b>
          <span class="muted small">${L.games[p.id] || 0} ${plural(L.games[p.id] || 0, "игра", "игры", "игр")}${bal ? ` · <span class="${bal > 0 ? "pos" : "neg"}">${bal > 0 ? "+" : ""}${money(bal)}</span>` : ""}</span>
        </div>
        <div class="pact">
          <button type="button" class="btn ghost small" data-rename="${p.id}" aria-label="Переименовать">✎</button>
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
  $$("[data-archive]", view).forEach((b) => b.onclick = () => {
    const id = b.dataset.archive;
    store.write(`players/${id}/archived`, true);
    const bal = L.balance[id] || 0;
    toast(bal ? `${playerName(id)} в архиве (долг ${money(bal)} сохранён)` : `${playerName(id)} в архиве`);
  });
  $$("[data-unarchive]", view).forEach((b) => b.onclick = () => store.write(`players/${b.dataset.unarchive}/archived`, false));
  $$("[data-rename]", view).forEach((b) => b.onclick = () => renamePlayer(b.dataset.rename));
  $$("[data-del-player]", view).forEach((b) => b.onclick = async () => {
    const id = b.dataset.delPlayer;
    const ok = await doubleConfirm("Удалить игрока?", `«${esc(playerName(id))}» ещё не участвовал в играх, его можно удалить совсем.`);
    if (ok) store.write(`players/${id}`, null);
  });
}

function renamePlayer(id) {
  const p = players()[id];
  if (!p) return;
  openModal(`
    <form class="sheet" id="rename-form">
      <h2>Переименовать</h2>
      <label>Имя<input type="text" name="name" value="${esc(p.name)}" required autocomplete="off"></label>
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
      store.write(`players/${id}/name`, name);
      closeModal(true);
    });
  });
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

// ---------- старт ----------

store.subscribe(() => {
  // не перерисовываем страницу под открытой формой, чтобы не терять ввод
  if (modal.open) { renderSync(); return; }
  render();
});
modal.addEventListener("close", () => render());
render();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
