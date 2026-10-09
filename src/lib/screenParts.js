// The monday data parts (≈ boards, see DATA_PARTS in monday.js) behind each screen: its Refresh button reads these
// again from monday, and its "read at" line shows when the oldest of them was read. The other parts come from the
// server's cache (refreshed every 6 h).
import { DATA_PARTS } from "./monday.js";

export const SCREEN_PARTS = {
  home: DATA_PARTS, // the Control center sums every board
  matrix: DATA_PARTS, // the matrix uses every board
  wholesale: ["orders", "fulfilledOrders", "ledger"],
  transit: ["containers", "ledger"],
  po: ["pos"],
  sku: ["warehouse"],
  importer: ["imports", "containers"],
};
