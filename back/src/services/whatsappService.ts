/**
 * whatsappService.ts — Baileys socket direto
 *
 * npm i @whiskeysockets/baileys @hapi/boom qrcode
 * npm i -D @types/qrcode
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
import { Candle } from '../types/index.js'
import { EventEmitter } from 'events'

// ─── Config ───────────────────────────────────────────────────────────────────

const SESSION_PATH       = process.env.WPP_SESSION_PATH  || './wpp-session'
const PAY_THRESHOLD      = parseFloat(process.env.WPP_PAY_THRESHOLD || '2')
const MIN_INTERVAL       = parseInt(process.env.WPP_MIN_INTERVAL_MS || '5000')
const PAY_ALERT_COOLDOWN = 10 * 60 * 1000 // 10 minutos

// ─── Logger silencioso compatível com Pino ────────────────────────────────────

const silentChild: any = {
  level:  'silent',
  trace:  () => {},
  debug:  () => {},
  info:   () => {},
  warn:   () => {},
  error:  () => {},
  fatal:  () => {},
  child:  () => silentChild,
}

// ─── Estado global ────────────────────────────────────────────────────────────

export type ConnState = 'close' | 'connecting' | 'open' | 'error'

interface WppState {
  conn:          ConnState
  qrBase64:      string | null
  socket:        WASocket | null
  isConnecting:  boolean
  retryTimer:    ReturnType<typeof setTimeout> | null
  retryCount:    number
  groups:        { id: string; name: string; size: number }[]
  contacts:      { id: string; name: string; phone: string }[]
  targets:       string[]
  lastPayAlertAt: number
}

const state: WppState = {
  conn:           'close',
  qrBase64:       null,
  socket:         null,
  isConnecting:   false,
  retryTimer:     null,
  retryCount:     0,
  groups:         [],
  contacts:       [],
  targets:        [],
  lastPayAlertAt: 0,
}

export const wppEvents = new EventEmitter()

// ─── Anti-spam ────────────────────────────────────────────────────────────────

const lastSentAt = new Map<string, number>()
function canSend(key: string): boolean { return Date.now() - (lastSentAt.get(key) ?? 0) >= MIN_INTERVAL }
function markSent(key: string): void   { lastSentAt.set(key, Date.now()) }

// ─── Helpers públicos ─────────────────────────────────────────────────────────

export function getConnState():              ConnState           { return state.conn }
export function getQrBase64():               string | null       { return state.qrBase64 }
export function getSavedTargets():           string[]            { return state.targets }
export function setSavedTargets(t: string[]): void              { state.targets = t; logger.info(`[WPP] Targets: ${t.length}`) }
export function getGroups():                 WppState['groups']  { return state.groups }
export function getContacts():               WppState['contacts']{ return state.contacts }
export function isConfigured():              boolean             { return state.conn === 'open' }
export function getPayThreshold():           number              { return PAY_THRESHOLD }

// ─── Retry ───────────────────────────────────────────────────────────────────

function scheduleRetry(): void {
  if (state.retryCount >= 5) {
    state.conn         = 'close'
    state.isConnecting = false
    logger.error('[WPP] Máximo de tentativas atingido')
    wppEvents.emit('state', 'close')
    return
  }
  state.retryCount++
  const delay = Math.min(5000 * state.retryCount, 30_000)
  logger.warn(`[WPP] Reconectando em ${delay / 1000}s (tentativa ${state.retryCount}/5)`)
  if (state.retryTimer) clearTimeout(state.retryTimer)
  state.retryTimer = setTimeout(() => {
    state.isConnecting = false
    startConnection()
  }, delay)
}

// ─── Conexão Baileys ──────────────────────────────────────────────────────────

export async function startConnection(): Promise<void> {
  if (state.isConnecting) {
    logger.info('[WPP] Já conectando — ignorando chamada duplicada')
    return
  }
  state.isConnecting = true
  state.conn         = 'connecting'
  state.qrBase64     = null
  wppEvents.emit('state', 'connecting')

  try {
    const sessionDir = path.resolve(SESSION_PATH)
    const { state: authState, saveCreds } = await useMultiFileAuthState(sessionDir)
    const { version } = await fetchLatestBaileysVersion()

    logger.info(`[WPP] Baileys v${version.join('.')}`)

    const sock = makeWASocket({
      version,
      auth: {
        creds: authState.creds,
        keys:  makeCacheableSignalKeyStore(authState.keys, undefined as any),
      },
      syncFullHistory:            false,
      generateHighQualityLinkPreview: false,
      browser:                    ['Ubuntu', 'Chrome', '22.0.0.75'],
      logger:                     silentChild,
      connectTimeoutMs:           60_000,
      keepAliveIntervalMs:        10_000,
    })

    state.socket = sock

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        try {
          state.qrBase64 = await QRCode.toDataURL(qr)
          wppEvents.emit('qr', state.qrBase64)
          logger.info('[WPP] QR Code gerado')
        } catch (e: any) {
          logger.error(`[WPP] Erro ao gerar QR: ${e.message}`)
        }
      }

      if (connection === 'open') {
        state.conn         = 'open'
        state.qrBase64     = null
        state.isConnecting = false
        state.retryCount   = 0
        if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = null }
        wppEvents.emit('state', 'open')
        logger.info('[WPP] ✅ WhatsApp conectado!')
        await loadGroupsAndContacts(sock)
      }

      if (connection === 'close') {
        const boom   = lastDisconnect?.error as Boom | undefined
        const reason = boom?.output?.statusCode
        const label  = DisconnectReason[reason as number] ?? reason
        logger.warn(`[WPP] Conexão fechada — motivo: ${label} (${reason})`)

        state.socket       = null
        state.isConnecting = false

        if (reason === DisconnectReason.loggedOut) {
          state.conn       = 'close'
          state.retryCount = 0
          wppEvents.emit('state', 'close')
          logger.error('[WPP] Deslogado — escaneie o QR novamente')
          return
        }

        state.conn = 'connecting'
        wppEvents.emit('state', 'connecting')
        scheduleRetry()
      }
    })

    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('groups.update', async () => {
      if (state.conn === 'open') await loadGroupsAndContacts(sock)
    })

  } catch (err: any) {
    logger.error(`[WPP] Erro crítico: ${err.message}`)
    state.socket       = null
    state.isConnecting = false
    state.conn         = 'connecting'
    wppEvents.emit('state', 'connecting')
    scheduleRetry()
  }
}

// ─── Grupos ───────────────────────────────────────────────────────────────────

async function loadGroupsAndContacts(sock: WASocket): Promise<void> {
  try {
    const groupMap: Record<string, GroupMetadata> = await sock.groupFetchAllParticipating()
    state.groups = Object.values(groupMap).map(g => ({
      id:   g.id,
      name: g.subject,
      size: g.participants?.length ?? 0,
    }))
    logger.info(`[WPP] ${state.groups.length} grupos carregados`)
    state.contacts = []
  } catch (err: any) {
    logger.warn(`[WPP] Erro ao carregar grupos: ${err.message}`)
  }
}

// ─── Desconectar ──────────────────────────────────────────────────────────────

export async function disconnect(): Promise<void> {
  if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = null }
  state.retryCount   = 0
  state.isConnecting = false
  if (state.socket) { await state.socket.logout().catch(() => {}); state.socket = null }
  state.conn     = 'close'
  state.qrBase64 = null
  state.groups   = []
  state.contacts = []
  wppEvents.emit('state', 'close')
  logger.info('[WPP] Desconectado')
}

// ─── Envio base ───────────────────────────────────────────────────────────────

async function sendText(jid: string, text: string): Promise<void> {
  if (!state.socket || state.conn !== 'open') throw new Error('WhatsApp não conectado')
  await state.socket.sendMessage(jid, { text })
}

async function sendToTargets(targets: string[], message: string, spamKey: string): Promise<void> {
  if (!targets.length)    { logger.warn('[WPP] Nenhum destino'); return }
  if (!canSend(spamKey))  { logger.info('[WPP] Anti-spam ativo'); return }
  markSent(spamKey)
  for (const jid of targets) {
    try   { await sendText(jid, message); logger.info(`[WPP] ✅ → ${jid}`) }
    catch (e: any) { logger.error(`[WPP] ❌ → ${jid}: ${e.message}`) }
  }
}

// ─── Alertas inteligentes ─────────────────────────────────────────────────────

/**
 * Aviator pagando — enviado apenas se <45% azuis e cooldown de 10min
 */
