import { fmt, plural } from "../../lib/format.js";

const RULE = "Suggested order: warehouse first, but only if it covers the whole line — then the container arriving soonest, then a purchase order.";

// Matrix frame (§5): fixed left block + footer. Rows and one column per source arrive in step 2.
export function MatrixFrame({ model, status }) {
  let body;
  if (status === "loading") body = <><b>Loading from Monday…</b>Wholesale orders, warehouse stock, containers and purchase orders.</>;
  else if (!model) body = <><b>No data yet.</b>Monday could not be read — see the message above.</>;
  else body = <><b>Matrix rows come next.</b>Step 2 builds the rows and one column per source of stock.</>;

  return (
    <div className="mx-wrap">
      <div className="mx-scroll">
        <table className="mx">
          <thead>
            <tr>
              <th className="s1" scope="col">
                <div className="hx"><div className="t">Wholesale order</div><div className="m">order · allocation · shipments</div></div>
              </th>
              <th className="s2" scope="col">
                <div className="hn"><span>To ship</span><span>Allocated</span><span>Left</span></div>
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
        {model && <span>{plural(model.counts.orders, "order", "orders")} · {plural(model.counts.rows, "row", "rows")}</span>}
        <span>{RULE}</span>
        {model?.orphanUnits > 0 && <span className="bad">{fmt(model.orphanUnits)} units point to a source that is no longer active</span>}
      </div>
    </div>
  );
}
