/**
 * whatsappService.ts — Baileys + sessão persistida no Supabase
 *
 * CORREÇÕES:
 *  - Reduzido cooldown de alerta de mercado para permitir maior reatividade.
 *  - Envio em paralelo para múltiplos grupos (reduz atraso de rede).
 *  - Ajuste no anti-spam para ser menos restritivo em sinais sequenciais.
 */

import {
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  WASocket,
  GroupMetadata,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import QRCode from 'qrcode'
import { logger } from '../utils/logger.js'
import { EventEmitter } from 'events'
import { useSupabaseAuthState } from './supabaseAuthState.js'

// ─── Config ───────────────────────────────────────────────────────────────────
const MIN_INTERVAL       = parseInt(process.env.WPP_MIN_INTERVAL_MS || '1500') // Reduzido para 1.5s
const PAY_ALERT_COOLDOWN = 5 * 60 * 1000 // Reduzido para 5 min

const silentChild: any = {
  level: 'silent', trace: () => {}, debug: () => {}, info: () => {},
  warn:  () => {},  error: () => {}, fatal: () => {}, child: () => silentChild,
}

// ─── Tipos ────────────────────────────────────────────────────────────────────
export type ConnState = 'close' | 'connecting' | 'open' | 'error'

export interface SessionScore {
  wins:   number   // total de wins (winsG1 + winsG2)
  winsG1: number   // wins diretos (primeira entrada)
  winsG2: number   // wins no martingale (G1)
  losses: number   // losses totais
}

interface WppState {
  conn:           ConnState
  qrBase64:       string | null
  socket:         WASocket | null
  isConnecting:   boolean
  retryTimer:     ReturnType<typeof setTimeout> | null
  retryCount:     number
  groups:         { id: string; name: string; size: number }[]
  contacts:       { id: string; name: string; phone: string }[]
  targets:        string[]
  lastPayAlertAt: number
  clearSession:   (() => Promise<void>) | null
}

// ─── Estado global ────────────────────────────────────────────────────────────
const state: WppState = {
  conn: 'close', qrBase64: null, socket: null, isConnecting: false,
  retryTimer: null, retryCount: 0, groups: [], contacts: [], targets: [],
  lastPayAlertAt: 0, clearSession: null,
}

export const wppEvents = new EventEmitter()

// ─── Anti-spam ────────────────────────────────────────────────────────────────
const lastSentAt = new Map<string, number>()
function canSend(key: string): boolean { 
  const last = lastSentAt.get(key) ?? 0
  return Date.now() - last >= MIN_INTERVAL 
}
function markSent(key: string): void   { lastSentAt.set(key, Date.now()) }

// ─── Helpers públicos ─────────────────────────────────────────────────────────
export function getConnState():               ConnState            { return state.conn }
export function getQrBase64():                string | null        { return state.qrBase64 }
export function getSavedTargets():            string[]             { return state.targets }
export function setSavedTargets(t: string[]): void                 { state.targets = t; logger.info(`[WPP] Targets: ${t.length}`) }
export function getGroups():                  WppState['groups']   { return state.groups }
export function getContacts():                WppState['contacts'] { return state.contacts }
export function isConfigured():               boolean              { return state.conn === 'open' }

// ─── Retry ────────────────────────────────────────────────────────────────────
function scheduleRetry(): void {
  if (state.retryCount >= 10) {
    state.conn = 'close'; state.isConnecting = false
    logger.error('[WPP] Máximo de tentativas atingido')
    wppEvents.emit('state', 'close'); return
  }
  state.retryCount++
  const delay = Math.min(2000 * state.retryCount, 20_000)
  if (state.retryTimer) clearTimeout(state.retryTimer)
  state.retryTimer = setTimeout(() => { state.isConnecting = false; startConnection() }, delay)
}

// ─── Conexão Baileys ──────────────────────────────────────────────────────────
export async function startConnection(): Promise<void> {
  if (state.isConnecting) return
  state.isConnecting = true; state.conn = 'connecting'; state.qrBase64 = null
  wppEvents.emit('state', 'connecting')

  try {
    const { state: authState, saveCreds, clearSession } = await useSupabaseAuthState()
    state.clearSession = clearSession

    const { version } = await fetchLatestBaileysVersion()
    const sock = makeWASocket({
      version,
      auth: {
        creds: authState.creds,
        keys:  makeCacheableSignalKeyStore(authState.keys, undefined as any),
      },
      syncFullHistory:                false,
      generateHighQualityLinkPreview: false,
      browser:                        ['Ubuntu', 'Chrome', '22.0.0.75'],
      logger:                         silentChild,
      connectTimeoutMs:               60_000,
      keepAliveIntervalMs:            30_000,
    })

    state.socket = sock

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update
      if (qr) {
        try { state.qrBase64 = await QRCode.toDataURL(qr); wppEvents.emit('qr', state.qrBase64) } catch {}
      }
      if (connection === 'open') {
        state.conn = 'open'; state.qrBase64 = null; state.isConnecting = false; state.retryCount = 0
        if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = null }
        wppEvents.emit('state', 'open')
        logger.info('[WPP] ✅ WhatsApp conectado!')
        await loadGroupsAndContacts(sock)
      }
      if (connection === 'close') {
        const boom = lastDisconnect?.error as Boom | undefined
        const reason = boom?.output?.statusCode
        state.socket = null; state.isConnecting = false
        if (reason === DisconnectReason.loggedOut) {
          await state.clearSession?.(); state.conn = 'close'; state.retryCount = 0
          wppEvents.emit('state', 'close'); return
        }
        state.conn = 'connecting'; wppEvents.emit('state', 'connecting'); scheduleRetry()
      }
    })
    sock.ev.on('creds.update', saveCreds)
  } catch (err: any) {
    state.socket = null; state.isConnecting = false; state.conn = 'connecting'
    wppEvents.emit('state', 'connecting'); scheduleRetry()
  }
}

