import { useEffect, useMemo, useRef, useState } from "react";
import { usePanelRequest } from "../../hooks/usePanelRequest.js";
import { clock, fmt, plural, dayMonthYear } from "../../lib/format.js";
import { buildImporter, IMPORT_FILTERS } from "../../lib/importer.js";
import { Card } from "../allocation-matrix/MetricCards.jsx";
import { SidePanel } from "../allocation-matrix/SidePanel.jsx";
import { importerPeople, uploadPackingList, useAppActions } from "../../lib/appActions.js";

// In-Transit Importer (mockup vImporter): one row per packing list uploaded for the US, newest first. Read-only:
// "Upload packing list" opens a pop-up with the fields of the board's Importer Form (Name, File, Type Import, People,
// Location, ETD, ETA); the server creates the Importer item and sets Import Status = Import, which starts monday's
// import (api/importer-upload.js). The monday form itself (members only) stays one click away. Deleting a shipment
// is done from its side panel. The shipment chip and "Open" show the container's side panel.
const LABELS = ["Shipments created", "Still reversible", "Reverted", "Uploaded this month"];
// The board's Importer Form in monday (asks for a monday login), offered as an alternative.
const FORM_URL = "https://forms.monday.com/forms/d589ca5528644f916c76216b5c1fbfff?r=use1";
const PACKING_CHIP = { Final: "wh", Done: "wh" };

export function InTransitImporter({ data, model, status, error, onRefresh, shipments, search, filter, onFilter, onGoShipments, panelRequest }) {
  const imp = useMemo(() => (model && data ? buildImporter(model, data) : null), [model, data]);
  const busy = status === "loading" || status === "refreshing";
  const ready = Boolean(imp);
  const toggleFilter = (k) => onFilter(filter === k ? "all" : k); // a card activates its filter; a second click goes back
  const [upload, setUpload] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const closeUpload = () => { setUpload(false); if (uploaded) { setUploaded(false); onRefresh(); } }; // read monday again to list it

  // Side panel (same rail and trail as the matrix).
  const [rail, setRail] = useState([]);
  const openRecord = (type, id) => setRail([{ type, id: String(id) }]);
  usePanelRequest(panelRequest, openRecord);
  const panel = {
    onOpen: (type, id) => setRail((cur) => [...cur, { type, id: String(id) }]),
    onTrail: (i) => setRail((cur) => cur.slice(0, i + 1)),
    onClose: () => setRail([]),
    onGoShipments(orderId) { setRail([]); onGoShipments(orderId); },
  };
  const escRef = useRef(null);
  escRef.current = () => (upload ? closeUpload() : rail.length && setRail([]));
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
          <button type="button" className="btn on" onClick={() => setUpload(true)}>Upload packing list</button>
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

      {upload && <UploadDialog onClose={closeUpload} onDone={() => setUploaded(true)} />}
    </>
  );
}

