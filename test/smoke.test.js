const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

for (const key of ['UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN','ADMIN_USER','ADMIN_PASS','SESSION_SECRET']) delete process.env[key];
const app = require('../server');

let server;
let base;
test.before(async () => {
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});

test('arquivos públicos principais existem', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'index.html')));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'admin.html')));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'vercel.json')));
});

test('página inicial / entrega o HTML original', async () => {
  const response = await fetch(`${base}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/html/);
  assert.match(html, /Cutify/i);
  assert.doesNotMatch(html, /Rota da API não encontrada/);
});

test('painel /admin entrega o HTML original', async () => {
  const response = await fetch(`${base}/admin`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/html/);
  assert.match(html, /Cutify/i);
});

test('health responde sem banco sem fingir conexão', async () => {
  const response = await fetch(`${base}/api/health`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.database, 'not_configured');
  assert.equal(body.status, 'degraded');
});

test('API desconhecida retorna 404 JSON', async () => {
  const response = await fetch(`${base}/api/nao-existe`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'Rota da API não encontrada');
});

test('login informa configuração ausente', async () => {
  const response = await fetch(`${base}/api/login`, {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({user:'admin',pass:'teste'})
  });
  assert.equal(response.status, 503);
});

test('JSON malformado retorna 400', async () => {
  const response = await fetch(`${base}/api/login`, {
    method: 'POST', headers: {'content-type':'application/json'}, body: '{'
  });
  assert.equal(response.status, 400);
});
