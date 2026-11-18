import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { boot } from "./lib/actions";
import { applyTheme } from "./lib/theme";

applyTheme();

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
boot();

if ("serviceWorker" in navigator && location.hostname !== "localhost") {
  window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch(() => {}); });
}
