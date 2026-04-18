import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { useCandles } from '@/hooks/useCandles'
import {
  Activity, ShieldAlert, CheckCircle2,
  MessageCircle, Clock, Zap, TrendingUp, Trophy,
  Users,
} from 'lucide-react'
import WppModal from '@/components/WppModal'

const C = {
  purple: 'hsl(263,70%,58%)',
  green:  'hsl(142,71%,45%)',
  amber:  'hsl(38,92%,50%)',
  red:    'hsl(0,72%,55%)',
  muted:  'rgba(255,255,255,0.18)',
}

const API_BASE = import.meta.env.VITE_BOT_API_URL || 'http://localhost:3001/api/v1'

interface SignalResult { tipo: 'entrar' | 'aguardar' | 'bloqueado'; msg: string; color: string }
interface StratStats { wins: number; losses: number; g1: number; g2: number; loss: number; winRate: number; total: number }
interface ConfigField { key: string; label: string; type: 'number'; defaultValue: string }
interface StrategyDef { id: string; name: string; description: string; icon: React.ReactNode; detectSignal: (candles: any[]) => SignalResult | null; configFields?: ConfigField[] }
interface WppConfig { enabled: boolean; serverConfigured: boolean; lastSentAt: number | null; targets: string[] }
type TradePhase = 'idle' | 'warning_sent' | 'confirmed' | 'gale'
interface TradeState { phase: TradePhase; entryCandles: number; stratName: string }

const SS_KEY_SELECTED = 'aviator_selectedStratId'
const SS_KEY_WPP = 'aviator_wppConfig'

function ssGet<T>(key: string, fallback: T): T {
  try { const raw = sessionStorage.getItem(key); if (raw == null) return fallback; return JSON.parse(raw) as T } catch { return fallback }
}
function ssSet(key: string, value: unknown): void { try { sessionStorage.setItem(key, JSON.stringify(value)) } catch {} }

function bluePercent(candles: any[], n = 20): number {
  if (!candles.length) return 0
  const slice = candles.slice(-n)
  return slice.filter((c: any) => c.cor === 'blue').length / slice.length
}

function computeStats(strategy: StrategyDef, candles: any[]): StratStats {
  let g1 = 0, g2 = 0, loss = 0
  for (let i = 5; i < candles.length - 2; i++) {
    const signal = strategy.detectSignal(candles.slice(0, i + 1))
    if (signal?.tipo !== 'entrar') continue
    const next1 = Number(candles[i + 1].multiplicador)
    const next2 = Number(candles[i + 2].multiplicador)
    if (next1 >= 2) g1++; else if (next2 >= 2) g2++; else loss++
  }
  const wins = g1 + g2; const total = wins + loss; const winRate = total > 0 ? (wins / total) * 100 : 0
  return { wins, losses: loss, g1, g2, loss, winRate, total }
}

