import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { useWS } from '@/contexts/WebSocketContext'
import { useCandles } from '@/hooks/useCandles'
import {
  ShieldAlert, CheckCircle2,
  MessageCircle, Clock, Zap, Trophy,
  Users, WifiOff, Activity, Settings2, X
} from 'lucide-react'
import WppModal from '@/components/WppModal'
import { Candle } from '@/types'

// ─── Paleta ───────────────────────────────────────────────────────────────────
const C = {
  purple: 'hsl(263,70%,58%)',
  green:  'hsl(142,71%,45%)',
  amber:  'hsl(38,92%,50%)',
  red:    'hsl(0,72%,55%)',
  muted:  'rgba(255,255,255,0.18)',
}

const API_BASE = import.meta.env.VITE_BOT_API_URL || 'http://localhost:3001/api/v1'

const NGROK_HEADERS: HeadersInit = API_BASE.includes('ngrok')
  ? { 'ngrok-skip-browser-warning': 'true' }
  : {}

function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: {
      ...NGROK_HEADERS,
      ...(options.headers ?? {}),
    },
  })
}

const GAME_LINK = 'https://d3c6klm.com/game/action/6770'

// ─── Normalização de cores ────────────────────────────────────────────────────
type NormalizedColor = 'blue' | 'purple' | 'pink' | 'unknown'

function normalizeColor(cor: unknown): NormalizedColor {
  const c = String(cor ?? '').toLowerCase().trim()
  if (c === 'blue'   || c === 'azul')                                    return 'blue'
  if (c === 'purple' || c === 'roxa' || c === 'roxo' || c === 'violeta') return 'purple'
  if (c === 'pink'   || c === 'rosa')                                    return 'pink'
  return 'unknown'
}

const candleCor      = (c: Candle): NormalizedColor => normalizeColor(c.cor)
const isBlueCandle   = (c: Candle): boolean => candleCor(c) === 'blue'
const isPurpleCandle = (c: Candle): boolean => candleCor(c) === 'purple'

// ─── Tipos ────────────────────────────────────────────────────────────────────
interface SignalResult { tipo: 'entrar' | 'aguardar' | 'bloqueado' | 'pre_sinal'; msg: string; color: string }
interface StratStats { wins: number; losses: number; g1: number; g2: number; loss: number; winRate: number; total: number }
interface ConfigField { key: string; label: string; type: 'number'; defaultValue: string }
interface StrategyDef {
  id: string; name: string; description: string; icon: React.ReactNode
  detectSignal: (candles: Candle[]) => SignalResult | null
  configFields?: ConfigField[]
}
interface WppConfig { enabled: boolean; serverConfigured: boolean; lastSentAt: number | null; targets: string[] }

type TradePhase = 'idle' | 'pre_sinal' | 'warning_sent' | 'confirmed' | 'gale'
interface TradeState {
  phase:            TradePhase
  entryCandles:     number
  stratName:        string
  preSignalStreak:  number
  entryCandleIndex: number
}

// ─── Placar da sessão ─────────────────────────────────────────────────────────
interface SessionScore {
  wins:   number   // total de wins (g1 + g2)
  winsG1: number   // wins diretos
  winsG2: number   // wins no martingale
  losses: number   // losses totais
}

// ─── Constantes de mercado ────────────────────────────────────────────────────
const MARKET_PAYING_THRESHOLD = 0.485
const MARKET_WINDOW           = 60
const MARKET_ALERT_COOLDOWN   = 10 * 60 * 1000

// ─── Chave de deduplicação ─────────────────────────────────────────────────────
function candleKey(c: any): string {
  // Se tem rodada_id, usamos ele como chave única (remove prefixos de histórico)
  const rid = c.rodada_id as string | undefined | null
  if (rid) {
    const cleanRid = rid.replace('hist_', '').replace('ws_', '').replace('dom_', '')
    return `rid_${cleanRid}`
  }
  // Se não tem rodada_id, usamos o ID do banco
  if (c.id) return `db_${c.id}`
  // Fallback para evitar chaves nulas
  return `fb_${new Date(c.created_at || 0).getTime()}_${c.multiplicador}`
}

