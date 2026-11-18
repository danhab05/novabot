export function Login() {
  return (
    <div className="h-full flex items-center justify-center p-6 relative overflow-hidden">
      <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[700px] h-[500px] rounded-full opacity-40 blur-3xl pointer-events-none" style={{ background: "var(--grad)" }} />
      <div className="relative w-full max-w-sm card grad-border p-8 text-center pop-in" style={{ boxShadow: "var(--shadow-lg)" }}>
        <div className="mx-auto w-16 h-16 rounded-2xl grad-bg flex items-center justify-center mb-5 shadow-[0_16px_40px_-12px_rgba(99,102,241,.9)]">
          <span className="text-2xl font-bold">N</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight mb-1.5">Novabot</h1>
        <p className="text-fg2 mb-7 text-[14px]">Ton harness perso. Connecte-toi pour continuer.</p>
        <a href="/auth/discord" className="flex items-center justify-center gap-2 w-full rounded-xl h-11 font-medium text-white transition-all hover:brightness-110" style={{ background: "#5865F2", boxShadow: "0 10px 30px -10px rgba(88,101,242,.8)" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.6 1.3a18.4 18.4 0 0 0-5.6 0L8.6 3a19.7 19.7 0 0 0-4.9 1.4C.6 9 .1 13.6.3 18.1A19.9 19.9 0 0 0 6.4 21l1.3-1.8c-.7-.3-1.4-.6-2-1l.5-.4a14.2 14.2 0 0 0 12.2 0l.5.4c-.6.4-1.3.7-2 1l1.3 1.8a19.8 19.8 0 0 0 6-3c.4-5.2-.7-9.8-3.9-13.6ZM8.7 15.4c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Zm6.6 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Z"/></svg>
          Se connecter avec Discord
        </a>
        <p className="text-[11.5px] text-fg3 mt-5">Accès réservé au propriétaire et aux invités d'un projet.</p>
      </div>
    </div>
  );
}