export async function alertMarketPaying(bluePercent: number, targets?: string[]): Promise<void> {
  if (state.conn !== 'open') return
  const dest = targets?.length ? targets : getSavedTargets()
  if (!dest.length) return

  // Cooldown de 10 minutos
  if (Date.now() - state.lastPayAlertAt < PAY_ALERT_COOLDOWN) return
  state.lastPayAlertAt = Date.now()

  const msg =
    `🟢 *AVIATOR EM MOMENTO FAVORÁVEL*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📊 Azuis nas últimas 20 velas: *${(bluePercent * 100).toFixed(0)}%*\n` +
    `✅ Gráfico abaixo de 45% — bom momento para operar\n` +
    `⏱ ${new Date().toLocaleTimeString('pt-BR')}`

  await sendToTargets(dest, msg, 'market_paying')
  logger.info('[WPP] Alerta de mercado favorável enviado')
}

/**
 * Pré-sinal — enviado 1 vela antes da entrada
 */
export async function alertWarning(strategyName: string, targets?: string[]): Promise<void> {
  if (state.conn !== 'open') return
  const dest = targets?.length ? targets : getSavedTargets()
  if (!dest.length) return

  const msg =
    `⚠️ *ATENÇÃO — PRÉ-SINAL*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📊 Estratégia: *${strategyName}*\n` +
    `🔎 Padrão identificado — possível entrada na próxima vela\n` +
    `👀 Fique de olho!\n` +
    `⏱ ${new Date().toLocaleTimeString('pt-BR')}`

  await sendToTargets(dest, msg, `warning_${strategyName}`)
  logger.info(`[WPP] Pré-sinal enviado — ${strategyName}`)
}