// The Importer Form's fields. People defaults to whoever is uploading.
function UploadDialog({ onClose, onDone }) {
  const { toast } = useAppActions();
  const [users, setUsers] = useState(null);
  const [f, setF] = useState({ name: "", typeImport: "", location: "US", etd: "", eta: "", people: [] });
  const [file, setFile] = useState(null);
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k) => (e) => setF((cur) => ({ ...cur, [k]: e.target.value }));
  useEffect(() => {
    let on = true;
    importerPeople()
      .then((d) => { if (!on) return; setUsers(d.users); setF((cur) => ({ ...cur, people: cur.people.length ? cur.people : [d.me] })); })
      .catch((e) => on && setError(e.message));
    return () => { on = false; };
  }, []);
  const togglePerson = (id) => setF((cur) => ({ ...cur, people: cur.people.includes(id) ? cur.people.filter((x) => x !== id) : [...cur.people, id] }));
  const missing = [!f.name.trim() && "Name", !file && "File", !f.typeImport && "Type Import", !f.people.length && "People", !f.location && "Location", !f.etd && "ETD"].filter(Boolean);
  const submit = async (e) => {
    e.preventDefault();
    if (missing.length) return setError(`Fill in: ${missing.join(", ")}.`);
    setBusy(true);
    setError("");
    try {
      await uploadPackingList({ ...f, name: f.name.trim(), people: f.people.join(","), file });
      onDone();
      toast(`"${f.name.trim()}" was sent to the In-Transit Importer. Monday is reading the file.`);
      onClose();
    } catch (err) {
      setError(err.message || "The packing list could not be sent.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="scrim on up-scrim" onClick={() => !busy && onClose()} />
      <form className="up-dlg" role="dialog" aria-modal="true" aria-labelledby="up-dlg-t" onSubmit={submit} noValidate>
        <div className="up-h">
          <h3 id="up-dlg-t">Upload packing list</h3>
          <a className="up-ext" href={FORM_URL} target="_blank" rel="noopener noreferrer">Use the Monday form instead</a>
          <button type="button" className="rail-x" onClick={onClose} disabled={busy} aria-label="Close">×</button>
        </div>
        <p className="up-n">Creates the item in the In-Transit Importer and starts the import: Monday reads the file and creates the shipment.</p>
        <div className="up-body">
          <label className="up-l">Name<input className="up-i" value={f.name} onChange={set("name")} placeholder="US / FLEX-4200000 / 40HC" maxLength={255} autoFocus /></label>
          <div className="up-l">File
            <span className="up-file">
              <button type="button" className="btn" onClick={() => fileRef.current?.click()}>{file ? "Change file" : "Choose file"}</button>
              <span className={file ? "" : "muted"}>{file ? `${file.name} · ${Math.max(1, Math.round(file.size / 1024))} KB` : "No file chosen"}</span>
              <input ref={fileRef} type="file" className="date-native" tabIndex={-1} aria-label="Packing list file" accept=".pdf,.xlsx,.xls,.csv,.png,.jpg,.jpeg"
                onChange={(e) => setFile(e.target.files?.[0] || null)} />
            </span>
          </div>
          <div className="up-row">
            <label className="up-l">Type Import
              <select className="up-i" value={f.typeImport} onChange={set("typeImport")}>
                <option value="">Choose…</option><option>In-Transit</option><option>In-Transit Draft</option>
              </select>
            </label>
            <label className="up-l">Location
              <select className="up-i" value={f.location} onChange={set("location")}><option>US</option><option>AU</option></select>
            </label>
          </div>
          <div className="up-row">
            <div className="up-l">ETD<EnglishDate label="ETD" value={f.etd} onChange={(v) => setF((cur) => ({ ...cur, etd: v }))} /></div>
            <div className="up-l">ETA<EnglishDate label="ETA" value={f.eta} onChange={(v) => setF((cur) => ({ ...cur, eta: v }))} /></div>
          </div>
          <fieldset className="up-l up-people">
            <legend>People</legend>
            {users ? users.map((u) => (
              <label key={u.id} className="up-p"><input type="checkbox" checked={f.people.includes(u.id)} onChange={() => togglePerson(u.id)} />{u.name}</label>
            )) : <span className="muted">Loading people from Monday…</span>}
          </fieldset>
          <p className="up-hint">Type Import: <b>In-Transit</b> creates the shipment with a Final packing list; <b>In-Transit Draft</b> with a Draft one (it can be deleted later). Files up to 4 MB.</p>
          {error && <div className="note warn" role="alert">{error}</div>}
        </div>
        <div className="up-b">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn on" disabled={busy}>{busy ? "Sending…" : "Submit"}</button>
        </div>
      </form>
    </>
  );
}

// A date shown in English ("21 Dec 2026" / "Choose a date") whatever the browser's language; it opens the native
// date picker (same approach as the matrix's ship date).
function EnglishDate({ label, value, onChange }) {
  const ref = useRef(null);
  const open = () => {
    try { ref.current.showPicker(); } catch { ref.current.focus(); ref.current.click(); }
  };
  return (
    <span className="up-date">
      <button type="button" className={`up-i up-date-b ${value ? "" : "empty"}`} onClick={open} aria-label={value ? `${label} ${dayMonthYear(value)}, change` : `Choose the ${label}`}>
        {value ? dayMonthYear(value) : "Choose a date"}
      </button>
      {value && <button type="button" className="date-clear" onClick={() => onChange("")} aria-label={`Clear the ${label}`}>×</button>}
      <input ref={ref} type="date" className="date-native" tabIndex={-1} aria-hidden="true" value={value || ""} onChange={(e) => onChange(e.target.value)} />
    </span>
  );
}
