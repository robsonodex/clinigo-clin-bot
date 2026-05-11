/**
 * Clin WhatsApp Chatbot — Baileys Integration
 * 
 * Roda 24/7 dentro do servidor Railway.
 * SESSÃO ETERNA: reconecta infinitamente.
 * Só desconecta se o usuário:
 * 1. Desconectar manualmente do celular (loggedOut)
 * 2. Chamar /clin/disconnect
 */

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WASocket,
  type ConnectionState,
} from '@whiskeysockets/baileys'
import { createClient } from '@supabase/supabase-js'
import pino from 'pino'
import * as fs from 'fs'
import * as path from 'path'
import type { Express } from 'express'

const logger = pino({ level: 'warn' })

// ========== CONFIG ==========
const CLIN_API_URL = process.env.CLIN_API_URL || 'https://clinigo.app/api/chatbot'
const AUTH_DIR = path.join(process.cwd(), '.clin-auth')

// ========== STATE ==========
let clinSocket: WASocket | null = null
let clinStatus: 'disconnected' | 'connecting' | 'connected' = 'disconnected'
let clinQrCode: string | null = null
let clinPhoneNumber: string | null = null
let reconnectAttempt = 0
let manualDisconnect = false // Flag para diferenciar desconexão manual vs queda
let keepAliveInterval: ReturnType<typeof setInterval> | null = null

// Histórico de conversas in-memory
const conversations = new Map<string, { role: string; content: string }[]>()

// ========== SUPABASE ==========
function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key)
}

// ========== KEEP-ALIVE ==========
function startKeepAlive() {
  stopKeepAlive()
  // Ping a cada 25s para manter a conexão viva
  keepAliveInterval = setInterval(() => {
    if (clinSocket && clinStatus === 'connected') {
      try {
        // Enviar presença para manter conexão
        clinSocket.sendPresenceUpdate('available')
      } catch (err) {
        console.error('[Clin] KeepAlive error:', err)
      }
    }
  }, 25_000)
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval)
    keepAliveInterval = null
  }
}

// ========== HANDLER DE MENSAGENS ==========
async function handleIncomingMessage(socket: WASocket, senderJid: string, text: string) {
  const senderPhone = senderJid.split('@')[0]

  if (!conversations.has(senderPhone)) {
    conversations.set(senderPhone, [])
  }
  const history = conversations.get(senderPhone)!
  history.push({ role: 'user', content: text })

  if (history.length > 20) {
    history.splice(0, history.length - 20)
  }

  try {
    await socket.presenceSubscribe(senderJid)
    await socket.sendPresenceUpdate('composing', senderJid)
  } catch { /* best effort */ }

  try {
    const response = await fetch(CLIN_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        sessionId: `wa-${senderPhone}`,
        sourcePage: 'whatsapp',
        history: history.slice(-10),
      }),
    })

    if (!response.ok) throw new Error(`API retornou ${response.status}`)

    const data = await response.json()
    const reply = data.reply || 'Desculpe, estou com dificuldade técnica. Tente novamente em instantes! 😊'

    history.push({ role: 'assistant', content: reply })

    try { await socket.sendPresenceUpdate('paused', senderJid) } catch { /* */ }

    await socket.sendMessage(senderJid, { text: reply })
    console.log(`[Clin] ✅ Respondido para ${senderPhone}`)

  } catch (err) {
    console.error(`[Clin] ❌ Erro ao chamar API:`, err)
    try { await socket.sendPresenceUpdate('paused', senderJid) } catch { /* */ }
    await socket.sendMessage(senderJid, {
      text: 'Oi! 😊 Estou com uma dificuldade técnica momentânea. Mas não se preocupe, nossa equipe já foi notificada e vai te atender em breve!'
    })
  }
}

