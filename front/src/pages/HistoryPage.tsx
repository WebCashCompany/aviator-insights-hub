import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { useWS } from '@/contexts/WebSocketContext'
import { useCandles } from '@/hooks/useCandles'
import { Candle } from '@/types'
import { calcularStats, detectarPadroes, corParaLabel } from '@/utils/candleUtils'

const INITIAL_LOAD = 60
const LOAD_MORE    = 60
const DB_POLL_INTERVAL_MS = 8_000   // fallback polling caso o WS perca eventos

function formatHora(ts: string): string {
  return new Date(ts).toLocaleTimeString('pt-BR', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

type Filtro    = 'all' | 'blue' | 'purple' | 'pink'
type Ordenacao = 'recent' | 'asc' | 'desc'
type TabView   = 'grade' | 'lista'
type Limite    = number

// ─── Chaves de deduplicação ───────────────────────────────────────────────────

function candleKey(c: Candle): string {
  const rid = (c as any).rodada_id as string | undefined | null
  if (rid) return `rid_${rid}`
  // Fallback consistente: usa só o id do banco — mesma lógica do dbKey
  return `db_${c.id}`
}

/**
 * BUG CORRIGIDO: `hist_*` são velas do scrape inicial (já persistidas no banco,
 * chegam via WS apenas como eco do HISTORY). Devem ser ignoradas no merge WS→UI
 * para evitar duplicatas.
 *
 * `dom_*` são detecções em tempo real do DOM polling (fallback quando o WS do jogo
 * silencia). Devem aparecer imediatamente — NÃO devem ser filtradas aqui.
 */
function isScrapedHistory(rid: string | undefined | null): boolean {
  return !!rid && rid.startsWith('hist_')
}

// ─── VelaCard ─────────────────────────────────────────────────────────────────
function VelaCard({ candle, isNew }: { candle: Candle; isNew: boolean }) {
  const ts = ((candle as any).timestamp || candle.created_at) as string
  const bgMap: Record<Candle['cor'], string> = {
    blue:   'bg-blue-500/10   border-blue-500/25   hover:border-blue-400/60',
    purple: 'bg-purple-500/10 border-purple-500/25 hover:border-purple-400/60',
    pink:   'bg-pink-500/10   border-pink-500/25   hover:border-pink-400/60',
  }
  const dotMap: Record<Candle['cor'], string> = {
    blue: 'bg-blue-400', purple: 'bg-purple-400', pink: 'bg-pink-400',
  }
  const textMap: Record<Candle['cor'], string> = {
    blue: 'text-blue-400', purple: 'text-purple-400', pink: 'text-pink-400',
  }
  return (
    <div
      title={formatHora(ts)}
      className={`
        rounded-xl border px-1.5 py-2 flex flex-col items-center gap-1
        transition-transform duration-100 hover:scale-105 cursor-default select-none
        ${bgMap[candle.cor]}
        ${isNew ? 'animate-[popIn_0.3s_ease]' : ''}
      `}
    >
      <div className={`w-1.5 h-1.5 rounded-full ${dotMap[candle.cor]}`} />
      <span className={`text-[11px] font-medium leading-none ${textMap[candle.cor]}`}>
        {candle.multiplicador.toFixed(2)}x
      </span>
      <span className="text-[9px] text-muted-foreground leading-none">{formatHora(ts)}</span>
    </div>
  )
}

// ─── CorBadge ─────────────────────────────────────────────────────────────────
function CorBadge({ cor }: { cor: Candle['cor'] }) {
  const map: Record<Candle['cor'], string> = {
    blue:   'bg-blue-500/10   text-blue-400   border-blue-500/30',
    purple: 'bg-purple-500/10 text-purple-400 border-purple-500/30',
    pink:   'bg-pink-500/10   text-pink-400   border-pink-500/30',
  }
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium border ${map[cor]}`}>
      {corParaLabel(cor)}
    </span>
  )
}

// ─── HistoryPage ──────────────────────────────────────────────────────────────
export default function HistoryPage() {
  const { candles: wsCandles } = useWS()
  const [limite, setLimite]    = useState<Limite>(100)

  // BUG CORRIGIDO: expõe `refetch` para polling periódico como fallback.
  // Se o WS perder um evento NEW_CANDLE, o polling garante que a vela apareça
  // em até DB_POLL_INTERVAL_MS ms sem necessidade de recarregar a página.
  const { candles: dbCandles, loading, refetch } = useCandles({ limit: 5000 })

  // ── Polling periódico do banco (fallback para eventos WS perdidos) ─────────
  useEffect(() => {
    if (typeof refetch !== 'function') return
    const id = setInterval(() => refetch(), DB_POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [refetch])

  // ── Rastreia chaves já vistas para detectar novidades e animar ────────────
  const seenKeys = useRef<Set<string>>(new Set())
  const [novosIds, setNovosIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!wsCandles.length) return
    const novos: string[] = []
    for (const c of wsCandles) {
      const rid = (c as any).rodada_id as string | undefined | null
      // Velas do scrape inicial não animam — chegaram no passado
      if (isScrapedHistory(rid)) continue
      const k = candleKey(c)
      if (!seenKeys.current.has(k)) {
        seenKeys.current.add(k)
        novos.push(k)
      }
    }
    if (novos.length > 0) {
      setNovosIds(new Set(novos))
      const t = setTimeout(() => setNovosIds(new Set()), 500)
      return () => clearTimeout(t)
    }
  }, [wsCandles])

  // ── Merge DB + WS sem duplicatas ──────────────────────────────────────────
  //
  // Estratégia:
  //   1. DB é a fonte de verdade para histórico persistido.
  //   2. WS complementa com velas ao vivo que ainda não chegaram ao banco
  //      (janela de ~1–3 s entre emissão e persistência).
  //
  // BUG CORRIGIDO: chave unificada `rid_*` / `db_*` tanto para DB quanto para
  // WS — antes, candles sem rodada_id usavam chaves divergentes (fallback_* vs
  // db_*), causando duplicatas ou velas sumindo do merge.
  //
  // BUG CORRIGIDO: `dom_*` candles (DOM polling em tempo real) NÃO são mais
  // filtradas — apenas `hist_*` (scrape inicial) são ignoradas.
  const candles = useMemo<Candle[]>(() => {
    const map = new Map<string, Candle>()

    // 1. Banco primeiro
    for (const c of dbCandles) {
      map.set(candleKey(c as Candle), c as Candle)
    }

    // 2. WS: adiciona apenas o que ainda não está no banco
    for (const c of wsCandles) {
      const rid = (c as any).rodada_id as string | undefined | null
      // Apenas scrape inicial é ignorado — dom_* e ws_* são eventos ao vivo
      if (isScrapedHistory(rid)) continue
      const k = candleKey(c)
      if (!map.has(k)) map.set(k, c)
    }

    return Array.from(map.values())
      .sort((a, b) => {
        const ta = new Date((((a as any).timestamp || a.created_at) as string)).getTime()
        const tb = new Date((((b as any).timestamp || b.created_at) as string)).getTime()
        return tb - ta
      })
      .slice(0, limite)
  }, [dbCandles, wsCandles, limite])

  const [filtro, setFiltro]       = useState<Filtro>('all')
  const [busca, setBusca]         = useState('')
  const [ordenacao, setOrdenacao] = useState<Ordenacao>('recent')
  const [tab, setTab]             = useState<TabView>('grade')
  const [visivel, setVisivel]     = useState(INITIAL_LOAD)

  const loaderRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setVisivel(INITIAL_LOAD) }, [filtro, busca, ordenacao, limite])

  const filtered = useMemo<Candle[]>(() => {
    let r = [...candles]
    if (filtro !== 'all') r = r.filter(c => c.cor === filtro)
    if (busca) {
      const minVal = parseFloat(busca)
      if (!isNaN(minVal)) r = r.filter(c => c.multiplicador >= minVal)
    }
    if (ordenacao === 'asc')  r.sort((a, b) => a.multiplicador - b.multiplicador)
    if (ordenacao === 'desc') r.sort((a, b) => b.multiplicador - a.multiplicador)
    return r
  }, [candles, filtro, busca, ordenacao])

  const visivelSlice = filtered.slice(0, visivel)

  const onIntersect = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      if (entries[0].isIntersecting && visivel < filtered.length)
        setVisivel(v => Math.min(v + LOAD_MORE, filtered.length))
    },
    [visivel, filtered.length]
  )

  useEffect(() => {
    const el = loaderRef.current
    if (!el) return
    const obs = new IntersectionObserver(onIntersect, { threshold: 0.1 })
    obs.observe(el)
    return () => obs.disconnect()
  }, [onIntersect])

  const candlesAsc = useMemo(() => [...candles].reverse(), [candles])
  const stats      = useMemo(() => (candlesAsc.length ? calcularStats(candlesAsc) : null), [candlesAsc])
  const padroes    = useMemo(() => detectarPadroes(candlesAsc), [candlesAsc])

  const bluePct   = stats ? +((stats.blue.count   / stats.total) * 100).toFixed(1) : 0
  const purplePct = stats ? +((stats.purple.count / stats.total) * 100).toFixed(1) : 0
  const pinkPct   = stats ? +((stats.pink.count   / stats.total) * 100).toFixed(1) : 0

  const streakColor: Record<string, string> = {
    blue: 'text-blue-400', purple: 'text-purple-400', pink: 'text-pink-400',
  }

  if (loading && !candles.length) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-3 text-muted-foreground">
        <p className="text-sm animate-pulse">Carregando histórico...</p>
        <p className="text-xs opacity-60">Buscando velas do banco de dados</p>
      </div>
    )
  }

  if (!candles.length) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-3 text-muted-foreground">
        <p className="text-sm">Aguardando velas do servidor...</p>
        <p className="text-xs opacity-60">O histórico aparecerá aqui assim que as primeiras velas chegarem</p>
      </div>
    )
  }

  return (
    <div className="space-y-4 pb-6">

      {/* ── Filtro de Quantidade ── */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-xs text-muted-foreground mr-1">Últimas:</span>
        {[50, 100, 200, 500, 1000].map(n => (
          <button
            key={n}
            onClick={() => setLimite(n)}
            className={`px-3 py-1 rounded-lg text-xs font-medium border transition-all ${
              limite === n
                ? 'bg-foreground text-background border-foreground'
                : 'bg-muted/40 text-muted-foreground border-transparent hover:bg-card hover:text-foreground'
            }`}
          >
            {n}
          </button>
        ))}
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={4}
          value={![50, 100, 200, 500, 1000].includes(limite) ? String(limite) : ''}
          onChange={e => {
            const raw = e.target.value.replace(/[^0-9]/g, '')
            if (raw === '') { setLimite(100); return }
            const v = Math.min(1000, Math.max(1, parseInt(raw)))
            setLimite(v)
          }}
          onBlur={e => { if (e.target.value === '') setLimite(100) }}
          placeholder="outro"
          className={`w-14 px-2 py-1 rounded-lg text-xs border bg-muted/40 placeholder:text-muted-foreground/50 focus:outline-none transition-all appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${
            ![50, 100, 200, 500, 1000].includes(limite)
              ? 'border-foreground text-foreground bg-card'
              : 'border-transparent text-muted-foreground hover:border-border'
          }`}
        />
        <span className="text-xs text-muted-foreground ml-auto">{candles.length} velas no total</span>
      </div>

      {/* ── Cards de Resumo ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="bg-card rounded-lg p-3 border border-border">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">Total</p>
          <p className="text-xl font-medium">{stats?.total ?? 0}</p>
          <p className="text-xs text-muted-foreground">velas</p>
        </div>
        <div className="bg-card rounded-lg p-3 border border-border">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">Maior</p>
          <p className="text-xl font-medium text-pink-400">{Number(stats?.maior ?? 0).toFixed(2)}x</p>
        </div>
        <div className="bg-card rounded-lg p-3 border border-border">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">Média</p>
          <p className="text-xl font-medium">{Number(stats?.media ?? 0).toFixed(2)}x</p>
        </div>
        <div className="bg-card rounded-lg p-3 border border-border">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">Streak atual</p>
          <p className={`text-xl font-medium ${streakColor[stats?.streakAtual.cor ?? 'blue']}`}>
            {stats?.streakAtual.count}x
          </p>
          <p className="text-xs text-muted-foreground">{corParaLabel(stats?.streakAtual.cor ?? 'blue')}</p>
        </div>
      </div>

      {/* ── Distribuição ── */}
      <div className="bg-card rounded-lg p-3 border border-border space-y-2">
        <div className="flex gap-0.5 h-2 rounded-full overflow-hidden w-full">
          <div className="bg-blue-400   h-full transition-all duration-500" style={{ width: `${bluePct}%`   }} />
          <div className="bg-purple-400 h-full transition-all duration-500" style={{ width: `${purplePct}%` }} />
          <div className="bg-pink-400   h-full transition-all duration-500" style={{ width: `${pinkPct}%`   }} />
        </div>
        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-blue-400" />
            <span className="text-blue-400 font-medium">{bluePct}%</span>
            <span>Azul ({stats?.blue.count})</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-purple-400" />
            <span className="text-purple-400 font-medium">{purplePct}%</span>
            <span>Roxa ({stats?.purple.count})</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-pink-400" />
            <span className="text-pink-400 font-medium">{pinkPct}%</span>
            <span>Rosa ({stats?.pink.count})</span>
          </div>
        </div>
      </div>

      {/* ── Streaks ── */}
      <div className="flex flex-wrap gap-2">
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-blue-500/25 bg-blue-500/10">
          <span className="text-muted-foreground text-xs">Maior streak azul</span>
          <span className="text-blue-400 font-medium text-base">{stats?.maiorStreakAzul}</span>
        </div>
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-purple-500/25 bg-purple-500/10">
          <span className="text-muted-foreground text-xs">Maior streak roxa</span>
          <span className="text-purple-400 font-medium text-base">{stats?.maiorStreakRoxa}</span>
        </div>
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-pink-500/25 bg-pink-500/10">
          <span className="text-muted-foreground text-xs">Intervalo médio rosa</span>
          <span className="text-pink-400 font-medium text-base">{stats?.intervalMedioRosa}</span>
        </div>
      </div>

      {/* ── Padrões ── */}
      {padroes.length > 0 && (
        <div className="space-y-1.5">
          {padroes.map((p, i) => (
            <div
              key={i}
              className={`text-xs px-3 py-2 rounded-lg border-l-2 ${
                p.startsWith('🚨')
                  ? 'border-l-pink-400 bg-pink-500/10 text-foreground'
                  : 'border-l-border bg-card text-muted-foreground'
              }`}
            >
              {p}
            </div>
          ))}
        </div>
      )}

      {/* ── Tabs ── */}
      <div className="border-b border-border flex gap-0">
        {(['grade', 'lista'] as TabView[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
              tab === t
                ? 'text-foreground border-foreground'
                : 'text-muted-foreground border-transparent hover:text-foreground'
            }`}
          >
            {t === 'grade' ? 'Grade Visual' : 'Lista Detalhada'}
          </button>
        ))}
      </div>

      {/* ── Toolbar ── */}
      <div className="flex flex-wrap gap-2 items-center justify-between">
        <div className="flex flex-wrap gap-1.5 items-center">
          {(['all', 'blue', 'purple', 'pink'] as Filtro[]).map(f => {
            const isActive = filtro === f
            const base = 'px-3 py-1 rounded-lg text-xs font-medium border transition-all'
            const colorClass = isActive
              ? f === 'blue'   ? 'bg-blue-500/15   text-blue-400   border-blue-500/40'
              : f === 'purple' ? 'bg-purple-500/15 text-purple-400 border-purple-500/40'
              : f === 'pink'   ? 'bg-pink-500/15   text-pink-400   border-pink-500/40'
              :                  'bg-card text-foreground border-border'
              : 'bg-muted/40 text-muted-foreground border-transparent hover:bg-card hover:text-foreground'
            return (
              <button key={f} onClick={() => setFiltro(f)} className={`${base} ${colorClass}`}>
                {f === 'all' ? 'Todas' : corParaLabel(f)}
              </button>
            )
          })}
          <input
            type="number"
            placeholder="mín. mult."
            value={busca}
            onChange={e => setBusca(e.target.value)}
            min={1}
            step={0.01}
            className="w-24 px-2 py-1 rounded-lg text-xs border border-border bg-muted/50 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{filtered.length} velas</span>
          <select
            value={ordenacao}
            onChange={e => setOrdenacao(e.target.value as Ordenacao)}
            className="px-2 py-1 rounded-lg text-xs border border-border bg-card text-muted-foreground cursor-pointer focus:outline-none"
          >
            <option value="recent">Recentes</option>
            <option value="asc">Menor → Maior</option>
            <option value="desc">Maior → Menor</option>
          </select>
        </div>
      </div>

      {/* ── Grade Visual ── */}
      {tab === 'grade' && (
        <>
          {visivelSlice.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground text-sm">
              Nenhuma vela encontrada com os filtros selecionados.
            </div>
          ) : (
            <div
              className="grid gap-1.5"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(64px, 1fr))' }}
            >
              {visivelSlice.map(candle => {
                const key = candleKey(candle)
                return (
                  <VelaCard
                    key={key}
                    candle={candle}
                    isNew={novosIds.has(key)}
                  />
                )
              })}
            </div>
          )}
          {visivel < filtered.length && (
            <div ref={loaderRef} className="flex justify-center py-4">
              <span className="text-xs text-muted-foreground animate-pulse">
                Carregando mais velas... ({visivel}/{filtered.length})
              </span>
            </div>
          )}
        </>
      )}

      {/* ── Lista Detalhada ── */}
      {tab === 'lista' && (
        <>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-3 py-2 text-muted-foreground font-medium uppercase tracking-wider text-[10px]">Horário</th>
                  <th className="text-left px-3 py-2 text-muted-foreground font-medium uppercase tracking-wider text-[10px]">Multiplicador</th>
                  <th className="text-left px-3 py-2 text-muted-foreground font-medium uppercase tracking-wider text-[10px]">Cor</th>
                </tr>
              </thead>
              <tbody>
                {visivelSlice.map(candle => {
                  const ts  = ((candle as any).timestamp || candle.created_at) as string
                  const key = candleKey(candle)
                  const multColor: Record<Candle['cor'], string> = {
                    blue: 'text-blue-400', purple: 'text-purple-400', pink: 'text-pink-400',
                  }
                  return (
                    <tr
                      key={key}
                      className={`border-b border-border/50 last:border-none hover:bg-muted/30 transition-colors ${
                        novosIds.has(key) ? 'animate-[popIn_0.3s_ease]' : ''
                      }`}
                    >
                      <td className="px-3 py-2 text-muted-foreground font-mono">{formatHora(ts)}</td>
                      <td className={`px-3 py-2 font-medium ${multColor[candle.cor]}`}>
                        {candle.multiplicador.toFixed(2)}x
                      </td>
                      <td className="px-3 py-2"><CorBadge cor={candle.cor} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {visivel < filtered.length && (
            <div ref={loaderRef} className="flex justify-center py-4">
              <span className="text-xs text-muted-foreground animate-pulse">
                Carregando mais... ({visivel}/{filtered.length})
              </span>
            </div>
          )}
        </>
      )}
    </div>
  )
}