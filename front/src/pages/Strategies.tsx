import { useState, useMemo, useRef, useEffect } from 'react'
import { useCandles } from '@/hooks/useCandles'
import {
  Activity, ShieldAlert, CheckCircle2,
  MessageCircle, Clock, Zap, TrendingUp, Trophy,
} from 'lucide-react'

// ── Paleta ────────────────────────────────────────────────────────────────────
const C = {
  purple: 'hsl(263,70%,58%)',
  green:  'hsl(142,71%,45%)',
  amber:  'hsl(38,92%,50%)',
  red:    'hsl(0,72%,55%)',
  muted:  'rgba(255,255,255,0.18)',
}

// ── WhatsApp stub ─────────────────────────────────────────────────────────────
function notifyWhatsApp(phone: string, message: string) {
  if (!phone) return
  console.log('[WhatsApp] Pronto para envio:', { phone, message })
}

// ── Tipos ─────────────────────────────────────────────────────────────────────
interface SignalResult {
  tipo: 'entrar' | 'aguardar' | 'bloqueado'
  msg: string
  color: string
}

interface StratStats {
  wins: number    // total wins (G1 + G2)
  losses: number
  g1: number      // win direto (candle i+1 >= 2)
  g2: number      // win com gale (candle i+1 < 2, mas candle i+2 >= 2)
  loss: number    // perdeu mesmo com gale
  winRate: number
  total: number
}

interface ConfigField {
  key: string
  label: string
  type: 'number'
  defaultValue: string
}

interface StrategyDef {
  id: string
  name: string
  description: string
  icon: React.ReactNode
  detectSignal: (candles: any[]) => SignalResult | null
  configFields?: ConfigField[]
}

// ── Backtest automático ───────────────────────────────────────────────────────
// G1 = candle i+1 >= 2 (win direto)
// G2 = candle i+1 < 2 E candle i+2 >= 2 (win com 1 gale)
// Loss = candle i+1 < 2 E candle i+2 < 2 (perdeu)
function computeStats(strategy: StrategyDef, candles: any[]): StratStats {
  let g1 = 0, g2 = 0, loss = 0
  for (let i = 5; i < candles.length - 2; i++) {
    const signal = strategy.detectSignal(candles.slice(0, i + 1))
    if (signal?.tipo !== 'entrar') continue
    const next1 = Number(candles[i + 1].multiplicador)
    const next2 = Number(candles[i + 2].multiplicador)
    if (next1 >= 2) {
      g1++
    } else if (next2 >= 2) {
      g2++
    } else {
      loss++
    }
  }
  const wins    = g1 + g2
  const total   = wins + loss
  const winRate = total > 0 ? (wins / total) * 100 : 0
  return { wins, losses: loss, g1, g2, loss, winRate, total }
}

