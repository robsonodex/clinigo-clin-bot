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
  BufferJSON,
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
const CLIN_SESSION_ID = process.env.CLIN_SESSION_ID || 'de000000-0000-0000-0000-000000000001'
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

// ========== SUPABASE STORAGE AUTH PERSISTENCE ==========
async function downloadAuthFromSupabase(): Promise<boolean> {
  const supabase = getSupabase()
  if (!supabase) return false

  try {
    let restoredAny = false

    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true })
    }

    // 1. Restaurar pasta multi-file (clin-sales-bot-files) com chaves pre-key/session
    const { data: files, error } = await supabase.storage
      .from('whatsapp-sessions')
      .list('clin-sales-bot-files')

    if (!error && files && files.length > 0) {
      for (const file of files) {
        if (file.name.startsWith('.')) continue
        const { data: fileData, error: downloadErr } = await supabase.storage
          .from('whatsapp-sessions')
          .download(`clin-sales-bot-files/${file.name}`)

        if (fileData && !downloadErr) {
          const buffer = Buffer.from(await fileData.arrayBuffer())
          fs.writeFileSync(path.join(AUTH_DIR, file.name), buffer)
        }
      }
      console.log(`[Clin] 📥 Credenciais multi-file restauradas do Supabase Storage (${files.length} arquivos)`)
      restoredAny = true
    }

    // 2. Restaurar/Garantir creds.json do formato single-file (tentando pasta UUID primeiro, depois clin-sales-bot)
    let singleData: any = null
    let singleErr: any = null

    const res1 = await supabase.storage
      .from('whatsapp-sessions')
      .download(`${CLIN_SESSION_ID}/default_auth_info.json`)
    
    if (res1.data && !res1.error) {
      singleData = res1.data
    } else {
      const res2 = await supabase.storage
        .from('whatsapp-sessions')
        .download('clin-sales-bot/default_auth_info.json')
      singleData = res2.data
      singleErr = res2.error
    }

    if (singleData) {
      const text = Buffer.from(await singleData.arrayBuffer()).toString('utf-8')
      const robustReviver = (key: string, value: any) => {
        if (value && typeof value === 'object' && value.type === 'Buffer') {
          if (typeof value.data === 'string') {
            return Buffer.from(value.data, 'base64')
          }
          if (Array.isArray(value.data)) {
            return Buffer.from(value.data)
          }
        }
        return BufferJSON.reviver(key, value)
      }
      const parsed = JSON.parse(text, robustReviver)
      if (parsed && parsed.creds) {
        if (parsed.creds.me && parsed.creds.me.id) {
          parsed.creds.registered = true
        }
        fs.writeFileSync(
          path.join(AUTH_DIR, 'creds.json'),
          JSON.stringify(parsed.creds, BufferJSON.replacer, 2)
        )
        console.log(`[Clin] 📥 Credenciais restauradas do Supabase Storage (default_auth_info.json) | me:`, parsed.creds.me?.id, '| registered:', parsed.creds.registered)
        restoredAny = true
      }
    }

    return restoredAny
  } catch (err: any) {
    console.error(`[Clin] Erro ao baixar credenciais do Supabase:`, err.message)
    return false
  }
}

