import { Cell, Pie, PieChart, Bar, BarChart, Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from "recharts"
import { cn } from "@/lib/utils"
import { compactAmount, money, type Category, type DailyExpense, type YearMonth } from "@/lib/ledger"

export type Series = "both" | "income" | "expense"

const expenseColors = ["#3159e9", "#7160df", "#0b9e90", "#e89d35", "#6689d9", "#d27797", "#8291ad"]
const incomeColors = ["#0b9e90", "#6689d9", "#7160df", "#e89d35", "#3159e9", "#d27797", "#8291ad"]

const axisProps = { axisLine: false, tickLine: false, tick: { fill: "var(--muted-foreground)", fontSize: 11 } }
const tooltipStyle = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--foreground)", boxShadow: "0 6px 22px #12214214", fontSize: 13 }

export function CashFlowChart({ data, series, selectedMonth }: { data: YearMonth[]; series: Series; selectedMonth: number }) {
  const months = Array.from({ length: 12 }, (_, index) => {
    const month = index + 1
    const row = data.find((item) => Number(item.month) === month)
    return { name: `${month}月`, income: row?.inc ?? 0, expense: row?.exp ?? 0 }
  })

  return <div className="chart-surface cash-flow-chart" role="img" aria-label="一月至十二月的收入与支出柱状图">
    <ResponsiveContainer width="100%" height="100%" minWidth={0}>
      <BarChart data={months} margin={{ top: 8, right: 4, left: 0, bottom: 0 }} barGap={4}>
        <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="3 4" />
        <XAxis {...axisProps} dataKey="name" tickMargin={10} interval="preserveStartEnd" minTickGap={8} />
        <YAxis {...axisProps} width={45} tickCount={5} tickFormatter={compactAmount} allowDecimals={false} />
        <Tooltip cursor={{ fill: "var(--muted)" }} formatter={(value: number) => money(value)} contentStyle={tooltipStyle} />
        {series !== "expense" && <Bar dataKey="income" name="收入" fill="var(--color-income)" radius={[5, 5, 0, 0]} maxBarSize={25} isAnimationActive={false}>
          {months.map(({ name }, index) => <Cell key={name} fillOpacity={index + 1 === selectedMonth ? 1 : 0.55} />)}
        </Bar>}
        {series !== "income" && <Bar dataKey="expense" name="支出" fill="var(--primary)" radius={[5, 5, 0, 0]} maxBarSize={25} isAnimationActive={false}>
          {months.map(({ name }, index) => <Cell key={name} fillOpacity={index + 1 === selectedMonth ? 1 : 0.55} />)}
        </Bar>}
      </BarChart>
    </ResponsiveContainer>
  </div>
}

export function CategoryChart({ kind, categories, selected, onSelect }: { kind: "income" | "expense"; categories: Category[]; selected: string; onSelect: (name: string) => void }) {
  const total = categories.reduce((sum, category) => sum + category.value, 0)
  const label = kind === "income" ? "收入" : "支出"
  const colors = kind === "income" ? incomeColors : expenseColors

  return <>
    <div className="donut-wrap">
      <div className="donut-chart" role="img" aria-label={`${label}构成，总${label} ${money(total)}`}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <PieChart>
            <Pie data={categories} dataKey="value" nameKey="category" innerRadius="73%" outerRadius="97%" paddingAngle={3} stroke="none" startAngle={90} endAngle={-270} isAnimationActive={false} onClick={(_, index) => onSelect(categories[index].category)}>
              {categories.map((item, index) => <Cell key={item.category} fill={colors[index % colors.length]} className="cursor-pointer outline-none" />)}
            </Pie>
            <Tooltip<number, string> content={(props) => <CategoryTooltip {...props} total={total} />} wrapperStyle={{ zIndex: 2, maxWidth: "100%" }} isAnimationActive={false} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="donut-center" aria-hidden="true"><span>总{label}</span><strong title={money(total)}>{money(total)}</strong></div>
    </div>
    <ul className="category-legend" aria-label={`按分类查看${label}`}>
      {categories.map((item, index) => (
        <li key={item.category}>
          <button type="button" className={cn("category-row", selected === item.category && "is-selected")} onClick={() => onSelect(item.category)} aria-pressed={selected === item.category}>
            <span className="category-name"><i style={{ backgroundColor: colors[index % colors.length] }} />{item.category}</span>
            <span className="category-value">{money(item.value)}</span>
            <span className="category-percent">{Math.round((item.value / total) * 100)}%</span>
          </button>
        </li>
      ))}
    </ul>
  </>
}

function CategoryTooltip({ active, payload, total }: Pick<TooltipProps<number, string>, "active" | "payload"> & { total: number }) {
  const entry = payload?.[0]
  if (!active || typeof entry?.value !== "number") return null

  return <div className="expense-tooltip" role="tooltip">
    <div className="expense-tooltip-name">{entry.name}</div>
    <div className="expense-tooltip-value"><strong>{money(entry.value)}</strong><span>{Math.round(entry.value / total * 100)}%</span></div>
  </div>
}

export function DailyChart({ data, month }: { data: DailyExpense[]; month: string }) {
  const values = new Map(data.map(({ date, value }) => [date, value]))
  const last = new Date(`${month}-01T00:00:00Z`)
  last.setUTCMonth(last.getUTCMonth() + 1, 0)
  const dates = Array.from({ length: last.getUTCDate() }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, "0")}`
    return { date, value: values.get(date) ?? 0 }
  })
  return <div className="chart-surface trend-chart" role="img" aria-label="每日支出折线图">
    <ResponsiveContainer width="100%" height="100%" minWidth={0}>
      <AreaChart data={dates} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs><linearGradient id="expenses-background" x1="0" x2="0" y1="0" y2="1"><stop offset="5%" stopColor="var(--primary)" stopOpacity={0.18} /><stop offset="95%" stopColor="var(--primary)" stopOpacity={0.02} /></linearGradient></defs>
        <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="3 4" />
        <XAxis {...axisProps} dataKey="date" minTickGap={24} tickMargin={10} tickFormatter={(date: string) => date.slice(5)} />
        <YAxis {...axisProps} width={45} tickFormatter={compactAmount} allowDecimals={false} />
        <Tooltip formatter={(value: number) => money(value)} contentStyle={tooltipStyle} />
        <Area type="monotone" dataKey="value" name="支出" stroke="var(--primary)" strokeWidth={2.5} fill="url(#expenses-background)" dot={false} activeDot={{ r: 5 }} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  </div>
}
