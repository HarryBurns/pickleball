// Расчёт долгов и статистики. Все суммы считаются в копейках/минимальных единицах (целых числах).
// Долги считаются по «кошелькам»: игроки с общим кошельком — один участник расчётов.

export const toCents = (v) => Math.round((Number(v) || 0) * 100);
export const fromCents = (c) => c / 100;

export function gamePlayerIds(game) {
  return Object.keys((game && game.players) || {}).filter((id) => game.players[id]);
}

// Ключ участника расчётов: "w:<walletId>" или "p:<playerId>".
export function walletKey(state, playerId) {
  const p = (state.players || {})[playerId];
  if (p && p.walletId && (state.wallets || {})[p.walletId]) return `w:${p.walletId}`;
  return `p:${playerId}`;
}

// Делит сумму поровну; лишние копейки достаются первым игрокам (в стабильном порядке).
export function splitCost(totalCents, ids) {
  const sorted = [...ids].sort();
  const n = sorted.length;
  const shares = {};
  if (!n) return shares;
  const base = Math.floor(totalCents / n);
  let rest = totalCents - base * n;
  for (const id of sorted) {
    shares[id] = base + (rest > 0 ? 1 : 0);
    if (rest > 0) rest--;
  }
  return shares;
}

export function computeLedger(state) {
  const balance = {}; // по ключам кошельков: >0 — им должны, <0 — они должны
  const paid = {}; // по ключам кошельков
  const spent = {}; // по ключам кошельков
  const games = {}; // по игрокам
  const owes = {}; // owes[a][b] — сколько кошелёк a должен кошельку b (без взаимозачёта)
  const K = (pid) => walletKey(state, pid);

  const add = (obj, id, v) => { obj[id] = (obj[id] || 0) + v; };
  const addOwe = (a, b, v) => {
    if (a === b || !v) return;
    owes[a] = owes[a] || {};
    owes[a][b] = (owes[a][b] || 0) + v;
  };

  for (const g of Object.values(state.games || {})) {
    const ids = gamePlayerIds(g);
    const total = toCents(g.cost);
    if (!g.payerId || !ids.length) continue;
    const shares = splitCost(total, ids);
    const payer = K(g.payerId);
    add(paid, payer, total);
    add(balance, payer, total);
    for (const id of ids) {
      const k = K(id);
      add(spent, k, shares[id]);
      add(balance, k, -shares[id]);
      add(games, id, 1);
      addOwe(k, payer, shares[id]);
    }
  }

  for (const p of Object.values(state.payments || {})) {
    const amt = toCents(p.amount);
    if (!p.fromId || !p.toId || !amt) continue;
    const from = K(p.fromId), to = K(p.toId);
    if (p.kind === "debt") {
      // from должен to
      add(balance, from, -amt);
      add(balance, to, amt);
      addOwe(from, to, amt);
    } else {
      // перевод: from вернул деньги to
      add(balance, from, amt);
      add(balance, to, -amt);
      addOwe(from, to, -amt);
    }
  }

  for (const k of Object.keys(balance)) if (!balance[k]) delete balance[k];

  return { balance, paid, spent, games, direct: directDebts(owes), simplified: simplifyDebts(balance) };
}

// Взаимозачёт по парам: кто кому должен "как было".
function directDebts(owes) {
  const ids = new Set(Object.keys(owes));
  for (const a of Object.keys(owes)) for (const b of Object.keys(owes[a])) ids.add(b);
  const list = [...ids].sort();
  const res = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const net = ((owes[a] || {})[b] || 0) - ((owes[b] || {})[a] || 0);
      if (net > 0) res.push({ from: a, to: b, amount: net });
      else if (net < 0) res.push({ from: b, to: a, amount: -net });
    }
  }
  return res.sort((x, y) => y.amount - x.amount);
}

// Минимум переводов: самый большой должник платит самому большому кредитору.
export function simplifyDebts(balance) {
  const debtors = [], creditors = [];
  for (const [id, v] of Object.entries(balance)) {
    if (v < 0) debtors.push({ id, v: -v });
    else if (v > 0) creditors.push({ id, v });
  }
  const res = [];
  while (debtors.length && creditors.length) {
    debtors.sort((a, b) => b.v - a.v || a.id.localeCompare(b.id));
    creditors.sort((a, b) => b.v - a.v || a.id.localeCompare(b.id));
    const d = debtors[0], c = creditors[0];
    const amt = Math.min(d.v, c.v);
    res.push({ from: d.id, to: c.id, amount: amt });
    d.v -= amt; c.v -= amt;
    if (!d.v) debtors.shift();
    if (!c.v) creditors.shift();
  }
  return res;
}

// Статистика по сыгранным играм (список игр уже отфильтрован по периоду).
export function computeStats(games) {
  const total = { games: 0, hours: 0, cost: 0, seats: 0 };
  const per = {}; // playerId -> { games, hours, spent, booked, paid }
  const byMonth = {}; // "YYYY-MM" -> { games, hours, cost }
  const P = (id) => (per[id] = per[id] || { games: 0, hours: 0, spent: 0, booked: 0, paid: 0 });
  for (const g of games) {
    const ids = gamePlayerIds(g);
    const cost = toCents(g.cost);
    const hours = Number(g.duration) || 0;
    const shares = splitCost(cost, ids);
    total.games++;
    total.hours += hours;
    total.cost += cost;
    total.seats += ids.length;
    const m = (g.date || "").slice(0, 7);
    const bm = (byMonth[m] = byMonth[m] || { games: 0, hours: 0, cost: 0 });
    bm.games++; bm.hours += hours; bm.cost += cost;
    for (const id of ids) {
      const s = P(id);
      s.games++;
      s.hours += hours;
      s.spent += shares[id];
    }
    if (g.payerId) { const s = P(g.payerId); s.booked++; s.paid += cost; }
  }
  return { total, per, byMonth };
}
