import { ALLOCATION_SOURCE, createMondayApi, fetchTransport } from "./lib/monday.js";

// Where confirmed allocations are read from until the client confirms (open point in the prompt txt):
//   "subitem-json" → long_text_mm4kee9f on the Wholesale subitems (current Allocation Queue, PDF §14)
//   "ledger"       → 🔗 Allocation Ledger - Monday Vibe (18430965833), group Active
export const allocationSource = import.meta.env.VITE_ALLOCATION_SOURCE === ALLOCATION_SOURCE.LEDGER
  ? ALLOCATION_SOURCE.LEDGER
  : ALLOCATION_SOURCE.SUBITEM_JSON;

// In monday Vibe this becomes: createMondayApi((q, v) => monday.api(q, { variables: v }).then((r) => r.data))
export const mondayApi = createMondayApi(fetchTransport);
