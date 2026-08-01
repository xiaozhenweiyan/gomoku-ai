/* =====================================================================
 * GoImmortal — 应用主逻辑
 * 棋盘渲染 / 落子提子 / 不朽块 / 异步MCTS / 形势图 / AI解说
 * ===================================================================== */
const { SIZE, EMPTY, BLACK, WHITE } = GoImmortal;
const coord = (x, y) => String.fromCharCode(65 + x) + (SIZE - y);
const parseCoord = s => { const x = s.charCodeAt(0) - 65, y = SIZE - parseInt(s.slice(1)); return [x, y]; };

// ---- 状态 ----
let board = GoImmortal.emptyBoard();
let currentPlayer = BLACK;
let history = [];          // {board, player, ko, state, passCount}
let koPoint = null;
let passCount = 0;
let gameOver = false;
let marks = [];            // 分析高亮 [{x,y,color}]
let lastMove = null;       // [x,y]
let winLine = null;        // 连五连线
let immortalMap = new Map();
let sideImmortal = new Set();
let aiThinking = false;
let stopStream = false;
let rules = { maxImmortalSize: 20, noAdjImmortal: false, oneImmortalPerSide: true, stoneNoScore: true };
let chart = null;
let chartData = { labels: [], black: [], white: [] };
let chatHistory = [];      // {role, content}

// ---- DOM ----
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const hoverCoord = document.getElementById('hoverCoord');
const aiProgress = document.getElementById('aiProgress');
const aiProgressFill = document.getElementById('aiProgressFill');
const aiProgressText = document.getElementById('aiProgressText');
const chatBody = document.getElementById('chatBody');
const chatInput = document.getElementById('chatInput');
const chatStatus = document.getElementById('chatStatus');
const stopBtn = document.getElementById('stopBtn');
const toast = document.getElementById('toast');

// ---- 棋盘渲染参数 ----
const MARGIN = 28;
const CELL = (760 - MARGIN * 2) / (SIZE - 1);
const STONE_R = CELL * 0.46;

function px(i) { return MARGIN + i * CELL; }
function fromPx(p) { return Math.round((p - MARGIN) / CELL); }

function drawBoard() {
  const W = canvas.width, H = canvas.height;
  // 棋盘底色
  ctx.fillStyle = '#dcb573';
  ctx.fillRect(0, 0, W, H);
  // 木纹噪点
  ctx.fillStyle = 'rgba(120,80,30,0.04)';
  for (let i = 0; i < 400; i++) ctx.fillRect(Math.random() * W, Math.random() * H, 2, 1);
  // 网格线
  ctx.strokeStyle = '#3a2a18';
  ctx.lineWidth = 1;
  for (let i = 0; i < SIZE; i++) {
    ctx.beginPath(); ctx.moveTo(px(0), px(i)); ctx.lineTo(px(SIZE - 1), px(i)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(px(i), px(0)); ctx.lineTo(px(i), px(SIZE - 1)); ctx.stroke();
  }
  // 星位（19路：天元 + 4角3-3 + 4边中点）
  const stars = [[3,3],[9,3],[15,3],[3,9],[15,9],[3,15],[9,15],[15,15],[9,9]];
  ctx.fillStyle = '#2a1a0a';
  for (const [sx, sy] of stars) { ctx.beginPath(); ctx.arc(px(sx), px(sy), 3.5, 0, 7); ctx.fill(); }
  // 坐标
  ctx.fillStyle = '#5a4220';
  ctx.font = '11px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let i = 0; i < SIZE; i++) {
    ctx.fillText(String.fromCharCode(65 + i), px(i), 12);
    ctx.fillText(String(SIZE - i), 12, px(i));
  }
  // 棋子
  for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) {
    if (board[x][y] === EMPTY) continue;
    drawStone(x, y, board[x][y]);
  }
  // 不朽块标记环
  ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 2.5;
  for (const [k, c] of immortalMap) {
    const x = k % SIZE, y = Math.floor(k / SIZE);
    ctx.beginPath(); ctx.arc(px(x), px(y), STONE_R + 3, 0, 7); ctx.stroke();
  }
  // 最后一手标记
  if (lastMove) {
    ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(px(lastMove[0]), px(lastMove[1]), STONE_R * 0.4, 0, 7); ctx.stroke();
  }
  // 连五获胜线
  if (winLine) {
    ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(px(winLine[0][0]), px(winLine[0][1]));
    ctx.lineTo(px(winLine[4][0]), px(winLine[4][1])); ctx.stroke();
  }
  // 分析标记
  for (const m of marks) {
    ctx.strokeStyle = m.color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(px(m.x), px(m.y), STONE_R * 0.55, 0, 7); ctx.stroke();
  }
}

