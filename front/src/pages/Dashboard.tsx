import { useState, useMemo } from 'react'
import { useCandles } from '@/hooks/useCandles'
import { useWS } from '@/contexts/WebSocketContext'
import { corParaLabel, calcularStats } from '@/utils/candleUtils'
import {
  PieChart, Pie, Cell, Tooltip as ReTooltip, ResponsiveContainer,
} from 'recharts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Download, Upload, TrendingUp, TrendingDown } from 'lucide-react'
import ImportModal from '@/components/ImportModal'
import { DashboardErrorBoundary } from '@/components/ui/DashboardErrorBoundary'
import { format, isValid } from 'date-fns'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip as ChartTooltip,
  Legend,
} from 'chart.js'
import annotationPlugin from 'chartjs-plugin-annotation'
import { Line } from 'react-chartjs-2'

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  ChartTooltip,
  Legend,
  annotationPlugin,
)

// ─── Threshold central ────────────────────────────────────────────────────────
const THRESHOLD = 2
const Y_MAX_DISPLAY = 30
const MA_PERIOD = 10

const COLORS = {
  blue:   '#378ADD',
  purple: '#7F77DD',
  pink:   '#D4537E',
} as const

const LIMITS = [50, 100, 200, 500, 1000]

// ─── Helpers ──────────────────────────────────────────────────────────────────
const isAlta = (mult: number) => mult >= THRESHOLD

function calcularMediaMovel(values: number[], period: number): (number | null)[] {
  return values.map((_, i) => {
    if (i < period - 1) return null
    const slice = values.slice(i - period + 1, i + 1)
    return slice.reduce((a, b) => a + b, 0) / period
  })
}

function calcularTendencia(candles: any[]) {
  if (!candles?.length) return null
  const total     = candles.length
  const altasQtd  = candles.filter(c => isAlta(Number(c.multiplicador))).length
  const baixasQtd = total - altasQtd
  const pctAltas  = (altasQtd  / total) * 100
  const pctBaixas = (baixasQtd / total) * 100

  const recentes    = candles.slice(-10)
  const altasRec    = recentes.filter(c => isAlta(Number(c.multiplicador))).length
  const pctAltasRec = (altasRec / recentes.length) * 100

  const tipo: 'alta' | 'baixa' | 'neutro' =
    pctAltas >= 45 ? 'alta' : pctAltas <= 30 ? 'baixa' : 'neutro'

  return { tipo, pctAltas, pctBaixas, altasQtd, baixasQtd, pctAltasRec, total }
}

// ─── Chave de deduplicação (alinhada com HistoryPage) ────────────────────────
//
// BUG CORRIGIDO: antes usava bucket de tempo de 3 s, o que causava duplicatas
// quando banco e WS chegavam com timestamps ligeiramente diferentes, e também
// colapsava velas distintas com mesmo multiplicador na mesma janela.
//
// Agora usa a mesma estratégia do HistoryPage:
//   • rid_* → rodada_id presente e não é scrape inicial (hist_*)
//   • db_*  → fallback pelo id do banco (estável e único)
function candleKey(c: any): string {
  const rid = c.rodada_id as string | undefined | null
  if (rid && !rid.startsWith('hist_')) return `rid_${rid}`
  return `db_${c.id}`
}

// ─── Badge de tendência ───────────────────────────────────────────────────────
function TrendBadge({ t }: { t: ReturnType<typeof calcularTendencia> }) {
  if (!t) return null
  if (t.tipo === 'alta') return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border bg-green-500/10 border-green-500/30 text-green-400">
      <TrendingUp className="h-3 w-3" />
      Pagando bem · {t.pctAltas.toFixed(0)}% acima de 2x
    </span>
  )
  if (t.tipo === 'baixa') return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border bg-red-500/10 border-red-500/30 text-red-400">
      <TrendingDown className="h-3 w-3" />
      Pagando mal · {t.pctBaixas.toFixed(0)}% abaixo de 2x
    </span>
  )
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border bg-yellow-500/10 border-yellow-500/30 text-yellow-400">
      Neutro · {t.pctAltas.toFixed(0)}% acima de 2x
    </span>
  )
}

