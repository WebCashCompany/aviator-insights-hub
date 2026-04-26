import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { useWS } from '@/contexts/WebSocketContext'
import { useCandles } from '@/hooks/useCandles'
import {
  ShieldAlert,
  MessageCircle, Clock, Zap, Trophy,
  WifiOff, Activity, Settings2, CheckCircle, AlertTriangle
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
    headers: { ...NGROK_HEADERS, ...(options.headers ?? {}) },
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

function candleTs(c: Candle): number {
  return new Date(c.created_at || 0).getTime()
}

// ─── Tipos ────────────────────────────────────────────────────────────────────
interface SignalResult { tipo: 'entrar' | 'aguardar' | 'bloqueado' | 'pre_sinal'; msg: string; color: string }
interface StratStats { wins: number; losses: number; g1: number; g2: number; loss: number; winRate: number; total: number }
interface ConfigField { key: string; label: string; type: 'number'; defaultValue: string }
interface StrategyDef {
  id: string; name: string; description: string; icon: React.ReactNode
  detectSignal: (candles: Candle[]) => SignalResult | null
  configFields?: ConfigField[]
}

interface WppConfig {
  enabled:          boolean
  serverConfigured: boolean
  lastSentAt:       number | null
  targets:          string[]
}

type TradePhase = 'idle' | 'pre_sinal' | 'warning_sent' | 'confirmed' | 'gale'

// FIX: entryTimestamp substitui entryCandleIndex — timestamp é estável,
// índice de array muda toda vez que o useMemo remonta o array mesclado
interface TradeState {
  phase:           TradePhase
  entryCandles:    number
  stratName:       string
  preSignalStreak: number
  entryTimestamp:  number
}

interface SessionScore {
  wins:   number
  winsG1: number
  winsG2: number
  losses: number
}

// ─── Constantes de mercado ────────────────────────────────────────────────────
const MARKET_PAYING_THRESHOLD = 0.485
const MARKET_WINDOW           = 60
const MARKET_ALERT_COOLDOWN   = 10 * 60 * 1000

// ─── Chave de deduplicação ────────────────────────────────────────────────────
function candleKey(c: any): string {
  const rid = c.rodada_id as string | undefined | null
  if (rid) {
    const cleanRid = rid.replace('hist_', '').replace('ws_', '').replace('dom_', '')
    return `rid_${cleanRid}`
  }
  if (c.id) return `db_${c.id}`
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

const INITIAL_TRADE: TradeState = {
  phase: 'idle', entryCandles: 0, stratName: '',
  preSignalStreak: 0, entryTimestamp: 0,
}
const INITIAL_SCORE: SessionScore = { wins: 0, winsG1: 0, winsG2: 0, losses: 0 }

export default function SignalPage() {
  const { candles: wsCandles, lastCandle, status: wsStatus } = useWS()
  const { candles: dbCandles } = useCandles({ limit: 100 })

  const [limit, setLimit] = useState(100)
  const LIMIT_OPTIONS = [50, 100, 200, 500]

  // candles mesclados — usado para backtest, display e análise de mercado na UI
  const candles = useMemo(() => {
    const map = new Map<string, Candle>()
    dbCandles.forEach(c => { map.set(candleKey(c), c) })
    wsCandles.forEach(c => {
      const key = candleKey(c)
      if (!map.has(key)) map.set(key, c)
    })
    return Array.from(map.values())
      .filter(c => c.multiplicador !== undefined && c.created_at)
      .sort((a, b) => candleTs(a) - candleTs(b))
      .slice(-limit)
  }, [dbCandles, wsCandles, limit])

  // FIX PRINCIPAL: wsOnly — apenas velas do WebSocket, ordenadas por tempo
  // O monitor de estratégia usa ESTE array, não o mesclado.
  // Motivo: o array mesclado depende de dbCandles (banco) que tem latência de rede/polling.
  // wsCandles atualiza imediatamente a cada NEW_CANDLE do WebSocket — zero atraso.
  const wsOnly = useMemo(() => {
    return [...wsCandles]
      .filter(c => c.multiplicador !== undefined && c.created_at)
      .sort((a, b) => candleTs(a) - candleTs(b))
  }, [wsCandles])

  // ─── Persistência ─────────────────────────────────────────────────────────────
  const [selectedId, setSelectedId] = useState<string>(
    () => localStorage.getItem('aviator_selected_strat') || 's_roxa_azul50'
  )
  const [botEnabled, setBotEnabled] = useState<boolean>(
    () => localStorage.getItem('aviator_bot_enabled') === 'true'
  )

  useEffect(() => { localStorage.setItem('aviator_selected_strat', selectedId || '') }, [selectedId])
  useEffect(() => { localStorage.setItem('aviator_bot_enabled', String(botEnabled)) }, [botEnabled])

  const [config, setConfig] = useState<Record<string, string>>({})
  const [configLoaded, setConfigLoaded] = useState(false)

  const [wppConfig, setWppConfig] = useState<WppConfig>({
    enabled: botEnabled,
    serverConfigured: false,
    lastSentAt: null,
    targets: [],
  })
  const [showWppModal, setShowWppModal] = useState(false)

  const wppConfigRef = useRef(wppConfig)
  useEffect(() => { wppConfigRef.current = { ...wppConfig, enabled: botEnabled } }, [wppConfig, botEnabled])

  const updateWppConfig = useCallback((patch: Partial<WppConfig>) => {
    setWppConfig(prev => ({ ...prev, ...patch }))
  }, [])

  const tradeRef = useRef<TradeState>(INITIAL_TRADE)
  const [tradeDisplay, setTradeDisplay] = useState<{
    kind: 'idle' | 'pre_sinal' | 'warning' | 'confirmed' | 'gale' | 'result'
    result?: 'win_g1' | 'win_g2' | 'loss'
    multiplier?: number
  }>({ kind: 'idle' })

  const scoreRef = useRef<SessionScore>(INITIAL_SCORE)
  const [sessionScore, setSessionScore] = useState<SessionScore>(INITIAL_SCORE)
  useEffect(() => {
    const timer = setInterval(() => setSessionScore({ ...scoreRef.current }), 1000)
    return () => clearInterval(timer)
  }, [])

  // FIX: refs de controle baseados em timestamp (estável) em vez de índice de array
  const prevBlueStreak       = useRef(-1)
  const prevTipoRef          = useRef<string | null>(null)
  const lastProcessedWsTs    = useRef(0)
  const lastProcessedMktTs   = useRef(0)
  const wasPayingRef         = useRef<boolean | null>(null)
  const lastPayAlertAt       = useRef(0)

  const strategies = useMemo(() => buildStrategies(config), [config])
  const selected   = useMemo(() => strategies.find(s => s.id === selectedId), [strategies, selectedId])

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

  // ── apiPost com log para debug ────────────────────────────────────────────────
  const apiPost = useCallback(async (endpoint: string, body: object, withLink = false) => {
    const cfg = wppConfigRef.current
    console.log(`[WPP] ${endpoint} | enabled=${cfg.enabled} configured=${cfg.serverConfigured} targets=${cfg.targets.length}`)
    if (!cfg.enabled || !cfg.serverConfigured || !cfg.targets.length) return
    const payload = {
      ...body,
      targets: cfg.targets,
      ...(withLink ? { gameLink: GAME_LINK } : {}),
    }
    try {
      const res = await apiFetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json().catch(() => ({}))
      console.log(`[WPP] ${endpoint} → ${res.status}`, json)
      updateWppConfig({ lastSentAt: Date.now() })
    } catch (e) {
      console.error(`[WPP] Falha em ${endpoint}:`, e)
    }
  }, [updateWppConfig])

  const apiPostMarket = useCallback(async () => {
    const cfg = wppConfigRef.current
    if (!cfg.enabled || !cfg.serverConfigured || !cfg.targets.length) return
    try {
      const res = await apiFetch(`${API_BASE}/whatsapp/market-paying`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets: cfg.targets, gameLink: GAME_LINK }),
      })
      console.log('[WPP] market-paying →', res.status)
      updateWppConfig({ lastSentAt: Date.now() })
    } catch (e) {
      console.error('[WPP] Falha market-paying:', e)
    }
  }, [updateWppConfig])

  // ─── Monitor de mercado — usa wsOnly ─────────────────────────────────────────
  useEffect(() => {
    if (!botEnabled) return
    if (wsOnly.length < MARKET_WINDOW) return
    const last = wsOnly[wsOnly.length - 1]
    const ts   = candleTs(last)
    if (ts <= lastProcessedMktTs.current) return
    lastProcessedMktTs.current = ts

    const paying = isMarketPaying(wsOnly)
    if (wasPayingRef.current === null) { wasPayingRef.current = paying; return }
    if (paying && wasPayingRef.current === false) {
      if (Date.now() - lastPayAlertAt.current >= MARKET_ALERT_COOLDOWN) {
        lastPayAlertAt.current = Date.now()
        apiPostMarket()
      }
    }
    wasPayingRef.current = paying
  }, [wsOnly, botEnabled, apiPostMarket])

  // ─── Monitor de estratégia — usa wsOnly para ZERO atraso ─────────────────────
  useEffect(() => {
    if (!botEnabled || !wsOnly.length || !selected) return

    const lastWsCandle = wsOnly[wsOnly.length - 1]
    const ts = candleTs(lastWsCandle)

    // Ignora se não chegou vela nova
    if (ts <= lastProcessedWsTs.current) return
    lastProcessedWsTs.current = ts

    console.log(`[STRAT] Vela: ${lastWsCandle.cor} ${lastWsCandle.multiplicador}x | phase=${tradeRef.current.phase}`)

    const trade = tradeRef.current

    // Resolve resultado usando timestamp: busca primeira vela APÓS o timestamp de entrada
    function resolveResult(entryTs: number, phase: 'confirmed' | 'gale', stratName: string): boolean {
      const afterEntry = wsOnly.filter(c => candleTs(c) > entryTs)
      if (afterEntry.length === 0) return false

      const resultCandle = afterEntry[0]
      const mult  = Number(resultCandle.multiplicador)
      const isWin = mult >= 2
      const snap  = { ...scoreRef.current }

      console.log(`[STRAT] Resolve ${phase}: ${resultCandle.cor} ${mult}x → ${isWin ? 'WIN' : 'LOSS'}`)

      if (phase === 'confirmed') {
        if (isWin) {
          scoreRef.current = { ...snap, wins: snap.wins + 1, winsG1: snap.winsG1 + 1 }
          apiPost('/whatsapp/result', { strategyName: stratName, result: 'win_g1', multiplier: mult, score: { ...scoreRef.current } })
          tradeRef.current = { ...INITIAL_TRADE }
          setTradeDisplay({ kind: 'result', result: 'win_g1', multiplier: mult })
          setTimeout(() => setTradeDisplay({ kind: 'idle' }), 6000)
        } else {
          apiPost('/whatsapp/gale', { strategyName: stratName })
          tradeRef.current = { ...trade, phase: 'gale', entryTimestamp: candleTs(resultCandle) }
          setTradeDisplay({ kind: 'gale' })
        }
      } else {
        const result = isWin ? 'win_g2' : 'loss'
        if (isWin) scoreRef.current = { ...snap, wins: snap.wins + 1, winsG2: snap.winsG2 + 1 }
        else        scoreRef.current = { ...snap, losses: snap.losses + 1 }
        apiPost('/whatsapp/result', { strategyName: stratName, result, multiplier: mult, score: { ...scoreRef.current } })
        tradeRef.current = { ...INITIAL_TRADE }
        setTradeDisplay({ kind: 'result', result: result as any, multiplier: mult })
        setTimeout(() => setTradeDisplay({ kind: 'idle' }), 6000)
      }
      return true
    }

    // ── Estratégia: Sequência da Vela Roxa ────────────────────────────────────
    if (selected.id === 's_roxa_azul50') {
      const streak = currentBlueStreak(wsOnly)
      const paying = isMarketPaying(wsOnly)
      const prev   = prevBlueStreak.current

      console.log(`[s_roxa] streak=${streak} prev=${prev} paying=${paying} phase=${trade.phase}`)

      if (trade.phase === 'idle') {
        // Detecta a transição: estava com 1 azul, agora tem 2
        if (paying && streak === 2 && prev === 1) {
          console.log('[s_roxa] → PRÉ-SINAL')
          apiPost('/whatsapp/warning', { strategyName: selected.name }, true)
          tradeRef.current = {
            phase: 'pre_sinal', entryCandles: wsOnly.length,
            stratName: selected.name, preSignalStreak: streak,
            entryTimestamp: ts,
          }
          setTradeDisplay({ kind: 'pre_sinal' })
        }
      } else if (trade.phase === 'pre_sinal') {
        const tipoAgora = selected.detectSignal(wsOnly)?.tipo
        if (tipoAgora === 'entrar') {
          console.log('[s_roxa] → CONFIRMADO')
          apiPost('/whatsapp/confirmed', { strategyName: selected.name }, true)
          tradeRef.current = { ...trade, phase: 'confirmed', entryTimestamp: ts }
          setTradeDisplay({ kind: 'confirmed' })
        } else if (!paying || streak === 0 || streak >= 3) {
          console.log('[s_roxa] → Pré-sinal cancelado')
          tradeRef.current = { ...INITIAL_TRADE }
          setTradeDisplay({ kind: 'idle' })
        }
      } else if (trade.phase === 'confirmed') {
        resolveResult(trade.entryTimestamp, 'confirmed', trade.stratName)
      } else if (trade.phase === 'gale') {
        resolveResult(trade.entryTimestamp, 'gale', trade.stratName)
      }

      prevBlueStreak.current = streak

    // ── Estratégias genéricas ─────────────────────────────────────────────────
    } else {
      const paying    = isMarketPaying(wsOnly)
      const tipoAgora = selected.detectSignal(wsOnly)?.tipo ?? null

      console.log(`[genérica] tipo=${tipoAgora} prev=${prevTipoRef.current} paying=${paying} phase=${trade.phase}`)

      if (!paying) {
        if (trade.phase !== 'idle') { tradeRef.current = { ...INITIAL_TRADE }; setTradeDisplay({ kind: 'idle' }) }
        prevTipoRef.current = tipoAgora; return
      }

      if (trade.phase === 'idle') {
        if (prevTipoRef.current !== 'entrar' && tipoAgora === 'entrar') {
          console.log('[genérica] → WARNING')
          apiPost('/whatsapp/warning', { strategyName: selected.name }, true)
          tradeRef.current = {
            phase: 'warning_sent', entryCandles: wsOnly.length,
            stratName: selected.name, preSignalStreak: 0,
            entryTimestamp: ts,
          }
          setTradeDisplay({ kind: 'warning' })
        }
      } else if (trade.phase === 'warning_sent') {
        if (ts > trade.entryTimestamp) {
          console.log('[genérica] → CONFIRMADO')
          apiPost('/whatsapp/confirmed', { strategyName: selected.name }, true)
          tradeRef.current = { ...trade, phase: 'confirmed', entryTimestamp: ts }
          setTradeDisplay({ kind: 'confirmed' })
        }
      } else if (trade.phase === 'confirmed') {
        resolveResult(trade.entryTimestamp, 'confirmed', trade.stratName)
      } else if (trade.phase === 'gale') {
        resolveResult(trade.entryTimestamp, 'gale', trade.stratName)
      }

      prevTipoRef.current = tipoAgora
    }
  }, [wsOnly, selected, botEnabled, apiPost])

  // ─── Reset ao trocar estratégia ou bot ───────────────────────────────────────
  useEffect(() => {
    tradeRef.current           = { ...INITIAL_TRADE }
    scoreRef.current           = { ...INITIAL_SCORE }
    prevBlueStreak.current     = -1
    prevTipoRef.current        = null
    lastProcessedWsTs.current  = 0
    lastProcessedMktTs.current = 0
    wasPayingRef.current       = null
    lastPayAlertAt.current     = 0
    setTradeDisplay({ kind: 'idle' })
    setSessionScore({ ...INITIAL_SCORE })
  }, [selectedId, botEnabled])

  // ─── Sync de status WPP ───────────────────────────────────────────────────────
  useEffect(() => {
    const sync = async () => {
      try {
        const res = await apiFetch(`${API_BASE}/whatsapp/status`)
        if (res.ok) {
          const d = await res.json()
          const targets: string[] = (d.targets ?? []).filter((t: any) => typeof t === 'string')
          console.log('[WPP] status sync: configured=', d.configured, 'targets=', targets.length)
          updateWppConfig({ serverConfigured: !!d.configured, targets })
        }
      } catch {}
    }
    sync()
    const t = setInterval(sync, 5000)
    return () => clearInterval(t)
  }, [updateWppConfig])

  // ─── Callback do WppModal — só atualiza estado local, sem POST duplo ──────────
  const handleTargetsChange = useCallback((targetIds: string[]) => {
    console.log('[WPP] Targets atualizados:', targetIds)
    updateWppConfig({ targets: targetIds })
    setShowWppModal(false)
  }, [updateWppConfig])

  if (!configLoaded) return (
    <div className="flex items-center justify-center py-20">
      <div className="h-6 w-6 rounded-full border-2 border-white/20 border-t-white/60 animate-spin" />
    </div>
  )

  const stats          = allStats[selectedId]
  const totalOps       = sessionScore.wins + sessionScore.losses
  const sessionWinRate = totalOps > 0 ? ((sessionScore.wins / totalOps) * 100).toFixed(1) : null

  return (
    <div className="space-y-5 pb-20 lg:pb-0 relative">

      {/* Limite de velas */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-xl font-bold text-foreground">Estratégias</h2>
        <div className="flex rounded-lg overflow-hidden border border-white/10">
          {LIMIT_OPTIONS.map(l => (
            <button
              key={l}
              onClick={() => setLimit(l)}
              className="px-2.5 py-1 text-[11px] font-medium transition-colors"
              style={{
                background: limit === l ? 'rgba(127,119,221,0.3)' : 'transparent',
                color:      limit === l ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.4)',
              }}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      {/* Cards de status */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

        {/* Status Bot */}
        <div className="bg-zinc-900/50 border border-white/5 p-4 rounded-2xl">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-purple-500/10 rounded-lg"><Activity className="h-5 w-5 text-purple-400" /></div>
            <div>
              <h3 className="text-sm font-medium text-zinc-400">Status do Bot</h3>
              <p className="text-lg font-semibold text-white">{wsStatus.connected ? 'Capturando' : 'Desconectado'}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className={`h-2 w-2 rounded-full ${wsStatus.connected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
            <span className="text-xs text-zinc-500">
              Total: {candles.length} · WS live: {wsOnly.length}
            </span>
          </div>
        </div>

        {/* Placar */}
        <div className="bg-zinc-900/50 border border-white/5 p-4 rounded-2xl">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 bg-green-500/10 rounded-lg"><Trophy className="h-5 w-5 text-green-400" /></div>
            <div>
              <h3 className="text-sm font-medium text-zinc-400">Placar da Sessão</h3>
              <p className="text-lg font-semibold text-white">{sessionScore.wins}W — {sessionScore.losses}L</p>
            </div>
          </div>
          <div className="flex gap-4 text-xs text-zinc-500">
            <span>G1: <b className="text-green-400">{sessionScore.winsG1}</b></span>
            <span>G2: <b className="text-green-400">{sessionScore.winsG2}</b></span>
            {sessionWinRate && (
              <span>
                Taxa: <b className={parseFloat(sessionWinRate) >= 60 ? 'text-green-400' : 'text-red-400'}>
                  {sessionWinRate}%
                </b>
              </span>
            )}
          </div>
        </div>

        {/* WhatsApp */}
        <div className="bg-zinc-900/50 border border-white/5 p-4 rounded-2xl">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-amber-500/10 rounded-lg"><MessageCircle className="h-5 w-5 text-amber-400" /></div>
              <div>
                <h3 className="text-sm font-medium text-zinc-400">WhatsApp</h3>
                <p className="text-lg font-semibold text-white">
                  {wppConfig.serverConfigured
                    ? wppConfig.targets.length > 0
                      ? `${wppConfig.targets.length} grupo${wppConfig.targets.length !== 1 ? 's' : ''}`
                      : 'Sem grupos'
                    : 'Desconectado'}
                </p>
              </div>
            </div>
            <button
              onClick={() => setShowWppModal(true)}
              className="p-2 hover:bg-white/10 rounded-lg transition-colors bg-white/5"
            >
              <Settings2 className="h-5 w-5 text-zinc-400" />
            </button>
          </div>
          <button
            onClick={() => setBotEnabled(!botEnabled)}
            className={`w-full py-2 rounded-xl text-xs font-bold transition-all ${
              botEnabled
                ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                : 'bg-green-500/10 text-green-400 border border-green-500/20'
            }`}
          >
            {botEnabled ? 'DESATIVAR ROBÔ' : 'ATIVAR ROBÔ'}
          </button>
        </div>
      </div>

      {/* Banner de trade ativo */}
      {tradeDisplay.kind !== 'idle' && (
        <div
          className="rounded-2xl p-4 border flex items-center gap-4 transition-all"
          style={{
            backgroundColor:
              tradeDisplay.kind === 'result' && tradeDisplay.result === 'loss' ? 'rgba(239,68,68,0.08)'
              : tradeDisplay.kind === 'result'    ? 'rgba(34,197,94,0.08)'
              : tradeDisplay.kind === 'confirmed' ? 'rgba(34,197,94,0.08)'
              : tradeDisplay.kind === 'gale'      ? 'rgba(251,146,60,0.08)'
              : 'rgba(251,191,36,0.08)',
            borderColor:
              tradeDisplay.kind === 'result' && tradeDisplay.result === 'loss' ? 'rgba(239,68,68,0.3)'
              : tradeDisplay.kind === 'result'    ? 'rgba(34,197,94,0.3)'
              : tradeDisplay.kind === 'confirmed' ? 'rgba(34,197,94,0.3)'
              : tradeDisplay.kind === 'gale'      ? 'rgba(251,146,60,0.3)'
              : 'rgba(251,191,36,0.3)',
          }}
        >
          <div className="flex-shrink-0">
            {tradeDisplay.kind === 'pre_sinal'  && <AlertTriangle className="h-6 w-6 text-yellow-400" />}
            {tradeDisplay.kind === 'warning'    && <AlertTriangle className="h-6 w-6 text-yellow-400" />}
            {tradeDisplay.kind === 'confirmed'  && <Zap className="h-6 w-6 text-green-400 fill-current" />}
            {tradeDisplay.kind === 'gale'       && <AlertTriangle className="h-6 w-6 text-orange-400" />}
            {tradeDisplay.kind === 'result' && tradeDisplay.result !== 'loss' && <CheckCircle className="h-6 w-6 text-green-400" />}
            {tradeDisplay.kind === 'result' && tradeDisplay.result === 'loss' && <WifiOff className="h-6 w-6 text-red-400" />}
          </div>
          <div className="flex-1">
            {tradeDisplay.kind === 'pre_sinal'  && <p className="font-bold text-yellow-300">⚠️ PRÉ-SINAL ENVIADO — aguardando roxa</p>}
            {tradeDisplay.kind === 'warning'    && <p className="font-bold text-yellow-300">⚠️ AVISO ENVIADO — aguardando confirmação</p>}
            {tradeDisplay.kind === 'confirmed'  && <p className="font-bold text-green-300">🚀 SINAL CONFIRMADO — entre agora!</p>}
            {tradeDisplay.kind === 'gale'       && <p className="font-bold text-orange-300">🔄 GALE ativado — aguardando resultado</p>}
            {tradeDisplay.kind === 'result' && tradeDisplay.result === 'win_g1' && (
              <div>
                <p className="font-bold text-green-300">✅ WIN G1 — {tradeDisplay.multiplier}x</p>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Placar: {scoreRef.current.wins}W / {scoreRef.current.losses}L
                  &nbsp;·&nbsp; G1: {scoreRef.current.winsG1} · G2: {scoreRef.current.winsG2}
                </p>
              </div>
            )}
            {tradeDisplay.kind === 'result' && tradeDisplay.result === 'win_g2' && (
              <div>
                <p className="font-bold text-green-300">✅ WIN G2 (Gale) — {tradeDisplay.multiplier}x</p>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Placar: {scoreRef.current.wins}W / {scoreRef.current.losses}L
                  &nbsp;·&nbsp; G1: {scoreRef.current.winsG1} · G2: {scoreRef.current.winsG2}
                </p>
              </div>
            )}
            {tradeDisplay.kind === 'result' && tradeDisplay.result === 'loss' && (
              <div>
                <p className="font-bold text-red-300">❌ LOSS — {tradeDisplay.multiplier}x</p>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Placar: {scoreRef.current.wins}W / {scoreRef.current.losses}L
                  &nbsp;·&nbsp; G1: {scoreRef.current.winsG1} · G2: {scoreRef.current.winsG2}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Estratégia */}
      <div className="bg-zinc-900/50 border border-white/5 rounded-3xl overflow-hidden">
        <div className="p-6 border-b border-white/5 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-purple-500/10 rounded-2xl">{selected?.icon}</div>
            <div>
              <h2 className="text-xl font-bold text-white">{selected?.name}</h2>
              <p className="text-sm text-zinc-400">{selected?.description}</p>
            </div>
          </div>
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="bg-zinc-800 border border-white/10 rounded-xl px-4 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-purple-500"
          >
            {strategies.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>

        <div className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Sinal + mercado */}
          <div className="space-y-6">
            <div className="bg-black/20 rounded-2xl p-6 border border-white/5">
              <h3 className="text-xs font-bold text-zinc-500 mb-4 uppercase tracking-widest">Sinal Atual</h3>
              {sinalAtual ? (
                <div className="space-y-4">
                  <div
                    className="text-lg font-bold p-5 rounded-2xl border flex items-center gap-4 transition-all"
                    style={{ backgroundColor: `${sinalAtual.color}10`, borderColor: `${sinalAtual.color}30`, color: sinalAtual.color }}
                  >
                    {sinalAtual.tipo === 'entrar'    && <Zap className="h-6 w-6 fill-current flex-shrink-0" />}
                    {sinalAtual.tipo === 'aguardar'  && <Clock className="h-6 w-6 flex-shrink-0" />}
                    {sinalAtual.tipo === 'bloqueado' && <ShieldAlert className="h-6 w-6 flex-shrink-0" />}
                    {sinalAtual.tipo === 'pre_sinal' && <Activity className="h-6 w-6 flex-shrink-0" />}
                    <span>{sinalAtual.msg}</span>
                  </div>
                  <div className="flex justify-between text-[10px] text-zinc-500 uppercase font-bold">
                    <span>Última Vela: {lastCandle?.multiplicador}x</span>
                    <span>Atualizado: {new Date().toLocaleTimeString()}</span>
                  </div>
                </div>
              ) : (
                <div className="text-zinc-500 italic">Aguardando...</div>
              )}
            </div>

            <div className="bg-black/20 rounded-2xl p-6 border border-white/5">
              <h3 className="text-xs font-bold text-zinc-500 mb-4 uppercase tracking-widest">Análise de Mercado</h3>
              <div className="space-y-4">
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-400">Taxa de Azuis (60 velas)</span>
                  <span className={`font-mono font-bold ${marketPaying ? 'text-green-400' : 'text-red-400'}`}>
                    {(bluePercent(candles) * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="w-full bg-zinc-800 h-2 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-1000 ${marketPaying ? 'bg-green-500' : 'bg-red-500'}`}
                    style={{ width: `${bluePercent(candles) * 100}%` }}
                  />
                </div>
                <p className="text-[11px] text-zinc-500 leading-relaxed">
                  {marketPaying ? '✅ Mercado favorável para operações.' : '⚠️ Mercado desfavorável. Sinais bloqueados.'}
                </p>
              </div>
            </div>
          </div>

          {/* Performance backtest */}
          <div className="bg-black/20 rounded-2xl p-6 border border-white/5">
            <h3 className="text-xs font-bold text-zinc-500 mb-6 uppercase tracking-widest">Performance (Backtest)</h3>
            <div className="grid grid-cols-2 gap-4 mb-8">
              <div className="p-5 bg-zinc-900/50 rounded-2xl border border-white/5">
                <div className="text-3xl font-bold text-white">{stats?.winRate.toFixed(1) ?? '—'}%</div>
                <div className="text-[10px] text-zinc-500 uppercase font-bold mt-1">Assertividade</div>
              </div>
              <div className="p-5 bg-zinc-900/50 rounded-2xl border border-white/5">
                <div className="text-3xl font-bold text-white">{stats?.total ?? '—'}</div>
                <div className="text-[10px] text-zinc-500 uppercase font-bold mt-1">Sinais</div>
              </div>
            </div>
            <div className="space-y-3">
              {[
                { label: 'Wins Diretos (G0)', val: stats?.g1, color: 'bg-green-500' },
                { label: 'Wins Martingale (G1)', val: stats?.g2, color: 'bg-green-400' },
                { label: 'Losses', val: stats?.loss, color: 'bg-red-500' },
              ].map(item => (
                <div key={item.label} className="flex items-center justify-between p-3 bg-white/5 rounded-xl">
                  <div className="flex items-center gap-3">
                    <div className={`h-2 w-2 rounded-full ${item.color}`} />
                    <span className="text-xs text-zinc-300">{item.label}</span>
                  </div>
                  <span className="font-mono font-bold text-white">{item.val ?? '—'}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {showWppModal && (
        <WppModal
          onClose={() => setShowWppModal(false)}
          initialTargets={wppConfig.targets}
          onTargetsChange={handleTargetsChange}
        />
      )}
    </div>
  )
}