import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addUser, inviteUser, loadUsers, setRole, setStatus } from "../../lib/usersApi.js";
import { addProblem, changeProblem, isEmail, TAKES_EFFECT } from "../../lib/userAdmin.js";

// "Users & access" (admins only): who can open the app and with which role, stored in the Access
// List board. Admins add someone who is already in monday, or invite them by email, and change Role
// (Admin / Member) or App access (Active / Inactive) — every change asks for confirmation first.
// The server re-checks everything (api/users.js); the checks here only explain it up front.

const initials = (name) => name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
const when = (iso) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "Never";
const matches = (q, ...fields) => !q || fields.some((f) => String(f || "").toLowerCase().includes(q));

export function UsersAccess({ search, toast }) {
  const [data, setData] = useState(null); // { rows, account, me }
  const [status, setStatusState] = useState("loading"); // loading | ready | error
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(null); // itemId being saved
  const [confirm, setConfirm] = useState(null); // { row, field, value }
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setStatusState((s) => (s === "ready" ? "ready" : "loading"));
    setError("");
    try {
      setData(await loadUsers());
      setStatusState("ready");
    } catch (e) {
      setError(e.message);
      setStatusState((s) => (s === "ready" ? "ready" : "error"));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const account = useMemo(() => new Map((data?.account || []).map((u) => [u.id, u])), [data]);
  const q = search.trim().toLowerCase();
  const rows = (data?.rows || []).filter((r) => matches(q, r.name, r.email));
  const active = (data?.rows || []).filter((r) => r.status === "Active").length;
  const inactive = (data?.rows || []).length - active;

  const ask = (row, field, value) => {
    if (row[field] === value || (field === "status" && value === "Inactive" && row.status !== "Active")) return;
    setConfirm({ row, field, value, problem: changeProblem(data.rows, data.me, { itemId: row.itemId, field, value }) });
  };

  const apply = async ({ row, field, value }) => {
    setConfirm(null);
    setBusy(row.itemId);
    try {
      const res = await (field === "role" ? setRole(row.itemId, value) : setStatus(row.itemId, value));
      setData((d) => ({ ...d, rows: d.rows.map((r) => (r.itemId === row.itemId ? res.row : r)) }));
      toast(field === "role" ? `${row.name} is now ${value === "Admin" ? "an Admin" : "a Member"}.` : value === "Active" ? `${row.name} can open the app now.` : `${row.name} no longer has access to the app.`);
    } catch (e) {
      toast(e.message);
      load(); // show what is really in monday now
    } finally {
      setBusy(null);
    }
  };

  const added = (res) => {
    setAdding(false);
    setData((d) => ({ ...d, rows: [...d.rows, res.row].sort((a, b) => a.name.localeCompare(b.name, "en")) }));
    toast(res.invited ? `Invitation sent. ${res.row.name} can open the app once they accept it.` : `${res.row.name} was added and can open the app now.`);
    load(); // refresh the monday account list (a new invite is pending there)
  };

  return (
    <div className="ua">
      <div className="page-h">
        <div>
          <h2>Users &amp; access</h2>
          <p>Who can open this app and what they can do. Admins use the app and manage this list; Members use the app. Changes are saved to the Access List board in monday and apply {TAKES_EFFECT}.</p>
        </div>
      </div>

      <div className="mx-bar">
        {data && (
          <>
            <span className="chip wh"><span className="sq" />{active} active</span>
            <span className="chip mut">{inactive} inactive</span>
          </>
        )}
        <span className="spacer" />
        <button type="button" className="btn" onClick={load} disabled={status === "loading"}>Refresh</button>
        <button type="button" className="btn on ua-add" onClick={() => setAdding(true)} disabled={!data}>+ Add user</button>
      </div>

      {error && status === "ready" && <div className="note warn">{error}</div>}

      <div className="card ua-card">
        {status === "loading" && <div className="mx-empty">Loading users from monday…</div>}
        {status === "error" && (
          <div className="mx-empty">
            {error} <button type="button" className="btn" onClick={load}>Try again</button>
          </div>
        )}
        {status === "ready" && (
          <div className="ua-scroll">
            <table className="ua-t">
              <thead>
                <tr><th>Name</th><th>Email</th><th>Role</th><th>App access</th><th>Last access</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const mine = r.userId === data.me;
                  const acc = account.get(r.userId);
                  const saving = busy === r.itemId;
                  const on = r.status === "Active";
                  return (
                    <tr key={r.itemId} className={on ? "" : "off"} data-item={r.itemId}>
                      <td>
                        <div className="ua-who">
                          <span className="av">{initials(r.name)}</span>
                          <b>{r.name}</b>
                          {mine && <span className="chip mut">You</span>}
                          {!r.userId && <span className="chip gap">No monday user</span>}
                          {acc?.pending && <span className="chip po">Invitation pending</span>}
                          {acc && !acc.pending && !acc.enabled && <span className="chip gap">Deactivated in monday</span>}
                          {acc?.guest && <span className="chip gap">Guest in monday</span>}
                        </div>
                      </td>
                      <td className="ua-mut">{r.email || "—"}</td>
                      <td>
                        <div className="seg ua-seg" role="group" aria-label={`Role of ${r.name}`}>
                          {["Member", "Admin"].map((v) => (
                            <button key={v} type="button" className={r.role === v ? "on" : ""} aria-pressed={r.role === v}
                              disabled={Boolean(busy)} onClick={() => ask(r, "role", v)}>{v}</button>
                          ))}
                        </div>
                      </td>
                      <td>
                        <div className="seg ua-seg ua-st" role="group" aria-label={`App access of ${r.name}`}>
                          {["Active", "Inactive"].map((v) => {
                            const cur = (on ? "Active" : "Inactive") === v;
                            return (
                              <button key={v} type="button" className={cur ? `on ${v === "Active" ? "yes" : "no"}` : ""} aria-pressed={cur}
                                disabled={Boolean(busy)} onClick={() => ask(r, "status", v)}>{v}</button>
                            );
                          })}
                        </div>
                        {saving && <span className="ua-saving">Saving…</span>}
                      </td>
                      <td className="ua-mut">{when(r.lastAccess)}</td>
                    </tr>
                  );
                })}
                {!rows.length && (
                  <tr><td colSpan={5}><div className="mx-empty">{q ? `No user matches “${search.trim()}”.` : "The list is empty."}</div></td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {confirm && <ConfirmChange {...confirm} onCancel={() => setConfirm(null)} onConfirm={() => apply(confirm)} />}
      <AddUserRail open={adding} data={data} onClose={() => setAdding(false)} onAdded={added} />
    </div>
  );
}

// What will happen, before anything is written. When the rules forbid the change, it says why.
function ConfirmChange({ row, field, value, problem, onCancel, onConfirm }) {
  const ok = useRef(null);
  useEffect(() => {
    ok.current?.focus();
    const esc = (e) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onCancel]);

  const t =
    field === "role"
      ? value === "Admin"
        ? { title: `Make ${row.name} an Admin?`, text: `${row.name} will also be able to manage users and access (this screen).`, button: "Make Admin" }
        : { title: `Change ${row.name} to Member?`, text: `${row.name} keeps using the app but can no longer manage users and access.`, button: "Change to Member" }
      : value === "Active"
        ? { title: `Give ${row.name} access to the app?`, text: `${row.name} will be able to open the app as ${row.role} ${TAKES_EFFECT}.`, button: "Give access" }
        : { title: `Remove ${row.name}'s access?`, text: `${row.name} won't be able to open the app ${TAKES_EFFECT}. Their monday account is not affected and the shipments they saved stay as they are.`, button: "Remove access", danger: true };

  return (
    <>
      <div className="scrim on" onClick={onCancel} />
      <div className="ua-dlg" role="alertdialog" aria-modal="true" aria-labelledby="ua-dlg-t">
        <h3 id="ua-dlg-t">{problem ? "This change can't be made" : t.title}</h3>
        <p>{problem || t.text}</p>
        <div className="ua-dlg-b">
          {problem ? (
            <button ref={ok} type="button" className="btn" onClick={onCancel}>OK</button>
          ) : (
            <>
              <button type="button" className="btn" onClick={onCancel}>Cancel</button>
              <button ref={ok} type="button" className={`btn ${t.danger ? "danger" : "on"}`} onClick={onConfirm}>{t.button}</button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

// Side panel (the mockup's rail): add someone who is already in monday, or invite them by email.
function AddUserRail({ open, data, onClose, onAdded }) {
  const [tab, setTab] = useState("monday"); // monday | invite
  const [find, setFind] = useState("");
  const [pick, setPick] = useState(null);
  const [role, setRoleChoice] = useState("Member");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const findRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setTab("monday"); setFind(""); setPick(null); setRoleChoice("Member"); setName(""); setEmail(""); setError("");
    const t = setTimeout(() => findRef.current?.focus(), 60);
    const esc = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => { clearTimeout(t); window.removeEventListener("keydown", esc); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = data?.rows || [];
  const q = find.trim().toLowerCase();
  // People who can be added first; the rest (already listed, guests, deactivated) after, greyed out.
  const people = (data?.account || []).filter((u) => matches(q, u.name, u.email)).sort((a, b) => Boolean(addProblem(rows, a)) - Boolean(addProblem(rows, b)));

  const toInvite = () => {
    setTab("invite");
    setError("");
    if (isEmail(find)) setEmail(find.trim());
    else if (find.trim()) setName(find.trim());
  };

  const submit = async () => {
    setError("");
    if (tab === "monday" && !pick) return setError("Choose who to add.");
    if (tab === "invite" && !name.trim()) return setError("Enter the person's name.");
    if (tab === "invite" && !isEmail(email)) return setError("Check the email address.");
    setSaving(true);
    try {
      onAdded(await (tab === "monday" ? addUser(pick, role) : inviteUser(email.trim(), name.trim(), role)));
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className={`scrim ${open ? "on" : ""}`} onClick={onClose} />
      <aside className={`rail ua-rail ${open ? "on" : ""}`} aria-hidden={!open} aria-label="Add user">
        <div className="rail-top">
          <div className="rail-trail"><span>Users &amp; access</span><span>›</span><span className="cur">Add user</span></div>
          <button type="button" className="rail-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="rail-body">
          <div className="rail-h"><h3>Add user</h3></div>
          <p className="rail-sub">They get access to the app as soon as they are added (Active).</p>

          <div className="seg ua-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "monday"} className={tab === "monday" ? "on" : ""} onClick={() => { setTab("monday"); setError(""); }}>Already in monday</button>
            <button type="button" role="tab" aria-selected={tab === "invite"} className={tab === "invite" ? "on" : ""} onClick={() => { setTab("invite"); setError(""); }}>Invite by email</button>
          </div>

          {tab === "monday" ? (
            <div className="sec">
              <h4>monday user</h4>
              <input ref={findRef} className="ua-in" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Search by name or email" autoComplete="off" aria-label="Search a monday user" />
              <div className="rel ua-pick">
                {people.map((u) => {
                  const why = addProblem(rows, u);
                  const tag = rows.some((r) => r.userId === u.id) ? "In the list" : u.guest ? "Guest" : !u.enabled ? "Deactivated" : u.pending ? "Invitation pending" : null;
                  return (
                    <button key={u.id} type="button" className={`rel-row ${pick === u.id ? "on" : ""}`} disabled={Boolean(why)} title={why || undefined}
                      onClick={() => setPick(u.id)} aria-pressed={pick === u.id}>
                      <span className="av">{initials(u.name)}</span>
                      <span className="body"><span className="t">{u.name}</span><span className="m">{u.email || "No email"}</span></span>
                      {tag && <span className={`chip ${why ? "mut" : "po"}`}>{tag}</span>}
                    </button>
                  );
                })}
                {!people.length && <div className="empty-note">No one in monday matches “{find.trim()}”.</div>}
              </div>
              <p className="ua-hint">Not in monday yet? <button type="button" className="ua-link" onClick={toInvite}>Invite them by email</button></p>
            </div>
          ) : (
            <div className="sec">
              <h4>Invite to monday</h4>
              <label className="ua-f"><span>Name</span><input className="ua-in" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" autoComplete="off" /></label>
              <label className="ua-f"><span>Email</span><input className="ua-in" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" autoComplete="off" /></label>
              <div className="note">monday emails them an invitation. They join monday as a <b>Member</b> (it uses a monday seat) and can open the app once they accept it. If the email is already in monday, nobody is invited again.</div>
            </div>
          )}

          <div className="sec">
            <h4>Role in the app</h4>
            <div className="seg ua-seg" role="group" aria-label="Role">
              {["Member", "Admin"].map((v) => (
                <button key={v} type="button" className={role === v ? "on" : ""} aria-pressed={role === v} onClick={() => setRoleChoice(v)}>{v}</button>
              ))}
            </div>
            <p className="ua-hint">{role === "Admin" ? "Uses the app and manages users and access." : "Uses the app."}</p>
          </div>

          {error && <div className="note warn ua-err">{error}</div>}

          <div className="ua-rail-b">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn on" onClick={submit} disabled={saving}>
              {saving ? "Saving…" : tab === "monday" ? "Add user" : "Send invitation"}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
