import { useMemo, useRef } from 'react'
import { useCandles } from '@/hooks/useCandles'
import { useWS } from '@/contexts/WebSocketContext'
import { calcularStats } from '@/utils/candleUtils'
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  CartesianGrid, ReferenceLine,
} from 'recharts'
import { TrendingUp, Activity, Zap, Target, ShieldAlert, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react'
import { getHours, isValid } from 'date-fns'

// ── Paleta ─────────────────────────────────────────────────────────────────────
const C = {
  blue:   'hsl(217,91%,60%)',
  purple: 'hsl(263,70%,58%)',
  pink:   'hsl(330,80%,60%)',
  green:  'hsl(142,71%,45%)',
  amber:  'hsl(38,92%,50%)',
  grid:   'rgba(255,255,255,0.06)',
  axis:   'rgba(255,255,255,0.25)',
}

const TT = {
  contentStyle: {
    background: '#0d0d0f',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 10,
    fontSize: 12,
  },
  itemStyle: { color: '#fff' },
  labelStyle: { color: 'rgba(255,255,255,0.5)', fontSize: 11 },
}

// ── Hook debounce width ─────────────────────────────────────────────────────────
function useDebouncedWidth(ref: React.RefObject<HTMLDivElement>, delay = 120) {
  const [width, setWidth] = ([] as any[]).concat(
    require !== undefined ? [] : []
  )
  // fallback simples sem ResizeObserver pra SSR
  return 0
}

// ── Helpers da estratégia ──────────────────────────────────────────────────────

/** Streak de azuis imediatamente antes do índice i */
function streakAzulAntes(candles: any[], i: number): number {
  let count = 0
  for (let j = i - 1; j >= 0; j--) {
    if (candles[j].cor === 'blue') count++
    else break
  }
  return count
}

/** Média das últimas N velas antes do índice i */
function mediaAntes(candles: any[], i: number, n = 10): number {
  const slice = candles.slice(Math.max(0, i - n), i)
  if (!slice.length) return 0
  return slice.reduce((s: number, c: any) => s + Number(c.multiplicador), 0) / slice.length
}

/** Houve rosa nas últimas N velas antes do índice i */
function rosaRecenteAntes(candles: any[], i: number, n = 15): boolean {
  return candles.slice(Math.max(0, i - n), i).some((c: any) => c.cor === 'pink')
}

/** % azuis nas últimas N velas antes do índice i */
function pctAzulAntes(candles: any[], i: number, n = 10): number {
  const slice = candles.slice(Math.max(0, i - n), i)
  if (!slice.length) return 0
  return slice.filter((c: any) => c.cor === 'blue').length / slice.length
}

/**
 * Simula a estratégia ao longo do histórico:
 * - Disparador: vela roxa aparece
 * - Entrada: próxima vela
 * - Bloqueio: 4+ azuis imediatamente antes da roxa
 * - Mercado bom: média10 > 2x + rosa recente (15v) + pctAzul10 < 0.6
 */
function simularEstrategia(candles: any[]) {
  const resultados: {
    index: number
    entrada: number        // multiplicador da vela de entrada
    cor: string            // cor da vela de entrada
    ganhou: boolean        // entrou em roxa ou rosa?
    bloqueado: boolean
    mercadoBom: boolean
    streakAzul: number
    mediaAnterior: number
  }[] = []

  for (let i = 1; i < candles.length - 1; i++) {
    if (candles[i].cor !== 'purple') continue

    const streak     = streakAzulAntes(candles, i)
    const media      = mediaAntes(candles, i)
    const rosaRecent = rosaRecenteAntes(candles, i)
    const pctAzul    = pctAzulAntes(candles, i)

    const bloqueado  = streak >= 4
    const mercadoBom = media > 2 && rosaRecent && pctAzul < 0.6

    const proxima    = candles[i + 1]
    const ganhou     = proxima.cor === 'purple' || proxima.cor === 'pink'

    resultados.push({
      index: i + 1,
      entrada: Number(proxima.multiplicador),
      cor: proxima.cor,
      ganhou,
      bloqueado,
      mercadoBom,
      streakAzul: streak,
      mediaAnterior: Number(media.toFixed(2)),
    })
  }
  return resultados
}

// ── Card ───────────────────────────────────────────────────────────────────────
function Card({
  title, subtitle, icon: Icon, children, accent,
}: {
  title: string
  subtitle?: string
  icon: any
  children: React.ReactNode
  accent?: string
}) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/3 p-5 flex flex-col gap-4">
      <div className="flex items-center gap-2.5">
        <div className="p-1.5 rounded-lg bg-white/5">
          <Icon className="h-4 w-4 text-white/50" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-white/90 leading-none">{title}</h3>
          {subtitle && <p className="text-[11px] text-white/35 mt-0.5">{subtitle}</p>}
        </div>
        {accent && (
          <span className="ml-auto text-xs font-semibold px-2 py-0.5 rounded-full bg-white/5 text-white/60">
            {accent}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}

// ── Stat pill ──────────────────────────────────────────────────────────────────
function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5 p-3 rounded-xl bg-white/5">
      <span className="text-[10px] text-white/35 uppercase tracking-wider">{label}</span>
      <span className="text-lg font-bold" style={{ color: color || '#fff' }}>{value}</span>
    </div>
  )
}

