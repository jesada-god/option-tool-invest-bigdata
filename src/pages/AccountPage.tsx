import { FormEvent, useState } from 'react';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { api, message } from '../lib/api';
import { useRequest } from '../lib/useRequest';
import { PageScaffold } from './PageScaffold';

export default function AccountPage() {
  const [error, setError] = useState('');
  const request = useRequest('account', async () => {
    const [me, prefs, favorites, analytics, trending] = await Promise.all([
      api<any>('/api/me'),
      api<any>('/api/preferences').catch(() => null),
      api<any>('/api/favorites').catch(() => ({ items: [] })),
      api<any>('/api/search-analytics').catch(() => null),
      api<any>('/api/search-analytics/trending').catch(() => ({ items: [] })),
    ]);
    return { me, prefs, favorites, analytics, trending };
  });
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api('/api/me', { method: 'PUT', body: JSON.stringify({ username: form.get('username') }) });
      location.reload();
    } catch (caught) {
      setError(message(caught));
    }
  };

  if (request.loading) return <PageScaffold title="Account & Settings" description="Profile, preferences, and session security."><LoadingState /></PageScaffold>;
  if (request.error) return <PageScaffold title="Account & Settings" description="Profile, preferences, and session security."><ErrorState detail={request.error} /></PageScaffold>;
  const data = request.data!;
  if (!data.me.authenticated) return <PageScaffold title="Account & Settings" description="Profile, preferences, and session security."><EmptyState title="You are not signed in" detail="Use the existing sign-in flow to create a secure cookie-based session." /></PageScaffold>;

  return <PageScaffold title="Account & Settings" description="Cookie-based session only; no token is stored in this app.">
    {error && <ErrorState detail={error} />}
    <section className="card"><h2>Profile</h2><form onSubmit={save}><label>Username<input name="username" defaultValue={data.me.user?.username || ''} /></label><button className="action-link">Save profile</button></form><button className="text-button danger" onClick={() => api('/api/auth/sign-out', { method: 'POST' }).then(() => location.assign('/'))}>Sign out</button></section>
    <section className="card"><h2>Preferences</h2>{data.prefs ? <pre>{JSON.stringify(data.prefs.preferences, null, 2)}</pre> : <p className="muted">Preferences are unavailable.</p>}</section>
    <section className="card"><h2>Favorites & search activity</h2><p>{data.analytics?.total_searches ?? 0} searches · {data.analytics?.unique_symbols ?? 0} symbols</p><div className="actions">{data.favorites.items?.map((favorite: any) => <span className="tag" key={favorite.ticker}>{favorite.ticker}</span>)}</div><p className="muted">Trending: {data.trending.items?.map((item: any) => item.ticker || item.symbol).join(', ') || 'none'}</p></section>
  </PageScaffold>;
}
