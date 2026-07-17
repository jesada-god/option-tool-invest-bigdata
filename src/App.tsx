import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { LoadingState } from './components/States';
import { AppLayout } from './layout/AppLayout';

const HomePage = lazy(() => import('./pages/HomePage'));
const WatchlistPage = lazy(() => import('./pages/WatchlistPage'));
const AnalysisPage = lazy(() => import('./pages/AnalysisPage'));
const PortfolioPage = lazy(() => import('./pages/PortfolioPage'));
const ToolsPage = lazy(() => import('./pages/ToolsPage'));
const AlertsPage = lazy(() => import('./pages/AlertsPage'));
const AccountPage = lazy(() => import('./pages/AccountPage'));

export default function App() {
  return (
    <AppLayout>
      <Suspense fallback={<LoadingState />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/watchlist" element={<WatchlistPage />} />
          <Route path="/analysis" element={<AnalysisPage />} />
          <Route path="/portfolio" element={<PortfolioPage />} />
          <Route path="/tools" element={<ToolsPage />} />
          <Route path="/alerts" element={<AlertsPage />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="*" element={<HomePage />} />
        </Routes>
      </Suspense>
    </AppLayout>
  );
}