// ─── Gráfico com Média Móvel ──────────────────────────────────────────────────
function TrendChart({ chartData }: { chartData: { index: number; mult: number; cor: string }[] }) {
  const isDark = typeof window !== 'undefined'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : true

  const realValues    = chartData.map(d => Number(d.mult))
  const displayValues = realValues.map(v => Math.min(v, Y_MAX_DISPLAY))
  const maValues      = calcularMediaMovel(displayValues, MA_PERIOD)
  const labels        = chartData.map(d => String(d.index))
  const pointColors   = realValues.map(v => isAlta(v) ? '#22c55e' : '#ef4444')
  const pointStyles   = realValues.map(v => v > Y_MAX_DISPLAY ? 'triangle' : 'circle')

  const data = {
    labels,
    datasets: [
      {
        label: 'Multiplicador',
        data: displayValues,
        borderColor: 'rgba(74,144,217,0.30)',
        backgroundColor: 'transparent',
        fill: false,
        borderWidth: 1,
        tension: 0.2,
        pointRadius: chartData.length <= 100 ? 4 : 2,
        pointHoverRadius: 6,
        pointBackgroundColor: pointColors,
        pointBorderColor: isDark ? '#111' : '#fff',
        pointBorderWidth: 1.5,
        pointStyle: pointStyles,
        order: 2,
      },
      {
        label: `MM${MA_PERIOD}`,
        data: maValues,
        borderColor: '#f59e0b',
        backgroundColor: (ctx: any) => {
          const { chartArea, ctx: c } = ctx.chart
          if (!chartArea) return 'rgba(245,158,11,0.05)'
          const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom)
          g.addColorStop(0,   'rgba(245,158,11,0.14)')
          g.addColorStop(1,   'rgba(245,158,11,0.00)')
          return g
        },
        fill: true,
        borderWidth: 2.5,
        tension: 0.45,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: '#f59e0b',
        spanGaps: false,
        order: 1,
      },
    ],
  }

  const options: any = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 280 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        display: true,
        position: 'top' as const,
        align: 'end' as const,
        labels: {
          color: isDark ? '#888' : '#666',
          font: { size: 11 },
          boxWidth: 20,
          usePointStyle: true,
          padding: 12,
        },
      },
      tooltip: {
        backgroundColor: isDark ? '#111' : '#fff',
        borderColor:      isDark ? '#2a2a2a' : '#e0e0e0',
        borderWidth: 1,
        titleColor: isDark ? '#888' : '#666',
        bodyColor:  isDark ? '#eee' : '#111',
        padding: 10,
        callbacks: {
          title: (items: any[]) => `Vela #${items[0].label}`,
          label: (ctx: any) => {
            if (ctx.datasetIndex === 0) {
              const real   = realValues[ctx.dataIndex]
              const status = isAlta(real) ? '✓ Acima de 2x' : '✗ Abaixo de 2x'
              const suffix = real > Y_MAX_DISPLAY ? ` (pico real: ${real.toFixed(2)}x)` : ''
              return ` Vela: ${real.toFixed(2)}x  ·  ${status}${suffix}`
            }
            if (ctx.datasetIndex === 1 && ctx.parsed.y !== null) {
              return ` MM${MA_PERIOD}: ${ctx.parsed.y.toFixed(2)}x`
            }
            return ''
          },
          labelColor: (ctx: any) => {
            if (ctx.datasetIndex === 1) {
              return { backgroundColor: '#f59e0b', borderColor: '#f59e0b', borderRadius: 3 }
            }
            const color = isAlta(realValues[ctx.dataIndex]) ? '#22c55e' : '#ef4444'
            return { backgroundColor: color, borderColor: color, borderRadius: 3 }
          },
        },
      },
      annotation: {
        annotations: {
          zonaBaixa: {
            type: 'box',
            yMin: 0,
            yMax: THRESHOLD,
            backgroundColor: 'rgba(239,68,68,0.07)',
            borderWidth: 0,
          },
          zonaAlta: {
            type: 'box',
            yMin: THRESHOLD,
            yMax: Y_MAX_DISPLAY,
            backgroundColor: 'rgba(34,197,94,0.05)',
            borderWidth: 0,
          },
          linha2x: {
            type: 'line',
            yMin: THRESHOLD,
            yMax: THRESHOLD,
            borderColor: 'rgba(255,255,255,0.35)',
            borderWidth: 1.5,
            borderDash: [6, 4],
            label: {
              content: '2x — threshold',
              display: true,
              position: 'end',
              backgroundColor: 'rgba(255,255,255,0.08)',
              color: 'rgba(255,255,255,0.65)',
              font: { size: 10, weight: '500' },
              padding: { x: 6, y: 3 },
              borderRadius: 4,
            },
          },
        },
      },
    },
    scales: {
      x: { display: false },
      y: {
        min: 0,
        max: Y_MAX_DISPLAY,
        grid: {
          color: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
          lineWidth: 0.5,
        },
        border: { display: false },
        ticks: {
          color: isDark ? '#555' : '#999',
          font: { size: 11 },
          callback: (v: any) => `${v}x`,
          maxTicksLimit: 7,
        },
      },
    },
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '240px' }}>
      <Line data={data} options={options} />
    </div>
  )
}

