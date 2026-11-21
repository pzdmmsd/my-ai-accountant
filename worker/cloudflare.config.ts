import { bindings, defineConfig } from "cf/config"

export default defineConfig({
  worker: {
    name: "money",
    entrypoint: "./index.js",
    compatibilityDate: "2026-02-12",
    domains: ["moneydb.pzdmmsd.qzz.io"],
    workersDev: true,
    previewUrls: false,
    observability: {
      enabled: true,
      redactQueryString: true,
      logs: { enabled: true },
      traces: { enabled: true, headSamplingRate: 0.1 },
    },
    env: {
      DB: bindings.d1({ id: "440f2f9d-0316-44ba-8ce6-8fdaec47da94" }),
      NVIDIA_API_KEY: bindings.secret(),
      TG_TOKEN: bindings.secret(),
      EXCHANGE_KEY: bindings.secret(),
    },
  },
})
