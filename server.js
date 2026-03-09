'use strict';
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { spawn }  = require('child_process');
const fs         = require('fs');
const fsp        = require('fs').promises;
const path       = require('path');
const multer     = require('multer');
const os         = require('os');
const crypto     = require('crypto');
const archiver   = require('archiver');
const AdmZip     = require('adm-zip');

// When compiled with pkg, __dirname points inside the binary snapshot.
// APP_DIR is always the real folder next to the .exe (or the project root in dev).
const IS_PKG = typeof process.pkg !== 'undefined';
const APP_DIR = IS_PKG ? path.dirname(process.execPath) : __dirname;

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.json());

// ─── Config ───────────────────────────────────────────────────────────────────
const CONFIG_FILE = path.join(APP_DIR, 'config.json');
const DEFAULT_CONFIG = {
  servers: [],
  activeServer: null,
  port: 3000,
  auth: { enabled: false, password: '' },
  discord: { enabled: false, webhook: '' },
  backupDir: path.join(APP_DIR, 'backups'),
  scheduledTasks: []
};

let config = loadConfig();
function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch {}
  }
  return { ...DEFAULT_CONFIG };
}
function saveConfig() { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); }
function getActiveServer() { return config.servers.find(s => s.id === config.activeServer) || null; }

// ─── ANSI stripping ───────────────────────────────────────────────────────────
function stripAnsi(str) {
  return str
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/\x1B[@-_][0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

// ─── Auth middleware ──────────────────────────────────────────────────────────
const sessions = new Set();
function authMiddleware(req, res, next) {
  if (!config.auth.enabled) return next();
  if (req.path === '/auth/login' || req.path === '/auth/check') return next();
  const token = req.headers['x-auth-token'] || req.query.token;
  if (sessions.has(token)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', authMiddleware);
app.post('/api/auth/login', (req, res) => {
  if (!config.auth.enabled) return res.json({ ok: true, token: 'disabled' });
  if (req.body.password === config.auth.password) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.add(token); res.json({ ok: true, token });
  } else res.status(401).json({ ok: false, error: 'Wrong password' });
});
app.get('/api/auth/check', (req, res) => res.json({ enabled: config.auth.enabled }));

// Cross-platform CPU usage
function getCpuUsage() {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  cpus.forEach(cpu => {
    for (const type in cpu.times) totalTick += cpu.times[type];
    totalIdle += cpu.times.idle;
  });
  return { idle: totalIdle / cpus.length, total: totalTick / cpus.length };
}

let lastCpu = getCpuUsage();
let currentCpuPercent = 0;
setInterval(() => {
  const now = getCpuUsage();
  const idleDiff  = now.idle  - lastCpu.idle;
  const totalDiff = now.total - lastCpu.total;
  currentCpuPercent = totalDiff > 0 ? +((1 - idleDiff / totalDiff) * 100).toFixed(1) : 0;
  lastCpu = now;
}, 1000);
let mcProcess    = null;
let consoleBuffer = [];
let perfHistory  = [];
let onlinePlayers = {};
const MAX_BUFFER = 1000;

function fmtBytes(b) {
  if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
  if (b >= 1048576)    return (b / 1048576).toFixed(1)    + ' MB';
  return (b / 1024).toFixed(0) + ' KB';
}

function pushLog(line, type = 'log') {
  line = stripAnsi(line);
  const entry = { line, type, ts: Date.now() };
  consoleBuffer.push(entry);
  if (consoleBuffer.length > MAX_BUFFER) consoleBuffer.shift();
  io.emit('console:line', entry);
  parseConsoleLine(line);
  if (type === 'error' && /exception|crash/i.test(line)) {
    sendDiscord(`🔴 **Server Error**: ${line.substring(0, 200)}`);
  }
}

function parseConsoleLine(line) {
  const join  = line.match(/:\s+(\w+) joined the game/);
  const leave = line.match(/:\s+(\w+) left the game/);
  const list  = line.match(/There are \d+ of a max of \d+ players online: (.+)/);
  if (join)  { onlinePlayers[join[1]]  = { name: join[1], joined: Date.now() }; io.emit('players:update', onlinePlayers); sendDiscord(`✅ **${join[1]}** joined`); }
  if (leave) { delete onlinePlayers[leave[1]]; io.emit('players:update', onlinePlayers); sendDiscord(`👋 **${leave[1]}** left`); }
  if (list)  {
    const names = list[1].split(',').map(n => n.trim()).filter(n => n && n !== 'None');
    onlinePlayers = {};
    names.forEach(n => { onlinePlayers[n] = { name: n, joined: null }; });
    io.emit('players:update', onlinePlayers);
  }
}

// ─── Server control ───────────────────────────────────────────────────────────
function getStatus() { return mcProcess && !mcProcess.killed ? 'online' : 'offline'; }

function startServer() {
  if (mcProcess)   return { ok: false, msg: 'Already running' };
  const srv = getActiveServer();
  if (!srv)        return { ok: false, msg: 'No server selected' };
  if (!srv.path)   return { ok: false, msg: 'Server path not set' };
  const jarPath = path.join(srv.path, srv.jar || 'server.jar');
  if (!fs.existsSync(jarPath)) return { ok: false, msg: `JAR not found: ${jarPath}` };

  const args = [...(srv.jvmArgs || '-Xmx2G -Xms1G').split(' ').filter(Boolean), '-jar', srv.jar || 'server.jar', '--nogui'];
  pushLog(`▶ Starting: ${srv.java || 'java'} ${args.join(' ')}`, 'system');

  mcProcess = spawn(srv.java || 'java', args, { cwd: srv.path, stdio: ['pipe','pipe','pipe'], shell: false });
  mcProcess.stdout.on('data', d => d.toString().split('\n').forEach(l => l.trim() && pushLog(l)));
  mcProcess.stderr.on('data', d => d.toString().split('\n').forEach(l => l.trim() && pushLog(l, 'error')));
  mcProcess.on('close', code => {
    pushLog(`■ Server stopped (exit ${code})`, 'system');
    mcProcess = null; onlinePlayers = {};
    io.emit('status:change', 'offline'); io.emit('players:update', {});
    sendDiscord(`🔴 **Server stopped** (exit ${code})`);
  });
  mcProcess.on('error', err => {
    pushLog(`✖ Failed to start: ${err.message}`, 'error');
    mcProcess = null; io.emit('status:change', 'offline');
  });
  io.emit('status:change', 'online');
  sendDiscord('🟢 **Server started**');
  return { ok: true };
}

function stopServer() {
  if (!mcProcess) return { ok: false, msg: 'Not running' };
  pushLog('■ Stopping server...', 'system');
  mcProcess.stdin.write('stop\n');
  setTimeout(() => { if (mcProcess) { mcProcess.kill(); mcProcess = null; } }, 15000);
  return { ok: true };
}

function sendCommand(cmd) {
  if (!mcProcess) return { ok: false, msg: 'Server not running' };
  mcProcess.stdin.write(cmd + '\n');
  pushLog(`> ${cmd}`, 'command');
  return { ok: true };
}

// ─── Discord ──────────────────────────────────────────────────────────────────
async function sendDiscord(content) {
  if (!config.discord?.enabled || !config.discord?.webhook) return;
  try {
    const url = new URL(config.discord.webhook);
    const body = JSON.stringify({ content, username: 'MC Manager' });
    const mod = url.protocol === 'https:' ? require('https') : require('http');
    const req = mod.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
    req.on('error', () => {});
    req.write(body); req.end();
  } catch {}
}

// ─── REST API ─────────────────────────────────────────────────────────────────

// Multi-server
app.get('/api/servers', (req, res) => res.json(config.servers));
app.post('/api/servers', (req, res) => {
  const srv = { id: crypto.randomBytes(4).toString('hex'), name: 'New Server', path: '', jar: 'server.jar', java: 'java', jvmArgs: '-Xmx2G -Xms1G', ...req.body };
  config.servers.push(srv);
  if (!config.activeServer) config.activeServer = srv.id;
  saveConfig(); res.json(srv);
});
app.put('/api/servers/:id', (req, res) => {
  const idx = config.servers.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  config.servers[idx] = { ...config.servers[idx], ...req.body };
  saveConfig(); res.json(config.servers[idx]);
});
app.delete('/api/servers/:id', (req, res) => {
  config.servers = config.servers.filter(s => s.id !== req.params.id);
  if (config.activeServer === req.params.id) config.activeServer = config.servers[0]?.id || null;
  saveConfig(); res.json({ ok: true });
});
app.post('/api/servers/:id/activate', (req, res) => {
  if (getStatus() === 'online') return res.status(400).json({ error: 'Stop current server first' });
  config.activeServer = req.params.id; saveConfig();
  consoleBuffer = []; io.emit('console:history', []);
  res.json({ ok: true, activeServer: config.activeServer });
});

// Status & control
app.get('/api/status', (req, res) => res.json({ status: getStatus(), activeServer: config.activeServer, freeMem: os.freemem(), totalMem: os.totalmem(), cpuLoad: currentCpuPercent }));
app.post('/api/start',   (req, res) => res.json(startServer()));
app.post('/api/stop',    (req, res) => res.json(stopServer()));
app.post('/api/restart', (req, res) => { stopServer(); setTimeout(() => res.json(startServer()), 4000); });
app.post('/api/command', (req, res) => res.json(sendCommand(req.body.command)));
app.get('/api/console',  (req, res) => res.json(consoleBuffer));
app.get('/api/perf',     (req, res) => res.json(perfHistory));

// Players
app.get('/api/players', (req, res) => res.json(Object.values(onlinePlayers)));
app.post('/api/players/kick',    (req, res) => res.json(sendCommand(`kick ${req.body.name} ${req.body.reason || 'Kicked by admin'}`)));
app.post('/api/players/ban',     (req, res) => res.json(sendCommand(`ban ${req.body.name} ${req.body.reason || 'Banned by admin'}`)));
app.post('/api/players/op',      (req, res) => res.json(sendCommand(`op ${req.body.name}`)));
app.post('/api/players/deop',    (req, res) => res.json(sendCommand(`deop ${req.body.name}`)));
app.post('/api/players/gamemode',(req, res) => res.json(sendCommand(`gamemode ${req.body.mode} ${req.body.name}`)));
app.post('/api/players/pardon',  (req, res) => res.json(sendCommand(`pardon ${req.body.name}`)));
app.post('/api/players/tp',      (req, res) => res.json(sendCommand(`tp ${req.body.name} ${req.body.target}`)));
app.get('/api/whitelist', async (req, res) => {
  try {
    const srv = getActiveServer();
    const wl = path.join(srv.path, 'whitelist.json');
    res.json(fs.existsSync(wl) ? JSON.parse(await fsp.readFile(wl,'utf8')) : []);
  } catch { res.json([]); }
});
app.post('/api/whitelist/add',    (req, res) => res.json(sendCommand(`whitelist add ${req.body.name}`)));
app.post('/api/whitelist/remove', (req, res) => res.json(sendCommand(`whitelist remove ${req.body.name}`)));
app.get('/api/banlist', async (req, res) => {
  try {
    const srv = getActiveServer();
    const bl = path.join(srv.path, 'banned-players.json');
    res.json(fs.existsSync(bl) ? JSON.parse(await fsp.readFile(bl,'utf8')) : []);
  } catch { res.json([]); }
});

// Config
app.get('/api/config', (req, res) => {
  const safe = JSON.parse(JSON.stringify(config));
  if (safe.auth?.password) safe.auth.password = '••••••••';
  res.json(safe);
});
app.post('/api/config', (req, res) => {
  const body = req.body;
  if (body.auth?.password === '••••••••') delete body.auth.password;
  if (body.auth)    config.auth    = { ...config.auth,    ...body.auth };
  if (body.discord) config.discord = { ...config.discord, ...body.discord };
  if (body.backupDir !== undefined) config.backupDir = body.backupDir;
  saveConfig(); res.json({ ok: true });
});

// Files
function safePath(rel) {
  const srv = getActiveServer();
  if (!srv?.path) throw new Error('Server path not set');
  const full = path.resolve(srv.path, rel || '');
  if (!full.startsWith(path.resolve(srv.path))) throw new Error('Access denied');
  return full;
}
app.get('/api/files', async (req, res) => {
  try {
    const dir = safePath(req.query.path || '');
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const items = await Promise.all(entries.map(async e => {
      const stat = await fsp.stat(path.join(dir, e.name)).catch(() => null);
      return { name: e.name, isDir: e.isDirectory(), size: stat?.size || 0, mtime: stat?.mtime };
    }));
    res.json({ path: req.query.path || '', items: items.sort((a, b) => b.isDir - a.isDir || a.name.localeCompare(b.name)) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/file', async (req, res) => {
  try {
    const fp = safePath(req.query.path);
    const stat = await fsp.stat(fp);
    if (stat.size > 2 * 1024 * 1024) return res.status(413).json({ error: 'File too large (>2MB)' });
    const content = await fsp.readFile(fp, 'utf8');
    res.json({ content, path: req.query.path });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/file', async (req, res) => {
  try { await fsp.writeFile(safePath(req.body.path), req.body.content, 'utf8'); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/file', async (req, res) => {
  try { await fsp.unlink(safePath(req.query.path)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Server info
function parseProperties(content) {
  const props = {};
  content.split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const idx = line.indexOf('=');
    if (idx === -1) return;
    props[line.substring(0, idx).trim()] = line.substring(idx + 1).trim();
  });
  return props;
}
app.get('/api/serverinfo', async (req, res) => {
  const info = {};
  try {
    const srv = getActiveServer();
    if (!srv?.path) return res.json(info);
    const propsFile = path.join(srv.path, 'server.properties');
    if (fs.existsSync(propsFile)) {
      const props = parseProperties(await fsp.readFile(propsFile, 'utf8'));
      info.motd         = (props['motd'] || '').replace(/§[0-9a-fk-or]/gi, '');
      info.gamemode     = props['gamemode']     || '—';
      info.difficulty   = props['difficulty']   || '—';
      info.maxPlayers   = props['max-players']  || '—';
      info.port         = props['server-port']  || '25565';
      info.worldName    = props['level-name']   || 'world';
      info.pvp          = props['pvp'] === 'true';
      info.onlineMode   = props['online-mode'] !== 'false';
      info.viewDistance = props['view-distance']|| '—';
      info.whitelist    = props['white-list'] === 'true';
    }
    let totalBytes = 0;
    const walkDir = async (dir) => {
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      await Promise.all(entries.map(async e => {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) await walkDir(fp);
        else { const s = await fsp.stat(fp).catch(() => null); if (s) totalBytes += s.size; }
      }));
    };
    await walkDir(srv.path);
    info.diskUsage = totalBytes;
    const pluginDir = path.join(srv.path, 'plugins');
    info.pluginCount = fs.existsSync(pluginDir)
      ? (await fsp.readdir(pluginDir).catch(() => [])).filter(f => f.endsWith('.jar')).length : 0;
    res.json(info);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Plugins
const pluginUpload = multer({ dest: os.tmpdir() });
async function readPluginMeta(jarPath) {
  try {
    const zip = new AdmZip(jarPath);
    const entry = zip.getEntry('plugin.yml') || zip.getEntry('paper-plugin.yml') || zip.getEntry('bungee.yml');
    if (!entry) return {};
    const yml  = entry.getData().toString('utf8');
    const meta = {};
    const nm = yml.match(/^name:\s*(.+)/m);
    const vm = yml.match(/^version:\s*['"]?(.+?)['"]?\s*$/m);
    const am = yml.match(/^authors?:\s*(.+)/m);
    const dm = yml.match(/^description:\s*(.+)/m);
    if (nm) meta.pluginName  = nm[1].trim();
    if (vm) meta.version     = vm[1].trim();
    if (am) meta.author      = am[1].replace(/[\[\]'"]/g,'').trim();
    if (dm) meta.description = dm[1].trim();
    return meta;
  } catch { return {}; }
}
app.get('/api/plugins', async (req, res) => {
  try {
    const srv = getActiveServer();
    if (!srv?.path) return res.json([]);
    const pluginDir = path.join(srv.path, 'plugins');
    if (!fs.existsSync(pluginDir)) return res.json([]);
    const files = await fsp.readdir(pluginDir);
    const plugins = [];
    for (const f of files) {
      const fullPath = path.join(pluginDir, f);
      const stat = await fsp.stat(fullPath).catch(() => null);
      if (!stat || stat.isDirectory()) continue;
      const isJar = f.endsWith('.jar'), isDisabled = f.endsWith('.jar.disabled');
      if (!isJar && !isDisabled) continue;
      const meta = await readPluginMeta(fullPath);
      plugins.push({ name: f.replace(/\.jar(\.disabled)?$/, ''), file: f, enabled: isJar, size: stat.size, mtime: stat.mtime, ...meta });
    }
    plugins.sort((a,b) => (a.pluginName||a.name).localeCompare(b.pluginName||b.name, undefined, { sensitivity:'base' }));
    res.json(plugins);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/plugins/upload', pluginUpload.single('plugin'), async (req, res) => {
  try {
    const srv = getActiveServer();
    const pluginDir = path.join(srv.path, 'plugins');
    if (!fs.existsSync(pluginDir)) await fsp.mkdir(pluginDir, { recursive: true });
    await fsp.rename(req.file.path, path.join(pluginDir, req.file.originalname));
    res.json({ ok: true, name: req.file.originalname });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/plugins/toggle', async (req, res) => {
  try {
    const srv = getActiveServer();
    const pd = path.join(srv.path, 'plugins');
    const { file, enabled } = req.body;
    await fsp.rename(path.join(pd, enabled ? file : file+'.disabled'), path.join(pd, enabled ? file+'.disabled' : file));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/plugins', async (req, res) => {
  try {
    const srv = getActiveServer();
    await fsp.unlink(path.join(srv.path, 'plugins', req.query.file));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Backups
async function createBackup(label = 'manual') {
  const srv = getActiveServer();
  if (!srv?.path) throw new Error('No server configured');
  const backupDir = config.backupDir || path.join(APP_DIR, 'backups');
  await fsp.mkdir(backupDir, { recursive: true });
  const ts   = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const name = `backup-${(srv.name||'server').replace(/\s+/g,'-')}-${label}-${ts}.zip`;
  const dest = path.join(backupDir, name);
  pushLog(`📦 Starting backup: ${name}`, 'system');
  if (getStatus()==='online') { sendCommand('save-off'); sendCommand('save-all'); }
  await new Promise((resolve, reject) => {
    const output  = fs.createWriteStream(dest);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', reject);
    output.on('close', resolve);
    archive.pipe(output);
    const worldName = 'world';
    const include = [worldName, worldName+'_nether', worldName+'_the_end', 'plugins', 'server.properties', 'ops.json', 'whitelist.json', 'banned-players.json'];
    include.forEach(item => {
      const fp = path.join(srv.path, item);
      if (!fs.existsSync(fp)) return;
      fs.statSync(fp).isDirectory() ? archive.directory(fp, item) : archive.file(fp, { name: item });
    });
    archive.finalize();
  });
  if (getStatus()==='online') sendCommand('save-on');
  const stat = await fsp.stat(dest);
  pushLog(`✅ Backup complete: ${name} (${fmtBytes(stat.size)})`, 'system');
  sendDiscord(`📦 **Backup created**: ${name} (${fmtBytes(stat.size)})`);
  return { name, size: stat.size, path: dest, ts: Date.now(), label };
}

app.get('/api/backups', async (req, res) => {
  try {
    const backupDir = config.backupDir || path.join(APP_DIR, 'backups');
    await fsp.mkdir(backupDir, { recursive: true });
    const files = await fsp.readdir(backupDir);
    const backups = await Promise.all(files.filter(f => f.endsWith('.zip')).map(async f => {
      const stat = await fsp.stat(path.join(backupDir, f));
      return { name: f, size: stat.size, mtime: stat.mtime };
    }));
    backups.sort((a,b) => new Date(b.mtime) - new Date(a.mtime));
    res.json(backups);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/backups', async (req, res) => {
  try {
    const result = await createBackup(req.body.label || 'manual');
    io.emit('backup:done', result); res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/backups/:name', async (req, res) => {
  try {
    const backupDir = config.backupDir || path.join(APP_DIR, 'backups');
    const fp = path.join(backupDir, req.params.name);
    if (!fp.startsWith(backupDir)) return res.status(403).json({ error: 'Forbidden' });
    await fsp.unlink(fp); res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/backups/:name/download', (req, res) => {
  const backupDir = config.backupDir || path.join(APP_DIR, 'backups');
  const fp = path.join(backupDir, req.params.name);
  if (!fp.startsWith(backupDir) || !fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  res.download(fp);
});

// Scheduler
let schedulerIntervals = {};
function startScheduler() {
  Object.values(schedulerIntervals).forEach(clearInterval);
  schedulerIntervals = {};
  (config.scheduledTasks || []).forEach(task => {
    if (!task.enabled || !task.intervalMinutes) return;
    schedulerIntervals[task.id] = setInterval(() => runTask(task), task.intervalMinutes * 60 * 1000);
  });
}
async function runTask(task) {
  pushLog(`⏰ Running scheduled task: ${task.name}`, 'system');
  if (task.type === 'command' && task.command) {
    if (getStatus() === 'online') sendCommand(task.command);
  } else if (task.type === 'backup') {
    try { const r = await createBackup('scheduled'); io.emit('backup:done', r); } catch(e) { pushLog(`Backup failed: ${e.message}`, 'error'); }
  } else if (task.type === 'restart') {
    if (getStatus() === 'online') {
      const warn = task.warnMinutes || 1;
      sendCommand(`say Server restarting in ${warn} minute(s)!`);
      setTimeout(() => { stopServer(); setTimeout(startServer, 5000); }, warn * 60 * 1000);
    }
  }
}
app.get('/api/scheduler',       (req, res) => res.json(config.scheduledTasks || []));
app.post('/api/scheduler', (req, res) => {
  const task = { id: crypto.randomBytes(4).toString('hex'), enabled: true, intervalMinutes: 60, name: 'New Task', type: 'command', command: '', warnMinutes: 1, ...req.body };
  config.scheduledTasks = config.scheduledTasks || [];
  config.scheduledTasks.push(task);
  saveConfig(); startScheduler(); res.json(task);
});
app.put('/api/scheduler/:id', (req, res) => {
  const idx = (config.scheduledTasks||[]).findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  config.scheduledTasks[idx] = { ...config.scheduledTasks[idx], ...req.body };
  saveConfig(); startScheduler(); res.json(config.scheduledTasks[idx]);
});
app.delete('/api/scheduler/:id', (req, res) => {
  config.scheduledTasks = (config.scheduledTasks||[]).filter(t => t.id !== req.params.id);
  saveConfig(); startScheduler(); res.json({ ok: true });
});
app.post('/api/scheduler/:id/run', async (req, res) => {
  const task = (config.scheduledTasks||[]).find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  await runTask(task); res.json({ ok: true });
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  socket.emit('status:change', getStatus());
  socket.emit('console:history', consoleBuffer);
  socket.emit('players:update', onlinePlayers);
  socket.on('command', cmd => sendCommand(cmd));
  socket.on('auth', token => {
    if (!config.auth.enabled || sessions.has(token)) socket.emit('auth:ok');
    else socket.emit('auth:fail');
  });
});

// ─── Perf tracking ────────────────────────────────────────────────────────────
setInterval(() => {
  const entry = { ts: Date.now(), ram: os.totalmem() - os.freemem(), totalRam: os.totalmem(), cpu: currentCpuPercent };
  perfHistory.push(entry);
  if (perfHistory.length > 60) perfHistory.shift();
  io.emit('stats', { ...entry, status: getStatus(), freeMem: os.freemem(), totalMem: os.totalmem() });
}, 5000);

// ─── Boot ─────────────────────────────────────────────────────────────────────
startScheduler();
const PORT = config.port || 3000;
server.listen(PORT, () => console.log(`\n⛏  Minecraft Manager → http://localhost:${PORT}\n`));
