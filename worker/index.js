import { extractTransactions } from "./nvidia.js";

const dashboardHeaders = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

function accountingDate() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
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

    ctx.waitUntil((async () => {
      let chatId;
      try {
        if (body.callback_query) { await handleCallback(body.callback_query, env); return; }
        const msg = body.message || body.edited_message;
        if (!msg) return;
        chatId = String(msg.chat.id);

        if (msg.photo) {
          const fileId = msg.photo[msg.photo.length - 1].file_id;
          await handleAccounting(chatId, msg.caption, env, fileId);
        } else if (msg.text) {
          const text = msg.text.trim();
          if (text.startsWith("/start")) await handleStart(chatId, env);
          else if (text.startsWith("/help")) await handleHelp(chatId, env);
          else if (text.startsWith("/budget") || text.match(/^(预算|设置预算)[:：\s]*/)) await handleSetBudget(chatId, text, env);
          else if (text === "/list" || text === "明细") await handleListQuery(chatId, env);
          else if (text.match(/^(金额|修改金额|改金额)/)) await handleUpdateAmount(chatId, text, env);
          else if (text.match(/^(备注|修改|更改|补)/)) await handleUpdateRemark(chatId, text, env);
          else await handleAccounting(chatId, text, env);
        }
      } catch (e) {
        console.error("Telegram update failed", { error: e.name });
        if (chatId) await sendMessage(chatId, "❌ 处理失败，请稍后重试。", env);
      }
    })());

    return response;
  }
};

/**
 * 🤖 AI 记账核心
 */
async function handleAccounting(userId, userText, env, fileId = null) {
  const today = accountingDate();
  const loading = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: userId, text: `⏳ AI 财务官正在审计账目...` })
  }).then(r => r.json());
  const botMsgId = loading.result.message_id;

  try {
    let image;
    if (fileId) {
      const file = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`, { signal: AbortSignal.timeout(3000) }).then(r => r.json());
      if (!file.ok || !file.result.file_path) throw new Error("Telegram image unavailable");
      const receipt = await fetch(`https://api.telegram.org/file/bot${env.TG_TOKEN}/${file.result.file_path}`, { signal: AbortSignal.timeout(3000) });
      if (!receipt.ok) throw new Error("Telegram image unavailable");
      image = `data:image/jpeg;base64,${arrayBufferToBase64(await receipt.arrayBuffer())}`;
    }

    const items = await extractTransactions({ key: env.NVIDIA_API_KEY, date: today, text: userText, image });
    if (!items.length) {
      await editMessage(userId, botMsgId, "没有识别到可记账的收支，请补充金额或重发清晰的账单。", env);
      return;
    }

    const currencies = [...new Set(items.map(item => item.currency))].filter(currency => currency !== "CNY");
    const rates = new Map(await Promise.all(currencies.map(async currency => {
      const exchange = await fetch(`https://v6.exchangerate-api.com/v6/${env.EXCHANGE_KEY}/latest/${currency}`, { signal: AbortSignal.timeout(3500) }).then(r => r.json());
      const rate = exchange.conversion_rates?.CNY;
      if (exchange.result !== "success" || !Number.isFinite(rate) || rate <= 0) throw new Error("Exchange rate unavailable");
      return [currency, rate];
    })));
    rates.set("CNY", 1);

    const transactions = items.map(item => ({ ...item, cny: Number((item.amount * rates.get(item.currency)).toFixed(2)) }));
    await env.DB.batch(transactions.map(({ amount, currency, cny, type, category, description, date }) =>
      env.DB.prepare("INSERT INTO bills (user_id, message_id, amount_original, currency_original, amount_cny, type, category, description, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(userId, String(botMsgId), amount, currency, cny, type, category, description, date)
    ));

    const summary = transactions.slice(0, 10).map(({ amount, currency, cny, type, category, description, date }) =>
      `${type === "income" ? "💰" : "💸"} ${amount} ${currency} (${cny} CNY)\n📅 ${date} | 📂 ${escapeMarkdown(category)}\n📝 ${escapeMarkdown(description)}`
    ).join("\n\n");
    await editMessage(userId, botMsgId, `✅ 已记录 ${items.length} 笔收支\n\n${summary}\n\n[📊 查看财务看板](https://money.pzdmmsd.qzz.io/?user_id=${userId})`, env, botMsgId);
  } catch (e) {
    console.error("Accounting request failed", { error: e.name, status: e.message.match(/^NVIDIA NIM returned HTTP (\d+)$/)?.[1] });
    await editMessage(userId, botMsgId, "❌ 暂时无法完成记账，请稍后重试。", env);
  }
}