// ─── Barra de distribuição ────────────────────────────────────────────────────
function DistBar({
  label, count, total, color, bold,
}: {
  label: string; count: number; total: number; color: string; bold?: boolean
}) {
  const pct = total > 0 ? (count / total) * 100 : 0
  return (
    <div className={`flex items-center gap-3 ${bold ? '' : 'opacity-70'}`}>
      <span className="text-xs font-medium w-28 shrink-0" style={{ color }}>{label}</span>
      <div className="flex-1 bg-white/10 rounded-full h-2 overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="text-xs font-medium w-10 text-right" style={{ color }}>{pct.toFixed(1)}%</span>
      <span className="text-xs text-muted-foreground w-10 text-right">{count}</span>
    </div>
  )
}

// ─── MetricCard ───────────────────────────────────────────────────────────────
function MetricCard({ label, value, sub, valueColor }: {
  label: string; value: string; sub?: string; valueColor?: string
}) {
  return (
    <div className="glass-card p-4 border border-white/10 bg-white/5 rounded-xl space-y-1">
      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className="text-xl font-black leading-tight" style={valueColor ? { color: valueColor } : {}}>{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  )
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function DashboardContent() {
  const [limit, setLimit]           = useState(100)
  const [importOpen, setImportOpen] = useState(false)
  const ws = useWS()

  const { candles: dbCandles, loading } = useCandles({ limit })

  // BUG CORRIGIDO: chave de deduplicação alinhada com HistoryPage.
  // Antes usava bucket de tempo de 3 s → duplicatas quando banco e WS chegavam
  // com timestamps ligeiramente diferentes.
  // Agora usa rodada_id (quando disponível e não é scrape hist_*) ou id do banco.
  const candles = useMemo(() => {
    const wsCandles: any[] = Array.isArray(ws?.candles) ? ws.candles : []

    const map = new Map<string, any>()

    // 1. Banco primeiro (fonte de verdade)
    for (const c of dbCandles) map.set(candleKey(c), c)

    // 2. WS: adiciona apenas o que ainda não está no banco
    //    hist_* (scrape inicial) são ignoradas para evitar duplicatas
    for (const c of wsCandles) {
      const rid = c.rodada_id as string | undefined | null
      if (rid && rid.startsWith('hist_')) continue
      const k = candleKey(c)
      if (!map.has(k)) map.set(k, c)
    }

    return Array.from(map.values())
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      .slice(-limit)
  }, [dbCandles, ws?.candles, limit])

  const stats     = useMemo(() => calcularStats(candles),    [candles])
  const tendencia = useMemo(() => calcularTendencia(candles), [candles])

  const chartData = useMemo(() =>
    candles.map((c: any, i: number) => ({
      index: i + 1,
      mult:  Number(c.multiplicador),
      cor:   c.cor,
    })),
    [candles]
  )

  const thresholdStats = useMemo(() => {
    const total     = candles.length
    const altasQtd  = candles.filter(c => isAlta(Number(c.multiplicador))).length
    const baixasQtd = total - altasQtd
    let streakCount = 0
    let streakTipo  = 'baixa'
    if (total > 0) {
      const ultimaTipo = isAlta(Number(candles[total - 1].multiplicador)) ? 'alta' : 'baixa'
      streakTipo = ultimaTipo
      for (let i = total - 1; i >= 0; i--) {
        if ((isAlta(Number(candles[i].multiplicador)) ? 'alta' : 'baixa') === ultimaTipo) streakCount++
        else break
      }
    }
    return { altasQtd, baixasQtd, total, streakCount, streakTipo }
  }, [candles])

  // ── Dados do pie por COR de vela ──────────────────────────────────────────
  const pieDataCores = useMemo(() => [
    { name: 'Azul',  value: stats?.blue?.count   ?? 0, color: COLORS.blue },
    { name: 'Roxa',  value: stats?.purple?.count ?? 0, color: COLORS.purple },
    { name: 'Rosa',  value: stats?.pink?.count   ?? 0, color: COLORS.pink },
  ], [stats])

  const exportCSV = () => {
    const csv = [
      'multiplicador,cor,fonte,data',
      ...candles.map((c: any) => `${c.multiplicador},${c.cor},${c.fonte ?? ''},${c.created_at}`),
    ].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = `aviator_export_${format(new Date(), 'dd-MM-HHmm')}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) return (
    <div className="space-y-4 p-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[1,2,3,4].map(i => <Skeleton key={i} className="h-24 rounded-xl" />)}
      </div>
      <Skeleton className="h-80 rounded-xl" />
    </div>
  )

  return (
    <div className="space-y-5 pb-20 lg:pb-0 p-4">

      {/* ── Controles ── */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 bg-white/5 rounded-lg p-1 border border-white/10">
          {LIMITS.map(l => (
            <button key={l} onClick={() => setLimit(l)}
              className={`px-3 py-1.5 text-xs rounded-md font-medium transition-all
                ${l === limit ? 'bg-blue-600 text-white shadow-lg' : 'text-muted-foreground hover:text-foreground'}`}>
              {l}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)} className="border-white/10 bg-white/5">
            <Upload className="h-4 w-4 mr-2" /> Importar
          </Button>
          <Button variant="outline" size="sm" onClick={exportCSV} className="border-white/10 bg-white/5">
            <Download className="h-4 w-4 mr-2" /> Exportar
          </Button>
        </div>
      </div>

      {/* ── Métricas ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MetricCard label="Total de velas" value={String(thresholdStats.total)} />
        <MetricCard
          label="Pagando bem (≥ 2x)"
          value={String(thresholdStats.altasQtd)}
          sub={`${tendencia?.pctAltas.toFixed(1) ?? '0'}% do total`}
          valueColor="#22c55e"
        />
        <MetricCard
          label="Pagando mal (< 2x)"
          value={String(thresholdStats.baixasQtd)}
          sub={`${tendencia?.pctBaixas.toFixed(1) ?? '0'}% do total`}
          valueColor="#ef4444"
        />
        <MetricCard
          label="Streak atual"
          value={String(thresholdStats.streakCount)}
          sub={thresholdStats.streakTipo === 'alta' ? 'seguidas ≥ 2x' : 'seguidas < 2x'}
          valueColor={thresholdStats.streakTipo === 'alta' ? '#22c55e' : '#ef4444'}
        />
      </div>

      {/* ── Card do gráfico ── */}
      <div className="glass-card border border-white/10 bg-white/5 rounded-xl overflow-hidden">

        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5 pb-0">
          <div className="flex items-center gap-2.5">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
            </span>
            <div>
              <h3 className="text-sm font-semibold text-foreground leading-tight">Tendência de Mercado</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Threshold: <span className="font-semibold text-white">2x</span>
                &nbsp;· {candles.length} velas · ao vivo
              </p>
            </div>
          </div>
          <TrendBadge t={tendencia} />
        </div>

        {/* Legenda */}
        <div className="flex flex-wrap items-center gap-4 px-5 mt-3">
          <span className="flex items-center gap-1.5 text-xs text-green-400">
            <span className="w-2.5 h-2.5 rounded-full bg-green-500" /> Acima de 2x
          </span>
          <span className="flex items-center gap-1.5 text-xs text-red-400">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500" /> Abaixo de 2x
          </span>
          <span className="flex items-center gap-1.5 text-xs" style={{ color: '#f59e0b' }}>
            <span className="inline-block w-5 border-t-2 border-dashed" style={{ borderColor: '#f59e0b' }} />
            MM{MA_PERIOD} (Média Móvel)
          </span>
          <span className="text-xs text-muted-foreground">· Y limitado a 30x</span>
        </div>

        {/* Gráfico */}
        <div className="px-4 pt-3 pb-4">
          <TrendChart chartData={chartData} />
        </div>

        {/* Barras */}
        <div className="border-t border-white/10 px-5 py-4 space-y-2.5">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
            Distribuição — threshold 2x
          </p>
          <DistBar label="Acima de 2x (bom)"  count={thresholdStats.altasQtd}  total={thresholdStats.total} color="#22c55e" bold={tendencia?.tipo === 'alta'} />
          <DistBar label="Abaixo de 2x (ruim)" count={thresholdStats.baixasQtd} total={thresholdStats.total} color="#ef4444" bold={tendencia?.tipo === 'baixa'} />
          <div className="border-t border-white/10 pt-3 mt-1 space-y-2">
            <p className="text-xs text-muted-foreground">Por cor de vela</p>
            {(['blue', 'purple', 'pink'] as const).map(cor => {
              const s = stats?.[cor] || { percent: 0, count: 0 }
              return (
                <DistBar key={cor} label={corParaLabel(cor)} count={s.count} total={thresholdStats.total} color={COLORS[cor]} />
              )
            })}
          </div>
        </div>

        {/* Insight */}
        {tendencia && (
          <div className="border-t border-white/10 px-5 py-3 flex items-start gap-2.5">
            <div className="w-2 h-2 rounded-full shrink-0 mt-0.5" style={{
              background: tendencia.tipo === 'alta' ? '#22c55e' : tendencia.tipo === 'baixa' ? '#ef4444' : '#f59e0b'
            }} />
            <p className="text-xs text-muted-foreground leading-relaxed">
              {tendencia.tipo === 'alta' &&
                `${tendencia.pctAltas.toFixed(0)}% das últimas ${tendencia.total} velas pagaram acima de 2x. Nas últimas 10, ${tendencia.pctAltasRec.toFixed(0)}% estão pagando bem.`}
              {tendencia.tipo === 'baixa' &&
                `${tendencia.pctBaixas.toFixed(0)}% das últimas ${tendencia.total} velas pagaram abaixo de 2x. Nas últimas 10, ${(100 - tendencia.pctAltasRec).toFixed(0)}% pagando mal — cautela.`}
              {tendencia.tipo === 'neutro' &&
                `Mercado oscilando em torno do threshold 2x. ${tendencia.pctAltas.toFixed(0)}% acima, ${tendencia.pctBaixas.toFixed(0)}% abaixo. Aguarde definição.`}
            </p>
          </div>
        )}
      </div>

      {/* ── Cards por cor + pizza ── */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {(['blue', 'purple', 'pink'] as const).map(cor => {
          const s = stats?.[cor] || { percent: 0, count: 0 }
          return (
            <div key={cor} className="glass-card p-4 space-y-3 border border-white/10 bg-white/5 rounded-xl">
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium" style={{ color: COLORS[cor] }}>{corParaLabel(cor)}</span>
                <span className="text-xs text-muted-foreground">{s.count} un</span>
              </div>
              <p className="text-3xl font-bold">{s.percent.toFixed(1)}%</p>
              <div className="w-full bg-white/10 h-1.5 rounded-full overflow-hidden">
                <div className="h-full transition-all duration-500" style={{ width: `${s.percent}%`, background: COLORS[cor] }} />
              </div>
            </div>
          )
        })}

        {/* Pizza: distribuição por COR de vela */}
        <div className="glass-card p-2 flex flex-col items-center justify-center border border-white/10 bg-white/5 rounded-xl gap-1">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mt-2">Por cor</p>
          <ResponsiveContainer width="100%" height={100}>
            <PieChart>
              <Pie
                data={pieDataCores}
                innerRadius={30}
                outerRadius={44}
                dataKey="value"
                stroke="none"
              >
                {pieDataCores.map((entry, i) => (
                  <Cell key={i} fill={entry.color} />
                ))}
              </Pie>
              <ReTooltip
                contentStyle={{ background: '#0a0a0a', border: '1px solid #333', borderRadius: '8px', fontSize: '12px' }}
                itemStyle={{ color: '#fff' }}
                formatter={(value: any, name: any) => [`${value} un`, name]}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex gap-2 text-[10px] pb-2">
            <span className="flex items-center gap-1" style={{ color: COLORS.blue }}>
              <span className="w-2 h-2 rounded-full" style={{ background: COLORS.blue }} /> Azul
            </span>
            <span className="flex items-center gap-1" style={{ color: COLORS.purple }}>
              <span className="w-2 h-2 rounded-full" style={{ background: COLORS.purple }} /> Roxa
            </span>
            <span className="flex items-center gap-1" style={{ color: COLORS.pink }}>
              <span className="w-2 h-2 rounded-full" style={{ background: COLORS.pink }} /> Rosa
            </span>
          </div>
        </div>
      </div>

      {/* ── Tabela ── */}
      <div className="glass-card border border-white/10 bg-white/5 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-white/5 border-b border-white/10">
            <tr>
              <th className="p-4 text-left font-medium">Data/Hora</th>
              <th className="p-4 text-left font-medium">Multiplicador</th>
              <th className="p-4 text-left font-medium">Cor</th>
              <th className="p-4 text-left font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {[...candles].reverse().slice(0, 10).map((c: any, i: number) => {
              const mult = Number(c.multiplicador)
              const paga = isAlta(mult)
              return (
                <tr key={c.id || i} className="border-b border-white/5 hover:bg-white/10 transition-colors">
                  <td className="p-4 text-muted-foreground">
                    {isValid(new Date(c.created_at)) ? format(new Date(c.created_at), 'HH:mm:ss') : 'Agora'}
                  </td>
                  <td className="p-4 font-bold" style={{ color: paga ? '#22c55e' : '#ef4444' }}>
                    {mult.toFixed(2)}x
                  </td>
                  <td className="p-4">
                    <Badge variant="outline" style={{ color: COLORS[c.cor as keyof typeof COLORS], borderColor: COLORS[c.cor as keyof typeof COLORS] }}>
                      {corParaLabel(c.cor)}
                    </Badge>
                  </td>
                  <td className="p-4">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
                      paga
                        ? 'bg-green-500/10 text-green-400 border-green-500/20'
                        : 'bg-red-500/10 text-red-400 border-red-500/20'
                    }`}>
                      {paga ? '≥ 2x' : '< 2x'}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  )
}

export default function DashboardPage() {
  return (
    <DashboardErrorBoundary>
      <DashboardContent />
    </DashboardErrorBoundary>
  )
}