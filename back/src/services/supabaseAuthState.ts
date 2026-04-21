/**
 * supabaseAuthState.ts
 *
 * Substitui o `useMultiFileAuthState` do Baileys.
 * Persiste creds + signal keys no Supabase para que a sessão
 * sobreviva a reinicializações do servidor e seja compartilhada
 * entre múltiplas instâncias (deploy, PM2, Docker, etc.).
 *
 * Tabela necessária no Supabase (rodar migration abaixo):
 * ─────────────────────────────────────────────────────────
 * CREATE TABLE IF NOT EXISTS wpp_sessions (
 *   session_id  TEXT NOT NULL,
 *   key         TEXT NOT NULL,
 *   value       JSONB NOT NULL,
 *   updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
 *   PRIMARY KEY (session_id, key)
 * );
 * ─────────────────────────────────────────────────────────
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  AuthenticationCreds,
  AuthenticationState,
  BufferJSON,
  initAuthCreds,
  proto,
  SignalDataTypeMap,
} from '@whiskeysockets/baileys'
import { logger } from '../utils/logger.js'

// ─── Cliente Supabase dedicado (sem auto-refresh para uso server-side) ─────────
function getSupabase(): SupabaseClient {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}

const SESSION_ID = process.env.WPP_SESSION_ID || 'default'

// ─── Helpers de leitura / escrita ─────────────────────────────────────────────

async function readRow(
  supabase: SupabaseClient,
  key: string,
): Promise<any | null> {
  const { data, error } = await supabase
    .from('wpp_sessions')
    .select('value')
    .eq('session_id', SESSION_ID)
    .eq('key', key)
    .maybeSingle()

  if (error) {
    logger.warn(`[SupabaseAuth] Erro ao ler "${key}": ${error.message}`)
    return null
  }
  return data?.value ?? null
}

async function writeRow(
  supabase: SupabaseClient,
  key: string,
  value: any,
): Promise<void> {
  const { error } = await supabase.from('wpp_sessions').upsert(
    {
      session_id: SESSION_ID,
      key,
      value,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'session_id,key' },
  )
  if (error) {
    logger.error(`[SupabaseAuth] Erro ao salvar "${key}": ${error.message}`)
  }
}

async function deleteRows(
  supabase: SupabaseClient,
  keys: string[],
): Promise<void> {
  if (!keys.length) return
  const { error } = await supabase
    .from('wpp_sessions')
    .delete()
    .eq('session_id', SESSION_ID)
    .in('key', keys)
  if (error) {
    logger.warn(`[SupabaseAuth] Erro ao deletar chaves: ${error.message}`)
  }
}

// ─── API pública ───────────────────────────────────────────────────────────────

/**
 * Equivalente ao `useMultiFileAuthState`, mas persiste no Supabase.
 *
 * Uso (em whatsappService.ts):
 * ```ts
 * import { useSupabaseAuthState } from './supabaseAuthState.js'
 * // ...
 * const { state: authState, saveCreds } = await useSupabaseAuthState()
 * ```
 */
export async function useSupabaseAuthState(): Promise<{
  state: AuthenticationState
  saveCreds: () => Promise<void>
  clearSession: () => Promise<void>
}> {
  const supabase = getSupabase()

  // ── Credenciais ──────────────────────────────────────────────────────────────
  const rawCreds = await readRow(supabase, 'creds')
  const creds: AuthenticationCreds = rawCreds
    ? (JSON.parse(JSON.stringify(rawCreds), BufferJSON.reviver) as AuthenticationCreds)
    : initAuthCreds()

  const saveCreds = async (): Promise<void> => {
    await writeRow(
      supabase,
      'creds',
      JSON.parse(JSON.stringify(creds, BufferJSON.replacer)),
    )
    logger.debug('[SupabaseAuth] Creds salvas')
  }

  // ── Signal Keys ──────────────────────────────────────────────────────────────
  const keys = {
    get: async <T extends keyof SignalDataTypeMap>(
      type: T,
      ids: string[],
    ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
      const result: { [id: string]: SignalDataTypeMap[T] } = {}
      await Promise.all(
        ids.map(async (id) => {
          const raw = await readRow(supabase, `key_${type}_${id}`)
          if (raw == null) return
          let value = JSON.parse(JSON.stringify(raw), BufferJSON.reviver)
          // Baileys espera Uint8Array em 'app-state-sync-key'
          if (type === 'app-state-sync-key') {
            value = proto.Message.AppStateSyncKeyData.fromObject(value)
          }
          result[id] = value
        }),
      )
      return result
    },

    set: async (data: { [category: string]: { [id: string]: any } }): Promise<void> => {
      const writes: Promise<void>[] = []
      const deletes: string[] = []

      for (const [type, ids] of Object.entries(data)) {
        for (const [id, value] of Object.entries(ids ?? {})) {
          const dbKey = `key_${type}_${id}`
          if (value) {
            writes.push(
              writeRow(
                supabase,
                dbKey,
                JSON.parse(JSON.stringify(value, BufferJSON.replacer)),
              ),
            )
          } else {
            deletes.push(dbKey)
          }
        }
      }

      await Promise.all([...writes, deleteRows(supabase, deletes)])
    },
  }

  // ── Limpar sessão completa (logout) ──────────────────────────────────────────
  const clearSession = async (): Promise<void> => {
    const { error } = await supabase
      .from('wpp_sessions')
      .delete()
      .eq('session_id', SESSION_ID)
    if (error) {
      logger.error(`[SupabaseAuth] Erro ao limpar sessão: ${error.message}`)
    } else {
      logger.info('[SupabaseAuth] Sessão removida do Supabase')
    }
  }

  return {
    state: { creds, keys },
    saveCreds,
    clearSession,
  }
}