#!/usr/bin/env node
const http = require('http');
const { spawn, execFile, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.MONITOR_PORT || 3339;

// Locate Ragnarok Offline runtime directories & binaries
function getPaths() {
	const home = os.homedir();
	let stateDir = '';
	let dataDir = '';
	let dockerSlim = '';

	if (process.platform === 'darwin') {
		dataDir = path.join(home, 'Library/Application Support/Ragnarok Offline');
		stateDir = path.join(dataDir, 'state');
		dockerSlim = path.join(dataDir, 'runtime/bin/docker-slim');
	} else if (process.platform === 'win32') {
		dataDir = path.join(process.env.APPDATA || home, 'ragnarokoffline');
		stateDir = path.join(dataDir, 'state');
		dockerSlim = path.join(dataDir, 'runtime/bin/docker-slim.exe');
	} else {
		dataDir = path.join(home, '.local/share/ragnarokoffline');
		stateDir = path.join(dataDir, 'state');
		dockerSlim = path.join(dataDir, 'runtime/bin/docker-slim');
	}

	const dockerSock = path.join(dataDir, 'nebula/run/docker.sock');
	const projectRoot = path.resolve(__dirname, '../..');
	if (!fs.existsSync(dockerSlim)) {
		const repoSlim = path.join(projectRoot, 'bin/docker-slim');
		if (fs.existsSync(repoSlim)) dockerSlim = repoSlim;
	}

	return { dataDir, stateDir, dockerSlim, dockerSock, projectRoot };
}

const { dataDir, stateDir, dockerSlim, dockerSock } = getPaths();

function getDockerEnv() {
	return {
		...process.env,
		DOCKER_HOST: `unix://${dockerSock}`,
	};
}

// Fetch status of all services
function getStatus(callback) {
	if (!fs.existsSync(dockerSlim) || !fs.existsSync(dockerSock)) {
		return callback(null, {
			engine: 'offline',
			message: 'Nebula microVM / Docker socket not active',
			services: {},
		});
	}

	execFile(dockerSlim, ['ps', '--format', '{{.Names}}\t{{.Status}}\t{{.Ports}}'], { env: getDockerEnv(), timeout: 3000 }, (err, stdout) => {
		const services = {
			'ragnarok-map': { name: 'Map Server', port: 5121, status: 'offline', details: '' },
			'ragnarok-char': { name: 'Char Server', port: 6121, status: 'offline', details: '' },
			'ragnarok-login': { name: 'Login Server', port: 6900, status: 'offline', details: '' },
			'ragnarok-db': { name: 'Database (MariaDB)', port: 3306, status: 'offline', details: '' },
		};

		if (!err && stdout) {
			const lines = stdout.trim().split('\n');
			for (const line of lines) {
				const [name, status, ports] = line.split('\t');
				if (services[name]) {
					services[name].status = status.startsWith('Up') ? 'running' : 'stopped';
					services[name].details = `${status} ${ports || ''}`.trim();
				}
			}
		}

		callback(null, {
			engine: 'running',
			timestamp: new Date().toISOString(),
			services,
		});
	});
}

// Read recent logs for a specific service or file
function getSnapshotLogs(service, lines, callback) {
	const count = parseInt(lines, 10) || 200;
	if (service === 'asset' || service === 'app' || service === 'assets') {
		const logFile = service === 'asset' || service === 'assets' ? 'assets.log' : 'app.log';
		const filePath = path.join(stateDir, logFile);
		if (!fs.existsSync(filePath)) return callback(null, `(No logs in ${logFile})`);
		try {
			const data = fs.readFileSync(filePath, 'utf8');
			const slice = data.split('\n').slice(-count).join('\n');
			return callback(null, slice);
		} catch (e) {
			return callback(e);
		}
	}

	const containerName = service.startsWith('ragnarok-') ? service : `ragnarok-${service}`;
	execFile(dockerSlim, ['logs', '--tail', String(count), containerName], { env: getDockerEnv(), timeout: 4000 }, (err, stdout, stderr) => {
		if (err) return callback(null, `[Error reading logs from ${containerName}]: ${err.message}\n${stderr || ''}`);
		callback(null, stdout || stderr || '(No recent log output)');
	});
}

// Server-Sent Events stream for live logs
function streamLogs(req, res, service) {
	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache, no-transform',
		'Connection': 'keep-alive',
		'Access-Control-Allow-Origin': '*',
	});
	res.write(': connected\n\n');

	let child = null;

	if (service === 'asset' || service === 'assets' || service === 'app') {
		const logFile = service === 'app' ? 'app.log' : 'assets.log';
		const filePath = path.join(stateDir, logFile);
		const tailProc = spawn('tail', ['-n', '100', '-f', filePath]);
		child = tailProc;

		tailProc.stdout.on('data', (chunk) => {
			const lines = chunk.toString().split('\n');
			for (const line of lines) {
				if (line) res.write(`data: ${JSON.stringify({ text: line, service })}\n\n`);
			}
		});
	} else {
		const containerName = service.startsWith('ragnarok-') ? service : `ragnarok-${service}`;
		const proc = spawn(dockerSlim, ['logs', '-f', '--tail', '100', containerName], { env: getDockerEnv() });
		child = proc;

		const handleData = (chunk) => {
			const lines = chunk.toString().split('\n');
			for (const line of lines) {
				if (line) res.write(`data: ${JSON.stringify({ text: line, service })}\n\n`);
			}
		};

		proc.stdout.on('data', handleData);
		proc.stderr.on('data', handleData);
	}

	const keepAlive = setInterval(() => {
		res.write(': ping\n\n');
	}, 15000);

	req.on('close', () => {
		clearInterval(keepAlive);
		if (child) child.kill();
	});
}

