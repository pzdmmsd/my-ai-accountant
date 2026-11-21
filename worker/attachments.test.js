import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { utils, write } from "xlsx";
import worker from "./index.js";
import { model } from "./nvidia.js";
import { readWorkbook } from "./workbook.js";

const rows = [["日期", "金额", "收支类型", "币种", "备注"], ["2026-11-21", 133, "支出", "HKD", "测试咖啡"], ["合计", 133]];

function workbookBytes(values, bookType = "xlsx") {
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, utils.aoa_to_sheet(values), "账单");
  return new Uint8Array(write(workbook, { type: "array", bookType }));
}

test("reads Excel amounts, dates and currencies without parsing summary rows", () => {
  for (const format of ["xlsx", "xls"]) {
    assert.deepEqual(readWorkbook(workbookBytes(rows, format)), [{ date: "2026-11-21", amount: 133, type: "expense", currency: "HKD", category: "其他", description: "测试咖啡" }]);
  }
  assert.equal(readWorkbook(workbookBytes([["date", "credit"], [46346, 100]]))[0].type, "income");
  assert.throws(() => readWorkbook(workbookBytes([["日期", "金额"], ["2026-11-21", 133]])), /第 2 行/);
});

test("queues a JPEG document and imports an Excel attachment exactly once", async (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(`CREATE TABLE bills (user_id, message_id, amount_original, currency_original, amount_cny, type, category, description, date);`);
  sqlite.exec(readFileSync(new URL("./migrations/0001_accounting_updates.sql", import.meta.url), "utf8"));
  const pending = [];
  const notices = [];
  const env = {
    DB: {
      prepare: (sql) => ({ bind: (...args) => ({ first: () => sqlite.prepare(sql).get(...args), run: () => sqlite.prepare(sql).run(...args) }) }),
      batch: (statements) => {
        sqlite.exec("BEGIN");
        try { statements.forEach((statement) => statement.run()); sqlite.exec("COMMIT"); }
        catch (error) { sqlite.exec("ROLLBACK"); throw error; }
      },
    },
    IMPORTS: { send: (job) => pending.push(job) },
    TG_TOKEN: "test",
    NVIDIA_API_KEY: "test",
    EXCHANGE_KEY: "test",
  };
  let modelCalls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.includes("/sendMessage")) return Response.json({ ok: true, result: { message_id: notices.length + 1 } });
    if (url.includes("/editMessageText")) { notices.push(JSON.parse(options.body).text); return Response.json({ ok: true }); }
    if (url.includes("/getFile")) return Response.json({ ok: true, result: { file_path: new URL(url).searchParams.get("file_id") } });
    if (url.endsWith("bill.jpg")) return new Response(Uint8Array.of(255, 216, 255, 217));
    if (url.endsWith("bill.xlsx")) return new Response(workbookBytes(rows));
    if (url.includes("api.nvidia.com")) {
      modelCalls++;
      const body = JSON.parse(options.body);
      assert.equal(body.model, model);
      assert.equal(body.chat_template_kwargs.enable_thinking, false);
      assert.equal(body.messages[1].content[1].image_url.url, "data:image/jpeg;base64,/9j/2Q==");
      return Response.json({ choices: [{ message: { content: '[{"amount":12,"type":"expense","currency":"CNY"}]' } }] });
    }
    if (url.includes("exchangerate-api.com")) return Response.json({ result: "success", conversion_rates: { CNY: 0.9 } });
    assert.fail(`Unexpected request to ${new URL(url).hostname}`);
  });
  for (const [index, file] of ["bill.jpg", "bill.xlsx"].entries()) {
    const body = { update_id: index + 1, message: { chat: { id: 88 }, date: 1795289843, document: { file_id: file, file_name: file } } };
    const response = await worker.fetch(new Request("https://test.invalid", { method: "POST", body: JSON.stringify(body) }), env, {});
    assert.equal(response.status, 200);
  }
  assert.deepEqual(pending.map(({ file }) => file.kind), ["image", "workbook"]);
  for (const body of [...pending, pending[1]]) await worker.queue({ messages: [{ body, ack() {} }] }, env);
  assert.equal(modelCalls, 1);
  assert.deepEqual(sqlite.prepare("SELECT amount_original, currency_original, amount_cny FROM bills ORDER BY amount_original").all().map((row) => Object.values(row)), [[12, "CNY", 12], [133, "HKD", 119.7]]);
  assert.equal(notices.length, 2);
  assert.match(notices[1], /已记录 1 笔/);
});
