import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "@fontsource-variable/inter"
import "./index.css"
import { App } from "./app"

const url = new URL(window.location.href)
const userId = url.searchParams.get("user_id")?.trim() || ""
const storageKey = `accountant-ask:${userId}`
const fragment = new URLSearchParams(url.hash.slice(1)).get("ask")
let askToken = fragment && fragment.startsWith(`${userId}.`) ? fragment : ""
if (fragment !== null) {
  history.replaceState(null, "", `${url.pathname}${url.search}`)
}
try {
  if (askToken) sessionStorage.setItem(storageKey, askToken)
  else if (userId) askToken = sessionStorage.getItem(storageKey) ?? ""
} catch {
  // Opening a signed link still works when storage is unavailable.
}

createRoot(document.getElementById("root")!).render(<StrictMode><App userId={userId} askToken={askToken} /></StrictMode>)
