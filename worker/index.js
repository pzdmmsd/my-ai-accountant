import { extractTransactions } from "./nvidia.js";
import { ImportError, readStatement } from "./workbook.js";

const dashboardHeaders = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

function accountingDate(timestamp = Date.now()) {
  return new Date((Number.isFinite(timestamp) ? timestamp : Date.now()) + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- 1. 前端 API 接口 (供网页调用) ---
    if (url.pathname === "/api/data") {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          }
        });
      }

      const userId = url.searchParams.get("user_id");
      const category = url.searchParams.get("category");
      const targetMonth = url.searchParams.get("month");

      if (!userId) return Response.json({ error: "Missing user_id" }, { status: 400, headers: dashboardHeaders });

      try {
        // A. 分类明细
        if (category) {
          const details = await env.DB.prepare("SELECT * FROM bills WHERE user_id = ? AND category = ? ORDER BY date DESC LIMIT 50").bind(userId, category).all();
          return Response.json(details.results, { headers: dashboardHeaders });
        }

        // B. 动态月份切换 (仅饼图)
        if (targetMonth && !url.searchParams.has("full")) {
          const pieData = await env.DB.prepare("SELECT category, SUM(amount_cny) as value FROM bills WHERE lower(type)='expense' AND user_id = ? AND strftime('%Y-%m', date) = ? GROUP BY category").bind(userId, targetMonth).all();
          return Response.json(pieData.results, { headers: dashboardHeaders });
        }

        // C. 基础全量数据
        const today = accountingDate();
        const nowMonth = today.slice(0, 7);
        const [settings, currentMonthTotal, totals, pie, line, annual, availableMonths] = await env.DB.batch([
          env.DB.prepare("SELECT budget_limit FROM settings WHERE user_id = ?").bind(userId),
          env.DB.prepare("SELECT SUM(amount_cny) as total FROM bills WHERE user_id = ? AND lower(type)='expense' AND strftime('%Y-%m', date) = ?").bind(userId, nowMonth),
          env.DB.prepare("SELECT lower(type) as type, SUM(amount_cny) as total FROM bills WHERE user_id = ? GROUP BY type").bind(userId),
          env.DB.prepare("SELECT category, SUM(amount_cny) as value FROM bills WHERE lower(type)='expense' AND user_id = ? AND strftime('%Y-%m', date) = ? GROUP BY category").bind(userId, nowMonth),
          env.DB.prepare("SELECT date, SUM(amount_cny) as value FROM bills WHERE lower(type)='expense' AND user_id = ? AND date BETWEEN date(?, '-29 days') AND ? GROUP BY date ORDER BY date ASC").bind(userId, today, today),
          env.DB.prepare("SELECT strftime('%m', date) as month, SUM(CASE WHEN lower(type)='expense' THEN amount_cny ELSE 0 END) as exp, SUM(CASE WHEN lower(type)='income' THEN amount_cny ELSE 0 END) as inc FROM bills WHERE user_id = ? AND strftime('%Y', date) = ? GROUP BY month ORDER BY month ASC").bind(userId, today.slice(0, 4)),
          env.DB.prepare("SELECT DISTINCT strftime('%Y-%m', date) as m FROM bills WHERE user_id = ? ORDER BY m DESC").bind(userId),
        ]);
        const budgetLimit = settings.results[0]?.budget_limit ?? 5000;
        const current = currentMonthTotal.results[0]?.total ?? 0;

        return Response.json({
          totals: totals.results, pie: pie.results, line: line.results, annual: annual.results, months: availableMonths.results,
          budget: { limit: budgetLimit, current, isOver: current > budgetLimit }
        }, { headers: dashboardHeaders });
      } catch (e) {
        console.error("Dashboard query failed", { error: e.name });
        return Response.json({ error: "Dashboard query failed" }, { status: 500, headers: dashboardHeaders });
      }
    }

    // --- 2. Telegram Webhook 处理 ---
    if (request.method !== "POST") return new Response("OK");

    let body;
    try { body = await request.json(); } catch (e) { return new Response("OK"); }

    const response = new Response("OK", { status: 200 });
    if (!body || typeof body !== "object") return response;
    const msg = body.message || body.edited_message;
    const text = msg?.text?.trim();
    const file = msg && accountingFile(msg);
    const isCommand = text && /^(\/start|\/help|\/budget|\/list$|明细$|预算|设置预算|金额|修改金额|改金额|备注|修改|更改|补)/.test(text);
    if (msg && (file || (text && !isCommand))) {
      if (!Number.isSafeInteger(body.update_id) || !Number.isSafeInteger(msg.chat?.id)) return new Response("Invalid update", { status: 400 });
      try {
        await env.IMPORTS.send({ updateId: String(body.update_id), chatId: String(msg.chat.id), text: msg.caption || text, file, date: accountingDate(msg.date * 1000) });
        return response;
      } catch (e) {
        console.error("Accounting enqueue failed", { error: e.name });
        return new Response("Temporarily unavailable", { status: 503 });
      }
    }

    ctx.waitUntil((async () => {
      let chatId;
      try {
        if (body.callback_query) { await handleCallback(body.callback_query, env); return; }
        if (!msg) return;
        chatId = String(msg.chat.id);

        if (msg.document) {
          await sendMessage(chatId, "请发送 JPG、PNG、WebP 图片，或 XLSX、XLS、CSV 账单。微信和支付宝账单请先解压。", env);
        } else if (text) {
          if (text.startsWith("/start")) await handleStart(chatId, env);
          else if (text.startsWith("/help")) await handleHelp(chatId, env);
          else if (text.startsWith("/budget") || text.match(/^(预算|设置预算)[:：\s]*/)) await handleSetBudget(chatId, text, env);
          else if (text === "/list" || text === "明细") await handleListQuery(chatId, env);
          else if (text.match(/^(金额|修改金额|改金额)/)) await handleUpdateAmount(chatId, text, env);
          else if (text.match(/^(备注|修改|更改|补)/)) await handleUpdateRemark(chatId, text, env);
        }
      } catch (e) {
        console.error("Telegram update failed", { error: e.name });
        if (chatId) await sendMessage(chatId, "处理失败，请稍后重试。", env);
      }
    })());

    return response;
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      await handleAccounting(message.body, env);
      message.ack();
    }
  },
};

