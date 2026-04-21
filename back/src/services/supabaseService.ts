import { createClient } from '@supabase/supabase-js'
import { logger } from '../utils/logger.js'
import { Candle } from '../types/index.js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

let resolvedUserId: string | null = null

// ─── SET LOCAL: garante que nenhum rodada_id é inserido 2x nesta sessão ──────
// Mesmo que o candleService falhe ou o burst chegue em paralelo,
// este set é a última barreira antes do INSERT.
const insertedRodadaIds = new Set<string>()

export async function initBotUser(): Promise<void> {
  const email = process.env.BET923_EMAIL

  if (!email) {
    logger.error('❌ BET923_EMAIL não definido no .env')
    return
  }

  try {
    const { data, error } = await supabase.auth.admin.listUsers()

    if (error) {
      logger.error(`❌ Erro ao listar usuários: ${error.message}`)
      return
    }

    const user = data.users.find(u => u.email === email)

    if (!user) {
      logger.error(`❌ Nenhum usuário encontrado com email: ${email}`)
      return
    }

    resolvedUserId = user.id
    logger.info(`✅ Bot vinculado ao usuário: ${email} (user_id: ${resolvedUserId})`)

    insertedRodadaIds.clear()
    await clearCandles()
  } catch (err: any) {
    logger.error(`💥 Erro crítico ao buscar usuário: ${err.message}`)
  }
}

async function clearCandles(): Promise<void> {
  if (!resolvedUserId) return
  try {
    const { error, count } = await supabase
      .from('candles')
      .delete({ count: 'exact' })
      .eq('user_id', resolvedUserId)

    if (error) {
      logger.error(`❌ Erro ao limpar velas: ${error.message}`)
    } else {
      logger.info(`🧹 Banco limpo: ${count ?? 0} vela(s) removida(s)`)
    }
  } catch (err: any) {
    logger.error(`💥 Falha ao limpar banco: ${err.message}`)
  }
}

export async function saveCandle(candle: Candle): Promise<void> {
  if (!resolvedUserId) {
    logger.warn('⚠️  user_id não resolvido — vela não salva')
    return
  }

  const rodadaId = candle.rodada_id ?? `fallback_${candle.multiplicador.toFixed(2)}_${Date.now()}`

  // ─── BARREIRA 1: set em memória (síncrono, zero latência) ────────────────
  if (insertedRodadaIds.has(rodadaId)) {
    logger.info(`⏭️  saveCandle ignorado (já inserido nesta sessão): ${rodadaId}`)
    return
  }
  insertedRodadaIds.add(rodadaId)

  try {
    // ─── BARREIRA 2: upsert com onConflict em rodada_id ──────────────────
    // Se o banco tiver constraint UNIQUE em (user_id, rodada_id),
    // conflitos são silenciosamente ignorados — zero duplicata no banco.
    // Se não tiver a constraint ainda, o insert normal ocorre mas a
    // barreira 1 já cobre 99% dos casos desta sessão.
    const { error } = await supabase.from('candles').upsert(
      {
        user_id:      resolvedUserId,
        multiplicador: candle.multiplicador,
        cor:           candle.cor,
        rodada_id:     rodadaId,
        fonte:         'auto',
        created_at:    new Date().toISOString(),
      },
      {
        onConflict:        'user_id,rodada_id',  // requer constraint UNIQUE no banco
        ignoreDuplicates:  true,                 // não lança erro, apenas ignora
      }
    )

    if (error) {
      // 23505 = unique_violation — pode chegar se a constraint existir e
      // o upsert não cobrir por alguma razão de versão do Supabase
      if (error.code === '23505') {
        logger.info(`⏭️  Vela já existe no banco (23505): ${rodadaId}`)
      } else {
        logger.error(`❌ Erro Supabase: ${error.message}`)
        // Remove do set para permitir retry em falhas reais
        insertedRodadaIds.delete(rodadaId)
      }
    } else {
      logger.info(`✅ Vela salva: ${candle.multiplicador}x`)
    }
  } catch (err: any) {
    logger.error(`💥 Falha crítica ao salvar vela: ${err.message}`)
    insertedRodadaIds.delete(rodadaId)
  }
}