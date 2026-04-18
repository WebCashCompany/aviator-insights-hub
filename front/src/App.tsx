import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom"
import { Toaster as Sonner } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AuthProvider } from "@/contexts/AuthContext"
import { WebSocketProvider } from "@/contexts/WebSocketContext"
import ProtectedRoute from "@/components/ProtectedRoute"
import AppLayout from "@/components/AppLayout"

// Páginas de Autenticação
import LoginPage from "@/pages/Login"
import RegisterPage from "@/pages/Register"
import ForgotPasswordPage from "@/pages/ForgotPassword"
import ResetPasswordPage from "@/pages/ResetPassword"

// Páginas da Aplicação
import DashboardPage from "@/pages/Dashboard"
import RealtimePage from "@/pages/Realtime"
import StrategiesPage from "@/pages/Strategies"
import ChartsPage from '@/pages/ChartsPage'
import HistoryPage from '@/pages/HistoryPage' // ← NOVO
import AIPage from "@/pages/AI"
import SettingsPage from "@/pages/Settings"
import NotFound from "@/pages/NotFound"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <WebSocketProvider>
        <TooltipProvider>
          <Sonner position="top-right" expand={false} richColors />
          <BrowserRouter>
            <Routes>
              {/* Redirecionamento Inicial */}
              <Route path="/" element={<Navigate to="/dashboard" replace />} />

              {/* Rotas Públicas */}
              <Route path="/login" element={<LoginPage />} />
              <Route path="/register" element={<RegisterPage />} />
              <Route path="/forgot-password" element={<ForgotPasswordPage />} />
              <Route path="/reset-password" element={<ResetPasswordPage />} />

              {/* Rotas Privadas (Envolvidas pelo Layout e Proteção) */}
              <Route element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/realtime" element={<RealtimePage />} />
                <Route path="/graficos" element={<ChartsPage />} />
                <Route path="/historico" element={<HistoryPage />} /> {/* ← NOVO */}
                <Route path="/strategies" element={<StrategiesPage />} />
                <Route path="/ai" element={<AIPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Route>

              {/* Rota 404 */}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </BrowserRouter>
        </TooltipProvider>
      </WebSocketProvider>
    </AuthProvider>
  </QueryClientProvider>
)

export default App