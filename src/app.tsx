import { lazy, Suspense, useEffect, useState, type ReactNode } from "react"
import { Activity, ArrowDownLeft, ArrowRight, ArrowUpRight, Bot, CalendarDays, ChartNoAxesColumnIncreasing, ChevronLeft, ChevronRight, CircleAlert, CircleHelp, LayoutDashboard, List, Menu, Moon, PieChart, RefreshCw, Sun, Wallet, type LucideIcon } from "lucide-react"
import type { Series } from "@/components/ledger-charts"
import { LedgerQuestions } from "@/components/ledger-questions"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { currentMonth, ledgerRequest, money, monthLabel, originalAmount, type Dashboard, type Transaction, type TransactionPage, type TransactionSort, type TransactionType } from "@/lib/ledger"
import { cn } from "@/lib/utils"

const CashFlowChart = lazy(() => import("@/components/ledger-charts").then(({ CashFlowChart }) => ({ default: CashFlowChart })))
const DailyChart = lazy(() => import("@/components/ledger-charts").then(({ DailyChart }) => ({ default: DailyChart })))
const CategoryChart = lazy(() => import("@/components/ledger-charts").then(({ CategoryChart }) => ({ default: CategoryChart })))

const navigation = [
  { id: "overview", label: "概览", icon: LayoutDashboard },
  { id: "cash-flow", label: "年度收支", icon: ChartNoAxesColumnIncreasing },
  { id: "spending", label: "收支构成", icon: PieChart },
  { id: "ask-ledger", label: "AI 账单问答", icon: Bot },
  { id: "transactions", label: "账单明细", icon: List },
]

const seriesOptions: { value: Series; label: string }[] = [
  { value: "both", label: "全部" }, { value: "income", label: "收入" }, { value: "expense", label: "支出" },
]

type Result<T> = { query: string; refresh: number; data?: T; failed?: true }

function useLedger<T>(userId: string, query: string | null, refresh: number) {
  const [result, setResult] = useState<Result<T>>()

  useEffect(() => {
    if (!userId || query === null) return
    const controller = new AbortController()
    ledgerRequest<T>(userId, Object.fromEntries(new URLSearchParams(query)), controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setResult({ query, refresh, data })
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ query, refresh, failed: true })
      })
    return () => controller.abort()
  }, [userId, query, refresh])

  const current = result?.query === query && result.refresh === refresh ? result : undefined
  return { data: current?.data, previousData: result?.data, failed: current?.failed, loading: Boolean(userId && query !== null && !current) }
}

function LedgerNavigation({ section, enabled, onNavigate }: { section: string; enabled: boolean; onNavigate: () => void }) {
  return <>
    <a href="#overview" className="brand" onClick={onNavigate}>
      <span className="brand-mark"><Wallet size={21} strokeWidth={2.25} /></span>
      <span>My AI Accountant<span className="brand-subtitle">个人账本</span></span>
    </a>
    <nav className="navigation" aria-label="看板导航">
      <span className="navigation-heading">工作台</span>
      {navigation.filter(({ id }) => enabled || id === "overview").map(({ id, label, icon: Icon }) => (
        <a key={id} href={`#${id}`} onClick={onNavigate} className={cn("nav-link", section === id && "nav-active")} aria-current={section === id ? "location" : undefined}>
          <Icon size={19} strokeWidth={1.9} />{label}
        </a>
      ))}
    </nav>
    {enabled && <div className="sidebar-footer"><CircleHelp size={17} /><span>在 Telegram 输入 <code>/help</code> 查看记账指令</span></div>}
  </>
}

function Metric({ label, value, detail, icon: Icon, tone, children }: { label: string; value: string; detail: string; icon: LucideIcon; tone: string; children?: ReactNode }) {
  return <Card className="metric-card dashboard-card">
    <CardContent className="metric-content">
      <div className="metric-intro"><span>{label}</span><span className={cn("metric-icon", `metric-${tone}`)}><Icon size={19} strokeWidth={2} /></span></div>
      <p className="metric-value" title={value}>{value}</p>
      {children}
      <p className="metric-detail">{detail}</p>
    </CardContent>
  </Card>
}

