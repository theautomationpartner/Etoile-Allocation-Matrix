// /api/users — "Users & access" (admins only): manage the Access List board from the app.
//
//   GET                                         the list as it is NOW in monday + the monday account's users
//   POST { action: "add", userId, role }        add a user who is already in monday (Active)
//   POST { action: "invite", email, name, role } invite someone to monday (as a monday Member) and add them (Active)
//   POST { action: "role", itemId, role }       Admin | Member
//   POST { action: "status", itemId, status }   Active | Inactive
//
// The caller must be an Active Admin of the list (checked here, on every request — hiding the screen
// is not the protection). The rules (nobody removes their own access or Admin role, the list always
// keeps one active Admin) are in src/lib/userAdmin.js and are checked against the live board.
// Each change is also written as an update on the user's item: what changed and which admin did it.

import { forgetWhitelistUser, guarded, serverMonday } from "./_auth.js";
import { ACCESS_LIST } from "../src/lib/access.js";
import { addProblem, changeProblem, isEmail, normEmail, ROLES } from "../src/lib/userAdmin.js";

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const fail = (status, error) => json(status, { error });

const c = ACCESS_LIST.col;
const B = ACCESS_LIST.board;

// The Access List, read live (no cache): the admin must see what is there now.
async function readRows() {
  const rows = [];
  const fields = `cursor items { id name column_values(ids:["${c.status}","${c.role}","${c.userId}","${c.email}","${c.lastAccess}"]) { id text value } }`;
  let page = (await serverMonday(`query($b:[ID!]){ boards(ids:$b){ items_page(limit:500){ ${fields} } } }`, { b: [B] })).boards[0].items_page;
  for (;;) {
    for (const it of page.items) {
      const col = (id) => it.column_values.find((x) => x.id === id) || {};
      let lastAccess = null;
      try {
        const v = JSON.parse(col(c.lastAccess).value || "null");
        if (v?.date) lastAccess = `${v.date}T${v.time || "00:00:00"}Z`; // stored in UTC
      } catch {
        /* no date */
      }
      rows.push({
        itemId: String(it.id),
        name: it.name,
        userId: (col(c.userId).text || "").trim(),
        email: (col(c.email).text || "").trim(),
        status: col(c.status).text || "",
        role: col(c.role).text === "Admin" ? "Admin" : "Member",
        lastAccess,
      });
    }
    if (!page.cursor) break;
    page = (await serverMonday(`query($c:String!){ next_items_page(limit:500, cursor:$c){ ${fields} } }`, { c: page.cursor })).next_items_page;
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name, "en"));
}

