import { useEffect, useMemo, useRef, useState } from "react";
import { clock, fmt, plural, dayMonthYear } from "../../lib/format.js";
import { buildImporter, IMPORT_FILTERS } from "../../lib/importer.js";
import { IMPORTER_BOARD } from "../../lib/monday.js";
import { Card } from "../allocation-matrix/MetricCards.jsx";
import { SidePanel } from "../allocation-matrix/SidePanel.jsx";

// In-Transit Importer (mockup vImporter): one row per packing list uploaded for the US, newest first. Read-only:
// "Upload packing list" opens the Importer board in monday, where files are uploaded; deleting a shipment is done
// from its In-Transit item. The shipment chip and "Open" show the container's side panel.
const LABELS = ["Shipments created", "Still reversible", "Reverted", "Uploaded this month"];
const IMPORTER_URL = `https://etoile8.monday.com/boards/${IMPORTER_BOARD}`;
const PACKING_CHIP = { Final: "wh", Done: "wh" };

export function InTransitImporter({ data, model, status, error, onRefresh, shipments, search, filter, onFilter, onGoShipments }) {
  const imp = useMemo(() => (model && data ? buildImporter(model, data) : null), [model, data]);
  const busy = status === "loading" || status === "refreshing";
  const ready = Boolean(imp);
  const toggleFilter = (k) => onFilter(filter === k ? "all" : k); // a card activates its filter; a second click goes back

  // Side panel (same rail and trail as the matrix).
  const [rail, setRail] = useState([]);
  const openRecord = (type, id) => setRail([{ type, id: String(id) }]);
  const panel = {
    onOpen: (type, id) => setRail((cur) => [...cur, { type, id: String(id) }]),
    onTrail: (i) => setRail((cur) => cur.slice(0, i + 1)),
    onClose: () => setRail([]),
    onGoShipments(orderId) { setRail([]); onGoShipments(orderId); },
  };
  const escRef = useRef(null);
  escRef.current = () => rail.length && setRail([]);
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && escRef.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const q = search.trim().toLowerCase();
  const shown = useMemo(() => {
    if (!imp) return [];
    const keep = imp.is[filter] || imp.is.all;
    const has = (t) => String(t || "").toLowerCase().includes(q);
    return imp.rows.filter((r) => keep(r) && (!q || has(r.name) || r.files.some(has) || has(r.ship?.code)));
  }, [imp, filter, q]);

  const fresh = status === "loading" ? "Loading from Monday…" : status === "refreshing" ? "Recalculating with fresh Monday data…"
    : data ? `Calculated from Monday data read at ${clock(data.loadedAt)}` : "";
  const c = imp?.cards;

  return (
    <>
      <div className="page-h">
        <div>
          <h2>In-Transit Importer</h2>
          <p>Every packing list uploaded, and the shipment it created. This is where a container enters the system — and the only place to undo one.</p>
        </div>
        <div className="page-act">
          <a className="btn on" href={IMPORTER_URL} target="_blank" rel="noopener noreferrer" title="Opens the In-Transit Importer board in Monday, where packing lists are uploaded">Upload packing list</a>
        </div>
      </div>

      {error && (
        <div className="note warn" role="alert">
          <b>{ready ? "Refresh failed." : "Monday could not be read."}</b> {error}
          {ready && ` Showing the figures loaded at ${clock(data.loadedAt)}.`}{" "}
          <button type="button" className="btn" onClick={onRefresh}>Try again</button>
        </div>
      )}

      <div className="kpi-bar">
        <span className="fresh" aria-live="polite">{fresh}</span>
        <button type="button" className="btn refresh" onClick={onRefresh} disabled={busy} title="Read every board again from Monday and recalculate all figures">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" className={busy ? "spin" : ""}>
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
          </svg>
          Refresh
        </button>
      </div>

      {!c ? (
        <div className="kpis">
          {LABELS.map((label) => (
            <div key={label} className="kpi" aria-busy="true">
              <div className="lab">{label}</div>
              <div className="val"><span className="sk v" /></div>
              <div className="sub"><span className="sk s" /></div>
            </div>
          ))}
        </div>
      ) : (
        <div className="kpis">
          <Card label={LABELS[0]} value={fmt(c.created.shipments)} filterKey="imported" filter={filter} onFilter={toggleFilter}
            sub={`${fmt(c.created.units)} units brought into the system`} />
          <Card label={LABELS[1]} value={fmt(c.draft)} tone={c.draft ? "warn" : ""} filterKey="draft" filter={filter} onFilter={toggleFilter}
            sub={c.draft ? "draft files — deleting them undoes everything" : "All files confirmed as final"} />
          <Card label={LABELS[2]} value={fmt(c.reverted)} filterKey="deleted" filter={filter} onFilter={toggleFilter}
            sub={c.reverted ? "files whose shipment was deleted" : "Nothing has been undone"} />
          <Card label={LABELS[3]} value={fmt(c.recent)} sub="packing lists processed in the last 30 days" />
        </div>
      )}

      <div className="note">
        <b>Deleting a shipment undoes the whole chain.</b> The In-Transit item and its Process twin disappear, the Master SKU records go back to an
        estimated arrival, the purchase order gets those units back as still-to-ship, and the file here is marked Deleted in In-Transit. The uploaded
        file stays — only what it created goes away. Only draft files can be undone.
      </div>

      <div className="fbar">
        <span className="fl">Show</span>
        {Object.entries(IMPORT_FILTERS).map(([k, f]) => (
          <button key={k} type="button" className={`fchip ${filter === k ? "on" : ""}`} aria-pressed={filter === k} onClick={() => onFilter(k)}>
            {f.label}{imp && <i>{fmt(imp.counts[k])}</i>}
          </button>
        ))}
        {q && imp && <span className="fnote">{fmt(shown.length)} of {plural(imp.rows.filter(imp.is[filter] || imp.is.all).length, "upload", "uploads")} match “{search.trim()}”</span>}
      </div>

      {imp && !shown.length ? (
        <section className="card">
          <div className="mx-empty">
            <b className="cc-empty-t">{q ? "No upload matches this search." : "No upload matches this filter."}</b>
            {q ? "Try another file name or container." : "Switch back to All uploads to see the full history."}
          </div>
        </section>
      ) : imp && (
        <section className="card">
          <div className="tw">
            <table className="imt">
              <thead>
                <tr>
                  <th className="im-file">File</th><th>Uploaded</th><th>Status</th><th>Shipment created</th>
                  <th>Packing list</th><th>Arrives</th><th className="r">Units</th><th className="r">Promised</th><th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} className={r.reverted ? "gone" : ""}>
                    <td className="strong im-file" title={r.files.join(", ")}>
                      {r.file || <span className="muted">no file</span>}
                      <div className="muted im-item">{r.name}</div>
                    </td>
                    <td className="muted im-date">{r.uploaded ? dayMonthYear(r.uploaded) : "—"}</td>
                    <td><span className={`chip ${r.status.c}`}><span className="sq" />{r.status.t}</span></td>
                    <td>
                      {r.ship ? (
                        <button type="button" className="chip it" onClick={() => openRecord("ship", r.ship.id)}><span className="sq" />{r.ship.code}</button>
                      ) : <span className="muted">{r.reverted ? "deleted" : "not linked"}</span>}
                    </td>
                    <td>{r.ship ? <span className={`chip ${PACKING_CHIP[r.ship.packingList] || "po"}`}><span className="sq" />{r.ship.packingList || "—"}</span> : <span className="muted">—</span>}</td>
                    <td className="muted im-date">{r.ship?.eta ? dayMonthYear(r.ship.eta) : "—"}</td>
                    <td className="r">{r.ship ? fmt(r.ship.units) : "—"}</td>
                    <td className="r im-it">{r.ship?.promised ? fmt(r.ship.promised) : "—"}</td>
                    <td className="r">{r.ship && <button type="button" className="btn" onClick={() => openRecord("ship", r.ship.id)}>Open</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <SidePanel stack={rail} model={model} data={data} shipments={shipments} {...panel} />
    </>
  );
}