// ── Estratégias ───────────────────────────────────────────────────────────────
function buildStrategies(config: Record<string, string>): StrategyDef[] {
  return [
    {
      id: 's_horario',
      name: 'Estratégia por Horário',
      description: 'Analisa o intervalo médio entre roxas e sinaliza quando está na hora de entrar.',
      icon: <Clock className="h-4 w-4" />,
      configFields: [
        { key: 'tolerancia', label: 'Tolerância (min)', type: 'number', defaultValue: '1' },
      ],
      detectSignal(candles) {
        const purples = candles
          .filter((c: any) => c.cor === 'purple' && c.created_at)
          .sort((a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
        if (purples.length < 3) return { tipo: 'aguardar', msg: 'Poucas roxas para calcular intervalo', color: C.muted }

        const intervals: number[] = []
        for (let i = 1; i < purples.length; i++) {
          const diff = (new Date(purples[i].created_at).getTime() - new Date(purples[i - 1].created_at).getTime()) / 60_000
          if (diff > 0 && diff < 60) intervals.push(diff)
        }
        if (intervals.length < 2) return { tipo: 'aguardar', msg: 'Dados insuficientes para intervalo médio', color: C.muted }

        const avg      = intervals.reduce((s, v) => s + v, 0) / intervals.length
        const last     = purples[purples.length - 1]
        const minSince = (Date.now() - new Date(last.created_at).getTime()) / 60_000
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
      id: 's_roxa_azul50',
      name: 'Sequência da Vela Roxa',
      description: 'Entrada após roxa quando azuis < 50% e sem streak de 4+ azuis antes.',
      icon: <Zap className="h-4 w-4" />,
      detectSignal(candles) {
        if (candles.length < 5) return null
        const last = candles[candles.length - 1]
        if (last?.cor !== 'purple') return { tipo: 'aguardar', msg: 'Aguardando vela roxa...', color: C.muted }

        let streak = 0
        for (let i = candles.length - 2; i >= 0; i--) { if (candles[i].cor === 'blue') streak++; else break }
        if (streak >= 4) return { tipo: 'bloqueado', msg: `Bloqueado: ${streak} azuis antes da roxa`, color: C.amber }

        const pct = candles.slice(-10).filter((c: any) => c.cor === 'blue').length / 10
        if (pct >= 0.5) return { tipo: 'bloqueado', msg: `Bloqueado: ${(pct * 100).toFixed(0)}% azul nas últimas 10`, color: C.amber }

        return { tipo: 'entrar', msg: `ENTRAR — roxa + ${(pct * 100).toFixed(0)}% azul + streak ok!`, color: C.green }
      },
    },

    {
      id: 's_inicio_azuis',
      name: 'Detectar Início de Azuis',
      description: 'Detecta o primeiro candle azul após uma quebra — início de streak azul.',
      icon: <TrendingUp className="h-4 w-4" />,
      detectSignal(candles) {
        if (candles.length < 3) return null
        const len = candles.length
        const last = candles[len - 1], prev = candles[len - 2]

        if (last?.cor === 'blue' && prev?.cor !== 'blue')
          return { tipo: 'entrar', msg: 'ENTRAR — início de streak azul detectado!', color: C.green }

        if (last?.cor === 'blue') {
          let s = 0
          for (let i = len - 1; i >= 0; i--) { if (candles[i].cor === 'blue') s++; else break }
          if (s >= 3) return { tipo: 'bloqueado', msg: `Streak ${s}x — aguardar reset`, color: C.amber }
          return { tipo: 'aguardar', msg: `Azul ${s}x em andamento`, color: C.muted }
        }
        return { tipo: 'aguardar', msg: 'Aguardando início de streak azul...', color: C.muted }
      },
    },

    {
      id: 's_inicio_roxas',
      name: 'Detectar Início de Roxas',
      description: 'Detecta padrão de roxa após 2–4 azuis consecutivos (início de ciclo roxo).',
      icon: <Activity className="h-4 w-4" />,
      detectSignal(candles) {
        if (candles.length < 5) return null
        const len = candles.length
        const last = candles[len - 1]

        if (last?.cor === 'purple') {
          let blues = 0
          for (let i = len - 2; i >= 0; i--) { if (candles[i].cor === 'blue') blues++; else break }
          if (blues >= 2 && blues <= 4) return { tipo: 'entrar', msg: `ENTRAR — roxa após ${blues} azuis!`, color: C.green }
          if (blues > 4) return { tipo: 'bloqueado', msg: `Roxa com ${blues} azuis — streak alto`, color: C.amber }
          return { tipo: 'aguardar', msg: 'Roxa sem padrão claro', color: C.muted }
        }
        if (last?.cor === 'blue') {
          let s = 0
          for (let i = len - 1; i >= 0; i--) { if (candles[i].cor === 'blue') s++; else break }
          if (s >= 2 && s <= 4) return { tipo: 'aguardar', msg: `${s} azuis — possível roxa chegando`, color: C.purple }
        }
        return { tipo: 'aguardar', msg: 'Aguardando padrão de início de roxas...', color: C.muted }
      },
    },
  ]
}

// ── WinRate bar ───────────────────────────────────────────────────────────────
function WinRateBar({ rate }: { rate: number }) {
  const color = rate >= 60 ? C.green : rate >= 45 ? C.amber : C.red
  return (
    <div className="w-full h-1 rounded-full bg-white/[0.07] overflow-hidden">
      <div className="h-full rounded-full transition-all duration-700" style={{ width: `${rate}%`, background: color }} />
    </div>
  )
}

// ── StatsRow ──────────────────────────────────────────────────────────────────
function StatsRow({ stats }: { stats: StratStats }) {
  const total = stats.total
  const pG1   = total > 0 ? (stats.g1   / total) * 100 : 0
  const pG2   = total > 0 ? (stats.g2   / total) * 100 : 0
  const pLoss = total > 0 ? (stats.loss / total) * 100 : 0

  return (
    <div className="space-y-2.5">
      {/* Barra de win rate geral */}
      <div className="w-full h-1.5 rounded-full bg-white/[0.07] overflow-hidden flex">
        <div className="h-full transition-all duration-700 rounded-l-full" style={{ width: `${pG1}%`, background: C.green }} />
        <div className="h-full transition-all duration-700" style={{ width: `${pG2}%`, background: C.amber }} />
        <div className="h-full transition-all duration-700 rounded-r-full" style={{ width: `${pLoss}%`, background: C.red + '70' }} />
      </div>

      {/* Números detalhados */}
      <div className="flex items-center gap-2">
        {/* Win */}
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg" style={{ background: C.green + '14' }}>
          <span className="text-[10px] font-bold" style={{ color: C.green }}>Win</span>
          <span className="text-[11px] font-semibold" style={{ color: C.green }}>{stats.g1}</span>
          <span className="text-[10px] text-white/25">{pG1.toFixed(0)}%</span>
        </div>

        {/* Martingale */}
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg" style={{ background: C.amber + '14' }}>
          <span className="text-[10px] font-bold" style={{ color: C.amber }}>Martingale</span>
          <span className="text-[11px] font-semibold" style={{ color: C.amber }}>{stats.g2}</span>
          <span className="text-[10px] text-white/25">{pG2.toFixed(0)}%</span>
        </div>

        {/* Loss */}
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg" style={{ background: C.red + '14' }}>
          <span className="text-[10px] font-bold" style={{ color: C.red }}>Loss</span>
          <span className="text-[11px] font-semibold" style={{ color: C.red }}>{stats.loss}</span>
          <span className="text-[10px] text-white/25">{pLoss.toFixed(0)}%</span>
        </div>

        {/* Win rate */}
        <span className="ml-auto text-xs font-bold"
          style={{ color: stats.winRate >= 60 ? C.green : stats.winRate >= 45 ? C.amber : C.red }}>
          {stats.winRate.toFixed(0)}%
        </span>
      </div>

      <p className="text-[10px] text-white/20">{total} entradas no histórico</p>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
const LIMIT_OPTIONS = [50, 100, 200, 1000] as const
type LimitOption = typeof LIMIT_OPTIONS[number]

export default function StrategiesPage() {
  const { candles: rawCandles } = useCandles({ limit: 1000 })
  const [limit, setLimit] = useState<LimitOption>(100)

  const candles = useMemo(() => rawCandles.slice(-limit), [rawCandles, limit])

  const [selectedId,    setSelectedId]    = useState<string | null>(null)
  const [stratConfig,   setStratConfig]   = useState<Record<string, string>>({})
  const [wppPhone,      setWppPhone]      = useState(() =>
    typeof window !== 'undefined' ? localStorage.getItem('wpp_phone') || '' : ''
  )
  const [showWppConfig, setShowWppConfig] = useState(false)
  const prevSinalRef = useRef<string | null>(null)

  const strategies = useMemo(() => buildStrategies(stratConfig), [stratConfig])
  const selected   = strategies.find(s => s.id === selectedId) ?? null

  const allStats = useMemo<Record<string, StratStats>>(() => {
    if (candles.length < 10) return {}
    return Object.fromEntries(strategies.map(s => [s.id, computeStats(s, candles)]))
  }, [strategies, candles])

  const allSignals = useMemo<Record<string, SignalResult | null>>(() => {
    if (candles.length === 0) return {}
    return Object.fromEntries(strategies.map(s => [s.id, s.detectSignal(candles)]))
  }, [strategies, candles])

  const sinalAtual: SignalResult | null = allSignals[selectedId ?? ''] ?? null

  const bestId = useMemo(() => {
    const valid = Object.entries(allStats).filter(([, st]) => st.total >= 10)
    if (!valid.length) return null
    return valid.sort((a, b) => b[1].winRate - a[1].winRate)[0][0]
  }, [allStats])

  useEffect(() => {
    const tipo = sinalAtual?.tipo ?? null
    if (tipo === 'entrar' && prevSinalRef.current !== 'entrar' && wppPhone) {
      notifyWhatsApp(wppPhone, `🟢 Sinal: ${sinalAtual!.msg} [${selected?.name}]`)
    }
    prevSinalRef.current = tipo
  }, [sinalAtual, wppPhone, selected])

  return (
    <div className="space-y-5 pb-20 lg:pb-0">

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-xl font-bold text-foreground">Estratégias</h2>
        <div className="flex items-center gap-2">
          {/* Filtro de velas */}
          <div className="flex rounded-lg overflow-hidden border border-white/10">
            {LIMIT_OPTIONS.map(l => (
              <button
                key={l}
                onClick={() => setLimit(l)}
                className="px-2.5 py-1 text-[11px] font-medium transition-colors"
                style={{
                  background: limit === l ? 'rgba(127,119,221,0.3)' : 'transparent',
                  color: limit === l ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.4)',
                }}
              >
                {l}
              </button>
            ))}
          </div>
          <button
            onClick={() => setShowWppConfig(v => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs border border-white/10 text-white/40 hover:bg-white/5 transition-colors"
          >
            <MessageCircle className="h-3.5 w-3.5" />
            WhatsApp
          </button>
        </div>
      </div>

      {/* WhatsApp config */}
      {showWppConfig && (
        <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-4 space-y-3">
          <div className="flex items-center gap-2">
            <MessageCircle className="h-4 w-4" style={{ color: C.green }} />
            <p className="text-sm font-semibold text-white/80">Notificações WhatsApp</p>
            <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full border" style={{ borderColor: C.amber + '50', color: C.amber }}>
              Em breve
            </span>
          </div>
          <p className="text-[11px] text-white/30 leading-relaxed">
            Receba sinais automáticos no WhatsApp quando uma estratégia sinalizar entrada.
          </p>
          <div className="flex gap-2">
            <input
              type="tel" placeholder="+55 11 99999-9999" value={wppPhone}
              onChange={e => setWppPhone(e.target.value)}
              className="flex-1 text-xs bg-white/[0.07] border border-white/15 rounded-xl px-3 py-2 text-white placeholder:text-white/20"
            />
            <button
              onClick={() => localStorage.setItem('wpp_phone', wppPhone)}
              className="px-4 py-2 rounded-xl text-xs border border-white/15 text-white/50 hover:bg-white/5 transition-colors"
            >
              Salvar
            </button>
          </div>
          <p className="text-[10px] text-white/20">
            🔧 Integração via Evolution API / Z-API — aguardando configuração do servidor.
          </p>
        </div>
      )}

      {/* Sinal ao vivo */}
      {sinalAtual ? (
        <div
          className="rounded-2xl border p-3.5"
          style={{ borderColor: sinalAtual.color + '50', background: sinalAtual.color + '0e' }}
        >
          <div className="flex items-start gap-3">
            {sinalAtual.tipo === 'entrar'    && <CheckCircle2 className="h-5 w-5 shrink-0 mt-0.5" style={{ color: C.green  }} />}
            {sinalAtual.tipo === 'bloqueado' && <ShieldAlert  className="h-5 w-5 shrink-0 mt-0.5" style={{ color: C.amber  }} />}
            {sinalAtual.tipo === 'aguardar'  && <Activity     className="h-5 w-5 shrink-0 mt-0.5" style={{ color: C.purple }} />}
            <div className="flex-1 min-w-0">
              <p className="text-[10px] text-white/35 uppercase tracking-widest mb-0.5">{selected?.name}</p>
              <p className="text-sm font-semibold text-white leading-snug">{sinalAtual.msg}</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.015] p-4 text-center text-sm text-white/25">
          Selecione uma estratégia abaixo para ativar o robô
        </div>
      )}

      {/* Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {strategies.map(s => {
          const isActive   = selectedId === s.id
          const stats      = allStats[s.id]
          const cardSignal = allSignals[s.id]
          const isBest     = bestId === s.id

          const statusBadge = !isActive && cardSignal ? (
            cardSignal.tipo === 'entrar'    ? { color: C.green, label: 'entraria agora', glow: true  } :
            cardSignal.tipo === 'bloqueado' ? { color: C.amber, label: 'bloqueado',      glow: false } :
                                             { color: C.muted,  label: 'aguardando',     glow: false }
          ) : null

          return (
            <div
              key={s.id}
              onClick={() => setSelectedId(isActive ? null : s.id)}
              className="rounded-2xl border p-4 cursor-pointer transition-all duration-150 space-y-3 select-none"
              style={{
                borderColor: isActive ? C.purple + '70' : isBest ? C.green + '35' : 'rgba(255,255,255,0.07)',
                background:  isActive ? C.purple + '12' : 'rgba(255,255,255,0.015)',
              }}
            >
              {/* Header do card */}
              <div className="flex items-center gap-2.5">
                <span style={{ color: isActive ? C.purple : 'rgba(255,255,255,0.35)' }}>{s.icon}</span>
                <h3 className="text-sm font-semibold text-white/85 flex-1 leading-snug">{s.name}</h3>

                {isBest && !isActive && (
                  <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border shrink-0"
                    style={{ color: C.green, borderColor: C.green + '40', background: C.green + '10' }}>
                    <Trophy className="h-2.5 w-2.5" /> top
                  </span>
                )}

                {!isActive && statusBadge && (
                  <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border shrink-0"
                    style={{
                      color:       statusBadge.color,
                      borderColor: statusBadge.color + '40',
                      background:  statusBadge.color + '10',
                      boxShadow:   statusBadge.glow ? `0 0 8px ${statusBadge.color}50` : 'none',
                    }}>
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: statusBadge.color }} />
                    {statusBadge.label}
                  </span>
                )}

                {isActive && (
                  <div className="h-2 w-2 rounded-full shrink-0"
                    style={{ background: C.green, boxShadow: `0 0 6px ${C.green}` }} />
                )}
              </div>

              {/* Stats com Win / Martingale / Loss */}
              {stats && stats.total > 0 ? (
                <StatsRow stats={stats} />
              ) : (
                <p className="text-[11px] text-white/20">Calculando estatísticas...</p>
              )}

              {/* Config fields (só quando ativo) */}
              {isActive && s.configFields && (
                <div className="flex gap-3 flex-wrap" onClick={e => e.stopPropagation()}>
                  {s.configFields.map(f => (
                    <div key={f.key}>
                      <p className="text-[10px] text-white/30 mb-1">{f.label}</p>
                      <input
                        type={f.type}
                        defaultValue={stratConfig[f.key] ?? f.defaultValue}
                        onChange={e => setStratConfig(c => ({ ...c, [f.key]: e.target.value }))}
                        className="w-24 text-xs bg-white/[0.07] border border-white/15 rounded-lg px-2 py-1.5 text-white"
                      />
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