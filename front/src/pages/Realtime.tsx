import { useEffect, useMemo } from 'react'
import { useWS } from '@/contexts/WebSocketContext'
import { corParaLabel } from '@/utils/candleUtils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer,
  Cell, Tooltip, CartesianGrid, ReferenceLine,
} from 'recharts'
import { motion, AnimatePresence } from 'framer-motion'
import { formatDistanceToNow, isValid } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { toast } from 'sonner'

const COLORS = {
  blue:   'hsl(217,91%,60%)',
  purple: 'hsl(263,70%,58%)',
  pink:   'hsl(330,80%,60%)',
}

const REFERENCE_LINES = [
  { y: 2,   stroke: COLORS.purple, label: '2x'   },
  { y: 10,  stroke: COLORS.pink,   label: '10x'  },
  { y: 20,  stroke: COLORS.pink,   label: '20x'  },
  { y: 50,  stroke: COLORS.purple, label: '50x'  },
  { y: 100, stroke: COLORS.pink,   label: '100x' },
]

export default function RealtimePage() {
  const ws = useWS()

  const wsCandles: any[] = useMemo(() => {
    return Array.isArray(ws?.candles) ? ws.candles : []
  }, [ws?.candles])

  const recentCandles = useMemo(() => {
    return [...wsCandles]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 20)
  }, [wsCandles])

  const barData = useMemo(() => {
    return [...wsCandles]
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      .slice(-30)
      .map((c, i) => ({
        index: i,
        // Garantimos que o valor mínimo seja 1 para não quebrar a escala logarítmica
        mult: Math.max(Number(c.multiplicador), 1), 
        cor: c.cor || 'blue',
      }))
  }, [wsCandles])

  useEffect(() => {
    if (ws?.lastCandle?.cor === 'pink') {
      toast.success('🌸 Rosa detectada!', {
        description: `${Number(ws.lastCandle.multiplicador).toFixed(2)}x`,
        duration: 5000,
      })
    }
  }, [ws?.lastCandle])

  return (
    <div className="space-y-6 pb-20 lg:pb-0 p-4">
      
      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scroll::-webkit-scrollbar { width: 4px; }
        .custom-scroll::-webkit-scrollbar-track { background: transparent; }
        .custom-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 10px; }
        .custom-scroll::-webkit-scrollbar-thumb:hover { background: ${COLORS.purple}; }
      `}} />

      {/* Cabeçalho de Status */}
      <div className="glass-card p-6 border border-white/10 bg-white/5 rounded-xl">
        <div className="flex items-center gap-4">
          <div className={`h-4 w-4 rounded-full ${ws?.connected ? 'bg-green-500 animate-pulse' : 'bg-red-500 shadow-[0_0_10px_red]'}`} />
          <div className="flex-1">
            <h2 className="text-lg font-bold text-white">{ws?.connected ? 'Servidor Online' : 'Servidor Offline'}</h2>
            <p className="text-sm text-zinc-400">{ws?.status?.totalCaptured || 0} velas capturadas</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* Feed - Monitoramento ao Vivo */}
        <div className="glass-card p-4 space-y-3 border border-white/10 bg-white/5 rounded-xl flex flex-col h-[500px]">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">Monitoramento ao vivo</h3>
          <div className="flex-1 overflow-y-auto pr-2 custom-scroll space-y-2">
            <AnimatePresence initial={false}>
              {recentCandles.map((c, i) => (
                <motion.div
                  key={c.id || i}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  className={`flex items-center gap-4 p-3 rounded-lg ${i === 0 ? 'bg-white/10 ring-1 ring-white/10' : 'bg-white/5'}`}
                >
                  <span className="text-xl font-bold font-mono" style={{ color: COLORS[c.cor as keyof typeof COLORS] }}>
                    {Number(c.multiplicador).toFixed(2)}x
                  </span>
                  <Badge variant="outline" className="capitalize" style={{ color: COLORS[c.cor as keyof typeof COLORS], borderColor: COLORS[c.cor as keyof typeof COLORS] }}>
                    {corParaLabel(c.cor)}
                  </Badge>
                  <span className="text-[10px] text-zinc-500 ml-auto uppercase font-medium">
                    {isValid(new Date(c.created_at)) ? formatDistanceToNow(new Date(c.created_at), { addSuffix: true, locale: ptBR }) : 'Agora'}
                  </span>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>

        {/* Gráfico - Escala Corrigida (Logarítmica) */}
        <div className="glass-card p-4 border border-white/10 bg-white/5 rounded-xl flex flex-col h-[500px]">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-500 mb-6">Volatilidade Recente</h3>
          <div className="flex-1 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={barData} margin={{ top: 10, right: 50, left: -15, bottom: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.03)" vertical={false} />
                <XAxis dataKey="index" hide />
                
                {/* O SEGREDO ESTÁ AQUI: scale="log" faz o 2x subir e as velas baixas crescerem */}
                <YAxis
                  scale="log"
                  domain={[1, 100]}
                  base={10}
                  stroke="rgba(255,255,255,0.2)"
                  fontSize={11}
                  tickFormatter={v => `${v}x`}
                  ticks={[1, 2, 5, 10, 20, 50, 100]}
                  allowDataOverflow={true}
                />

                <Tooltip
                  cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                  content={({ active, payload }) => active && payload?.[0] && (
                    <div className="bg-zinc-950 border border-white/20 p-2 rounded shadow-2xl text-xs font-mono text-white">
                      {Number(payload[0].value).toFixed(2)}x
                    </div>
                  )}
                />

                {REFERENCE_LINES.map(r => (
                  <ReferenceLine
                    key={r.y}
                    y={r.y}
                    stroke={r.stroke}
                    strokeDasharray="5 5"
                    strokeWidth={1}
                    label={{
                      value: r.label,
                      position: 'right',
                      fill: r.stroke,
                      fontSize: 12,
                      fontWeight: 'bold',
                      offset: 15
                    }}
                  />
                ))}

                <Bar dataKey="mult" radius={[4, 4, 0, 0]} maxBarSize={30}>
                  {barData.map((entry, index) => (
                    <Cell 
                      key={`cell-${index}`} 
                      fill={COLORS[entry.cor as keyof typeof COLORS] || COLORS.blue} 
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

      </div>
    </div>
  )
}