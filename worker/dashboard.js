const monthlyBills = "FROM bills WHERE user_id = ? AND strftime('%Y-%m', date) = ?";
export const categoryName = "COALESCE(NULLIF(trim(category), ''), '未分类')";
export const income = "(lower(type) = 'income' OR type = '收入')";
export const expense = "(lower(type) = 'expense' OR type = '支出')";
export const defaultBudget = 5000;
const amountRank = "abs(coalesce(amount_cny, 0))";
const currencyCode = "upper(trim(currency_original))";
const pageSize = 50;

export function validMonth(month) {
  return typeof month === "string" && month.length === 7 && /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

export async function readAvailableMonths(db, userId) {
  const { results } = await db.prepare("SELECT DISTINCT strftime('%Y-%m', date) AS m FROM bills WHERE user_id = ? ORDER BY m DESC").bind(userId).all();
  return results.flatMap(({ m }) => m && validMonth(m) ? [m] : []);
}

function weeksOverlappingMonth(month) {
  const monday = new Date(`${month}-01T00:00:00Z`);
  const last = new Date(monday);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);

  const weeks = [];
  for (; monday <= last; monday.setUTCDate(monday.getUTCDate() + 7)) {
    const sunday = new Date(monday);
    sunday.setUTCDate(sunday.getUTCDate() + 6);
    weeks.push({ start: new Date(monday), end: sunday });
  }
  return weeks;
}

export async function readDashboardMonth(db, userId, month) {
  const year = month.slice(0, 4);
  const weeks = weeksOverlappingMonth(month);
  const [settings, annual, composition, daily, categories, currencyExpenses] = await db.batch([
    db.prepare("SELECT budget_limit FROM settings WHERE user_id = ?").bind(userId),
    db.prepare(`SELECT strftime('%m', date) AS month,
      SUM(CASE WHEN ${expense} THEN amount_cny ELSE 0 END) AS exp,
      SUM(CASE WHEN ${income} THEN amount_cny ELSE 0 END) AS inc
      FROM bills WHERE user_id = ? AND strftime('%Y', date) = ? GROUP BY month ORDER BY month`).bind(userId, year),
    db.prepare(`SELECT CASE WHEN ${income} THEN 'income' ELSE 'expense' END AS direction,
      ${categoryName} AS category, SUM(amount_cny) AS value ${monthlyBills}
      AND (${income} OR ${expense}) GROUP BY direction, ${categoryName} ORDER BY value DESC, category`).bind(userId, month),
    db.prepare(`SELECT date(date) AS day, unixepoch(date(date)) AS daySecond,
      SUM(CASE WHEN ${expense} THEN amount_cny END) AS expense,
      SUM(CASE WHEN ${income} THEN amount_cny END) AS income
      FROM bills WHERE user_id = ? AND unixepoch(date(date)) BETWEEN ? AND ? AND (${expense} OR ${income})
      GROUP BY day ORDER BY day`).bind(userId, weeks[0].start.getTime() / 1000, weeks.at(-1).end.getTime() / 1000),
    db.prepare(`SELECT DISTINCT ${categoryName} AS category ${monthlyBills} ORDER BY category`).bind(userId, month),
    db.prepare(`SELECT ${currencyCode} AS currency, SUM(amount_original) AS amount, COUNT(*) AS count ${monthlyBills}
      AND ${expense} AND amount_original IS NOT NULL AND ${currencyCode} GLOB '[A-Z][A-Z][A-Z]'
      GROUP BY currency ORDER BY currency`).bind(userId, month),
  ]);
  const selectedMonth = annual.results.find((entry) => entry.month === month.slice(5));
  const limit = settings.results[0]?.budget_limit ?? defaultBudget;
  const current = selectedMonth?.exp ?? 0;
  const monthDays = daily.results.filter(({ day }) => day.startsWith(`${month}-`));
  const weekly = weeks.map(({ start, end }) => {
    const firstSecond = start.getTime() / 1000;
    const lastSecond = end.getTime() / 1000;
    let weeklyIncome = 0;
    let weeklyExpense = 0;
    for (const day of daily.results) {
      if (day.daySecond < firstSecond || day.daySecond > lastSecond) continue;
      weeklyIncome += day.income ?? 0;
      weeklyExpense += day.expense ?? 0;
    }
    return { start: start.toISOString().split("T")[0], end: end.toISOString().split("T")[0], income: weeklyIncome, expense: weeklyExpense };
  });

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
    currencyExpenses: currencyExpenses.results,
    line: monthDays.flatMap(({ day, expense: value }) => value === null ? [] : [{ date: day, value }]),
    incomeLine: monthDays.flatMap(({ day, income: value }) => value === null ? [] : [{ date: day, value }]),
    weekly,
    categories: categories.results.map(({ category }) => category),
  };
}

export function readTransactionCursor(cursor, month, sort) {
  if (!cursor) return null;
  const byAmount = sort === "amount";
  const ascending = sort === "date_asc";
  const parts = cursor.split("|");
  if (parts.length !== (byAmount || ascending ? 3 : 2) || (ascending && parts[0] !== "asc")) return undefined;
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
  const ascending = sort === "date_asc";
  const order = byAmount ? `${amountRank} DESC, date DESC, id DESC` : ascending ? "date ASC, id ASC" : "date DESC, id DESC";
  const cut = byAmount ? `(${amountRank}, date, id) < (?, ?, ?)` : `(date, id) ${ascending ? ">" : "<"} (?, ?)`;
  const window = cursor ? `${filter} AND ${cut}` : filter;
  const [count, page] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS total ${filter}`).bind(...params),
    db.prepare(`SELECT id, date, type, ${categoryName} AS category, description, amount_original, currency_original, amount_cny ${window}
      ORDER BY ${order} LIMIT ?`).bind(...params, ...(cursor ?? []), pageSize + 1),
  ]);
  const rows = page.results.slice(0, pageSize);
  const last = rows.at(-1);
  const total = count.results[0].total;
  if (page.results.length <= pageSize) return { rows, total, nextCursor: null };
  const prefix = byAmount ? `${Math.abs(last.amount_cny ?? 0)}|` : ascending ? "asc|" : "";
  return { rows, total, nextCursor: `${prefix}${last.date}|${last.id}` };
}
