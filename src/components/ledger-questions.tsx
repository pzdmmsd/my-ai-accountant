import { useState, type FormEvent } from "react"
import { Bot, LoaderCircle, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { askLedger, monthLabel, type LedgerAnswer } from "@/lib/ledger"

const examples = ["这个月花得最多的是哪一类？", "这个月净支出占预算多少？", "这个月金额最大的一笔支出是什么？"]

export function LedgerQuestions({ token, month }: { token: string; month: string }) {
  const [draft, setDraft] = useState("")
  const [result, setResult] = useState<(LedgerAnswer & { question: string }) | null>(null)
  const [pending, setPending] = useState(false)
  const [expired, setExpired] = useState(false)
  const [failed, setFailed] = useState(false)
  const canAsk = Boolean(token) && !expired

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const question = draft.trim()
    if (pending || !canAsk || !question) return
    setPending(true)
    setFailed(false)
    setResult(null)
    try {
      const answer = await askLedger(token, month, question)
      if (answer === "expired") setExpired(true)
      else setResult({ ...answer, question })
    } catch {
      setFailed(true)
    } finally {
      setPending(false)
    }
  }

  return <Card id="ask-ledger" className="dashboard-card questions-card">
    <CardHeader className="panel-header">
      <div>
        <CardTitle className="questions-title"><Bot size={18} aria-hidden="true" />AI 账单问答</CardTitle>
        <CardDescription>默认查询 {monthLabel(month)}，也可在问题中指定日期或时间段。</CardDescription>
      </div>
    </CardHeader>
    <CardContent className="panel-content">
      {canAsk ? <form onSubmit={submit} className="questions-form" aria-busy={pending}>
        <label htmlFor="ledger-question" className="sr-only">账单问题</label>
        <textarea id="ledger-question" rows={2} maxLength={500} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="输入你的账单问题" disabled={pending} />
        <div className="questions-actions">
          <div className="question-examples">
            {examples.map((example) => <Button key={example} type="button" variant="outline" size="sm" onClick={() => setDraft(example)} disabled={pending}>{example}</Button>)}
          </div>
          <Button type="submit" disabled={!draft.trim() || pending}>
            {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
            {pending ? "正在查询" : "提问"}
          </Button>
        </div>
      </form> : <p className="questions-hint">在 Telegram 向机器人发送 <code>/start</code>，用新链接打开看板即可提问。</p>}
      {failed && <p className="questions-error" role="alert">问答服务暂时不可用，请重试。</p>}
      {result && <div className="questions-answer" aria-live="polite">
        <p className="questions-prompt">{result.question}</p>
        <p className="questions-response">{result.answer}</p>
        {result.sources.length > 0 && <ul className="questions-sources" aria-label="账单查询范围">
          {result.sources.map(({ start, end, search, count }, index) => <li key={index}>{periodLabel(start, end)}{search && ` · ${search}`} · {count} 笔</li>)}
        </ul>}
      </div>}
    </CardContent>
  </Card>
}

function periodLabel(start: string, end: string) {
  if (start && end) return start === end ? start : `${start} 至 ${end}`
  if (start) return `${start} 起`
  if (end) return `截至 ${end}`
  return "全部账单"
}
