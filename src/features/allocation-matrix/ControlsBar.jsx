export const VIEWS = [
  { id: "order", label: "Wholesale order" },
  { id: "sku", label: "SKU" },
  { id: "source", label: "Source of stock" },
];

// §3 controls row 1. Expand / Collapse all act on the matrix groups, built in step 2.
export function ControlsBar({ view, onView }) {
  return (
    <div className="mx-bar">
      <span className="fl">View by</span>
      <span className="seg" role="group" aria-label="View by">
        {VIEWS.map((v) => (
          <button key={v.id} type="button" aria-pressed={view === v.id} onClick={() => onView(v.id)}>
            {v.label}
          </button>
        ))}
      </span>
      <span className="spacer" />
      <button className="btn" type="button" disabled title="Available when the matrix rows are built">Expand all</button>
      <button className="btn" type="button" disabled title="Available when the matrix rows are built">Collapse all</button>
    </div>
  );
}
