// Who is using the app: the verified monday user, as listed in the whitelist board.
// Also stamps "Last Access" on the user's whitelist item (once per app load).

import { guarded, serverMonday } from "./_auth.js";
import { ACCESS_LIST } from "../src/lib/access.js";

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export const GET = guarded(async (_request, { user }) => {
  let photo = "";
  try {
    const d = await serverMonday(`query($i:[ID!]){ users(ids:$i){ photo_thumb_small } }`, { i: [user.userId] });
    photo = d?.users?.[0]?.photo_thumb_small || "";
  } catch {
    /* the avatar falls back to initials */
  }
  try {
    const now = new Date().toISOString();
    await serverMonday(`mutation($b:ID!,$i:ID!,$v:JSON!){ change_multiple_column_values(board_id:$b, item_id:$i, column_values:$v){ id } }`, {
      b: ACCESS_LIST.board,
      i: user.itemId,
      v: JSON.stringify({ [ACCESS_LIST.col.lastAccess]: { date: now.slice(0, 10), time: now.slice(11, 19) } }),
    });
  } catch (e) {
    console.warn("[me] could not stamp Last Access", e?.message);
  }
  return json(200, { userId: user.userId, name: user.name, email: user.email, role: user.role, photo });
});
