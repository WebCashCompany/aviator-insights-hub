/**
 * whatsappService.ts — Baileys socket direto
 */

import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  WASocket,
  GroupMetadata,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import QRCode from 'qrcode'
import path from 'path'
import { logger } from '../utils/logger.js'
import { EventEmitter } from 'events'

// ─── Config ───────────────────────────────────────────────────────────────────
const SESSION_PATH       = process.env.WPP_SESSION_PATH  || './wpp-session'
const PAY_THRESHOLD      = parseFloat(process.env.WPP_PAY_THRESHOLD || '2')
const MIN_INTERVAL       = parseInt(process.env.WPP_MIN_INTERVAL_MS || '5000')
const PAY_ALERT_COOLDOWN = 10 * 60 * 1000 // 10 min

const silentChild: any = {
  level: 'silent', trace: () => {}, debug: () => {}, info: () => {},
  warn: () => {}, error: () => {}, fatal: () => {}, child: () => silentChild,
}

// ─── Estado global ────────────────────────────────────────────────────────────
export type ConnState = 'close' | 'connecting' | 'open' | 'error'

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
}

const state: WppState = {
  conn: 'close', qrBase64: null, socket: null, isConnecting: false,
  retryTimer: null, retryCount: 0, groups: [], contacts: [], targets: [],
  lastPayAlertAt: 0,
}

export const wppEvents = new EventEmitter()

// ─── Anti-spam ────────────────────────────────────────────────────────────────
const lastSentAt = new Map<string, number>()
function canSend(key: string): boolean { return Date.now() - (lastSentAt.get(key) ?? 0) >= MIN_INTERVAL }
function markSent(key: string): void   { lastSentAt.set(key, Date.now()) }

// ─── Helpers públicos ─────────────────────────────────────────────────────────
export function getConnState():               ConnState            { return state.conn }
export function getQrBase64():                string | null        { return state.qrBase64 }
export function getSavedTargets():            string[]             { return state.targets }
export function setSavedTargets(t: string[]): void                 { state.targets = t; logger.info(`[WPP] Targets: ${t.length}`) }
export function getGroups():                  WppState['groups']   { return state.groups }
export function getContacts():                WppState['contacts'] { return state.contacts }
export function isConfigured():               boolean              { return state.conn === 'open' }
export function getPayThreshold():            number               { return PAY_THRESHOLD }

// ─── Retry ────────────────────────────────────────────────────────────────────
function scheduleRetry(): void {
  if (state.retryCount >= 5) {
    state.conn = 'close'; state.isConnecting = false
    logger.error('[WPP] Máximo de tentativas atingido')
    wppEvents.emit('state', 'close'); return
  }
  state.retryCount++
  const delay = Math.min(5000 * state.retryCount, 30_000)
  logger.warn(`[WPP] Reconectando em ${delay / 1000}s (tentativa ${state.retryCount}/5)`)
  if (state.retryTimer) clearTimeout(state.retryTimer)
  state.retryTimer = setTimeout(() => { state.isConnecting = false; startConnection() }, delay)
}

// ─── Conexão Baileys ──────────────────────────────────────────────────────────
export async function startConnection(): Promise<void> {
  if (state.isConnecting) { logger.info('[WPP] Já conectando'); return }
  state.isConnecting = true; state.conn = 'connecting'; state.qrBase64 = null
  wppEvents.emit('state', 'connecting')

  try {
    const sessionDir = path.resolve(SESSION_PATH)
    const { state: authState, saveCreds } = await useMultiFileAuthState(sessionDir)
    const { version } = await fetchLatestBaileysVersion()
    logger.info(`[WPP] Baileys v${version.join('.')}`)

    const sock = makeWASocket({
      version,
      auth: { creds: authState.creds, keys: makeCacheableSignalKeyStore(authState.keys, undefined as any) },
      syncFullHistory: false, generateHighQualityLinkPreview: false,
      browser: ['Ubuntu', 'Chrome', '22.0.0.75'], logger: silentChild,
      connectTimeoutMs: 60_000, keepAliveIntervalMs: 10_000,
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
        logger.warn(`[WPP] Conexão fechada — ${DisconnectReason[reason as number] ?? reason}`)
        state.socket = null; state.isConnecting = false
        if (reason === DisconnectReason.loggedOut) {
          state.conn = 'close'; state.retryCount = 0; wppEvents.emit('state', 'close'); return
        }
        state.conn = 'connecting'; wppEvents.emit('state', 'connecting'); scheduleRetry()
      }
    })

    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('groups.update', async () => { if (state.conn === 'open') await loadGroupsAndContacts(sock) })
  } catch (err: any) {
    logger.error(`[WPP] Erro crítico: ${err.message}`)
    state.socket = null; state.isConnecting = false; state.conn = 'connecting'
    wppEvents.emit('state', 'connecting'); scheduleRetry()
  }
}

