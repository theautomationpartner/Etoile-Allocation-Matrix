import { useEffect, useRef, useState } from "react";
import { setLeaveOpener, useActiveGuards } from "../lib/leaveGuard.js";

const KEY = "etoileLeaveGuard";
const isGuard = (state) => Boolean(state && state[KEY]);

// Keeps unsaved work from being lost by leaving the app by accident (lib/leaveGuard.js holds what is open):
// - Reload (F5, Ctrl+R), closing the tab or the window (×, Ctrl+W, Alt+F4) or typing another address: the
//   browser's own "Leave site?" prompt. Browsers don't let a page change its text or replace it with its own.
// - Back / forward (trackpad swipe, mouse side buttons, Alt+←): an extra history entry sits on top while there is
//   unsaved work, so the first "back" stays in the app and opens this warning instead.
// - In-app actions that would drop the work (Refresh, switching screens, closing a filled form): the same warning,
//   through confirmLeave / confirmDiscard.
export function LeaveGuard() {
  const active = useActiveGuards();
  const has = active.length > 0;
  const live = useRef(active);
  live.current = active;
  const [ask, setAsk] = useState(null); // { list, title, action, resolve }
  const askRef = useRef(null);
  askRef.current = ask;
  const leaving = useRef(false); // "Leave anyway" was chosen: the browser's own prompt must not follow
  const armed = useRef(typeof history !== "undefined" && isGuard(history.state)); // our entry is on top

  const open = (req) => new Promise((resolve) => {
    askRef.current?.resolve(false);
    setAsk({ ...req, resolve });
  });
  useEffect(() => {
    setLeaveOpener(open);
    return () => setLeaveOpener(null);
  }, []);
  const answer = (ok) => {
    ask?.resolve(ok);
    setAsk(null);
  };

  // Reload / close / another address.
  useEffect(() => {
    if (!has) return undefined;
    const warn = (e) => {
      if (leaving.current) return undefined;
      e.preventDefault();
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [has]);

  // Back / forward: put our entry on top while something is unsaved.
  useEffect(() => {
    if (!has || isGuard(history.state)) {
      if (has) armed.current = true;
      return;
    }
    history.pushState({ [KEY]: true }, "");
    armed.current = true;
  }, [has]);
  useEffect(() => {
    const onPop = (e) => {
      if (isGuard(e.state)) return; // forward onto our entry again: nothing to do
      if (!armed.current) return; // not ours
      armed.current = false;
      if (!live.current.length) {
        history.back(); // saved meanwhile: our entry is spent, finish the "back" the person asked for
        return;
      }
      history.pushState({ [KEY]: true }, ""); // stay in the app, then ask
      armed.current = true;
      open({ list: live.current, title: "Leave without saving?", action: "Leave anyway" }).then((ok) => {
        if (!ok) return;
        leaving.current = true;
        armed.current = false;
        history.go(-2); // past our entry and the app's own one
        setTimeout(() => { // still here (nothing to go back to): stay guarded
          leaving.current = false;
          if (isGuard(history.state)) armed.current = true;
        }, 1500);
      });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Esc = Stay. Captured first so the screen behind (which closes its own editor or form on Esc) doesn't see it.
  useEffect(() => {
    if (!ask) return undefined;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      answer(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ask) return null;
  return (
    <>
      <div className="scrim on leave-scrim" onClick={() => answer(false)} />
      <div className="ua-dlg leave-dlg" role="alertdialog" aria-modal="true" aria-labelledby="leave-dlg-t" aria-describedby="leave-dlg-d">
        <h3 id="leave-dlg-t"><span aria-hidden="true">⚠</span> {ask.title || "Leave without saving?"}</h3>
        <p id="leave-dlg-d">{ask.list.length === 1 ? "This isn't saved yet and will be lost:" : "These aren't saved yet and will be lost:"}</p>
        <ul className="leave-list">
          {ask.list.map((g, i) => <li key={i}>{g.what}</li>)}
        </ul>
        <div className="ua-dlg-b">
          <button type="button" className="btn on" onClick={() => answer(false)} autoFocus>Stay</button>
          <button type="button" className="btn danger" onClick={() => answer(true)}>{ask.action || "Leave anyway"}</button>
        </div>
      </div>
    </>
  );
}
