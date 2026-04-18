import * as React from "react"
import { Outlet, NavLink, useLocation } from 'react-router-dom'
import { 
  BarChart2, 
  Radio, 
  Target, 
  Brain, 
  Settings, 
  LogOut, 
  Plane,
  LineChart,
  History, // ← Ícone do Histórico
} from 'lucide-react'

// Hooks e Contextos
import { useAuth } from '@/contexts/AuthContext'
import { useWebSocket } from '@/hooks/useWebSocket'
import { WebSocketContext } from '@/contexts/WebSocketContext'

// Componentes da Sidebar
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  SidebarSeparator
} from "@/components/ui/sidebar"
import { Button } from '@/components/ui/button'

const navItems = [
  { to: '/dashboard',  icon: BarChart2,  label: 'Dashboard'     },
  { to: '/realtime',   icon: Radio,      label: 'Tempo Real'    },
  { to: '/graficos',   icon: LineChart,  label: 'Gráficos'      },
  { to: '/historico',  icon: History,    label: 'Histórico'     }, // ← NOVA ABA
  { to: '/strategies', icon: Target,     label: 'Estratégias'   },
  { to: '/ai',         icon: Brain,      label: 'IA'            },
  { to: '/settings',   icon: Settings,   label: 'Configurações' },
]

export default function AppLayout() {
  const { user, signOut } = useAuth()
  const ws = useWebSocket()
  const location = useLocation()

  return (
    <WebSocketContext.Provider value={ws}>
      <SidebarProvider>
        <div className="flex min-h-screen w-full bg-background">
          
          {/* Menu Lateral (Sidebar) */}
          <Sidebar variant="sidebar" collapsible="icon">
            <SidebarHeader className="h-14 border-b border-sidebar-border flex items-center justify-center">
              <div className="flex items-center gap-3 px-2 group-data-[collapsible=icon]:justify-center w-full">
                <Plane className="h-6 w-6 text-primary shrink-0" />
                <span className="font-bold text-lg text-foreground truncate group-data-[collapsible=icon]:hidden">
                  Aviator Pro
                </span>
              </div>
            </SidebarHeader>

            <SidebarContent className="py-4">
              <SidebarMenu>
                {navItems.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton 
                      asChild 
                      tooltip={item.label}
                      isActive={location.pathname === item.to}
                    >
                      <NavLink to={item.to} className="flex items-center w-full">
                        <item.icon className="h-5 w-5" />
                        <span>{item.label}</span>
                        
                        {/* Indicador de Status no Tempo Real */}
                        {item.to === '/realtime' && ws.connected && (
                          <span className="ml-auto h-2 w-2 rounded-full bg-green-500 animate-pulse group-data-[collapsible=icon]:hidden" />
                        )}
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarContent>

            <SidebarFooter className="border-t border-sidebar-border p-2">
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton onClick={signOut} className="text-destructive hover:text-destructive">
                    <LogOut className="h-5 w-5" />
                    <span>Sair da conta</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarFooter>
          </Sidebar>

          {/* Área de Conteúdo */}
          <SidebarInset className="flex flex-col">
            {/* Header Superior */}
            <header className="flex h-14 items-center justify-between border-b border-border bg-card px-4 sticky top-0 z-20">
              <div className="flex items-center gap-4">
                <SidebarTrigger />
                <SidebarSeparator orientation="vertical" className="h-4 hidden sm:block" />
                
                <div className="flex items-center gap-2 text-sm">
                  <span className={`h-2 w-2 rounded-full ${ws.connected ? 'bg-green-500 animate-pulse' : 'bg-destructive'}`} />
                  <span className="text-muted-foreground hidden sm:inline font-medium">
                    {ws.connected ? 'Servidor conectado' : 'Servidor offline'}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-4">
                <div className="flex flex-col items-end hidden md:flex">
                  <span className="text-sm font-medium text-foreground leading-none">{user?.email?.split('@')[0]}</span>
                  <span className="text-[10px] text-muted-foreground">{user?.email}</span>
                </div>
                <Button variant="ghost" size="icon" onClick={signOut} className="h-9 w-9">
                  <LogOut className="h-4 w-4" />
                </Button>
              </div>
            </header>

            <main className="flex-1 p-4 lg:p-6 pb-20 lg:pb-6 overflow-x-hidden">
              <Outlet />
            </main>

            {/* Navegação Mobile Inferior — mostra os 5 primeiros itens */}
            <nav className="lg:hidden fixed bottom-0 left-0 right-0 border-t border-border bg-card flex z-30 h-16">
              {navItems.slice(0, 5).map(item => (
                <NavLink 
                  key={item.to} 
                  to={item.to}
                  className={({ isActive }) =>
                    `flex-1 flex flex-col items-center justify-center gap-1 transition-colors ${isActive ? 'text-primary' : 'text-muted-foreground'}`
                  }
                >
                  <item.icon className="h-5 w-5" />
                  <span className="text-[10px] font-medium">{item.label.split(' ')[0]}</span>
                </NavLink>
              ))}
            </nav>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </WebSocketContext.Provider>
  )
}