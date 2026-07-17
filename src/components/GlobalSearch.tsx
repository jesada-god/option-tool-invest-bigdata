import { KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

type Item = { ticker?: string; symbol?: string; name?: string; category?: string };

export function GlobalSearch({ close }: { close: () => void }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const resultsId = useId();
  const navigate = useNavigate();

  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => openerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!q.trim()) { setItems([]); return; }
    const timer = setTimeout(() => api<{ items: Item[] }>(`/api/search?q=${encodeURIComponent(q)}&limit=8`)
      .then(result => { setItems(result.items || []); setError(''); setIndex(0); })
      .catch(err => setError(err.message)), 250);
    return () => clearTimeout(timer);
  }, [q]);

  const choose = (item: Item) => {
    const ticker = item.ticker || item.symbol;
    if (!ticker) return;
    api('/api/search-history', { method: 'POST', body: JSON.stringify({ ticker, query: q }) }).catch(() => {});
    api('/api/recent-viewed', { method: 'POST', body: JSON.stringify({ ticker, query: q }) }).catch(() => {});
    navigate(`/analysis?ticker=${encodeURIComponent(ticker)}`);
    close();
  };

  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setIndex(value => Math.min(value + 1, items.length - 1)); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setIndex(value => Math.max(value - 1, 0)); }
    if (event.key === 'Enter' && items[index]) choose(items[index]);
    if (event.key === 'Escape') close();
  };

  const trapFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])'));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  return <div className="search-backdrop" onMouseDown={close}>
    <section className="search-dialog" role="dialog" aria-modal="true" aria-labelledby={`${resultsId}-title`} onMouseDown={event => event.stopPropagation()} onKeyDown={trapFocus}>
      <button className="text-button" onClick={close}>Close search</button>
      <h2 id={`${resultsId}-title`}>Search markets</h2>
      <input ref={inputRef} value={q} onChange={event => setQ(event.target.value)} onKeyDown={keys} placeholder="Search ticker or company" aria-label="Search ticker or company" aria-controls={resultsId} aria-activedescendant={items[index] ? `${resultsId}-${index}` : undefined} />
      {error && <p className="error" role="alert">{error}</p>}
      {q && !error && !items.length && <p className="muted" aria-live="polite">No instruments found.</p>}
      <div className="search-results" id={resultsId} role="listbox" aria-label="Search results">
        {items.map((item, itemIndex) => <button className={itemIndex === index ? 'selected' : ''} id={`${resultsId}-${itemIndex}`} role="option" aria-selected={itemIndex === index} key={`${item.ticker || item.symbol}-${itemIndex}`} onClick={() => choose(item)}><strong>{item.ticker || item.symbol}</strong><span>{item.name} · {item.category}</span></button>)}
      </div>
    </section>
  </div>;
}