function drawStone(x, y, color) {
  const cx = px(x), cy = px(y), r = STONE_R;
  // 阴影
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath(); ctx.arc(cx + 1.5, cy + 2, r, 0, 7); ctx.fill();
  // 棋子
  const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
  if (color === BLACK) { grad.addColorStop(0, '#555'); grad.addColorStop(1, '#0a0a0a'); }
  else { grad.addColorStop(0, '#fff'); grad.addColorStop(1, '#c8c8c8'); }
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
}

// ---- 鼠标交互 ----
canvas.addEventListener('mousemove', e => {
  const rect = canvas.getBoundingClientRect();
  const sx = (e.clientX - rect.left) * (canvas.width / rect.width);
  const sy = (e.clientY - rect.top) * (canvas.height / rect.height);
  const x = fromPx(sx), y = fromPx(sy);
  if (x >= 0 && x < SIZE && y >= 0 && y < SIZE) hoverCoord.textContent = coord(x, y);
  else hoverCoord.textContent = '';
});
canvas.addEventListener('mouseleave', () => hoverCoord.textContent = '');
canvas.addEventListener('click', e => {
  if (gameOver || aiThinking) return;
  if (document.getElementById('aiEnable').checked && currentPlayer === WHITE) return; // AI回合
  const rect = canvas.getBoundingClientRect();
  const sx = (e.clientX - rect.left) * (canvas.width / rect.width);
  const sy = (e.clientY - rect.top) * (canvas.height / rect.height);
  const x = fromPx(sx), y = fromPx(sy);
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
  doMove(x, y);
});

// ---- 落子核心 ----
function getState() { return { immortalMap, sideImmortal }; }

function doMove(x, y, isPass = false) {
  if (gameOver) return;
  if (!isPass && board[x][y] !== EMPTY) { showToast('该点已有棋子', true); return; }
  // 保存历史用于悔棋
  history.push({
    board: GoImmortal.cloneBoard(board), player: currentPlayer,
    ko: koPoint, state: { immortalMap: new Map(immortalMap), sideImmortal: new Set(sideImmortal) },
    passCount, lastMove: lastMove ? [...lastMove] : null, winLine
  });
  if (isPass) {
    passCount++;
    addChat('ai', `<b>${currentPlayer === BLACK ? '黑' : '白'}方弃权</b>（连续弃权 ${passCount}/2）`);
    if (GoImmortal.isGameOver(board, passCount)) { endGame(); return; }
    nextTurn();
    return;
  }
  const r = GoImmortal.tryMove(board, x, y, currentPlayer, rules, getState(), koPoint);
  if (!r.ok) { showToast(r.reason, true); history.pop(); return; }
  board = r.board;
  koPoint = r.koPoint;
  lastMove = [x, y];
  passCount = 0;
  // 不朽触发
  if (r.immortalTriggered) {
    r.immortalStones.forEach(([sx, sy]) => immortalMap.set(sy * SIZE + sx, currentPlayer));
    sideImmortal.add(currentPlayer);
    const line = GoImmortal.findFiveLine(board, x, y, currentPlayer);
    winLine = line;
    addChat('ai', `<b>⚡ 连五不朽触发！</b>${currentPlayer === BLACK ? '黑' : '白'}方在 ${coord(x, y)} 连成五子，整个连通棋块（${r.immortalStones.length} 子）变为<b>不朽块</b>，永久存活且围住的空点锁定为领地。`);
  }
  drawBoard();
  updateSituation();
  if (winLine) { setTimeout(() => endByImmortal(), 600); return; }
  nextTurn();
}

