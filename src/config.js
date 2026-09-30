import { ALLOCATION_SOURCE, createMondayApi, fetchTransport } from "./lib/monday.js";

// Where confirmed allocations are read from (client decision, 2026-09-30: the Allocation Ledger):
//   "ledger"       → 🔗 Allocation Ledger - Monday Vibe (18430965833), group Active, linked from each
//                    Wholesale subitem by board_relation_mm7pqf7j; one Ledger subitem per source
//   "subitem-json" → legacy long_text_mm4kee9f on the Wholesale subitems (before the migration)
export const allocationSource = import.meta.env.VITE_ALLOCATION_SOURCE === ALLOCATION_SOURCE.SUBITEM_JSON
  ? ALLOCATION_SOURCE.SUBITEM_JSON
  : ALLOCATION_SOURCE.LEDGER;

// In monday Vibe this becomes: createMondayApi((q, v) => monday.api(q, { variables: v }).then((r) => r.data))
export const mondayApi = createMondayApi(fetchTransport);
