// supabaseService.ts — COMPLETO
import { createClient } from '@supabase/supabase-js'
import { logger } from '../utils/logger.js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

let resolvedUserId: string | null = null
const insertedRodadaIds = new Set<string>()

// ─── Init ─────────────────────────────────────────────────────────────────────
export async function initBotUser() {
  const email = process.env.BET923_EMAIL
  if (!email) return logger.error('❌ BET923_EMAIL não definido no .env')

  try {
    const { data } = await supabase.auth.admin.listUsers()
    const user = data.users.find(u => u.email === email)

    if (!user) {
      logger.error(`❌ Usuário não encontrado: ${email}`)
      return
    }

    resolvedUserId = user.id
    insertedRodadaIds.clear()
    await clearCandles()
    logger.info(`✅ Bot vinculado ao usuário: ${email}`)
  } catch (err: any) {
    logger.error(`💥 Erro crítico no init: ${err.message}`)
  }
}

// ─── Limpa banco ──────────────────────────────────────────────────────────────
export async function clearCandles() {
  if (!resolvedUserId) return
  try {
    const { error, count } = await supabase
      .from('candles')
      .delete({ count: 'exact' })
      .eq('user_id', resolvedUserId)

    if (!error) logger.info(`🧹 Banco limpo: ${count ?? 0} vela(s) removida(s)`)
  } catch (err: any) {
    logger.error(`💥 Falha ao limpar: ${err.message}`)
  }
}

// ─── Salva vela ───────────────────────────────────────────────────────────────
// Sem Barreira 2 — ela estava com janela errada e não funcionava.
// O banco é limpo a cada restart, então não há risco de duplicata entre sessões.
// A única deduplicação necessária é:
//   Barreira 1: memória síncrona (insertedRodadaIds) — evita double-fire na mesma sessão
//   Barreira 3: upsert com ignoreDuplicates — defesa final no banco
export async function saveCandle(candle: any) {
  if (!resolvedUserId) return

  if (!candle.rodada_id) {
    logger.warn(`⚠️  Vela sem rodada_id ignorada: ${candle.multiplicador}x`)
    return
  }

  // Barreira 1: memória síncrona
  if (insertedRodadaIds.has(candle.rodada_id)) return
  insertedRodadaIds.add(candle.rodada_id)

  try {
    const { error } = await supabase.from('candles').upsert(
      {
        user_id:       resolvedUserId,
        multiplicador: candle.multiplicador,
        cor:           candle.cor,
        rodada_id:     candle.rodada_id,
        fonte:         'auto',
        timestamp:     candle.timestamp || new Date().toISOString(),
      },
      { onConflict: 'user_id,rodada_id', ignoreDuplicates: true }
    )

    if (error) {
      if (error.code === '23505') return
      logger.error(`❌ Erro Supabase: ${error.message}`)
      insertedRodadaIds.delete(candle.rodada_id)
    } else {
      logger.info(`✅ Vela salva: ${candle.multiplicador}x`)
    }
  } catch (err: any) {
    insertedRodadaIds.delete(candle.rodada_id)
    logger.error(`💥 Falha de rede ao salvar: ${err.message}`)
  }
}

export function resetSaveState() {
  insertedRodadaIds.clear()
  logger.info('🔄 Estado de inserção resetado')
}

export { supabase }