function accountingFile(msg) {
  const photo = msg.photo?.at(-1);
  if (photo?.file_id) return { kind: "image", id: photo.file_id, size: photo.file_size };
  const document = msg.document;
  if (!document?.file_id) return null;
  const name = document.file_name || "";
  const mime = document.mime_type || "";
  const file = { id: document.file_id, size: document.file_size };
  if (/\.(jpg|jpeg|png|webp)$/i.test(name) || /^image\/(jpeg|png|webp)$/i.test(mime)) return { ...file, kind: "image" };
  if (/\.(xlsx?|csv)$/i.test(name) || /^(text\/csv|application\/vnd\.ms-excel|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet)$/i.test(mime)) return { ...file, kind: "workbook" };
  return null;
}

async function downloadAccountingFile(file, env) {
  const megabytes = file.kind === "workbook" ? 2 : 5;
  const limit = megabytes * 1024 * 1024;
  const tooLarge = () => new ImportError(`文件过大。${file.kind === "workbook" ? "流水表" : "图片"}文件上限为 ${megabytes} MB。`);
  if (file.size > limit) throw tooLarge();
  const api = `https://api.telegram.org/bot${env.TG_TOKEN}`;
  const metadata = await fetch(`${api}/getFile?file_id=${encodeURIComponent(file.id)}`, { signal: AbortSignal.timeout(10000) }).then(r => r.json());
  if (!metadata.ok || !metadata.result?.file_path) throw new ImportError("无法从 Telegram 下载附件，请重新发送文件。");
  if (metadata.result.file_size > limit) throw tooLarge();
  const path = metadata.result.file_path.split("/").map(encodeURIComponent).join("/");
  const download = await fetch(`https://api.telegram.org/file/bot${env.TG_TOKEN}/${path}`, { signal: AbortSignal.timeout(20000) });
  if (!download.ok || !download.body) throw new ImportError("无法从 Telegram 下载附件，请重新发送文件。");
  const reader = download.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function imageDataUrl(bytes) {
  const signature = (...prefix) => prefix.every((value, index) => bytes[index] === value);
  let kind;
  if (signature(0xff, 0xd8, 0xff)) kind = "jpeg";
  else if (signature(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) kind = "png";
  else if (signature(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) kind = "webp";
  else throw new ImportError("无法识别图片格式，请发送 JPG、PNG 或 WebP。");
  return `data:image/${kind};base64,${arrayBufferToBase64(bytes.buffer)}`;
}

async function saveAccountingUpdate(db, updateId, userId, botMsgId, transactions) {
  const statements = [];
  for (let index = 0; index < transactions.length; index += 10) {
    const rows = transactions.slice(index, index + 10);
    const values = rows.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const parameters = rows.flatMap(({ amount, currency, cny, type, category, description, date }) => [userId, botMsgId, amount, currency, cny, type, category, description, date]);
    statements.push(db.prepare(`INSERT INTO bills (user_id, message_id, amount_original, currency_original, amount_cny, type, category, description, date)
      SELECT * FROM (VALUES ${values}) WHERE NOT EXISTS (SELECT 1 FROM accounting_updates WHERE update_id = ?)`)
      .bind(...parameters, updateId));
  }
  statements.push(db.prepare("INSERT OR IGNORE INTO accounting_updates (update_id) VALUES (?)").bind(updateId));
  await db.batch(statements);
}

async function handleAccounting({ updateId, chatId: userId, text, file, date }, env) {
  if (await env.DB.prepare("SELECT 1 FROM accounting_updates WHERE update_id = ?").bind(updateId).first()) return;
  const loading = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: userId, text: file?.kind === "workbook" ? "正在读取流水表…" : "正在识别账单…" }),
    signal: AbortSignal.timeout(8000),
  }).then(r => r.json());
  if (!loading.ok || !loading.result?.message_id) throw new Error("Telegram acknowledgement failed");
  const botMsgId = String(loading.result.message_id);

  let stage = "download";
  try {
    const bytes = file ? await downloadAccountingFile(file, env) : null;
    stage = file?.kind === "workbook" ? "workbook" : "nvidia";
    const { items, skipped = 0 } = file?.kind === "workbook"
      ? readStatement(bytes)
      : { items: await extractTransactions({ key: env.NVIDIA_API_KEY, date, text, image: bytes ? imageDataUrl(bytes) : undefined }) };
    if (!items.length) {
      await editMessage(userId, botMsgId, skipped ? `这份账单没有可入账的收支，已略过 ${skipped} 笔。` : "没有识别到可记账的收支，请补充金额或重发清晰的账单。", env);
      return;
    }

    stage = "exchange";
    const currencies = [...new Set(items.map(item => item.currency))].filter(currency => currency !== "CNY");
    const rates = new Map(await Promise.all(currencies.map(async currency => {
      const exchange = await fetch(`https://v6.exchangerate-api.com/v6/${env.EXCHANGE_KEY}/latest/${currency}`, { signal: AbortSignal.timeout(10000) }).then(r => r.json());
      const rate = exchange.conversion_rates?.CNY;
      if (exchange.result !== "success" || !Number.isFinite(rate) || rate <= 0) throw new Error("Exchange rate unavailable");
      return [currency, rate];
    })));
    rates.set("CNY", 1);

    const transactions = items.map(item => ({ ...item, cny: Number((item.amount * rates.get(item.currency)).toFixed(2)) }));
    stage = "database";
    await saveAccountingUpdate(env.DB, updateId, userId, botMsgId, transactions);

    const summary = transactions.slice(0, 10).map(({ amount, currency, cny, type, category, description, date }) => {
      const converted = currency === "CNY" ? "" : `（约 ${cny} CNY）`;
      return `${type === "income" ? "+" : "−"}${amount} ${currency}${converted} · ${date} · ${escapeMarkdown(category)}${description ? `\n${escapeMarkdown(description)}` : ""}`;
    }).join("\n\n");
    const heading = `已记录 ${items.length} 笔收支${skipped ? `，略过 ${skipped} 笔` : ""}。${items.length > 10 ? "以下显示前 10 笔。" : ""}`;
    stage = "reply";
    await editMessage(userId, botMsgId, `${heading}\n\n${summary}\n\n[查看财务看板](https://money.pzdmmsd.qzz.io/?user_id=${userId})`, env, botMsgId);
  } catch (e) {
    console.error("Accounting request failed", { stage, error: e.name, reason: e.code, status: e.status });
    const message = e instanceof ImportError ? e.message : stage === "reply" ? "账单已记录，请用 /list 查看。" : stage === "nvidia" && file ? "这张图片未能生成可入账的明细。可以裁成几张清晰的截图再发送。" : stage === "nvidia" ? "暂时无法识别这条消息，本次未入账。" : stage === "exchange" ? "暂时无法获取汇率，本次未入账。请稍后重试。" : "暂时无法完成记账，请稍后重试。";
    await editMessage(userId, botMsgId, escapeMarkdown(message), env);
  }
}

