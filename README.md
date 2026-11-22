# My AI Accountant

用 Telegram 发送文字、账单照片或 Excel 流水记账。Worker 将请求交给 `money-accounting` 队列，通过 NVIDIA NIM 的 Nemotron 3.5 Super VL 识别文字和账单图片。Excel 直接读取单元格。收支写入 D1 后，可用 Telegram 返回的链接打开财务看板。

## 导入文件

- 图片支持 Telegram 相册发送和文件附件，格式为 JPG、PNG 或 WebP，每张最多 5 MB。
- 微信支付和支付宝账单可解压后直接发送。支持 `.xlsx`、`.xls`、`.csv`，CSV 可用 UTF-8 或 GBK。系统会读取原始表头、交易方向和状态，只将明确完成且计入收支的行写入账本。退款、关闭、待支付和其他未确认状态会计入略过笔数。
- 每个流水文件最多 2 MB、1000 笔。通用 Excel 使用「日期、金额、收支类型、币种、备注」或分别提供「收入」「支出」两列。日期可用 Excel 日期单元格或 `YYYY-MM-DD`。币种可用 `CNY`、`HKD` 等三字母代码，空白按 CNY 处理。方向列可用「收入」或「支出」。常见英文表头也可识别。表内存在负金额且未填写方向时，负数记为支出、正数记为收入。

| 位置 | 用途 |
| --- | --- |
| `src/` | React、Vite 和 shadcn/ui 财务看板 |
| `worker/` | `money` Worker、NVIDIA NIM 接入和 Cloudflare 配置 |

## 开发

使用 `.node-version` 中的 Node.js 版本。在仓库根目录运行以下命令。

```sh
npm ci
npm run dev
npm run build
npm ci --prefix worker
npm test --prefix worker
npm run build --prefix worker
```

网页使用 Telegram 链接中的 `user_id`。本地开发时可用 `VITE_API_BASE_URL` 指向测试接口。

在 Telegram 发送 `/start` 并使用新链接打开看板即可使用 AI 账单问答。问答默认用所选月份，也支持在问题中指定日期范围。Worker 仅从链接对应的账本读取数据，并将问题和本次查询所需的结果交给 NVIDIA NIM。链接的问答权限有效期为 7 天。

## 部署

- Cloudflare Pages 项目 `my-ai-accountant` 从 `main` 构建仓库根目录，构建命令为 `npm run build`，产物目录为 `dist`。拉取请求可在 Pages 预览页面查看改动。
- Cloudflare Worker `money` 使用 `worker/cloudflare.config.ts`。在 `worker/` 运行 `npm ci`、`npm test` 和 `npm run deploy` 可通过 cf CLI 部署。Cloudflare Workers Builds 应使用 `worker` 作为根目录，运行 `npm test` 后执行 `npm run deploy`。
- `NVIDIA_API_KEY`、`TG_TOKEN` 和 `EXCHANGE_KEY` 通过 Worker Secrets 提供。D1 使用配置中的现有 `DB` 绑定。
- 新环境需要先创建 `money-accounting` 队列，并在 D1 上应用 `worker/migrations/0001_accounting_updates.sql`。
