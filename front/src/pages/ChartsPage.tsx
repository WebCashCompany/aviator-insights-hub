import { useMemo } from 'react'
import { useCandles } from '@/hooks/useCandles'
import { useWS } from '@/contexts/WebSocketContext'
import { calcularStats } from '@/utils/candleUtils'
import {
  AreaChart, Area,
  BarChart, Bar,
  LineChart, Line,
  ScatterChart, Scatter,
  RadarChart, Radar, PolarGrid, PolarAngleAxis,
  XAxis, YAxis, ZAxis,
  Tooltip, ResponsiveContainer, Cell,
  CartesianGrid, ReferenceLine, Legend,
} from 'recharts'
import { format, isValid, getHours } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { TrendingUp, Activity, Clock, Zap, Target, BarChart2 } from 'lucide-react'

// ── Paleta ────────────────────────────────────────────────────────────────────
const C = {
  blue:   'hsl(217,91%,60%)',
  purple: 'hsl(263,70%,58%)',
  pink:   'hsl(330,80%,60%)',
  grid:   'rgba(255,255,255,0.06)',
  axis:   'rgba(255,255,255,0.25)',
  bg:     'rgba(255,255,255,0.03)',
}

const TOOLTIP_STYLE = {
  contentStyle: { background: '#0d0d0f', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', fontSize: 12 },
  itemStyle: { color: '#fff' },
  labelStyle: { color: 'rgba(255,255,255,0.5)', fontSize: 11 },
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function corColor(cor: string) { return C[cor as keyof typeof C] || C.blue }

function buildStreakHistory(candles: any[]) {
  if (candles.length === 0) return []
  const result: { index: number; streak: number; cor: string }[] = []
  let streak = 1
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].cor === candles[i - 1].cor) { streak++ }
    else { streak = 1 }
    result.push({ index: i, streak, cor: candles[i].cor })
  }
  return result
}

function buildIntervalRosa(candles: any[]) {
  const intervals: { ocorrencia: number; intervalo: number; mult: number }[] = []
  let lastIdx = -1
  let count = 0
  candles.forEach((c, i) => {
    if (c.cor === 'pink') {
      if (lastIdx >= 0) {
        count++
        intervals.push({ ocorrencia: count, intervalo: i - lastIdx, mult: Number(c.multiplicador) })
      }
      lastIdx = i
    }
  })
  return intervals
}