function nextTurn() {
  currentPlayer = currentPlayer === BLACK ? WHITE : BLACK;
  if (!gameOver && document.getElementById('aiEnable').checked && currentPlayer === WHITE) {
    setTimeout(() => aiTurn(), 200);
  }
}

// ---- AI 回合（异步 MCTS，避免阻塞）----
async function aiTurn() {
  if (gameOver) return;
  aiThinking = true;
  showProgress(0, 20, '正在评估局面…');
  // 让出主线程两帧，确保进度条先渲染出来
  await new Promise(r => requestAnimationFrame(r));
  await new Promise(r => requestAnimationFrame(r));
  let lastProg = 0;
  const result = GoImmortal.mcts(board, WHITE, rules, getState(), koPoint,
    { simulations: 20, topK: 8 },
    (p) => {
      if (p.done - lastProg >= 4) { lastProg = p.done; showProgress(p.done, p.total, `正在评估局面… (${p.done}/${p.total})`); }
    }
  );
  showProgress(20, 20, '评估完成，落子中…');
  await new Promise(r => requestAnimationFrame(r));
  hideProgress();
  aiThinking = false;
  if (result.pass || result.x < 0) { doMove(0, 0, true); return; }
  doMove(result.x, result.y);
  // AI 解说
  commentMove(result.x, result.y, result.scores);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function showProgress(done, total, text) {
  aiProgress.style.display = 'flex';
  aiProgressFill.style.width = `${(done / total) * 100}%`;
  aiProgressText.textContent = text;
}
function hideProgress() { aiProgress.style.display = 'none'; }

// ---- 形势更新 ----
function updateSituation() {
  const ev = GoImmortal.evaluate(board, immortalMap, rules);
  document.getElementById('blackScore').textContent = ev.black;
  document.getElementById('whiteScore').textContent = ev.white;
  const total = ev.black + ev.white || 1;
  document.getElementById('sitBlack').style.width = `${(ev.black / total) * 100}%`;
  document.getElementById('sitWhite').style.width = `${(ev.white / total) * 100}%`;
  let verdict = '均势';
  if (ev.net > 30) verdict = '黑棋优势';
  else if (ev.net > 10) verdict = '黑棋略优';
  else if (ev.net < -30) verdict = '白棋优势';
  else if (ev.net < -10) verdict = '白棋略优';
  if (immortalMap.size > 0) {
    const bk = [...immortalMap.values()].filter(v => v === BLACK).length;
    const wk = [...immortalMap.values()].filter(v => v === WHITE).length;
    document.getElementById('immortalTag').textContent = `不朽块 黑${bk}/白${wk}`;
  } else document.getElementById('immortalTag').textContent = '';
  document.getElementById('sitVerdict').textContent = `${verdict} · 黑领地${ev.blackTerr}目 / 白领地${ev.whiteTerr}目`;
  // 折线图
  chartData.labels.push(`第${history.length + 1}手`);
  chartData.black.push(ev.black);
  chartData.white.push(ev.white);
  if (chart) {
    chart.data.labels = chartData.labels;
    chart.data.datasets[0].data = chartData.black.map(v => compress(v));
    chart.data.datasets[1].data = chartData.white.map(v => compress(v));
    chart.update('none');
  }
}

// 对数压缩，避免五连/大领地撑爆刻度
function compress(v) { const sign = v >= 0 ? 1 : -1; return sign * Math.log1p(Math.abs(v)); }

// ---- 终局 ----
function endByImmortal() {
  gameOver = true;
  const ev = GoImmortal.evaluate(board, immortalMap, rules);
  addChat('ai', `<b>🏁 连五不朽获胜！</b>${sideImmortal.has(BLACK) ? '黑' : '白'}方触发不朽块。<br>最终：黑 ${ev.black} 目 / 白 ${ev.white} 目。`);
}
function endGame() {
  gameOver = true;
  const ev = GoImmortal.evaluate(board, immortalMap, rules);
  const winner = ev.net > 0 ? '黑' : ev.net < 0 ? '白' : '平';
  addChat('ai', `<b>🏁 终局</b>（双方弃权）。<br>黑 ${ev.black} 目 / 白 ${ev.white} 目 → <b>${winner === '平' ? '和局' : winner + '方获胜'}</b>`);
}

// ---- 分析最优下法 ----
function analyzeBest() {
  if (aiThinking) { showToast('AI 正在思考，请稍候', true); return; }
  const result = GoImmortal.mcts(board, currentPlayer, rules, getState(), koPoint, { simulations: 30, topK: 10 });
  marks = result.scores.slice(0, 5).map((s, i) => ({ x: s.x, y: s.y, color: ['#fbbf24', '#6ee7b7', '#4d9fff', '#a78bfa', '#f87171'][i] }));
  drawBoard();
  const text = result.scores.slice(0, 5).map((s, i) => `${i + 1}. ${coord(s.x, s.y)}（评分 ${Math.round(s.score)}）`).join('  ');
  addChat('ai', `<b>最优下法 Top5</b>（当前${currentPlayer === BLACK ? '黑' : '白'}方）：<br>${text}`);
}

// ---- AI 解说（DeepSeek 流式）----
async function commentMove(x, y, scores) {
  const apiKey = localStorage.getItem('deepseek_key');
  if (!apiKey) return; // 无 Key 静默
  const model = document.getElementById('modelSelect').value;
  const ev = GoImmortal.evaluate(board, immortalMap, rules);
  const top5 = scores.slice(0, 5).map((s, i) => `${i + 1}.${coord(s.x, s.y)}(${Math.round(s.score)})`).join(' ');
  const boardText = boardTextForAI();
  const sys = `你是围棋·五子不朽游戏的解说。规则：围棋气/提子/领地 + 连五触发不朽块。客观、简短（1-3句），平淡时一句话带过。绝不可把昏招说成妙手。结合当前目数差、不朽块、Top5推荐点点评。若落子不在Top5，委婉指出更优位置。`;
  const user = `当前局面（${currentPlayer === BLACK ? '白' : '黑'}方刚下 ${coord(x, y)}，现轮${currentPlayer === BLACK ? '黑' : '白'}方）：\n黑${ev.black}目/白${ev.white}目，净差${ev.net}。不朽块${immortalMap.size}子。Top5推荐：${top5}\n棋盘：\n${boardText}`;
  await streamChat([{ role: 'system', content: sys }, { role: 'user', content: user }], model, 'ai');
}

function boardTextForAI() {
  let s = '   ';
  for (let x = 0; x < SIZE; x++) s += String.fromCharCode(65 + x);
  s += '\n';
  for (let y = 0; y < SIZE; y++) {
    s += (SIZE - y).toString().padStart(2) + ' ';
    for (let x = 0; x < SIZE; x++) s += board[x][y] === BLACK ? 'X' : board[x][y] === WHITE ? 'O' : '.';
    s += '\n';
  }
  return s + '(X黑 O白 .空)';
}

// ---- 流式对话 ----
async function streamChat(messages, model, role) {
  const apiKey = localStorage.getItem('deepseek_key');
  if (!apiKey) { addChat('ai', '<i>未配置 API Key，解说/对话不可用。请点击右上「API 设置」。</i>'); return; }
  stopStream = false; stopBtn.disabled = false; chatStatus.textContent = '生成中…';
  const msgEl = addChat(role, '');
  const isReasoner = model === 'deepseek-reasoner';
  let text = '', reasoning = '';
  try {
    const resp = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, stream: true })
    });
    if (!resp.ok) { const e = await resp.text(); addChat('ai', `<i>API 错误 ${resp.status}：${e.slice(0, 100)}</i>`); return; }
    const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) {
      if (stopStream) break;
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim(); if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const delta = j.choices[0]?.delta || {};
          if (delta.reasoning_content) { reasoning += delta.reasoning_content; renderMsg(msgEl, text, isReasoner ? reasoning : ''); }
          if (delta.content) { text += delta.content; renderMsg(msgEl, text, isReasoner ? reasoning : ''); }
        } catch (e) {}
      }
    }
  } catch (e) { addChat('ai', `<i>网络错误：${e.message}</i>`); }
  finally { stopBtn.disabled = true; chatStatus.textContent = '就绪'; chatHistory.push({ role, content: text }); }
}

