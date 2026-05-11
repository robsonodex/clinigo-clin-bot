/**
 * Clin WhatsApp Sales Bot — Standalone Service
 * 
 * Serviço independente para rodar no Railway 24/7.
 * Express server + Baileys WhatsApp listener.
 */

import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { setupClinRoutes, initClin } from './clin-chatbot'

dotenv.config()

const app = express()

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true
}))
app.use(express.json())

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'clinigo-clin-bot',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  })
})

// Clin WhatsApp routes
setupClinRoutes(app)

const PORT = process.env.PORT || 3002

app.listen(PORT, () => {
  console.log(`🤖 Clin Bot Service`)
  console.log(`🌐 HTTP: http://localhost:${PORT}`)
  console.log(`✅ Server running`)

  // Auto-iniciar Clin
  initClin()
})

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing...')
  process.exit(0)
})
