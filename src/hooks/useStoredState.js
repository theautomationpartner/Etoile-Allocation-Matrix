import { useEffect, useState } from "react";

// State mirrored in localStorage for per-viewer conveniences (menu collapsed, theme).
// Storage can be unavailable (private mode): the app keeps working with the in-memory value.
export function useStoredState(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved === null ? initial : JSON.parse(saved);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  }, [key, value]);
  return [value, setValue];
}
