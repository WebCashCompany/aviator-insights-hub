import { useState, useMemo } from 'react'
import { useCandles } from '@/hooks/useCandles'
import { useWS } from '@/contexts/WebSocketContext'
import { detectarPadroes, corParaLabel, calcularStats } from '@/utils/candleUtils'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  Brush, ReferenceLine, PieChart, Pie, Cell,
} from 'recharts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Download, Upload } from 'lucide-react'
import ImportModal from '@/components/ImportModal'
import { DashboardErrorBoundary } from '@/components/ui/DashboardErrorBoundary'
import { format, isValid } from 'date-fns'

const COLORS = {
  blue:   'hsl(217,91%,60%)',
  purple: 'hsl(263,70%,58%)',
  pink:   'hsl(330,80%,60%)',
}
const LIMITS = [50, 100, 200, 500, 1000]

// ─── Componente interno isolado ────────────────────────────────────────────────
// Separar o conteúdo real do wrapper de ErrorBoundary garante que apenas
// o conteúdo seja desmontado/remontado em caso de erro, sem afetar o layout.
function DashboardContent() {
  const [limit, setLimit] = useState(200)
  const [importOpen, setImportOpen] = useState(false)
  const ws = useWS()

  const { candles: dbCandles, loading } = useCandles({ limit })

  // Mescla banco + WebSocket e deduplica por multiplicador + bucket de 3s
  const candles = useMemo(() => {
    const wsCandles: any[] = Array.isArray(ws?.candles) ? ws.candles : []

    const key = (c: any) => {
      const bucket = Math.floor(new Date(c.created_at).getTime() / 3000)
      return `${Number(c.multiplicador).toFixed(2)}_${bucket}`
    }

    const map = new Map<string, any>()
    for (const c of dbCandles) map.set(key(c), c)
    for (const c of wsCandles) {
      if (!map.has(key(c))) map.set(key(c), c)
    }

    return Array.from(map.values())
      .sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      )
      .slice(-limit)
  }, [dbCandles, ws?.candles, limit])

  const stats    = useMemo(() => calcularStats(candles), [candles])
  const padroes  = useMemo(() => detectarPadroes(candles), [candles])

  const chartData = useMemo(
    () =>
      candles.map((c: any, i: number) => ({
        index: i + 1,
        mult: Number(c.multiplicador),
        cor: c.cor,
      })),
    [candles]
  )

  const pieData = useMemo(
    () => [
      { name: 'Azul',  value: stats?.blue?.count   || 0, color: COLORS.blue },
      { name: 'Roxa',  value: stats?.purple?.count || 0, color: COLORS.purple },
      { name: 'Rosa',  value: stats?.pink?.count   || 0, color: COLORS.pink },
    ],
    [stats]
  )

  const maiorCandle = useMemo(() => {
    if (candles.length === 0) return null
    return candles.reduce(
      (max: any, c: any) => (c.multiplicador > max.multiplicador ? c : max),
      candles[0]
    )
  }, [candles])

  const exportCSV = () => {
    const csv = [
      'multiplicador,cor,fonte,data',
      ...candles.map(
        (c: any) =>
          `${c.multiplicador},${c.cor},${c.fonte ?? ''},${c.created_at}`
      ),
    ].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `aviator_export_${format(new Date(), 'dd-MM-HHmm')}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) {
    return (
      <div className="space-y-4 p-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-80 rounded-xl" />
      </div>
    )
  }

  return (
    <div className="space-y-6 pb-20 lg:pb-0 p-4">

      {/* ── Barra de controles ── */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 bg-white/5 rounded-lg p-1 border border-white/10">
          {LIMITS.map(l => (
            <button
              key={l}
              onClick={() => setLimit(l)}
              className={`px-3 py-1.5 text-xs rounded-md font-medium transition-all
                ${l === limit
                  ? 'bg-blue-600 text-white shadow-lg'
                  : 'text-muted-foreground hover:text-foreground'
                }`}
            >
              {l}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setImportOpen(true)}
            className="border-white/10 bg-white/5"
          >
            <Upload className="h-4 w-4 mr-2" /> Importar
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={exportCSV}
            className="border-white/10 bg-white/5"
          >
            <Download className="h-4 w-4 mr-2" /> Exportar
          </Button>
        </div>
      </div>

      {/* ── Métricas ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard label="Total de velas" value={stats?.total?.toString() || '0'} />
        <MetricCard
          label="Maior multiplicador"
          value={`${stats?.maior?.toFixed(2) || '1.00'}x`}
          sub={
            maiorCandle && isValid(new Date((maiorCandle as any).created_at))
              ? format(new Date((maiorCandle as any).created_at), 'dd/MM HH:mm')
              : ''
          }
        />
        <MetricCard label="Média geral" value={`${stats?.media?.toFixed(2) || '1.00'}x`} />
        <MetricCard
          label="Streak atual"
          value={`${stats?.streakAtual?.count || 0} ${corParaLabel(stats?.streakAtual?.cor || 'blue')}`}
          color={stats?.streakAtual?.cor}
        />
      </div>

      {/* ── Gráfico de área ── */}
      <div className="glass-card p-6 border border-white/10 bg-white/5 rounded-xl">
        <h3 className="text-sm font-medium text-foreground mb-6">
          Tendência de Mercado
        </h3>
        <div className="h-[300px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="colorMult" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={COLORS.blue} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={COLORS.blue} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="index" hide />
              <YAxis domain={[0, 'auto']} stroke="#666" fontSize={12} />
              <Tooltip
                contentStyle={{
                  background: '#0a0a0a',
                  border: '1px solid #333',
                  borderRadius: '8px',
                }}
                itemStyle={{ color: '#fff' }}
                formatter={(val: any) => [
                  `${Number(val).toFixed(2)}x`,
                  'Multiplicador',
                ]}
              />
              <Area
                type="monotone"
                dataKey="mult"
                stroke={COLORS.blue}
                fillOpacity={1}
                fill="url(#colorMult)"
                strokeWidth={2}
              />
              <ReferenceLine y={2}  stroke={COLORS.purple} strokeDasharray="3 3" />
              <ReferenceLine y={10} stroke={COLORS.pink}   strokeDasharray="3 3" />
              <Brush dataKey="index" height={30} stroke="#333" fill="#000" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Distribuição por cor ── */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {(['blue', 'purple', 'pink'] as const).map(cor => {
          const s = stats?.[cor] || { percent: 0, count: 0 }
          return (
            <div
              key={cor}
              className="glass-card p-4 space-y-3 border border-white/10 bg-white/5 rounded-xl"
            >
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium" style={{ color: COLORS[cor] }}>
                  {corParaLabel(cor)}
                </span>
                <span className="text-xs text-muted-foreground">{s.count} un</span>
              </div>
              <p className="text-3xl font-bold">{s.percent.toFixed(1)}%</p>
              <div className="w-full bg-white/10 h-1.5 rounded-full overflow-hidden">
                <div
                  className="h-full transition-all duration-500"
                  style={{ width: `${s.percent}%`, background: COLORS[cor] }}
                />
              </div>
            </div>
          )
        })}

        <div className="glass-card p-2 flex items-center justify-center border border-white/10 bg-white/5 rounded-xl">
          <ResponsiveContainer width="100%" height={120}>
            <PieChart>
              <Pie
                data={pieData}
                innerRadius={35}
                outerRadius={50}
                dataKey="value"
                stroke="none"
              >
                {pieData.map((entry, index) => (
                  <Cell key={index} fill={entry.color} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Tabela das últimas velas ── */}
      <div className="glass-card border border-white/10 bg-white/5 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-white/5 border-b border-white/10">
            <tr>
              <th className="p-4 text-left font-medium">Data/Hora</th>
              <th className="p-4 text-left font-medium">Multiplicador</th>
              <th className="p-4 text-left font-medium">Cor</th>
            </tr>
          </thead>
          <tbody>
            {[...candles]
              .reverse()
              .slice(0, 10)
              .map((c: any, i: number) => (
                <tr
                  key={c.id || i}
                  className="border-b border-white/5 hover:bg-white/10 transition-colors"
                >
                  <td className="p-4 text-muted-foreground">
                    {isValid(new Date(c.created_at))
                      ? format(new Date(c.created_at), 'HH:mm:ss')
                      : 'Agora'}
                  </td>
                  <td
                    className="p-4 font-bold"
                    style={{ color: COLORS[c.cor as keyof typeof COLORS] }}
                  >
                    {Number(c.multiplicador).toFixed(2)}x
                  </td>
                  <td className="p-4">
                    <Badge
                      variant="outline"
                      style={{
                        color:       COLORS[c.cor as keyof typeof COLORS],
                        borderColor: COLORS[c.cor as keyof typeof COLORS],
                      }}
                    >
                      {corParaLabel(c.cor)}
                    </Badge>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  )
}

// ─── Export default: envolve o conteúdo no ErrorBoundary ──────────────────────
export default function DashboardPage() {
  return (
    <DashboardErrorBoundary>
      <DashboardContent />
    </DashboardErrorBoundary>
  )
}

// ─── Componente auxiliar ──────────────────────────────────────────────────────
function MetricCard({
  label,
  value,
  sub,
  color,
}: {
  label: string
  value: string
  sub?: string
  color?: string
}) {
  return (
    <div className="glass-card p-5 border border-white/10 bg-white/5 rounded-xl space-y-1">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        {label}
      </p>
      <p
        className="text-2xl font-black"
        style={color ? { color: COLORS[color as keyof typeof COLORS] } : {}}
      >
        {value}
      </p>
      {sub && (
        <p className="text-[10px] text-muted-foreground font-mono">{sub}</p>
      )}
    </div>
  )
}