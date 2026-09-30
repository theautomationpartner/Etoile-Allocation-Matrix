import { Fragment } from "react";
import { fmt, plural } from "../../lib/format.js";

const RULE = "Suggested order: warehouse first when it covers at least half of the line — then the container arriving soonest, then a purchase order.";

// §7.2 / §8 — one matrix cell. Container columns read "X/Y": X allocated here, Y = units of the SKU on board.
// Read-only in step 2: clicking a cell opens the allocation editor in step 3.
function Cell({ c, needs }) {
  const XY = c.k === "it" && c.tot > 0;
  const of = XY ? <span className="of">/{fmt(c.tot)}</span> : null;
  const free = c.av > 0 ? ` · ${fmt(c.av)} still free there` : "";
  if (c.a > 0) {
    const multi = c.split.includes("+");
    return (
      <td className={`cl a ${c.k}`}>
        <button type="button" tabIndex={-1} title={`${c.lbl} — ${fmt(c.a)} allocated${XY ? ` of ${fmt(c.tot)} on board` : ""}${c.split ? ` (${c.split})` : ""}${free}`}>
          {fmt(c.a)}{of}
          {multi && <sup className="mpo">{c.split.split("+").length} POs</sup>}
          {c.dr > 0 && <sup className="mpo">+{fmt(c.dr)} draft</sup>}
        </button>
      </td>
    );
  }
  if (c.dr > 0) {
    return (
      <td className={`cl dr ${c.k}`}>
        <button type="button" tabIndex={-1} title={`${c.lbl} — ${fmt(c.dr)} proposed${XY ? ` of ${fmt(c.tot)} on board` : ""}. Draft: not allocated until you open it and click Allocate.`}>
          {fmt(c.dr)}{of}<sup className="mpo">draft</sup>
        </button>
      </td>
    );
  }
  if (XY) {
    return (
      <td className="cl xy">
        <span title={`${c.lbl} — nothing allocated to this order yet · ${fmt(c.tot)} on board, ${fmt(c.av)} still free`}>{fmt(c.tot)}</span>
      </td>
    );
  }
  if (c.av > 0 && needs) {
    return (
      <td className="cl av">
        <button type="button" tabIndex={-1} title={`${c.lbl} — ${fmt(c.av)} free`}>{fmt(c.av)}</button>
      </td>
    );
  }
  if (c.cap > 0) {
    return (
      <td className="cl idle">
        <button type="button" tabIndex={-1} title={`${c.lbl} — nothing allocated from here`}>·</button>
      </td>
    );
  }
  return <td className="cl" />;
}

function Row({ r }) {
  const [toShip, allocated, left] = r.nums;
  return (
    <tr className="rw">
      <td className="s1">
        <div className="rh">
          <div className="t"><b>{r.title}</b></div>
          {r.warnings.map((w) => (
            <div key={w} className="m warn"
              title={w.startsWith("lost") ? "Reserved on a container or PO that no longer exists or no longer carries this SKU. These units are back in Left." : "More units are reserved than are left to ship: part of the reservation was already shipped. Review the line."}>
              {w}
            </div>
          ))}
        </div>
      </td>
      <td className="s2">
        <div className="nn">
          <span className="n">{fmt(toShip)}</span>
          <span className="n mid">{fmt(allocated)}</span>
          {left ? (
            <span className={`n k ${r.end ? "bad" : ""}`}>
              <span className={`pill ${r.end ? "bad" : ""} ${r.dr ? "drp" : ""}`}
                title={r.dr ? `${fmt(r.dr)} units proposed as draft — review and click Allocate` : "Allocate these units"}>
                {fmt(left)}<i>{r.dr ? "Draft" : "Allocate"}</i>
              </span>
            </span>
          ) : (
            <span className="n k done">✓</span>
          )}
        </div>
      </td>
      {r.cells.map((c, i) => <Cell key={i} c={c} needs={r.needs} />)}
      <td className={`end ${r.end ? "bad" : "ok"}`}>{r.end ? fmt(r.end) : "—"}</td>
    </tr>
  );
}