/**
 * 其他指令函数
 */
async function handleSetBudget(userId, text, env) {
  const amt = parseFloat(text.match(/\d+(\.\d+)?/)?.[0]);
  if (!amt) return await sendMessage(userId, "请指定预算数字，如 `/budget 5000`。", env);
  await env.DB.prepare("INSERT OR REPLACE INTO settings (user_id, budget_limit) VALUES (?, ?)").bind(userId, amt).run();
  await sendMessage(userId, `本月预算已调至 ¥${amt.toLocaleString()}。`, env);
}

async function handleStart(userId, env) {
  await sendMessage(userId, `发送文字、账单照片、Excel 或 CSV 流水即可记账。微信和支付宝导出的账单请先解压。\n\n[打开财务看板](https://money.pzdmmsd.qzz.io/?user_id=${userId})`, env);
}

async function handleHelp(userId, env) {
  await sendMessage(userId, `/budget 8000 设置预算\n金额：100 修改最近一笔金额\n备注：内容 修改最近一笔备注\n/list 查看最近明细`, env);
}

async function handleListQuery(userId, env) {
  const { results } = await env.DB.prepare("SELECT * FROM bills WHERE user_id = ? AND date >= date('now','-30 day') ORDER BY date DESC, id DESC").bind(userId).all();
  if (!results.length) return await sendMessage(userId, "近期无记录。", env);
  const expenses = new Map();
  for (const item of results) {
    if (cleanTypeFormat(item.type) === "expense") expenses.set(item.date, (expenses.get(item.date) ?? 0) + Number(item.amount_cny));
  }
  let txt = "最近 30 天的账单\n";
  let previousDate;
  let included = 0;
  for (const row of results) {
    const description = escapeMarkdown(String(row.description ?? "").slice(0, 140));
    const header = row.date === previousDate ? "" : `\n${row.date} · 支出 ${(expenses.get(row.date) ?? 0).toFixed(2)} CNY\n`;
    const line = `${header}${cleanTypeFormat(row.type) === "income" ? "+" : "−"}${row.amount_original} ${row.currency_original} · ${escapeMarkdown(String(row.category ?? "其他"))}${description ? `\n${description}` : ""}\n`;
    if (txt.length + line.length > 3700) break;
    txt += line;
    previousDate = row.date;
    included++;
  }
  if (included < results.length) txt += `\n另有 ${results.length - included} 笔未在这条消息中展开。\n`;
  await sendMessage(userId, `${txt}\n[查看财务看板](https://money.pzdmmsd.qzz.io/?user_id=${userId})`, env);
}

