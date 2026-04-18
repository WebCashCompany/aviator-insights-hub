import { useState, useMemo, useEffect, useRef } from 'react'
import { useCandles } from '@/hooks/useCandles'
import { useWS } from '@/contexts/WebSocketContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import {
  Activity, ShieldAlert, CheckCircle2, AlertTriangle, RefreshCw,
} from 'lucide-react'
import { SimulationResult, Strategy } from '@/types'

// ── Paleta (só o necessário para o sinal) ─────────────────────────────────────
const C = {
  purple: 'hsl(263,70%,58%)',
  green:  'hsl(142,71%,45%)',
  amber:  'hsl(38,92%,50%)',
  red:    'hsl(0,72%,55%)',
  blue:   'hsl(217,91%,60%)',
  axis:   'rgba(255,255,255,0.25)',
}

// ── Helpers para o sinal ──────────────────────────────────────────────────────
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

// ── MultInput ─────────────────────────────────────────────────────────────────
function MultInput({ onConfirm }: { onConfirm: (v: number) => void }) {
  const [val, setVal] = useState('')
  return (
    <div className="flex items-center gap-1">
      <input
        type="number" placeholder="outro" step="0.01" min="0"
        value={val} onChange={e => setVal(e.target.value)}
        className="w-16 text-xs bg-white/8 border border-white/15 rounded-lg px-2 py-1.5 text-white text-center"
      />
      <button
        onClick={() => { if (val) { onConfirm(parseFloat(val)); setVal('') } }}
        className="px-2 py-1.5 rounded-lg text-xs border border-white/20 text-white/60 hover:bg-white/5 transition-colors">
        OK
      </button>
    </div>
  )
}

// ── MartingaleFlow ────────────────────────────────────────────────────────────
type MGState = 'idle' | 'waiting_result' | 'martingale_1' | 'martingale_2' | 'done_win' | 'done_loss'