function EmptyPanel({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return <div className="panel-empty"><Icon size={23} strokeWidth={1.65} /><p>{children}</p></div>
}

function LoadingDashboard() {
  return <div className="dashboard-content" aria-busy="true" aria-label="正在加载账本">
    <div className="metric-grid">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="loading-metric" />)}</div>
    <div className="chart-grid"><Skeleton className="loading-chart" /><Skeleton className="loading-chart" /><Skeleton className="loading-chart" /></div>
  </div>
}

export function App({ userId, askToken }: { userId: string; askToken: string }) {
  const thisMonth = currentMonth()
  const [refresh, setRefresh] = useState(0)
  const [month, setMonth] = useState(thisMonth)
  const [category, setCategory] = useState("")
  const [type, setType] = useState<TransactionType | "all">("all")
  const [sort, setSort] = useState<TransactionSort>("date")
  const [pageCursors, setPageCursors] = useState<string[]>([])
  const [series, setSeries] = useState<Series>("both")
  const [section, setSection] = useState(window.location.hash.slice(1) || "overview")
  const [menuOpen, setMenuOpen] = useState(false)
  const [dark, setDark] = useState(() => {
    const preference = localStorage.getItem("accountant-theme")
    return preference === null ? matchMedia("(prefers-color-scheme: dark)").matches : preference === "dark"
  })

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
    localStorage.setItem("accountant-theme", dark ? "dark" : "light")
  }, [dark])

  useEffect(() => {
    const update = () => setSection(window.location.hash.slice(1) || "overview")
    window.addEventListener("hashchange", update)
    return () => window.removeEventListener("hashchange", update)
  }, [])

  const available = useLedger<string[]>(userId, "view=months", refresh)
  const ledger = useLedger<Dashboard>(userId, new URLSearchParams({ view: "month", month }).toString(), refresh)
  const data = ledger.data
  const composition = [
    { id: "spending", kind: "expense", label: "支出", categories: data?.pie.filter((item) => item.value > 0) ?? [] },
    { id: "income-composition", kind: "income", label: "收入", categories: data?.incomePie?.filter((item) => item.value > 0) ?? [] },
  ] as const
  const before = pageCursors.at(-1)
  const transactions = useLedger<TransactionPage>(userId, new URLSearchParams({ view: "transactions", month, sort, ...(type !== "all" ? { type } : {}), ...(category ? { category } : {}), ...(before ? { before } : {}) }).toString(), refresh)
  const knownMonths = [thisMonth, month, ...(available.data ?? available.previousData ?? [])]
  const years = [...new Set(knownMonths.map((value) => value.slice(0, 4)))].sort().reverse()
  const latestMonth = knownMonths.reduce((latest, value) => value > latest ? value : latest, thisMonth)
  const income = data?.income ?? 0
  const expense = data?.budget.current ?? 0
  const budget = data?.budget
  const netExpense = expense - income
  const overBudget = budget ? netExpense > budget.limit : false
  const utilization = budget && budget.limit > 0 ? Math.round(100 * netExpense / budget.limit) : 0
  const budgetDetail = budget && budget.limit > 0 ? `${overBudget ? "超出" : "剩余"} ${money(Math.abs(budget.limit - netExpense))}${month === thisMonth ? "" : " · 按当前预算上限"}` : "在 Telegram 中设置预算"
  const selectCategory = (value: string) => { setCategory(value); setPageCursors([]) }
  const selectType = (value: TransactionType | "all") => { setType(value); setPageCursors([]) }
  const selectSort = (value: TransactionSort) => { setSort(value); setPageCursors([]) }
  const selectMonth = (value: string) => { setMonth(value); selectCategory("") }
  const refreshData = () => { setPageCursors([]); setRefresh((version) => version + 1) }
  const transactionPage = transactions.data
  const changePage = (cursors: string[]) => {
    setPageCursors(cursors)
    document.getElementById("transactions")?.scrollIntoView({ block: "start" })
  }

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">跳到主要内容</a>
    <aside className="desktop-sidebar"><LedgerNavigation section={section} enabled={Boolean(data)} onNavigate={() => undefined} /></aside>
    <div className="workspace">
      <header className="topbar">
        <div className="topbar-start">
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild><Button variant="ghost" size="icon" className="mobile-menu" aria-label="打开导航"><Menu size={21} /></Button></SheetTrigger>
            <SheetContent side="left" className="mobile-sidebar">
              <SheetTitle className="sr-only">看板导航</SheetTitle><SheetDescription className="sr-only">跳到摘要、图表或账单明细</SheetDescription>
              <LedgerNavigation section={section} enabled={Boolean(data)} onNavigate={() => setMenuOpen(false)} />
            </SheetContent>
          </Sheet>
          <span className="breadcrumb-home">个人账本</span><span className="breadcrumb-divider" aria-hidden="true">/</span><span className="breadcrumb-current">{navigation.find(({ id }) => id === section)?.label ?? "概览"}</span>
        </div>
        <div className="topbar-end">
          <Button variant="ghost" size="icon" onClick={() => setDark(!dark)} aria-label={dark ? "切换至浅色模式" : "切换至深色模式"} title={dark ? "浅色模式" : "深色模式"}>
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </Button>
        </div>
      </header>

      <main id="main-content" className="main-content">
        <div id="overview" className="page-heading">
          <div><h1>财务概览</h1><p>按月查看收支、预算和账单。</p></div>
          {userId && <div className="heading-actions">
            <Select value={month} onValueChange={selectMonth}>
              <SelectTrigger className="period-select" aria-label="选择年月"><CalendarDays size={15} /><SelectValue /></SelectTrigger>
              <SelectContent position="popper" align="end">
                {years.map((year) => {
                  const last = latestMonth.startsWith(year) ? Number(latestMonth.slice(5)) : 12
                  return <SelectGroup key={year}>
                    <SelectLabel>{year} 年</SelectLabel>
                    {Array.from({ length: last }, (_, index) => `${year}-${String(last - index).padStart(2, "0")}`).map((value) => (
                      <SelectItem key={value} value={value}>{monthLabel(value)}</SelectItem>
                    ))}
                  </SelectGroup>
                })}
              </SelectContent>
            </Select>
            <Button variant="outline" size="icon" onClick={refreshData} disabled={ledger.loading} aria-label="刷新账本" title="刷新账本"><RefreshCw size={16} className={ledger.loading ? "animate-spin" : ""} /></Button>
          </div>}
        </div>

        {!userId && <Card className="dashboard-card launch-card"><CardContent>
          <span className="launch-icon"><Wallet size={28} /></span>
          <h2>从 Telegram 打开你的账本</h2>
          <p>在记账机器人中发送 <code>/start</code>，然后点击消息中的看板链接。</p>
        </CardContent></Card>}
        {userId && <div className="dashboard-content">
          {ledger.loading && <LoadingDashboard />}
          {ledger.failed && <Alert variant="destructive" className="dashboard-error"><CircleAlert /><AlertTitle>账本暂时加载失败</AlertTitle><AlertDescription>请检查网络连接，或尝试刷新账本。</AlertDescription><Button variant="outline" size="sm" onClick={refreshData}>重新加载</Button></Alert>}
          {data && budget && <section className="metric-grid" aria-label="本月收支摘要">
            <Metric label="本月收入" value={money(income)} detail="收入合计 · CNY" icon={ArrowDownLeft} tone="green" />
            <Metric label="本月支出" value={money(expense)} detail="支出合计 · CNY" icon={ArrowUpRight} tone="blue" />
            <Metric label="本月结余" value={money(income - expense)} detail="收入减去支出" icon={Wallet} tone="purple" />
            <Metric label="预算进度" value={budget.limit > 0 ? `${utilization}%` : "—"} detail={budgetDetail} icon={Activity} tone={overBudget ? "red" : "amber"}>
              {budget.limit > 0 && <Progress value={Math.max(0, Math.min(utilization, 100))} className={cn("budget-progress", overBudget && "budget-over")} aria-label="本月净支出占预算比例" aria-valuetext={`${utilization}%`} />}
            </Metric>
          </section>}
          <LedgerQuestions token={askToken} month={month} />
          {data && <>
          <div className="chart-grid">
            <Card id="cash-flow" className="dashboard-card chart-card">
              <CardHeader className="panel-header">
                <div><CardTitle>年度收支</CardTitle><CardDescription>{month.slice(0, 4)} 年各月的收入与支出</CardDescription></div>
                <div className="series-buttons" role="group" aria-label="收支显示范围">
                  {seriesOptions.map(({ value, label }) => <Button key={value} type="button" size="sm" variant="ghost" className={cn("series-button", series === value && "series-selected")} onClick={() => setSeries(value)} aria-pressed={series === value}>{label}</Button>)}
                </div>
              </CardHeader>
              <CardContent className="panel-content">
                <div className="series-legend" aria-hidden="true">{series !== "expense" && <span><i className="income-dot" />收入</span>}{series !== "income" && <span><i className="expense-dot" />支出</span>}</div>
                {data.annual.length ? <Suspense fallback={<Skeleton className="cash-flow-chart" />}><CashFlowChart data={data.annual} series={series} selectedMonth={Number(month.slice(5))} /></Suspense> : <EmptyPanel icon={ChartNoAxesColumnIncreasing}>所选年度暂无收支记录</EmptyPanel>}
              </CardContent>
            </Card>

            {composition.map(({ id, kind, label, categories }) => <Card key={kind} id={id} className="dashboard-card chart-card">
              <CardHeader className="panel-header">
                <div><CardTitle>{label}构成</CardTitle><CardDescription>{monthLabel(month)} · 按分类统计</CardDescription></div>
              </CardHeader>
              <CardContent className="panel-content spending-content">
                {categories.length ? <Suspense fallback={<Skeleton className="chart-placeholder" />}><CategoryChart kind={kind} categories={categories} selected={type === kind ? category : ""} onSelect={(value) => { selectType(kind); selectCategory(value) }} /></Suspense> : <EmptyPanel icon={PieChart}>该月暂无{label}记录</EmptyPanel>}
              </CardContent>
            </Card>)}
          </div>

          <Card className="dashboard-card trend-card">
            <CardHeader className="panel-header"><div><CardTitle>支出趋势</CardTitle><CardDescription>{monthLabel(month)}每日支出 · CNY</CardDescription></div><Badge variant="secondary"><Activity size={13} />日支出</Badge></CardHeader>
            <CardContent className="panel-content">{data.line.length ? <Suspense fallback={<Skeleton className="trend-chart" />}><DailyChart data={data.line} month={month} /></Suspense> : <EmptyPanel icon={Activity}>该月暂无日支出记录</EmptyPanel>}</CardContent>
          </Card>

          <Card id="transactions" className="dashboard-card transactions-card">
            <CardHeader className="panel-header">
              <div><CardTitle>账单明细</CardTitle><CardDescription>{monthLabel(month)}{transactionPage ? ` · 共 ${transactionPage.total} 笔` : ""}</CardDescription></div>
              <div className="transaction-controls" role="group" aria-label="账单筛选与排序">
                <Select value={type} onValueChange={(value) => selectType(value === "income" || value === "expense" ? value : "all")}>
                  <SelectTrigger size="sm" aria-label="收支类型"><SelectValue /></SelectTrigger>
                  <SelectContent position="popper" align="end">
                    <SelectItem value="all">全部收支</SelectItem>
                    <SelectItem value="income">收入</SelectItem>
                    <SelectItem value="expense">支出</SelectItem>
                  </SelectContent>
                </Select>
                {data.categories.length > 0 && <Select value={category ? `category:${category}` : "all"} onValueChange={(value) => selectCategory(value === "all" ? "" : value.slice("category:".length))}>
                  <SelectTrigger size="sm" aria-label="账单分类"><SelectValue /></SelectTrigger>
                  <SelectContent position="popper" align="end">
                    <SelectItem value="all">全部分类</SelectItem>
                    {data.categories.map((value) => <SelectItem key={value} value={`category:${value}`}>{value}</SelectItem>)}
                  </SelectContent>
                </Select>}
                <Select value={sort} onValueChange={(value) => selectSort(value === "amount" || value === "date_asc" ? value : "date")}>
                  <SelectTrigger size="sm" aria-label="账单排序"><SelectValue /></SelectTrigger>
                  <SelectContent position="popper" align="end">
                    <SelectItem value="date">日期从近到远</SelectItem>
                    <SelectItem value="date_asc">日期从远到近</SelectItem>
                    <SelectItem value="amount">金额从大到小</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent className="panel-content">
              {transactions.loading ? <Skeleton className="chart-placeholder" aria-label="正在加载明细" /> : transactions.failed ? <EmptyPanel icon={CircleAlert}>账单加载失败，请刷新重试。</EmptyPanel> : transactionPage?.rows.length ? <TransactionTable rows={transactionPage.rows} /> : <EmptyPanel icon={List}>{category || type !== "all" ? "没有符合筛选条件的账单" : "该月暂无账单"}</EmptyPanel>}
              {(pageCursors.length > 0 || transactionPage?.nextCursor) && <div className="transaction-pagination" aria-label="账单分页">
                <Button type="button" size="sm" variant="outline" disabled={pageCursors.length === 0 || transactions.loading} onClick={() => changePage(pageCursors.slice(0, -1))}><ChevronLeft size={16} />上一页</Button>
                <span aria-live="polite">第 {pageCursors.length + 1} 页</span>
                <Button type="button" size="sm" variant="outline" disabled={!transactionPage?.nextCursor} onClick={() => { if (transactionPage?.nextCursor) changePage([...pageCursors, transactionPage.nextCursor]) }}>下一页<ChevronRight size={16} /></Button>
              </div>}
            </CardContent>
          </Card>
          </>}
        </div>}
      </main>
      {data && <footer className="workspace-footer"><span>My AI Accountant</span><a href="#overview">返回概览 <ArrowRight size={14} /></a></footer>}
    </div>
  </div>
}

function TransactionTable({ rows }: { rows: Transaction[] }) {
  return <Table>
    <TableHeader><TableRow><TableHead>账单</TableHead><TableHead>日期</TableHead><TableHead>类型</TableHead><TableHead className="text-right">金额</TableHead></TableRow></TableHeader>
    <TableBody>{rows.map((row) => {
      const income = row.type.toLowerCase() === "income" || row.type.includes("收入")
      return <TableRow key={row.id}>
        <TableCell className="transaction-description" title={row.description || row.category}>
          {row.description || row.category}
          {row.description && row.description !== row.category && <small className="transaction-category">{row.category}</small>}
        </TableCell>
        <TableCell className="transaction-date"><time dateTime={row.date}>{row.date}</time></TableCell>
        <TableCell><Badge variant="secondary" className={income ? "income-badge" : "expense-badge"}>{income ? "收入" : "支出"}</Badge></TableCell>
        <TableCell className={cn("transaction-amount", income && "transaction-income")}>
          {income ? "+" : "−"}{originalAmount(row.amount_original, row.currency_original)}
          {row.currency_original !== "CNY" && <small>{money(row.amount_cny)}</small>}
        </TableCell>
      </TableRow>
    })}</TableBody>
  </Table>
}
