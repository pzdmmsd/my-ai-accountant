export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");
    const data = await request.json();
    const msg = data.message;
    if (!msg || !msg.text) return new Response("OK");

    const chatId = msg.chat.id;
    const userText = msg.text;

    // --- 1. 处理指令：如果是查询报表 ---
    if (userText === "/report") {
      const stats = await env.DB.prepare(
        "SELECT SUM(amount_cny) as total FROM bills WHERE created_at > date('now', 'start of month')"
      ).first();
      await sendMessage(chatId, `📊 本月消费统计：\n总计：${stats.total || 0} CNY`, env);
      return new Response("OK");
    }

    // --- 2. AI 识别逻辑 ---
    try {
      const aiResponse = await env.AI.run("@cf/meta/llama-3-8b-instruct", {
        messages: [
          { role: "system", content: "你是一个记账助手。提取 JSON：{amount:数字, currency:币种代码, desc:描述}。" },
          { role: "user", content: userText }
        ],
        response_format: { type: "json_object" }
      });

      const info = typeof aiResponse === 'string' ? JSON.parse(aiResponse) : aiResponse;
      const { amount, currency = "CNY", desc = "日常消费" } = info;

      if (!amount) return new Response("OK");

      // --- 3. 换算逻辑 ---
      let amountCNY = amount;
      let rate = 1;
      if (currency.toUpperCase() !== "CNY") {
        const exRes = await fetch(`https://v6.exchangerate-api.com/v6/${env.EXCHANGE_KEY}/latest/${currency}`);
        const exData = await exRes.json();
        rate = exData.conversion_rates.CNY;
        amountCNY = (amount * rate).toFixed(2);
      }

      // --- 4. 核心步骤：存入 D1 数据库 ---
      // 这行代码把数据永久存进了你之前创建的 SQL 表里
      await env.DB.prepare(
        "INSERT INTO bills (amount_original, currency_original, amount_cny, category, description) VALUES (?, ?, ?, ?, ?)"
      ).bind(amount, currency, amountCNY, "默认", desc).run();

      const reply = `✅ 已记账并存入数据库！\n💰 ${amount} ${currency} -> ${amountCNY} CNY\n📝 备注：${desc}`;
      await sendMessage(chatId, reply, env);

    } catch (e) {
      await sendMessage(chatId, "抱歉，记账失败了，请检查格式。", env);
    }

    return new Response("OK");
  }
};

async function sendMessage(chatId, text, env) {
  await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text }),
  });
}