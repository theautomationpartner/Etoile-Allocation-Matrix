import { useEffect, useId, useSyncExternalStore } from "react";

// Unsaved work that leaving would lose: a shipment not saved yet, an allocation being typed, a packing list form
// filled in. While any is open, leaving the app asks first (components/LeaveGuard.jsx). Each guard says what is at
// stake and what else drops it: refresh (a Refresh reads monday again and resets it), screen (switching screens
// unmounts it).
const guards = new Map(); // id → { what, refresh, screen }
const subscribers = new Set();
let snapshot = [];
const emit = () => {
  snapshot = [...guards.values()];
  subscribers.forEach((fn) => fn());
};

export function useLeaveGuard(active, what, { refresh = false, screen = false } = {}) {
  const id = useId();
  useEffect(() => {
    if (!active) return undefined;
    guards.set(id, { what, refresh, screen });
    emit();
    return () => {
      guards.delete(id);
      emit();
    };
  }, [id, active, what, refresh, screen]);
}

const subscribe = (fn) => {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
};
export const useActiveGuards = () => useSyncExternalStore(subscribe, () => snapshot);
export const activeGuards = () => snapshot;

// The open warning (LeaveGuard registers it). ask({ list, title, action }) → Promise<boolean>: true = go on and lose it.
let opener = null;
export const setLeaveOpener = (fn) => { opener = fn; };

// Before an in-app action that would drop unsaved work: asks only when a guard of that kind is open.
// kind: "refresh" | "screen" | undefined (every guard). Resolves true when the action may go on.
export function confirmLeave(kind, { title, action } = {}) {
  const list = snapshot.filter((g) => !kind || g[kind]);
  if (!list.length) return Promise.resolve(true);
  return opener ? opener({ list, title, action }) : Promise.resolve(window.confirm(`${title || "Leave without saving?"}\n\n${list.map((g) => g.what).join("\n")}`));
}

// The same warning for a single piece of work (closing a form, switching the line being allocated).
export function confirmDiscard(what, { title, action } = {}) {
  const list = [{ what }];
  return opener ? opener({ list, title, action }) : Promise.resolve(window.confirm(`${title || "Discard your changes?"}\n\n${what}`));
}
