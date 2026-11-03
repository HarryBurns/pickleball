// Расчёт долгов. Все суммы считаются в копейках (целых числах), чтобы не было ошибок округления.

export const toCents = (v) => Math.round((Number(v) || 0) * 100);
export const fromCents = (c) => c / 100;

export function gamePlayerIds(game) {
  return Object.keys((game && game.players) || {}).filter((id) => game.players[id]);
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
  const balance = {}; // >0 — ему должны, <0 — он должен
  const paid = {};
  const spent = {};
  const games = {};
  const owes = {}; // owes[a][b] — сколько a должен b (без взаимозачёта)

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
    add(paid, g.payerId, total);
    add(balance, g.payerId, total);
    for (const id of ids) {
      add(spent, id, shares[id]);
      add(balance, id, -shares[id]);
      add(games, id, 1);
      addOwe(id, g.payerId, shares[id]);
    }
  }

  for (const p of Object.values(state.payments || {})) {
    const amt = toCents(p.amount);
    if (!p.fromId || !p.toId || !amt) continue;
    add(balance, p.fromId, amt);
    add(balance, p.toId, -amt);
    addOwe(p.fromId, p.toId, -amt);
  }

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
