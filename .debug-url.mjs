import http from "node:http";
import fs from "node:fs";

const HOST = "127.0.0.1:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsMsgId = 0;
const pending = new Map();

function send(ws, method, params) {
  const id = ++wsMsgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res) => pending.set(id, res));
}

async function connect() {
  const { spawn } = await import("node:child_process");
  const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
  const proc = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9333", `--user-data-dir=${process.cwd()}/.dbg-profile2`, "--no-first-run", "about:blank"], { stdio: "ignore" });
  let target = null;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch("http://127.0.0.1:9333/json/list");
      const list = await r.json();
      target = list.find((t) => t.type === "page");
      if (target) break;
    } catch {}
    await sleep(500);
  }
  if (!target) throw new Error("no CDP target");
  return { proc, wsUrl: target.webSocketDebuggerUrl };
}

const { proc, wsUrl } = await connect();
const ws = new WebSocket(wsUrl);
await new Promise((res) => (ws.onopen = res));
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const res = pending.get(msg.id);
    pending.delete(msg.id);
    res(msg);
  } else if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type)) {
    console.log(`[console.${msg.params.type}]`, msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
  } else if (msg.method === "Runtime.exceptionThrown") {
    console.log("[exception]", msg.params.exceptionDetails?.exception?.description?.slice(0, 300) ?? JSON.stringify(msg.params.exceptionDetails).slice(0, 200));
  } else if (msg.method === "Log.entryAdded") {
    console.log(`[log.${msg.params.entry.level}]`, msg.params.entry.text?.slice(0, 200));
  } else if (msg.method === "Network.responseReceived") {
    const { url, status } = msg.params.response;
    if (status >= 400) console.log(`[http ${status}]`, url.slice(0, 120));
  }
};
await send(ws, "Runtime.enable");
await send(ws, "Page.enable");
await send(ws, "Network.enable");
await send(ws, "Log.enable");

async function nav(url) {
  await send(ws, "Page.navigate", { url: `http://${HOST}${url}` });
  await sleep(6000);
}
async function evalJs(expr) {
  const r = await send(ws, "Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
}

// Login — exactly the harness flow: /products → redirected to /login →
// Input.insertText (trusted events; React ignores programmatic .value).
async function navHarness(path) {
  await send(ws, "Page.navigate", { url: `http://localhost:3000${path}` });
  await sleep(6000);
}
await navHarness("/products");
if ((await evalJs("location.pathname"))?.startsWith("/login")) {
  await navHarness("/login");
  await evalJs(`(() => { const e = document.querySelector('input[type=email]'); e.focus(); e.value = ''; })()`);
  await send(ws, "Input.insertText", { text: "admin@elitepos.com" });
  await evalJs(`(() => { const p = document.querySelector('input[type=password]'); p.focus(); p.value = ''; })()`);
  await send(ws, "Input.insertText", { text: "Admin@123" });
  await evalJs(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => (b.innerText || '').trim().toLowerCase().includes('sign in'));
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(8000);
}
console.log("logged in, pathname:", await evalJs("location.pathname"));

console.log("--- warm /products plain ---");
await navHarness("/products");
await sleep(2000);
console.log("cards:", await evalJs("document.querySelectorAll('.product-card').length"), "| rows:", await evalJs("document.querySelectorAll('tbody input[type=checkbox]').length"));

console.log("--- THE FAILING NAV: /products?view=grid&status=active ---");
await navHarness("/products?view=grid&status=active");
await sleep(3000);
console.log("url:", await evalJs("location.search"));
console.log("cards:", await evalJs("document.querySelectorAll('.product-card').length"));
console.log("rows:", await evalJs("document.querySelectorAll('tbody input[type=checkbox]').length"));
console.log("segmented buttons:", await evalJs("document.querySelectorAll('.pos-segmented button').length"));
console.log("body has error boundary:", await evalJs("!!document.querySelector('[data-nextjs-error], nextjs-portal')"));

console.log("--- toggle back to table ---");
await evalJs(`(() => { const b = document.querySelectorAll('.pos-segmented button')[0]; if (b) b.click(); return true; })()`);
await sleep(1500);
console.log("url after toggle:", await evalJs("location.search"));
console.log("cards after toggle:", await evalJs("document.querySelectorAll('.product-card').length"));

proc.kill();
process.exit(0);