async function loadGroupsAndContacts(sock: WASocket): Promise<void> {
  try {
    const groupMap: Record<string, GroupMetadata> = await sock.groupFetchAllParticipating()
    state.groups = Object.values(groupMap).map(g => ({ id: g.id, name: g.subject, size: g.participants?.length ?? 0 }))
    logger.info(`[WPP] ${state.groups.length} grupos carregados`)
    state.contacts = []
  } catch (err: any) { logger.warn(`[WPP] Erro ao carregar grupos: ${err.message}`) }
}

export async function disconnect(): Promise<void> {
  if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = null }
  state.retryCount = 0; state.isConnecting = false
  if (state.socket) { await state.socket.logout().catch(() => {}); state.socket = null }
  state.conn = 'close'; state.qrBase64 = null; state.groups = []; state.contacts = []
  wppEvents.emit('state', 'close'); logger.info('[WPP] Desconectado')
}

// ─── Envio base ───────────────────────────────────────────────────────────────
async function sendText(jid: string, text: string): Promise<void> {
  if (!state.socket || state.conn !== 'open') throw new Error('WhatsApp não conectado')
  await state.socket.sendMessage(jid, { text })
}

async function sendToTargets(targets: string[], message: string, spamKey: string): Promise<void> {
  if (!targets.length)   { logger.warn('[WPP] Nenhum destino'); return }
  if (!canSend(spamKey)) { logger.info('[WPP] Anti-spam ativo'); return }
  markSent(spamKey)
  for (const jid of targets) {
    try   { await sendText(jid, message); logger.info(`[WPP] ✅ → ${jid}`) }
    catch (e: any) { logger.error(`[WPP] ❌ → ${jid}: ${e.message}`) }
  }
}

function hora(): string { return new Date().toLocaleTimeString('pt-BR') }

// ─── Alertas ──────────────────────────────────────────────────────────────────

/**
 * Mercado em momento favorável — mostra qualidades do gráfico,
 * sem mencionar porcentagem de azuis ou aspectos negativos.
 * Baseado nas últimas 80 velas (calculado no frontend, aqui só enviamos).
 */
