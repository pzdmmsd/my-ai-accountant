const dashboardOrigin = "https://money.pzdmmsd.qzz.io";
const lifetimeSeconds = 7 * 24 * 60 * 60;
const encoder = new TextEncoder();

function signingKey(secret, usage) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

function signedMessage(id, expiry) {
  return encoder.encode(`my-ai-accountant:ask:v1:${id}:${expiry}`);
}

export async function dashboardLink(id, secret, now = Date.now()) {
  const url = new URL(dashboardOrigin);
  url.searchParams.set("user_id", id);
  const expiry = Math.floor(now / 1000) + lifetimeSeconds;
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(secret, "sign"), signedMessage(id, expiry)));
  const encoded = btoa(String.fromCharCode(...signature)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  url.hash = `ask=${id}.${expiry}.${encoded}`;
  return url.href;
}

export async function dashboardAccount(header, secret, now = Date.now()) {
  if (!secret || !header) return null;
  const match = /^Bearer (-?\d{1,16})\.(\d{1,11})\.([A-Za-z0-9_-]{43})$/.exec(header);
  if (!match) return null;
  const [, id, expiry, signature] = match;
  const current = Math.floor(now / 1000);
  if (Number(expiry) <= current || Number(expiry) > current + lifetimeSeconds) return null;
  const bytes = Uint8Array.from(atob(signature.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
  const verified = await crypto.subtle.verify("HMAC", await signingKey(secret, "verify"), bytes, signedMessage(id, expiry));
  return verified ? id : null;
}
