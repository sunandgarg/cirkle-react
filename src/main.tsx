import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { initializeTheme } from "@/lib/theme";
import { configureErrorTelemetryTransport, createSupabaseErrorTransport, installGlobalErrorTelemetry, reportError } from "@/lib/errorTelemetry";
import { supabase } from "@/integrations/supabase/client";

initializeTheme();
configureErrorTelemetryTransport(createSupabaseErrorTransport((name, args) => (supabase as any).rpc(name, args)));
installGlobalErrorTelemetry();

// A deployment replaces content-hashed lazy chunks. If a tab kept an older
// HTML document open, Vite emits this event when that old chunk no longer
// exists. Reload exactly once so the browser picks up the current asset map
// instead of leaving the member inside an error boundary.
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  const key = "cirkle:preload-recovery";
  if (sessionStorage.getItem(key)) return;
  sessionStorage.setItem(key, new Date().toISOString());
  window.location.reload();
});
window.addEventListener("pageshow", () => {
  const key = "cirkle:preload-recovery";
  const recoveredAt = Date.parse(sessionStorage.getItem(key) || "");
  if (Number.isFinite(recoveredAt) && Date.now() - recoveredAt > 60_000) sessionStorage.removeItem(key);
});

createRoot(document.getElementById("root")!).render(<App />);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      reportError(error, { flow: "application_startup", action: "register_service_worker", severity: "warning" });
    });
  });
}
