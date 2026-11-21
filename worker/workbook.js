import { read, SSF, utils } from "xlsx";
import { utils as codepage } from "xlsx/dist/cpexcel";

export const maxWorkbookEntries = 200;
const headerRows = 60;
const scanRows = maxWorkbookEntries + headerRows + 25;
const aliases = {
  date: ["日期", "交易日期", "交易时间", "记账日期", "入账日期", "时间", "date", "transactiondate", "datetime", "posteddate"],
  amount: ["金额", "金额(元)", "交易金额", "交易金额(元)", "原币金额", "收支金额", "amount", "transactionamount", "originalamount"],
  type: ["收/支", "收支方向", "收支类型", "收支", "类型", "direction", "type", "交易类型", "transactiontype"],
  expense: ["支出", "支出金额", "借方", "借方金额", "expense", "debit", "debitamount"],
  income: ["收入", "收入金额", "贷方", "贷方金额", "income", "credit", "creditamount"],
  currency: ["币种", "原币币种", "货币", "交易币种", "currency", "currencycode"],
  description: ["备注", "描述", "摘要", "商户", "商户名称", "交易对方", "description", "merchant", "memo", "note", "notes"],
  category: ["分类", "交易分类", "类别", "category", "交易类型"],
  merchant: ["交易对方", "商户名称", "商户"],
  product: ["商品说明", "商品名称", "商品"],
  status: ["当前状态", "交易状态"],
};

export class ImportError extends Error {}

function headerColumns(row) {
  const headers = row.map((cell) => String(cell ?? "").normalize("NFKC").trim().toLowerCase().replace(/[\s_-]+/g, ""));
  const columns = Object.fromEntries(Object.entries(aliases).map(([key, names]) => [key, names.map((name) => headers.indexOf(name)).find((index) => index >= 0) ?? -1]));
  columns.paymentExport = headers.includes("收/支") && columns.status >= 0 && columns.merchant >= 0;
  return columns.date >= 0 && [columns.amount, columns.expense, columns.income].some((index) => index >= 0) ? columns : null;
}

