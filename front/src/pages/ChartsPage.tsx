import { useMemo, useState } from 'react'
import { useCandles } from '@/hooks/useCandles'
import { useWS } from '@/contexts/WebSocketContext'
import { calcularStats } from '@/utils/candleUtils'
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  CartesianGrid, ReferenceLine,
} from 'recharts'
import {
  TrendingUp, Activity, Zap, Target, ShieldAlert,
  CheckCircle2, Clock, Calendar,
  BarChart2,
} from 'lucide-react'
import { getHours, getMinutes, isValid } from 'date-fns'

// ── Paleta ────────────────────────────────────────────────────────────────────
const C = {
  blue:   'hsl(217,91%,60%)',
  purple: 'hsl(263,70%,58%)',
  pink:   'hsl(330,80%,60%)',
  green:  'hsl(142,71%,45%)',
  amber:  'hsl(38,92%,50%)',
  red:    'hsl(0,72%,55%)',
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

// ── Helpers estratégia ────────────────────────────────────────────────────────
function streakAzulAntes(candles: any[], i: number): number {
  let count = 0
  for (let j = i - 1; j >= 0; j--) {
    if (candles[j].cor === 'blue') count++
    else break
  }
  return count
}
function mediaAntes(candles: any[], i: number, n = 10): number {
  const slice = candles.slice(Math.max(0, i - n), i)
  if (!slice.length) return 0
  return slice.reduce((s: number, c: any) => s + Number(c.multiplicador), 0) / slice.length
}
function rosaRecenteAntes(candles: any[], i: number, n = 15): boolean {
  return candles.slice(Math.max(0, i - n), i).some((c: any) => c.cor === 'pink')
}
function pctAzulAntes(candles: any[], i: number, n = 10): number {
  const slice = candles.slice(Math.max(0, i - n), i)
  if (!slice.length) return 0
  return slice.filter((c: any) => c.cor === 'blue').length / slice.length
}
function simularEstrategia(candles: any[]) {
  const res: {
    index: number; entrada: number; cor: string; ganhou: boolean
    bloqueado: boolean; mercadoBom: boolean; streakAzul: number; mediaAnterior: number
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
    res.push({
      index: i + 1, entrada: Number(proxima.multiplicador), cor: proxima.cor,
      ganhou, bloqueado, mercadoBom, streakAzul: streak, mediaAnterior: Number(media.toFixed(2)),
    })
  }
  return res
}

// ── Card ──────────────────────────────────────────────────────────────────────
function Card({ title, subtitle, icon: Icon, children, accent, fullWidth }: {
  title: string; subtitle?: string; icon: any; children: React.ReactNode
  accent?: string; fullWidth?: boolean
}) {
  return (
    <div className={`rounded-2xl border border-white/8 bg-white/3 p-4 flex flex-col gap-3${fullWidth ? ' sm:col-span-2' : ''}`}>
      <div className="flex items-center gap-2.5">
        <div className="p-1.5 rounded-lg bg-white/5">
          <Icon className="h-4 w-4 text-white/50" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-white/90 leading-none truncate">{title}</h3>
          {subtitle && <p className="text-[11px] text-white/35 mt-0.5 truncate">{subtitle}</p>}
        </div>
        {accent && (
          <span className="ml-auto shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full bg-white/5 text-white/60">{accent}</span>
        )}
      </div>
      {children}
    </div>
  )
}

// ── HeatCell ──────────────────────────────────────────────────────────────────
function HeatCell({ value, max, label }: { value: number; max: number; label: string }) {
  const intensity = max > 0 ? value / max : 0
  const bg = intensity > 0.8 ? C.pink : intensity > 0.55 ? C.purple
    : intensity > 0.3 ? 'hsl(263,50%,38%)' : intensity > 0.1
    ? 'rgba(127,119,221,0.2)' : 'rgba(255,255,255,0.03)'
  return (
    <div title={label} className="rounded flex items-center justify-center cursor-default"
      style={{ background: bg, aspectRatio: '1', minWidth: 0, fontSize: 9,
        color: intensity > 0.3 ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.25)' }}>
      {value > 0 ? value : ''}
    </div>
  )
}

// ── PerformanceCard ───────────────────────────────────────────────────────────
function PerformanceCard({ taxaGeral, taxaMercadoBom, simulacao, totalBloqueadas }: {
  taxaGeral: string; taxaMercadoBom: string
  simulacao: { ganhou: boolean; bloqueado: boolean; mercadoBom: boolean }[]
  totalBloqueadas: number
}) {
  const totalRoxas     = simulacao.length
  const semBloqueio    = simulacao.filter(r => !r.bloqueado)
  const comFiltro      = simulacao.filter(r => !r.bloqueado && r.mercadoBom)
  const winsSemBloquio = semBloqueio.filter(r => r.ganhou).length
  const winsComFiltro  = comFiltro.filter(r => r.ganhou).length
  const lossSemBloquio = semBloqueio.length - winsSemBloquio

  const pBar = (n: number) => totalRoxas > 0 ? Math.round(n / totalRoxas * 100) : 0

  const funil = [
    { label: 'Todas as roxas detectadas', n: totalRoxas,         color: 'rgba(127,119,221,0.25)', taxa: null,           desc: null },
    { label: 'Sem bloqueio de azuis',     n: semBloqueio.length, color: 'rgba(127,119,221,0.5)',  taxa: taxaGeral,      desc: `${winsSemBloquio}W · ${lossSemBloquio}L` },
    { label: 'Mercado bom (filtro ativo)',n: comFiltro.length,   color: 'rgba(34,197,94,0.45)',   taxa: taxaMercadoBom, desc: `${winsComFiltro}W · ${comFiltro.length - winsComFiltro}L` },
  ]

  return (
    <div className="rounded-2xl border border-white/8 bg-white/3 p-4 flex flex-col gap-4">
      <div className="flex items-center gap-2.5">
        <div className="p-1.5 rounded-lg bg-white/5"><BarChart2 className="h-4 w-4 text-white/50" /></div>
        <div>
          <h3 className="text-sm font-semibold text-white/90 leading-none">Performance da estratégia</h3>
          <p className="text-[11px] text-white/35 mt-0.5">{totalRoxas} disparos de roxa analisados</p>
        </div>
      </div>

      <div className="space-y-2">
        {funil.map((f, i) => (
          <div key={i} className="flex items-center gap-2.5">
            <div className="w-[120px] shrink-0 text-right">
              <p className="text-[11px] text-white/50 leading-tight">{f.label}</p>
            </div>
            <div className="flex-1 relative h-8 rounded-lg bg-white/5 overflow-hidden">
              <div className="absolute inset-y-0 left-0 rounded-lg transition-all duration-700"
                style={{ width: `${pBar(f.n)}%`, background: f.color }} />
              <div className="absolute inset-0 flex items-center px-2.5 gap-1.5">
                <span className="text-[11px] text-white/80 font-medium">{f.n}</span>
                {f.desc && <span className="text-[10px] text-white/40">· {f.desc}</span>}
              </div>
            </div>
            <div className="w-10 shrink-0 text-right">
              {f.taxa !== null
                ? <span className="text-[12px] font-bold" style={{ color: i === 2 ? C.green : C.purple }}>{f.taxa}%</span>
                : <span className="text-[11px] text-white/30">—</span>
              }
            </div>
          </div>
        ))}
      </div>

      <div>
        <div className="flex justify-between text-[11px] mb-1.5 text-white/40">
          <span>Win rate sem filtro: <strong style={{ color: C.purple }}>{taxaGeral}%</strong></span>
          <span>Com filtro: <strong style={{ color: C.green }}>{taxaMercadoBom}%</strong></span>
        </div>
        <div className="h-2 rounded-full overflow-hidden flex bg-white/5">
          <div style={{ width: `${taxaMercadoBom}%`, background: C.green }} className="rounded-l-full transition-all duration-700" />
          <div style={{ width: `${100 - Number(taxaMercadoBom)}%`, background: C.red }} className="rounded-r-full opacity-40" />
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1 border-t border-white/6">
        <ShieldAlert className="h-3.5 w-3.5 shrink-0" style={{ color: C.amber }} />
        <p className="text-[11px] text-white/40">
          <strong style={{ color: C.amber }}>{totalBloqueadas}</strong> entradas bloqueadas pela regra das 4 azuis consecutivas — o sistema ignorou esses sinais
        </p>
      </div>
    </div>
  )
}

// ── HeatmapCard (novo) ────────────────────────────────────────────────────────
const BLOCOS5 = ['00','05','10','15','20','25','30','35','40','45','50','55']

function HeatmapCard({ heatmapData, freqPorHora }: {
  heatmapData: { matrix: number[][]; totals: number[][]; maxVal: number }
  freqPorHora: { horaNum: number; hora: string; especiais: number; total: number; taxa: number }[]
}) {
  const [mode, setMode] = useState<'count' | 'taxa'>('count')

  const horaEsp = useMemo(() =>
    heatmapData.matrix.map(row => row.reduce((s, v) => s + v, 0)), [heatmapData])

  const maxHoraEsp = Math.max(...horaEsp, 1)

  const top3 = useMemo(() =>
    freqPorHora
      .filter(h => h.total > 0)
      .sort((a, b) => b.especiais - a.especiais)
      .slice(0, 3),
  [freqPorHora])

  function getCellValue(h: number, b: number) {
    if (mode === 'count') return heatmapData.matrix[h][b]
    const tot = heatmapData.totals[h][b]
    return tot > 0 ? Math.round(heatmapData.matrix[h][b] / tot * 100) : 0
  }

  function getCellMax() {
    if (mode === 'count') return heatmapData.maxVal
    let m = 0
    for (let h = 0; h < 24; h++)
      for (let b = 0; b < 12; b++) {
        const tot = heatmapData.totals[h][b]
        if (tot > 0) m = Math.max(m, Math.round(heatmapData.matrix[h][b] / tot * 100))
      }
    return m || 1
  }

  function getCellBg(norm: number) {
    if (norm <= 0) return 'rgba(255,255,255,0.03)'
    if (norm > 0.8) return C.pink
    if (norm > 0.55) return C.purple
    if (norm > 0.3) return 'hsl(263,50%,38%)'
    return 'rgba(127,119,221,0.2)'
  }

  function getCellTextColor(norm: number) {
    return norm > 0.3 ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.2)'
  }

  const cellMax = getCellMax()

  return (
    <div className="rounded-2xl border border-white/8 bg-white/3 p-4 flex flex-col gap-3 sm:col-span-2">
      {/* Header */}
      <div className="flex items-center gap-2.5">
        <div className="p-1.5 rounded-lg bg-white/5">
          <Calendar className="h-4 w-4 text-white/50" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-white/90 leading-none">Heatmap: hora × bloco de 5 min</h3>
          <p className="text-[11px] text-white/35 mt-0.5">Concentração de roxas e rosas no dia</p>
        </div>
        {/* Toggle */}
        <div className="flex rounded-lg overflow-hidden border border-white/10 shrink-0">
          {(['count', 'taxa'] as const).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className="px-2.5 py-1 text-[11px] font-medium transition-colors"
              style={{
                background: mode === m ? 'rgba(127,119,221,0.3)' : 'transparent',
                color: mode === m ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.4)',
              }}
            >
              {m === 'count' ? 'Qtd' : 'Taxa %'}
            </button>
          ))}
        </div>
      </div>

      {/* Top 3 horários */}
      <div className="grid grid-cols-3 gap-2">
        {top3.map((h, i) => (
          <div key={h.horaNum} className="rounded-xl bg-white/5 p-2.5 flex flex-col gap-0.5">
            <span className="text-[10px] text-white/35">#{i + 1} mais ativo</span>
            <span className="text-base font-bold" style={{ color: i === 0 ? C.pink : i === 1 ? C.purple : C.blue }}>
              {h.hora}
            </span>
            <span className="text-[11px] text-white/50">{h.especiais} esp · {h.taxa}%</span>
          </div>
        ))}
      </div>

      {/* Barra de resumo por hora */}
      <div>
        <p className="text-[10px] text-white/30 mb-1">Resumo por hora</p>
        <div className="flex gap-0.5">
          {heatmapData.matrix.map((row, h) => {
            const esp = row.reduce((s, v) => s + v, 0)
            const norm = maxHoraEsp > 0 ? esp / maxHoraEsp : 0
            const bg = getCellBg(norm)
            return (
              <div
                key={h}
                title={`${String(h).padStart(2,'0')}h: ${esp} especiais`}
                className="flex-1 rounded-sm cursor-default"
                style={{ height: 20, background: bg, minWidth: 0 }}
              />
            )
          })}
        </div>
        <div className="flex justify-between text-[9px] text-white/20 mt-0.5">
          <span>00h</span><span>06h</span><span>12h</span><span>18h</span><span>23h</span>
        </div>
      </div>

      {/* Grade hora × bloco */}
      <div className="overflow-x-auto -mx-1">
        <div style={{ minWidth: 340 }}>
          {/* Header blocos */}
          <div className="grid gap-0.5 mb-0.5" style={{ gridTemplateColumns: '26px repeat(12, 1fr)' }}>
            <div />
            {BLOCOS5.map(b => (
              <div key={b} className="text-center text-[9px] text-white/30">{b}</div>
            ))}
          </div>
          {/* Linhas */}
          {heatmapData.matrix.map((row, h) => {
            const norm = maxHoraEsp > 0 ? horaEsp[h] / maxHoraEsp : 0
            return (
              <div key={h} className="grid gap-0.5 mb-0.5" style={{ gridTemplateColumns: '26px repeat(12, 1fr)' }}>
                {/* Label hora — colorida pela intensidade */}
                <div
                  className="text-[10px] flex items-center justify-end pr-1 font-medium"
                  style={{ color: norm > 0.5 ? C.purple : 'rgba(255,255,255,0.25)' }}
                >
                  {String(h).padStart(2, '0')}
                </div>
                {row.map((_, b) => {
                  const val = getCellValue(h, b)
                  const cellNorm = cellMax > 0 ? val / cellMax : 0
                  const bg = getCellBg(cellNorm)
                  const textColor = getCellTextColor(cellNorm)
                  const label = `${String(h).padStart(2,'0')}:${BLOCOS5[b]} — ${heatmapData.matrix[h][b]} esp de ${heatmapData.totals[h][b]}`
                  return (
                    <div
                      key={b}
                      title={label}
                      className="rounded cursor-default flex items-center justify-center"
                      style={{
                        background: bg,
                        height: 20,
                        fontSize: 9,
                        color: textColor,
                        minWidth: 0,
                      }}
                    >
                      {val > 0 ? (mode === 'taxa' ? `${val}%` : val) : ''}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>

      {/* Legenda */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] text-white/30">Intensidade:</span>
        {[
          { color: 'rgba(255,255,255,0.03)', label: '0' },
          { color: 'rgba(127,119,221,0.2)',  label: 'baixo' },
          { color: 'hsl(263,50%,38%)',       label: 'médio' },
          { color: C.purple,                 label: 'alto' },
          { color: C.pink,                   label: 'muito alto' },
        ].map(leg => (
          <div key={leg.label} className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-sm" style={{ background: leg.color, border: '0.5px solid rgba(255,255,255,0.1)' }} />
            <span className="text-[10px] text-white/30">{leg.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

const LIMIT_OPTIONS = [50, 100, 200, 1000] as const
type LimitOption = typeof LIMIT_OPTIONS[number]

// ── Página Principal ──────────────────────────────────────────────────────────
export default function ChartsPage() {
  const [limit, setLimit] = useState<LimitOption>(100)
  const ws = useWS()
  const { candles: dbCandles } = useCandles({ limit: 1000 })

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
      .slice(-limit)
  }, [dbCandles, ws?.candles, limit])

  const simulacao = useMemo(() => simularEstrategia(candles), [candles])

  const totalEntradas   = simulacao.filter(r => !r.bloqueado).length
  const entradasBoas    = simulacao.filter(r => !r.bloqueado && r.mercadoBom)
  const totalBloqueadas = simulacao.filter(r => r.bloqueado).length

  const taxaGeral = totalEntradas > 0
    ? (simulacao.filter(r => !r.bloqueado && r.ganhou).length / totalEntradas * 100).toFixed(1) : '—'
  const taxaMercadoBom = entradasBoas.length > 0
    ? (entradasBoas.filter(r => r.ganhou).length / entradasBoas.length * 100).toFixed(1) : '—'

  // Gráficos
  const entradaTimeline = useMemo(() =>
    simulacao.filter(r => !r.bloqueado).slice(-60).map((r, i) => ({
      i: i + 1, resultado: r.ganhou ? 1 : -1, cor: r.cor, entrada: r.entrada, mercadoBom: r.mercadoBom,
    })), [simulacao])

  const taxaPorStreak = useMemo(() => {
    const grupos: Record<number, { wins: number; total: number }> = {}
    simulacao.forEach(r => {
      const k = Math.min(r.streakAzul, 6)
      if (!grupos[k]) grupos[k] = { wins: 0, total: 0 }
      grupos[k].total++
      if (r.ganhou) grupos[k].wins++
    })
    return Object.entries(grupos).map(([k, v]) => ({
      streak: Number(k), label: Number(k) >= 6 ? '6+' : `${k}`,
      taxa: v.total > 0 ? Number((v.wins / v.total * 100).toFixed(1)) : 0,
      total: v.total, bloqueado: Number(k) >= 4,
    })).sort((a, b) => a.streak - b.streak)
  }, [simulacao])

  const aposRoxa = useMemo(() => {
    let blue = 0, purple = 0, pink = 0, total = 0
    for (let i = 0; i < candles.length - 1; i++) {
      if (candles[i].cor !== 'purple') continue
      total++
      const prox = candles[i + 1].cor
      if (prox === 'blue') blue++
      if (prox === 'purple') purple++
      if (prox === 'pink') pink++
    }
    return [
      { label: 'Azul',  count: blue,   pct: total ? +(blue   / total * 100).toFixed(1) : 0, cor: 'blue'   },
      { label: 'Roxa',  count: purple, pct: total ? +(purple / total * 100).toFixed(1) : 0, cor: 'purple' },
      { label: 'Rosa',  count: pink,   pct: total ? +(pink   / total * 100).toFixed(1) : 0, cor: 'pink'   },
    ]
  }, [candles])

  const mediaMovel = useMemo(() =>
    candles.slice(-80).map((c, i, arr) => {
      const slice = arr.slice(Math.max(0, i - 9), i + 1)
      const ma = slice.reduce((s: number, x: any) => s + Number(x.multiplicador), 0) / slice.length
      const pctAzul = slice.filter((x: any) => x.cor === 'blue').length / slice.length
      return { i: i + 1, ma: Number(ma.toFixed(2)), pctAzul: Number((pctAzul * 100).toFixed(1)) }
    }), [candles])

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
          label: Number(k) >= 7 ? '7+' : `${k}az`, streak: Number(k),
          blue: Number((v.blue / total * 100).toFixed(1)),
          purple: Number((v.purple / total * 100).toFixed(1)),
          pink: Number((v.pink / total * 100).toFixed(1)),
          total, bloqueado: Number(k) >= 4,
        }
      }).sort((a, b) => a.streak - b.streak)
  }, [candles])

  const taxaPorHoraEstrategia = useMemo(() => {
    const horas: Record<number, { wins: number; total: number }> = {}
    for (let h = 0; h < 24; h++) horas[h] = { wins: 0, total: 0 }
    simulacao.filter(r => !r.bloqueado && r.mercadoBom).forEach(r => {
      const d = new Date(candles[r.index]?.created_at || '')
      if (!isValid(d)) return
      const h = getHours(d)
      horas[h].total++
      if (r.ganhou) horas[h].wins++
    })
    return Object.entries(horas).filter(([, v]) => v.total >= 2)
      .map(([h, v]) => ({
        hora: `${h}h`, horaNum: Number(h),
        taxa: Number((v.wins / v.total * 100).toFixed(1)), total: v.total,
      })).sort((a, b) => a.horaNum - b.horaNum)
  }, [simulacao, candles])

  // Temporal
  const freqPorHora = useMemo(() => {
    const horas: Record<number, { purple: number; pink: number; total: number }> = {}
    for (let h = 0; h < 24; h++) horas[h] = { purple: 0, pink: 0, total: 0 }
    candles.forEach(c => {
      const d = new Date(c.created_at)
      if (!isValid(d)) return
      const h = getHours(d)
      horas[h].total++
      if (c.cor === 'purple') horas[h].purple++
      if (c.cor === 'pink')   horas[h].pink++
    })
    return Array.from({ length: 24 }, (_, h) => {
      const v = horas[h]
      const especiais = v.purple + v.pink
      return {
        hora: `${String(h).padStart(2, '0')}h`, horaNum: h,
        purple: v.purple, pink: v.pink, especiais, total: v.total,
        taxa: v.total > 0 ? Number((especiais / v.total * 100).toFixed(1)) : 0,
        intervaloMin: especiais > 0 ? Number(((v.total / especiais) * 3 / 60).toFixed(1)) : null,
      }
    })
  }, [candles])

  const freqPorMinuto = useMemo(() => {
    const mins: Record<number, { purple: number; pink: number; total: number }> = {}
    for (let m = 0; m < 60; m++) mins[m] = { purple: 0, pink: 0, total: 0 }
    candles.forEach(c => {
      const d = new Date(c.created_at)
      if (!isValid(d)) return
      const m = getMinutes(d)
      mins[m].total++
      if (c.cor === 'purple') mins[m].purple++
      if (c.cor === 'pink')   mins[m].pink++
    })
    return Array.from({ length: 60 }, (_, m) => {
      const v = mins[m]
      const especiais = v.purple + v.pink
      return {
        min: m, label: String(m).padStart(2, '0'),
        purple: v.purple, pink: v.pink, especiais, total: v.total,
        taxa: v.total > 0 ? Number((especiais / v.total * 100).toFixed(1)) : 0,
      }
    })
  }, [candles])

  const heatmapData = useMemo(() => {
    const matrix: number[][] = Array.from({ length: 24 }, () => Array(12).fill(0))
    const totals:  number[][] = Array.from({ length: 24 }, () => Array(12).fill(0))
    candles.forEach(c => {
      const d = new Date(c.created_at)
      if (!isValid(d)) return
      const h = getHours(d)
      const bloco = Math.floor(getMinutes(d) / 5)
      totals[h][bloco]++
      if (c.cor === 'purple' || c.cor === 'pink') matrix[h][bloco]++
    })
    let maxVal = 0
    for (let h = 0; h < 24; h++)
      for (let b = 0; b < 12; b++)
        if (matrix[h][b] > maxVal) maxVal = matrix[h][b]
    return { matrix, totals, maxVal }
  }, [candles])

  const topMinutos = useMemo(() =>
    [...freqPorMinuto].sort((a, b) => b.taxa - a.taxa).slice(0, 10), [freqPorMinuto])

  const horasOrdenadas = useMemo(() =>
    [...freqPorHora].filter(h => h.total > 5).sort((a, b) => b.taxa - a.taxa), [freqPorHora])
  const top3Horas = horasOrdenadas.slice(0, 3)
  const bot3Horas = horasOrdenadas.slice(-3).reverse()

  if (candles.length < 10) {
    return (
      <div className="flex items-center justify-center h-64 text-white/30 text-sm">
        Aguardando dados suficientes para análise...
      </div>
    )
  }

  return (
    <div className="p-3 pb-24 lg:pb-6 space-y-3">

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-base font-bold text-white">Análise de Estratégia</h1>
          <p className="text-[11px] text-white/35 mt-0.5">{candles.length} velas · ao vivo</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Toggle de quantidade */}
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
      </div>

      {/* Performance */}
      <PerformanceCard
        taxaGeral={taxaGeral}
        taxaMercadoBom={taxaMercadoBom}
        simulacao={simulacao}
        totalBloqueadas={totalBloqueadas}
      />

      {/* Grid principal */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">

        <Card title="Após uma roxa, o que vem?" subtitle={`${aposRoxa.reduce((s, r) => s + r.count, 0)} ocorrências`} icon={Zap}>
          <div className="space-y-2.5">
            {aposRoxa.map(r => (
              <div key={r.label} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span style={{ color: C[r.cor as keyof typeof C] }} className="font-medium">{r.label}</span>
                  <span className="text-white/60">{r.pct}% ({r.count}x)</span>
                </div>
                <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${r.pct}%`, background: C[r.cor as keyof typeof C] }} />
                </div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-white/30">Roxa + Roxa consecutiva: {aposRoxa.find(r => r.cor === 'purple')?.pct ?? 0}%</p>
        </Card>

        <Card title="Acerto × streak azul" subtitle="Azuis antes da roxa vs taxa de ganho" icon={Activity}>
          <div className="h-[180px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={taxaPorStreak} margin={{ left: -22, right: 4, top: 4 }}>
                <CartesianGrid stroke={C.grid} vertical={false} />
                <XAxis dataKey="label" stroke={C.axis} fontSize={10}
                  tickFormatter={(v, i) => taxaPorStreak[i]?.bloqueado ? `🚫${v}` : v} />
                <YAxis stroke={C.axis} fontSize={10} tickFormatter={v => `${v}%`} domain={[0, 100]} />
                <ReferenceLine y={50} stroke="rgba(255,255,255,0.15)" strokeDasharray="3 3" />
                <Tooltip {...TT} content={({ active, payload }) => {
                  if (!active || !payload?.length) return null
                  const d = payload[0].payload
                  return (
                    <div style={TT.contentStyle} className="p-2 space-y-1 text-xs">
                      <p className="text-white font-bold">{d.label} azuis antes</p>
                      <p style={{ color: C.green }}>Taxa: {d.taxa}%</p>
                      <p className="text-white/40">Amostras: {d.total}</p>
                      {d.bloqueado && <p style={{ color: C.amber }}>⚠️ Bloqueado</p>}
                    </div>
                  )
                }} />
                <Bar dataKey="taxa" radius={[5, 5, 0, 0]}>
                  {taxaPorStreak.map((d, i) => (
                    <Cell key={i} fill={d.bloqueado ? C.amber : d.taxa >= 50 ? C.green : C.purple}
                      fillOpacity={d.bloqueado ? 0.4 : 0.85} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="text-[11px] text-white/30">Laranja = bloqueado pela regra das 4 azuis</p>
        </Card>

        <Card title="Após N azuis → próxima cor" subtitle="Distribuição da cor seguinte" icon={ShieldAlert}>
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={aposNAzuis} margin={{ left: -22, right: 4, top: 4 }}>
                <CartesianGrid stroke={C.grid} vertical={false} />
                <XAxis dataKey="label" stroke={C.axis} fontSize={10} />
                <YAxis stroke={C.axis} fontSize={10} tickFormatter={v => `${v}%`} domain={[0, 100]} />
                <ReferenceLine x="4az" stroke={C.amber} strokeDasharray="4 2"
                  label={{ value: 'bloqueio', fill: C.amber, fontSize: 9 }} />
                <Tooltip {...TT} content={({ active, payload }) => {
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
                }} />
                <Bar dataKey="blue"   stackId="a" fill={C.blue}   fillOpacity={0.8} radius={[0,0,0,0]} />
                <Bar dataKey="purple" stackId="a" fill={C.purple} fillOpacity={0.8} />
                <Bar dataKey="pink"   stackId="a" fill={C.pink}   fillOpacity={0.8} radius={[4,4,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="text-[11px] text-white/30">Linha laranja = onde a regra bloqueia</p>
        </Card>

        <Card title="Média móvel 10 velas + % azuis" subtitle="Identifica quando o mercado paga bem" icon={TrendingUp}>
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={mediaMovel} margin={{ left: -22, right: 4, top: 4 }}>
                <CartesianGrid stroke={C.grid} vertical={false} />
                <XAxis dataKey="i" hide />
                <YAxis yAxisId="ma"  stroke={C.axis} fontSize={10} tickFormatter={v => `${v}x`} />
                <YAxis yAxisId="pct" orientation="right" stroke={C.axis} fontSize={10}
                  tickFormatter={v => `${v}%`} domain={[0, 100]} />
                <ReferenceLine yAxisId="ma"  y={2}  stroke={C.purple} strokeDasharray="3 3" strokeOpacity={0.6}
                  label={{ value: '2x', fill: C.purple, fontSize: 9 }} />
                <ReferenceLine yAxisId="pct" y={60} stroke={C.amber}  strokeDasharray="3 3" strokeOpacity={0.6}
                  label={{ value: '60%', fill: C.amber, fontSize: 9 }} />
                <Tooltip {...TT} content={({ active, payload }) => {
                  if (!active || !payload?.length) return null
                  const d = payload[0]?.payload
                  const bom = d?.ma > 2 && d?.pctAzul < 60
                  return (
                    <div style={TT.contentStyle} className="p-2 space-y-1 text-xs">
                      <p style={{ color: C.blue }}>Média 10v: {d?.ma}x</p>
                      <p style={{ color: C.amber }}>% Azuis: {d?.pctAzul}%</p>
                      <p style={{ color: bom ? C.green : C.amber }}>Mercado: {bom ? '✅ bom' : '⚠️ ruim'}</p>
                    </div>
                  )
                }} />
                <Line yAxisId="ma"  dataKey="ma"      stroke={C.blue}  strokeWidth={2}   dot={false} />
                <Line yAxisId="pct" dataKey="pctAzul" stroke={C.amber} strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="flex gap-3 text-[11px] text-white/40 flex-wrap">
            <span style={{ color: C.blue }}>— Média 10v (meta: &gt;2x)</span>
            <span style={{ color: C.amber }}>-- % Azuis (meta: &lt;60%)</span>
          </div>
        </Card>

        <Card
          title="Histórico de entradas"
          subtitle="Últimas 60 entradas da estratégia"
          icon={CheckCircle2}
          accent={`${simulacao.filter(r => !r.bloqueado && r.ganhou).length}W / ${simulacao.filter(r => !r.bloqueado && !r.ganhou).length}L`}
        >
          <div className="h-[180px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={entradaTimeline} margin={{ left: -22, right: 4, top: 4 }}>
                <CartesianGrid stroke={C.grid} vertical={false} />
                <XAxis dataKey="i" hide />
                <YAxis stroke={C.axis} fontSize={10}
                  tickFormatter={v => v === 1 ? 'Win' : v === -1 ? 'Loss' : ''}
                  domain={[-1.5, 1.5]} ticks={[-1, 1]} />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.1)" />
                <Tooltip {...TT} content={({ active, payload }) => {
                  if (!active || !payload?.length) return null
                  const d = payload[0].payload
                  return (
                    <div style={TT.contentStyle} className="p-2 space-y-1 text-xs">
                      <p style={{ color: d.resultado === 1 ? C.green : C.red }}>
                        {d.resultado === 1 ? '✅ WIN' : '❌ LOSS'}
                      </p>
                      <p style={{ color: C[d.cor as keyof typeof C] }}>Saiu: {d.entrada}x ({d.cor})</p>
                      {d.mercadoBom && <p style={{ color: C.green }}>Mercado estava bom</p>}
                    </div>
                  )
                }} />
                <Bar dataKey="resultado" radius={[4, 4, 0, 0]}>
                  {entradaTimeline.map((d, i) => (
                    <Cell key={i} fill={d.resultado === 1 ? C.green : C.red}
                      fillOpacity={d.mercadoBom ? 0.9 : 0.45} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="text-[11px] text-white/30">Barras opacas = fora do filtro "mercado bom"</p>
        </Card>

        {taxaPorHoraEstrategia.length >= 2 && (
          <Card title="Melhores horários p/ entrar" subtitle="Taxa acerto por hora (mercado bom)" icon={Target}>
            <div className="h-[180px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={taxaPorHoraEstrategia} margin={{ left: -22, right: 4, top: 4 }}>
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis dataKey="hora" stroke={C.axis} fontSize={10} />
                  <YAxis stroke={C.axis} fontSize={10} tickFormatter={v => `${v}%`} domain={[0, 100]} />
                  <ReferenceLine y={50} stroke="rgba(255,255,255,0.15)" strokeDasharray="3 3" />
                  <Tooltip {...TT} formatter={(v: any, _, p) => [`${v}% (${p.payload.total} ent.)`, 'Taxa']} />
                  <Bar dataKey="taxa" radius={[5, 5, 0, 0]}>
                    {taxaPorHoraEstrategia.map((d, i) => (
                      <Cell key={i} fill={d.taxa >= 60 ? C.green : d.taxa >= 40 ? C.purple : C.red} fillOpacity={0.8} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="text-[11px] text-white/30">Verde ≥60% · Roxo neutro · Vermelho evitar</p>
          </Card>
        )}

      </div>

      {/* Análise Temporal */}
      <div className="flex items-center gap-2 pt-2">
        <Clock className="h-4 w-4 text-white/40" />
        <h2 className="text-sm font-semibold text-white/70 uppercase tracking-wider">Análise temporal</h2>
        <div className="flex-1 h-px bg-white/8" />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {top3Horas.map(h => (
          <div key={h.horaNum} className="rounded-xl bg-white/5 p-3 flex flex-col gap-0.5">
            <span className="text-[10px] text-white/35 uppercase tracking-wider">Melhor horário</span>
            <span className="text-base font-bold" style={{ color: C.green }}>{h.hora}</span>
            <span className="text-[11px] text-white/50">{h.taxa}% · {h.especiais} velas</span>
          </div>
        ))}
        {bot3Horas.map(h => (
          <div key={h.horaNum} className="rounded-xl bg-white/5 p-3 flex flex-col gap-0.5">
            <span className="text-[10px] text-white/35 uppercase tracking-wider">Horário fraco</span>
            <span className="text-base font-bold" style={{ color: C.red }}>{h.hora}</span>
            <span className="text-[11px] text-white/50">{h.taxa}% · {h.especiais} velas</span>
          </div>
        ))}
      </div>

      {/* ── Heatmap novo ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <HeatmapCard heatmapData={heatmapData} freqPorHora={freqPorHora} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">

        <Card title="Frequência por hora do dia" subtitle="Quantidade de roxas e rosas em cada hora" icon={Clock}>
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={freqPorHora} margin={{ left: -22, right: 4, top: 4 }}>
                <CartesianGrid stroke={C.grid} vertical={false} />
                <XAxis dataKey="hora" stroke={C.axis} fontSize={9} interval={2} tickFormatter={v => v.replace('h','')} />
                <YAxis stroke={C.axis} fontSize={10} />
                <Tooltip {...TT} content={({ active, payload }) => {
                  if (!active || !payload?.length) return null
                  const d = payload[0].payload
                  return (
                    <div style={TT.contentStyle} className="p-2 space-y-1 text-xs">
                      <p className="text-white font-bold">{d.hora}</p>
                      <p style={{ color: C.purple }}>Roxas: {d.purple}</p>
                      <p style={{ color: C.pink }}>Rosas: {d.pink}</p>
                      <p style={{ color: C.green }}>Taxa: {d.taxa}%</p>
                      <p className="text-white/40">Intervalo: {d.intervaloMin ? `${d.intervaloMin} min` : '—'}</p>
                    </div>
                  )
                }} />
                <Bar dataKey="purple" stackId="a" fill={C.purple} fillOpacity={0.85} radius={[0,0,0,0]} />
                <Bar dataKey="pink"   stackId="a" fill={C.pink}   fillOpacity={0.85} radius={[4,4,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="flex gap-3 text-[11px] flex-wrap">
            <span style={{ color: C.purple }}>■ Roxa</span>
            <span style={{ color: C.pink }}>■ Rosa</span>
          </div>
        </Card>

        <Card title="Intervalo médio entre especiais" subtitle="A cada quantos minutos aparece uma roxa/rosa" icon={Clock}>
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={freqPorHora.filter(h => h.intervaloMin !== null)} margin={{ left: -22, right: 4, top: 4 }}>
                <CartesianGrid stroke={C.grid} vertical={false} />
                <XAxis dataKey="hora" stroke={C.axis} fontSize={9} interval={2} tickFormatter={v => v.replace('h','')} />
                <YAxis stroke={C.axis} fontSize={10} tickFormatter={v => `${v}m`} />
                <Tooltip {...TT} formatter={(v: any) => [`${v} min`, 'Intervalo médio']} />
                <Bar dataKey="intervaloMin" radius={[5, 5, 0, 0]}>
                  {freqPorHora.filter(h => h.intervaloMin !== null).map((d, i) => (
                    <Cell key={i}
                      fill={(d.intervaloMin ?? 99) <= 5 ? C.green : (d.intervaloMin ?? 99) <= 10 ? C.purple : C.amber}
                      fillOpacity={0.8} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="text-[11px] text-white/30">Verde ≤5 min · Roxo ≤10 min · Laranja &gt;10 min</p>
        </Card>

        <Card title="Distribuição por minuto (0–59)" subtitle="Em qual minuto da hora mais aparecem especiais" icon={Clock}>
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={freqPorMinuto} margin={{ left: -22, right: 4, top: 4 }} barCategoryGap="5%">
                <CartesianGrid stroke={C.grid} vertical={false} />
                <XAxis dataKey="label" stroke={C.axis} fontSize={9} interval={9} />
                <YAxis stroke={C.axis} fontSize={10} />
                <Tooltip {...TT} content={({ active, payload }) => {
                  if (!active || !payload?.length) return null
                  const d = payload[0].payload
                  return (
                    <div style={TT.contentStyle} className="p-2 space-y-1 text-xs">
                      <p className="text-white font-bold">Minuto :{d.label}</p>
                      <p style={{ color: C.purple }}>Roxas: {d.purple}</p>
                      <p style={{ color: C.pink }}>Rosas: {d.pink}</p>
                      <p style={{ color: C.green }}>Taxa: {d.taxa}%</p>
                    </div>
                  )
                }} />
                <Bar dataKey="purple" stackId="a" fill={C.purple} fillOpacity={0.85} />
                <Bar dataKey="pink"   stackId="a" fill={C.pink}   fillOpacity={0.85} radius={[3,3,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="text-[11px] text-white/30">Cada barra = 1 minuto dentro da hora</p>
        </Card>

        <Card title="Top 10 minutos do ciclo" subtitle="Minutos com maior taxa histórica de especiais" icon={Target}>
          <div className="space-y-2">
            {topMinutos.map((m, i) => (
              <div key={m.min} className="flex items-center gap-2">
                <span className="text-[10px] font-bold w-4 text-center"
                  style={{ color: i < 3 ? C.green : i < 6 ? C.purple : C.axis }}>#{i+1}</span>
                <span className="text-xs font-mono text-white/80 w-6">:{m.label}</span>
                <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
                  <div className="h-full rounded-full"
                    style={{ width: `${(m.taxa / (topMinutos[0]?.taxa || 1)) * 100}%`,
                      background: i < 3 ? C.green : i < 6 ? C.purple : C.pink }} />
                </div>
                <span className="text-[11px] text-white/50 shrink-0">{m.taxa}%</span>
                <span className="text-[10px] text-white/30 shrink-0">({m.especiais}x)</span>
              </div>
            ))}
          </div>
        </Card>

      </div>
    </div>
  )
}