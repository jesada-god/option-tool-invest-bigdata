export function ListItem({ title, detail }: { title: string; detail?: string }) { return <div className="row"><div className="row-copy"><strong>{title}</strong><div className="muted">{detail}</div></div></div>; }
export function EmptyState({ title = 'Nothing here yet', detail = 'There is no data to show yet.' }: { title?: string; detail?: string }) { return <section className="card"><strong>{title}</strong><p className="muted">{detail}</p></section>; }
export function LoadingState() { return <section className="card" aria-live="polite">Loading workspace…</section>; }
export function ErrorState({ detail }: { detail: string }) { return <section className="card error" role="alert"><strong>Could not load this section</strong><p>{detail}</p></section>; }
