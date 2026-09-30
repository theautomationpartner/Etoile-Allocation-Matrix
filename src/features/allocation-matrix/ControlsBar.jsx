// §3 controls row 1. Only the Wholesale order view is kept (client decision, 2026-09-30: the SKU and
// Source of stock views are removed). Expand / Collapse all act on the matrix groups, built in step 2.
export function ControlsBar() {
  return (
    <div className="mx-bar">
      <span className="fl">View by</span>
      <span className="seg" role="group" aria-label="View by">
        <button type="button" aria-pressed="true">Wholesale order</button>
      </span>
      <span className="spacer" />
      <button className="btn" type="button" disabled title="Available when the matrix rows are built">Expand all</button>
      <button className="btn" type="button" disabled title="Available when the matrix rows are built">Collapse all</button>
    </div>
  );
}
