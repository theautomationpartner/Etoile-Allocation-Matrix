import { useEffect, useMemo, useRef, useState } from "react";
import { clock, fmt } from "../../lib/format.js";
import { buildOrderMatrix } from "../../lib/matrix.js";
import { allocatedMessage, clampValue, editorFor, suggestSplit, validate } from "../../lib/allocation.js";
import { releaseLine, saveAllocation } from "../../lib/allocationSync.js";
import { buildReview } from "../../lib/review.js";
import { ReviewPanel } from "./ReviewPanel.jsx";
import { mondayApi } from "../../config.js";
import { AllocationEditor } from "./AllocationEditor.jsx";
import { SidePanel } from "./SidePanel.jsx";
import { rowMatchesSearch } from "../../lib/search.js";
import { MetricCards } from "./MetricCards.jsx";
import { ControlsBar } from "./ControlsBar.jsx";
import { ShowFilters } from "./ShowFilters.jsx";
import { Legend } from "./Legend.jsx";
import { MatrixTable } from "./MatrixTable.jsx";
import { fetchWrite } from "../../lib/mondayWrites.js";

// Allocation matrix screen (§3). Step 1: metrics + Show filters + search. Step 2: the matrix in the
// Wholesale order view. Step 3: the allocation editor below a row (writes the Allocation Ledger) and the
// side panel of an order, SKU or source. Step 4: shipments (Shipments tab of each order).
// shipments: useShipments(...) owned by the workspace (the Control center opens the same records).
// request: { n, filter?, orderShipments? } from another screen (the Control center): apply a Show filter, or
// open an order on its Shipments tab. n changes on every request.
export function AllocationMatrix({ data, model, status, error, search, onRefresh, toast, patchData, shipments, request }) {

  // Closing or reloading the tab with unsaved shipments: the browser asks first.
  useEffect(() => {
    if (!shipments.hasUnsaved) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [shipments.hasUnsaved]);

  // Refresh reloads everything from monday: with unsaved shipments it asks for a second click first.
  const armed = useRef(0);
  const refresh = () => {
    if (shipments.hasUnsaved && Date.now() - armed.current > 6000) {
      armed.current = Date.now();
      return toast("Some shipments are not saved yet. Click Refresh again to discard those changes and reload.");
    }
    armed.current = 0;
    onRefresh();
  };
  const [filter, setFilter] = useState("all"); // §15.1: one filter at a time
  const [open, setOpen] = useState({}); // group open/closed, kept while the page is open (§3)

  // A request from another screen (the Control center): a Show filter, or an order opened on its Shipments tab.
  useEffect(() => {
    if (!request) return;
    if (request.filter !== undefined && request.filter !== null) setFilter(request.filter);
    if (request.orderShipments) {
      const id = String(request.orderShipments);
      setFilter("all");
      setOpen((cur) => ({ ...cur, [id]: true }));
      shipments.actions.setTab(id, "ships");
    }
  }, [request?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = Boolean(model);
  const busy = status === "loading" || status === "refreshing";

  // §4: a card activates its filter; a second click goes back to Everything.
  const toggleFilter = (key) => setFilter((cur) => (cur === key ? "all" : key));

  const matrix = useMemo(() => (model ? buildOrderMatrix(model, data, { filter, search }) : null), [model, data, filter, search]);

  // ── Step 3: allocation editor (one line at a time; clicking the same line again closes it) ──
  const [edit, setEdit] = useState(null); // { lineId, focus, values, notice, error, saving }
  const ed = useMemo(() => (edit && model ? editorFor(model, data, edit.lineId) : null), [edit?.lineId, model, data]); // eslint-disable-line react-hooks/exhaustive-deps
  const openEditor = (lineId, focus) => setEdit((cur) => {
    if (cur?.saving) return cur;
    if (cur && String(cur.lineId) === String(lineId)) return null;
    const e = editorFor(model, data, lineId);
    return e ? { lineId, focus: focus || null, values: e.values, notice: "", error: "", saving: false } : cur;
  });
  const patchEdit = (patch) => setEdit((cur) => (cur ? { ...cur, ...patch } : cur));
  const closeEditor = () => setEdit((cur) => (cur?.saving ? cur : null));
  // The line left the matrix (e.g. fully shipped after a refresh) or its order switched to Shipments: close.
  const editOrder = ed ? String(ed.line.orderId) : null;
  useEffect(() => {
    if (edit && !edit.saving && (!ed || shipments.ui.tab[editOrder] === "ships")) setEdit(null);
  }, [edit, ed, editOrder, shipments.ui.tab]);

  const editorActions = {
    onChange(row, raw) {
      const { value, capped } = clampValue(row, raw);
      setEdit((cur) => {
        const values = { ...cur.values };
        if (value > 0) values[row.id] = value;
        else delete values[row.id];
        return { ...cur, values, error: "", notice: capped ? `${row.title} capped at ${fmt(row.max)}, what it has available` : "" };
      });
    },
    onSuggest: () => patchEdit({ values: suggestSplit(ed), notice: "", error: "" }),
    onClear: () => patchEdit({ values: {}, notice: "", error: "" }),
    onCancel: closeEditor,
    async onSave() {
      if (!edit || edit.saving) return;
      const problem = validate(ed, edit.values);
      if (problem) return patchEdit({ error: problem });
      patchEdit({ saving: true, error: "" });
      const { sku, number, goal } = ed;
      const orderId = String(ed.line.orderId);
      try {
        const res = await saveAllocation(fetchWrite, mondayApi, { data, lineId: edit.lineId, values: edit.values });
        // Keep loadedAt: the matrix is recalculated, unsaved shipments stay as they are.
        patchData((cur) => ({ ...res.data, loadedAt: cur.loadedAt }));
        const cut = shipments.actions.fitAllocation(orderId, sku, res.allocated);
        setEdit(null);
        toast(`${cut ? `${fmt(cut)} units of ${sku} came out of ${number}'s shipments: save them to keep the change. ` : ""}${allocatedMessage({ sku, number, allocated: res.allocated, toShip: goal })}`);
      } catch (e) {
        // A conflict brings the figures read just now: the editor shows them.
        if (e.fresh) patchData((cur) => ({ ...e.fresh, loadedAt: cur.loadedAt }));
        setEdit((cur) => (cur ? { ...cur, saving: false, error: `Not allocated: ${e.message}` } : cur));
      }
    },
  };

  // ── Review (2026-10-07): lines holding more than they still have to ship can be released ──
  const review = useMemo(() => (model ? buildReview(model, data) : null), [model, data]);
  const [releasing, setReleasing] = useState(null);
  async function onRelease(item) {
    if (releasing) return;
    setReleasing(item.key);
    try {
      const res = await releaseLine(fetchWrite, mondayApi, { data, lineId: item.lineId });
      patchData((cur) => ({ ...res.data, loadedAt: cur.loadedAt }));
      const cut = shipments.actions.fitAllocation(item.orderId, item.sku, res.allocated);
      toast(`Released ${fmt(res.plan.units)} units of ${item.title}: ${res.plan.parts.map((p) => `${fmt(p.qty)} from ${p.title}`).join(" · ")}.${cut ? ` ${fmt(cut)} units came out of its shipments: save them to keep the change.` : ""}`);
    } catch (e) {
      if (e.fresh) patchData((cur) => ({ ...e.fresh, loadedAt: cur.loadedAt }));
      toast(`Not released: ${e.message}`);
    } finally {
      setReleasing(null);
    }
  }

  // ── Side panel (§8.3): a trail of records; a click in the matrix starts a new trail ──
  const [rail, setRail] = useState([]);
  const panel = {
    onPanel: (type, id) => setRail([{ type, id: String(id) }]),
    onOpen: (type, id) => setRail((cur) => [...cur, { type, id: String(id) }]),
    onTrail: (i) => setRail((cur) => cur.slice(0, i + 1)),
    onClose: () => setRail([]),
    onGoShipments(orderId) {
      setRail([]);
      setOpen((cur) => ({ ...cur, [orderId]: true }));
      shipments.actions.setTab(orderId, "ships");
    },
  };

  // Esc closes the editor first, then the side panel (as in the mockup).
  const escRef = useRef(null);
  escRef.current = () => {
    if (edit && !edit.saving) setEdit(null);
    else if (rail.length) setRail([]);
  };
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && escRef.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const matched = useMemo(() => (model ? model.lines.filter((r) => rowMatchesSearch(r, search, data.warehouse)).length : 0), [model, data, search]);

  // By default only groups with something left to allocate are open; with a filter or a search, all are.
  const narrowed = filter !== "all" || Boolean(search.trim());
  const isOpen = (g) => open[g.key] ?? (narrowed ? true : g.defOpen);
  const toggle = (g, value) => setOpen((cur) => ({ ...cur, [g.key]: value }));
  const expandAll = (value) => setOpen(Object.fromEntries((matrix?.groups || []).map((g) => [g.key, value])));

  const fresh = status === "loading" ? "Loading from Monday…" : status === "refreshing" ? "Recalculating with fresh Monday data…"
    : data ? `Calculated from Monday data read at ${clock(data.loadedAt)}` : "";

  return (
    <>
      <div className="page-h">
        <div>
          <h2>Allocation matrix</h2>
          <p>Where every sold unit comes from — and the place to decide it. Pick the angle: the sale, the product, or the container.</p>
        </div>
      </div>

      {error && (
        <div className="note warn" role="alert">
          <b>{ready ? "Refresh failed." : "Monday could not be read."}</b> {error}
          {ready && ` Showing the figures loaded at ${clock(data.loadedAt)}.`}{" "}
          <button type="button" className="btn" onClick={refresh}>Try again</button>
        </div>
      )}

      <div className="kpi-bar">
        <span className="fresh" aria-live="polite">{fresh}</span>
        <button type="button" className="btn refresh" onClick={refresh} disabled={busy}
          title="Read every board again from Monday and recalculate all figures">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" className={busy ? "spin" : ""}>
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
          </svg>
          Refresh
        </button>
      </div>
      <MetricCards metrics={model?.metrics} filter={filter} onFilter={toggleFilter} />
      <ReviewPanel items={review} busyKey={releasing} onRelease={onRelease} />
      <ControlsBar onExpandAll={expandAll} disabled={!matrix?.groups.length} />
      <ShowFilters filter={filter} onFilter={setFilter} search={search} matched={matched} total={model?.lines.length} />
      <Legend totals={matrix?.legend} />
      <MatrixTable matrix={matrix} status={status} isOpen={isOpen} onToggle={toggle} shipments={shipments}
        editingLine={ed ? edit.lineId : null} onEdit={openEditor} onPanel={panel.onPanel}
        renderEditor={(nCol) => ed && <AllocationEditor ed={ed} state={edit} nCol={nCol} {...editorActions} />} />
      <SidePanel stack={rail} model={model} data={data} shipments={shipments} {...panel} />
    </>
  );
}
