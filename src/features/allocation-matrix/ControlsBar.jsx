// §3 controls row 1 (mockup markup). Only the Wholesale order view is kept (client decision,
// 2026-09-30: the SKU and Source of stock views are removed).
export function ControlsBar({ onExpandAll, disabled }) {
  return (
    <div className="mx-bar">
      <span className="fl">View by</span>
      <span className="seg">
        <button type="button" className="on" aria-pressed="true">Wholesale order</button>
      </span>
      <span className="spacer" />
      <button className="btn" type="button" disabled={disabled} onClick={() => onExpandAll(true)}>Expand all</button>
      <button className="btn" type="button" disabled={disabled} onClick={() => onExpandAll(false)}>Collapse all</button>
    </div>
  );
}