async function loadGroupsAndContacts(sock: WASocket): Promise<void> {
  try {
    const groupMap: Record<string, GroupMetadata> = await sock.groupFetchAllParticipating()
    state.groups = Object.values(groupMap).map(g => ({ id: g.id, name: g.subject, size: g.participants?.length ?? 0 }))
    state.contacts = []
  } catch {}
}

export async function disconnect(): Promise<void> {
  if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = null }
  state.isConnecting = false
  if (state.socket) { await state.socket.logout().catch(() => {}); state.socket = null }
  await state.clearSession?.(); state.clearSession = null
  state.conn = 'close'; state.qrBase64 = null; state.groups = []; state.contacts = []
  wppEvents.emit('state', 'close')
}

// ─── Envio base ───────────────────────────────────────────────────────────────
async function sendText(jid: string, text: string): Promise<void> {
  if (!state.socket || state.conn !== 'open') throw new Error('WhatsApp não conectado')
  await state.socket.sendMessage(jid, { text })
}

async function sendToTargets(targets: string[], message: string, spamKey: string): Promise<void> {
  if (!targets.length) return
  if (!canSend(spamKey)) { logger.info(`[WPP] Anti-spam: ${spamKey}`); return }
  markSent(spamKey)
  
  // Envio em paralelo para reduzir atraso
  const promises = targets.map(async (jid) => {
    try { await sendText(jid, message); logger.info(`[WPP] ✅ → ${jid}`) }
    catch (e: any) { logger.error(`[WPP] ❌ → ${jid}: ${e.message}`) }
  })
  await Promise.all(promises)
}

function hora(): string { return new Date().toLocaleTimeString('pt-BR') }

function formatScore(score?: SessionScore): string {
  if (!score) return ''
  const total = score.wins + score.losses
  const winRate = total > 0 ? ((score.wins / total) * 100).toFixed(0) : '0'
  return (
    `\n━━━━━━━━━━━━━━━━━━━━\n` +
    `📊 *Placar da sessão*\n` +
    `✅ Win: *${score.wins}*  (direto: ${score.winsG1} · gale: ${score.winsG2})\n` +
    `❌ Loss: *${score.losses}*\n` +
    `🎯 Aproveitamento: *${winRate}%*`
  )
}

// ─── Alertas ──────────────────────────────────────────────────────────────────

