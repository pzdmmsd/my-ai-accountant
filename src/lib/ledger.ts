export type Category = { category: string; value: number }
export type YearMonth = { month: string; exp: number; inc: number }
export type DailyExpense = { date: string; value: number }
export type Budget = { limit: number; current: number; isOver: boolean }

export type Dashboard = {
  income: number
  annual: YearMonth[]
  pie: Category[]
  incomePie: Category[]
  line: DailyExpense[]
  budget: Budget
  categories: string[]
}

export type TransactionPage = { rows: Transaction[]; total: number; nextCursor: string | null }
export type TransactionType = "income" | "expense"
export type TransactionSort = "date" | "amount"

export type Transaction = {
  id: number
  date: string
  type: "income" | "expense"
  description: string | null
  category: string
  amount_original: number
  currency_original: string
  amount_cny: number
}

const apiBase = import.meta.env.VITE_API_BASE_URL || "https://moneydb.pzdmmsd.qzz.io"
const moneyFormat = new Intl.NumberFormat("zh-CN", {
  style: "currency", currency: "CNY", currencyDisplay: "narrowSymbol", maximumFractionDigits: 2,
})
const decimalFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 })

export function money(amount: number) {
  return moneyFormat.format(amount)
}

export function originalAmount(amount: number, currency: string) {
  return currency === "CNY" ? money(amount) : `${decimalFormat.format(amount)} ${currency}`
}

export function compactAmount(amount: number) {
  return amount >= 10000 ? `${decimalFormat.format(amount / 10000)}万` : decimalFormat.format(amount)
}

export function monthLabel(month: string) {
  const [year, index] = month.split("-")
  return `${year}年${Number(index)}月`
}

export function currentMonth() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).format(new Date())
}

export async function ledgerRequest<T>(userId: string, filters: Record<string, string>, signal: AbortSignal): Promise<T> {
  const url = new URL("/api/data", apiBase)
  url.search = new URLSearchParams({ user_id: userId, ...filters }).toString()
  const response = await fetch(url, { signal, cache: "no-store" })
  if (!response.ok) throw new Error(`Ledger request failed (${response.status})`)
  return response.json() as Promise<T>
}