// ─── Funções de mercado ───────────────────────────────────────────────────────
function bluePercent(candles: Candle[], n = MARKET_WINDOW): number {
  if (!candles.length) return 0
  const slice = candles.slice(-n)
  return slice.filter(isBlueCandle).length / slice.length
}

function isMarketPaying(candles: Candle[]): boolean {
  return bluePercent(candles, MARKET_WINDOW) <= MARKET_PAYING_THRESHOLD
}

function currentBlueStreak(candles: Candle[]): number {
  let streak = 0
  for (let i = candles.length - 1; i >= 0; i--) {
    if (isBlueCandle(candles[i])) streak++
    else break
  }
  return streak
}

// ─── Backtesting ──────────────────────────────────────────────────────────────
function computeStats(strategy: StrategyDef, candles: Candle[]): StratStats {
  let g1 = 0, g2 = 0, loss = 0

  if (strategy.id === 's_roxa_azul50') {
    let idx = 3
    while (idx < candles.length - 2) {
      const c = candles[idx]
      const sliceAtIdx = candles.slice(0, idx + 1)
      if (!isMarketPaying(sliceAtIdx)) { idx++; continue }
      if (isPurpleCandle(c)) {
        const prev1 = candles[idx - 1]
        const prev2 = candles[idx - 2]
        const prev3 = candles[idx - 3]
        const exactlyTwoBlues =
          isBlueCandle(prev1) && isBlueCandle(prev2) &&
          prev3 !== undefined && !isBlueCandle(prev3)
        if (exactlyTwoBlues) {
          const entryIdx = idx + 1
          const galeIdx  = idx + 2
          if (entryIdx >= candles.length) { idx++; continue }
          const m1 = Number(candles[entryIdx].multiplicador)
          if (m1 >= 2) {
            g1++; idx = entryIdx + 1
          } else if (galeIdx < candles.length) {
            const m2 = Number(candles[galeIdx].multiplicador)
            if (m2 >= 2) { g2++; idx = galeIdx + 1 }
            else         { loss++; idx = galeIdx + 1 }
          } else { idx++ }
          continue
        }
      }
      idx++
    }
    const wins = g1 + g2; const total = wins + loss
    return { wins, losses: loss, g1, g2, loss, winRate: total > 0 ? (wins / total) * 100 : 0, total }
  }

  let i = 5
  while (i < candles.length - 2) {
    const slice = candles.slice(0, i + 1)
    if (!isMarketPaying(slice)) { i++; continue }
    const signal = strategy.detectSignal(slice)
    if (signal?.tipo !== 'entrar') { i++; continue }
    const next1 = Number(candles[i + 1].multiplicador)
    const next2 = Number(candles[i + 2].multiplicador)
    if (next1 >= 2) { g1++; i += 2 }
    else if (next2 >= 2) { g2++; i += 3 }
    else { loss++; i += 3 }
  }
  const wins = g1 + g2; const total = wins + loss
  return { wins, losses: loss, g1, g2, loss, winRate: total > 0 ? (wins / total) * 100 : 0, total }
}

