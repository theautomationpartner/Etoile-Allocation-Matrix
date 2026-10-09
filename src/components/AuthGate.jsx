import { useEffect, useState } from "react";
import { DENIED_EVENT, fetchMe, NotAuthorizedError } from "../lib/auth.js";
import { NOT_AUTHORIZED_MESSAGE } from "../lib/access.js";

const CACHE_PREFIXES = ["etoile-matrix-cache", "etoile-parts-cache"]; // monday data kept in the browser

// Nothing of the app renders until the server confirms who is signed in and that they are Active in
// the access list. Outside monday, or for anyone not listed, only the generic message is shown.
export function AuthGate({ children }) {
  const [state, setState] = useState({ status: "checking", user: null });

  useEffect(() => {
    let alive = true;
    const lock = () => {
      // Drop anything cached on this device and show only the message.
      try {
        Object.keys(localStorage).filter((k) => CACHE_PREFIXES.some((pre) => k.startsWith(pre))).forEach((k) => localStorage.removeItem(k));
      } catch {
        /* storage unavailable */
      }
      if (alive) setState({ status: "denied", user: null });
    };
    window.addEventListener(DENIED_EVENT, lock);
    fetchMe()
      .then((user) => alive && setState({ status: "ok", user }))
      .catch((e) => (e instanceof NotAuthorizedError ? lock() : alive && setState({ status: "error", user: null })));
    return () => {
      alive = false;
      window.removeEventListener(DENIED_EVENT, lock);
    };
  }, []);

  if (state.status === "ok") return children(state.user);
  return (
    <div className="gate">
      <div className="gate-card">
        <h1>Etoile Flow</h1>
        {state.status === "checking" && <p>Checking access…</p>}
        {state.status === "denied" && <p>{NOT_AUTHORIZED_MESSAGE}</p>}
        {state.status === "error" && (
          <p>
            The app could not be reached. Try again in a moment.{" "}
            <button type="button" className="btn" onClick={() => window.location.reload()}>Try again</button>
          </p>
        )}
      </div>
    </div>
  );
}

// Signed-in user, top right: avatar (monday photo or initials) + name.
export function UserChip({ user }) {
  if (!user) return null;
  const initials = user.name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  return (
    <div className="user-chip" title={`${user.name}${user.email ? ` · ${user.email}` : ""} · ${user.role === "admin" ? "Admin" : "Member"}`}>
      {user.photo ? <img src={user.photo} alt="" /> : <span className="av">{initials}</span>}
      <span className="nm">{user.name}</span>
      {user.role === "admin" && <span className="rl">Admin</span>}
    </div>
  );
}
