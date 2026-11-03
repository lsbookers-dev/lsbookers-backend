// scripts/loadtest/sockets.js — Connexions temps réel des membres virtuels (test de charge, étape 7).
// Ouvre une connexion Socket.io par membre, progressivement, et les garde ouvertes pendant le test.
//   node sockets.js <adresse du serveur de TEST> <nombre> <durée en s> [chemin de socket.io-client]
// Affiche chaque minute : connectés, en échec, déconnexions, temps moyen de connexion.
const fs = require('fs')
const path = require('path')
const [target, countArg = '1000', durationArg = '900', clientPath = 'socket.io-client'] = process.argv.slice(2)
if (!target || /api\.lsbookers\.com|lsbookers-backend-production/.test(target)) {
  throw new Error('Cible manquante ou production : ce script ne vise que le serveur de test')
}
const { io } = require(clientPath)
const tokens = fs.readFileSync(path.join(__dirname, 'tokens.csv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split(',')[1])
const COUNT = Number(countArg)
const DURATION = Number(durationArg) * 1000
const RAMP_MS = Math.min(600000, DURATION / 2) // montée sur 10 min max, comme le scénario

const stats = { connected: 0, failed: 0, disconnects: 0, events: 0, connectMs: [] }
const sockets = []
for (let i = 0; i < COUNT; i++) {
  setTimeout(() => {
    const started = Date.now()
    const socket = io(target, { auth: { token: tokens[i % tokens.length] }, transports: ['websocket'], reconnection: false, timeout: 20000 })
    socket.on('connect', () => { stats.connected++; stats.connectMs.push(Date.now() - started) })
    socket.on('connect_error', () => { stats.failed++ })
    socket.on('disconnect', (reason) => { if (reason !== 'io client disconnect') { stats.connected--; stats.disconnects++ } })
    socket.onAny(() => { stats.events++ })
    sockets.push(socket)
  }, Math.floor((i / COUNT) * RAMP_MS))
}

const report = () => {
  const avg = stats.connectMs.length ? Math.round(stats.connectMs.reduce((a, b) => a + b, 0) / stats.connectMs.length) : 0
  console.log(`${new Date().toLocaleTimeString('fr-FR')} temps réel : ${stats.connected} connectés, ${stats.failed} échecs, ${stats.disconnects} coupures, ${stats.events} événements reçus, connexion en ${avg} ms en moyenne`)
}
const timer = setInterval(report, 60000)
setTimeout(() => { report(); clearInterval(timer); sockets.forEach((s) => s.close()); process.exit(0) }, DURATION)
