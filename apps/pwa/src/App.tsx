import { lazy, Suspense, useEffect, useState } from "react";
import { useStore, store } from "./lib/store";
import { Login } from "./components/Login";
import { Sidebar } from "./components/Sidebar";
import { ThreadView } from "./components/ThreadView";
import { RightPanel } from "./components/RightPanel";
import { MobileNav } from "./components/MobileNav";
import { Toasts } from "./components/Toasts";
import { openDeepLink } from "./lib/actions";
import { startSessionsPolling } from "./lib/sessions";

const Cockpit = lazy(() => import("./components/Cockpit"));
const CommandPalette = lazy(() => import("./components/CommandPalette"));

function useIsDesktop() {
  const q = "(min-width: 768px)";
  const [d, setD] = useState(() => matchMedia(q).matches);
  useEffect(() => { const m = matchMedia(q); const f = () => setD(m.matches); m.addEventListener("change", f); return () => m.removeEventListener("change", f); }, []);
  return d;
}

export function App() {
  const auth = useStore((s) => s.authState);
  if (auth === "loading") return <Splash />;
  if (auth === "out") return <Login />;
  return <Shell />;
}

function Splash() {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4">
      <div className="orb orb-think" style={{ width: 44, height: 44, borderRadius: 14 }} />
      <div className="text-fg3 text-[13px]">Novabot</div>
    </div>
  );
}

function Shell() {
  const desktop = useIsDesktop();
  const view = useStore((s) => s.view);
  const panelOpen = useStore((s) => s.panelOpen);
  const tab = useStore((s) => s.mobileTab);
  const palette = useStore((s) => s.paletteOpen);
  const isAdmin = useStore((s) => s.user?.role === "admin");
  const wide = useStore((s) => s.panelWide && s.panel === "sessions");

  useEffect(() => { openDeepLink(location.pathname); }, []);
  useEffect(() => { if (isAdmin) startSessionsPolling(); }, [isAdmin]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); store.set((s) => ({ paletteOpen: !s.paletteOpen })); }
      else if (e.key === "Escape" && store.get().paletteOpen) store.set({ paletteOpen: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const main = view === "cockpit"
    ? <Suspense fallback={<Splash />}><Cockpit /></Suspense>
    : <ThreadView />;
  const paletteEl = palette && <Suspense fallback={null}><CommandPalette /></Suspense>;

  if (desktop) {
    const side = panelOpen && view !== "cockpit";
    return (
      <div className="h-full grid overflow-hidden" style={{ gridTemplateRows: "100%", gridTemplateColumns: `272px minmax(0,1fr)${side ? (wide ? " minmax(480px, 64%)" : " minmax(360px, 38%)") : ""}` }}>
        <Sidebar />
        {main}
        {side && <RightPanel />}
        <Toasts />
        {paletteEl}
      </div>
    );
  }
  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0">
        {tab === "projects" && <Sidebar />}
        {tab === "thread" && <ThreadView />}
        {tab === "tasks" && <RightPanel only={["tasks", "terminal"]} mobile />}
        {tab === "sessions" && <RightPanel only={["sessions"]} mobile />}
        {tab === "browser" && <RightPanel only={["browser"]} mobile />}
        {tab === "cockpit" && <Suspense fallback={<Splash />}><Cockpit /></Suspense>}
      </div>
      {tab !== "sessions" && <MobileNav />}
      <Toasts />
      {paletteEl}
    </div>
  );
}

// réexport pour les tests
export { store };