export function MatrixTable({ matrix, status, isOpen, onToggle, orphanUnits }) {
  const cols = matrix?.cols || [{ k: "wh", id: "warehouse", label: "Warehouse", meta: "on hand" }];
  const nCol = 2 + cols.length + 1;

  let empty = null;
  if (status === "loading") empty = <><b style={{ display: "block", color: "var(--ink)", fontSize: 14, marginBottom: 4 }}>Loading from Monday…</b>Wholesale orders, warehouse stock, containers and purchase orders.</>;
  else if (!matrix) empty = <><b style={{ display: "block", color: "var(--ink)", fontSize: 14, marginBottom: 4 }}>No data yet.</b>Monday could not be read — see the message above.</>;
  else if (!matrix.groups.length) empty = <><b style={{ display: "block", color: "var(--ink)", fontSize: 14, marginBottom: 4 }}>Nothing to show here.</b>No row matches this filter — switch back to Everything.</>;

  return (
    <div className="mx-wrap">
      <div className="mx-scroll">
        <table className="mx">
          <thead>
            <tr>
              <th className="s1"><div className="hx"><div className="t">Wholesale order</div><div className="m">order · allocation · shipments</div></div></th>
              <th className="s2"><div className="hn"><span>To ship</span><span>Allocated</span><span>Left</span></div></th>
              {cols.map((c) => {
                const w = c.cap?.total ? Math.min(100, Math.round((c.cap.committed / c.cap.total) * 100)) : 0;
                return (
                  <th key={c.id} className={`hsrc ${c.k}`}>
                    <div className={`inner ${c.landed ? "landed" : ""}`}>
                      <div className="rule" />
                      <div className="t">{c.label}</div>
                      <div className="m">{c.meta}</div>
                      <div className="cap" title={c.cap ? `${fmt(c.cap.committed)} of ${fmt(c.cap.total)} already committed` : ""}><i style={{ width: `${w}%` }} /></div>
                    </div>
                  </th>
                );
              })}
              <th className="hend"><div className="t">Impossible</div><div className="m">needs a PO</div></th>
            </tr>
          </thead>
          <tbody>
            {empty && <tr><td colSpan={nCol}><div className="mx-empty">{empty}</div></td></tr>}
            {matrix?.groups.map((g) => {
              const open = isOpen(g);
              return (
                <Fragment key={g.key}>
                  <tr className={`g ${open ? "open" : ""}`}>
                    <td className="s1">
                      <div className="gh">
                        <button type="button" className="cv" onClick={() => onToggle(g, !open)} aria-label={open ? "Collapse" : "Expand"} aria-expanded={open}>{open ? "▼" : "▶"}</button>
                        <span className="tx">
                          <span className="t"><b className="eivr">{g.number}</b><span className="slash">/</span><span className="ret">{g.retailer}</span></span>
                          <span className="m">{g.meta}{g.review > 0 && <span className="warn"> · {plural(g.review, "line", "lines")} to review</span>}</span>
                        </span>
                      </div>
                    </td>
                    <td className="s2">
                      <div className="nn">
                        <span className="n">{fmt(g.nums[0])}</span>
                        <span className="n">{fmt(g.nums[1])}</span>
                        <span className={`n k ${g.nums[2] && g.end ? "bad" : ""}`}>{fmt(g.nums[2])}</span>
                      </div>
                    </td>
                    {g.roll.map((v, i) => <td key={i} className="roll">{v ? fmt(v) : ""}</td>)}
                    <td className={`end ${g.end ? "bad" : "ok"}`}>{g.end ? fmt(g.end) : "—"}</td>
                  </tr>
                  {open && (
                    <>
                      {/* §16 tabs: the Shipments tab is step 4 */}
                      <tr className="otabs-r">
                        <td colSpan={nCol}>
                          <div className="otabs">
                            <button type="button" className="on">Allocation</button>
                            <button type="button" disabled title="Shipments come in step 4">Shipments (0)</button>
                            <button type="button" className="add" disabled title="Shipments come in step 4">+ New shipment</button>
                            <span className="sp" />
                            <button type="button" className="btn copy" disabled title="Shipments come in step 4">
                              Copy remaining to ship{g.allocated ? ` · ${fmt(g.allocated)}` : ""}
                            </button>
                          </div>
                        </td>
                      </tr>
                      {g.rows.map((r) => <Row key={r.key} r={r} />)}
                    </>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mx-foot">
        {matrix && <span>{plural(matrix.groups.length, "order", "orders")} · {plural(matrix.rowCount, "row", "rows")}</span>}
        <span>{RULE}</span>
        {orphanUnits > 0 && <span style={{ color: "var(--gap)" }}>{fmt(orphanUnits)} units point to a source that is no longer active</span>}
      </div>
    </div>
  );
}
