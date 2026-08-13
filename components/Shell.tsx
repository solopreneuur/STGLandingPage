/** Narrow mobile-first column. The feed opts out of this deliberately. */
export default function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-[480px] flex-col px-6 pt-6 pb-[22px]">
      {children}
    </div>
  );
}
