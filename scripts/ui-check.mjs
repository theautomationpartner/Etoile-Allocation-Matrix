// UI regression check — drives the running app (npm run dev) in a real browser and fails if any of
// the layout problems found in QA comes back. Nothing is saved to monday (it only creates a local,
// unsaved shipment and never clicks Save; it opens the allocation editor and never clicks Allocate;
// on Users & access it opens dialogs and always cancels).
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
    check(`column resize handles have no tooltip ${tag}`, await ev(`const h=document.querySelectorAll(".col-rs"); return h.length > 0 && [...h].every(x => !x.dataset.tip && !x.title)`));
    check(`no help (?) cursor anywhere ${tag}`, await ev(`return [...document.querySelectorAll("*")].every(e => getComputedStyle(e).cursor !== "help")`));
    const head = JSON.parse(await ev(`const h=document.querySelector("th.hend"), f=document.querySelector(".mx-scroll"); const fr=f.getBoundingClientRect(), r=h.getBoundingClientRect();
      return JSON.stringify({ fits: [...h.querySelectorAll(".t,.m")].every(x => x.scrollWidth <= x.clientWidth), inside: r.right <= fr.left + f.clientWidth + 0.5 })`));
    check(`"Impossible / needs a PO" header fully readable ${tag}`, head.fits && head.inside, JSON.stringify(head));
    check(`source column headers not cut ${tag}`, await ev(`return [...document.querySelectorAll("th.hsrc .t, th.hsrc .m")].every(x => x.scrollWidth <= x.clientWidth + 1)`));
    const legendWeight = await ev(`return Math.min(...[...document.querySelectorAll(".mx-hint .sw")].map(s => +getComputedStyle(s).fontWeight))`);
    check(`legend numbers bold (≥ 700) ${tag}`, legendWeight >= 700, `weight ${legendWeight}`);

    check(`no cell shows more than its source has (X ≤ Y in X/Y) ${tag}`, await ev(`return [...document.querySelectorAll("tr.rw td.cl.a.it button")].every(b => { const p=b.textContent.split(",").join("").split(String.fromCharCode(47)); return p.length < 2 || parseInt(p[0],10) <= parseInt(p[1],10); })`));
    check(`Ordered · Fulfilled · To ship · Allocated · Left, readable ${tag}`, await ev(`const h=[...document.querySelectorAll("th.s2 .hn span")]; return h.map(s=>s.textContent).join("|")==="Ordered|Fulfilled|To ship|Allocated|Left" && h.every(s=>s.scrollWidth<=s.clientWidth+1) && [...document.querySelectorAll("tr.rw .s2 .nn")].every(n=>n.children.length===5)`));
    check(`rows show only the product name, no red notices ${tag}`, await ev(`return !document.querySelector("tr.rw .rh .m.warn, tr.g .gh .m .warn") && ![...document.querySelectorAll(".mx-foot span")].some(s => /no longer active/.test(s.textContent))`));
    // Review (2026-10-07): closed by default with its count; opened it lists the cases; Release is never clicked.
    const rv = JSON.parse(await ev(`const wait=(ms)=>new Promise(x=>setTimeout(x,ms)); const s=document.querySelector("section.rv"); if(!s) return JSON.stringify({panel:false});
      const res={ panel:true, closed: !s.querySelector(".rv-b"), count: +s.querySelector(".rv-n").textContent };
      s.querySelector(".rv-h").click(); await wait(200);
      const items=[...s.querySelectorAll(".rv-i")];
      res.items=items.length; res.release=s.querySelectorAll(".rv-i .btn").length;
      res.releaseLabels=[...s.querySelectorAll(".rv-i .btn")].every(b=>/^Release [0-9,]+$/.test(b.textContent));
      res.inside = items.every(i=>i.getBoundingClientRect().right <= s.getBoundingClientRect().right + 1);
      res.noScroll = document.documentElement.scrollWidth <= innerWidth + 1;
      s.querySelector(".rv-h").click(); await wait(150); res.closesAgain = !s.querySelector(".rv-b");
      return JSON.stringify(res)`));
    check(`"Needs review" is closed by default and shows its count ${tag}`, rv.panel && rv.closed && Number.isFinite(rv.count), JSON.stringify(rv));
    check(`"Needs review" lists every case; only "Release N" buttons ${tag}`, rv.items === rv.count && rv.releaseLabels && rv.inside && rv.noScroll && rv.closesAgain, JSON.stringify(rv));
    // Step 3 — allocation editor (opened and closed, never Allocate) and side panel.
    const ed = JSON.parse(await ev(`const wait=(ms)=>new Promise(x=>setTimeout(x,ms)); const p=document.querySelector("tr.rw .pill"); if(!p) return JSON.stringify({pill:false});
      p.click(); await wait(250); const e=document.querySelector("tr.ed .ap");
      const res={ pill:true, open: !!e && p.closest("tr").classList.contains("editing") && e.closest("tr").previousElementSibling===p.closest("tr"),
        parts: !!e && [".ap-t b",".ap-t i",".ap-rows .apr input",".ap-sum",".ap-note"].every(s=>e.querySelector(s)), focused: document.activeElement?.matches?.(".apr input") };
      p.click(); await wait(250); res.toggles = !document.querySelector("tr.ed");
      const c=document.querySelector("tr.rw td.cl.a button, tr.rw td.cl.dr button"); if(c){ c.click(); await wait(250); res.cell = !!document.querySelector("tr.ed"); }
      return JSON.stringify(res)`));
    check(`a Left pill opens the editor right below its row ${tag}`, ed.pill && ed.open && ed.parts, JSON.stringify(ed));
    check(`the clicked line's editor gets the focus; a second click closes it ${tag}`, ed.focused && ed.toggles, JSON.stringify(ed));
    check(`clicking an allocated or draft cell opens the editor ${tag}`, ed.cell !== false, JSON.stringify(ed));
    // The four actions together on the right of the sources (Suggest · Clear on top, Cancel · Allocate at
    // the bottom next to the total), inside the visible frame — also with the table scrolled sideways.
    const acts = async () => JSON.parse(await ev(`const ap=document.querySelector("tr.ed .ap"); if(!ap) return JSON.stringify({open:false});
      const f=document.querySelector(".mx-scroll").getBoundingClientRect(), R=(e)=>e.getBoundingClientRect();
      const b=Object.fromEntries([...ap.querySelectorAll(".ap-side button")].map(x=>[x.textContent,R(x)])), t=R(ap.querySelector(".ap-t")), sum=R(ap.querySelector(".ap-sum")), rows=R(ap.querySelector(".ap-rows, .ap-empty"));
      const all=["Suggest a split","Clear","Cancel","Allocate"].map(k=>b[k]).filter(Boolean);
      return JSON.stringify({ open:true, four: all.length===4, inFrame: all.every(r=>r.left>=f.left-1 && r.right<=f.right+1),
        top: Math.abs(b["Suggest a split"].top - t.top) <= 4 && Math.abs(b["Clear"].top - b["Suggest a split"].top) <= 1,
        // next to the total, or — editor taller than the frame — pinned to the frame's bottom edge
        bottom: (Math.abs(b["Allocate"].bottom - sum.bottom) <= 6 || (sum.bottom > f.bottom && b["Allocate"].bottom <= f.bottom && b["Allocate"].bottom >= f.bottom - 40)) && Math.abs(b["Cancel"].top - b["Allocate"].top) <= 1,
        rightOfRows: all.every(r=>r.left >= rows.right + 8), gapToRows: Math.round(b["Suggest a split"].left - rows.right) })`));
    if (!ed.cell) await ev(`document.querySelector("tr.rw .pill")?.click()`);
    await sleep(250);
    const a1 = await acts();
    check(`editor: the 4 actions sit together right of the sources (top · bottom) ${tag}`, a1.open && a1.four && a1.top && a1.bottom && a1.rightOfRows && a1.gapToRows <= 260, JSON.stringify(a1));
    await ev(`const s=document.querySelector(".mx-scroll"); s.scrollLeft=s.scrollWidth`);
    await sleep(250);
    const a2 = await acts();
    check(`editor stays in view with the table scrolled sideways ${tag}`, a2.open && a2.four && a2.inFrame, JSON.stringify(a2));
    await ev(`document.querySelector(".mx-scroll").scrollLeft=0`);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(200);
    check(`Esc closes the editor without saving ${tag}`, await ev(`return !document.querySelector("tr.ed")`));
    await ev(`document.querySelector("tr.g .tx").click()`);
    await sleep(350);
    const rail = JSON.parse(await ev(`const r=document.querySelector(".rail.on"); if(!r) return JSON.stringify({open:false}); const b=r.getBoundingClientRect();
      return JSON.stringify({ open:true, inView: b.right<=innerWidth+1 && b.left>=0, table: !!r.querySelector(".pt"), title: r.querySelector(".rail-h h3")?.textContent || "" })`));
    check(`an order's label opens its side panel with its allocation paths ${tag}`, rail.open && rail.inView && rail.table, JSON.stringify(rail));
    // Light theme: a soft dark (not pure black); dark theme: a soft white.
    const lab = JSON.parse(await ev(`const e=document.querySelector(".rail.on .fact .l"); if(!e) return JSON.stringify({found:false}); const c=getComputedStyle(e);
      const sum=(v)=>v.match(/[0-9]+/g).slice(0,3).map(Number).reduce((a,x)=>a+x,0); const dark=sum(getComputedStyle(document.body).backgroundColor) < 300, ink=sum(c.color);
      return JSON.stringify({found:true, dark, weight:+c.fontWeight, ink, ok: +c.fontWeight>=600 && (dark ? ink > 600 && ink < 765 : ink < 200 && ink > 0)})`));
    check(`side panel figure labels bold, soft dark on light / soft white on dark ${tag}`, lab.ok, JSON.stringify(lab));
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(300);
    check(`Esc closes the side panel ${tag}`, await ev(`return !document.querySelector(".rail.on")`));

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

    await usersChecks(tag);
    // Back to the matrix: the unsaved shipment must still be there (switching views never loses it).
    await ev(`document.querySelector('[data-nav="matrix"]').click()`);
    await sleep(250);
    check(`unsaved shipment kept after visiting Users & access ${tag}`, await ev(`return !!document.querySelector("tr.shc .sh-controls") && !!document.querySelector(".shs .unsaved")`));
  }

  // Phone width: Users & access only (no page scroll; the table scrolls inside its card).
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 1, mobile: true });
  await sleep(300);
  await ev(`document.querySelector('[data-nav="users"]')?.click()`);
  for (let t = 0; t < 40 && !(await ev(`return !!document.querySelector(".ua-t tr[data-item]")`)); t++) await sleep(250);
  check("Users & access: no horizontal page scroll @390px", await ev(`return document.documentElement.scrollWidth <= innerWidth + 1`));
  await ev(`document.querySelector('[data-nav="matrix"]')?.click()`);
}