// ─── Estratégias ──────────────────────────────────────────────────────────────
function buildStrategies(config: Record<string, string>): StrategyDef[] {
  return [
    {
      id: 's_horario', name: 'Estratégia por Horário',
      description: 'Analisa o intervalo médio entre roxas e sinaliza quando está na hora de entrar.',
      icon: <Clock className="h-4 w-4" />,
      configFields: [{ key: 'tolerancia', label: 'Tolerância (min)', type: 'number', defaultValue: '1' }],
      detectSignal(candles) {
        const purples = candles
          .filter(c => isPurpleCandle(c) && c.created_at)
          .sort((a, b) => new Date(a.created_at!).getTime() - new Date(b.created_at!).getTime())
        if (purples.length < 3) return { tipo: 'aguardar', msg: 'Poucas roxas para calcular intervalo', color: C.muted }
        const intervals: number[] = []
        for (let i = 1; i < purples.length; i++) {
          const diff = (new Date(purples[i].created_at!).getTime() - new Date(purples[i-1].created_at!).getTime()) / 60_000
          if (diff > 0 && diff < 60) intervals.push(diff)
        }
        if (intervals.length < 2) return { tipo: 'aguardar', msg: 'Dados insuficientes', color: C.muted }
        const avg      = intervals.reduce((s, v) => s + v, 0) / intervals.length
        const last     = purples[purples.length - 1]
        const minSince = (Date.now() - new Date(last.created_at!).getTime()) / 60_000
        const tol      = parseFloat(config.tolerancia || '1')
        const remain   = avg - minSince
        if (minSince >= avg - tol)
          return { tipo: 'entrar', msg: `ENTRAR — ${minSince.toFixed(1)}min desde última roxa (média: ${avg.toFixed(1)}min)`, color: C.green }
        if (remain <= tol * 2)
          return { tipo: 'aguardar', msg: `Próxima em ~${remain.toFixed(1)}min — se preparar`, color: C.amber }
        return { tipo: 'aguardar', msg: `Próxima em ~${remain.toFixed(1)}min (média: ${avg.toFixed(1)}min)`, color: C.muted }
      },
    },
    {
      id: 's_roxa_azul50', name: 'Sequência da Vela Roxa',
      description: 'Pré-sinal com exatamente 2 azuis consecutivas. Entrada confirmada quando a roxa aparecer — entre na próxima vela. Até 1 Martingale.',
      icon: <Zap className="h-4 w-4" />,
      detectSignal(candles) {
        if (candles.length < 4) return null
        const bluePct = bluePercent(candles, MARKET_WINDOW)
        if (bluePct > MARKET_PAYING_THRESHOLD) return {
          tipo: 'bloqueado',
          msg: `Mercado não pagando (${(bluePct * 100).toFixed(1)}% azuis nas últ. ${MARKET_WINDOW}) — sinal bloqueado`,
          color: C.amber,
        }
        const last    = candles[candles.length - 1]
        const lastCor = candleCor(last)
        if (lastCor === 'purple') {
          const prev1 = candles[candles.length - 2]
          const prev2 = candles[candles.length - 3]
          const prev3 = candles[candles.length - 4]
          const exactlyTwoBlues =
            prev1 && isBlueCandle(prev1) && prev2 && isBlueCandle(prev2) && prev3 && !isBlueCandle(prev3)
          if (exactlyTwoBlues)
            return { tipo: 'entrar', msg: `🚀 ENTRADA CONFIRMADA — roxa após exatamente 2 azuis! Entre na PRÓXIMA vela!`, color: C.green }
          let streak = 0
          for (let i = candles.length - 2; i >= 0; i--) {
            if (isBlueCandle(candles[i])) streak++
            else break
          }
          return {
            tipo: 'bloqueado',
            msg: streak === 0 ? `Roxa veio, mas não havia azuis antes — precisa exatamente 2`
               : streak === 1 ? `Roxa veio após apenas 1 azul — precisa exatamente 2`
               : `Roxa veio após ${streak} azuis — precisa exatamente 2`,
            color: C.amber,
          }
        }
        if (lastCor === 'blue') {
          const streak = currentBlueStreak(candles)
          if (streak === 1) return { tipo: 'aguardar', msg: '1 azul detectada — aguardando a 2ª', color: C.muted }
          if (streak === 2) return { tipo: 'pre_sinal', msg: '⚠️ PRÉ-SINAL: 2 azuis detectadas! Aguarde a ROXA para entrar.', color: C.amber }
          return { tipo: 'aguardar', msg: `${streak} azuis consecutivas — aguardando quebra`, color: C.muted }
        }
        return { tipo: 'aguardar', msg: 'Aguardando sequência de 2 azuis + 1 roxa', color: C.muted }
      },
    },
  ]
}

const INITIAL_TRADE: TradeState = { phase: 'idle', entryCandles: 0, stratName: '', preSignalStreak: 0, entryCandleIndex: -1 }
const INITIAL_SCORE: SessionScore = { wins: 0, winsG1: 0, winsG2: 0, losses: 0 }