// Every user of the monday account, deactivated ones included (marked) so the picker can say why they
// can't be chosen. monday only returns deactivated users when asked (non_active); from that list,
// pending entries are cancelled or expired invitations, never real users.
const USER_FIELDS = "id name email enabled is_guest is_pending is_view_only";
async function accountUsers() {
  const d = await serverMonday(`{ active: users(limit:500){ ${USER_FIELDS} } inactive: users(limit:500, non_active:true){ ${USER_FIELDS} } }`);
  // Deleted accounts stay in monday as "Deleted member" with an …@deleted.user email: not people to pick.
  const real = (u) => !String(u.email || "").endsWith("@deleted.user");
  const byId = new Map([...(d.active || []), ...(d.inactive || []).filter((u) => !u.is_pending)].filter(real).map((u) => [String(u.id), u]));
  return [...byId.values()]
    .map((u) => ({ id: String(u.id), name: u.name, email: u.email || "", enabled: Boolean(u.enabled), guest: Boolean(u.is_guest), pending: Boolean(u.is_pending) }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
}

const setColumns = (itemId, values) =>
  serverMonday(`mutation($b:ID!,$i:ID!,$v:JSON!){ change_multiple_column_values(board_id:$b, item_id:$i, column_values:$v){ id } }`, {
    b: B, i: String(itemId), v: JSON.stringify(values),
  });

async function createRow({ name, userId, email, role }) {
  const base = { [c.status]: { label: "Active" }, [c.role]: { label: role }, [c.userId]: String(userId), [c.email]: email || "" };
  const create = (v) =>
    serverMonday(`mutation($b:ID!,$n:String!,$v:JSON!){ create_item(board_id:$b, item_name:$n, column_values:$v){ id } }`, { b: B, n: name, v: JSON.stringify(v) });
  try {
    return (await create({ ...base, [c.person]: { personsAndTeams: [{ id: Number(userId), kind: "person" }] } })).create_item.id;
  } catch (e) {
    // A just-invited user (invitation not accepted yet) may not be assignable to a People column.
    console.warn("[users] create with Person failed, retrying without it:", e.message);
    return (await create(base)).create_item.id;
  }
}

// Who changed what, as an update on the user's item (visible in monday). Never blocks the change.
async function logChange(itemId, text, admin) {
  try {
    await serverMonday(`mutation($i:ID!,$t:String!){ create_update(item_id:$i, body:$t){ id } }`, {
      i: String(itemId), t: `${text} — by ${admin.name} (Users & access, Allocation Matrix app).`,
    });
  } catch (e) {
    console.warn("[users] could not log the change", e.message);
  }
}

// Invites the email to monday as a Member (guests can't use the app). If monday already knows the
// email, nobody is invited again and that user's id is returned.
async function inviteToMonday(email) {
  const d = await serverMonday(
    `mutation($e:[String!]!){ invite_users(emails:$e, user_role:MEMBER){ invited_users { id email } errors { message code email } } }`,
    { e: [email] },
  );
  const invited = d.invite_users?.invited_users?.[0];
  if (invited?.id) return { id: String(invited.id), invited: true };
  const found = (await serverMonday(`query($e:[String]){ users(emails:$e){ id } }`, { e: [email] })).users?.[0];
  if (found?.id) return { id: String(found.id), invited: false };
  throw new Error(d.invite_users?.errors?.[0]?.message || `monday could not invite ${email}.`);
}

const adminOnly = (handler) =>
  guarded(async (request, ctx) => {
    if (ctx.user.role !== "admin") return fail(403, "Only admins can manage users.");
    try {
      return await handler(request, ctx);
    } catch (e) {
      console.error("[users]", e);
      return fail(502, `monday did not answer as expected: ${e.message}`);
    }
  });

export const GET = adminOnly(async (_request, { user }) => {
  const [rows, account] = await Promise.all([readRows(), accountUsers()]);
  return json(200, { rows, account, me: user.userId });
});

export const POST = adminOnly(async (request, { user }) => {
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return fail(400, "Body must be JSON.");
  }
  const rows = await readRows(); // rules are checked against the board as it is now
  const action = body?.action;

  if (action === "role" || action === "status") {
    const field = action;
    const value = String(body[field] ?? "");
    const problem = changeProblem(rows, user.userId, { itemId: body.itemId, field, value });
    if (problem) return fail(409, problem);
    const row = rows.find((r) => r.itemId === String(body.itemId));
    if (row[field] === value) return json(200, { ok: true, row });
    await setColumns(row.itemId, { [field === "role" ? c.role : c.status]: { label: value } });
    if (row.userId) forgetWhitelistUser(row.userId);
    await logChange(row.itemId, field === "role" ? `Role changed from ${row.role} to ${value}` : `App access changed from ${row.status || "(empty)"} to ${value}`, user);
    return json(200, { ok: true, row: { ...row, [field]: value } });
  }

  if (action === "add" || action === "invite") {
    const role = ROLES.includes(body.role) ? body.role : "Member";
    let target;
    let invited = false;
    if (action === "add") {
      const account = await accountUsers();
      target = account.find((u) => u.id === String(body.userId ?? ""));
      const problem = addProblem(rows, target);
      if (problem) return fail(409, problem);
    } else {
      const email = normEmail(body.email);
      const name = String(body.name ?? "").trim();
      if (!name) return fail(400, "Enter the person's name.");
      if (!isEmail(email)) return fail(400, "Check the email address.");
      if (rows.some((r) => normEmail(r.email) === email)) return fail(409, "This email is already in the list: change their access there.");
      const known = (await accountUsers()).find((u) => normEmail(u.email) === email);
      if (known) {
        const problem = addProblem(rows, known);
        if (problem) return fail(409, problem);
        target = { ...known, name };
      } else {
        const res = await inviteToMonday(email).catch((e) => ({ error: e.message }));
        if (res.error) return fail(502, `monday did not send the invitation: ${res.error}`);
        if (rows.some((r) => r.userId === res.id)) return fail(409, "This user is already in the list: change their access there.");
        target = { id: res.id, name, email };
        invited = res.invited;
      }
    }
    const itemId = await createRow({ name: target.name, userId: target.id, email: target.email, role });
    forgetWhitelistUser(target.id);
    await logChange(itemId, invited ? `Invited to monday and added to the app (Active · ${role})` : `Added to the app (Active · ${role})`, user);
    return json(200, { ok: true, invited, row: { itemId: String(itemId), name: target.name, userId: target.id, email: target.email, status: "Active", role, lastAccess: null } });
  }

  return fail(400, "Unknown action.");
});