function buildHeatmapHora(candles: any[]) {
  const horas: Record<number, { blue: number; purple: number; pink: number; total: number }> = {}
  for (let h = 0; h < 24; h++) {
    horas[h] = { blue: 0, purple: 0, pink: 0, total: 0 }
  }
  candles.forEach(c => {
    const d = new Date(c.created_at)
    if (!isValid(d)) return
    const h = getHours(d)
    horas[h][c.cor as 'blue' | 'purple' | 'pink']++
    horas[h].total++
  })
  return Object.entries(horas)
    .filter(([, v]) => v.total > 0)
    .map(([hora, v]) => ({
      hora: `${hora}h`,
      horaNum: Number(hora),
      azul: v.blue,
      roxa: v.purple,
      rosa: v.pink,
      total: v.total,
      pctRosa: v.total > 0 ? Number(((v.pink / v.total) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => a.horaNum - b.horaNum)
}

function buildCorrelacao(candles: any[]) {
  return candles.slice(1).map((c, i) => ({
    anterior: Number(candles[i].multiplicador),
    atual: Number(c.multiplicador),
    cor: c.cor,
  }))
}

function buildRunLength(candles: any[]) {
  if (candles.length === 0) return { blue: [], purple: [], pink: [] }
  const runs: Record<string, number[]> = { blue: [], purple: [], pink: [] }
  let cur = candles[0].cor
  let len = 1
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].cor === cur) { len++ }
    else { runs[cur].push(len); cur = candles[i].cor; len = 1 }
  }
  runs[cur].push(len)
  const toFreq = (arr: number[]) => {
    const freq: Record<number, number> = {}
    arr.forEach(n => { freq[n] = (freq[n] || 0) + 1 })
    return Object.entries(freq).map(([k, v]) => ({ tamanho: Number(k), frequencia: v })).sort((a, b) => a.tamanho - b.tamanho)
  }
  return { blue: toFreq(runs.blue), purple: toFreq(runs.purple), pink: toFreq(runs.pink) }
}

function buildRadar(candles: any[]) {
  const stats = calcularStats(candles)
  if (!stats || stats.total === 0) return []
  const max = (v: number, m: number) => Math.min(100, Math.round((v / m) * 100))
  return [
    { metrica: 'Freq. Azul',  valor: Math.round(stats.blue.percent) },
    { metrica: 'Freq. Roxa',  valor: Math.round(stats.purple.percent) },
    { metrica: 'Freq. Rosa',  valor: Math.round(stats.pink.percent * 3) },
    { metrica: 'Streak Azul', valor: max(stats.maiorStreakAzul, 20) },
    { metrica: 'Streak Roxa', valor: max(stats.maiorStreakRoxa, 20) },
    { metrica: 'Volatil.',    valor: max(stats.maior, 100) },
  ]
}

// ── Componente de Card de Gráfico ─────────────────────────────────────────────
function ChartCard({ title, subtitle, icon: Icon, children, span = 1 }: {
  title: string
  subtitle?: string
  icon: any
  children: React.ReactNode
  span?: 1 | 2
}) {
  return (
    <div
      className="rounded-2xl border border-white/8 bg-white/3 p-5 flex flex-col gap-4 backdrop-blur-sm"
      style={{ gridColumn: span === 2 ? 'span 2' : 'span 1' }}
    >
      <div className="flex items-center gap-2.5">
        <div className="p-1.5 rounded-lg bg-white/5">
          <Icon className="h-4 w-4 text-white/50" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-white/90 leading-none">{title}</h3>
          {subtitle && <p className="text-[11px] text-white/35 mt-0.5">{subtitle}</p>}
        </div>
      </div>
      {children}
    </div>
  )
}

const CustomDot = (props: any) => {
  const { cx, cy, payload } = props
  return <circle cx={cx} cy={cy} r={3} fill={corColor(payload.cor)} fillOpacity={0.8} stroke="none" />
}

// ── Página Principal ──────────────────────────────────────────────────────────
export default function ChartsPage() {
  const ws = useWS()

  const { candles: dbCandles } = useCandles({ limit: 500 })

  // Mescla WS + banco (mesmo padrão do Dashboard)
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

  const multSerie = useMemo(() =>
    candles.map((c, i) => ({ i: i + 1, v: Number(c.multiplicador), cor: c.cor })),
    [candles]
  )

  const distData = useMemo(() => {
    const buckets: Record<string, { label: string; count: number; cor: string }> = {
      '1-2':   { label: '1–2x',   count: 0, cor: 'blue' },
      '2-5':   { label: '2–5x',   count: 0, cor: 'purple' },
      '5-10':  { label: '5–10x',  count: 0, cor: 'purple' },
      '10-20': { label: '10–20x', count: 0, cor: 'pink' },
      '20+':   { label: '20x+',   count: 0, cor: 'pink' },
    }
    candles.forEach(c => {
      const v = Number(c.multiplicador)
      if (v < 2)       buckets['1-2'].count++
      else if (v < 5)  buckets['2-5'].count++
      else if (v < 10) buckets['5-10'].count++
      else if (v < 20) buckets['10-20'].count++
      else             buckets['20+'].count++
    })
    return Object.values(buckets)
  }, [candles])

  const streakHistory = useMemo(() => buildStreakHistory(candles), [candles])
  const intervalRosa  = useMemo(() => buildIntervalRosa(candles), [candles])
  const heatmap       = useMemo(() => buildHeatmapHora(candles), [candles])
  const correlacao    = useMemo(() => buildCorrelacao(candles), [candles])
  const runLength     = useMemo(() => buildRunLength(candles), [candles])
  const radarData     = useMemo(() => buildRadar(candles), [candles])

  const mediaMovel = useMemo(() => {
    const W = 10
    return multSerie.map((d, i) => {
      if (i < W - 1) return { ...d, ma: null }
      const slice = multSerie.slice(i - W + 1, i + 1)
      const ma = slice.reduce((s, x) => s + x.v, 0) / W
      return { ...d, ma: Number(ma.toFixed(2)) }
    })
  }, [multSerie])

  if (candles.length < 5) {
    return (
      <div className="flex items-center justify-center h-64 text-white/30 text-sm p-4">
        Aguardando dados suficientes para gerar análises...
      </div>
    )
  }

  return (
    <div className="p-4 pb-24 lg:pb-6 space-y-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h1 className="text-lg font-bold text-white">Análise Gráfica</h1>
          <p className="text-xs text-white/35 mt-0.5">{candles.length} velas · sessão atual</p>
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        <ChartCard
          title="Multiplicadores ao Longo do Tempo"
          subtitle={`Média móvel 10 períodos · pico ${stats?.maior?.toFixed(2)}x`}
          icon={TrendingUp}
          span={2}
        >
          <div className="h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={mediaMovel} margin={{ left: -20, right: 4 }}>
                <defs>
                  <linearGradient id="gMult" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={C.blue} stopOpacity={0.25}/>
                    <stop offset="95%" stopColor={C.blue} stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={C.grid} vertical={false} />
                <XAxis dataKey="i" hide />
                <YAxis stroke={C.axis} fontSize={10} tickFormatter={v => `${v}x`} />
                <Tooltip {...TOOLTIP_STYLE} formatter={(v: any) => [`${Number(v).toFixed(2)}x`]} />
                <ReferenceLine y={2}  stroke={C.purple} strokeDasharray="3 3" strokeOpacity={0.5} />
                <ReferenceLine y={10} stroke={C.pink}   strokeDasharray="3 3" strokeOpacity={0.5} />
                <Area dataKey="v"  stroke={C.blue} fill="url(#gMult)" strokeWidth={1.5} dot={false} name="Multiplicador" />
                <Line dataKey="ma" stroke={C.pink} strokeWidth={2}    dot={false} strokeDasharray="4 2" name="Média 10p" connectNulls />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <ChartCard
          title="Distribuição por Faixa"
          subtitle="Quantas velas caíram em cada faixa de multiplicador"
          icon={BarChart2}
        >
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={distData} margin={{ left: -20, right: 4 }}>
                <CartesianGrid stroke={C.grid} vertical={false} />
                <XAxis dataKey="label" stroke={C.axis} fontSize={10} />
                <YAxis stroke={C.axis} fontSize={10} />
                <Tooltip {...TOOLTIP_STYLE} formatter={(v: any) => [`${v} velas`]} />
                <Bar dataKey="count" radius={[6,6,0,0]} name="Velas">
                  {distData.map((d, i) => <Cell key={i} fill={corColor(d.cor)} fillOpacity={0.85} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <ChartCard
          title="Comprimento de Streak por Vela"
          subtitle="Tamanho da sequência consecutiva em cada ponto"
          icon={Activity}
        >
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={streakHistory.slice(-80)} margin={{ left: -20, right: 4 }}>
                <CartesianGrid stroke={C.grid} vertical={false} />
                <XAxis dataKey="index" hide />
                <YAxis stroke={C.axis} fontSize={10} allowDecimals={false} />
                <Tooltip {...TOOLTIP_STYLE} formatter={(v: any, _: any, p: any) => [`${v} seguidas`, p.payload.cor === 'blue' ? 'Azul' : p.payload.cor === 'purple' ? 'Roxa' : 'Rosa']} />
                <Bar dataKey="streak" radius={[3,3,0,0]} name="Streak">
                  {streakHistory.slice(-80).map((d, i) => <Cell key={i} fill={corColor(d.cor)} fillOpacity={0.8} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <ChartCard
          title="Intervalo Entre Rosas (10x+)"
          subtitle="Quantas velas entre cada aparição Rosa"
          icon={Zap}
        >
          {intervalRosa.length < 2 ? (
            <div className="h-[200px] flex items-center justify-center text-white/25 text-xs">
              Aguardando mais aparições Rosa...
            </div>
          ) : (
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={intervalRosa} margin={{ left: -20, right: 4 }}>
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis dataKey="ocorrencia" stroke={C.axis} fontSize={10} tickFormatter={v => `#${v}`} />
                  <YAxis stroke={C.axis} fontSize={10} label={{ value: 'velas', angle: -90, position: 'insideLeft', fill: C.axis, fontSize: 9, dx: 20 }} />
                  <Tooltip {...TOOLTIP_STYLE} formatter={(v: any, n: any, p: any) => [`${v} velas · ${p.payload.mult}x`, 'Intervalo']} />
                  <ReferenceLine
                    y={intervalRosa.reduce((s, d) => s + d.intervalo, 0) / intervalRosa.length}
                    stroke={C.purple} strokeDasharray="4 2" label={{ value: 'média', fill: C.purple, fontSize: 9 }}
                  />
                  <Bar dataKey="intervalo" fill={C.pink} fillOpacity={0.7} radius={[4,4,0,0]} name="Intervalo" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </ChartCard>

        <ChartCard
          title="% Rosa por Horário"
          subtitle="Em quais horas Rosa (10x+) aparece mais"
          icon={Clock}
          span={2}
        >
          {heatmap.length < 2 ? (
            <div className="h-[180px] flex items-center justify-center text-white/25 text-xs">
              Dados insuficientes por horário...
            </div>
          ) : (
            <div className="h-[180px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={heatmap} margin={{ left: -20, right: 4 }}>
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis dataKey="hora" stroke={C.axis} fontSize={10} />
                  <YAxis stroke={C.axis} fontSize={10} tickFormatter={v => `${v}%`} />
                  <Tooltip
                    {...TOOLTIP_STYLE}
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null
                      const d = payload[0].payload
                      return (
                        <div style={TOOLTIP_STYLE.contentStyle} className="p-3 space-y-1">
                          <p className="font-bold text-white">{d.hora}</p>
                          <p style={{ color: C.blue   }}>Azul: {d.azul}</p>
                          <p style={{ color: C.purple }}>Roxa: {d.roxa}</p>
                          <p style={{ color: C.pink   }}>Rosa: {d.rosa} ({d.pctRosa}%)</p>
                          <p className="text-white/40">Total: {d.total}</p>
                        </div>
                      )
                    }}
                  />
                  <Bar dataKey="pctRosa" radius={[4,4,0,0]} name="% Rosa">
                    {heatmap.map((d, i) => (
                      <Cell key={i} fill={C.pink} fillOpacity={0.15 + (d.pctRosa / 100) * 0.85} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </ChartCard>

        <ChartCard
          title="Correlação: Vela Anterior × Atual"
          subtitle="Cada ponto é uma vela. Padrões indicam dependência entre rodadas"
          icon={Target}
          span={2}
        >
          <div className="h-[260px]">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ left: -10, right: 10 }}>
                <CartesianGrid stroke={C.grid} />
                <XAxis dataKey="anterior" name="Anterior" stroke={C.axis} fontSize={10}
                  tickFormatter={v => `${v}x`} domain={[0, 'auto']}
                  label={{ value: 'Vela anterior (x)', position: 'insideBottom', offset: -2, fill: C.axis, fontSize: 10 }}
                />
                <YAxis dataKey="atual" name="Atual" stroke={C.axis} fontSize={10}
                  tickFormatter={v => `${v}x`}
                  label={{ value: 'Vela atual (x)', angle: -90, position: 'insideLeft', fill: C.axis, fontSize: 10, dx: 20 }}
                />
                <ZAxis range={[18, 18]} />
                <Tooltip
                  {...TOOLTIP_STYLE}
                  cursor={{ strokeDasharray: '3 3', stroke: 'rgba(255,255,255,0.1)' }}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null
                    const d = payload[0].payload
                    return (
                      <div style={TOOLTIP_STYLE.contentStyle} className="p-2 text-xs">
                        <p style={{ color: corColor(d.cor) }}>Anterior: {d.anterior.toFixed(2)}x</p>
                        <p style={{ color: corColor(d.cor) }}>Atual: {d.atual.toFixed(2)}x</p>
                      </div>
                    )
                  }}
                />
                {(['blue', 'purple', 'pink'] as const).map(cor => (
                  <Scatter
                    key={cor}
                    data={correlacao.filter(d => d.cor === cor).slice(-150)}
                    fill={corColor(cor)}
                    fillOpacity={0.55}
                    name={cor === 'blue' ? 'Azul' : cor === 'purple' ? 'Roxa' : 'Rosa'}
                    shape={<CustomDot />}
                  />
                ))}
                <Legend formatter={(v) => <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>{v}</span>} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <ChartCard
          title="Distribuição de Sequências por Cor"
          subtitle="Com que frequência cada cor forma sequências de N rodadas"
          icon={BarChart2}
          span={2}
        >
          <div className="grid grid-cols-3 gap-3">
            {([
              { cor: 'blue',   label: 'Azul',  data: runLength.blue },
              { cor: 'purple', label: 'Roxa',  data: runLength.purple },
              { cor: 'pink',   label: 'Rosa',  data: runLength.pink },
            ] as const).map(({ cor, label, data }) => (
              <div key={cor}>
                <p className="text-[11px] font-semibold mb-2" style={{ color: corColor(cor) }}>{label}</p>
                <div className="h-[160px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data} margin={{ left: -28, right: 4 }}>
                      <CartesianGrid stroke={C.grid} vertical={false} />
                      <XAxis dataKey="tamanho" stroke={C.axis} fontSize={9} tickFormatter={v => `${v}x`} />
                      <YAxis stroke={C.axis} fontSize={9} />
                      <Tooltip {...TOOLTIP_STYLE} formatter={(v: any, _, p) => [`${v}×`, `Seq. ${p.payload.tamanho} seguidas`]} />
                      <Bar dataKey="frequencia" fill={corColor(cor)} fillOpacity={0.75} radius={[3,3,0,0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            ))}
          </div>
        </ChartCard>

        <ChartCard
          title="Perfil da Sessão"
          subtitle="Visão radar das métricas relativas da sessão atual"
          icon={Activity}
        >
          <div className="h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart data={radarData} margin={{ top: 10, right: 20, bottom: 10, left: 20 }}>
                <PolarGrid stroke={C.grid} />
                <PolarAngleAxis dataKey="metrica" tick={{ fill: 'rgba(255,255,255,0.45)', fontSize: 10 }} />
                <Radar dataKey="valor" stroke={C.blue} fill={C.blue} fillOpacity={0.15} strokeWidth={2} />
              </RadarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <ChartCard
          title="Volume por Horário (Azul / Roxa / Rosa)"
          subtitle="Composição de cores em cada hora do dia"
          icon={Clock}
        >
          {heatmap.length < 2 ? (
            <div className="h-[220px] flex items-center justify-center text-white/25 text-xs">
              Dados insuficientes por horário...
            </div>
          ) : (
            <div className="h-[220px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={heatmap} margin={{ left: -20, right: 4 }}>
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis dataKey="hora" stroke={C.axis} fontSize={10} />
                  <YAxis stroke={C.axis} fontSize={10} />
                  <Tooltip {...TOOLTIP_STYLE} />
                  <Bar dataKey="azul"  stackId="a" fill={C.blue}   fillOpacity={0.8} name="Azul"  radius={[0,0,0,0]} />
                  <Bar dataKey="roxa"  stackId="a" fill={C.purple} fillOpacity={0.8} name="Roxa" />
                  <Bar dataKey="rosa"  stackId="a" fill={C.pink}   fillOpacity={0.8} name="Rosa"  radius={[4,4,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </ChartCard>

      </div>
    </div>
  )
}