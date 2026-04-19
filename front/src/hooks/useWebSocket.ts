import { useState, useEffect, useRef, useCallback } from 'react'
import { Candle, ServerStatus } from '@/types'

const DEFAULT_WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3001'

export function useWebSocket() {
  const [candles, setCandles] = useState<Candle[]>([])
  const [status, setStatus] = useState<ServerStatus>({
    connected: false, loggedIn: false, gameOpen: false,
    totalCaptured: 0, lastCandle: null, uptime: 0, lastError: null,
  })
  const [connected, setConnected] = useState(false)
  const [lastCandle, setLastCandle] = useState<Candle | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectRef = useRef<ReturnType<typeof setTimeout>>()

  const connect = useCallback(() => {
    // Usa a variável de ambiente, com fallback pro localStorage apenas em dev
    const wsUrl = DEFAULT_WS_URL.includes('ngrok')
      ? `${DEFAULT_WS_URL}?ngrok-skip-browser-warning=true`
      : (localStorage.getItem('ws_url') || DEFAULT_WS_URL)

    try {
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        setStatus(prev => ({ ...prev, connected: true, lastError: null }))
      }

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          switch (msg.type) {
            case 'NEW_CANDLE':
              setCandles(prev => [...prev, msg.data])
              setLastCandle(msg.data)
              setStatus(prev => ({
                ...prev,
                totalCaptured: prev.totalCaptured + 1,
                lastCandle: msg.data,
              }))
              break
            case 'HISTORY':
              setCandles(msg.data)
              break
            case 'STATUS_UPDATE':
              setStatus(prev => ({ ...prev, ...msg.data }))
              break
          }
        } catch (e) {
          console.error('Erro ao processar mensagem WS:', e)
        }
      }

      ws.onclose = () => {
        setConnected(false)
        setStatus(prev => ({ ...prev, connected: false }))
        reconnectRef.current = setTimeout(connect, 5000)
      }

      ws.onerror = () => {
        setStatus(prev => ({ ...prev, lastError: 'Erro de conexão' }))
        ws.close()
      }
    } catch {
      reconnectRef.current = setTimeout(connect, 5000)
    }
  }, [])

  useEffect(() => {
    connect()
    return () => {
      wsRef.current?.close()
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
    }
  }, [connect])

  return { candles, status, connected, lastCandle, reconnect: connect }
}