function renderMsg(el, text, reasoning) {
  const t = marked.parse(text || (reasoning ? '' : '…'));
  const r = reasoning ? `<details class="thinking"><summary>💭 思考过程</summary>${marked.parse(reasoning)}</details>` : '';
  el.querySelector('.msg-text').innerHTML = r + t;
  chatBody.scrollTop = chatBody.scrollHeight;
}

function addChat(role, html) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = `<div class="msg-author">${role === 'ai' ? 'AI 解说' : '你'}</div><div class="msg-text">${html}</div>`;
  chatBody.appendChild(div);
  chatBody.scrollTop = chatBody.scrollHeight;
  return div;
}

function showToast(msg, err) {
  toast.textContent = msg; toast.className = 'toast show' + (err ? ' err' : '');
  setTimeout(() => toast.classList.remove('show'), 2200);
}

// ---- 控件事件 ----
document.getElementById('undoBtn').onclick = () => {
  if (history.length === 0) return;
  // AI 回合悔两步（撤回 AI 的落子 + 自己的落子）
  let steps = (document.getElementById('aiEnable').checked && currentPlayer === BLACK && history.length >= 2) ? 2 : 1;
  for (let i = 0; i < steps && history.length; i++) {
    const h = history.pop();
    board = h.board; currentPlayer = h.player; koPoint = h.ko;
    immortalMap = h.state.immortalMap; sideImmortal = h.state.sideImmortal;
    passCount = h.passCount; lastMove = h.lastMove; winLine = h.winLine;
  }
  gameOver = false; marks = []; drawBoard(); updateSituation();
  // 撤回图表
  for (let i = 0; i < steps; i++) { chartData.labels.pop(); chartData.black.pop(); chartData.white.pop(); }
  if (chart) { chart.data.labels = chartData.labels; chart.data.datasets[0].data = chartData.black.map(compress); chart.data.datasets[1].data = chartData.white.map(compress); chart.update('none'); }
};
document.getElementById('passBtn').onclick = () => { if (!aiThinking && !gameOver) doMove(0, 0, true); };
document.getElementById('restartBtn').onclick = () => restart();
document.getElementById('analyzeBtn').onclick = () => analyzeBest();
document.getElementById('clearMarksBtn').onclick = () => { marks = []; winLine = null; drawBoard(); };
document.getElementById('sendBtn').onclick = sendChat;
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
stopBtn.onclick = () => { stopStream = true; };