// HTML Dashboard UI
const HTML_DASHBOARD = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ragnarok Offline — Server Console & Monitor</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&family=JetBrains+Mono:wght@400;500;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg-primary: #0d1117;
    --bg-surface: #161b22;
    --bg-card: #1f242c;
    --bg-card-hover: #262c36;
    --border-color: #30363d;
    --gold: #e8b84b;
    --gold-glow: rgba(232, 184, 75, 0.25);
    --gold-dim: #a67c1e;
    --text-primary: #f0f6fc;
    --text-muted: #8b949e;
    --status-online: #3fb950;
    --status-offline: #f85149;
    --status-warn: #d29922;
    --font-mono: 'JetBrains Mono', monospace;
    --font-sans: 'Inter', system-ui, -apple-system, sans-serif;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background-color: var(--bg-primary);
    color: var(--text-primary);
    font-family: var(--font-sans);
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* Top Bar */
  header {
    background: linear-gradient(180deg, #161b22 0%, #0d1117 100%);
    border-bottom: 1px solid var(--border-color);
    padding: 12px 20px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
  }
  .branding {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .branding h1 {
    font-family: 'Cinzel', serif;
    font-size: 1.25rem;
    color: var(--gold);
    letter-spacing: 1px;
    text-shadow: 0 0 10px var(--gold-glow);
  }
  .badge {
    padding: 3px 8px;
    border-radius: 12px;
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .badge.live { background: rgba(63, 185, 80, 0.15); color: var(--status-online); border: 1px solid var(--status-online); }
  .badge.dead { background: rgba(248, 81, 73, 0.15); color: var(--status-offline); border: 1px solid var(--status-offline); }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  button.action-btn {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 0.82rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  button.action-btn:hover {
    background: var(--bg-card);
    border-color: var(--gold-dim);
    color: var(--gold);
  }

  /* Status Cards */
  .status-bar {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 12px;
    padding: 14px 20px;
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border-color);
  }
  .card {
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 10px 14px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    transition: border-color 0.2s;
  }
  .card:hover { border-color: #484f58; }
  .card-info .card-title {
    font-size: 0.8rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 600;
  }
  .card-info .card-port {
    font-size: 0.95rem;
    font-family: var(--font-mono);
    color: var(--text-primary);
    margin-top: 2px;
  }
  .dot-status {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    box-shadow: 0 0 8px currentColor;
  }
  .dot-status.running { background-color: var(--status-online); color: var(--status-online); }
  .dot-status.offline { background-color: var(--status-offline); color: var(--status-offline); }

  /* Main Workspace */
  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 14px 20px;
    overflow: hidden;
    gap: 10px;
  }

  /* Controls & Tabs */
  .console-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
  }
  .nav-tabs {
    display: flex;
    gap: 6px;
    background: var(--bg-surface);
    padding: 4px;
    border-radius: 8px;
    border: 1px solid var(--border-color);
  }
  .tab-btn {
    background: transparent;
    border: none;
    color: var(--text-muted);
    padding: 6px 14px;
    font-size: 0.82rem;
    font-weight: 600;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.2s;
  }
  .tab-btn.active {
    background: var(--gold);
    color: #111;
    box-shadow: 0 0 10px var(--gold-glow);
  }
  .tab-btn:not(.active):hover {
    color: var(--text-primary);
    background: rgba(255,255,255,0.05);
  }

  .console-tools {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .search-input {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 0.82rem;
    outline: none;
    width: 180px;
    font-family: var(--font-mono);
  }
  .search-input:focus { border-color: var(--gold); }

  .toggle-btn {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    color: var(--text-muted);
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .toggle-btn.active {
    color: var(--gold);
    border-color: var(--gold-dim);
    background: rgba(232, 184, 75, 0.1);
  }

  /* Log Terminal Container */
  .terminal-box {
    flex: 1;
    background: #090d13;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 12px;
    overflow-y: auto;
    font-family: var(--font-mono);
    font-size: 0.82rem;
    line-height: 1.45;
    position: relative;
    box-shadow: inset 0 2px 10px rgba(0,0,0,0.6);
  }
  .log-line {
    white-space: pre-wrap;
    word-break: break-all;
    padding: 1px 0;
  }
  .log-line.err, .log-line:has(.err-word) { color: #ff7b72; }
  .log-line.warn, .log-line:has(.warn-word) { color: #f2cc60; }
  .log-line.info, .log-line:has(.info-word) { color: #7ee787; }
  .highlight { background: rgba(232, 184, 75, 0.3); color: #fff; padding: 0 2px; border-radius: 2px; }
  .timestamp { color: #484f58; margin-right: 8px; user-select: none; }
  .service-tag { color: var(--gold); font-weight: bold; margin-right: 8px; }

  /* Footer */
  footer {
    padding: 6px 20px 10px;
    display: flex;
    justify-content: space-between;
    font-size: 0.75rem;
    color: var(--text-muted);
  }
</style>
</head>
<body>

<header>
  <div class="branding">
    <h1>⚔ RAGNAROK OFFLINE</h1>
    <span class="badge" id="engine-badge">Checking...</span>
  </div>
  <div class="header-actions">
    <button class="action-btn" onclick="fetchStatus()">↻ Refresh</button>
    <button class="action-btn" onclick="clearLogs()">⊘ Clear View</button>
    <button class="action-btn" onclick="copyAllLogs()">📋 Copy Logs</button>
  </div>
</header>

<div class="status-bar" id="status-bar">
  <div class="card">
    <div class="card-info">
      <div class="card-title">Map Server</div>
      <div class="card-port">Port 5121</div>
    </div>
    <div class="dot-status offline" id="dot-map"></div>
  </div>
  <div class="card">
    <div class="card-info">
      <div class="card-title">Char Server</div>
      <div class="card-port">Port 6121</div>
    </div>
    <div class="dot-status offline" id="dot-char"></div>
  </div>
  <div class="card">
    <div class="card-info">
      <div class="card-title">Login Server</div>
      <div class="card-port">Port 6900</div>
    </div>
    <div class="dot-status offline" id="dot-login"></div>
  </div>
  <div class="card">
    <div class="card-info">
      <div class="card-title">Database</div>
      <div class="card-port">MariaDB</div>
    </div>
    <div class="dot-status offline" id="dot-db"></div>
  </div>
</div>

<main>
  <div class="console-header">
    <div class="nav-tabs" id="nav-tabs">
      <button class="tab-btn active" data-service="map" onclick="switchTab('map')">Map Server</button>
      <button class="tab-btn" data-service="char" onclick="switchTab('char')">Char Server</button>
      <button class="tab-btn" data-service="login" onclick="switchTab('login')">Login Server</button>
      <button class="tab-btn" data-service="db" onclick="switchTab('db')">Database</button>
      <button class="tab-btn" data-service="assets" onclick="switchTab('assets')">Asset Server</button>
    </div>

    <div class="console-tools">
      <input type="text" id="search-box" class="search-input" placeholder="Filter logs..." oninput="filterLogs()">
      <button class="toggle-btn active" id="autoscroll-btn" onclick="toggleAutoScroll()">Auto-scroll: ON</button>
    </div>
  </div>

  <div class="terminal-box" id="terminal"></div>
</main>

<footer>
  <span id="stream-status">Connecting live event stream...</span>
  <span>Local Monitor Port :3339</span>
</footer>

<script>
let currentService = 'map';
let eventSource = null;
let autoScroll = true;
const logsByService = { map: [], char: [], login: [], db: [], assets: [] };

function formatLine(text, service) {
  const isErr = /error|fatal|fail|panic/i.test(text);
  const isWarn = /warning|warn/i.test(text);
  const isInfo = /ready|success|connected|started|listening/i.test(text);
  
  let cls = 'log-line';
  if (isErr) cls += ' err';
  else if (isWarn) cls += ' warn';
  else if (isInfo) cls += ' info';

  const filter = document.getElementById('search-box').value.trim();
  let renderedText = escapeHTML(text);
  if (filter) {
    const reg = new RegExp('(' + escapeRegex(filter) + ')', 'gi');
    renderedText = renderedText.replace(reg, '<span class="highlight">$1</span>');
  }

  const time = new Date().toLocaleTimeString();
  return '<div class="' + cls + '"><span class="timestamp">[' + time + ']</span>' + renderedText + '</div>';
}

function escapeHTML(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeRegex(s) {
  return s.replace(/[-\\/\\\\^$*+?.()|[\\]{}]/g, '\\\\$&');
}

function appendLog(service, text) {
  if (!logsByService[service]) logsByService[service] = [];
  logsByService[service].push(text);
  if (logsByService[service].length > 1000) logsByService[service].shift();

  if (service === currentService) {
    const term = document.getElementById('terminal');
    term.insertAdjacentHTML('beforeend', formatLine(text, service));
    if (autoScroll) term.scrollTop = term.scrollHeight;
  }
}

function renderActiveLogs() {
  const term = document.getElementById('terminal');
  const lines = logsByService[currentService] || [];
  term.innerHTML = lines.map(l => formatLine(l, currentService)).join('');
  if (autoScroll) term.scrollTop = term.scrollHeight;
}

function switchTab(service) {
  currentService = service;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-service') === service);
  });
  
  // Load initial snapshot if empty
  if (!logsByService[service] || logsByService[service].length === 0) {
    fetch('/api/logs-snapshot/' + service + '?lines=200')
      .then(r => r.text())
      .then(text => {
        logsByService[service] = text.split('\\n').filter(Boolean);
        renderActiveLogs();
      });
  } else {
    renderActiveLogs();
  }
  
  connectStream(service);
}

function connectStream(service) {
  if (eventSource) eventSource.close();
  const statusEl = document.getElementById('stream-status');
  statusEl.textContent = 'Streaming live logs for [' + service + ']...';
  
  eventSource = new EventSource('/api/logs/' + service);
  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      appendLog(data.service, data.text);
    } catch(e) {}
  };
  eventSource.onerror = () => {
    statusEl.textContent = 'Stream reconnecting...';
  };
}

function toggleAutoScroll() {
  autoScroll = !autoScroll;
  const btn = document.getElementById('autoscroll-btn');
  btn.textContent = 'Auto-scroll: ' + (autoScroll ? 'ON' : 'OFF');
  btn.classList.toggle('active', autoScroll);
}

function clearLogs() {
  logsByService[currentService] = [];
  renderActiveLogs();
}

function copyAllLogs() {
  const text = (logsByService[currentService] || []).join('\\n');
  navigator.clipboard.writeText(text).then(() => alert('Copied ' + logsByService[currentService].length + ' log lines to clipboard!'));
}

function filterLogs() {
  renderActiveLogs();
}

function fetchStatus() {
  fetch('/api/status')
    .then(r => r.json())
    .then(data => {
      const badge = document.getElementById('engine-badge');
      if (data.engine === 'running') {
        badge.textContent = 'ENGINE RUNNING';
        badge.className = 'badge live';
      } else {
        badge.textContent = 'OFFLINE';
        badge.className = 'badge dead';
      }

      if (data.services) {
        setDot('dot-map', data.services['ragnarok-map']?.status);
        setDot('dot-char', data.services['ragnarok-char']?.status);
        setDot('dot-login', data.services['ragnarok-login']?.status);
        setDot('dot-db', data.services['ragnarok-db']?.status);
      }
    })
    .catch(() => {
      document.getElementById('engine-badge').textContent = 'UNREACHABLE';
      document.getElementById('engine-badge').className = 'badge dead';
    });
}

function setDot(id, status) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = 'dot-status ' + (status === 'running' ? 'running' : 'offline');
}

// Init
fetchStatus();
setInterval(fetchStatus, 4000);
switchTab('map');
</script>
</body>
</html>
`;

// HTTP Server
const server = http.createServer((req, res) => {
	const url = new URL(req.url, `http://${req.headers.host}`);
	const pathname = url.pathname;

	if (pathname === '/' || pathname === '/index.html') {
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
		return res.end(HTML_DASHBOARD);
	}

	if (pathname === '/api/status') {
		return getStatus((err, data) => {
			res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
			res.end(JSON.stringify(data));
		});
	}

	if (pathname.startsWith('/api/logs-snapshot/')) {
		const service = pathname.replace('/api/logs-snapshot/', '');
		const lines = url.searchParams.get('lines') || 200;
		return getSnapshotLogs(service, lines, (err, text) => {
			res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
			res.end(text || '');
		});
	}

	if (pathname.startsWith('/api/logs/')) {
		const service = pathname.replace('/api/logs/', '');
		return streamLogs(req, res, service);
	}

	res.writeHead(404, { 'Content-Type': 'text/plain' });
	res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
	console.log(`\n⚔ Ragnarok Server Monitor is active at http://127.0.0.1:${PORT}`);
	console.log(`- Map Server, Char Server, Login Server, Database & Asset Server live monitor`);
	console.log(`- Press Ctrl+C to stop.\n`);
});
