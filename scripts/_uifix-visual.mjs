/* TEMPORARY — verify the theme menu and collapsed-rail fixes visually. */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const CHROME = process.env.CHROME_PATH || {
  win32: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
}[process.platform] || "/usr/bin/google-chrome";
const PORT = 9362;
const PROFILE = tmpdir() + "/uifix-profile";
const BASE = process.env.BASE_URL || "http://localhost:3399";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu",
  "--window-size=1440,1000", "about:blank",
], { stdio: "ignore" });

let ws, msgId = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++msgId; pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("timeout " + method)); } }, 40000);
  });
}
async function evalJs(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? ""));
  return r.result?.value;
}
async function waitFor(expression, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await evalJs(expression)) return true; } catch {}
    await sleep(300);
  }
  return false;
}
async function shot(p) { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(p, Buffer.from(r.data, "base64")); }

(async () => {
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" }); if (r.ok) target = await r.json(); } catch {}
    if (!target) await sleep(500);
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  };
  await send("Page.enable"); await send("Runtime.enable");

  // Login through the real form (the path verify-ui proves works).
  await send("Page.navigate", { url: BASE + "/login" });
  const hydrated = await waitFor(`(() => {
    const f = document.querySelectorAll('input[type=email], input[type=password]');
    return f.length >= 2 && [...f].every((el) => Object.keys(el).some((k) => k.startsWith('__reactFiber$')));
  })()`, 40000);
  if (!hydrated) throw new Error("login form never hydrated");
  const fill = (sel, value) => evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  })()`);
  await fill("input[type=email]", "admin@elitepos.com");
  await fill("input[type=password]", "Admin@123");
  await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /sign in|log in/i.test(x.textContent || '')); if (b) b.click(); return !!b; })()`);
  const moved = await waitFor(`!location.pathname.startsWith('/login')`, 60000);
  const login = moved ? "ok" : "failed";
  console.log("LOGIN", login);
  if (!moved) throw new Error("login failed");

  // ── Check 1: theme menu labels + icon ──
  await send("Page.navigate", { url: BASE + "/dashboard" });
  await waitFor(`!!document.querySelector('header')`);
  await sleep(1200);
  await evalJs(`(() => {
    const btn = [...document.querySelectorAll('header button')].find((b) => (b.getAttribute('aria-label') || '').includes('(') && b.querySelector('svg'));
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(600);
  const menu = await evalJs(`(() => {
    const items = [...document.querySelectorAll('[role="menuitemradio"]')];
    return items.map((i) => ({
      label: i.textContent.trim(),
      svgPaths: i.querySelectorAll('svg path').length,
      key: i.textContent.includes('Golden') || i.textContent.includes('گولڈن') ? 'golden-ok' : i.textContent.trim(),
    }));
  })()`);
  console.log("THEME MENU", JSON.stringify(menu, null, 1));
  await shot(tmpdir() + "/uifix-thememenu.png");

  // Golden still applies end-to-end from this menu.
  await evalJs(`(() => { const g = [...document.querySelectorAll('[role="menuitemradio"]')].find((i) => i.textContent.includes('Golden')); if (g) g.click(); return !!g; })()`);
  await sleep(1200);
  const golden = await evalJs(`(() => ({
    golden: document.documentElement.classList.contains('golden'),
    body: getComputedStyle(document.body).backgroundColor,
    grain: (() => { const g = document.querySelector('.golden-grains'); return g ? getComputedStyle(g).opacity : 'absent'; })(),
  }))()`);
  console.log("GOLDEN APPLIED", JSON.stringify(golden));

  // ── Check 2: collapsed rail New Sale button ──
  await evalJs(`(() => {
    const t = [...document.querySelectorAll('aside button')].find((b) => (b.getAttribute('aria-label') || '') === 'Collapse sidebar' || /collapse/i.test(b.getAttribute('aria-label') || ''));
    if (t) t.click();
    return !!t;
  })()`);
  await sleep(1200);
  const collapsed = await evalJs(`(() => {
    const link = [...document.querySelectorAll('aside a')].find((a) => a.getAttribute('href') === '/pos');
    if (!link) return { found: false };
    const rect = link.getBoundingClientRect();
    const label = [...link.querySelectorAll('span')].filter((s) => !s.querySelector('svg')).map((s) => ({ text: s.textContent.trim(), visible: s.getBoundingClientRect().width > 0 && s.textContent.trim().length > 0 }));
    const svg = link.querySelector('svg');
    const svgRect = svg ? svg.getBoundingClientRect() : null;
    return {
      found: true,
      linkWidth: Math.round(rect.width),
      labelHidden: label.every((l) => l.text === '' || !l.visible),
      iconVisible: !!svgRect && svgRect.width > 0 && svgRect.width < 30,
      iconCentered: svgRect ? Math.abs((svgRect.left + svgRect.width / 2) - (rect.left + rect.width / 2)) < 6 : null,
      overflow: link.scrollWidth <= link.clientWidth + 1,
    };
  })()`);
  console.log("COLLAPSED NEW SALE", JSON.stringify(collapsed));
  await shot(tmpdir() + "/uifix-collapsed.png");

  // And it still navigates.
  await evalJs(`(() => { const l = [...document.querySelectorAll('aside a')].find((a) => a.getAttribute('href') === '/pos'); if (l) l.click(); return !!l; })()`);
  await waitFor(`location.pathname === '/pos'`, 20000);
  console.log("NAVIGATES TO /pos", await evalJs("location.pathname"));

  console.log("SHOTS:", tmpdir());
  chrome.kill("SIGTERM");
  process.exit(0);
})().catch((e) => { console.error("ERR", e.message); try { chrome.kill("SIGKILL"); } catch {} process.exit(1); });