export default function SignalPage() {
  const { candles: wsCandles, lastCandle, status: wsStatus } = useWS()
  const { candles: dbCandles, loading: dbLoading } = useCandles({ limit: 100 })

  const [limit, setLimit] = useState(100)
  const LIMIT_OPTIONS = [50, 100, 200, 500]

  const candles = useMemo(() => {
    const map = new Map<string, Candle>()
    
    // 1. Adicionamos as do banco (Fonte de Verdade)
    dbCandles.forEach(c => {
      const key = candleKey(c)
      map.set(key, c)
    })
    
    // 2. Adicionamos as do WebSocket apenas se não existirem (Deduplicação Real)
    wsCandles.forEach(c => {
      const key = candleKey(c)
      if (!map.has(key)) {
        map.set(key, c)
      }
    })

    // 3. Filtramos para garantir que não temos "velas fantasmas" sem dados básicos
    const result = Array.from(map.values())
      .filter(c => c.multiplicador !== undefined && c.created_at)
      .sort((a, b) => new Date(a.created_at!).getTime() - new Date(b.created_at!).getTime())

    // 4. O limite agora corta o excesso de forma agressiva
    return result.slice(-limit)
  }, [dbCandles, wsCandles, limit])

  // ─── Persistência ────────────────────────────────────────────────────────────
  const [selectedId, setSelectedId] = useState<string>(() => localStorage.getItem('aviator_selected_strat') || 's_roxa_azul50')
  const [botEnabled, setBotEnabled] = useState<boolean>(() => localStorage.getItem('aviator_bot_enabled') === 'true')
  
  useEffect(() => { localStorage.setItem('aviator_selected_strat', selectedId || '') }, [selectedId])
  useEffect(() => { localStorage.setItem('aviator_bot_enabled', String(botEnabled)) }, [botEnabled])

  const [config, setConfig] = useState<Record<string, string>>({})
  const [configLoaded, setConfigLoaded] = useState(false)

  const [wppConfig, setWppConfig] = useState<WppConfig>({ enabled: botEnabled, serverConfigured: false, lastSentAt: null, targets: [] })
  const [showWppModal, setShowWppModal] = useState(false)

  const wppConfigRef = useRef(wppConfig)
  useEffect(() => { wppConfigRef.current = { ...wppConfig, enabled: botEnabled } }, [wppConfig, botEnabled])

  const updateWppConfig = useCallback((patch: Partial<WppConfig>) => {
    setWppConfig(prev => ({ ...prev, ...patch }))
  }, [])

  const tradeRef = useRef<TradeState>(INITIAL_TRADE)
  const [tradeDisplay, setTradeDisplay] = useState<{ kind: 'idle' | 'pre_sinal' | 'warning' | 'confirmed' | 'gale' | 'result'; result?: 'win_g1' | 'win_g2' | 'loss'; multiplier?: number }>({ kind: 'idle' })
  
  const scoreRef = useRef<SessionScore>(INITIAL_SCORE)
  const [sessionScore, setSessionScore] = useState<SessionScore>(INITIAL_SCORE)
  useEffect(() => {
    const timer = setInterval(() => setSessionScore({ ...scoreRef.current }), 1000)
    return () => clearInterval(timer)
  }, [])

  const prevBlueStreak = useRef(-1)
  const prevTipoRef = useRef<string | null>(null)
  const lastTotalCount = useRef(-1)
  const lastStratCandleCount = useRef(-1)
  const lastGenCandleCount = useRef(-1)
  const wasPayingRef = useRef<boolean | null>(null)
  const lastPayAlertAt = useRef(0)

  const strategies = useMemo(() => buildStrategies(config), [config])
  const selected = useMemo(() => strategies.find(s => s.id === selectedId), [strategies, selectedId])

  useEffect(() => {
    const saved = localStorage.getItem('aviator_strat_configs')
    if (saved) try { setConfig(JSON.parse(saved)) } catch {}
    setConfigLoaded(true)
  }, [])

  useEffect(() => {
    if (configLoaded) localStorage.setItem('aviator_strat_configs', JSON.stringify(config))
  }, [config, configLoaded])

  const allStats = useMemo<Record<string, StratStats>>(() => {
    if (candles.length < 10) return {}
    return Object.fromEntries(strategies.map(s => [s.id, computeStats(s, candles)]))
  }, [strategies, candles])

  const allSignals = useMemo<Record<string, SignalResult | null>>(() => {
    if (!candles.length) return {}
    return Object.fromEntries(strategies.map(s => [s.id, s.detectSignal(candles)]))
  }, [strategies, candles])

  const sinalAtual: SignalResult | null = allSignals[selectedId ?? ''] ?? null
  const marketPaying = useMemo(() => isMarketPaying(candles), [candles])

  // ── apiPost ───────────────────────────────────────────────────────────────
  const apiPost = useCallback(async (endpoint: string, body: object, withLink = false) => {
    const cfg = wppConfigRef.current
    if (!cfg.enabled) return
    if (!cfg.serverConfigured) return
    if (!cfg.targets.length) return
    const payload = { ...body, targets: cfg.targets, ...(withLink ? { gameLink: GAME_LINK } : {}) }
    try {
      await apiFetch(`${API_BASE}${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      })
      updateWppConfig({ lastSentAt: Date.now() })
    } catch (e) { console.error(`[WPP] Falha em ${endpoint}:`, e) }
  }, [updateWppConfig])

  const apiPostMarket = useCallback(async () => {
    const cfg = wppConfigRef.current
    if (!cfg.enabled || !cfg.serverConfigured || !cfg.targets.length) return
    try {
      await apiFetch(`${API_BASE}/whatsapp/market-paying`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets: cfg.targets, gameLink: GAME_LINK }),
      })
      updateWppConfig({ lastSentAt: Date.now() })
    } catch (e) { console.error('[WPP] Falha ao enviar market-paying:', e) }
  }, [updateWppConfig])

  // ─── Monitor de mercado pagando ───────────────────────────────────────────
  useEffect(() => {
    if (!botEnabled) return
    if (candles.length < MARKET_WINDOW) return
    const totalNow = candles.length
    if (totalNow === lastTotalCount.current) return
    lastTotalCount.current = totalNow
    const paying = isMarketPaying(candles)
    if (wasPayingRef.current === null) { wasPayingRef.current = paying; return }
    if (paying && wasPayingRef.current === false) {
      if (Date.now() - lastPayAlertAt.current >= MARKET_ALERT_COOLDOWN) {
        lastPayAlertAt.current = Date.now()
        apiPostMarket()
      }
    }
    wasPayingRef.current = paying
  }, [candles, botEnabled, apiPostMarket])

  // ─── Monitor de estratégia ────────────────────────────────────────────────
  useEffect(() => {
    if (!botEnabled) return
    if (!candles.length || !selected) return
    const tipo  = sinalAtual?.tipo ?? null
    const trade = tradeRef.current

    function resolveResult(waitingSinceLength: number, phase: 'confirmed' | 'gale', stratName: string): boolean {
      if (candles.length <= waitingSinceLength) return false
      const resultCandle = candles[candles.length - 1]
      const mult = Number(resultCandle.multiplicador)
      const isWin = mult >= 2
      if (phase === 'confirmed') {
        if (isWin) {
          scoreRef.current.wins++; scoreRef.current.winsG1++
          apiPost('/whatsapp/result', { strategyName: stratName, result: 'win_g1', multiplier: mult, score: { ...scoreRef.current } })
          tradeRef.current = { ...INITIAL_TRADE }; setTradeDisplay({ kind: 'result', result: 'win_g1', multiplier: mult })
          setTimeout(() => setTradeDisplay({ kind: 'idle' }), 6000)
        } else {
          apiPost('/whatsapp/gale', { strategyName: stratName })
          tradeRef.current = { ...trade, phase: 'gale', entryCandleIndex: candles.length }
          setTradeDisplay({ kind: 'gale' })
        }
      } else {
        const result = isWin ? 'win_g2' : 'loss'
        if (isWin) { scoreRef.current.wins++; scoreRef.current.winsG2++ } else { scoreRef.current.losses++ }
        apiPost('/whatsapp/result', { strategyName: stratName, result, multiplier: mult, score: { ...scoreRef.current } })
        tradeRef.current = { ...INITIAL_TRADE }; setTradeDisplay({ kind: 'result', result, multiplier: mult })
        setTimeout(() => setTradeDisplay({ kind: 'idle' }), 6000)
      }
      return true
    }

    if (selected.id === 's_roxa_azul50') {
      const streak = currentBlueStreak(candles)
      const paying = isMarketPaying(candles)
      if (lastStratCandleCount.current === -1) { lastStratCandleCount.current = candles.length; prevBlueStreak.current = streak; return }
      if (candles.length <= lastStratCandleCount.current) return
      lastStratCandleCount.current = candles.length
      const prev = prevBlueStreak.current
      if (trade.phase === 'idle') {
        if (paying && streak === 2 && prev === 1) {
          apiPost('/whatsapp/warning', { strategyName: selected.name }, true)
          tradeRef.current = { phase: 'pre_sinal', entryCandles: wsCandles.length, stratName: selected.name, preSignalStreak: streak, entryCandleIndex: -1 }
          setTradeDisplay({ kind: 'pre_sinal' })
        }
      } else if (trade.phase === 'pre_sinal') {
        if (tipo === 'entrar') {
          apiPost('/whatsapp/confirmed', { strategyName: selected.name }, true)
          tradeRef.current = { ...trade, phase: 'confirmed', entryCandleIndex: candles.length }
          setTradeDisplay({ kind: 'confirmed' })
        } else if (!paying || streak === 0 || streak >= 3) {
          tradeRef.current = { ...INITIAL_TRADE }; setTradeDisplay({ kind: 'idle' })
        }
      } else if (trade.phase === 'confirmed') { resolveResult(trade.entryCandleIndex, 'confirmed', trade.stratName) }
      else if (trade.phase === 'gale') { resolveResult(trade.entryCandleIndex, 'gale', trade.stratName) }
      prevBlueStreak.current = streak
    } else {
      const paying = isMarketPaying(candles)
      if (lastGenCandleCount.current === -1) { lastGenCandleCount.current = candles.length; prevTipoRef.current = tipo; return }
      if (candles.length <= lastGenCandleCount.current) return
      lastGenCandleCount.current = candles.length
      if (!paying) { if (trade.phase !== 'idle') { tradeRef.current = { ...INITIAL_TRADE }; setTradeDisplay({ kind: 'idle' }) }; prevTipoRef.current = tipo; return }
      if (trade.phase === 'idle') {
        if (prevTipoRef.current !== 'entrar' && tipo === 'entrar') {
          apiPost('/whatsapp/warning', { strategyName: selected.name }, true)
          tradeRef.current = { phase: 'warning_sent', entryCandles: wsCandles.length, stratName: selected.name, preSignalStreak: 0, entryCandleIndex: -1 }
          setTradeDisplay({ kind: 'warning' })
        }
      } else if (trade.phase === 'warning_sent') {
        if (wsCandles.length > trade.entryCandles) {
          apiPost('/whatsapp/confirmed', { strategyName: selected.name }, true)
          tradeRef.current = { ...trade, phase: 'confirmed', entryCandleIndex: candles.length }
          setTradeDisplay({ kind: 'confirmed' })
        }
      } else if (trade.phase === 'confirmed') { resolveResult(trade.entryCandleIndex, 'confirmed', trade.stratName) }
      else if (trade.phase === 'gale') { resolveResult(trade.entryCandleIndex, 'gale', trade.stratName) }
      prevTipoRef.current = tipo
    }
  }, [candles, wsCandles, sinalAtual, selected, botEnabled, apiPost])

  useEffect(() => {
    tradeRef.current = { ...INITIAL_TRADE }; scoreRef.current = { ...INITIAL_SCORE }
    prevBlueStreak.current = -1; prevTipoRef.current = null; lastTotalCount.current = -1
    lastStratCandleCount.current = -1; lastGenCandleCount.current = -1; wasPayingRef.current = null
    setTradeDisplay({ kind: 'idle' })
  }, [selectedId])

  useEffect(() => {
    const sync = async () => {
      try {
        const res = await apiFetch(`${API_BASE}/whatsapp/status`)
        if (res.ok) {
          const d = await res.json()
          updateWppConfig({ serverConfigured: !!d.configured, targets: d.targets || [] })
        }
      } catch {}
    }
    sync(); const t = setInterval(sync, 5000); return () => clearInterval(t)
  }, [updateWppConfig])

  const handleSaveTargets = async (targets: string[]) => {
    const res = await apiFetch(`${API_BASE}/whatsapp/targets`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targets }),
    })
    if (res.ok) { updateWppConfig({ targets }); setShowWppModal(false) }
    else throw new Error('Erro ao salvar')
  }

  if (!configLoaded) return <div className="flex items-center justify-center py-20"><div className="h-6 w-6 rounded-full border-2 border-white/20 border-t-white/60 animate-spin" /></div>

  return (
    <div className="space-y-5 pb-20 lg:pb-0 relative">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-xl font-bold text-foreground">Estratégias</h2>
        <div className="flex rounded-lg overflow-hidden border border-white/10">
          {LIMIT_OPTIONS.map(l => (
            <button key={l} onClick={() => setLimit(l)} className="px-2.5 py-1 text-[11px] font-medium transition-colors"
              style={{ background: limit === l ? 'rgba(127,119,221,0.3)' : 'transparent', color: limit === l ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.4)' }}>
              {l}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-zinc-900/50 border border-white/5 p-4 rounded-2xl">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-purple-500/10 rounded-lg"><Activity className="h-5 w-5 text-purple-400" /></div>
            <div><h3 className="text-sm font-medium text-zinc-400">Status do Bot</h3><p className="text-lg font-semibold text-white">{wsStatus.connected ? 'Capturando' : 'Desconectado'}</p></div>
          </div>
          <div className="flex items-center gap-2"><div className={`h-2 w-2 rounded-full ${wsStatus.connected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} /><span className="text-xs text-zinc-500">Live: {candles.length} velas em memória</span></div>
        </div>
        <div className="bg-zinc-900/50 border border-white/5 p-4 rounded-2xl">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-green-500/10 rounded-lg"><Trophy className="h-5 w-5 text-green-400" /></div>
            <div><h3 className="text-sm font-medium text-zinc-400">Placar da Sessão</h3><p className="text-lg font-semibold text-white">{sessionScore.wins}W - {sessionScore.losses}L</p></div>
          </div>
          <div className="flex gap-4 text-xs text-zinc-500"><span>G1: <b className="text-green-400">{sessionScore.winsG1}</b></span><span>G2: <b className="text-green-400">{sessionScore.winsG2}</b></span></div>
        </div>
        <div className="bg-zinc-900/50 border border-white/5 p-4 rounded-2xl">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-amber-500/10 rounded-lg"><MessageCircle className="h-5 w-5 text-amber-400" /></div>
              <div><h3 className="text-sm font-medium text-zinc-400">WhatsApp</h3><p className="text-lg font-semibold text-white">{wppConfig.serverConfigured ? 'Conectado' : 'Desconectado'}</p></div>
            </div>
            <button onClick={() => setShowWppModal(true)} className="p-2 hover:bg-white/10 rounded-lg transition-colors bg-white/5"><Settings2 className="h-5 w-5 text-zinc-400" /></button>
          </div>
          <button onClick={() => setBotEnabled(!botEnabled)} className={`w-full py-2 rounded-xl text-xs font-bold transition-all ${botEnabled ? 'bg-red-500/10 text-red-400 border border-red-500/20' : 'bg-green-500/10 text-green-400 border border-green-500/20'}`}>{botEnabled ? 'DESATIVAR ROBÔ' : 'ATIVAR ROBÔ'}</button>
        </div>
      </div>

      <div className="bg-zinc-900/50 border border-white/5 rounded-3xl overflow-hidden">
        <div className="p-6 border-b border-white/5 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-purple-500/10 rounded-2xl">{selected?.icon}</div>
            <div><h2 className="text-xl font-bold text-white">{selected?.name}</h2><p className="text-sm text-zinc-400">{selected?.description}</p></div>
          </div>
          <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} className="bg-zinc-800 border border-white/10 rounded-xl px-4 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-purple-500">
            {strategies.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className="space-y-6">
            <div className="bg-black/20 rounded-2xl p-6 border border-white/5">
              <h3 className="text-xs font-bold text-zinc-500 mb-4 uppercase tracking-widest">Sinal Atual</h3>
              {sinalAtual ? (
                <div className="space-y-4">
                  <div className="text-2xl font-bold p-5 rounded-2xl border flex items-center gap-4 transition-all" style={{ backgroundColor: `${sinalAtual.color}10`, borderColor: `${sinalAtual.color}30`, color: sinalAtual.color }}>
                    {sinalAtual.tipo === 'entrar' && <Zap className="h-7 w-7 fill-current" />}
                    {sinalAtual.tipo === 'aguardar' && <Clock className="h-7 w-7" />}
                    {sinalAtual.tipo === 'bloqueado' && <ShieldAlert className="h-7 w-7" />}
                    {sinalAtual.tipo === 'pre_sinal' && <Activity className="h-7 w-7" />}
                    {sinalAtual.msg}
                  </div>
                  <div className="flex justify-between text-[10px] text-zinc-500 uppercase font-bold"><span>Última Vela: {lastCandle?.multiplicador}x</span><span>Atualizado: {new Date().toLocaleTimeString()}</span></div>
                </div>
              ) : <div className="text-zinc-500 italic">Aguardando...</div>}
            </div>
            <div className="bg-black/20 rounded-2xl p-6 border border-white/5">
              <h3 className="text-xs font-bold text-zinc-500 mb-4 uppercase tracking-widest">Análise de Mercado</h3>
              <div className="space-y-4">
                <div className="flex justify-between text-sm"><span className="text-zinc-400">Taxa de Azuis (60 velas)</span><span className={`font-mono font-bold ${isMarketPaying(candles) ? 'text-green-400' : 'text-red-400'}`}>{(bluePercent(candles) * 100).toFixed(1)}%</span></div>
                <div className="w-full bg-zinc-800 h-2 rounded-full overflow-hidden"><div className={`h-full transition-all duration-1000 ${isMarketPaying(candles) ? 'bg-green-500' : 'bg-red-500'}`} style={{ width: `${bluePercent(candles) * 100}%` }} /></div>
                <p className="text-[11px] text-zinc-500 leading-relaxed">{isMarketPaying(candles) ? '✅ Mercado favorável para operações.' : '⚠️ Mercado desfavorável. Sinais bloqueados.'}</p>
              </div>
            </div>
          </div>
          <div className="bg-black/20 rounded-2xl p-6 border border-white/5">
            <h3 className="text-xs font-bold text-zinc-500 mb-6 uppercase tracking-widest">Performance (Backtest)</h3>
            <div className="grid grid-cols-2 gap-4 mb-8">
              <div className="p-5 bg-zinc-900/50 rounded-2xl border border-white/5"><div className="text-3xl font-bold text-white">{allStats[selectedId]?.winRate.toFixed(1)}%</div><div className="text-[10px] text-zinc-500 uppercase font-bold mt-1">Assertividade</div></div>
              <div className="p-5 bg-zinc-900/50 rounded-2xl border border-white/5"><div className="text-3xl font-bold text-white">{allStats[selectedId]?.total}</div><div className="text-[10px] text-zinc-500 uppercase font-bold mt-1">Sinais</div></div>
            </div>
            <div className="space-y-3">
              {[
                { label: 'Wins Diretos (G0)', val: allStats[selectedId]?.g1, color: 'bg-green-500' },
                { label: 'Wins Martingale (G1)', val: allStats[selectedId]?.g2, color: 'bg-green-400' },
                { label: 'Losses', val: allStats[selectedId]?.loss, color: 'bg-red-500' }
              ].map(item => (
                <div key={item.label} className="flex items-center justify-between p-3 bg-white/5 rounded-xl"><div className="flex items-center gap-3"><div className={`h-2 w-2 rounded-full ${item.color}`} /><span className="text-xs text-zinc-300">{item.label}</span></div><span className="font-mono font-bold text-white">{item.val}</span></div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {showWppModal && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-hidden">
          <div className="relative w-full max-w-2xl bg-zinc-900 border border-white/10 rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between p-6 border-b border-white/5"><h3 className="text-lg font-bold text-white">Configurações do WhatsApp</h3><button onClick={() => setShowWppModal(false)} className="p-2 bg-white/5 hover:bg-white/10 rounded-full text-zinc-400 hover:text-white transition-all"><X className="h-5 w-5" /></button></div>
            <div className="flex-1 overflow-y-auto p-2"><WppModal isOpen={true} onClose={() => setShowWppModal(false)} initialTargets={wppConfig.targets} onSave={handleSaveTargets} /></div>
          </div>
        </div>
      )}
    </div>
  )
}
