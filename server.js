/** Cutify Recruitment API - Vercel Serverless compatible. */
const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.use(express.json({ limit: '200kb' }));

const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;
const SESSION_SECRET = process.env.SESSION_SECRET;
const WEBHOOK_URL = String(process.env.WEBHOOK_URL || '').trim().replace(/^['"]|['"]$/g, '');
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const DB_KEY = 'cutify:recruitment:db:v1';
const COOKIE = 'cutify_admin';
const ROLES = ['administrador','moderador','suporte','editor','designer','divulgacao','desenvolvedor','outros'];
const STATUSES = ['pendente','em_analise','aprovada','recusada'];

function str(v, max) { return v == null ? '' : String(v).trim().slice(0, max); }
function validateApp(body = {}) {
  const main = str(body.cargo_principal, 30), secondary = str(body.cargo_secundario, 30);
  const age = Number.parseInt(body.idade, 10);
  return {
    nome: str(body.nome,100), idade: Number.isFinite(age) ? age : 0,
    discord_user: str(body.discord_user,50), discord_id: str(body.discord_id,25),
    pais: str(body.pais,50), fuso: str(body.fuso,50),
    cargo_principal: ROLES.includes(main) ? main : 'outros',
    cargo_secundario: ROLES.includes(secondary) ? secondary : '',
    cargo_outro: str(body.cargo_outro,120), experiencia: str(body.experiencia,2000),
    tempo_disponivel: str(body.tempo_disponivel,100),
    q1:str(body.q1,2000), q2:str(body.q2,2000), q3:str(body.q3,2000),
    q4:str(body.q4,2000), q5:str(body.q5,2000), q6:str(body.q6,2000), q7:str(body.q7,2000)
  };
}
function dbConfigured() { return !!(REDIS_URL && REDIS_TOKEN); }
async function redis(command) {
  if (!dbConfigured()) throw new Error('Banco de dados não configurado. Configure UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN.');
  const response = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) throw new Error(payload.error || `Redis HTTP ${response.status}`);
  return payload.result;
}
async function loadDB() {
  const raw = await redis(['GET', DB_KEY]);
  if (!raw) return { candidaturas: [], historico: [] };
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return { candidaturas: Array.isArray(parsed.candidaturas) ? parsed.candidaturas : [], historico: Array.isArray(parsed.historico) ? parsed.historico : [] };
}
async function saveDB(db) { await redis(['SET', DB_KEY, JSON.stringify(db)]); }

// Serialize read-modify-write operations across concurrent Vercel instances.
const LOCK_KEY = `${DB_KEY}:lock`;
async function withDBLock(work) {
  const lockToken = crypto.randomBytes(18).toString('hex');
  let acquired = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await redis(['SET', LOCK_KEY, lockToken, 'NX', 'PX', 30000]);
    if (result === 'OK') { acquired = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100 + Math.floor(Math.random() * 100)));
  }
  if (!acquired) throw new Error('Não foi possível obter o bloqueio do banco. Tente novamente.');
  try {
    return await work();
  } finally {
    // Compare-and-delete prevents releasing a lock acquired by another request after expiry.
    await redis(['EVAL', "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", '1', LOCK_KEY, lockToken]).catch(error => {
      console.error('[Redis lock release]', error.message);
    });
  }
}

