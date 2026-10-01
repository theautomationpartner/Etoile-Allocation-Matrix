// Rules of the "Users & access" screen (admins only), shared by the server (api/users.js, which
// enforces them) and the browser (which only uses them to explain and pre-check).
// Everything is stored in the Access List board (see access.js): Status = Active | Inactive,
// Role = Admin | Member. Admin = uses the app and manages this list; Member = uses the app.

export const ROLES = ["Member", "Admin"];
export const STATUSES = ["Active", "Inactive"];
// Re-checked on every request with a short cache (api/_auth.js), so a change applies within this time.
export const TAKES_EFFECT = "within 30 seconds";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (s) => EMAIL.test(String(s || "").trim());
export const normEmail = (s) => String(s || "").trim().toLowerCase();

export const isActiveAdmin = (row) => row.status === "Active" && row.role === "Admin";

// Why a role/status change cannot be made (English, shown as is), or null when it can.
//   rows: the list as it is NOW in monday · me: monday user id of the admin making the change
export function changeProblem(rows, me, { itemId, field, value }) {
  const row = rows.find((r) => r.itemId === String(itemId));
  if (!row) return "That user is no longer in the list. Reload the page.";
  if (field === "role" && !ROLES.includes(value)) return "Unknown role.";
  if (field === "status" && !STATUSES.includes(value)) return "Unknown status.";
  if (field !== "role" && field !== "status") return "Unknown change.";
  if (row[field] === value) return null;
  const mine = row.userId === String(me);
  const losesAdmin = isActiveAdmin(row) && ((field === "role" && value !== "Admin") || (field === "status" && value !== "Active"));
  if (mine && field === "status" && value !== "Active") return "You can't remove your own access. Ask another admin.";
  if (mine && losesAdmin) return "You can't remove your own Admin role. Ask another admin.";
  if (losesAdmin && rows.filter(isActiveAdmin).length <= 1) return "This is the only active admin: the list would have nobody to manage it.";
  return null;
}

// Why this monday user cannot be added, or null. account: users of the monday account.
export function addProblem(rows, accountUser) {
  if (!accountUser) return "That user is not in the monday account.";
  if (rows.some((r) => r.userId === accountUser.id)) return "This user is already in the list: change their access there.";
  if (accountUser.guest) return "Guests of the monday account can't use the app.";
  if (!accountUser.enabled) return "This user is deactivated in monday.";
  return null;
}
