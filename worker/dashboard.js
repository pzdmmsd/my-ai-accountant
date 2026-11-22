const monthlyBills = "FROM bills WHERE user_id = ? AND strftime('%Y-%m', date) = ?";
const categoryName = "COALESCE(NULLIF(trim(category), ''), '未分类')";
const income = "(lower(type) = 'income' OR type = '收入')";
const expense = "(lower(type) = 'expense' OR type = '支出')";
const amountRank = "abs(coalesce(amount_cny, 0))";
const pageSize = 50;

export function validMonth(month) {
  return month.length === 7 && /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

export async function readAvailableMonths(db, userId) {
  const { results } = await db.prepare("SELECT DISTINCT strftime('%Y-%m', date) AS m FROM bills WHERE user_id = ? ORDER BY m DESC").bind(userId).all();
  return results.flatMap(({ m }) => m && validMonth(m) ? [m] : []);
}

export async function readDashboardMonth(db, userId, month) {
  const year = month.slice(0, 4);
  const [settings, annual, composition, line, categories] = await db.batch([
    db.prepare("SELECT budget_limit FROM settings WHERE user_id = ?").bind(userId),
    db.prepare(`SELECT strftime('%m', date) AS month,
      SUM(CASE WHEN ${expense} THEN amount_cny ELSE 0 END) AS exp,
      SUM(CASE WHEN ${income} THEN amount_cny ELSE 0 END) AS inc
      FROM bills WHERE user_id = ? AND strftime('%Y', date) = ? GROUP BY month ORDER BY month`).bind(userId, year),
    db.prepare(`SELECT CASE WHEN ${income} THEN 'income' ELSE 'expense' END AS direction,
      ${categoryName} AS category, SUM(amount_cny) AS value ${monthlyBills}
      AND (${income} OR ${expense}) GROUP BY direction, ${categoryName} ORDER BY value DESC, category`).bind(userId, month),
    db.prepare(`SELECT date(date) AS day, SUM(amount_cny) AS value ${monthlyBills}
      AND ${expense} GROUP BY day ORDER BY day`).bind(userId, month),
    db.prepare(`SELECT DISTINCT ${categoryName} AS category ${monthlyBills} ORDER BY category`).bind(userId, month),
  ]);
  const selectedMonth = annual.results.find((entry) => entry.month === month.slice(5));
  const limit = settings.results[0]?.budget_limit ?? 5000;
  const current = selectedMonth?.exp ?? 0;

  const pie = [];
  const incomePie = [];
  for (const { direction, category, value } of composition.results) {
    (direction === "income" ? incomePie : pie).push({ category, value });
  }
  return {
    income: selectedMonth?.inc ?? 0,
    budget: { limit, current, isOver: current > limit },
    annual: annual.results,
    pie,
    incomePie,
    line: line.results.map(({ day, value }) => ({ date: day, value })),
    categories: categories.results.map(({ category }) => category),
  };
}

export function readTransactionCursor(cursor, month, sort) {
  if (!cursor) return null;
  const byAmount = sort === "amount";
  const parts = cursor.split("|");
  if (parts.length !== (byAmount ? 3 : 2)) return undefined;
  const match = /^([0-9]{4}-[0-9]{2}-[0-9]{2}[^|]{0,24})\|(-?\d+)$/.exec(parts.slice(-2).join("|"));
  if (!match || !match[1].startsWith(month) || !Number.isSafeInteger(Number(match[2]))) return undefined;
  const position = [match[1], Number(match[2])];
  if (!byAmount) return position;
  const amount = Number(parts[0]);
  if (!parts[0].trim() || !Number.isFinite(amount) || amount < 0) return undefined;
  return [amount, ...position];
}

export async function readMonthlyTransactions(db, userId, month, { category, type, sort, cursor }) {
  let filter = category === null ? monthlyBills : `${monthlyBills} AND ${categoryName} = ?`;
  if (type) filter += ` AND ${type === "income" ? income : expense}`;
  const params = category === null ? [userId, month] : [userId, month, category];
  const byAmount = sort === "amount";
  const order = byAmount ? `${amountRank} DESC, date DESC, id DESC` : "date DESC, id DESC";
  const cut = byAmount ? `(${amountRank}, date, id) < (?, ?, ?)` : "(date, id) < (?, ?)";
  const window = cursor ? `${filter} AND ${cut}` : filter;
  const [count, page] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS total ${filter}`).bind(...params),
    db.prepare(`SELECT id, date, type, ${categoryName} AS category, description, amount_original, currency_original, amount_cny ${window}
      ORDER BY ${order} LIMIT ?`).bind(...params, ...(cursor ?? []), pageSize + 1),
  ]);
  const rows = page.results.slice(0, pageSize);
  const last = rows.at(-1);
  const nextCursor = page.results.length > pageSize
    ? `${byAmount ? `${Math.abs(last.amount_cny ?? 0)}|` : ""}${last.date}|${last.id}`
    : null;
  return { rows, total: count.results[0].total, nextCursor };
}