function sendChat() {
  const q = chatInput.value.trim(); if (!q) return;
  chatInput.value = '';
  addChat('user', q);
  const ev = GoImmortal.evaluate(board, immortalMap, rules);
  const sys = `你是围棋·五子不朽游戏的 AI 助手。基于当前棋局回答。当前：黑${ev.black}目/白${ev.white}目，不朽块${immortalMap.size}子。棋盘：\n${boardTextForAI()}`;
  streamChat([{ role: 'system', content: sys }, { role: 'user', content: q }], document.getElementById('modelSelect').value, 'ai');
}

function restart() {
  board = GoImmortal.emptyBoard(); currentPlayer = BLACK; history = []; koPoint = null;
  passCount = 0; gameOver = false; marks = []; lastMove = null; winLine = null;
  immortalMap = new Map(); sideImmortal = new Set(); aiThinking = false;
  chartData = { labels: [], black: [], white: [] };
  if (chart) { chart.data.labels = []; chart.data.datasets[0].data = []; chart.data.datasets[1].data = []; chart.update(); }
  drawBoard(); updateSituation();
  addChat('ai', '🔄 新对局开始。黑方先行。');
}

// ---- 规则设置 ----
document.getElementById('rulesBtn').onclick = () => document.getElementById('rulesModal').classList.add('show');
document.getElementById('closeRules').onclick = () => document.getElementById('rulesModal').classList.remove('show');
document.getElementById('applyRules').onclick = () => {
  const a = document.getElementById('ruleMaxSize').checked;
  const b = document.getElementById('ruleNoAdj').checked;
  const c = document.getElementById('ruleOneImmortal').checked;
  const d = document.getElementById('ruleStoneNoScore').checked;
  if (!a && !b && !c && !d) { document.getElementById('ruleMsg').textContent = '至少启用一项'; document.getElementById('ruleMsg').className = 'test-result err'; return; }
  rules = { maxImmortalSize: a ? 20 : null, noAdjImmortal: b, oneImmortalPerSide: c, stoneNoScore: d };
  document.getElementById('ruleMsg').textContent = '已应用 ✓'; document.getElementById('ruleMsg').className = 'test-result ok';
  setTimeout(() => document.getElementById('rulesModal').classList.remove('show'), 800);
};

