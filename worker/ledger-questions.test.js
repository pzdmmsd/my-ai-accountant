import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import worker from "./index.js";
import { dashboardAccount, dashboardLink } from "./dashboard-session.js";
import { model } from "./nvidia.js";

const secret = "fixture-telegram-secret";
const tokenFrom = (link) => new URLSearchParams(new URL(link).hash.slice(1)).get("ask");

test("dashboard question links bind the account and expire", async () => {
  const now = Date.now();
  const token = tokenFrom(await dashboardLink("1234", secret, now));
  assert.equal(await dashboardAccount(`Bearer ${token}`, secret, now), "1234");
  assert.equal(await dashboardAccount(`Bearer ${token.replace(/^1234/, "4321")}`, secret, now), null);
  assert.equal(await dashboardAccount(`Bearer ${token}`, secret, now + 7 * 86400000), null);
});

test("Telegram start produces a dashboard question link for the receiving chat", async (t) => {
  let sent;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, `https://api.telegram.org/bot${secret}/sendMessage`);
    sent = JSON.parse(options.body);
    return Response.json({ ok: true });
  });
  let task;
  const update = new Request("https://fixture.invalid/webhook", { method: "POST", body: JSON.stringify({ message: { text: "/start", chat: { id: 1234 } } }) });
  const response = await worker.fetch(update, { TG_TOKEN: secret }, { waitUntil: (promise) => { task = promise; } });
  await task;
  assert.equal(response.status, 200);
  assert.equal(sent.chat_id, "1234");
  const url = new URL(sent.text.match(/\((https:\/\/[^)]+)\)/)[1]);
  assert.equal(url.searchParams.get("user_id"), "1234");
  assert.equal(await dashboardAccount(`Bearer ${tokenFrom(url.href)}`, secret), "1234");
});

test("ledger questions answer from account-scoped totals across different years", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE bills (id INTEGER PRIMARY KEY, user_id TEXT, date TEXT, type TEXT, category TEXT, description TEXT, amount_original REAL, currency_original TEXT, amount_cny REAL);
    CREATE TABLE settings (user_id TEXT PRIMARY KEY, budget_limit REAL);
    INSERT INTO settings VALUES ('1234', 750);
    INSERT INTO bills (user_id, date, type, category, description, amount_original, currency_original, amount_cny) VALUES
      ('1234', '2024-02-29', '支出', '餐饮', '测试午餐', 10, 'CNY', 10),
      ('1234', '2024-02-29T10:30:00Z', 'expense', '餐饮', '测试晚餐', 23, 'CNY', 23),
      ('1234', '2028-02-29', 'expense', '餐饮', '测试餐费', 65, 'CNY', 65),
      ('1234', '2024-02-24', 'income', '餐饮', '测试补贴', 100, 'CNY', 100),
      ('4321', '2024-02-29', 'expense', '餐饮', '其他账户', 900, 'CNY', 900);`);
  const env = {
    DB: { prepare: (sql) => ({ bind: (...args) => ({ all: async () => ({ results: db.prepare(sql).all(...args) }) }) }) },
    TG_TOKEN: secret,
    NVIDIA_API_KEY: "fixture-key",
  };
  const question = "对比 2024 年和 2028 年二月的餐饮支出。";
  const scope = (year, details) => ({ start: `${year}-02-01`, end: `${year}-02-29`, type: "expense", search: "餐饮", group: "category", details });
  const responseText = "2024 年 2 月餐饮支出 33 元，2028 年 2 月餐饮支出 65 元。";
  const fakeNim = t.mock.method(globalThis, "fetch", async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.model, model);
    let content;
    if (request.response_format) {
      assert.match(request.messages[0].content, /2024-02-29/);
      assert.equal(request.messages[1].content, question);
      content = JSON.stringify({ queries: [scope(2024, "none"), scope(2028, "largest")], includeBudget: false });
    } else {
      const { results, currentBudgetCny } = JSON.parse(request.messages[1].content);
      assert.equal(currentBudgetCny, undefined);
      assert.deepEqual(results.map(({ totals }) => [totals.expense, totals.count]), [[33, 2], [65, 1]]);
      assert.equal(results[0].groups[0].label, "餐饮");
      assert.equal(results[0].details, undefined);
      assert.equal(results[1].details[0].description, "测试餐费");
      content = responseText;
    }
    return Response.json({ choices: [{ message: { content }, finish_reason: "stop" }] });
  });

  const token = tokenFrom(await dashboardLink("1234", secret));
  const ask = (authorization, questionBody = question) => worker.fetch(new Request("https://fixture.invalid/api/ask?user_id=4321", {
    method: "POST", headers: { Authorization: authorization }, body: JSON.stringify({ question: questionBody, month: "2024-02", user_id: "4321" }),
  }), env, {});
  assert.equal((await ask(`Bearer ${token.replace(/^1234/, "4321")}`)).status, 401);
  assert.equal((await ask(`Bearer ${token}`, "问".repeat(501))).status, 400);
  assert.equal(fakeNim.mock.callCount(), 0);
  const response = await ask(`Bearer ${token}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    answer: responseText,
    sources: [
      { start: "2024-02-01", end: "2024-02-29", search: "餐饮", count: 2 },
      { start: "2028-02-01", end: "2028-02-29", search: "餐饮", count: 1 },
    ],
  });
  assert.equal(fakeNim.mock.callCount(), 2);
});
