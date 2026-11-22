import assert from "node:assert/strict"
import { test } from "node:test"
import { extractTransactions, model } from "./nvidia.js"

const entry = { amount: 28.5, type: "expense", currency: "cny", category: "餐饮", desc: "午餐" }
const context = { key: "test-key", date: "2026-11-22" }
const completion = (content) => Response.json({ choices: [{ message: { content }, finish_reason: "stop" }] })

test("extracts text transactions using NVIDIA NIM and normalizes fields", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://integrate.api.nvidia.com/v1/chat/completions")
    assert.equal(options.headers.Authorization, "Bearer test-key")
    const body = JSON.parse(options.body)
    assert.equal(body.model, model)
    assert.equal(body.response_format.type, "json_schema")
    assert.equal(body.stream, false)
    assert.deepEqual(body.messages[1], { role: "user", content: "午餐 28.5 元" })
    return completion(`\`\`\`json\n${JSON.stringify([entry])}\n\`\`\``)
  })
  assert.deepEqual(await extractTransactions({ ...context, text: "午餐 28.5 元" }), [
    { amount: 28.5, type: "expense", currency: "CNY", category: "餐饮", description: "午餐", date: context.date },
  ])
})

test("passes a Telegram photo and caption as multimodal content", async (t) => {
  const image = "data:image/jpeg;base64,AA=="
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body).messages[1].content, [
      { type: "text", text: "午餐" },
      { type: "image_url", image_url: { url: image } },
    ])
    return completion("[]")
  })
  assert.deepEqual(await extractTransactions({ ...context, text: "午餐", image }), [])
})

test("rejects invalid transactions and reports upstream error status", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => completion(JSON.stringify([{ ...entry, amount: null }])))
  await assert.rejects(extractTransactions({ ...context, text: "测试" }), /Invalid transaction/)
  fetch.mock.mockImplementation(async () => new Response("{}", { status: 429 }))
  await assert.rejects(extractTransactions({ ...context, text: "测试" }), /HTTP 429/)
})

test("recovers a screenshot when the first model produces an invalid row", async (t) => {
  const calls = []
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body)
    calls.push(body.model)
    if (body.model === model) return completion(JSON.stringify({ transactions: [{ ...entry, date: "2026-11-31" }] }))
    return completion(JSON.stringify({ transactions: [{ ...entry, currency: "HKD", date: "2026-11-21" }] }))
  })
  const result = await extractTransactions({ ...context, image: "data:image/jpeg;base64,AA==" })
  assert.deepEqual(calls, [model, "moonshotai/kimi-k3.1-pro"])
  assert.equal(result[0].currency, "HKD")
  assert.equal(result[0].date, "2026-11-21")
})
