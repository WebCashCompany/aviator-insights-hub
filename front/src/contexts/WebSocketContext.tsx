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
const RECONNECT_DELAY_MS = 3000

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const [candles, setCandles] = useState<Candle[]>([])
  const [status, setStatus] = useState<ServerStatus>(DEFAULT_STATUS)
  const [connected, setConnected] = useState(false)
  const [lastCandle, setLastCandle] = useState<Candle | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isMounted = useRef(true)

  const connect = useCallback(() => {
    // Evita múltiplas conexões simultâneas
    if (wsRef.current?.readyState === WebSocket.OPEN ||
        wsRef.current?.readyState === WebSocket.CONNECTING) return

    // Adiciona header ngrok para evitar tela de aviso
    const url = WS_URL.includes('ngrok')
      ? `${WS_URL}?ngrok-skip-browser-warning=true`
      : WS_URL

    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      if (!isMounted.current) return
      setConnected(true)
      setStatus(prev => ({ ...prev, connected: true }))
      // Cancela qualquer timer de reconexão pendente
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
    }

    ws.onmessage = (event) => {
      if (!isMounted.current) return
      try {
        const msg = JSON.parse(event.data)

        switch (msg.type) {
          case 'HISTORY': {
            // Histórico inicial enviado pelo bot ao conectar
            const history: Candle[] = Array.isArray(msg.data) ? msg.data : []
            setCandles(history.slice(-MAX_CANDLES_IN_MEMORY))
            break
          }

          case 'NEW_CANDLE': {
            const candle: Candle = msg.data
            setLastCandle(candle)
            setCandles(prev => {
              const next = [...prev, candle]
              // Mantém apenas as últimas N velas em memória
              return next.length > MAX_CANDLES_IN_MEMORY
                ? next.slice(next.length - MAX_CANDLES_IN_MEMORY)
                : next
            })
            break
          }

          case 'STATUS_UPDATE': {
            setStatus({ ...DEFAULT_STATUS, ...msg.data, connected: true })
            break
          }

          case 'PONG':
            // heartbeat de resposta — ignorar silenciosamente
            break

          default:
            break
        }
      } catch {
        // mensagem malformada — ignorar
      }
    }

    ws.onclose = () => {
      if (!isMounted.current) return
      setConnected(false)
      setStatus(prev => ({ ...prev, connected: false }))
      wsRef.current = null
      // Agenda reconexão automática
      reconnectTimer.current = setTimeout(() => {
        if (isMounted.current) connect()
      }, RECONNECT_DELAY_MS)
    }

    ws.onerror = () => {
      // onclose será disparado logo após — deixa ele cuidar da reconexão
      ws.close()
    }
  }, [])

  // Inicia conexão ao montar e limpa ao desmontar
  useEffect(() => {
    isMounted.current = true
    connect()

    return () => {
      isMounted.current = false
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, [connect])

  // Mantém o status sincronizado com o estado de conexão
  useEffect(() => {
    setStatus(prev => ({ ...prev, connected }))
  }, [connected])

  const reconnect = useCallback(() => {
    wsRef.current?.close()
    connect()
  }, [connect])

  return (
    <WebSocketContext.Provider value={{ candles, status, connected, lastCandle, reconnect }}>
      {children}
    </WebSocketContext.Provider>
  )
}