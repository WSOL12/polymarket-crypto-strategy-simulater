import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppNav } from "./components/AppNav";
import { ArbitrageSimPage } from "./pages/ArbitrageSimPage";
import { LiveDashboardPage } from "./pages/LiveDashboardPage";
import { StrategySimPage } from "./pages/StrategySimPage";

export function App() {
  return (
    <BrowserRouter>
      <AppNav />
      <Routes>
        <Route path="/" element={<LiveDashboardPage />} />
        <Route path="/arbitrage" element={<ArbitrageSimPage />} />
        <Route path="/strategy" element={<StrategySimPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