// Users & access (the dev user must be an Admin). Opens dialogs and the rail and always cancels:
// nothing is written to monday.
async function usersChecks(tag) {
  const nav = await ev(`return !!document.querySelector('[data-nav="users"]')`);
  check(`admin sees "Users & access" in the side nav ${tag}`, nav, nav ? "" : await ev(`return [...document.querySelectorAll(".nav a, .nav-h")].map(a=>a.textContent+"|"+(a.dataset.nav||"")).join(", ") + " · chip: " + (document.querySelector(".user-chip")?.textContent||"none")`));
  if (!nav) return;
  await ev(`document.querySelector('[data-nav="users"]').click()`);
  let loaded = false;
  for (let t = 0; t < 60 && !loaded; t++) { await sleep(250); loaded = await ev(`return document.querySelectorAll(".ua-t tr[data-item]").length > 0`); }
  check(`Users & access lists the users ${tag}`, loaded);
  if (!loaded) return;
  check(`Users & access: matrix hidden, crumb updated ${tag}`, await ev(`return document.querySelector(".view[hidden] .mx-wrap") !== null && /Users & access/.test(document.querySelector(".crumb b").textContent)`));
  check(`Users & access: no horizontal page scroll ${tag}`, await ev(`return document.documentElement.scrollWidth <= innerWidth + 1`));
  check(`Users & access: role and access buttons 28px ${tag}`, await ev(`return [...document.querySelectorAll(".ua-t .ua-seg button")].every(b => Math.abs(b.getBoundingClientRect().height - 28) <= 1)`));

  // Another user's role → a confirmation opens; Cancel closes it and nothing changes.
  const other = await ev(`const r=[...document.querySelectorAll(".ua-t tr[data-item]")].find(r=>!r.querySelector(".chip.mut")); if(!r) return null;
    const off=[...r.querySelectorAll(".ua-seg")[0].querySelectorAll("button")].find(b=>!b.classList.contains("on")); off.click(); return r.dataset.item`);
  await sleep(150);
  const dlg = JSON.parse(await ev(`const d=document.querySelector(".ua-dlg"); if(!d) return JSON.stringify({open:false}); const r=d.getBoundingClientRect();
    return JSON.stringify({ open:true, inViewport: r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight, buttons: d.querySelectorAll("button").length, onTop: d.contains(document.elementFromPoint(r.left+r.width/2, r.top+20)) })`));
  check(`role change asks for confirmation (dialog visible, on top) ${tag}`, other && dlg.open && dlg.inViewport && dlg.onTop && dlg.buttons === 2, JSON.stringify(dlg));
  await ev(`[...document.querySelectorAll(".ua-dlg button")].find(b=>b.textContent==="Cancel")?.click()`);
  await sleep(150);
  check(`Cancel closes the confirmation, nothing saved ${tag}`, await ev(`return !document.querySelector(".ua-dlg") && !document.querySelector(".ua-saving")`));

  // Own row → Inactive is refused with the reason, before anything is sent.
  await ev(`const r=[...document.querySelectorAll(".ua-t tr[data-item]")].find(r=>r.querySelector(".chip.mut")?.textContent==="You"); [...r.querySelectorAll(".ua-st button")].find(b=>b.textContent==="Inactive").click()`);
  await sleep(150);
  check(`own access can't be removed (explained) ${tag}`, await ev(`const d=document.querySelector(".ua-dlg"); return !!d && /own access/.test(d.textContent) && d.querySelectorAll("button").length===1`));
  await ev(`document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"}))`);
  await sleep(150);
  check(`Esc closes the dialog ${tag}`, await ev(`return !document.querySelector(".ua-dlg")`));

  // Add user rail: opens, lists monday users (already listed ones can't be picked), invite tab has its fields.
  await ev(`document.querySelector(".ua-add").click()`);
  await sleep(350);
  const rail = JSON.parse(await ev(`const r=document.querySelector(".ua-rail"); const b=r.getBoundingClientRect();
    return JSON.stringify({ open: r.classList.contains("on") && b.right <= innerWidth + 1 && b.left >= 0, people: r.querySelectorAll(".ua-pick .rel-row").length,
      listedDisabled: [...r.querySelectorAll(".ua-pick .rel-row")].filter(x=>/In the list/.test(x.textContent)).every(x=>x.disabled), focus: document.activeElement?.classList.contains("ua-in") })`));
  check(`"Add user" opens the side panel with monday users ${tag}`, rail.open && rail.people > 0 && rail.listedDisabled, JSON.stringify(rail));
  await ev(`[...document.querySelectorAll(".ua-tabs button")].find(b=>/Invite/.test(b.textContent)).click()`);
  await sleep(150);
  check(`"Invite by email" shows name, email and the monday note ${tag}`, await ev(`const r=document.querySelector(".ua-rail"); return r.querySelectorAll(".ua-f input").length===2 && /Member/.test(r.querySelector(".note")?.textContent||"") && /Send invitation/.test(r.querySelector(".ua-rail-b .btn.on").textContent)`));
  await ev(`document.querySelector(".ua-rail .rail-x").click()`);
  await sleep(300);
  check(`side panel closes ${tag}`, await ev(`return !document.querySelector(".ua-rail.on")`));
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
