// §3 legend — static, same markup and colours as the mockup.
export function Legend() {
  return (
    <div className="mx-hint">
      <span className="k"><span className="sw wh">240</span> from warehouse</span>
      <span className="k"><span className="sw it">240</span> from a container</span>
      <span className="k"><span className="sw po">240</span> from a purchase order</span>
      <span className="k"><span className="sw dr">240</span> draft · proposed, not allocated</span>
      <span className="k"><span className="sw av">240</span> free, not assigned yet</span>
      <span className="k" style={{ marginLeft: "auto" }}>Open a draft or a grey number, check it, then click <b style={{ color: "var(--ink)" }}>Allocate</b>.</span>
    </div>
  );
}