function transactionDate(value, date1904) {
  if (typeof value === "number") {
    const result = SSF.parse_date_code(value, { date1904 });
    if (!result) return null;
    value = `${result.y}-${result.m}-${result.d}`;
  }
  const parts = String(value ?? "").trim().match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?=$|[\sT日])/);
  if (!parts) return null;
  const date = `${parts[1]}-${parts[2].padStart(2, "0")}-${parts[3].padStart(2, "0")}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}

function amountValue(value, allowYuan = false) {
  const text = String(value ?? "").normalize("NFKC").trim();
  if (!text || text === "-" || text === "—") return 0;
  const numeric = allowYuan ? text.replace(/^¥\s*/, "").replace(/\s*元$/, "") : text;
  const cleaned = numeric.replace(/^\((.*)\)$/, "-$1");
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(cleaned)) return NaN;
  return Number(cleaned.replace(/,/g, ""));
}

function typeFrom(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (["收入", "入账", "贷方", "退款", "income", "credit", "refund"].includes(text)) return "income";
  if (["支出", "消费", "付款", "借方", "expense", "debit", "payment"].includes(text)) return "expense";
  return null;
}

function validateWorkbookZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const invalid = () => new ImportError("无法打开这个 Excel 文件，请重新另存为 XLSX 后发送。");
  let end = view.byteLength - 22;
  const first = Math.max(0, end - 65535);
  while (end >= first && (view.getUint32(end, true) !== 0x06054b50 || end + 22 + view.getUint16(end + 20, true) !== view.byteLength)) end--;
  if (end < first) throw invalid();
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  if (count > 256 || offset + size !== end) throw invalid();
  let unpacked = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw invalid();
    unpacked += view.getUint32(offset + 24, true);
    if (unpacked > 24 * 1024 * 1024) throw new ImportError("Excel 文件解压后过大，请删去无关工作表和图片后重试。");
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  if (offset !== end) throw invalid();
}

function decodeCsv(bytes) {
  if (bytes.includes(0)) throw new ImportError("无法读取 CSV，请用 Excel 另存为 UTF-8 CSV 后重试。");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return codepage.decode(936, bytes); }
}

function completedPayment(status) {
  return /^(?:支付成功|交易成功|交易完成|收款成功|转账成功|已支付|已完成|已转账|已存入零钱|提现成功|充值成功|已到账|已全额领取|(?:对方|朋友)?已(?:收钱|收款|领取))$/.test(String(status ?? "").trim());
}

export function readStatement(bytes) {
  const zipped = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
  const legacy = bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  const csv = !zipped && !legacy;
  if (zipped) validateWorkbookZip(bytes);
  let workbook;
  try {
    const data = csv ? decodeCsv(bytes) : bytes;
    workbook = read(data, { type: csv ? "string" : "array", ...(csv ? { FS: ",", raw: true } : {}), sheetRows: scanRows, cellFormula: false, cellHTML: false, cellStyles: false, cellText: false });
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError("无法打开账单文件，请确认已解压且文件完整。");
  }
  const entries = [];
  let skipped = 0;
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet["!ref"]) continue;
    if (utils.decode_range(sheet["!ref"]).e.c > 99) throw new ImportError("Excel 工作表最多支持 100 列。请保留流水字段后重试。");
    const rows = utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
    const headerIndex = rows.slice(0, headerRows).findIndex(headerColumns);
    if (headerIndex === -1) continue;
    if (sheet["!fullref"] && utils.decode_range(sheet["!fullref"]).e.r > utils.decode_range(sheet["!ref"]).e.r) {
      throw new ImportError(`每个文件最多导入 ${maxWorkbookEntries} 笔，请把流水拆成较小的文件。`);
    }
    const columns = headerColumns(rows[headerIndex]);
    const data = rows.slice(headerIndex + 1);
    const signed = columns.amount >= 0 && data.some((row) => amountValue(row[columns.amount]) < 0);
    const rowOffset = utils.decode_range(sheet["!ref"]).s.r + headerIndex + 2;
    for (const [index, row] of data.entries()) {
      if (row.every((cell) => cell == null || String(cell).trim() === "")) continue;
      if ([row[columns.date], row[columns.description]].some((cell) => /^(合计|总计|小计|期初余额|期末余额|subtotal|grand total|total)[:：]?$/i.test(String(cell ?? "").trim()))) continue;
      const direction = row[columns.type];
      if (columns.paymentExport) {
        const status = String(row[columns.status] ?? "").trim();
        if (!direction && !status && !row[columns.amount]) continue;
        if (/^(?:不计收支|不计入收支|收支不计|\/|-)$/i.test(String(direction ?? "").trim()) || !completedPayment(status)) {
          skipped++;
          continue;
        }
      }
      const date = transactionDate(row[columns.date], workbook.Workbook?.WBProps?.date1904);
      const debit = amountValue(row[columns.expense]);
      const credit = amountValue(row[columns.income]);
      const sideColumns = columns.expense >= 0 || columns.income >= 0;
      const currency = String(row[columns.currency] || "CNY").trim().toUpperCase();
      const rawAmount = sideColumns ? (debit || credit) : amountValue(row[columns.amount], columns.paymentExport && currency === "CNY");
      const type = sideColumns ? (debit ? "expense" : "income") : typeFrom(direction) ?? (direction ? null : rawAmount < 0 ? "expense" : signed ? "income" : null);
      if (!date || !Number.isFinite(rawAmount) || rawAmount === 0 || !type || !/^[A-Z]{3}$/.test(currency) || (sideColumns && ((!Number.isFinite(debit) || !Number.isFinite(credit)) || (debit && credit)))) {
        throw new ImportError(`工作表「${name.slice(0, 30)}」第 ${rowOffset + index} 行有无法识别的日期、金额、收支类型或币种。请使用 YYYY-MM-DD 日期和 CNY、HKD 等币种代码。`);
      }
      const parts = (columns.paymentExport ? [row[columns.merchant], row[columns.product], row[columns.description]] : [row[columns.description]])
        .map((part) => String(part ?? "").trim()).filter((part) => part && !/^(?:\/|-|--)$/.test(part));
      entries.push({ date, amount: Math.abs(rawAmount), type, currency, category: String(row[columns.category] || "其他").trim().slice(0, 30) || "其他", description: [...new Set(parts)].join(" · ").slice(0, 140) });
      if (entries.length > maxWorkbookEntries) throw new ImportError(`每个文件最多导入 ${maxWorkbookEntries} 笔。`);
    }
  }
  if (!entries.length && !skipped) throw new ImportError("未找到流水。请发送解压后的微信或支付宝账单，或使用「日期、金额、收支类型、币种、备注」表头。");
  return { items: entries, skipped };
}