export async function alertMarketPaying(targets?: string[]): Promise<void> {
  if (state.conn !== 'open') return
  const dest = targets?.length ? targets : getSavedTargets()
  if (!dest.length) return
  if (Date.now() - state.lastPayAlertAt < PAY_ALERT_COOLDOWN) return
  state.lastPayAlertAt = Date.now()

  const msg = `🟢 *GRÁFICO EM MOMENTO FAVORÁVEL*\n━━━━━━━━━━━━━━━━━━━━\n✅ Padrão de entrada identificado\n📊 Volatilidade elevada — bom para operar\n🎯 Fique atento aos próximos sinais!\n⏱ ${hora()}`
  await sendToTargets(dest, msg, 'market_paying')
}

export async function alertWarning(strategyName: string, targets?: string[]): Promise<void> {
  if (state.conn !== 'open') return
  const dest = targets?.length ? targets : getSavedTargets()
  if (!dest.length) return
  const msg = `⚠️ *PRÉ-SINAL IDENTIFICADO*\n━━━━━━━━━━━━━━━━━━━━\n🤖 Estratégia: *${strategyName}*\n🎯 Status: *Aguardando confirmação*\n📱 Fique atento para a entrada!\n⏱ ${hora()}`
  await sendToTargets(dest, msg, `warning_${strategyName}`)
}

export async function alertConfirmed(strategyName: string, targets?: string[]): Promise<void> {
  if (state.conn !== 'open') return
  const dest = targets?.length ? targets : getSavedTargets()
  if (!dest.length) return
  const msg = `🚀 *ENTRADA CONFIRMADA*\n━━━━━━━━━━━━━━━━━━━━\n🤖 Estratégia: *${strategyName}*\n✅ *ENTRAR AGORA NA PRÓXIMA VELA*\n🎯 Alvo: *2.00x*\n🛡 Proteção: *Até G1*\n⏱ ${hora()}\n\n🔗 [Clique aqui para abrir o jogo](${GAME_LINK})`
  await sendToTargets(dest, msg, `confirmed_${strategyName}`)
}

export async function alertGale(strategyName: string, targets?: string[]): Promise<void> {
  if (state.conn !== 'open') return
  const dest = targets?.length ? targets : getSavedTargets()
  if (!dest.length) return
  const msg = `🔄 *MARTINGALE 1 (G1)*\n━━━━━━━━━━━━━━━━━━━━\n🤖 Estratégia: *${strategyName}*\n⚠️ A primeira não pagou, entrar novamente!\n🎯 Alvo: *2.00x*\n⏱ ${hora()}`
  await sendToTargets(dest, msg, `gale_${strategyName}`)
}

export async function alertResult(strategyName: string, result: string, multiplier: number, targets?: string[], score?: SessionScore): Promise<void> {
  if (state.conn !== 'open') return
  const dest = targets?.length ? targets : getSavedTargets()
  if (!dest.length) return
  const isWin = result.startsWith('win')
  const msg = `${isWin ? '✅' : '❌'} *${isWin ? 'GREEN CONFIRMADO!' : 'LOSS (STOP LOSS)'}*\n━━━━━━━━━━━━━━━━━━━━\n🤖 Estratégia: *${strategyName}*\n📊 Resultado: *${multiplier.toFixed(2)}x*\n⏱ ${hora()}${formatScore(score)}`
  await sendToTargets(dest, msg, `result_${strategyName}_${Date.now()}`)
}

export async function alertStrategySignal(strategyName: string, signalMsg: string, targets?: string[]): Promise<void> {
  if (state.conn !== 'open') return
  const dest = targets?.length ? targets : getSavedTargets()
  if (!dest.length) return
  const msg = `🤖 *SINAL DE ESTRATÉGIA*\n━━━━━━━━━━━━━━━━━━━━\n📈 Estratégia: *${strategyName}*\n💬 Mensagem: ${signalMsg}\n⏱ ${hora()}`
  await sendToTargets(dest, msg, `signal_${strategyName}`)
}

export async function testConnection(): Promise<{ ok: boolean; error?: string }> {
  if (state.conn !== 'open') return { ok: false, error: 'WhatsApp não conectado' }
  try {
    const dest = getSavedTargets()
    if (!dest.length) return { ok: false, error: 'Nenhum destino configurado' }
    await sendText(dest[0], `🤖 *Teste de Conexão*\n\nSeu bot está online!\n⏱ ${hora()}`)
    return { ok: true }
  } catch (err: any) { return { ok: false, error: err.message } }
}
