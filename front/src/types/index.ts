export interface Candle {
  id: string
  user_id: string
  multiplicador: number
  cor: 'blue' | 'purple' | 'pink'
  rodada_id?: string
  fonte: 'auto' | 'manual' | 'csv'
  session_id?: string
  created_at: string
}

export interface Strategy {
  id: string
  user_id?: string
  name: string
  description: string
  rules: Record<string, any>
  is_public?: boolean
  winRate?: number
  totalSimulations?: number
  created_at?: string
}

export interface SimulationResult {
  totalRodadas: number
  wins: number
  losses: number
  skips: number
  winRate: number
  bancaInicial: number
  bancaFinal: number
  lucro: number
  maiorDrawdown: number
  historicoBanca: number[]
}

export interface CandleStats {
  total: number
  blue: { count: number; percent: number }
  purple: { count: number; percent: number }
  pink: { count: number; percent: number }
  maior: number
  menor: number
  media: number
  streakAtual: { cor: string; count: number }
  maiorStreakAzul: number
  maiorStreakRoxa: number
  intervalMedioRosa: number
}

export interface ServerStatus {
  connected: boolean
  loggedIn: boolean
  gameOpen: boolean
  totalCaptured: number
  lastCandle: Candle | null
  uptime: number
  lastError: string | null
}

export interface AIAnalysis {
  resumo: string
  padrao: string
  estrategiaRecomendada: string          // 'ENTRAR' | 'AGUARDAR' | 'ABORTAR'
  confianca: number                      // 0.0 – 1.0
  insights: string[]
  // ── Campos novos retornados pelo Gemini ──────────────────────────────────
  nivelRisco?:    string                 // 'BAIXO' | 'MÉDIO' | 'ALTO'
  melhorMomento?: string
  gestaoGale?:    string
  alertas?:       (string | null)[]
}