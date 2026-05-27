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

const logger = pino({ level: 'info' }) // INFO para diagnóstico

// ========== CONFIG ==========
const CLIN_API_URL = process.env.CLIN_API_URL || 'https://clinigo.app/api/chatbot'
const AUTH_DIR = path.join(process.cwd(), '.clin-auth')

// ========== STATE ==========
let clinSocket: WASocket | null = null
let clinStatus: string = 'disconnected'
let clinQrCode: string | null = null
let clinPhoneNumber: string | null = null
let reconnectAttempt = 0
let manualDisconnect = false
let isStarting = false
let keepAliveInterval: ReturnType<typeof setInterval> | null = null
let lastConnectionError: string | null = null // Debug: último erro

// Histórico de conversas in-memory
const conversations = new Map<string, { role: string; content: string }[]>()

// Timers de inatividade por sessão (30 minutos sem resposta → follow-up)
const inactivityTimers = new Map<string, ReturnType<typeof setTimeout>>()
const inactivityTimers24h = new Map<string, ReturnType<typeof setTimeout>>()
const INACTIVITY_TIMEOUT = 30 * 60 * 1000 // 30 minutos
const INACTIVITY_TIMEOUT_24H = 24 * 60 * 60 * 1000 // 24 horas

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
  keepAliveInterval = setInterval(() => {
    if (clinSocket && clinStatus === 'connected') {
      try {
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

// ========== DELAY HELPER ==========
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ========== INATIVIDADE ==========
function resetInactivityTimer(socket: WASocket, senderJid: string) {
  const key = senderJid
  
  // Limpar timers anteriores
  if (inactivityTimers.has(key)) {
    clearTimeout(inactivityTimers.get(key)!)
    inactivityTimers.delete(key)
  }
  if (inactivityTimers24h.has(key)) {
    clearTimeout(inactivityTimers24h.get(key)!)
    inactivityTimers24h.delete(key)
  }

  // Setar novo timer de 30 minutos
  const timer = setTimeout(async () => {
    try {
      const inactivityMsg = `Ei, ainda estou por aqui! 😊

Se quiser continuar de onde paramos, é só me chamar.

O *teste grátis de 7 dias* está te esperando:

👉 *https://clinigo.app/trial*

Até breve! 💙 — _Clin, Assistente CliniGo_`
      await socket.sendMessage(senderJid, { text: inactivityMsg })
      console.log(`[Clin] ⏰ Follow-up de inatividade (30min) enviado para ${senderJid.split('@')[0]}`)
      
      // Agendar o segundo follow-up para dali a 24 horas
      schedule24hFollowUp(socket, senderJid)
    } catch (err) {
      console.error(`[Clin] Erro ao enviar inatividade (30m):`, err)
    }
    inactivityTimers.delete(key)
  }, INACTIVITY_TIMEOUT)
  inactivityTimers.set(key, timer)
}

function schedule24hFollowUp(socket: WASocket, senderJid: string) {
  const key = senderJid
  if (inactivityTimers24h.has(key)) {
    clearTimeout(inactivityTimers24h.get(key)!)
  }
  
  const timer24h = setTimeout(async () => {
    try {
      // Atualizar o step da conversa no Supabase/Memory para 'recuperacao_24h' para receber resposta direcionada
      const supabase = getSupabase()
      if (supabase) {
        const { data: session } = await supabase
          .from('chatbot_sessions')
          .select('conversation_state')
          .eq('session_id', `wa-${senderJid.split('@')[0]}`)
          .single()
        
        if (session?.conversation_state) {
          const state = session.conversation_state as any
          state.step = 'recuperacao_24h'
          await supabase
            .from('chatbot_sessions')
            .update({ conversation_state: state })
            .eq('session_id', `wa-${senderJid.split('@')[0]}`)
        }
      }

      const msg24h = `Oi! Tudo bem? 😊

Vi que você ficou com dúvida sobre o CliniGo.

Se quiser, posso te conectar agora com um especialista — é rápido e sem compromisso.

✅ *1* — Quero falar com especialista
🚀 *2* — Prefiro testar grátis direto
🔙 *0* — Ver o menu novamente`
      
      await socket.sendMessage(senderJid, { text: msg24h })
      console.log(`[Clin] ⏰ Follow-up de inatividade (24h) enviado para ${senderJid.split('@')[0]}`)
    } catch (err) {
      console.error(`[Clin] Erro no follow-up de 24h:`, err)
    }
    inactivityTimers24h.delete(key)
  }, INACTIVITY_TIMEOUT_24H)
  
  inactivityTimers24h.set(key, timer24h)
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

  // Resetar timer de inatividade
  resetInactivityTimer(socket, senderJid)

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
        source: 'whatsapp',
      }),
    })

    if (!response.ok) throw new Error(`API retornou ${response.status}`)

    const data: any = await response.json()

    // Se sessão já foi transferida para humano → silenciar o bot completamente
    if (data.transfer === true && (!data.messages || data.messages.length === 0)) {
      console.log(`[Clin] 🔇 Sessão transferida para humano — bot silenciado para ${senderPhone}`)
      try { await socket.sendPresenceUpdate('paused', senderJid) } catch { /* */ }
      // Limpar timers de inatividade pois humano assumiu
      if (inactivityTimers.has(senderJid)) {
        clearTimeout(inactivityTimers.get(senderJid)!)
        inactivityTimers.delete(senderJid)
      }
      if (inactivityTimers24h.has(senderJid)) {
        clearTimeout(inactivityTimers24h.get(senderJid)!)
        inactivityTimers24h.delete(senderJid)
      }
      return
    }

    // Parsear array de mensagens (novo formato)
    const messages: string[] = data.messages || (data.reply ? [data.reply] : [])
    if (messages.length === 0) {
      messages.push('Desculpe, estou com dificuldade técnica. Tente novamente em instantes! 😊')
    }

    // Salvar no histórico
    for (const msg of messages) {
      history.push({ role: 'assistant', content: msg })
    }

    // Enviar cada mensagem com delay de 1.5s entre elas
    for (let i = 0; i < messages.length; i++) {
      if (i > 0) {
        // Indicar composing entre mensagens
        try { await socket.sendPresenceUpdate('composing', senderJid) } catch { /* */ }
        await delay(1500)
      }
      await socket.sendMessage(senderJid, { text: messages[i] })
    }

    try { await socket.sendPresenceUpdate('paused', senderJid) } catch { /* */ }

    console.log(`[Clin] ✅ Respondido para ${senderPhone} (${messages.length} msg${messages.length > 1 ? 's' : ''})`)

    // Se API indicou follow-up (trial), enviar após 30s
    if (data.sendFollowUp && data.followUpMessages) {
      setTimeout(async () => {
        try {
          for (let i = 0; i < data.followUpMessages.length; i++) {
            if (i > 0) await delay(1500)
            await socket.sendMessage(senderJid, { text: data.followUpMessages[i] })
          }
          console.log(`[Clin] ✅ Follow-up enviado para ${senderPhone}`)
        } catch (err) {
          console.error(`[Clin] Erro ao enviar follow-up:`, err)
        }
      }, 30000)
    }

    // Se transferiu, limpar timers de inatividade
    if (data.transfer) {
      if (inactivityTimers.has(senderJid)) {
        clearTimeout(inactivityTimers.get(senderJid)!)
        inactivityTimers.delete(senderJid)
      }
      if (inactivityTimers24h.has(senderJid)) {
        clearTimeout(inactivityTimers24h.get(senderJid)!)
        inactivityTimers24h.delete(senderJid)
      }
    }

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
  if (isStarting) return
  if (manualDisconnect) return

  isStarting = true
  clinStatus = 'connecting'
  clinQrCode = null
  lastConnectionError = null

  // Apenas criar o diretório se não existir — NUNCA apagar aqui
  // (apagar só no /clin/connect explícito ou loggedOut)
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true })
  }

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    const { version } = await fetchLatestBaileysVersion()
    console.log(`[Clin] 📡 Baileys v${version.join('.')} — iniciando sessão...`)

    const socket = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger as any),
      },
      logger: logger as any,
      printQRInTerminal: true,
      browser: ['Ubuntu', 'Chrome', '22.0.0'],
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      keepAliveIntervalMs: 30_000,
      retryRequestDelayMs: 500,
      connectTimeoutMs: 120_000,
    })

    clinSocket = socket

    // ===== CONNECTION EVENTS =====
    socket.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = update
      console.log(`[Clin] 🔄 connection.update:`, JSON.stringify({ connection, qr: !!qr, hasLastDisconnect: !!lastDisconnect }))

      if (qr) {
        clinQrCode = qr
        clinStatus = 'connecting'
        console.log(`[Clin] 📱 QR Code gerado — escaneie pelo /clin/qr`)
      }

      if (connection === 'open') {
        isStarting = false // Libertar guard
        clinStatus = 'connected'
        clinQrCode = null
        reconnectAttempt = 0 // Reset do contador
        clinPhoneNumber = socket.user?.id?.split(':')[0] || socket.user?.id?.split('@')[0] || null
        console.log(`[Clin] ✅ WhatsApp CONECTADO ETERNAMENTE (${clinPhoneNumber})`)

        // Iniciar keep-alive
        startKeepAlive()

        const supabase = getSupabase()
        if (supabase) {
          try {
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
            }, { onConflict: 'clinic_id' })
          } catch { /* best effort */ }
        }
      }

      if (connection === 'close') {
        isStarting = false // Libertar guard para permitir reconexão
        stopKeepAlive()
        clinSocket = null
        clinQrCode = null

        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode
        const errorMessage = (lastDisconnect?.error as any)?.message || 'unknown'
        const isLoggedOut = statusCode === DisconnectReason.loggedOut
        lastConnectionError = `code=${statusCode}, msg=${errorMessage}`

        // 408 = QR refs attempts ended (QR expirou sem escanear ou sessão inválida)
        // 401 = Unauthorized (credenciais inválidas)
        // 440 = Session replaced
        const isSessionInvalid = statusCode === 408 || statusCode === 401 || statusCode === 440

        console.log(`[Clin] ⚠️ Conexão fechada (code=${statusCode}, loggedOut=${isLoggedOut}, sessionInvalid=${isSessionInvalid}, error=${errorMessage})`)

        if (isLoggedOut || isSessionInvalid) {
          // Sessão morreu: loggedOut pelo celular, QR expirou, ou auth inválido
          // Limpar tudo e aguardar novo /clin/connect
          clinStatus = 'disconnected'
          clinPhoneNumber = null
          reconnectAttempt = 0

          if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true })
          }

          const supabase = getSupabase()
          if (supabase) {
            try {
              await supabase.from('whatsapp_sessions').update({
                status: 'disconnected',
                disconnected_at: new Date().toISOString(),
                qr_code: null,
                phone_number: null,
                updated_at: new Date().toISOString(),
              }).eq('clinic_id', 'clin-sales-bot')
            } catch { /* best effort */ }
          }

          console.log(`[Clin] 🔴 Sessão encerrada (${isLoggedOut ? 'loggedOut' : 'sessão inválida'}). Escaneie novamente via /clin/qr.`)
        } else if (reconnectAttempt >= 10) {
          // Limite de reconexão atingido — parar para evitar loop infinito
          clinStatus = 'disconnected'
          reconnectAttempt = 0
          
          if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true })
          }
          
          console.log(`[Clin] 🔴 Limite de reconexão atingido. Limpando auth. Reconecte via /clin/connect.`)
        } else {
          // Erro temporário: reconecta com backoff
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

    // Se está "connecting" mas sem QR e sem socket (sessão travada pós-redeploy), resetar
    if (clinStatus === 'connecting' && !clinQrCode && !clinSocket) {
      console.log('[Clin] ⚠️ Sessão travada em connecting sem socket — resetando...')
      isStarting = false
      clinStatus = 'disconnected'
    }

    // Iniciar sessão se necessário
    if (!clinQrCode && clinStatus !== 'connecting') {
      manualDisconnect = false
      isStarting = false // Garantir que não está travado
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

  // Debug endpoint
  app.get('/clin/debug', (_req, res) => {
    res.json({
      status: clinStatus,
      isStarting,
      manualDisconnect,
      hasSocket: !!clinSocket,
      hasQrCode: !!clinQrCode,
      phoneNumber: clinPhoneNumber,
      reconnectAttempt,
      lastConnectionError,
      authDirExists: fs.existsSync(AUTH_DIR),
      authCredsExists: fs.existsSync(path.join(AUTH_DIR, 'creds.json')),
      uptime: process.uptime(),
    })
  })

  app.post('/clin/connect', async (_req, res) => {
    manualDisconnect = false
    if (clinStatus === 'connected') {
      return res.json({ status: 'connected', phone_number: clinPhoneNumber })
    }

    // Limpar sessão anterior para forçar novo QR limpo
    isStarting = false
    if (clinSocket) {
      try { clinSocket.end(undefined) } catch { /* */ }
      clinSocket = null
    }
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true })
    }
    reconnectAttempt = 0

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

  app.post('/clin/send', async (req, res) => {
    const { to, text } = req.body
    if (!to || !text) {
      return res.status(400).json({ error: 'Parâmetros "to" e "text" são obrigatórios' })
    }
    if (clinStatus !== 'connected' || !clinSocket) {
      return res.status(400).json({ error: 'WhatsApp não está conectado' })
    }
    try {
      // Limpar número para conter apenas dígitos
      const cleanPhone = to.replace(/\D/g, '')
      const fullPhone = cleanPhone.startsWith('55') ? cleanPhone : `55${cleanPhone}`
      let formattedJid = `${fullPhone}@s.whatsapp.net`

      // 🔍 Validar e corrigir nono dígito usando onWhatsApp do Baileys
      try {
        const [result] = await clinSocket.onWhatsApp(fullPhone)
        if (result?.exists) {
          formattedJid = result.jid
          console.log(`[Clin] 🔍 onWhatsApp encontrou JID exato: ${formattedJid}`)
        } else if (fullPhone.length === 13) {
          // Tentar sem o 9 (muito comum no Brasil em DDDs fora de SP/RJ)
          const semNove = fullPhone.substring(0, 4) + fullPhone.substring(5)
          const [resSemNove] = await clinSocket.onWhatsApp(semNove)
          if (resSemNove?.exists) {
            formattedJid = resSemNove.jid
            console.log(`[Clin] 🔄 Número corrigido automaticamente (removido 9): ${semNove} -> JID: ${formattedJid}`)
          } else {
            console.log(`[Clin] ⚠️ Número ${fullPhone} não foi encontrado pelo Meta, tentando enviar para o JID original.`)
          }
        } else if (fullPhone.length === 12) {
          // Tentar com o 9
          const comNove = fullPhone.substring(0, 4) + '9' + fullPhone.substring(4)
          const [resComNove] = await clinSocket.onWhatsApp(comNove)
          if (resComNove?.exists) {
            formattedJid = resComNove.jid
            console.log(`[Clin] 🔄 Número corrigido automaticamente (adicionado 9): ${comNove} -> JID: ${formattedJid}`)
          } else {
            console.log(`[Clin] ⚠️ Número ${fullPhone} não foi encontrado pelo Meta, tentando enviar para o JID original.`)
          }
        }
      } catch (err: any) {
        console.error('[Clin] Erro ao consultar onWhatsApp, usando JID padrão:', err.message)
      }
      
      await clinSocket.sendMessage(formattedJid, { text })
      console.log(`[Clin] 🚀 Mensagem enviada manualmente para ${formattedJid}: ${text.substring(0, 50)}`)
      res.json({ success: true })
    } catch (err: any) {
      console.error('[Clin] Erro ao enviar mensagem manual:', err)
      res.status(500).json({ error: err.message || 'Erro ao enviar mensagem' })
    }
  })

  console.log(`[Clin] 📡 Rotas: /clin/status, /clin/qr, /clin/connect, /clin/disconnect, /clin/send`)
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