function sign(value) { return crypto.createHmac('sha256', SESSION_SECRET || 'missing-secret').update(value).digest('hex'); }
function makeToken() {
  const payload = Buffer.from(JSON.stringify({ admin: true, exp: Date.now() + 8*60*60*1000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function isAuthenticated(req) {
  if (!SESSION_SECRET) return false;
  const cookies = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const item = part.trim();
    const index = item.indexOf('=');
    if (index < 1) continue;
    try { cookies[item.slice(0, index)] = decodeURIComponent(item.slice(index + 1)); } catch { return false; }
  }
  const token = cookies[COOKIE]; if (!token) return false;
  const parts = token.split('.'); if (parts.length !== 2) return false;
  const expected = Buffer.from(sign(parts[0])); const actual = Buffer.from(parts[1]);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return false;
  try { const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); return data.admin === true && data.exp > Date.now(); } catch { return false; }
}
function requireAuth(req,res,next) { if (isAuthenticated(req)) return next(); return res.status(401).json({ error:'Não autorizado' }); }
function clip(v, max=700) { const s = String(v == null ? '' : v).trim(); if (!s) return '(vazio)'; return s.length <= max ? s : s.slice(0,max-1)+'…'; }
function prettyRole(r) { return ({administrador:'Administrador',moderador:'Moderador',suporte:'Suporte',editor:'Editor',designer:'Designer',divulgacao:'Divulgação',desenvolvedor:'Desenvolvedor',outros:'Outros'})[r] || r || '-'; }
function buildEmbeds(c) {
  const role = c.cargo_principal === 'outros' && c.cargo_outro ? `Outros - ${clip(c.cargo_outro,100)}` : prettyRole(c.cargo_principal);
  const date = new Date(c.criado_em).toISOString();
  return [
    { title:`Nova Candidatura - ${c.id}`, color:0xffffff, description:`Recebida em ${date}`, fields:[
      {name:'Nome',value:clip(c.nome,100),inline:true},{name:'Idade',value:String(c.idade),inline:true},{name:'País',value:clip(c.pais,50),inline:true},
      {name:'Discord',value:clip(c.discord_user,50),inline:true},{name:'ID Discord',value:clip(c.discord_id,25),inline:true},{name:'Fuso',value:clip(c.fuso,50),inline:true},
      {name:'Cargo Principal',value:role,inline:true},{name:'Cargo Secundário',value:c.cargo_secundario?prettyRole(c.cargo_secundario):'Não informado',inline:true},
      {name:'Tempo Disponível',value:clip(c.tempo_disponivel,100),inline:true},{name:'Experiência',value:clip(c.experiencia),inline:false}],
      footer:{text:'Cutify Community - Recrutamento'},timestamp:date },
    { title:`Respostas da Candidatura - ${c.id}`, color:0xffffff, fields:[
      {name:'Por que deseja entrar na equipe?',value:clip(c.q1),inline:false},{name:'Principais habilidades',value:clip(c.q2),inline:false},
      {name:'Já trabalhou em equipe?',value:clip(c.q3),inline:false},{name:'Como lidaria com conflitos?',value:clip(c.q4),inline:false},
      {name:'Desrespeito de membro da equipe',value:clip(c.q5),inline:false},{name:'Por que deveríamos escolher você?',value:clip(c.q6),inline:false},
      {name:'O que pretende melhorar?',value:clip(c.q7),inline:false}],footer:{text:'Cutify Community - Recrutamento'} }
  ];
}
async function sendWebhook(c) {
  if (!WEBHOOK_URL) return { ok:false, reason:'no_url' };
  if (!/^https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+/.test(WEBHOOK_URL)) return {ok:false,reason:'invalid_url'};
  try {
    const response = await fetch(WEBHOOK_URL + (WEBHOOK_URL.includes('?')?'&':'?') + 'wait=true', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username:'Cutify Recruitment',embeds:buildEmbeds(c)}), signal:AbortSignal.timeout(9000)
    });
    if (!response.ok) return {ok:false,status:response.status,reason:'discord_error'};
    return {ok:true,status:response.status};
  } catch (error) { console.error('[Discord webhook]', error.message); return {ok:false,reason:'network_error'}; }
}

app.get('/api/health', async (req,res) => {
  let database = 'not_configured';
  if (dbConfigured()) { try { await redis(['PING']); database = 'connected'; } catch (e) { database = 'error'; console.error('[DB health]',e.message); } }
  res.status(database === 'error' ? 503 : 200).json({status:database==='connected'?'ok':'degraded',database,webhook:WEBHOOK_URL?'configured':'not_configured',timestamp:new Date().toISOString()});
});
app.post('/api/candidaturas', async (req,res) => {
  try {
    const data = validateApp(req.body || {});
    if (!data.nome || !data.discord_user || !data.discord_id || !data.pais || !data.fuso || !data.tempo_disponivel) return res.status(400).json({error:'Preencha os campos obrigatórios.'});
    if (!/^\d{15,25}$/.test(data.discord_id)) return res.status(400).json({error:'ID do Discord inválido.'});
    if (data.idade < 13 || data.idade > 100) return res.status(400).json({error:'Idade inválida.'});
    const candidatura = await withDBLock(async () => {
      const db = await loadDB();
      const now = new Date().toISOString();
      const id = 'CUT-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      const item = {...data,id,status:'pendente',observacoes:'',criado_em:now,atualizado_em:now};
      db.candidaturas.push(item);
      db.historico.push({candidatura_id:id,status:'pendente',observacao:'Candidatura recebida',criado_em:now});
      await saveDB(db);
      return item;
    });
    const webhook = await sendWebhook(candidatura);
    return res.status(201).json({success:true,id:candidatura.id,webhook});
  } catch (e) { console.error('[POST candidatura]',e); return res.status(503).json({error:'Não foi possível salvar a candidatura. Verifique a configuração do banco de dados.'}); }
});
app.post('/api/login',(req,res)=>{
  const {user,pass}=req.body||{};
  if (!ADMIN_USER || !ADMIN_PASS || !SESSION_SECRET || SESSION_SECRET.length < 32) return res.status(503).json({error:'Configure ADMIN_USER, ADMIN_PASS e SESSION_SECRET (mínimo de 32 caracteres) nas variáveis de ambiente.'});
  if (typeof user!=='string'||typeof pass!=='string') return res.status(400).json({error:'Credenciais ausentes'});
  const u=Buffer.from(user), p=Buffer.from(pass), eu=Buffer.from(ADMIN_USER), ep=Buffer.from(ADMIN_PASS);
  const valid=u.length===eu.length&&p.length===ep.length&&crypto.timingSafeEqual(u,eu)&&crypto.timingSafeEqual(p,ep);
  if (!valid) return res.status(401).json({error:'Credenciais inválidas'});
  const secure = process.env.VERCEL ? '; Secure' : '';
  res.setHeader('Set-Cookie',`${COOKIE}=${encodeURIComponent(makeToken())}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=28800`);
  return res.json({success:true});
});
app.post('/api/logout',(req,res)=>{const secure = process.env.VERCEL ? '; Secure' : '';
  res.setHeader('Set-Cookie',`${COOKIE}=; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=0`);res.json({success:true});});