// ── Página Principal ───────────────────────────────────────────────────────────
export default function ChartsPage() {
  const ws = useWS()
  const { candles: dbCandles } = useCandles({ limit: 500 })

  const candles = useMemo(() => {
    const wsCandles: any[] = Array.isArray(ws?.candles) ? ws.candles : []
    const key = (c: any) => {
      const bucket = Math.floor(new Date(c.created_at).getTime() / 3000)
      return `${Number(c.multiplicador).toFixed(2)}_${bucket}`
    }
    const map = new Map<string, any>()
    for (const c of dbCandles) map.set(key(c), c)
    for (const c of wsCandles) { if (!map.has(key(c))) map.set(key(c), c) }
    return Array.from(map.values())
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
  }, [dbCandles, ws?.candles])

  const stats = useMemo(() => calcularStats(candles), [candles])

  // ── Simulação da estratégia ──────────────────────────────────────────────────
  const simulacao = useMemo(() => simularEstrategia(candles), [candles])

  const totalEntradas    = simulacao.filter(r => !r.bloqueado).length
  const entradasBoas     = simulacao.filter(r => !r.bloqueado && r.mercadoBom)
  const totalBloqueadas  = simulacao.filter(r => r.bloqueado).length

  const taxaGeral        = totalEntradas > 0
    ? (simulacao.filter(r => !r.bloqueado && r.ganhou).length / totalEntradas * 100).toFixed(1)
    : '—'

  const taxaMercadoBom   = entradasBoas.length > 0
    ? (entradasBoas.filter(r => r.ganhou).length / entradasBoas.length * 100).toFixed(1)
    : '—'

  const taxaSemFiltro    = simulacao.length > 0
    ? (simulacao.filter(r => r.ganhou).length / simulacao.length * 100).toFixed(1)
    : '—'

  // ── Gráfico 1: Win/Loss por entrada ─────────────────────────────────────────
  const entradaTimeline = useMemo(() =>
    simulacao
      .filter(r => !r.bloqueado)
      .slice(-60)
      .map((r, i) => ({
        i: i + 1,
        resultado: r.ganhou ? 1 : -1,
        cor: r.cor,
        entrada: r.entrada,
        mercadoBom: r.mercadoBom,
      })),
    [simulacao]
  )

  // ── Gráfico 2: Taxa de sucesso por streak azul antes ─────────────────────────
  const taxaPorStreak = useMemo(() => {
    const grupos: Record<number, { wins: number; total: number }> = {}
    simulacao.forEach(r => {
      const k = Math.min(r.streakAzul, 6)
      if (!grupos[k]) grupos[k] = { wins: 0, total: 0 }
      grupos[k].total++
      if (r.ganhou) grupos[k].wins++
    })
    return Object.entries(grupos)
      .map(([k, v]) => ({
        streak: Number(k),
        label: Number(k) >= 6 ? '6+' : `${k}`,
        taxa: v.total > 0 ? Number((v.wins / v.total * 100).toFixed(1)) : 0,
        total: v.total,
        bloqueado: Number(k) >= 4,
      }))
      .sort((a, b) => a.streak - b.streak)
  }, [simulacao])

  // ── Gráfico 3: O que vem após uma roxa? ──────────────────────────────────────
  const aposRoxa = useMemo(() => {
    let blue = 0, purple = 0, pink = 0, total = 0
    for (let i = 0; i < candles.length - 1; i++) {
      if (candles[i].cor !== 'purple') continue
      total++
      const prox = candles[i + 1].cor
      if (prox === 'blue')   blue++
      if (prox === 'purple') purple++
      if (prox === 'pink')   pink++
    }
    return [
      { label: 'Azul',  count: blue,   pct: total ? +(blue   / total * 100).toFixed(1) : 0, cor: 'blue'   },
      { label: 'Roxa',  count: purple, pct: total ? +(purple / total * 100).toFixed(1) : 0, cor: 'purple' },
      { label: 'Rosa',  count: pink,   pct: total ? +(pink   / total * 100).toFixed(1) : 0, cor: 'pink'   },
    ]
  }, [candles])

  // ── Gráfico 4: Média móvel 10 — "mercado pagando bem?" ────────────────────────
  const mediaMovel = useMemo(() =>
    candles.slice(-80).map((c, i, arr) => {
      const slice = arr.slice(Math.max(0, i - 9), i + 1)
      const ma = slice.reduce((s: number, x: any) => s + Number(x.multiplicador), 0) / slice.length
      const pctAzul = slice.filter((x: any) => x.cor === 'blue').length / slice.length
      return {
        i: i + 1,
        ma: Number(ma.toFixed(2)),
        pctAzul: Number((pctAzul * 100).toFixed(1)),
        cor: c.cor,
        mult: Number(c.multiplicador).toFixed(2),
      }
    }),
    [candles]
  )

  // ── Gráfico 5: Após N azuis consecutivas, o que veio? ────────────────────────
  const aposNAzuis = useMemo(() => {
    const grupos: Record<number, { blue: number; purple: number; pink: number }> = {}
    for (let n = 0; n <= 7; n++) grupos[n] = { blue: 0, purple: 0, pink: 0 }
    for (let i = 1; i < candles.length; i++) {
      if (candles[i].cor === 'blue') continue
      const streak = streakAzulAntes(candles, i)
      const k = Math.min(streak, 7)
      const cor = candles[i].cor as 'blue' | 'purple' | 'pink'
      grupos[k][cor]++
    }
    return Object.entries(grupos)
      .filter(([, v]) => v.blue + v.purple + v.pink > 0)
      .map(([k, v]) => {
        const total = v.blue + v.purple + v.pink
        return {
          label: Number(k) >= 7 ? '7+' : `${k} azuis`,
          streak: Number(k),
          blue:   Number((v.blue   / total * 100).toFixed(1)),
          purple: Number((v.purple / total * 100).toFixed(1)),
          pink:   Number((v.pink   / total * 100).toFixed(1)),
          total,
          bloqueado: Number(k) >= 4,
        }
      })
      .sort((a, b) => a.streak - b.streak)
  }, [candles])

  // ── Gráfico 6: Hora do dia × taxa de sucesso da estratégia ───────────────────
  const taxaPorHora = useMemo(() => {
    const horas: Record<number, { wins: number; total: number }> = {}
    for (let h = 0; h < 24; h++) horas[h] = { wins: 0, total: 0 }
    simulacao.filter(r => !r.bloqueado && r.mercadoBom).forEach(r => {
      const d = new Date(candles[r.index]?.created_at || '')
      if (!isValid(d)) return
      const h = getHours(d)
      horas[h].total++
      if (r.ganhou) horas[h].wins++
    })
    return Object.entries(horas)
      .filter(([, v]) => v.total >= 2)
      .map(([h, v]) => ({
        hora: `${h}h`,
        horaNum: Number(h),
        taxa: Number((v.wins / v.total * 100).toFixed(1)),
        total: v.total,
      }))
      .sort((a, b) => a.horaNum - b.horaNum)
  }, [simulacao, candles])

  // ── Estado atual do mercado ──────────────────────────────────────────────────
  const estadoAtual = useMemo(() => {
    if (candles.length < 10) return null
    const ultimas = candles.slice(-10)
    const media   = ultimas.reduce((s: number, c: any) => s + Number(c.multiplicador), 0) / 10
    const pctAzul = ultimas.filter((c: any) => c.cor === 'blue').length / 10
    const rosaRec = candles.slice(-15).some((c: any) => c.cor === 'pink')
    const streakAtual = (() => {
      let s = 0
      for (let i = candles.length - 1; i >= 0; i--) {
        if (candles[i].cor === 'blue') s++
        else break
      }
      return s
    })()
    const ultimaCor = candles[candles.length - 1]?.cor
    const mercadoBom = media > 2 && rosaRec && pctAzul < 0.6

    return { media, pctAzul, rosaRec, streakAtual, ultimaCor, mercadoBom }
  }, [candles])

  // ── Sinal da estratégia agora ─────────────────────────────────────────────────
  const sinalAtual = useMemo(() => {
    if (!estadoAtual) return null
    const ultimaCor   = estadoAtual.ultimaCor
    const streakAtual = estadoAtual.streakAtual
    const mercadoBom  = estadoAtual.mercadoBom

    if (ultimaCor === 'purple') {
      if (streakAtual >= 4) return { tipo: 'bloqueado', msg: 'Roxa detectada, mas bloqueado: 4+ azuis antes', color: C.amber }
      if (!mercadoBom)       return { tipo: 'cautela',  msg: 'Roxa detectada, mas mercado não está bom',       color: C.amber }
      return                        { tipo: 'entrar',   msg: 'ENTRAR na próxima — roxa + mercado bom!',        color: C.green }
    }
    if (ultimaCor === 'blue') {
      if (streakAtual >= 4)  return { tipo: 'bloqueado', msg: `Cuidado: ${streakAtual} azuis seguidas — aguardar`, color: C.amber }
      return                        { tipo: 'aguardar',  msg: 'Aguardando roxa disparar entrada',               color: C.axis  }
    }
    if (ultimaCor === 'pink') {
      return { tipo: 'aguardar', msg: 'Rosa saiu — observar próximas velas', color: C.purple }
    }
    return { tipo: 'aguardar', msg: 'Aguardando sinal...', color: C.axis }
  }, [estadoAtual])

  if (candles.length < 10) {
    return (
      <div className="flex items-center justify-center h-64 text-white/30 text-sm">
        Aguardando dados suficientes para análise...
      </div>
    )
  }

  const colW = 'w-full'

  return (
    <div className="p-4 pb-24 lg:pb-6 space-y-4">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-white">Análise de Estratégia</h1>
          <p className="text-xs text-white/35 mt-0.5">{candles.length} velas analisadas</p>
        </div>
        {ws?.connected && (
          <span className="flex items-center gap-1.5 text-xs text-emerald-400 font-medium">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-300 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
            </span>
            ao vivo
          </span>
        )}
      </div>

      {/* ── SINAL ATUAL ── */}
      {sinalAtual && (
        <div
          className="rounded-2xl border p-4 flex items-center gap-4"
          style={{
            borderColor: sinalAtual.color + '55',
            background: sinalAtual.color + '11',
          }}
        >
          {sinalAtual.tipo === 'entrar'    && <CheckCircle2  className="h-7 w-7 shrink-0" style={{ color: C.green  }} />}
          {sinalAtual.tipo === 'bloqueado' && <ShieldAlert   className="h-7 w-7 shrink-0" style={{ color: C.amber  }} />}
          {sinalAtual.tipo === 'cautela'   && <AlertTriangle className="h-7 w-7 shrink-0" style={{ color: C.amber  }} />}
          {sinalAtual.tipo === 'aguardar'  && <Activity      className="h-7 w-7 shrink-0" style={{ color: C.purple }} />}
          <div className="flex-1">
            <p className="text-xs text-white/40 uppercase tracking-wider mb-0.5">Sinal agora</p>
            <p className="text-sm font-semibold text-white">{sinalAtual.msg}</p>
          </div>
          {estadoAtual && (
            <div className="hidden sm:flex flex-col items-end gap-0.5 text-right text-xs text-white/40">
              <span>Média 10v: <strong className="text-white/70">{estadoAtual.media.toFixed(2)}x</strong></span>
              <span>Azuis 10v: <strong className="text-white/70">{(estadoAtual.pctAzul * 100).toFixed(0)}%</strong></span>
              <span>Streak azul: <strong className="text-white/70">{estadoAtual.streakAtual}</strong></span>
            </div>
          )}
        </div>
      )}

      {/* ── KPIs da estratégia ── */}
      <Card title="Performance da Estratégia" subtitle="Backtest em todo o histórico disponível" icon={Target}>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat label="Taxa sem filtro"    value={`${taxaSemFiltro}%`}   color="rgba(255,255,255,0.4)" />
          <Stat label="Taxa c/ bloqueio"   value={`${taxaGeral}%`}       color={C.purple} />
          <Stat label="Taxa mercado bom"   value={`${taxaMercadoBom}%`}  color={C.green}  />
          <Stat label="Entradas bloqueadas" value={totalBloqueadas}       color={C.amber}  />
        </div>
        <p className="text-[11px] text-white/25 text-center">
          O filtro de "mercado bom" melhora a taxa de {taxaGeral}% → {taxaMercadoBom}%
        </p>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* ── Após uma roxa, o que vem? ── */}
        <Card
          title="O que vem após uma Roxa?"
          subtitle={`Base: ${aposRoxa.reduce((s, r) => s + r.count, 0)} ocorrências`}
          icon={Zap}
        >
          <div className="space-y-3">
            {aposRoxa.map((r) => (
              <div key={r.label} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span style={{ color: C[r.cor as keyof typeof C] }} className="font-medium">{r.label}</span>
                  <span className="text-white/60">{r.pct}% ({r.count}x)</span>
                </div>
                <div className="h-2 rounded-full bg-white/5 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-700"
                    style={{ width: `${r.pct}%`, background: C[r.cor as keyof typeof C] }}
                  />
                </div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-white/30">
            Roxa + Roxa consecutiva acontece em {aposRoxa.find(r => r.cor === 'purple')?.pct ?? 0}% dos casos
          </p>
        </Card>

        {/* ── Taxa por streak azul ── */}
        <Card
          title="Taxa de Acerto × Streak Azul"
          subtitle="Quantas azuis antes da roxa → quanto você ganha"
          icon={Activity}
        >
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={taxaPorStreak} margin={{ left: -20, right: 4 }}>
                <CartesianGrid stroke={C.grid} vertical={false} />
                <XAxis
                  dataKey="label"
                  stroke={C.axis}
                  fontSize={10}
                  tickFormatter={(v, i) => taxaPorStreak[i]?.bloqueado ? `🚫${v}` : v}
                />
                <YAxis stroke={C.axis} fontSize={10} tickFormatter={v => `${v}%`} domain={[0, 100]} />
                <ReferenceLine y={50} stroke="rgba(255,255,255,0.15)" strokeDasharray="3 3" />
                <Tooltip
                  {...TT}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null
                    const d = payload[0].payload
                    return (
                      <div style={TT.contentStyle} className="p-2 space-y-1 text-xs">
                        <p className="text-white font-bold">{d.label} azuis antes</p>
                        <p style={{ color: C.green }}>Taxa: {d.taxa}%</p>
                        <p className="text-white/40">Amostras: {d.total}</p>
                        {d.bloqueado && <p style={{ color: C.amber }}>⚠️ Bloqueado pela regra</p>}
                      </div>
                    )
                  }}
                />
                <Bar dataKey="taxa" radius={[6, 6, 0, 0]} name="Taxa">
                  {taxaPorStreak.map((d, i) => (
                    <Cell
                      key={i}
                      fill={d.bloqueado ? C.amber : d.taxa >= 50 ? C.green : C.purple}
                      fillOpacity={d.bloqueado ? 0.4 : 0.85}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="text-[11px] text-white/30">
            Barras laranja = bloqueadas pela sua regra das 4 azuis
          </p>
        </Card>

        {/* ── Após N azuis, o que veio? ── */}
        <Card
          title="Após N Azuis Consecutivas → Próxima Cor"
          subtitle="Distribuição do que saiu após cada sequência de azuis"
          icon={ShieldAlert}
          span={undefined}
        >
          <div className="h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={aposNAzuis} margin={{ left: -20, right: 4 }}>
                <CartesianGrid stroke={C.grid} vertical={false} />
                <XAxis dataKey="label" stroke={C.axis} fontSize={10} />
                <YAxis stroke={C.axis} fontSize={10} tickFormatter={v => `${v}%`} domain={[0, 100]} />
                <ReferenceLine x="4 azuis" stroke={C.amber} strokeDasharray="4 2" label={{ value: 'bloqueio', fill: C.amber, fontSize: 9 }} />
                <Tooltip
                  {...TT}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null
                    const d = payload[0].payload
                    return (
                      <div style={TT.contentStyle} className="p-2 space-y-1 text-xs">
                        <p className="text-white font-bold">{d.label}</p>
                        <p style={{ color: C.blue }}>Azul: {d.blue}%</p>
                        <p style={{ color: C.purple }}>Roxa: {d.purple}%</p>
                        <p style={{ color: C.pink }}>Rosa: {d.pink}%</p>
                        <p className="text-white/40">Total: {d.total}</p>
                      </div>
                    )
                  }}
                />
                <Bar dataKey="blue"   stackId="a" fill={C.blue}   fillOpacity={0.8} name="Azul"  radius={[0,0,0,0]} />
                <Bar dataKey="purple" stackId="a" fill={C.purple} fillOpacity={0.8} name="Roxa" />
                <Bar dataKey="pink"   stackId="a" fill={C.pink}   fillOpacity={0.8} name="Rosa"  radius={[4,4,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="text-[11px] text-white/30">
            A linha laranja marca onde sua regra bloqueia entradas
          </p>
        </Card>

        {/* ── Média móvel / mercado bom ── */}
        <Card
          title="Média Móvel 10 Velas + % Azuis"
          subtitle="Identifique quando o mercado está 'pagando bem'"
          icon={TrendingUp}
        >
          <div className="h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={mediaMovel} margin={{ left: -20, right: 4 }}>
                <CartesianGrid stroke={C.grid} vertical={false} />
                <XAxis dataKey="i" hide />
                <YAxis yAxisId="ma" stroke={C.axis} fontSize={10} tickFormatter={v => `${v}x`} />
                <YAxis yAxisId="pct" orientation="right" stroke={C.axis} fontSize={10} tickFormatter={v => `${v}%`} domain={[0, 100]} />
                <ReferenceLine yAxisId="ma" y={2} stroke={C.purple} strokeDasharray="3 3" strokeOpacity={0.6} label={{ value: '2x', fill: C.purple, fontSize: 9 }} />
                <ReferenceLine yAxisId="pct" y={60} stroke={C.amber} strokeDasharray="3 3" strokeOpacity={0.6} label={{ value: '60%az', fill: C.amber, fontSize: 9 }} />
                <Tooltip
                  {...TT}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null
                    const d = payload[0]?.payload
                    const bom = d?.ma > 2 && d?.pctAzul < 60
                    return (
                      <div style={TT.contentStyle} className="p-2 space-y-1 text-xs">
                        <p style={{ color: C.blue }}>Média 10v: {d?.ma}x</p>
                        <p style={{ color: C.amber }}>% Azuis: {d?.pctAzul}%</p>
                        <p style={{ color: bom ? C.green : C.amber }}>
                          Mercado: {bom ? '✅ bom' : '⚠️ ruim'}
                        </p>
                      </div>
                    )
                  }}
                />
                <Line yAxisId="ma"  dataKey="ma"      stroke={C.blue}   strokeWidth={2} dot={false} name="Média 10v" />
                <Line yAxisId="pct" dataKey="pctAzul" stroke={C.amber}  strokeWidth={1.5} dot={false} strokeDasharray="4 2" name="% Azuis" />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="flex gap-4 text-[11px] text-white/40">
            <span style={{ color: C.blue }}>— Média 10v (meta: acima de 2x)</span>
            <span style={{ color: C.amber }}>-- % Azuis (meta: abaixo de 60%)</span>
          </div>
        </Card>

        {/* ── Timeline de entradas Win/Loss ── */}
        <Card
          title="Histórico de Entradas"
          subtitle="Últimas 60 entradas disparadas pela estratégia"
          icon={CheckCircle2}
          accent={`${simulacao.filter(r => !r.bloqueado && r.ganhou).length}W / ${simulacao.filter(r => !r.bloqueado && !r.ganhou).length}L`}
        >
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={entradaTimeline} margin={{ left: -20, right: 4 }}>
                <CartesianGrid stroke={C.grid} vertical={false} />
                <XAxis dataKey="i" hide />
                <YAxis stroke={C.axis} fontSize={10} tickFormatter={v => v === 1 ? 'Win' : v === -1 ? 'Loss' : ''} domain={[-1.5, 1.5]} ticks={[-1, 1]} />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.1)" />
                <Tooltip
                  {...TT}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null
                    const d = payload[0].payload
                    return (
                      <div style={TT.contentStyle} className="p-2 space-y-1 text-xs">
                        <p style={{ color: d.resultado === 1 ? C.green : '#ef4444' }}>
                          {d.resultado === 1 ? '✅ WIN' : '❌ LOSS'}
                        </p>
                        <p style={{ color: C[d.cor as keyof typeof C] }}>
                          Saiu: {d.entrada}x ({d.cor})
                        </p>
                        {d.mercadoBom && <p style={{ color: C.green }}>Mercado estava bom</p>}
                      </div>
                    )
                  }}
                />
                <Bar dataKey="resultado" radius={[4, 4, 0, 0]} name="Resultado">
                  {entradaTimeline.map((d, i) => (
                    <Cell
                      key={i}
                      fill={d.resultado === 1 ? C.green : '#ef4444'}
                      fillOpacity={d.mercadoBom ? 0.9 : 0.45}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="text-[11px] text-white/30">
            Barras opacas = entrada fora do filtro "mercado bom"
          </p>
        </Card>

        {/* ── Taxa por hora ── */}
        {taxaPorHora.length >= 2 && (
          <Card
            title="Melhores Horários para Entrar"
            subtitle="Taxa de acerto da estratégia por hora do dia (mercado bom)"
            icon={Target}
          >
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={taxaPorHora} margin={{ left: -20, right: 4 }}>
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis dataKey="hora" stroke={C.axis} fontSize={10} />
                  <YAxis stroke={C.axis} fontSize={10} tickFormatter={v => `${v}%`} domain={[0, 100]} />
                  <ReferenceLine y={50} stroke="rgba(255,255,255,0.15)" strokeDasharray="3 3" />
                  <Tooltip
                    {...TT}
                    formatter={(v: any, _, p) => [`${v}% (${p.payload.total} entradas)`, 'Taxa']}
                  />
                  <Bar dataKey="taxa" radius={[5, 5, 0, 0]} name="Taxa">
                    {taxaPorHora.map((d, i) => (
                      <Cell
                        key={i}
                        fill={d.taxa >= 60 ? C.green : d.taxa >= 40 ? C.purple : '#ef4444'}
                        fillOpacity={0.8}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="text-[11px] text-white/30">
              Verde = acima de 60% · Roxo = neutro · Vermelho = evitar
            </p>
          </Card>
        )}

      </div>
    </div>
  )
}