export async function alertMarketPaying(targets?: string[]): Promise<void> {
  if (state.conn !== 'open') return
  const dest = targets?.length ? targets : getSavedTargets()
  if (!dest.length) return

  if (Date.now() - state.lastPayAlertAt < PAY_ALERT_COOLDOWN) return
  state.lastPayAlertAt = Date.now()

  const msg =
    `🟢 *GRÁFICO EM MOMENTO FAVORÁVEL*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `✅ Padrão de entrada identificado\n` +
    `📊 Volatilidade elevada — bom para operar\n` +
    `🎯 Fique atento aos próximos sinais!\n` +
    `⏱ ${hora()}`

  await sendToTargets(dest, msg, 'market_paying')
  logger.info('[WPP] Alerta mercado favorável enviado')
}

/**
 * Pré-sinal — 1 vela antes da entrada
 */
export async function alertWarning(strategyName: string, targets?: string[]): Promise<void> {
  if (state.conn !== 'open') return
  const dest = targets?.length ? targets : getSavedTargets()
  if (!dest.length) return

  const msg =
    `⚠️ *ATENÇÃO — PRÉ-SINAL*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📊 Estratégia: *${strategyName}*\n` +
    `🔎 Padrão identificado — prepare-se!\n` +
    `👀 Possível entrada na próxima vela\n` +
    `⏱ ${hora()}`

  await sendToTargets(dest, msg, `warning_${strategyName}`)
  logger.info(`[WPP] Pré-sinal enviado — ${strategyName}`)
}

/**
 * Entrada confirmada — hora de entrar
 */
export async function alertConfirmed(strategyName: string, targets?: string[]): Promise<void> {
  if (state.conn !== 'open') return
  const dest = targets?.length ? targets : getSavedTargets()
  if (!dest.length) return

  const msg =
    `🚀 *ENTRADA CONFIRMADA*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📊 Estratégia: *${strategyName}*\n` +
    `🎯 *ENTRE AGORA!*\n` +
    `💡 Saia em *2x* ou mais\n` +
    `🛡 Protegido até G1 (Martingale)\n` +
    `⏱ ${hora()}`

  await sendToTargets(dest, msg, `confirmed_${strategyName}`)
  logger.info(`[WPP] Entrada confirmada enviada — ${strategyName}`)
}

/**
 * G1 perdeu — entre no Martingale
 */
export async function alertGale(strategyName: string, targets?: string[]): Promise<void> {
  if (state.conn !== 'open') return
  const dest = targets?.length ? targets : getSavedTargets()
  if (!dest.length) return

  const msg =
    `🔄 *ENTRE NO G1 — MARTINGALE*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📊 Estratégia: *${strategyName}*\n` +
    `⚡ Primeira entrada não bateu — *entre agora no dobro*\n` +
    `🎯 Saia em *2x* ou mais\n` +
    `⏱ ${hora()}`

  await sendToTargets(dest, msg, `gale_${strategyName}`)
  logger.info(`[WPP] Gale enviado — ${strategyName}`)
}

/**
 * Resultado — Win direto, Win G1 (martingale) ou Loss
 */
export async function alertResult(
  strategyName: string,
  result: 'win_g1' | 'win_g2' | 'loss',
  multiplier: number,
  targets?: string[],
): Promise<void> {
  if (state.conn !== 'open') return
  const dest = targets?.length ? targets : getSavedTargets()
  if (!dest.length) return

  let msg = ''

  if (result === 'win_g1') {
    msg =
      `✅ *WIN DIRETO!*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 Estratégia: *${strategyName}*\n` +
      `💰 Multiplicador: *${multiplier.toFixed(2)}x*\n` +
      `🏆 Primeira entrada — sem precisar de Martingale!\n` +
      `💪 Excelente resultado, continue disciplinado!\n` +
      `⏱ ${hora()}`
  } else if (result === 'win_g2') {
    msg =
      `✅ *WIN NO MARTINGALE (G1)!*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 Estratégia: *${strategyName}*\n` +
      `💰 Multiplicador: *${multiplier.toFixed(2)}x*\n` +
      `🔄 Recuperado na segunda entrada!\n` +
      `💪 Gestão funcionou — siga o plano sempre!\n` +
      `⏱ ${hora()}`
  } else {
    msg =
      `❌ *LOSS — STOP*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 Estratégia: *${strategyName}*\n` +
      `💸 Multiplicador: *${multiplier.toFixed(2)}x*\n` +
      `🛑 Loss confirmado\n` +
      `🧠 *Mantenha a gestão!* Loss faz parte — não emocione,\n` +
      `   respeite sua banca e aguarde o próximo sinal com calma.\n` +
      `⏱ ${hora()}`
  }

  await sendToTargets(dest, msg, `result_${strategyName}_${Date.now()}`)
  logger.info(`[WPP] Resultado enviado — ${result} ${multiplier.toFixed(2)}x`)
}

export async function testConnection(): Promise<{ ok: boolean; error?: string }> {
  const targets = getSavedTargets()
  if (state.conn !== 'open') return { ok: false, error: 'WhatsApp não conectado' }
  if (!targets.length)       return { ok: false, error: 'Nenhum destino selecionado' }
  try {
    await sendText(targets[0], `✅ *Teste de conexão*\nAviator Bot online!\n${new Date().toLocaleString('pt-BR')}`)
    return { ok: true }
  } catch (e: any) { return { ok: false, error: e.message } }
}

/** @deprecated use alertMarketPaying sem parâmetro bluePercent */
export async function alertStrategySignal(strategyName: string, signalMsg: string, targets?: string[]): Promise<void> {
  if (state.conn !== 'open') return
  const dest = targets?.length ? targets : getSavedTargets()
  if (!dest.length) return
  const msg = `🤖 *SINAL*\n📊 ${strategyName}\n📢 ${signalMsg}\n⏱ ${hora()}`
  await sendToTargets(dest, msg, `signal_${strategyName}`)
}