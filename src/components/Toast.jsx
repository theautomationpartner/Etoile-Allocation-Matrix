import { useCallback, useEffect, useRef, useState } from "react";

export function useToast() {
  const [message, setMessage] = useState("");
  const [visible, setVisible] = useState(false);
  const timer = useRef(null);
  const show = useCallback((msg) => {
    setMessage(msg);
    setVisible(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setVisible(false), 3600);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { message, visible, show };
}

export function Toast({ message, visible }) {
  return (
    <div className={`toast ${visible ? "on" : ""}`} role="status">
      {message}
    </div>
  );
}
