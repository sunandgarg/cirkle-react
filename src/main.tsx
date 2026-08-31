import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { initializeTheme } from "@/lib/theme";
import { configureErrorTelemetryTransport, createSupabaseErrorTransport, installGlobalErrorTelemetry, reportError } from "@/lib/errorTelemetry";
import { supabase } from "@/integrations/supabase/client";

initializeTheme();
configureErrorTelemetryTransport(createSupabaseErrorTransport((name, args) => (supabase as any).rpc(name, args)));
installGlobalErrorTelemetry();

createRoot(document.getElementById("root")!).render(<App />);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      reportError(error, { flow: "application_startup", action: "register_service_worker", severity: "warning" });
    });
  });
}
