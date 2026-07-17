import { NavLink } from 'react-router-dom';
const items = [['/', 'Home'], ['/watchlist', 'Watchlist'], ['/analysis', 'Analysis'], ['/portfolio', 'Portfolio'], ['/tools', 'Tools'], ['/alerts', 'Alerts'], ['/account', 'Account']];
export function Sidebar({ openSearch }: { openSearch: () => void }) { return <aside className="sidebar"><div className="brand">Quantora AI</div><nav className="nav" aria-label="Primary navigation">{items.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}>{label}</NavLink>)}<button onClick={openSearch} className="card">Search</button></nav></aside>; }
