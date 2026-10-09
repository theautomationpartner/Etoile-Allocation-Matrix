// Header search + Enter (requirements "Conexiones transversales" §3.1): the app asks the open screen to show a record
// in its side panel — { n, type, id }; each new n opens it once, starting a new breadcrumb.
import { useEffect, useRef } from "react";

export function usePanelRequest(request, open) {
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (request) openRef.current(request.type, request.id);
  }, [request?.n]); // eslint-disable-line react-hooks/exhaustive-deps
}
