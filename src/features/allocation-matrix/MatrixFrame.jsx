import { fmt, plural } from "../../lib/format.js";

// §3 / §5.4 — what the fixed left block shows in each view.
const HEAD = {
  order: { title: "Wholesale order", meta: "order · allocation · shipments", nums: ["To ship", "Allocated", "Left"], group: ["order", "orders"] },
  sku: { title: "SKU", meta: "grouped by product · orders inside", nums: ["Required", "Assigned", "Left"], group: ["product", "products"] },
  source: { title: "Source of stock", meta: "grouped by origin · SKUs inside", nums: ["On board", "Assigned", "Free"], group: ["source", "sources"] },
};

const RULE = "Suggested order: warehouse first, but only if it covers the whole line — then the container arriving soonest, then a purchase order.";

// Matrix frame: fixed left block + footer. Rows and one column per source arrive in step 2.
export function MatrixFrame({ view, model, status }) {
  const h = HEAD[view];
  let body;
  if (status === "loading") body = <><b>Loading from Monday…</b>Wholesale orders, warehouse stock, containers and purchase orders.</>;
  else if (!model) body = <><b>No data yet.</b>Monday could not be read — see the message above.</>;
  else body = <><b>Matrix rows come next.</b>Step 2 builds the rows and one column per source of stock.</>;

  let lead = null;
  if (model) {
    const { counts, lines } = model;
    const groups = view === "order" ? counts.orders : view === "sku" ? new Set(lines.map((l) => l.sku)).size : null;
    lead = groups === null ? plural(counts.rows, "row", "rows") : `${plural(groups, h.group[0], h.group[1])} · ${plural(counts.rows, "row", "rows")}`;
  }

  return (
    <div className="mx-wrap">
      <div className="mx-scroll">
        <table className="mx">
          <thead>
            <tr>
              <th className="s1" scope="col">
                <div className="hx"><div className="t">{h.title}</div><div className="m">{h.meta}</div></div>
              </th>
              <th className="s2" scope="col">
                <div className="hn">{h.nums.map((n) => <span key={n}>{n}</span>)}</div>
              </th>
              <th scope="col"><span className="sr-only">Sources</span></th>
            </tr>
          </thead>
          <tbody>
            <tr><td colSpan={3}><div className="mx-empty">{body}</div></td></tr>
          </tbody>
        </table>
      </div>
      <div className="mx-foot">
        {lead && <span>{lead}</span>}
        <span>{RULE}</span>
        {model?.orphanUnits > 0 && <span className="bad">{fmt(model.orphanUnits)} units point to a source that is no longer active</span>}
      </div>
    </div>
  );
}
