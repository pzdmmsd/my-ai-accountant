import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import worker from "./index.js";

test("monthly dashboard and complete transaction pages use the selected month and account", async (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(`CREATE TABLE bills (id INTEGER PRIMARY KEY, user_id TEXT, date TEXT, type TEXT, category TEXT, description TEXT, amount_original REAL, currency_original TEXT, amount_cny REAL);
    CREATE TABLE settings (user_id TEXT PRIMARY KEY, budget_limit REAL);
    INSERT INTO settings VALUES ('fixture', 75);`);
  const insert = sqlite.prepare(`INSERT INTO bills (user_id, date, type, category, description, amount_original, currency_original, amount_cny)
    VALUES (?, ?, ?, ?, '测试', ?, 'CNY', ?)`);
  const transaction = (month, type, category, amount, id = "fixture") => insert.run(id, month, type, category, amount, amount);
  for (let i = 0; i < 103; i++) transaction("2025-01-31", "expense", "餐饮", 1);
  transaction("2025-01-01", "income", "工资", 200);
  transaction("2025-01-01", "支出", null, 7);
  transaction("2025-02-01", "expense", "交通", 50);
  transaction("2026-01-01", "income", "其他年份", 999);
  transaction("2025-01-31", "expense", "餐饮", 900, "other");

  const DB = {
    prepare: (sql) => ({ bind: (...args) => ({ all: async () => ({ results: sqlite.prepare(sql).all(...args) }) }) }),
    batch: async (queries) => Promise.all(queries.map((query) => query.all())),
  };
  const request = (params) => worker.fetch(new Request(`https://fixture.invalid/api/data?${new URLSearchParams({ user_id: "fixture", ...params })}`), { DB }, {});
  async function json(params) {
    const response = await request(params);
    assert.equal(response.status, 200);
    return response.json();
  }

  assert.deepEqual(await json({ view: "months" }), ["2026-01", "2025-02", "2025-01"]);
  const summary = await json({ view: "month", month: "2025-01" });
  assert.equal(summary.income, 200);
  assert.deepEqual(summary.budget, { current: 110, limit: 75, isOver: true });
  assert.deepEqual(summary.annual.map(({ month, inc, exp }) => [month, inc, exp]), [["01", 200, 110], ["02", 0, 50]]);
  assert.deepEqual(summary.pie.map(({ category, value }) => [category, value]), [["餐饮", 103], ["未分类", 7]]);
  assert.deepEqual(summary.incomePie, [{ category: "工资", value: 200 }]);
  assert.deepEqual((await json({ view: "month", month: "2025-02" })).incomePie, []);
  assert.deepEqual(summary.line, [{ date: "2025-01-01", value: 7 }, { date: "2025-01-31", value: 103 }]);
  assert(summary.categories.includes("工资"));

  const first = await json({ view: "transactions", month: "2025-01" });
  const second = await json({ view: "transactions", month: "2025-01", before: first.nextCursor });
  const last = await json({ view: "transactions", month: "2025-01", before: second.nextCursor });
  assert.equal(first.total, 105);
  assert.deepEqual([first.rows.length, second.rows.length, last.rows.length], [50, 50, 5]);
  assert.equal(last.nextCursor, null);
  const allIds = [...first.rows, ...second.rows, ...last.rows].map(({ id }) => id);
  assert.equal(new Set(allIds).size, 105);
  assert(last.rows.some(({ type }) => type === "income"));

  const wages = await json({ view: "transactions", month: "2025-01", category: "工资" });
  assert.equal(wages.total, 1);
  assert.equal(wages.rows[0].amount_cny, 200);
  const monthlyTransactions = { view: "transactions", month: "2025-01" };
  assert.deepEqual((await json({ ...monthlyTransactions, type: "income" })).rows, wages.rows);
  const expenses = await json({ ...monthlyTransactions, type: "expense", sort: "amount" });
  assert.equal(expenses.total, 104);
  assert.equal(expenses.rows[0].type, "支出");
  assert.equal((await json({ ...monthlyTransactions, type: "expense", category: "餐饮" })).total, 103);
  assert.equal((await json({ ...monthlyTransactions, type: "income", category: "餐饮" })).total, 0);

  const amountSort = { ...monthlyTransactions, sort: "amount" };
  const largest = await json(amountSort);
  const middle = await json({ ...amountSort, before: largest.nextCursor });
  const smallest = await json({ ...amountSort, before: middle.nextCursor });
  const sortedRows = [...largest.rows, ...middle.rows, ...smallest.rows];
  assert.deepEqual(sortedRows.map(({ amount_cny }) => amount_cny), [200, 7, ...Array(103).fill(1)]);
  assert.deepEqual(sortedRows.map(({ id }) => id), [104, 105, ...Array.from({ length: 103 }, (_, index) => 103 - index)]);
  assert.equal(smallest.nextCursor, null);
  assert.equal((await request({ ...amountSort, before: first.nextCursor })).status, 400);
  assert.equal((await request({ ...monthlyTransactions, type: "unknown" })).status, 400);
  assert.equal((await request({ ...monthlyTransactions, sort: "unknown" })).status, 400);
  assert.deepEqual(await json({ view: "transactions", month: "2025-03" }), { rows: [], total: 0, nextCursor: null });
  assert.equal((await request({ view: "month", month: "2025-13" })).status, 400);
  assert.equal((await request({ view: "transactions", month: "2025-02", before: first.nextCursor })).status, 400);
  assert.deepEqual(await json({ month: "2025-02" }), [{ category: "交通", value: 50 }]);
});
