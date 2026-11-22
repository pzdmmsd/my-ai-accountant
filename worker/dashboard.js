const monthlyBills = "FROM bills WHERE user_id = ? AND strftime('%Y-%m', date) = ?";
const categoryName = "COALESCE(NULLIF(trim(category), ''), '未分类')";
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
  const [settings, annual, pie, line, categories] = await db.batch([
    db.prepare("SELECT budget_limit FROM settings WHERE user_id = ?").bind(userId),
    db.prepare(`SELECT strftime('%m', date) AS month,
      SUM(CASE WHEN lower(type) = 'expense' OR type = '支出' THEN amount_cny ELSE 0 END) AS exp,
      SUM(CASE WHEN lower(type) = 'income' OR type = '收入' THEN amount_cny ELSE 0 END) AS inc
      FROM bills WHERE user_id = ? AND strftime('%Y', date) = ? GROUP BY month ORDER BY month`).bind(userId, year),
    db.prepare(`SELECT ${categoryName} AS category, SUM(amount_cny) AS value ${monthlyBills}
      AND (lower(type) = 'expense' OR type = '支出') GROUP BY ${categoryName} ORDER BY value DESC, category`).bind(userId, month),
    db.prepare(`SELECT date(date) AS day, SUM(amount_cny) AS value ${monthlyBills}
      AND (lower(type) = 'expense' OR type = '支出') GROUP BY day ORDER BY day`).bind(userId, month),
    db.prepare(`SELECT DISTINCT ${categoryName} AS category ${monthlyBills} ORDER BY category`).bind(userId, month),
  ]);
  const selectedMonth = annual.results.find((entry) => entry.month === month.slice(5));
  const limit = settings.results[0]?.budget_limit ?? 5000;
  const current = selectedMonth?.exp ?? 0;

  return {
    income: selectedMonth?.inc ?? 0,
    budget: { limit, current, isOver: current > limit },
    annual: annual.results,
    pie: pie.results,
    line: line.results.map(({ day, value }) => ({ date: day, value })),
    categories: categories.results.map(({ category }) => category),
  };
}

export function readTransactionCursor(cursor, month) {
  if (!cursor) return null;
  const match = /^([0-9]{4}-[0-9]{2}-[0-9]{2}[^|]{0,24})\|(-?\d+)$/.exec(cursor);
  if (!match || !match[1].startsWith(month) || !Number.isSafeInteger(Number(match[2]))) return undefined;
  return [match[1], Number(match[2])];
}

export async function readMonthlyTransactions(db, userId, month, category, cursor) {
  const filter = category === null ? monthlyBills : `${monthlyBills} AND ${categoryName} = ?`;
  const params = category === null ? [userId, month] : [userId, month, category];
  const window = cursor ? `${filter} AND (date, id) < (?, ?)` : filter;
  const [count, page] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS total ${filter}`).bind(...params),
    db.prepare(`SELECT id, date, type, ${categoryName} AS category, description, amount_original, currency_original, amount_cny ${window}
      ORDER BY date DESC, id DESC LIMIT ?`).bind(...params, ...(cursor ?? []), pageSize + 1),
  ]);
  const rows = page.results.slice(0, pageSize);
  const last = rows.at(-1);
  return { rows, total: count.results[0].total, nextCursor: page.results.length > pageSize ? `${last.date}|${last.id}` : null };
}