/**
 * Entrada confirmada
 */
export async function alertConfirmed(strategyName: string, targets?: string[]): Promise<void> {
  if (state.conn !== 'open') return
  const dest = targets?.length ? targets : getSavedTargets()
  if (!dest.length) return

  const msg =
    `🚀 *ENTRADA CONFIRMADA*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📊 Estratégia: *${strategyName}*\n` +
    `🎯 Entre agora com proteção até *G1*\n` +
    `💡 Saia em *2x* ou mais\n` +
    `⏱ ${new Date().toLocaleTimeString('pt-BR')}`

  await sendToTargets(dest, msg, `confirmed_${strategyName}`)
  logger.info(`[WPP] Entrada confirmada enviada — ${strategyName}`)
}

/**
 * Resultado — Win G1, Win G2 (Martingale) ou Loss
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

  const time = new Date().toLocaleTimeString('pt-BR')
  let msg = ''

  if (result === 'win_g1') {
    msg =
      `✅ *WIN — VITÓRIA DIRETA*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 Estratégia: *${strategyName}*\n` +
      `💰 Multiplicador: *${multiplier.toFixed(2)}x*\n` +
      `🏆 Resultado: *Win G1*\n` +
      `⏱ ${time}`
  } else if (result === 'win_g2') {
    msg =
      `✅ *WIN — MARTINGALE*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 Estratégia: *${strategyName}*\n` +
      `💰 Multiplicador: *${multiplier.toFixed(2)}x*\n` +
      `🔄 Resultado: *Win G2 (Martingale)*\n` +
      `⚠️ Recuperado na segunda entrada\n` +
      `⏱ ${time}`
  } else {
    msg =
      `❌ *LOSS — STOP*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 Estratégia: *${strategyName}*\n` +
      `💸 Multiplicador: *${multiplier.toFixed(2)}x*\n` +
      `🛑 Resultado: *Loss*\n` +
      `😤 Aguarde o próximo sinal\n` +
      `⏱ ${time}`
  }

  await sendToTargets(dest, msg, `result_${strategyName}_${Date.now()}`)
  logger.info(`[WPP] Resultado enviado — ${result} ${multiplier}x`)
}

/**
 * Alerta legado — mantido para compatibilidade
 */
export async function alertStrategySignal(
  strategyName: string,
  signalMsg:    string,
  targets?:     string[],
): Promise<void> {
  if (state.conn !== 'open') return
  const dest = targets?.length ? targets : getSavedTargets()
  if (!dest.length) return
  const msg =
    `🤖 *SINAL*\n` +
    `📊 ${strategyName}\n` +
    `📢 ${signalMsg}\n` +
    `⏱ ${new Date().toLocaleTimeString('pt-BR')}`
  await sendToTargets(dest, msg, `signal_${strategyName}`)
}

export async function testConnection(): Promise<{ ok: boolean; error?: string }> {
  const targets = getSavedTargets()
  if (state.conn !== 'open') return { ok: false, error: 'WhatsApp não conectado' }
  if (!targets.length)       return { ok: false, error: 'Nenhum destino selecionado' }
  try {
    await sendText(targets[0], `✅ *Teste de conexão*\nAviator Bot online!\n${new Date().toLocaleString('pt-BR')}`)
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
}