function MartingaleFlow({ ativo, onReset }: { ativo: boolean; onReset: () => void }) {
  const [mgState, setMgState] = useState<MGState>('idle')
  const [entrada, setEntrada] = useState(1)
  const [multPago, setMultPago] = useState(0)
  const [historico, setHistorico] = useState<{ rodada: number; aposta: number; mult: number; ganhou: boolean }[]>([])

  useEffect(() => {
    if (ativo && mgState === 'idle') setMgState('waiting_result')
    if (!ativo) { setMgState('idle'); setHistorico([]) }
  }, [ativo])

  const apostaAtual = mgState === 'waiting_result' ? entrada
    : mgState === 'martingale_1' ? entrada * 2
    : entrada * 4

  const perdaAcum = mgState === 'martingale_1' ? entrada
    : mgState === 'martingale_2' ? entrada + entrada * 2
    : mgState === 'done_loss' ? entrada + entrada * 2 + entrada * 4 : 0

  function handleResult(mult: number) {
    const ganhou = mult >= 2
    const rodada = mgState === 'waiting_result' ? 1 : mgState === 'martingale_1' ? 2 : 3
    setHistorico(h => [...h, { rodada, aposta: apostaAtual, mult, ganhou }])
    setMultPago(mult)
    if (ganhou) {
      setMgState('done_win')
    } else {
      if (mgState === 'waiting_result')    setMgState('martingale_1')
      else if (mgState === 'martingale_1') setMgState('martingale_2')
      else                                 setMgState('done_loss')
    }
  }

  function handleNovaEntrada() {
    setMgState('waiting_result')
    setHistorico([])
    setMultPago(0)
  }

  if (!ativo) return null

  const rodadaLabel: Partial<Record<MGState, string>> = {
    waiting_result: 'Entrada 1 — apostar agora',
    martingale_1:   'Martingale 1 — dobrar aposta',
    martingale_2:   'Martingale 2 — última tentativa',
  }

  const isPlaying = mgState === 'waiting_result' || mgState === 'martingale_1' || mgState === 'martingale_2'
  const multBtns = [1.2, 1.5, 1.8, 2.5, 3.0, 5.0]

  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-white/4 p-3 space-y-3">

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-white/40">Valor base R$:</span>
        <input
          type="number" min={1} step={1} value={entrada}
          onChange={e => setEntrada(Math.max(1, Number(e.target.value)))}
          disabled={mgState !== 'waiting_result' || historico.length > 0}
          className="w-20 text-xs bg-white/8 border border-white/15 rounded-lg px-2 py-1 text-white text-center disabled:opacity-40"
        />
        {perdaAcum > 0 && (
          <span className="ml-auto text-[11px]" style={{ color: C.red }}>
            Perda acum: <strong>R$ {perdaAcum}</strong>
          </span>
        )}
      </div>

      {historico.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {historico.map((h, i) => (
            <div key={i} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs"
              style={{
                background: h.ganhou ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                border: `1px solid ${h.ganhou ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
              }}>
              <span className="text-white/40">R{h.rodada}</span>
              <span className="font-mono text-white/80">R${h.aposta}</span>
              <span style={{ color: h.ganhou ? C.green : C.red }}>{h.mult.toFixed(2)}x</span>
              <span>{h.ganhou ? '✓' : '✗'}</span>
            </div>
          ))}
        </div>
      )}

      {isPlaying && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className="text-[10px] text-white/40 uppercase tracking-wider mb-0.5">
                {rodadaLabel[mgState]}
              </p>
              <p className="text-sm font-bold text-white">
                Apostar:{' '}
                <span style={{ color: mgState === 'waiting_result' ? C.green : C.amber }}>
                  R$ {apostaAtual}
                </span>
              </p>
            </div>
          </div>
          <p className="text-[11px] text-white/35 mb-2.5">
            {mgState === 'waiting_result' && 'Entre na próxima vela. Qual multiplicador saiu?'}
            {mgState === 'martingale_1'   && 'Vela pagou abaixo de 2x. Dobre e tente de novo. Qual multiplicador saiu?'}
            {mgState === 'martingale_2'   && 'Segunda loss. Última tentativa com 4x. Qual multiplicador saiu?'}
          </p>
          <div className="flex flex-wrap gap-2">
            {multBtns.map(v => (
              <button key={v} onClick={() => handleResult(v)}
                className="px-3 py-1.5 rounded-lg text-xs font-mono border transition-all active:scale-95"
                style={{
                  border:     `1px solid ${v >= 2 ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.3)'}`,
                  background: v >= 2 ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
                  color:      v >= 2 ? C.green : C.red,
                }}>
                {v}x
              </button>
            ))}
            <MultInput onConfirm={handleResult} />
          </div>
        </div>
      )}

      {mgState === 'done_win' && (
        <div className="rounded-xl p-3 flex items-center gap-3"
          style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)' }}>
          <CheckCircle2 className="h-6 w-6 shrink-0" style={{ color: C.green }} />
          <div className="flex-1">
            <p className="text-sm font-bold" style={{ color: C.green }}>
              Ganhou na rodada {historico.length}!
            </p>
            <p className="text-[11px] text-white/50">
              Saiu {multPago.toFixed(2)}x · Apostado R$ {apostaAtual}
              {historico.length > 1 && ` · Recuperou R$ ${perdaAcum} de perda`}
            </p>
          </div>
          <button onClick={handleNovaEntrada}
            className="shrink-0 px-3 py-1.5 rounded-lg text-xs border border-white/15 text-white/60 flex items-center gap-1 hover:bg-white/5 transition-colors">
            <RefreshCw className="h-3 w-3" /> Nova
          </button>
        </div>
      )}

      {mgState === 'done_loss' && (
        <div className="rounded-xl p-3 flex items-center gap-3"
          style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)' }}>
          <AlertTriangle className="h-6 w-6 shrink-0" style={{ color: C.red }} />
          <div className="flex-1">
            <p className="text-sm font-bold" style={{ color: C.red }}>Stop — 3 tentativas perdidas</p>
            <p className="text-[11px] text-white/50">
              Perda total: R$ {entrada + entrada * 2 + entrada * 4} · Aguarde novo sinal
            </p>
          </div>
          <button onClick={() => { setMgState('idle'); setHistorico([]); onReset() }}
            className="shrink-0 px-3 py-1.5 rounded-lg text-xs border border-white/15 text-white/60 flex items-center gap-1 hover:bg-white/5 transition-colors">
            <RefreshCw className="h-3 w-3" /> Resetar
          </button>
        </div>
      )}
    </div>
  )
}