// ========== INICIAR SESSÃO BAILEYS (SESSÃO ETERNA) ==========
async function startClinSession() {
  if (clinStatus === 'connecting') return
  if (manualDisconnect) return // Não reconectar se foi desconexão manual

  clinStatus = 'connecting'
  clinQrCode = null

  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true })
  }

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    const { version } = await fetchLatestBaileysVersion()

    const socket = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger as any),
      },
      logger: logger as any,
      printQRInTerminal: true,
      browser: ['CliniGo Clin', 'Chrome', '120.0.0'],
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      // Configurações para sessão eterna
      keepAliveIntervalMs: 30_000, // Heartbeat do Baileys a cada 30s
      retryRequestDelayMs: 500,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: undefined, // Sem timeout de query
      emitOwnEvents: false,
    })

    clinSocket = socket

    // ===== CONNECTION EVENTS =====
    socket.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        clinQrCode = qr
        clinStatus = 'connecting'
        console.log(`[Clin] 📱 QR Code gerado — escaneie pelo /clin/qr`)
      }

      if (connection === 'open') {
        clinStatus = 'connected'
        clinQrCode = null
        reconnectAttempt = 0 // Reset do contador
        clinPhoneNumber = socket.user?.id?.split(':')[0] || socket.user?.id?.split('@')[0] || null
        console.log(`[Clin] ✅ WhatsApp CONECTADO ETERNAMENTE (${clinPhoneNumber})`)

        // Iniciar keep-alive
        startKeepAlive()

        const supabase = getSupabase()
        if (supabase) {
          await supabase.from('whatsapp_sessions').upsert({
            clinic_id: 'clin-sales-bot',
            instance_name: 'clin-railway',
            status: 'connected',
            phone_number: clinPhoneNumber,
            connected_at: new Date().toISOString(),
            qr_code: null,
            error_message: null,
            last_health_check: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }, { onConflict: 'clinic_id' }).catch(() => {})
        }
      }

      if (connection === 'close') {
        stopKeepAlive()
        clinSocket = null
        clinQrCode = null

        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode
        const isLoggedOut = statusCode === DisconnectReason.loggedOut

        console.log(`[Clin] ⚠️ Conexão fechada (code=${statusCode}, loggedOut=${isLoggedOut})`)

        if (isLoggedOut) {
          // ÚNICO caso onde a sessão realmente morre:
          // o usuário desconectou do celular (ou /clin/disconnect)
          clinStatus = 'disconnected'
          clinPhoneNumber = null

          if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true })
          }

          const supabase = getSupabase()
          if (supabase) {
            await supabase.from('whatsapp_sessions').update({
              status: 'disconnected',
              disconnected_at: new Date().toISOString(),
              qr_code: null,
              phone_number: null,
              updated_at: new Date().toISOString(),
            }).eq('clinic_id', 'clin-sales-bot').catch(() => {})
          }

          console.log(`[Clin] 🔴 Sessão encerrada pelo celular. Escaneie novamente via /clin/qr.`)
        } else {
          // QUALQUER outro erro: reconecta SEMPRE, infinitamente
          reconnectAttempt++
          // Backoff: 2s, 4s, 8s, 16s, 30s (max 30s entre tentativas)
          const delay = Math.min(2000 * Math.pow(2, reconnectAttempt - 1), 30_000)
          
          console.log(`[Clin] 🔄 Reconexão #${reconnectAttempt} em ${delay / 1000}s...`)
          
          clinStatus = 'connecting'
          setTimeout(() => {
            startClinSession().catch((err) => {
              console.error('[Clin] Erro na reconexão:', err)
              // Mesmo com erro, tenta de novo
              setTimeout(() => startClinSession().catch(console.error), 10_000)
            })
          }, delay)
        }
      }
    })

    socket.ev.on('creds.update', saveCreds)

    // ===== LISTENER DE MENSAGENS =====
    socket.ev.on('messages.upsert', async (m) => {
      for (const msg of m.messages) {
        if (msg.key.fromMe) continue
        if (msg.key.remoteJid?.endsWith('@g.us')) continue
        if (msg.key.remoteJid === 'status@broadcast') continue

        const text = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || ''

        if (!text.trim()) continue

        const senderJid = msg.key.remoteJid!
        console.log(`[Clin] 📩 Mensagem de ${senderJid.split('@')[0]}: ${text.substring(0, 50)}`)

        try {
          await handleIncomingMessage(socket, senderJid, text)
        } catch (err) {
          console.error(`[Clin] Erro ao processar:`, err)
        }
      }
    })

    console.log(`[Clin] 🤖 Listener ativado — sessão eterna habilitada`)

  } catch (err) {
    console.error('[Clin] ❌ Erro ao criar sessão:', err)
    clinStatus = 'disconnected'
    
    // Reconectar mesmo quando o startClinSession dá erro
    const delay = Math.min(5000 * Math.pow(2, reconnectAttempt), 60_000)
    reconnectAttempt++
    console.log(`[Clin] 🔄 Tentando novamente em ${delay / 1000}s...`)
    setTimeout(() => startClinSession().catch(console.error), delay)
  }
}

