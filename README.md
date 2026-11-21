# My AI Accountant

用 Telegram 发送文字或账单照片记账。Cloudflare Worker 调用 NVIDIA NIM 上的 Kimi K3.1 Pro 提取收支并写入 D1。Telegram 返回的链接可打开财务看板。

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

## 部署

- Cloudflare Pages 项目 `my-ai-accountant` 从 `main` 构建仓库根目录，构建命令为 `npm run build`，产物目录为 `dist`。拉取请求可在 Pages 预览页面查看改动。
- Cloudflare Worker `money` 使用 `worker/cloudflare.config.ts`。在 `worker/` 运行 `npm ci`、`npm test` 和 `npm run deploy` 可通过 cf CLI 部署。Cloudflare Workers Builds 应使用 `worker` 作为根目录，运行 `npm test` 后执行 `npm run deploy`。
- `NVIDIA_API_KEY`、`TG_TOKEN` 和 `EXCHANGE_KEY` 通过 Worker Secrets 提供。D1 使用配置中的现有 `DB` 绑定。
