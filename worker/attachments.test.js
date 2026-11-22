import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { utils, write } from "xlsx";
import { utils as codepage } from "xlsx/dist/cpexcel";
import worker from "./index.js";
import { model } from "./nvidia.js";
import { readStatement } from "./workbook.js";

const rows = [["日期", "金额", "收支类型", "币种", "备注"], ["2026-11-21", 133, "支出", "HKD", "测试咖啡"], ["合计", 133]];

function statementRows(count) {
  return [rows[0], ...Array.from({ length: count }, (_, i) => ["2026-11-21", 133 + i, "支出", "HKD", `测试账单 ${i + 1}`])];
}

function workbookBytes(values, bookType = "xlsx") {
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, utils.aoa_to_sheet(values), "账单");
  return new Uint8Array(write(workbook, { type: "array", bookType }));
}

test("reads Excel amounts, dates and currencies without parsing summary rows", () => {
  for (const format of ["xlsx", "xls"]) {
    assert.deepEqual(readStatement(workbookBytes(rows, format)).items, [{ date: "2026-11-21", amount: 133, type: "expense", currency: "HKD", category: "其他", description: "测试咖啡" }]);
  }
  assert.equal(readStatement(workbookBytes([["date", "credit"], [46346, 100]])).items[0].type, "income");
  assert.throws(() => readStatement(workbookBytes([["日期", "金额"], ["2026-11-21", 133]])), /第 2 行/);
});

test("reads native WeChat Excel and Alipay CSV exports through their preambles", () => {
  const wechat = [
    ...Array.from({ length: 25 }, () => ["微信支付账单说明"]),
    ["交易时间", "交易类型", "交易对方", "商品", "收/支", "金额(元)", "支付方式", "当前状态", "交易单号", "商户单号", "备注"],
    ["2026-11-21 10:30:00", "商户消费", "便利店", "咖啡", "支出", "￥18.50", "零钱", "支付成功"],
    ["2026-11-21 10:31:00", "零钱充值", "系统", "充值", "/", "￥200.00", "银行卡", "充值成功"],
    ["2026-11-21 10:32:00", "商户消费", "超市", "食品", "支出", "￥12.00", "零钱", "已全额退款"],
  ];
  assert.deepEqual(readStatement(workbookBytes(wechat)), { items: [
    { date: "2026-11-21", amount: 18.5, type: "expense", currency: "CNY", category: "商户消费", description: "便利店 · 咖啡" },
  ], skipped: 2 });

  const alipay = [
    "支付宝交易明细",
    "账号信息：测试账号",
    "----------------------交易明细列表----------------------",
    "交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注",
    '2026-11-21 14:05:00,餐饮美食,测试餐厅,测试账号,"午餐, 套餐",支出,58.60,余额,交易成功,0001,0002,',
    "2026-11-21 14:05:00,其他,测试商户,测试账号,测试,支出,29.2,余额,交易关闭,0003,0004,",
    "----------------------交易明细列表结束----------------------",
  ].join("\r\n");
  for (const bytes of [new TextEncoder().encode(`\uFEFF${alipay}`), Uint8Array.from(codepage.encode(936, alipay))]) {
    assert.deepEqual(readStatement(bytes), { items: [
      { date: "2026-11-21", amount: 58.6, type: "expense", currency: "CNY", category: "餐饮美食", description: "测试餐厅 · 午餐, 套餐" },
    ], skipped: 1 });
  }
});

test("rejects more than 1,000 entries in XLSX or CSV", () => {
  const input = statementRows(1001);
  const csv = new TextEncoder().encode(input.map(row => row.join(",")).join("\n"));
  for (const bytes of [workbookBytes(input), csv]) {
    assert.throws(() => readStatement(bytes), /最多导入 1000 笔/);
  }
});

test("queues a JPEG document and imports 1,000 Excel entries exactly once", async (t) => {
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
    if (url.endsWith("bill.xlsx")) return new Response(workbookBytes(statementRows(1000)));
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
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM bills").get().count, 1001);
  assert.deepEqual(sqlite.prepare("SELECT amount_original, currency_original, amount_cny FROM bills ORDER BY rowid DESC LIMIT 1").all().map((row) => Object.values(row)), [[1132, "HKD", 1018.8]]);
  assert.equal(notices.length, 2);
  assert.match(notices[1], /已记录 1000 笔/);
  assert.ok(notices.every(notice => !/\p{Extended_Pictographic}/u.test(notice)));
});
