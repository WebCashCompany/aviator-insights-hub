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

export function useCandles(options: UseCandlesOptions = {}) {
  const { user } = useAuth()
  const [dbCandles, setDbCandles] = useState<Candle[]>([])
  const [loading, setLoading] = useState(true)
  const limitRef = useRef(options.limit)
  limitRef.current = options.limit

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

  useEffect(() => { fetchCandles() }, [fetchCandles])

  // Realtime: .on() DEVE ser chamado antes de .subscribe()
  // O cleanup remove o canal completamente antes de recriar
  useEffect(() => {
    if (!user) return

    const channelName = `candles-${user.id}-${Date.now()}`

    // Constrói o canal com o listener JÁ registrado, depois subscreve
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'candles',
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          const newCandle = payload.new as Candle
          setDbCandles(prev => {
            if (prev.some(c => c.id === newCandle.id)) return prev
            const next = [...prev, newCandle].sort(
              (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
            )
            const limit = limitRef.current
            return limit && next.length > limit ? next.slice(next.length - limit) : next
          })
        }
      )
      .subscribe()

    // Cleanup: remove o canal inteiro — nunca reutiliza após unsubscribe
    return () => {
      supabase.removeChannel(channel)
    }
  }, [user])

  const addCandle = useCallback(async (multiplicador: number, fonte: 'manual' | 'csv' | 'auto' = 'manual') => {
    if (!user) return
    const cor = calcularCor(multiplicador)
    const { data, error } = await supabase.from('candles').insert({
      user_id: user.id,
      multiplicador,
      cor,
      fonte,
    }).select().single()
    return { data, error }
  }, [user])

  const addBulk = useCallback(async (multiplicadores: number[], fonte: 'manual' | 'csv' = 'csv') => {
    if (!user) return
    const rows = multiplicadores.map(m => ({
      user_id: user.id,
      multiplicador: m,
      cor: calcularCor(m),
      fonte,
    }))
    const { data, error } = await supabase.from('candles').insert(rows).select()
    return { data, error }
  }, [user])

  const clearAll = useCallback(async () => {
    if (!user) return
    await supabase.from('candles').delete().eq('user_id', user.id)
    setDbCandles([])
  }, [user])

  const stats = useMemo(() => calcularStats(dbCandles), [dbCandles])

  return { candles: dbCandles, stats, loading, addCandle, addBulk, clearAll, refetch: fetchCandles }
}