// ── Estratégias padrão ────────────────────────────────────────────────────────
const DEFAULT_STRATEGIES: Strategy[] = [
  { id: 's1', name: 'Martingale Azul', description: 'Entrar após 3+ azuis consecutivas esperando roxa', rules: { tipo: 'martingale', threshold: 3, target: 'purple' } },
  { id: 's2', name: 'Pós-Rosa Conservador', description: 'Entrar em 1.5x nas 2 rodadas após sair rosa', rules: { tipo: 'pos-rosa', mult: 1.5, rodadas: 2 } },
  { id: 's3', name: 'Double Purple', description: 'Após roxa, apostar esperando outra roxa', rules: { tipo: 'double', target: 'purple' } },
  { id: 's4', name: 'Safe 1.5x', description: 'Sempre sair em 1.5x independente da vela', rules: { tipo: 'safe', mult: 1.5 } },
  { id: 's5', name: 'Fibonacci Recovery', description: 'Seguir sequência Fibonacci após perdas', rules: { tipo: 'fibonacci' } },
  { id: 's6', name: 'Anti-Streak', description: 'Entrar quando streak de azuis > média histórica', rules: { tipo: 'anti-streak' } },
]

// ── Página Principal ──────────────────────────────────────────────────────────
export default function StrategiesPage() {
  const ws = useWS()
  const { candles } = useCandles({ limit: 1000 })
  const [mgAtivo, setMgAtivo] = useState(false)
  const prevSinalRef = useRef<string | null>(null)

  const [selectedStrategy, setSelectedStrategy] = useState<Strategy | null>(null)
  const [simOpen, setSimOpen] = useState(false)
  const [bancaInicial, setBancaInicial] = useState('100')
  const [valorEntrada, setValorEntrada] = useState('5')
  const [stopLoss, setStopLoss] = useState('50')
  const [stopGain, setStopGain] = useState('200')
  const [simResult, setSimResult] = useState<SimulationResult | null>(null)

  // ── Estado atual / sinal ──────────────────────────────────────────────────
  const estadoAtual = useMemo(() => {
    if (candles.length < 10) return null
    const ultimas = candles.slice(-10)
    const media   = ultimas.reduce((s: number, c: any) => s + Number(c.multiplicador), 0) / 10
    const pctAzul = ultimas.filter((c: any) => c.cor === 'blue').length / 10
    const rosaRec = candles.slice(-15).some((c: any) => c.cor === 'pink')
    const streakAtual = (() => {
      let s = 0
      for (let i = candles.length - 1; i >= 0; i--) {
        if (candles[i].cor === 'blue') s++; else break
      }
      return s
    })()
    const ultimaCor  = candles[candles.length - 1]?.cor
    const mercadoBom = media > 2 && rosaRec && pctAzul < 0.6
    return { media, pctAzul, rosaRec, streakAtual, ultimaCor, mercadoBom }
  }, [candles])

  const sinalAtual = useMemo(() => {
    if (!estadoAtual) return null
    const { ultimaCor, streakAtual, mercadoBom } = estadoAtual
    if (ultimaCor === 'purple') {
      if (streakAtual >= 4) return { tipo: 'bloqueado', msg: 'Roxa detectada, mas bloqueado: 4+ azuis antes', color: C.amber }
      if (!mercadoBom)      return { tipo: 'cautela',  msg: 'Roxa detectada, mas mercado não está bom',       color: C.amber }
      return                       { tipo: 'entrar',   msg: 'ENTRAR na próxima — roxa + mercado bom!',        color: C.green }
    }
    if (ultimaCor === 'blue') {
      if (streakAtual >= 4) return { tipo: 'bloqueado', msg: `Cuidado: ${streakAtual} azuis seguidas — aguardar`, color: C.amber }
      return                       { tipo: 'aguardar',  msg: 'Aguardando roxa disparar entrada',               color: C.axis  }
    }
    if (ultimaCor === 'pink') return { tipo: 'aguardar', msg: 'Rosa saiu — observar próximas velas', color: C.purple }
    return { tipo: 'aguardar', msg: 'Aguardando sinal...', color: C.axis }
  }, [estadoAtual])

  useEffect(() => {
    const tipo = sinalAtual?.tipo ?? null
    if (tipo === 'entrar' && prevSinalRef.current !== 'entrar') setMgAtivo(true)
    prevSinalRef.current = tipo
  }, [sinalAtual])

  // ── Simulação ─────────────────────────────────────────────────────────────
  const runSimulation = () => {
    if (!selectedStrategy || candles.length === 0) return
    const bInicial = parseFloat(bancaInicial)
    const vEntrada = parseFloat(valorEntrada)
    const sLoss = parseFloat(stopLoss)
    const sGain = parseFloat(stopGain)
    let banca = bInicial
    let wins = 0, losses = 0, skips = 0
    let maiorDrawdown = 0
    let maxBanca = bInicial
    const historico: number[] = [bInicial]
    const rules = selectedStrategy.rules

    for (const candle of candles) {
      if (banca <= sLoss || banca >= sGain) break
      let shouldEnter = false
      let targetMult = 2

      switch (rules.tipo) {
        case 'martingale': {
          const lastN = candles.slice(Math.max(0, candles.indexOf(candle) - 3), candles.indexOf(candle))
          shouldEnter = lastN.length >= 3 && lastN.every((c: any) => c.cor === 'blue')
          targetMult = 2
          break
        }
        case 'pos-rosa': {
          const idx = candles.indexOf(candle)
          if (idx >= 1 && candles[idx - 1].cor === 'pink') shouldEnter = true
          if (idx >= 2 && candles[idx - 2].cor === 'pink') shouldEnter = true
          targetMult = 1.5
          break
        }
        case 'safe':
          shouldEnter = true
          targetMult = 1.5
          break
        case 'double': {
          const idx = candles.indexOf(candle)
          shouldEnter = idx >= 1 && candles[idx - 1].cor === 'purple'
          targetMult = 2
          break
        }
        default:
          shouldEnter = Math.random() > 0.5
          targetMult = 1.5
      }

      if (!shouldEnter) { skips++; historico.push(banca); continue }

      if (candle.multiplicador >= targetMult) {
        banca += vEntrada * (targetMult - 1)
        wins++
      } else {
        banca -= vEntrada
        losses++
      }

      if (banca > maxBanca) maxBanca = banca
      const dd = maxBanca - banca
      if (dd > maiorDrawdown) maiorDrawdown = dd
      historico.push(banca)
    }

    setSimResult({
      totalRodadas: wins + losses + skips,
      wins, losses, skips,
      winRate: wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0,
      bancaInicial: bInicial,
      bancaFinal: banca,
      lucro: banca - bInicial,
      maiorDrawdown,
      historicoBanca: historico,
    })
  }

  return (
    <div className="space-y-6 pb-20 lg:pb-0">

      {/* Sinal atual + Martingale */}
      {sinalAtual && (
        <div className="rounded-2xl border p-3.5 flex flex-col"
          style={{ borderColor: sinalAtual.color + '55', background: sinalAtual.color + '11' }}>
          <div className="flex items-center gap-3">
            {sinalAtual.tipo === 'entrar'    && <CheckCircle2  className="h-6 w-6 shrink-0" style={{ color: C.green  }} />}
            {sinalAtual.tipo === 'bloqueado' && <ShieldAlert   className="h-6 w-6 shrink-0" style={{ color: C.amber  }} />}
            {sinalAtual.tipo === 'cautela'   && <AlertTriangle className="h-6 w-6 shrink-0" style={{ color: C.amber  }} />}
            {sinalAtual.tipo === 'aguardar'  && <Activity      className="h-6 w-6 shrink-0" style={{ color: C.purple }} />}
            <div className="flex-1 min-w-0">
              <p className="text-[10px] text-white/40 uppercase tracking-wider mb-0.5">Sinal agora</p>
              <p className="text-sm font-semibold text-white leading-tight">{sinalAtual.msg}</p>
            </div>
            {estadoAtual && (
              <div className="hidden sm:flex flex-col items-end gap-0.5 text-right text-[11px] text-white/40 shrink-0">
                <span>Média 10v: <strong className="text-white/70">{estadoAtual.media.toFixed(2)}x</strong></span>
                <span>Azuis: <strong className="text-white/70">{(estadoAtual.pctAzul * 100).toFixed(0)}%</strong></span>
                <span>Streak: <strong className="text-white/70">{estadoAtual.streakAtual}</strong></span>
              </div>
            )}
          </div>

          {sinalAtual.tipo === 'entrar' && mgAtivo && (
            <MartingaleFlow ativo={mgAtivo} onReset={() => setMgAtivo(false)} />
          )}
          {sinalAtual.tipo === 'entrar' && !mgAtivo && (
            <button onClick={() => setMgAtivo(true)}
              className="mt-2.5 self-start text-xs text-white/40 border border-white/10 rounded-xl px-3 py-2 flex items-center gap-1.5 hover:bg-white/5 transition-colors">
              <RefreshCw className="h-3 w-3" /> Acompanhar martingale
            </button>
          )}
        </div>
      )}

      {/* Cards de estratégias */}
      <h2 className="text-xl font-bold text-foreground">Estratégias</h2>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {DEFAULT_STRATEGIES.map(s => (
          <div key={s.id} className="glass-card p-5 space-y-3">
            <h3 className="font-semibold text-foreground">{s.name}</h3>
            <p className="text-sm text-muted-foreground">{s.description}</p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => { setSelectedStrategy(s); setSimOpen(true); setSimResult(null) }}>
                Simular agora
              </Button>
            </div>
          </div>
        ))}
      </div>

      {/* Sheet de simulação */}
      <Sheet open={simOpen} onOpenChange={setSimOpen}>
        <SheetContent className="w-full sm:max-w-xl bg-card border-border overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="text-foreground">Simular: {selectedStrategy?.name}</SheetTitle>
          </SheetHeader>

          <div className="space-y-4 mt-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground">Banca inicial (R$)</label>
                <Input value={bancaInicial} onChange={e => setBancaInicial(e.target.value)} type="number" className="bg-muted border-border" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Valor entrada (R$)</label>
                <Input value={valorEntrada} onChange={e => setValorEntrada(e.target.value)} type="number" className="bg-muted border-border" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Stop Loss (R$)</label>
                <Input value={stopLoss} onChange={e => setStopLoss(e.target.value)} type="number" className="bg-muted border-border" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Stop Gain (R$)</label>
                <Input value={stopGain} onChange={e => setStopGain(e.target.value)} type="number" className="bg-muted border-border" />
              </div>
            </div>

            <p className="text-xs text-muted-foreground">{candles.length} velas disponíveis para simulação</p>
            <Button onClick={runSimulation} className="w-full" disabled={candles.length === 0}>Rodar simulação</Button>

            {simResult && (
              <div className="space-y-4 fade-in">
                <div className="grid grid-cols-2 gap-3">
                  <div className="glass-card p-3">
                    <p className="text-xs text-muted-foreground">Win Rate</p>
                    <p className={`text-xl font-bold ${simResult.winRate >= 60 ? 'text-success' : simResult.winRate >= 40 ? 'text-warning' : 'text-destructive'}`}>
                      {simResult.winRate.toFixed(1)}%
                    </p>
                  </div>
                  <div className="glass-card p-3">
                    <p className="text-xs text-muted-foreground">Lucro</p>
                    <p className={`text-xl font-bold ${simResult.lucro >= 0 ? 'text-success' : 'text-destructive'}`}>
                      R$ {simResult.lucro.toFixed(2)}
                    </p>
                  </div>
                  <div className="glass-card p-3">
                    <p className="text-xs text-muted-foreground">Maior Drawdown</p>
                    <p className="text-xl font-bold text-destructive">R$ {simResult.maiorDrawdown.toFixed(2)}</p>
                  </div>
                  <div className="glass-card p-3">
                    <p className="text-xs text-muted-foreground">Rodadas</p>
                    <p className="text-xl font-bold text-foreground">{simResult.totalRodadas}</p>
                  </div>
                </div>

                <div className="glass-card p-4">
                  <h4 className="text-sm font-medium text-foreground mb-2">Evolução da banca</h4>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={simResult.historicoBanca.map((v, i) => ({ i, v }))}>
                      <XAxis dataKey="i" hide />
                      <YAxis stroke="hsl(220,10%,30%)" fontSize={10} />
                      <Tooltip
                        contentStyle={{ background: 'hsl(240,15%,8%)', border: '1px solid hsl(240,10%,18%)', borderRadius: 8, color: '#fff' }}
                        formatter={(v: number) => [`R$ ${v.toFixed(2)}`, 'Banca']}
                      />
                      <Line type="monotone" dataKey="v" stroke="hsl(217,91%,60%)" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}