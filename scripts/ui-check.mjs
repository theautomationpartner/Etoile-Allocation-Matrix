// UI regression check — drives the running app (npm run dev) in a real browser and fails if any of
// the layout problems found in QA comes back. Nothing is saved to monday (it only creates a local,
// unsaved shipment and never clicks Save).
//
//   npm run dev            (in another terminal)
//   npm run ui-check       (EDGE_PATH / APP_URL can override the defaults)

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP_URL = process.env.APP_URL || "http://localhost:5173/";
const EDGE = process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9400 + Math.floor(Math.random() * 400);
const WIDTHS = [1200, 1440];

const profile = mkdtempSync(join(tmpdir(), "ui-check-"));
// Background throttling off: a headless page counts as "hidden" and its timers would be delayed ~1 s.
const browser = spawn(EDGE, ["--headless=new", "--disable-gpu", "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Never hang silently: fail after 4 minutes.
const watchdog = setTimeout(() => { console.log("FAIL  ui-check timed out (4 min)"); try { browser.kill(); } catch { /* ignore */ } process.exit(1); }, 240000);

let ws, id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: `(async()=>{ ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "evaluation failed");
  return r.result?.result?.value;
};

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: Boolean(ok), detail });

async function run() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
    } catch { /* browser starting */ }
    await sleep(250);
  }
  await new Promise((r) => ws.addEventListener("open", r));
  let leaveDialogs = 0;
  ws.addEventListener("message", (m) => {
    const d = JSON.parse(m.data);
    if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    // "Leave site? Changes you made may not be saved" — expected when a local shipment is unsaved.
    if (d.method === "Page.javascriptDialogOpening") {
      if (d.params?.type === "beforeunload") leaveDialogs++;
      send("Page.handleJavaScriptDialog", { accept: true });
    }
  });
  await send("Page.enable");

  for (const [w, width] of WIDTHS.entries()) {
    const tag = `@${width}px`;
    // From the 2nd width on, navigating away leaves the previous run's unsaved shipment behind.
    if (w > 0) {
      // A real mouse click first: browsers only ask "Leave site?" after a genuine user interaction.
      const h = JSON.parse(await ev(`const r=document.querySelector(".page-h h2").getBoundingClientRect(); return JSON.stringify({x:r.left+10,y:r.top+r.height/2})`));
      for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: h.x, y: h.y, button: "left", clickCount: 1 });
      const before = leaveDialogs;
      await send("Page.navigate", { url: "about:blank" });
      await sleep(600);
      check("leaving with an unsaved shipment asks first (beforeunload)", leaveDialogs > before);
    }
    await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    // A headless window never has the system focus, so focus events would not fire; behave like a real, focused window.
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await send("Page.navigate", { url: APP_URL });
    for (let i = 0; i < 120 && !(await ev(`return !!document.querySelector("tr.g")`).catch(() => false)); i++) await sleep(500);
    if (!(await ev(`return !!document.querySelector("tr.g")`))) { check(`matrix loads ${tag}`, false, "no order rows (is the app running and are you authorized?)"); continue; }
    await ev(`document.querySelector(".mx-wrap").scrollIntoView({block:"start"})`);
    await sleep(200);

    check(`no horizontal page scroll ${tag}`, await ev(`return document.documentElement.scrollWidth <= innerWidth + 1`));
    check(`no help (?) cursor anywhere ${tag}`, await ev(`return [...document.querySelectorAll("*")].every(e => getComputedStyle(e).cursor !== "help")`));
    const head = JSON.parse(await ev(`const h=document.querySelector("th.hend"), f=document.querySelector(".mx-scroll"); const fr=f.getBoundingClientRect(), r=h.getBoundingClientRect();
      return JSON.stringify({ fits: [...h.querySelectorAll(".t,.m")].every(x => x.scrollWidth <= x.clientWidth), inside: r.right <= fr.left + f.clientWidth + 0.5 })`));
    check(`"Impossible / needs a PO" header fully readable ${tag}`, head.fits && head.inside, JSON.stringify(head));
    check(`source column headers not cut ${tag}`, await ev(`return [...document.querySelectorAll("th.hsrc .t, th.hsrc .m")].every(x => x.scrollWidth <= x.clientWidth + 1)`));
    const legendWeight = await ev(`return Math.min(...[...document.querySelectorAll(".mx-hint .sw")].map(s => +getComputedStyle(s).fontWeight))`);
    check(`legend numbers bold (≥ 700) ${tag}`, legendWeight >= 700, `weight ${legendWeight}`);

    // Open the first order that still has units to put in a shipment and create a LOCAL shipment.
    const opened = await ev(`const wait=(ms)=>new Promise(x=>setTimeout(x,ms)); const n=document.querySelectorAll("tr.g").length;
      for (let k=0; k<n; k++) { const r=document.querySelectorAll("tr.g")[k]; const wasOpen=r.classList.contains("open");
        if (!wasOpen) { r.querySelector("button.cv").click(); await wait(250); }
        const row=document.querySelectorAll("tr.g")[k]; const c=row.nextElementSibling?.querySelector(".otabs .copy");
        if (c && /·\\s*[0-9]/.test(c.textContent)) { c.click(); await wait(300); return true; }
        if (!wasOpen) { row.querySelector("button.cv").click(); await wait(200); } } return false`);
    if (!opened) { check(`a shipment can be created ${tag}`, false, "no order with remaining units"); continue; }
    let created = false;
    for (let t = 0; t < 40 && !created; t++) { await sleep(150); created = await ev(`return !!document.querySelector("tr.shc .sh-controls")`); }
    check(`a local shipment is created ${tag}`, created);
    if (!created) continue;
    await ev(`document.querySelector("tr.shc").scrollIntoView({block:"center"})`);
    await sleep(200);

    const tabs = JSON.parse(await ev(`const t=[...document.querySelectorAll(".otabs")].find(x=>x.querySelector(".copy"));
      if (!t) return JSON.stringify({ gap: -1, visible: false, diag: { otabs: document.querySelectorAll(".otabs").length, shc: document.querySelectorAll("tr.shc").length, open: [...document.querySelectorAll("tr.g.open")].map(g=>g.querySelector(".eivr")?.textContent), loading: document.querySelector(".kpi-bar .fresh")?.textContent } });
      const a=t.querySelector(".add").getBoundingClientRect(), c=t.querySelector(".copy").getBoundingClientRect(), f=document.querySelector(".mx-scroll").getBoundingClientRect();
      return JSON.stringify({ gap: Math.round(c.left - a.right), visible: c.right <= f.right })`));
    check(`"Copy remaining" right next to "+ New shipment" ${tag}`, tabs.gap >= 4 && tabs.gap <= 24 && tabs.visible, JSON.stringify(tabs));

    const ctl = JSON.parse(await ev(`const row=document.querySelector("tr.shc"); const q=(s)=>row.querySelector(s).getBoundingClientRect();
      const st=q(".shs"), grp=q(".sh-controls"), date=q(".date-btn"), save=q(".btn.save"), menu=q(".shm"), dots=row.querySelector(".shm svg").getBoundingClientRect();
      const mid=(r)=>r.top+r.height/2;
      return JSON.stringify({ gapAfterStatus: Math.round(grp.left - st.right), heights:[date.height, save.height, menu.height].map(Math.round), centres:[mid(date), mid(save), mid(menu)].map(Math.round),
        dotsOffset: [Math.abs((dots.left+dots.width/2)-(menu.left+menu.width/2)), Math.abs(mid(dots)-mid(menu))].map(v=>+v.toFixed(1)), sameLine: Math.abs(mid(st)-mid(grp)) < 6 })`));
    check(`Ship date · Save · ··· follow the status with a tidy gap ${tag}`, ctl.sameLine && ctl.gapAfterStatus >= 8 && ctl.gapAfterStatus <= 40, JSON.stringify({ gap: ctl.gapAfterStatus, sameLine: ctl.sameLine }));
    check(`controls share one height (28px) ${tag}`, ctl.heights.every((h) => Math.abs(h - 28) <= 1), JSON.stringify(ctl.heights));
    check(`controls vertically aligned ${tag}`, Math.max(...ctl.centres) - Math.min(...ctl.centres) <= 1, JSON.stringify(ctl.centres));
    check(`"···" icon centred in its button ${tag}`, ctl.dotsOffset.every((v) => v <= 1), JSON.stringify(ctl.dotsOffset));

    check(`ship date shown in English (no browser-language placeholder) ${tag}`, await ev(`const t=document.querySelector("tr.shc .date-btn").textContent; return /Set a date|[0-9]{1,2} [A-Z][a-z]{2} [0-9]{4}/.test(t) && !/aaaa|jj|mm|dd/i.test(t)`));
    check(`shipment table headers not clipped ${tag}`, await ev(`return [...document.querySelectorAll("tr.shth .nn.n4 span")].every(x => x.scrollWidth <= x.clientWidth + 1 && x.scrollHeight <= x.clientHeight + 1)`));
    check(`legend tip reads "…click Allocate." ${tag}`, await ev(`const k=document.querySelector(".mx-hint .k.tip"); const b=k.querySelector("b").getBoundingClientRect(); const r=document.createRange(); r.setStart(k.lastChild,0); r.setEnd(k.lastChild,1); return r.getBoundingClientRect().left - b.right < 2`));
    await ev(`document.querySelector("tr.shc .shm").click()`);
    await sleep(250);
    const menu = JSON.parse(await ev(`const p=document.querySelector(".mnu-p.float"); if(!p) return JSON.stringify({open:false}); const r=p.getBoundingClientRect();
      return JSON.stringify({ open:true, compact: r.width <= 260, inViewport: r.top>=0 && r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight, onTop: [...p.querySelectorAll("button")].every(b=>{const k=b.getBoundingClientRect(); return p.contains(document.elementFromPoint(k.left+k.width/2, k.top+k.height/2));}) })`));
    check(`"···" menu opens compact, fully visible and on top ${tag}`, menu.open && menu.compact && menu.inViewport && menu.onTop, JSON.stringify(menu));
    await ev(`document.body.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))`);
    await sleep(150);
    check(`menu closes on an outside click ${tag}`, await ev(`return !document.querySelector(".mnu-p.float")`));

    await ev(`document.querySelector(".shn-edit").click()`);
    let renamed = false;
    for (let t = 0; t < 10 && !renamed; t++) { await sleep(100); renamed = await ev(`const i=document.querySelector("input.shname"); return !!i && document.activeElement===i && i.selectionStart===0 && i.selectionEnd===i.value.length`); }
    check(`click on the name → editable, text selected ${tag}`, renamed, renamed ? "" : await ev(`const i=document.querySelector("input.shname"); const a=document.activeElement; return JSON.stringify({ input: !!i, active: a.tagName + "." + a.className, sel: i ? [i.selectionStart, i.selectionEnd, i.value.length] : null, edits: document.querySelectorAll(".shn-edit").length })`));
    await ev(`document.querySelector("input.shname")?.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))`);
    await ev(`document.querySelector("tr.shr .qin").focus()`);
    let qsel = false;
    for (let t = 0; t < 10 && !qsel; t++) { await sleep(80); qsel = await ev(`const i=document.querySelector("tr.shr .qin"); return document.activeElement===i && i.value.length>0 && i.selectionStart===0 && i.selectionEnd===i.value.length`).catch(() => false); }
    check(`quantity field selects its number on focus (type to replace) ${tag}`, qsel, qsel ? "" : await ev(`const i=document.querySelector("tr.shr .qin"); return JSON.stringify({ type: i.type, active: document.activeElement===i, value: i.value, sel: [i.selectionStart, i.selectionEnd] })`));
    check(`trash sits right after "Remaining to ship" ${tag}`, await ev(`return !!document.querySelector("tr.shr td.s2 .rm-slot .rmx")`));
  }
}

try {
  await run();
} catch (e) {
  check("ui-check ran", false, e.message);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  browser.kill();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ }
}

clearTimeout(watchdog);
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  → ${r.detail}`}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
