import { FormEvent, useEffect, useState } from 'react';
import { NumericKeypad } from '../components/NumericKeypad';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { api, cloudFeatureMessage, message } from '../lib/api';
import { PageScaffold } from './PageScaffold';

const tools = ['position-size', 'compound', 'dca', 'expected-move', 'probability', 'intrinsic-value', 'fair-value', 'allocation'];

export default function ToolsPage() {
  const [tool, setTool] = useState(tools[0]); const [payload, setPayload] = useState('{}'); const [result, setResult] = useState('');
  const [error, setError] = useState(''); const [status, setStatus] = useState(''); const [history, setHistory] = useState<any[]>();
  const load = () => api<any>('/api/simulation-history?limit=50').then(x => { setHistory(x.items); setError(''); }).catch(x => { setHistory(undefined); setError(cloudFeatureMessage(x)); });
  useEffect(() => { void load(); }, []);
  const call = async (path: string, body: any) => { setError(''); setStatus('Running…'); try { const x: any = await api(path, { method: 'POST', body: JSON.stringify(body) }); if (x.error) throw new Error(x.error); setResult(JSON.stringify(x, null, 2)); setStatus('Complete.'); return x; } catch (x) { setStatus(''); setError(message(x)); throw x; } };
  const runTool = async (e: FormEvent) => { e.preventDefault(); try { await call(`/api/tools/${tool}`, JSON.parse(payload)); } catch {} };
  const simulate = async (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget); const body = { strike_price: Number(f.get('strike')), option_type: f.get('type'), expiration: f.get('expiration'), premium_paid: Number(f.get('premium')), current_iv: Number(f.get('iv')), target_price: Number(f.get('target_price')), target_date: f.get('target_date') }; try { const x = await call('/api/simulate', body); await api('/api/simulation-history', { method: 'POST', body: JSON.stringify({ ticker: String(f.get('ticker')).toUpperCase(), simulation_type: 'what-if', input_data: body, result_data: x }) }); setStatus('Simulation saved to history.'); await load(); } catch {} };
  const remove = async (id: number) => { if (!confirm('Delete this saved simulation?')) return; try { await api(`/api/simulation-history/${id}`, { method: 'DELETE' }); setStatus('History item deleted.'); await load(); } catch (x) { setError(cloudFeatureMessage(x)); } };
  return <PageScaffold title="Tools & Simulator" description="Run calculators and save/review real simulations.">
    {error && <ErrorState detail={error}/>} {status && <p className="success" role="status">{status}</p>}
    <section className="card"><h2>Calculator desk</h2><label>Calculator<select value={tool} onChange={e => setTool(e.target.value)}>{tools.map(x => <option key={x}>{x}</option>)}</select></label><form onSubmit={runTool}><label>JSON inputs<textarea value={payload} onChange={e => setPayload(e.target.value)} aria-label="Calculator JSON inputs"/></label><button className="action-link">Calculate</button></form></section>
    <section className="card"><h2>Option What-if</h2><form className="inline-form" onSubmit={simulate}><input required name="ticker" placeholder="Ticker"/><input required name="strike" type="number" step="any" placeholder="Strike"/><select name="type"><option>CALL</option><option>PUT</option></select><input required name="expiration" type="date"/><input required name="premium" type="number" step="any" placeholder="Premium"/><input required name="iv" type="number" step="any" placeholder="IV"/><input required name="target_price" type="number" step="any" placeholder="Target price"/><input required name="target_date" type="date"/><button className="action-link">Run simulation</button></form><NumericKeypad label="Numeric input aid"/></section>
    {result && <section className="card"><h2>Result</h2><pre>{result}</pre></section>}
    <section className="card"><h2>Simulation history</h2>{history === undefined ? <LoadingState/> : history.length ? history.map(x => <div className="row" key={x.id}><div className="row-copy"><strong>{x.ticker} · {x.simulation_type}</strong><div className="muted">{x.created_at}</div></div><button className="text-button" onClick={() => setResult(JSON.stringify({ input: x.input_data, result: x.result_data }, null, 2))}>View</button><button className="text-button danger" onClick={() => remove(x.id)}>Delete</button></div>) : <EmptyState title="No saved simulations" detail="Run a What-if simulation to save it here."/>}</section>
  </PageScaffold>;
}
