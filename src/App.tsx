import { Route, Routes } from 'react-router-dom';
import { AppLayout } from './layout/AppLayout';
import HomePage from './pages/HomePage';
import WatchlistPage from './pages/WatchlistPage';
import AnalysisPage from './pages/AnalysisPage';
import PortfolioPage from './pages/PortfolioPage';
import ToolsPage from './pages/ToolsPage';
import AlertsPage from './pages/AlertsPage';
import AccountPage from './pages/AccountPage';

export default function App() { return <AppLayout><Routes><Route path="/" element={<HomePage />} /><Route path="/watchlist" element={<WatchlistPage />} /><Route path="/analysis" element={<AnalysisPage />} /><Route path="/portfolio" element={<PortfolioPage />} /><Route path="/tools" element={<ToolsPage />} /><Route path="/alerts" element={<AlertsPage />} /><Route path="/account" element={<AccountPage />} /><Route path="*" element={<HomePage />} /></Routes></AppLayout>; }
