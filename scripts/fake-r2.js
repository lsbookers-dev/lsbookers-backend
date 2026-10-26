// scripts/fake-r2.js — Faux stockage R2 pour les essais EN LOCAL de l'envoi direct (#275).
// PUT / GET (avec Range) / HEAD / DELETE, adresses « /bucket/clé ». CORS=0 imite R2 sans règle CORS.
// Lancé par .claude/launch.json (fake-r2, fake-r2-sans-cors) avec backend-local-fake-r2. Journal : GET /__log
const http = require('http')
const store = new Map()
const cors = process.env.CORS !== '0'
const log = []
http.createServer((req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0])
  const hdr = cors ? {
    'Access-Control-Allow-Origin': 'http://localhost:3000',
    'Access-Control-Allow-Methods': 'PUT, GET, HEAD',
    'Access-Control-Allow-Headers': 'content-type, cache-control',
  } : {}
  if (req.method === 'OPTIONS') { res.writeHead(cors ? 204 : 403, hdr); return res.end() }
  if (path === '/__log') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ log, objets: [...store.keys()] })) }
  if (req.method === 'PUT') {
    const chunks = []
    req.on('data', c => chunks.push(c)).on('end', () => {
      const body = Buffer.concat(chunks)
      store.set(path, { body, type: req.headers['content-type'] || 'application/octet-stream' })
      log.push(`PUT ${path} ${body.length} octets (${req.headers['content-type']}) ${req.url.includes('X-Amz-Signature') ? 'via adresse signée (navigateur)' : 'par le serveur'}`)
      res.writeHead(200, { ...hdr, ETag: '"x"' }); res.end()
    })
    return
  }
  const obj = store.get(path)
  if (req.method === 'DELETE') { store.delete(path); log.push(`DELETE ${path}`); res.writeHead(204, hdr); return res.end() }
  if (!obj) { res.writeHead(404, { ...hdr, 'Content-Type': 'application/xml' }); return res.end('<Error><Code>NoSuchKey</Code></Error>') }
  const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '')
  if (range) {
    const [s, e] = [Number(range[1]), Math.min(Number(range[2]), obj.body.length - 1)]
    res.writeHead(206, { ...hdr, 'Content-Type': obj.type, 'Content-Range': `bytes ${s}-${e}/${obj.body.length}`, 'Content-Length': e - s + 1 })
    return res.end(obj.body.subarray(s, e + 1))
  }
  res.writeHead(200, { ...hdr, 'Content-Type': obj.type, 'Content-Length': obj.body.length })
  res.end(req.method === 'HEAD' ? undefined : obj.body)
}).listen(9000, () => console.log(`faux R2 sur :9000 (CORS ${cors ? 'activé' : 'absent'})`))