// ---- API 设置 ----
document.getElementById('settingsBtn').onclick = () => { document.getElementById('apiKeyInput').value = localStorage.getItem('deepseek_key') || ''; document.getElementById('settingsModal').classList.add('show'); };
document.getElementById('closeSettings').onclick = () => document.getElementById('settingsModal').classList.remove('show');
document.getElementById('saveKeyBtn').onclick = () => { localStorage.setItem('deepseek_key', document.getElementById('apiKeyInput').value.trim()); showToast('API Key 已保存'); document.getElementById('settingsModal').classList.remove('show'); };
document.getElementById('testBtn').onclick = async () => {
  const k = document.getElementById('apiKeyInput').value.trim();
  const el = document.getElementById('testResult');
  el.textContent = '测试中…'; el.className = 'test-result';
  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${k}` }, body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }) });
    el.textContent = r.ok ? '✓ 连接成功' : `✗ 失败 ${r.status}`; el.className = 'test-result ' + (r.ok ? 'ok' : 'err');
  } catch (e) { el.textContent = '✗ ' + e.message; el.className = 'test-result err'; }
};

// ---- 折线图 ----
function initChart() {
  const cctx = document.getElementById('sitChart').getContext('2d');
  chart = new Chart(cctx, {
    type: 'line',
    data: { labels: [], datasets: [
      { label: '黑方', data: [], borderColor: '#888', backgroundColor: 'rgba(50,50,50,.15)', tension: 0.3, pointRadius: 2 },
      { label: '白方', data: [], borderColor: '#f5f5f5', backgroundColor: 'rgba(245,245,245,.1)', tension: 0.3, pointRadius: 2 }
    ]},
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#e4e7eb', font: { size: 11 } } }, tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}：${Math.round(Math.expm1(Math.abs(ctx.parsed.y)) * Math.sign(ctx.parsed.y))} 目` } } },
      scales: {
        x: { ticks: { color: '#8b95a3', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,.05)' } },
        y: { title: { display: true, text: '目数（对数压缩）', color: '#8b95a3', font: { size: 10 } }, ticks: { color: '#8b95a3', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,.05)' } }
      }
    }
  });
}

// ---- 启动 ----
initChart();
drawBoard();
updateSituation();