function buildStrategies(config: Record<string, string>): StrategyDef[] {
  return [
    {
      id: 's_horario', name: 'Estratégia por Horário',
      description: 'Analisa o intervalo médio entre roxas e sinaliza quando está na hora de entrar.',
      icon: <Clock className="h-4 w-4" />,
      configFields: [{ key: 'tolerancia', label: 'Tolerância (min)', type: 'number', defaultValue: '1' }],
      detectSignal(candles) {
        const purples = candles.filter((c: any) => c.cor === 'purple' && c.created_at).sort((a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
        if (purples.length < 3) return { tipo: 'aguardar', msg: 'Poucas roxas para calcular intervalo', color: C.muted }
        const intervals: number[] = []
        for (let i = 1; i < purples.length; i++) { const diff = (new Date(purples[i].created_at).getTime() - new Date(purples[i - 1].created_at).getTime()) / 60_000; if (diff > 0 && diff < 60) intervals.push(diff) }
        if (intervals.length < 2) return { tipo: 'aguardar', msg: 'Dados insuficientes', color: C.muted }
        const avg = intervals.reduce((s, v) => s + v, 0) / intervals.length
        const last = purples[purples.length - 1]
        const minSince = (Date.now() - new Date(last.created_at).getTime()) / 60_000
        const tol = parseFloat(config.tolerancia || '1')
        const remain = avg - minSince
        if (minSince >= avg - tol) return { tipo: 'entrar', msg: `ENTRAR — ${minSince.toFixed(1)}min desde última roxa (média: ${avg.toFixed(1)}min)`, color: C.green }
        if (remain <= tol * 2) return { tipo: 'aguardar', msg: `Próxima em ~${remain.toFixed(1)}min — se preparar`, color: C.amber }
        return { tipo: 'aguardar', msg: `Próxima em ~${remain.toFixed(1)}min (média: ${avg.toFixed(1)}min)`, color: C.muted }
      },
    },
    {
      id: 's_roxa_azul50', name: 'Sequência da Vela Roxa',
      description: 'Entrada após roxa quando azuis < 49% nas últimas 20 velas e sem streak de 4+ azuis.',
      icon: <Zap className="h-4 w-4" />,
      detectSignal(candles) {
        if (candles.length < 5) return null
        // FILTRO GLOBAL: azuis < 49% nas últimas 20 velas — verificado ANTES de qualquer outra coisa
        const bluePct = bluePercent(candles, 20)
        if (bluePct >= 0.49) return { tipo: 'bloqueado', msg: `Bloqueado: ${(bluePct * 100).toFixed(0)}% azul nas últimas 20 (precisa < 49%)`, color: C.amber }
        const last = candles[candles.length - 1]
        if (last?.cor !== 'purple') return { tipo: 'aguardar', msg: 'Aguardando vela roxa...', color: C.muted }
        let streak = 0
        for (let i = candles.length - 2; i >= 0; i--) { if (candles[i].cor === 'blue') streak++; else break }
        if (streak >= 4) return { tipo: 'bloqueado', msg: `Bloqueado: ${streak} azuis consecutivos antes da roxa`, color: C.amber }
        return { tipo: 'entrar', msg: `ENTRAR — roxa + ${(bluePct * 100).toFixed(0)}% azul (últimas 20) + streak ok!`, color: C.green }
      },
    },
    {
      id: 's_inicio_azuis', name: 'Detectar Início de Azuis',
      description: 'Detecta o primeiro candle azul após uma quebra — início de streak azul.',
      icon: <TrendingUp className="h-4 w-4" />,
      detectSignal(candles) {
        if (candles.length < 3) return null
        const len = candles.length; const last = candles[len - 1]; const prev = candles[len - 2]
        if (last?.cor === 'blue' && prev?.cor !== 'blue') return { tipo: 'entrar', msg: 'ENTRAR — início de streak azul detectado!', color: C.green }
        if (last?.cor === 'blue') {
          let s = 0; for (let i = len - 1; i >= 0; i--) { if (candles[i].cor === 'blue') s++; else break }
          if (s >= 3) return { tipo: 'bloqueado', msg: `Streak ${s}x — aguardar reset`, color: C.amber }
          return { tipo: 'aguardar', msg: `Azul ${s}x em andamento`, color: C.muted }
        }
        return { tipo: 'aguardar', msg: 'Aguardando início de streak azul...', color: C.muted }
      },
    },
    {
      id: 's_inicio_roxas', name: 'Detectar Início de Roxas',
      description: 'Detecta padrão de roxa após 2–4 azuis consecutivos (início de ciclo roxo).',
      icon: <Activity className="h-4 w-4" />,
      detectSignal(candles) {
        if (candles.length < 5) return null
        const len = candles.length; const last = candles[len - 1]
        if (last?.cor === 'purple') {
          let blues = 0; for (let i = len - 2; i >= 0; i--) { if (candles[i].cor === 'blue') blues++; else break }
          if (blues >= 2 && blues <= 4) return { tipo: 'entrar', msg: `ENTRAR — roxa após ${blues} azuis!`, color: C.green }
          if (blues > 4) return { tipo: 'bloqueado', msg: `Roxa com ${blues} azuis — streak alto`, color: C.amber }
          return { tipo: 'aguardar', msg: 'Roxa sem padrão claro', color: C.muted }
        }
        if (last?.cor === 'blue') {
          let s = 0; for (let i = len - 1; i >= 0; i--) { if (candles[i].cor === 'blue') s++; else break }
          if (s >= 2 && s <= 4) return { tipo: 'aguardar', msg: `${s} azuis — possível roxa chegando`, color: C.purple }
        }
        return { tipo: 'aguardar', msg: 'Aguardando padrão de início de roxas...', color: C.muted }
      },
    },
  ]
}

function StatsRow({ stats }: { stats: StratStats }) {
  const total = stats.total
  const pG1 = total > 0 ? (stats.g1 / total) * 100 : 0
  const pG2 = total > 0 ? (stats.g2 / total) * 100 : 0
  const pLoss = total > 0 ? (stats.loss / total) * 100 : 0
  return (
    <div className="space-y-2.5">
      <div className="w-full h-1.5 rounded-full bg-white/[0.07] overflow-hidden flex">
        <div className="h-full transition-all duration-700 rounded-l-full" style={{ width: `${pG1}%`, background: C.green }} />
        <div className="h-full transition-all duration-700" style={{ width: `${pG2}%`, background: C.amber }} />
        <div className="h-full transition-all duration-700 rounded-r-full" style={{ width: `${pLoss}%`, background: C.red + '70' }} />
      </div>
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg" style={{ background: C.green + '14' }}>
          <span className="text-[10px] font-bold" style={{ color: C.green }}>Win</span>
          <span className="text-[11px] font-semibold" style={{ color: C.green }}>{stats.g1}</span>
          <span className="text-[10px] text-white/25">{pG1.toFixed(0)}%</span>
        </div>
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg" style={{ background: C.amber + '14' }}>
          <span className="text-[10px] font-bold" style={{ color: C.amber }}>Gale</span>
          <span className="text-[11px] font-semibold" style={{ color: C.amber }}>{stats.g2}</span>
          <span className="text-[10px] text-white/25">{pG2.toFixed(0)}%</span>
        </div>
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg" style={{ background: C.red + '14' }}>
          <span className="text-[10px] font-bold" style={{ color: C.red }}>Loss</span>
          <span className="text-[11px] font-semibold" style={{ color: C.red }}>{stats.loss}</span>
          <span className="text-[10px] text-white/25">{pLoss.toFixed(0)}%</span>
        </div>
        <span className="ml-auto text-xs font-bold" style={{ color: stats.winRate >= 60 ? C.green : stats.winRate >= 45 ? C.amber : C.red }}>{stats.winRate.toFixed(0)}%</span>
      </div>
      <p className="text-[10px] text-white/20">{total} entradas no histórico</p>
    </div>
  )
}

function WppBar({ wppConfig, onUpdate, selectedStrategyName }: { wppConfig: WppConfig; onUpdate: (partial: Partial<WppConfig>) => void; selectedStrategyName: string | null }) {
  const [showModal, setShowModal] = useState(false)
  const hasTargets = wppConfig.targets.length > 0
  const statusLabel = wppConfig.enabled
    ? selectedStrategyName ? `Ativo · ${selectedStrategyName}` : 'Ativo · selecione uma estratégia'
    : hasTargets ? `${wppConfig.targets.length} destino${wppConfig.targets.length > 1 ? 's' : ''} configurado${wppConfig.targets.length > 1 ? 's' : ''}` : 'Nenhum destino configurado'
  return (
    <>
      <div className="rounded-2xl border p-3.5 flex items-center gap-3 transition-all" style={{ borderColor: wppConfig.enabled ? C.green + '45' : 'rgba(255,255,255,0.08)', background: wppConfig.enabled ? C.green + '08' : 'rgba(255,255,255,0.015)' }}>
        <div className="h-9 w-9 rounded-2xl flex items-center justify-center shrink-0" style={{ background: wppConfig.enabled ? C.green + '20' : 'rgba(255,255,255,0.06)' }}>
          <MessageCircle className="h-4 w-4" style={{ color: wppConfig.enabled ? C.green : 'rgba(255,255,255,0.3)' }} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white/80 leading-tight">Robô WhatsApp</p>
          <p className="text-[11px] text-white/30 truncate mt-0.5">{statusLabel}</p>
        </div>
        <button onClick={() => setShowModal(true)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] border border-white/10 text-white/40 hover:bg-white/5 hover:text-white/70 transition-colors shrink-0">
          <Users className="h-3.5 w-3.5" />{hasTargets ? 'Editar' : 'Configurar'}
        </button>
        <button onClick={() => onUpdate({ enabled: !wppConfig.enabled })} disabled={!hasTargets} className="relative h-5 w-9 rounded-full transition-all duration-200 shrink-0 disabled:opacity-30 disabled:cursor-not-allowed" style={{ background: wppConfig.enabled ? C.green : 'rgba(255,255,255,0.12)' }}>
          <span className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-all duration-200 shadow" style={{ transform: wppConfig.enabled ? 'translateX(16px)' : 'translateX(0)' }} />
        </button>
      </div>
      {showModal && <WppModal onClose={() => setShowModal(false)} initialTargets={wppConfig.targets} onTargetsChange={targets => { onUpdate({ targets }); setShowModal(false) }} />}
    </>
  )
}

const LIMIT_OPTIONS = [50, 100, 200, 1000] as const
type LimitOption = typeof LIMIT_OPTIONS[number]
const DEFAULT_WPP: WppConfig = { enabled: false, serverConfigured: false, lastSentAt: null, targets: [] }

export default function StrategiesPage() {
  const { candles: rawCandles } = useCandles({ limit: 1000 })
  const [limit, setLimit] = useState<LimitOption>(100)
  const candles = useMemo(() => rawCandles.slice(-limit), [rawCandles, limit])

  // Persist selectedId + wpp in sessionStorage so navigation doesn't reset state
  const [selectedId, setSelectedIdRaw] = useState<string | null>(() => ssGet<string | null>(SS_KEY_SELECTED, null))
  const [wppConfig, setWppConfigRaw] = useState<WppConfig>(() => {
    const saved = ssGet<Partial<WppConfig>>(SS_KEY_WPP, {})
    return { ...DEFAULT_WPP, targets: saved.targets ?? [], enabled: saved.enabled ?? false }
  })

  const setSelectedId = useCallback((id: string | null) => { setSelectedIdRaw(id); ssSet(SS_KEY_SELECTED, id) }, [])
  const updateWppConfig = useCallback((partial: Partial<WppConfig>) => {
    setWppConfigRaw(prev => { const next = { ...prev, ...partial }; ssSet(SS_KEY_WPP, { targets: next.targets, enabled: next.enabled }); return next })
  }, [])

  const [stratConfig, setStratConfig] = useState<Record<string, string>>({})

  const tradeRef        = useRef<TradeState>({ phase: 'idle', entryCandles: 0, stratName: '' })
  const prevSignalRef   = useRef<'entrar' | 'aguardar' | 'bloqueado' | null>(null)
  const prevBlueRef     = useRef<boolean>(false)
  const lastCandleCount = useRef<number>(0)

  useEffect(() => {
    fetch(`${API_BASE}/whatsapp/status`).then(r => r.json()).then(d => {
      updateWppConfig({ serverConfigured: !!d.configured, ...(d.targets?.length ? { targets: d.targets } : {}) })
    }).catch(() => updateWppConfig({ serverConfigured: false }))
  }, [])

  const strategies = useMemo(() => buildStrategies(stratConfig), [stratConfig])
  const selected   = strategies.find(s => s.id === selectedId) ?? null

  const allStats = useMemo<Record<string, StratStats>>(() => {
    if (candles.length < 10) return {}
    return Object.fromEntries(strategies.map(s => [s.id, computeStats(s, candles)]))
  }, [strategies, candles])

  const allSignals = useMemo<Record<string, SignalResult | null>>(() => {
    if (!candles.length) return {}
    return Object.fromEntries(strategies.map(s => [s.id, s.detectSignal(candles)]))
  }, [strategies, candles])

  const sinalAtual: SignalResult | null = allSignals[selectedId ?? ''] ?? null

  const bestId = useMemo(() => {
    const valid = Object.entries(allStats).filter(([, st]) => st.total >= 10)
    if (!valid.length) return null
    return valid.sort((a, b) => b[1].winRate - a[1].winRate)[0][0]
  }, [allStats])

  const apiPost = useCallback(async (endpoint: string, body: object) => {
    // Guard: only send if bot is enabled, server configured, targets set, AND a strategy is selected
    if (!wppConfig.enabled || !wppConfig.serverConfigured || !wppConfig.targets.length || !selectedId) return
    try {
      await fetch(`${API_BASE}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, targets: wppConfig.targets }) })
      updateWppConfig({ lastSentAt: Date.now() })
    } catch {}
  }, [wppConfig.enabled, wppConfig.serverConfigured, wppConfig.targets, selectedId, updateWppConfig])

  // Main monitor — only runs when a NEW candle arrives (candles.length changed)
  useEffect(() => {
    if (!wppConfig.enabled || !selected || !candles.length) return
    if (candles.length === lastCandleCount.current) return  // same set of candles, skip (e.g. tab switch)
    lastCandleCount.current = candles.length

    const tipo  = sinalAtual?.tipo ?? null
    const trade = tradeRef.current
    const blue  = bluePercent(candles, 20)

    // Market paying alert (cooldown handled server-side)
    if (blue < 0.45 && !prevBlueRef.current) apiPost('/whatsapp/market-paying', { bluePercent: blue })
    prevBlueRef.current = blue < 0.45

    const prevTipo = prevSignalRef.current

    if (trade.phase === 'idle') {
      if (prevTipo !== 'entrar' && tipo === 'entrar') {
        apiPost('/whatsapp/warning', { strategyName: selected.name })
        tradeRef.current = { phase: 'warning_sent', entryCandles: candles.length, stratName: selected.name }
      }
    } else if (trade.phase === 'warning_sent') {
      if (tipo === 'entrar' && candles.length > trade.entryCandles) {
        apiPost('/whatsapp/confirmed', { strategyName: selected.name })
        tradeRef.current = { ...trade, phase: 'confirmed', entryCandles: candles.length }
      } else if (tipo !== 'entrar' && candles.length > trade.entryCandles) {
        tradeRef.current = { ...trade, phase: 'idle' }
      }
    } else if (trade.phase === 'confirmed') {
      if (candles.length > trade.entryCandles) {
        const mult = Number(candles[candles.length - 1].multiplicador)
        if (mult >= 2) { apiPost('/whatsapp/result', { strategyName: selected.name, result: 'win_g1', multiplier: mult }); tradeRef.current = { ...trade, phase: 'idle' } }
        else tradeRef.current = { ...trade, phase: 'gale', entryCandles: candles.length }
      }
    } else if (trade.phase === 'gale') {
      if (candles.length > trade.entryCandles) {
        const mult = Number(candles[candles.length - 1].multiplicador)
        apiPost('/whatsapp/result', { strategyName: selected.name, result: mult >= 2 ? 'win_g2' : 'loss', multiplier: mult })
        tradeRef.current = { ...trade, phase: 'idle' }
      }
    }

    prevSignalRef.current = tipo
  }, [candles, sinalAtual, wppConfig.enabled, selected, apiPost])

  // Reset trade machine when strategy changes (not on tab switch)
  useEffect(() => {
    tradeRef.current        = { phase: 'idle', entryCandles: 0, stratName: '' }
    prevSignalRef.current   = null
    lastCandleCount.current = 0
  }, [selectedId])

  const phaseBadge = useMemo(() => {
    if (!wppConfig.enabled || !selected) return null
    const p = tradeRef.current.phase
    if (p === 'warning_sent') return { label: 'Atenção enviado', color: C.amber }
    if (p === 'confirmed')    return { label: 'Aguardando G1', color: C.green }
    if (p === 'gale')         return { label: 'Aguardando G2', color: C.red }
    return null
  }, [wppConfig.enabled, selected, sinalAtual])

  return (
    <div className="space-y-5 pb-20 lg:pb-0">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-xl font-bold text-foreground">Estratégias</h2>
        <div className="flex rounded-lg overflow-hidden border border-white/10">
          {LIMIT_OPTIONS.map(l => (
            <button key={l} onClick={() => setLimit(l)} className="px-2.5 py-1 text-[11px] font-medium transition-colors" style={{ background: limit === l ? 'rgba(127,119,221,0.3)' : 'transparent', color: limit === l ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.4)' }}>{l}</button>
          ))}
        </div>
      </div>

      <WppBar wppConfig={wppConfig} onUpdate={updateWppConfig} selectedStrategyName={selected?.name ?? null} />

      {phaseBadge && (
        <div className="rounded-xl border px-3.5 py-2.5 flex items-center gap-2" style={{ borderColor: phaseBadge.color + '40', background: phaseBadge.color + '10' }}>
          <span className="h-2 w-2 rounded-full animate-pulse" style={{ background: phaseBadge.color }} />
          <span className="text-xs font-medium" style={{ color: phaseBadge.color }}>{phaseBadge.label}</span>
        </div>
      )}

      {sinalAtual ? (
        <div className="rounded-2xl border p-3.5" style={{ borderColor: sinalAtual.color + '50', background: sinalAtual.color + '0e' }}>
          <div className="flex items-start gap-3">
            {sinalAtual.tipo === 'entrar'    && <CheckCircle2 className="h-5 w-5 shrink-0 mt-0.5" style={{ color: C.green }} />}
            {sinalAtual.tipo === 'bloqueado' && <ShieldAlert  className="h-5 w-5 shrink-0 mt-0.5" style={{ color: C.amber }} />}
            {sinalAtual.tipo === 'aguardar'  && <Activity     className="h-5 w-5 shrink-0 mt-0.5" style={{ color: C.purple }} />}
            <div className="flex-1 min-w-0">
              <p className="text-[10px] text-white/35 uppercase tracking-widest mb-0.5">{selected?.name}</p>
              <p className="text-sm font-semibold text-white leading-snug">{sinalAtual.msg}</p>
              {wppConfig.lastSentAt && <p className="text-[10px] text-white/25 mt-1">Último envio: {new Date(wppConfig.lastSentAt).toLocaleTimeString('pt-BR')}</p>}
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.015] p-4 text-center text-sm text-white/25">Selecione uma estratégia abaixo para ativar o robô</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {strategies.map(s => {
          const isActive   = selectedId === s.id
          const stats      = allStats[s.id]
          const cardSignal = allSignals[s.id]
          const isBest     = bestId === s.id
          const statusBadge = !isActive && cardSignal
            ? cardSignal.tipo === 'entrar'    ? { color: C.green, label: 'entraria agora', glow: true }
            : cardSignal.tipo === 'bloqueado' ? { color: C.amber, label: 'bloqueado', glow: false }
            :                                  { color: C.muted, label: 'aguardando', glow: false }
            : null
          return (
            <div key={s.id} onClick={() => setSelectedId(isActive ? null : s.id)} className="rounded-2xl border p-4 cursor-pointer transition-all duration-150 space-y-3 select-none" style={{ borderColor: isActive ? C.purple + '70' : isBest ? C.green + '35' : 'rgba(255,255,255,0.07)', background: isActive ? C.purple + '12' : 'rgba(255,255,255,0.015)' }}>
              <div className="flex items-center gap-2.5">
                <span style={{ color: isActive ? C.purple : 'rgba(255,255,255,0.35)' }}>{s.icon}</span>
                <h3 className="text-sm font-semibold text-white/85 flex-1 leading-snug">{s.name}</h3>
                {isBest && !isActive && <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border shrink-0" style={{ color: C.green, borderColor: C.green + '40', background: C.green + '10' }}><Trophy className="h-2.5 w-2.5" /> top</span>}
                {!isActive && statusBadge && <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border shrink-0" style={{ color: statusBadge.color, borderColor: statusBadge.color + '40', background: statusBadge.color + '10', boxShadow: statusBadge.glow ? `0 0 8px ${statusBadge.color}50` : 'none' }}><span className="h-1.5 w-1.5 rounded-full" style={{ background: statusBadge.color }} />{statusBadge.label}</span>}
                {isActive && (
                  <div className="flex items-center gap-1.5">
                    {wppConfig.enabled && <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: C.green + '20', color: C.green }}><MessageCircle className="h-2.5 w-2.5" /></span>}
                    <div className="h-2 w-2 rounded-full shrink-0" style={{ background: C.green, boxShadow: `0 0 6px ${C.green}` }} />
                  </div>
                )}
              </div>
              {stats && stats.total > 0 ? <StatsRow stats={stats} /> : <p className="text-[11px] text-white/20">Calculando estatísticas...</p>}
              {isActive && s.configFields && (
                <div className="flex gap-3 flex-wrap" onClick={e => e.stopPropagation()}>
                  {s.configFields.map(f => (
                    <div key={f.key}>
                      <p className="text-[10px] text-white/30 mb-1">{f.label}</p>
                      <input type={f.type} defaultValue={stratConfig[f.key] ?? f.defaultValue} onChange={e => setStratConfig(c => ({ ...c, [f.key]: e.target.value }))} className="w-24 text-xs bg-white/[0.07] border border-white/15 rounded-lg px-2 py-1.5 text-white focus:outline-none focus:border-white/30" />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}