import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'
import { Candle, ServerStatus } from '@/types'

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface WebSocketContextType {
  candles: Candle[]
  status: ServerStatus
  connected: boolean
  lastCandle: Candle | null
  reconnect: () => void
}

const DEFAULT_STATUS: ServerStatus = {
  connected: false,
  loggedIn: false,
  gameOpen: false,
  totalCaptured: 0,
  lastCandle: null,
  uptime: 0,
  lastError: null,
}

// ─── Contexto ─────────────────────────────────────────────────────────────────

export const WebSocketContext = createContext<WebSocketContextType>({
  candles: [],
  status: DEFAULT_STATUS,
  connected: false,
  lastCandle: null,
  reconnect: () => {},
})

export function useWS() {
  return useContext(WebSocketContext)
}

// ─── Provider ─────────────────────────────────────────────────────────────────

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3001'
const MAX_CANDLES_IN_MEMORY = 1000
const RECONNECT_DELAY_MS    = 3_000

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  // Buffer interno persistente: Map chave → Candle.
  // Nunca é zerado em reconexão automática — preserva histórico entre drops de conexão.
  const candleMapRef = useRef<Map<string, Candle>>(new Map())

  const [candles, setCandles]     = useState<Candle[]>([])
  const [status, setStatus]       = useState<ServerStatus>(DEFAULT_STATUS)
  const [connected, setConnected] = useState(false)
  const [lastCandle, setLastCandle] = useState<Candle | null>(null)

  const wsRef           = useRef<WebSocket | null>(null)
  const reconnectTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isMounted       = useRef(true)

  /**
   * BUG CORRIGIDO: chave unificada.
   *
   * Antes, candles sem rodada_id geravam `fallback_<ts>_<id>` aqui, mas
   * `db_<id>` no HistoryPage — causando duplicatas no merge e velas fantasmas
   * que "desapareciam" quando o banco respondia.
   *
   * Agora: se tem rodada_id → `rid_<rodada_id>` (mesmo para dom_* e ws_*).
   *        se não tem       → `db_<id>` (consistente com o lado do banco).
   */
  function candleKey(c: Candle): string {
    const rid = (c as any).rodada_id as string | undefined | null
    if (rid) return `rid_${rid}`
    return `db_${c.id}`
  }

  // Reconstrói array ordenado (mais recente primeiro) a partir do Map interno.
  // Sempre cria um novo array — garante que React detecte a mudança de referência.
  function flushMap(): Candle[] {
    const arr = Array.from(candleMapRef.current.values())
      .sort((a, b) => {
        const ta = new Date(((a as any).timestamp || a.created_at) as string).getTime()
        const tb = new Date(((b as any).timestamp || b.created_at) as string).getTime()
        return tb - ta
      })
      .slice(0, MAX_CANDLES_IN_MEMORY)
    setCandles([...arr])   // spread extra garante nova referência mesmo se conteúdo idêntico
    return arr
  }

  const connect = useCallback(() => {
    if (
      wsRef.current?.readyState === WebSocket.OPEN ||
      wsRef.current?.readyState === WebSocket.CONNECTING
    ) return

    const url = WS_URL.includes('ngrok')
      ? `${WS_URL}?ngrok-skip-browser-warning=true`
      : WS_URL

    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      if (!isMounted.current) return
      setConnected(true)
      setStatus(prev => ({ ...prev, connected: true }))
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
    }

    ws.onmessage = (event) => {
      if (!isMounted.current) return
      try {
        const msg = JSON.parse(event.data)

        switch (msg.type) {
          case 'HISTORY': {
            // Histórico inicial: popula o Map com todas as velas recebidas.
            // Não limpa o Map — pode ter chegado um NEW_CANDLE antes do HISTORY
            // em caso de reconexão rápida.
            const history: Candle[] = Array.isArray(msg.data) ? msg.data : []
            let changed = false
            for (const c of history) {
              const k = candleKey(c)
              if (!candleMapRef.current.has(k)) {
                candleMapRef.current.set(k, c)
                changed = true
              }
            }
            if (changed) {
              const arr = flushMap()
              if (arr.length > 0) setLastCandle(arr[0])
            }
            break
          }

          case 'NEW_CANDLE': {
            // Nova vela em tempo real: insere/atualiza no Map e re-renderiza.
            const candle: Candle = msg.data
            const k = candleKey(candle)
            candleMapRef.current.set(k, candle)

            // Limita tamanho: remove a mais antiga se ultrapassar o limite
            if (candleMapRef.current.size > MAX_CANDLES_IN_MEMORY) {
              let oldestKey: string | null = null
              let oldestTs  = Infinity
              for (const [key, c] of candleMapRef.current) {
                const ts = new Date(((c as any).timestamp || c.created_at) as string).getTime()
                if (ts < oldestTs) { oldestTs = ts; oldestKey = key }
              }
              if (oldestKey) candleMapRef.current.delete(oldestKey)
            }

            setLastCandle(candle)
            flushMap()
            break
          }

          case 'STATUS_UPDATE': {
            setStatus({ ...DEFAULT_STATUS, ...msg.data, connected: true })
            break
          }

          case 'PONG':
            break

          default:
            break
        }
      } catch {
        // mensagem malformada — ignorar silenciosamente
      }
    }

    ws.onclose = () => {
      if (!isMounted.current) return
      setConnected(false)
      setStatus(prev => ({ ...prev, connected: false }))
      wsRef.current = null
      // Não limpa o candleMapRef no close — preserva histórico entre reconexões
      reconnectTimer.current = setTimeout(() => {
        if (isMounted.current) connect()
      }, RECONNECT_DELAY_MS)
    }

    ws.onerror = () => {
      ws.close()
    }
  }, [])

  useEffect(() => {
    isMounted.current = true
    connect()

    return () => {
      isMounted.current = false
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, [connect])

  useEffect(() => {
    setStatus(prev => ({ ...prev, connected }))
  }, [connected])

  const reconnect = useCallback(() => {
    // No reconnect manual, limpa o Map para forçar re-sincronização completa
    candleMapRef.current.clear()
    setCandles([])
    setLastCandle(null)
    wsRef.current?.close()
    connect()
  }, [connect])

  return (
    <WebSocketContext.Provider value={{ candles, status, connected, lastCandle, reconnect }}>
      {children}
    </WebSocketContext.Provider>
  )
}