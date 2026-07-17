import { ReactNode, useState } from 'react';
import { BottomNav } from '../components/BottomNav';
import { GlobalSearch } from '../components/GlobalSearch';
import { Sidebar } from '../components/Sidebar';
import { AuthGate } from '../components/AuthGate';

function Shell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <div className="app">
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <Sidebar openSearch={() => setOpen(true)} />
    <main className="main" id="main-content" tabIndex={-1}>{children}</main>
    <BottomNav openSearch={() => setOpen(true)} />
    {open && <GlobalSearch close={() => setOpen(false)} />}
  </div>;
}
export function AppLayout({ children }: { children: ReactNode }) { return <AuthGate><Shell>{children}</Shell></AuthGate>; }
