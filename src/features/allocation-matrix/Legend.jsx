import { fmt } from "../../lib/format.js";

// §3 legend — same markup and colours as the mockup. Client request (2026-09-30): each swatch shows the
// real total of what the matrix is showing (with the active filter and search), not a static example.
//   from warehouse / from a container / from a purchase order → units allocated from each kind of source
//   draft → units proposed as draft · free → units still free anywhere for the SKUs in view
export function Legend({ totals }) {
  const t = totals || { wh: 0, it: 0, po: 0, draft: 0, free: 0 };
  const v = (n) => (totals ? fmt(n) : "—");
  return (
    <div className="mx-hint">
      <span className="k"><span className="sw wh">{v(t.wh)}</span> from warehouse</span>
      <span className="k"><span className="sw it">{v(t.it)}</span> from a container</span>
      <span className="k"><span className="sw po">{v(t.po)}</span> from a purchase order</span>
      <span className="k"><span className="sw dr">{v(t.draft)}</span> draft · proposed, not allocated</span>
      <span className="k"><span className="sw av">{v(t.free)}</span> free, not assigned yet</span>
      <span className="k" style={{ marginLeft: "auto" }}>Open a draft or a grey number, check it, then click <b style={{ color: "var(--ink)" }}>Allocate</b>.</span>
    </div>
  );
}
