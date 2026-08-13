import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Dashboard } from './pages/Dashboard';
import { Mint } from './pages/Mint';
import { Redeem } from './pages/Redeem';
import { FxManager } from './pages/FxManager';
import { History } from './pages/History';
import { OnChain } from './pages/OnChain';
import { Settings } from './pages/Settings';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 10000 } },
});

const navItems = [
  { to: '/', label: 'Dashboard' },
  { to: '/mint', label: 'Issue' },
  { to: '/redeem', label: 'Redeem' },
  { to: '/history', label: 'History' },
  { to: '/fx', label: 'FX Rate' },
  { to: '/on-chain', label: 'On-Chain' },
  { to: '/settings', label: 'Settings' },
];

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <div className="min-h-screen bg-gray-50">
          <nav className="bg-white shadow-sm border-b">
            <div className="max-w-7xl mx-auto px-4 flex items-center h-14 gap-6">
              <span className="font-bold text-lg text-gray-900">Bank ABC</span>
              <span className="text-xs text-gray-400 border-l pl-4">Tokenized Deposits Pilot</span>
              <div className="flex gap-1 ml-8">
                {navItems.map(item => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    className={({ isActive }) =>
                      `px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                        isActive ? 'bg-blue-100 text-blue-800' : 'text-gray-600 hover:bg-gray-100'
                      }`
                    }
                  >
                    {item.label}
                  </NavLink>
                ))}
              </div>
            </div>
          </nav>
          <main className="max-w-7xl mx-auto px-4 py-6">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/mint" element={<Mint />} />
              <Route path="/redeem" element={<Redeem />} />
              <Route path="/history" element={<History />} />
              <Route path="/fx" element={<FxManager />} />
              <Route path="/on-chain" element={<OnChain />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </main>
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
