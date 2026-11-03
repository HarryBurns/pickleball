import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeLedger, computeStats, splitCost, simplifyDebts, toCents } from "../ledger.js";
import { cleanState } from "../store.js";

const P = (...ids) => Object.fromEntries(ids.map((i) => [i, true]));
const base = (extra = {}) => ({ players: {}, wallets: {}, games: {}, payments: {}, settings: {}, ...extra });
const fmt = (list) => list.map((d) => `${d.from}>${d.to}:${d.amount / 100}`).sort();

test("splitCost делит без потери копеек", () => {
  const s = splitCost(1000, ["c", "a", "b"]);
  assert.deepEqual(s, { a: 334, b: 333, c: 333 });
  assert.equal(Object.values(s).reduce((x, y) => x + y, 0), 1000);
  assert.deepEqual(splitCost(500, []), {});
});

test("игра: каждый должен плательщику свою долю, сумма балансов = 0", () => {
  const L = computeLedger(base({
    players: { a: { name: "A" }, b: { name: "B" }, c: { name: "C" } },
    games: { g: { date: "2026-01-01", cost: 300, payerId: "a", players: P("a", "b", "c") } },
  }));
  assert.deepEqual(fmt(L.direct), ["p:b>p:a:100", "p:c>p:a:100"]);
  assert.equal(Object.values(L.balance).reduce((x, y) => x + y, 0), 0);
});

test("плательщик может не играть", () => {
  const L = computeLedger(base({
    games: { g: { date: "2026-01-01", cost: 200, payerId: "x", players: P("a", "b") } },
  }));
  assert.equal(L.balance["p:x"], toCents(200));
});

test("кошелёк: внутри долгов нет, снаружи считается как один участник", () => {
  const L = computeLedger(base({
    players: { a: { name: "A", walletId: "w" }, b: { name: "B", walletId: "w" }, c: { name: "C" } },
    wallets: { w: {} },
    games: { g: { date: "2026-01-01", cost: 300, payerId: "a", players: P("a", "b", "c") } },
  }));
  assert.deepEqual(fmt(L.direct), ["p:c>w:w:100"]);
});

test("перевод гасит долг, ручной долг добавляет", () => {
  const st = base({
    games: { g: { date: "2026-01-01", cost: 200, payerId: "a", players: P("a", "b") } },
    payments: { p: { kind: "payment", fromId: "b", toId: "a", amount: 100 } },
  });
  assert.deepEqual(computeLedger(st).direct, []);
  st.payments.d = { kind: "debt", fromId: "a", toId: "b", amount: 30 };
  assert.deepEqual(fmt(computeLedger(st).direct), ["p:a>p:b:30"]);
});

test("минимум переводов сводит цепочку", () => {
  assert.deepEqual(simplifyDebts({ a: -100, b: 0, c: 100 }), [{ from: "a", to: "c", amount: 100 }]);
  const r = simplifyDebts({ a: -50, b: -50, c: 30, d: 70 });
  assert.equal(r.reduce((s, x) => s + x.amount, 0), 100);
});

test("статистика: игры, часы, траты", () => {
  const S = computeStats([
    { date: "2026-01-01", cost: 100, duration: 1.5, payerId: "a", players: P("a", "b") },
    { date: "2026-02-01", cost: 60, duration: 1, payerId: "b", players: P("b") },
  ]);
  assert.equal(S.total.games, 2);
  assert.equal(S.total.hours, 2.5);
  assert.equal(S.per.b.hours, 2.5);
  assert.equal(S.per.b.spent, toCents(110));
  assert.equal(S.per.a.booked, 1);
});

test("реальные данные на 03.11.2026 дают известный результат", () => {
  const db = cleanState(JSON.parse(readFileSync(new URL("./fixtures/db-2026-11-03.json", import.meta.url))));
  const L = computeLedger(db);
  assert.deepEqual(fmt(L.direct), ["w:w_olga_alexey>p:seed_harry:77000", "w:w_vera_igor>w:w_olga_alexey:45000"]);
  assert.deepEqual(fmt(L.simplified), ["w:w_olga_alexey>p:seed_harry:32000", "w:w_vera_igor>p:seed_harry:45000"]);
});

test("cleanState отбрасывает битые записи", () => {
  const s = cleanState({
    players: { ok: { name: " Аня " }, noname: { archived: true }, bad: "x" },
    games: {
      ok: { date: "2026-01-01", cost: "100", payerId: "ok", players: { ok: true, no: false }, time: "25:00" },
      bad: { date: "<img>", cost: 1, payerId: "ok", players: {} },
    },
    payments: { zero: { fromId: "a", toId: "b", amount: 0 }, ok: { fromId: "a", toId: "b", amount: 5, kind: "weird" } },
    settings: null,
  });
  assert.deepEqual(Object.keys(s.players), ["ok"]);
  assert.equal(s.players.ok.name, "Аня");
  assert.deepEqual(Object.keys(s.games), ["ok"]);
  assert.equal(s.games.ok.cost, 100);
  assert.equal(s.games.ok.time, "");
  assert.deepEqual(s.games.ok.players, { ok: true });
  assert.deepEqual(Object.keys(s.payments), ["ok"]);
  assert.equal(s.payments.ok.kind, "payment");
  assert.deepEqual(s.settings, {});
});
