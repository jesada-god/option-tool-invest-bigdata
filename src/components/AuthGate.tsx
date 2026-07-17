import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { api, message } from '../lib/api';
import { LoadingState } from './States';

type Me = { auth_enabled?: boolean; authenticated?: boolean; csrf_token?: string };
export function AuthGate({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me>(); const [failure, setFailure] = useState('');
  const refresh = () => api<Me>('/api/me').then(setMe).catch(x => setFailure(message(x)));
  useEffect(() => { void refresh(); }, []);
  if (failure) return <main className="auth-page"><p className="error" role="alert">{failure}</p></main>;
  if (!me) return <LoadingState />;
  if (!me.auth_enabled || me.authenticated) return <>{children}</>;
  return <AuthForm complete={refresh} />;
}

function AuthForm({ complete }: { complete: () => void }) {
  const [mode, setMode] = useState<'login'|'register'|'forgot'|'reset'>('login'); const [status, setStatus] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const values = new FormData(event.currentTarget); setBusy(true); setError(''); setStatus('');
    try { const email = String(values.get('email') || ''); if (mode === 'forgot') { const x:any = await api('/api/auth/forgot-password',{method:'POST',body:JSON.stringify({email})}); setStatus(x.message || 'Check your email for recovery instructions.'); }
      else if (mode === 'reset') { const x:any = await api('/api/auth/update-password',{method:'POST',body:JSON.stringify({password:values.get('password')})}); setStatus(x.message || 'Password updated.'); setMode('login'); }
      else { const endpoint = mode === 'register' ? '/api/auth/sign-up' : '/api/auth/sign-in'; const body:any = { email, password: values.get('password'), remember_me: Boolean(values.get('remember_me')) }; if(mode==='register') body.full_name=values.get('full_name'); const x:any=await api(endpoint,{method:'POST',body:JSON.stringify(body)}); if(x.authenticated) complete(); else setStatus(x.message || 'Account created. Verify your email, then sign in.'); }
    } catch (x) { setError(message(x)); } finally { setBusy(false); } };
  const title = mode==='login'?'Welcome back':mode==='register'?'Create your account':mode==='forgot'?'Reset your password':'Choose a new password';
  return <main className="auth-page"><section className="card auth-card"><div className="brand">Quantora AI</div><h1>{title}</h1><p className="muted">Secure access uses HttpOnly session cookies.</p><form onSubmit={submit}>{mode!=='reset'&&<label>Email<input required name="email" type="email" autoComplete="email" /></label>}{mode==='register'&&<label>Name<input name="full_name" autoComplete="name" /></label>}{mode!=='forgot'&&<label>Password<input required name="password" type="password" minLength={8} autoComplete={mode==='reset'?'new-password':mode==='register'?'new-password':'current-password'} /></label>}{mode==='login'&&<label><input name="remember_me" type="checkbox" /> Remember me</label>}<button className="action-link" disabled={busy}>{busy?'Please wait…':mode==='login'?'Sign in':mode==='register'?'Register':mode==='forgot'?'Send recovery email':'Update password'}</button></form>{status&&<p className="success" role="status">{status}</p>}{error&&<p className="error" role="alert">{error}</p>}<div className="actions">{mode!=='login'&&<button className="text-button" onClick={()=>setMode('login')}>Sign in</button>}{mode==='login'&&<><button className="text-button" onClick={()=>setMode('register')}>Register</button><button className="text-button" onClick={()=>setMode('forgot')}>Forgot password?</button></>}{mode==='forgot'&&<button className="text-button" onClick={()=>setMode('reset')}>I have a recovery session</button>}</div><a className="text-button" href="/api/auth/google/start">Continue with Google</a></section></main>;
}
