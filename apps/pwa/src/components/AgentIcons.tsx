// Icônes génériques (pas de logos de marque) pour distinguer les deux familles d'agents.
export function ClaudeIcon({ size = 15 }: { size?: number }) {
  // étoile à rayons : « agent de raisonnement »
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <defs><linearGradient id="nb-cl" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#f6a76b" /><stop offset="1" stopColor="#e3735a" /></linearGradient></defs>
      {[0, 30, 60, 90, 120, 150].map((a) => <rect key={a} x="11" y="2.5" width="2" height="19" rx="1" fill="url(#nb-cl)" transform={`rotate(${a} 12 12)`} />)}
    </svg>
  );
}
export function CodexIcon({ size = 15 }: { size?: number }) {
  // invite de commande dans un hexagone : « agent de code »
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <defs><linearGradient id="nb-cx" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#6ee7b7" /><stop offset="1" stopColor="#3b82f6" /></linearGradient></defs>
      <path d="M12 2.5 20.2 7.2v9.6L12 21.5l-8.2-4.7V7.2L12 2.5Z" stroke="url(#nb-cx)" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="m8.5 10 2.5 2-2.5 2M12.5 14.5h3" stroke="url(#nb-cx)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