async function handleUpdateAmount(userId, text, env) {
  const last = await env.DB.prepare("SELECT * FROM bills WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind(userId).first();
  const amt = parseFloat(text.match(/\d+(\.\d+)?/)?.[0]);
  if (!last || !amt) return;
  let cny = amt;
  if (last.currency_original !== "CNY") {
    const ex = await fetch(`https://v6.exchangerate-api.com/v6/${env.EXCHANGE_KEY}/latest/${last.currency_original}`).then(r => r.json());
    cny = parseFloat((amt * ex.conversion_rates.CNY).toFixed(2));
  }
  await env.DB.prepare("UPDATE bills SET amount_original = ?, amount_cny = ?, type = ? WHERE id = ?").bind(amt, cny, cleanTypeFormat(last.type), last.id).run();
  await sendMessage(userId, "金额已修正。", env);
}

async function handleUpdateRemark(userId, text, env) {
  const last = await env.DB.prepare("SELECT * FROM bills WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind(userId).first();
  if (!last) return;
  const part = text.replace(/^(备注|修改|更改|补)[:：\s]*/, "");
  const final = text.includes("补") ? `${last.description}，${part}` : part;
  await env.DB.prepare("UPDATE bills SET description = ?, type = ? WHERE id = ?").bind(final, cleanTypeFormat(last.type), last.id).run();
  await sendMessage(userId, "备注已更新。", env);
}

async function handleCallback(q, env) {
  await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/answerCallbackQuery`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callback_query_id: q.id }) });
  if (q.data.startsWith("del_")) {
    await env.DB.prepare("DELETE FROM bills WHERE user_id = ? AND message_id = ?").bind(String(q.message.chat.id), q.data.replace("del_", "")).run();
    await editMessage(String(q.message.chat.id), q.message.message_id, "记录已撤销。", env);
  }
}

// 辅助函数
function cleanTypeFormat(r) { const t = String(r||"expense").toLowerCase(); return (t.includes("收")||t.includes("income")) ? "income" : "expense"; }
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
function escapeMarkdown(text) { return text.replace(/[\\_*`\[]/g, "\\$&"); }
async function sendMessage(c, t, e) { await fetch(`https://api.telegram.org/bot${e.TG_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: c, text: t, parse_mode: "Markdown" }) }); }
async function editMessage(c, m, t, e, bid = null) {
  const body = { chat_id: c, message_id: m, text: t, parse_mode: "Markdown" };
  if (bid) body.reply_markup = { inline_keyboard: [[{ text: "撤销本次记账", callback_data: `del_${bid}` }]] };
  const response = await fetch(`https://api.telegram.org/bot${e.TG_TOKEN}/editMessageText`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  if (!response.ok || !(await response.json()).ok) throw new Error("Telegram confirmation failed");
}