app.get('/api/session',(req,res)=>res.json({admin:isAuthenticated(req)}));
app.post('/api/test-webhook',requireAuth,async(req,res)=>{const result=await sendWebhook({id:'TEST',criado_em:new Date().toISOString(),nome:'Teste',idade:18,pais:'-',discord_user:'-',discord_id:'-',fuso:'-',cargo_principal:'outros',cargo_secundario:'',tempo_disponivel:'-',experiencia:'Teste',q1:'Teste',q2:'Teste',q3:'Teste',q4:'Teste',q5:'Teste',q6:'Teste',q7:'Teste'});res.status(result.ok?200:502).json(result);});
app.get('/api/candidaturas',requireAuth,async(req,res)=>{
  try { const db=await loadDB(); const {q,status,cargo}=req.query; let items=db.candidaturas.slice();
    if(q){const s=String(q).toLowerCase();items=items.filter(c=>(c.nome||'').toLowerCase().includes(s)||(c.discord_user||'').toLowerCase().includes(s)||(c.discord_id||'').includes(s)||c.id.toLowerCase().includes(s));}
    if(status&&status!=='all')items=items.filter(c=>c.status===status);if(cargo&&cargo!=='all')items=items.filter(c=>c.cargo_principal===cargo);
    items.sort((a,b)=>b.criado_em.localeCompare(a.criado_em));
    res.json({items,stats:{total:db.candidaturas.length,pendente:db.candidaturas.filter(c=>c.status==='pendente').length,em_analise:db.candidaturas.filter(c=>c.status==='em_analise').length,aprovada:db.candidaturas.filter(c=>c.status==='aprovada').length,recusada:db.candidaturas.filter(c=>c.status==='recusada').length}});
  } catch(e){console.error('[GET candidaturas]',e);res.status(503).json({error:'Banco de dados indisponível.'});}
});
app.get('/api/candidaturas/:id',requireAuth,async(req,res)=>{try{const db=await loadDB();const c=db.candidaturas.find(x=>x.id===req.params.id);if(!c)return res.status(404).json({error:'Candidatura não encontrada'});res.json({candidatura:c,historico:db.historico.filter(h=>h.candidatura_id===c.id).sort((a,b)=>b.criado_em.localeCompare(a.criado_em))});}catch(e){res.status(503).json({error:'Banco de dados indisponível.'});}});
app.patch('/api/candidaturas/:id/status',requireAuth,async(req,res)=>{try{const {status,observacao}=req.body||{};if(!STATUSES.includes(status))return res.status(400).json({error:'Status inválido'});const found=await withDBLock(async()=>{const db=await loadDB();const c=db.candidaturas.find(x=>x.id===req.params.id);if(!c)return false;const now=new Date().toISOString();c.status=status;c.atualizado_em=now;db.historico.push({candidatura_id:c.id,status,observacao:typeof observacao==='string'?observacao.slice(0,500):'',criado_em:now});await saveDB(db);return true;});if(!found)return res.status(404).json({error:'Candidatura não encontrada'});res.json({success:true});}catch(e){console.error('[PATCH status]',e);res.status(503).json({error:'Banco de dados indisponível.'});}});
app.patch('/api/candidaturas/:id/observacoes',requireAuth,async(req,res)=>{try{const {observacoes}=req.body||{};if(typeof observacoes!=='string'||observacoes.length>5000)return res.status(400).json({error:'Observações inválidas'});const found=await withDBLock(async()=>{const db=await loadDB();const c=db.candidaturas.find(x=>x.id===req.params.id);if(!c)return false;c.observacoes=observacoes;c.atualizado_em=new Date().toISOString();await saveDB(db);return true;});if(!found)return res.status(404).json({error:'Candidatura não encontrada'});res.json({success:true});}catch(e){console.error('[PATCH observacoes]',e);res.status(503).json({error:'Banco de dados indisponível.'});}});

// Public pages: serve the original HTML files even when Vercel routes the
// request through the catch-all serverless function. Keep these routes after
// the API endpoints so they cannot shadow /api/* handlers.
app.get(['/', '/index.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get(['/admin', '/admin.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.use((req,res)=>res.status(404).json({error:'Rota da API não encontrada'}));
app.use((err,req,res,next)=>{
  console.error('[API error]',err);
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({error:'JSON inválido.'});
  if (err && err.type === 'entity.too.large') return res.status(413).json({error:'Requisição muito grande.'});
  return res.status(500).json({error:'Erro interno do servidor'});
});

module.exports = app;