async function uploadAuthToSupabase() {
  const supabase = getSupabase()
  if (!supabase) return

  try {
    if (!fs.existsSync(AUTH_DIR)) return

    const credsFile = path.join(AUTH_DIR, 'creds.json')
    if (fs.existsSync(credsFile)) {
      const robustReviver = (key: string, value: any) => {
        if (value && typeof value === 'object' && value.type === 'Buffer') {
          if (typeof value.data === 'string') {
            return Buffer.from(value.data, 'base64')
          }
          if (Array.isArray(value.data)) {
            return Buffer.from(value.data)
          }
        }
        return BufferJSON.reviver(key, value)
      }
      const credsContent = fs.readFileSync(credsFile, 'utf-8')
      const credsObj = JSON.parse(credsContent, robustReviver)
      if (credsObj && credsObj.me && credsObj.me.id) {
        credsObj.registered = true
      }
      const singlePayload = JSON.stringify({ creds: credsObj, keys: {} }, BufferJSON.replacer)
      const payloadBuffer = Buffer.from(singlePayload)

      // Upload para ambas as rotas de compatibilidade (UUID e nome)
      await Promise.all([
        supabase.storage
          .from('whatsapp-sessions')
          .upload(`${CLIN_SESSION_ID}/default_auth_info.json`, payloadBuffer, {
            contentType: 'application/json',
            upsert: true
          }),
        supabase.storage
          .from('whatsapp-sessions')
          .upload('clin-sales-bot/default_auth_info.json', payloadBuffer, {
            contentType: 'application/json',
            upsert: true
          })
      ])
    }

    const files = fs.readdirSync(AUTH_DIR)
    for (const file of files) {
      if (file.startsWith('.')) continue
      const filePath = path.join(AUTH_DIR, file)
      if (fs.statSync(filePath).isFile()) {
        const content = fs.readFileSync(filePath)
        await supabase.storage
          .from('whatsapp-sessions')
          .upload(`clin-sales-bot-files/${file}`, content, { upsert: true })
      }
    }
    console.log(`[Clin] 📤 Credenciais sincronizadas com Supabase Storage`)
  } catch (err: any) {
    console.error(`[Clin] Erro ao subir credenciais para Supabase:`, err.message)
  }
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

/**
 * Extrai o texto contido na mensagem Baileys (efêmera, botões, listas, etc)
 */
function extractMessageText(msg: any): string {
  const m = msg.message
  if (!m) return ''

  const message = m.ephemeralMessage?.message
    || m.viewOnceMessage?.message
    || m.viewOnceMessageV2?.message
    || m.documentWithCaptionMessage?.message
    || m

  return message.conversation
    || message.extendedTextMessage?.text
    || message.buttonsResponseMessage?.selectedButtonId
    || message.buttonsResponseMessage?.selectedDisplayText
    || message.listResponseMessage?.singleSelectReply?.selectedRowId
    || message.listResponseMessage?.title
    || message.templateButtonReplyMessage?.selectedId
    || message.imageMessage?.caption
    || message.videoMessage?.caption
    || ''
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

    // Enviar cada mensagem com delay rápido (300ms) entre elas
    for (let i = 0; i < messages.length; i++) {
      if (i > 0) {
        try { await socket.sendPresenceUpdate('composing', senderJid) } catch { /* */ }
        await delay(300)
      }

      try {
        await socket.sendMessage(senderJid, { text: messages[i] })
      } catch (sendErr: any) {
        console.error(`[Clin] ⚠️ Falha ao enviar para JID ${senderJid}:`, sendErr?.message || sendErr)
        // Fallback: se JID era @lid e falhou, tentar no formato padrão @s.whatsapp.net
        if (senderJid.endsWith('@lid')) {
          const fallbackJid = `${senderPhone}@s.whatsapp.net`
          console.log(`[Clin] 🔄 Tentando fallback para JID: ${fallbackJid}`)
          try {
            await socket.sendMessage(fallbackJid, { text: messages[i] })
          } catch (err2) {
            console.error(`[Clin] ❌ Falha também no fallback ${fallbackJid}:`, err2)
          }
        }
      }
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

    // Se transferiu, limpar timers de inatividade e notificar o Especialista no (21) 96553-2247
    if (data.transfer) {
      if (inactivityTimers.has(senderJid)) {
        clearTimeout(inactivityTimers.get(senderJid)!)
        inactivityTimers.delete(senderJid)
      }
      if (inactivityTimers24h.has(senderJid)) {
        clearTimeout(inactivityTimers24h.get(senderJid)!)
        inactivityTimers24h.delete(senderJid)
      }

      // 📲 Notificar o Especialista no WhatsApp (21 96553-2247)
      try {
        const lead = data.leadToSave || {}
        const rawPhone = senderPhone.replace(/\D/g, '')
        const cleanLeadPhone = rawPhone.startsWith('55') ? rawPhone : `55${rawPhone}`
        const specialistPhone = process.env.SPECIALIST_PHONE || '5521965532247'
        const specialistJid = `${specialistPhone}@s.whatsapp.net`

        const prefilledMsg = encodeURIComponent(
          `Olá ${lead.nome || ''}! Sou o especialista do CliniGo. Vi que você cadastrou a clínica ${lead.clinica || ''}. Como posso te ajudar?`
        )
        const waLink = `https://wa.me/${cleanLeadPhone}?text=${prefilledMsg}`

        const specialistText = `🚨 *NOVO LEAD QUALIFICADO NO BOT!* 🚨\n\n` +
          `👤 *Nome:* ${lead.nome || 'Não informado'}\n` +
          `🏥 *Clínica:* ${lead.clinica || 'Não informada'}\n` +
          `👥 *Equipe:* ${lead.numProfissionais || '?'} profissional(is)\n` +
          `💡 *Plano Indicado:* ${lead.planoIndicado || 'A definir'}\n` +
          `🎯 *Principal Interesse:* ${lead.dorPrincipal || 'Não informado'}\n` +
          `📱 *Telefone do Lead:* +${cleanLeadPhone}\n\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `👇 *CLIQUE NO LINK ABAIXO PARA INICIAR A CONVERSA:* \n` +
          `${waLink}`

        await socket.sendMessage(specialistJid, { text: specialistText })
        console.log(`[Clin] 📲 Notificação de lead enviada com sucesso para o Especialista (${specialistPhone})`)
      } catch (specErr: any) {
        console.error(`[Clin] ⚠️ Erro ao enviar notificação para o Especialista:`, specErr?.message || specErr)
      }
    }

  } catch (err) {
    console.error(`[Clin] ❌ Erro ao chamar API:`, err)
    try { await socket.sendPresenceUpdate('paused', senderJid) } catch { /* */ }
    await socket.sendMessage(senderJid, {
      text: 'Olá! 😊 Como posso te ajudar hoje?\n\n1 — O que é o CliniGo\n2 — Planos e preços\n3 — Demonstração gratuita\n4 — Funcionalidades\n5 — Falar com especialista'
    })
  } finally {
    try { await socket.sendPresenceUpdate('paused', senderJid) } catch { /* best effort */ }
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
    if (state.creds.me && state.creds.me.id) {
      state.creds.registered = true
    }
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
              clinic_id: CLIN_SESSION_ID,
              sector: 'default',
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
              }).eq('clinic_id', CLIN_SESSION_ID)
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

    socket.ev.on('creds.update', async () => {
      await saveCreds()
      uploadAuthToSupabase().catch(() => {})
    })

    // ===== LISTENER DE MENSAGENS =====
    socket.ev.on('messages.upsert', async (m) => {
      for (const msg of m.messages) {
        if (msg.key.fromMe) continue
        if (msg.key.remoteJid?.endsWith('@g.us')) continue
        if (msg.key.remoteJid === 'status@broadcast') continue

        const text = extractMessageText(msg)

        if (!text.trim()) continue

        let senderJid = msg.key.remoteJid!
        if (senderJid.endsWith('@lid') && (msg.key as any).remoteJidAlt) {
          const altJid = (msg.key as any).remoteJidAlt
          console.log(`[Clin] 🔀 JID @lid ${senderJid} convertido para remoteJidAlt: ${altJid}`)
          senderJid = altJid
        }

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
        const checkResult = await clinSocket.onWhatsApp(fullPhone)
        const result = checkResult && checkResult.length > 0 ? checkResult[0] : null
        
        if (result?.exists) {
          formattedJid = result.jid
          console.log(`[Clin] 🔍 onWhatsApp encontrou JID exato: ${formattedJid}`)
        } else if (fullPhone.length === 13) {
          // Tentar sem o 9 (muito comum no Brasil em DDDs fora de SP/RJ)
          const semNove = fullPhone.substring(0, 4) + fullPhone.substring(5)
          const checkSemNove = await clinSocket.onWhatsApp(semNove)
          const resSemNove = checkSemNove && checkSemNove.length > 0 ? checkSemNove[0] : null
          
          if (resSemNove?.exists) {
            formattedJid = resSemNove.jid
            console.log(`[Clin] 🔄 Número corrigido automaticamente (removido 9): ${semNove} -> JID: ${formattedJid}`)
          } else {
            console.log(`[Clin] ⚠️ Número ${fullPhone} não foi encontrado pelo Meta, trying default.`)
          }
        } else if (fullPhone.length === 12) {
          // Tentar com o 9
          const comNove = fullPhone.substring(0, 4) + '9' + fullPhone.substring(4)
          const checkComNove = await clinSocket.onWhatsApp(comNove)
          const resComNove = checkComNove && checkComNove.length > 0 ? checkComNove[0] : null
          
          if (resComNove?.exists) {
            formattedJid = resComNove.jid
            console.log(`[Clin] 🔄 Número corrigido automaticamente (adicionado 9): ${comNove} -> JID: ${formattedJid}`)
          } else {
            console.log(`[Clin] ⚠️ Número ${fullPhone} não foi encontrado pelo Meta, trying default.`)
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

  // ===== ENVIO DE IMAGEM =====
  app.post('/clin/send-image', async (req, res) => {
    const { to, imageBase64, caption } = req.body
    if (!to || !imageBase64) {
      return res.status(400).json({ error: 'Parâmetros "to" e "imageBase64" são obrigatórios' })
    }
    if (clinStatus !== 'connected' || !clinSocket) {
      return res.status(400).json({ error: 'WhatsApp não está conectado' })
    }
    try {
      // Limpar número para conter apenas dígitos
      const cleanPhone = to.replace(/\D/g, '')
      const fullPhone = cleanPhone.startsWith('55') ? cleanPhone : `55${cleanPhone}`
      let formattedJid = `${fullPhone}@s.whatsapp.net`

      // Validar e corrigir nono dígito usando onWhatsApp do Baileys
      try {
        const checkResult = await clinSocket.onWhatsApp(fullPhone)
        const result = checkResult && checkResult.length > 0 ? checkResult[0] : null
        
        if (result?.exists) {
          formattedJid = result.jid
          console.log(`[Clin] 🔍 onWhatsApp encontrou JID exato: ${formattedJid}`)
        } else if (fullPhone.length === 13) {
          const semNove = fullPhone.substring(0, 4) + fullPhone.substring(5)
          const checkSemNove = await clinSocket.onWhatsApp(semNove)
          const resSemNove = checkSemNove && checkSemNove.length > 0 ? checkSemNove[0] : null
          
          if (resSemNove?.exists) {
            formattedJid = resSemNove.jid
            console.log(`[Clin] 🔄 Número corrigido (removido 9): ${semNove} -> JID: ${formattedJid}`)
          }
        } else if (fullPhone.length === 12) {
          const comNove = fullPhone.substring(0, 4) + '9' + fullPhone.substring(4)
          const checkComNove = await clinSocket.onWhatsApp(comNove)
          const resComNove = checkComNove && checkComNove.length > 0 ? checkComNove[0] : null
          
          if (resComNove?.exists) {
            formattedJid = resComNove.jid
            console.log(`[Clin] 🔄 Número corrigido (adicionado 9): ${comNove} -> JID: ${formattedJid}`)
          }
        }
      } catch (err: any) {
        console.error('[Clin] Erro ao consultar onWhatsApp, usando JID padrão:', err.message)
      }

      // Higienizar a string base64 contra prefixos data-URI ou espaços em branco
      const cleanBase64 = imageBase64.replace(/^data:image\/[a-z]+;base64,/, '').trim()
      const imageBuffer = Buffer.from(cleanBase64, 'base64')
      
      await clinSocket.sendMessage(formattedJid, {
        image: imageBuffer,
        caption: caption || '',
        mimetype: 'image/jpeg'
      })

      console.log(`[Clin] 🖼️ Imagem enviada para ${formattedJid} (${Math.round(imageBuffer.length / 1024)}KB)`)
      res.json({ success: true })
    } catch (err: any) {
      console.error('[Clin] Erro ao enviar imagem:', err)
      res.status(500).json({ error: err.message || 'Erro ao enviar imagem' })
    }
  })

  console.log(`[Clin] 📡 Rotas: /clin/status, /clin/qr, /clin/connect, /clin/disconnect, /clin/send, /clin/send-image`)
}

// ========== AUTO-START ==========
export async function initClin() {
  manualDisconnect = false
  console.log(`[Clin] 🚀 Inicializando bot... Baixando credenciais do Supabase Storage...`)
  await downloadAuthFromSupabase()
  startClinSession().catch(console.error)
}