// ========== EXPRESS ROUTES ==========
export function setupClinRoutes(app: Express) {
  app.get('/clin/status', (_req, res) => {
    res.json({
      status: clinStatus,
      phone_number: clinPhoneNumber,
      connected: clinStatus === 'connected',
      conversations_active: conversations.size,
      reconnect_attempts: reconnectAttempt,
      uptime: process.uptime(),
    })
  })

  app.get('/clin/qr', async (_req, res) => {
    if (clinStatus === 'connected') {
      return res.json({ status: 'connected', qr: null, phone_number: clinPhoneNumber })
    }

    // Iniciar sessão se necessário
    if (!clinQrCode && clinStatus !== 'connecting') {
      manualDisconnect = false
      startClinSession().catch(console.error)
    }

    // Esperar QR (até 15s)
    for (let i = 0; i < 30; i++) {
      if (clinQrCode || clinStatus === 'connected') break
      await new Promise(r => setTimeout(r, 500))
    }

    if (clinStatus === 'connected') {
      return res.json({ status: 'connected', qr: null, phone_number: clinPhoneNumber })
    }

    if (clinQrCode) {
      try {
        const QRCode = await import('qrcode')
        const qrDataUri = await QRCode.toDataURL(clinQrCode, { width: 300, margin: 2 })
        return res.json({ status: 'connecting', qr: qrDataUri })
      } catch {
        return res.json({ status: 'connecting', qr: null, raw_qr: clinQrCode })
      }
    }

    res.json({ status: clinStatus, qr: null })
  })

  app.post('/clin/connect', async (_req, res) => {
    manualDisconnect = false
    if (clinStatus === 'connected') {
      return res.json({ status: 'connected', phone_number: clinPhoneNumber })
    }
    startClinSession().catch(console.error)
    res.json({ status: 'connecting', message: 'Iniciando. Acesse /clin/qr para QR Code.' })
  })

  app.post('/clin/disconnect', async (_req, res) => {
    manualDisconnect = true // Bloqueia reconexão automática
    stopKeepAlive()

    if (clinSocket) {
      try {
        await clinSocket.logout()
      } catch {
        try { clinSocket.end(undefined) } catch { /* */ }
      }
    }

    clinSocket = null
    clinStatus = 'disconnected'
    clinPhoneNumber = null
    clinQrCode = null
    reconnectAttempt = 0
    conversations.clear()

    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true })
    }

    res.json({ status: 'disconnected' })
  })

  console.log(`[Clin] 📡 Rotas: /clin/status, /clin/qr, /clin/connect, /clin/disconnect`)
}

// ========== AUTO-START ==========
export function initClin() {
  manualDisconnect = false
  if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
    console.log(`[Clin] 🔄 Auth encontrado — reconectando automaticamente...`)
    startClinSession().catch(console.error)
  } else {
    console.log(`[Clin] ⏳ Aguardando conexão via /clin/connect ou /clin/qr`)
  }
}
