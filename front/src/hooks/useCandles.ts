import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { Candle } from '@/types'
import { calcularCor, calcularStats } from '@/utils/candleUtils'

interface UseCandlesOptions {
  limit?: number
  cor?: string
  from?: string
  to?: string
}

// Ref global fora do hook — persiste entre remontagens e evita canais zumbis
const activeChannels = new Map<string, ReturnType<typeof supabase.channel>>()

export function useCandles(options: UseCandlesOptions = {}) {
  const { user } = useAuth()
  const [dbCandles, setDbCandles] = useState<Candle[]>([])
  const [loading, setLoading] = useState(true)
  const limitRef = useRef(options.limit)
  limitRef.current = options.limit

  // ─── Busca inicial + re-busca quando opções mudam ───────────────────────────
  const fetchCandles = useCallback(async () => {
    if (!user) return
    setLoading(true)

    let query = supabase
      .from('candles')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })

    if (options.limit) query = query.limit(options.limit)
    if (options.cor)   query = query.eq('cor', options.cor)
    if (options.from)  query = query.gte('created_at', options.from)
    if (options.to)    query = query.lte('created_at', options.to)

    const { data, error } = await query
    if (!error && data) setDbCandles(data as Candle[])
    setLoading(false)
  }, [user, options.limit, options.cor, options.from, options.to])

  useEffect(() => {
    fetchCandles()
  }, [fetchCandles])

  // ─── Realtime ───────────────────────────────────────────────────────────────
  // Problema: removeChannel() é assíncrono internamente no Supabase.
  // O React (especialmente StrictMode) desmonta/remonta efeitos rapidamente,
  // fazendo o novo .on() ser chamado antes do canal antigo ser destruído.
  // Solução: Map global que rastreia o canal ativo por usuário de forma
  // síncrona, removendo o anterior antes de registrar qualquer novo listener.
  useEffect(() => {
    if (!user) return

    const userId = user.id

    // Remove canal anterior de forma síncrona antes de criar o novo
    const existing = activeChannels.get(userId)
    if (existing) {
      supabase.removeChannel(existing)
      activeChannels.delete(userId)
    }

    const channelName = `candles-${userId}-${Date.now()}`

    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'candles',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          // Descarta callbacks de canais que já foram substituídos
          if (activeChannels.get(userId) !== channel) return

          const newCandle = payload.new as Candle
          setDbCandles(prev => {
            if (prev.some(c => c.id === newCandle.id)) return prev
            const next = [...prev, newCandle].sort(
              (a, b) =>
                new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
            )
            const limit = limitRef.current
            return limit && next.length > limit
              ? next.slice(next.length - limit)
              : next
          })
        }
      )
      .subscribe()

    activeChannels.set(userId, channel)

    return () => {
      // Só remove se ainda for o canal ativo desse usuário
      if (activeChannels.get(userId) === channel) {
        supabase.removeChannel(channel)
        activeChannels.delete(userId)
      }
    }
  }, [user])

  // ─── Mutações ───────────────────────────────────────────────────────────────
  const addCandle = useCallback(
    async (multiplicador: number, fonte: 'manual' | 'csv' | 'auto' = 'manual') => {
      if (!user) return
      const cor = calcularCor(multiplicador)
      const { data, error } = await supabase
        .from('candles')
        .insert({ user_id: user.id, multiplicador, cor, fonte })
        .select()
        .single()
      return { data, error }
    },
    [user]
  )

  const addBulk = useCallback(
    async (multiplicadores: number[], fonte: 'manual' | 'csv' = 'csv') => {
      if (!user) return
      const rows = multiplicadores.map(m => ({
        user_id: user.id,
        multiplicador: m,
        cor: calcularCor(m),
        fonte,
      }))
      const { data, error } = await supabase
        .from('candles')
        .insert(rows)
        .select()
      return { data, error }
    },
    [user]
  )

  const clearAll = useCallback(async () => {
    if (!user) return
    await supabase.from('candles').delete().eq('user_id', user.id)
    setDbCandles([])
  }, [user])

  // ─── Stats derivadas ────────────────────────────────────────────────────────
  const stats = useMemo(() => calcularStats(dbCandles), [dbCandles])

  return {
    candles: dbCandles,
    stats,
    loading,
    addCandle,
    addBulk,
    clearAll,
    refetch: fetchCandles,
  }
}