/**
 * 其他指令函数
 */
async function handleSetBudget(userId, text, env) {
  const amt = parseFloat(text.match(/\d+(\.\d+)?/)?.[0]);
  if (!amt) return await sendMessage(userId, "⚠️ 请指定预算数字，如 `/budget 5000`", env);
  await env.DB.prepare("INSERT OR REPLACE INTO settings (user_id, budget_limit) VALUES (?, ?)").bind(userId, amt).run();
  await sendMessage(userId, `✅ 本月预算已调至 **¥${amt.toLocaleString()}**`, env);
}

async function handleStart(userId, env) {
  await sendMessage(userId, `💼 **AI 财务管家 Pro+ 已就绪**\n\n直接发送文字或照片即可记账。\n[🔗 点击开启可视化看板](https://money.pzdmmsd.qzz.io/?user_id=${userId})`, env);
}

async function handleHelp(userId, env) {
  await sendMessage(userId, `🛠 **功能指南**\n\n• /budget 8000 - 设预算\n• 金额：100 - 改错\n• 备注：内容 - 改备注\n• /list - 查明细`, env);
}

async function handleListQuery(userId, env) {
  const { results } = await env.DB.prepare("SELECT * FROM bills WHERE user_id = ? AND date >= date('now','-30 day') ORDER BY date DESC, id DESC").bind(userId).all();
  if (!results.length) return await sendMessage(userId, "📋 近期无记录。", env);
  const grouped = results.reduce((a, r) => { (a[r.date] = a[r.date] || []).push(r); return a; }, {});
  let txt = "📋 **最近明细**\n\n";
  for (const date in grouped) {
    const sum = grouped[date].reduce((s, r) => cleanTypeFormat(r.type)==='expense' ? s + r.amount_cny : s, 0).toFixed(2);
    txt += `─── **${date}** (支:${sum}) ───\n`;
    grouped[date].forEach(r => txt += `${cleanTypeFormat(r.type)==='income'?'➕':'➖'} ${r.amount_original}${r.currency_original} | ${r.category}\n    └ ${r.description}\n`);
    txt += `\n`;
  }
  await sendMessage(userId, `${txt}[📊 Pro+ 看板](https://money.pzdmmsd.qzz.io/?user_id=${userId})`, env);
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
  await sendMessage(userId, `💰 金额已修正。`, env);
}

async function handleUpdateRemark(userId, text, env) {
  const last = await env.DB.prepare("SELECT * FROM bills WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind(userId).first();
  if (!last) return;
  const part = text.replace(/^(备注|修改|更改|补)[:：\s]*/, "");
  const final = text.includes("补") ? `${last.description}，${part}` : part;
  await env.DB.prepare("UPDATE bills SET description = ?, type = ? WHERE id = ?").bind(final, cleanTypeFormat(last.type), last.id).run();
  await sendMessage(userId, `📝 备注已更新。`, env);
}

async function handleCallback(q, env) {
  await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/answerCallbackQuery`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callback_query_id: q.id }) });
  if (q.data.startsWith("del_")) {
    await env.DB.prepare("DELETE FROM bills WHERE user_id = ? AND message_id = ?").bind(String(q.message.chat.id), q.data.replace("del_", "")).run();
    await editMessage(String(q.message.chat.id), q.message.message_id, "🗑️ 记录已撤销。", env);
  }
}

// 辅助函数
function cleanTypeFormat(r) { const t = String(r||"expense").toLowerCase(); return (t.includes("收")||t.includes("income")) ? "income" : "expense"; }
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
function escapeMarkdown(text) { return text.replace(/[\\_*`\[]/g, "\\$&"); }
async function sendMessage(c, t, e) { await fetch(`https://api.telegram.org/bot${e.TG_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: c, text: t, parse_mode: "Markdown" }) }); }
async function editMessage(c, m, t, e, bid = null) {
  const body = { chat_id: c, message_id: m, text: t, parse_mode: "Markdown" };
  if (bid) body.reply_markup = { inline_keyboard: [[{ text: "撤销此笔记账 🗑️", callback_data: `del_${bid}` }]] };
  await fetch(`https://api.telegram.org/bot${e.TG_TOKEN}/editMessageText`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
