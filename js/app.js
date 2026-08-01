/* =====================================================================
 * app.js — 五子棋主程序：棋盘渲染 / 对弈 / 形势 / AI 解说与对话
 * 依赖：GomokuAnalysis(analysis.js)、Chart.js、marked.js
 * ===================================================================== */
(() => {
  const GA = GomokuAnalysis;
  const SIZE = GA.SIZE;
  const BLACK = GA.BLACK, WHITE = GA.WHITE;

  // ---------- 工具：坐标 ----------
  const letterOf = (x) => String.fromCharCode(65 + x);       // 0->A ... 14->O
  const numberOf = (y) => 15 - y;                            // 0->15(顶) ... 14->1(底)
  const coordOf = (x, y) => letterOf(x) + numberOf(y);

  // ---------- 游戏状态 ----------
  const State = {
    board: emptyBoard(),
    history: [],          // {x,y,player}
    current: BLACK,
    over: false,
    winner: 0,
    winLine: null,
    marks: [],            // [{x,y,rank,score}] Top5 高亮
    scoreHistory: [{ move: 0, black: 0, white: 0, net: 0 }],
    lastTop5Note: null,
  };
  function emptyBoard() { return Array.from({ length: SIZE }, () => Array(SIZE).fill(0)); }

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const canvas = $('board'), ctx = canvas.getContext('2d');
  const hoverCoord = $('hoverCoord');
  const chatBody = $('chatBody'), chatInput = $('chatInput');
  const stopBtn = $('stopBtn'), sendBtn = $('sendBtn');
  const chatStatus = $('chatStatus');
  const modelSelect = $('modelSelect');

  // ---------- 棋盘渲染 ----------
  let cell = 0, margin = 0, cssSize = 0;
  const STAR = [[3, 3], [3, 7], [3, 11], [7, 3], [7, 7], [7, 11], [11, 3], [11, 7], [11, 11]];

  function resizeCanvas() {
    const wrap = $('boardWrap');
    cssSize = wrap.clientWidth - 16; // padding 8*2
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cssSize * dpr;
    canvas.height = cssSize * dpr;
    canvas.style.width = cssSize + 'px';
    canvas.style.height = cssSize + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    margin = cssSize * 0.045;
    cell = (cssSize - 2 * margin) / 14;
    draw();
  }
  function px(x) { return margin + x * cell; }
  function py(y) { return margin + y * cell; }

  function draw() {
    ctx.clearRect(0, 0, cssSize, cssSize);
    // 木色底
    const g = ctx.createLinearGradient(0, 0, cssSize, cssSize);
    g.addColorStop(0, '#e0bd86'); g.addColorStop(1, '#cf9e5f');
    ctx.fillStyle = g; ctx.fillRect(0, 0, cssSize, cssSize);

    // 网格
    ctx.strokeStyle = 'rgba(40,25,10,.55)';
    ctx.lineWidth = 1;
    for (let i = 0; i < SIZE; i++) {
      ctx.beginPath(); ctx.moveTo(px(0), py(i)); ctx.lineTo(px(14), py(i)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(px(i), py(0)); ctx.lineTo(px(i), py(14)); ctx.stroke();
    }
    // 星位
    ctx.fillStyle = 'rgba(40,25,10,.7)';
    for (const [sx, sy] of STAR) { ctx.beginPath(); ctx.arc(px(sx), py(sy), Math.max(2.2, cell * 0.07), 0, 7); ctx.fill(); }

    // 坐标标注
    ctx.fillStyle = 'rgba(60,40,15,.75)';
    ctx.font = `${Math.max(9, cell * 0.28)}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i < SIZE; i++) {
      ctx.fillText(letterOf(i), px(i), margin * 0.45);
      ctx.fillText(letterOf(i), px(i), cssSize - margin * 0.45);
      ctx.fillText(String(numberOf(i)), margin * 0.45, py(i));
      ctx.fillText(String(numberOf(i)), cssSize - margin * 0.45, py(i));
    }

    // 标记 Top5
    drawMarks();
    // 棋子
    for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) {
      if (State.board[x][y] !== 0) drawStone(x, y, State.board[x][y], false);
    }
    // 最后一步标记
    const last = State.history[State.history.length - 1];
    if (last && !State.over) {
      ctx.fillStyle = '#ef5b5b';
      ctx.beginPath(); ctx.arc(px(last.x), py(last.y), cell * 0.1, 0, 7); ctx.fill();
    }
    // 获胜连线
    if (State.winLine) drawWinLine();
  }

  function drawStone(x, y, color, ghost) {
    const r = cell * 0.43;
    const cx = px(x), cy = py(y);
    ctx.save();
    ctx.globalAlpha = ghost ? 0.42 : 1;
    // 阴影
    if (!ghost) { ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.beginPath(); ctx.arc(cx + 1.5, cy + 2, r, 0, 7); ctx.fill(); }
    if (color === BLACK) {
      const gr = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
      gr.addColorStop(0, '#5a5a5a'); gr.addColorStop(0.4, '#1c1c1c'); gr.addColorStop(1, '#000');
      ctx.fillStyle = gr;
    } else {
      const gr = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
      gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.7, '#eceef2'); gr.addColorStop(1, '#c7cbd3');
      ctx.fillStyle = gr;
    }
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
    ctx.lineWidth = 0.8; ctx.strokeStyle = color === BLACK ? 'rgba(0,0,0,.6)' : 'rgba(120,120,130,.5)';
    ctx.stroke();
    ctx.restore();
  }

  function drawMarks() {
    State.marks.forEach((m, i) => {
      const cx = px(m.x), cy = py(m.y), r = cell * 0.34;
      const colors = ['#ef5b5b', '#f0a93b', '#3ec77a', '#5b8cff', '#b07cff'];
      const c = colors[i] || '#888';
      ctx.save();
      ctx.globalAlpha = 0.92;
      ctx.strokeStyle = c; ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.stroke();
      ctx.fillStyle = c; ctx.globalAlpha = 0.95;
      ctx.font = `bold ${Math.max(10, cell * 0.32)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), cx, cy);
      ctx.restore();
    });
  }

  function drawWinLine() {
    const a = State.winLine[0], b = State.winLine[State.winLine.length - 1];
    ctx.save();
    ctx.strokeStyle = 'rgba(239,91,91,.9)'; ctx.lineWidth = cell * 0.16; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(px(a[0]), py(a[1])); ctx.lineTo(px(b[0]), py(b[1])); ctx.stroke();
    for (const [x, y] of State.winLine) {
      ctx.strokeStyle = '#ef5b5b'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(px(x), py(y), cell * 0.5, 0, 7); ctx.stroke();
    }
    ctx.restore();
  }

  // 鼠标悬停
  let hoverCell = null;
  function hoverPos(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left, my = clientY - rect.top;
    const x = Math.round((mx - margin) / cell), y = Math.round((my - margin) / cell);
    if (x < 0 || x > 14 || y < 0 || y > 14) return null;
    return [x, y];
  }
  canvas.addEventListener('mousemove', (e) => {
    const c = hoverPos(e.clientX, e.clientY);
    if (!c) { hoverCoord.classList.remove('show'); hoverCell = null; return; }
    hoverCell = c;
    hoverCoord.textContent = coordOf(c[0], c[1]) + (State.over ? '' : ' · ' + (State.current === BLACK ? '黑' : '白') + '落子');
    hoverCoord.classList.add('show');
    drawGhost();
  });
  canvas.addEventListener('mouseleave', () => { hoverCoord.classList.remove('show'); hoverCell = null; draw(); });
  function drawGhost() {
    draw();
    if (hoverCell && !State.over && State.board[hoverCell[0]][hoverCell[1]] === 0) {
      drawStone(hoverCell[0], hoverCell[1], State.current, true);
    }
  }
  canvas.addEventListener('click', (e) => {
    const c = hoverPos(e.clientX, e.clientY);
    if (c) placeMove(c[0], c[1]);
  });
  // 触摸
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const t = e.touches[0]; const c = hoverPos(t.clientX, t.clientY);
    if (c) placeMove(c[0], c[1]);
  }, { passive: false });

  // ---------- 落子主流程 ----------
  function placeMove(x, y) {
    if (State.over) { toast('对局已结束，请点击「重新开始」'); return; }
    if (State.board[x][y] !== 0) return;
    const mover = State.current;

    // 落子前的 Top5（用于点评：本手是否在推荐之列）
    State.board[x][y] = mover;
    State.history.push({ x, y, player: mover });
    State.board[x][y] = 0; // 临时还原算 pre-move 推荐
    const preTop5 = GA.recommend(State.board, mover);
    State.board[x][y] = mover; // 恢复

    const inTop = preTop5.findIndex(r => r.x === x && r.y === y);
    const moveInfo = { x, y, player: mover, coord: coordOf(x, y), preTop5, inTop };

    // 胜负
    const win = GA.checkWin(State.board, x, y);
    if (win) {
      State.over = true; State.winner = mover; State.winLine = win;
    } else if (GA.isBoardFull(State.board)) {
      State.over = true; State.winner = 0; // 平局
    }

    // 形势
    const ev = GA.evaluate(State.board);
    State.scoreHistory.push({ move: State.history.length, black: ev.black, white: ev.white, net: ev.net });
    updateSituation(ev);
    updateChart();

    // 清除上轮分析标记
    State.marks = [];
    draw();

    // 切换玩家
    if (!State.over) State.current = mover === BLACK ? WHITE : BLACK;

    // AI 解说
    runCommentary(moveInfo, ev);
  }

  // ---------- 形势条 ----------
  function updateSituation(ev) {
    $('blackScore').textContent = ev.black;
    $('whiteScore').textContent = ev.white;
    const total = ev.black + ev.white;
    let bp = total > 0 ? (ev.black / total) * 100 : 50;
    if (ev.black === 0 && ev.white === 0) bp = 50;
    bp = Math.max(4, Math.min(96, bp));
    $('sitBlack').style.width = bp + '%';
    $('sitWhite').style.width = (100 - bp) + '%';
    let verdict;
    if (ev.black === 0 && ev.white === 0) verdict = '均势 · 等待开局';
    else {
      const d = ev.net;
      if (Math.abs(d) < Math.max(50, total * 0.05)) verdict = '均势';
      else if (d > 0) verdict = d > total * 0.4 ? '黑棋明显优势' : '黑棋占优';
      else verdict = -d > total * 0.4 ? '白棋明显优势' : '白棋占优';
    }
    if (State.over) {
      if (State.winner === BLACK) verdict = '黑方获胜';
      else if (State.winner === WHITE) verdict = '白方获胜';
      else verdict = '和棋';
    }
    $('sitVerdict').textContent = verdict;
  }

  // ---------- 折线图 ----------
  let chart;
  function initChart() {
    const c = $('sitChart').getContext('2d');
    chart = new Chart(c, {
      type: 'line',
      data: {
        labels: ['0'],
        datasets: [
          { label: '黑方积分', data: [0], borderColor: '#c9ccd6', backgroundColor: 'rgba(201,204,214,.12)', tension: .25, fill: false, pointRadius: 2, borderWidth: 2 },
          { label: '白方积分', data: [0], borderColor: '#5b8cff', backgroundColor: 'rgba(91,140,255,.12)', tension: .25, fill: false, pointRadius: 2, borderWidth: 2 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { color: '#9aa1b1', boxWidth: 12, font: { size: 11 } } }, tooltip: { } },
        scales: {
          x: { ticks: { color: '#6b7180', maxTicksLimit: 12 }, grid: { color: 'rgba(255,255,255,.05)' }, title: { display: true, text: '手数', color: '#6b7180' } },
          y: { ticks: { color: '#6b7180' }, grid: { color: 'rgba(255,255,255,.05)' }, title: { display: true, text: '积分', color: '#6b7180' } },
        },
      },
    });
  }
  function updateChart() {
    const h = State.scoreHistory[State.scoreHistory.length - 1];
    chart.data.labels.push(String(h.move));
    chart.data.datasets[0].data.push(h.black);
    chart.data.datasets[1].data.push(h.white);
    chart.update('none');
  }

  // ---------- AI ----------
  const AI = {
    apiKey: localStorage.getItem('ds_api_key') || '',
    model: localStorage.getItem('ds_model') || 'deepseek-chat',
    ctrl: null,
  };
  modelSelect.value = AI.model;

  const MODEL_NAME = { 'deepseek-chat': 'V4 Flash', 'deepseek-reasoner': 'V4 Pro' };

  function isPro() { return AI.model === 'deepseek-reasoner'; }

  // 棋盘文本（供 AI）
  function boardText() {
    let header = '    ' + Array.from({ length: SIZE }, (_, i) => letterOf(i)).join(' ');
    let lines = [header];
    for (let y = 0; y < SIZE; y++) {
      let row = String(numberOf(y)).padStart(2, ' ') + '  ';
      for (let x = 0; x < SIZE; x++) {
        const v = State.board[x][y];
        row += (v === BLACK ? 'X' : v === WHITE ? 'O' : '.') + ' ';
      }
      lines.push(row);
    }
    return lines.join('\n');
  }
  function patternText(p) {
    if (!p || Object.keys(p).length === 0) return '无';
    return Object.entries(p).map(([k, v]) => `${k}×${v}`).join('，');
  }

  function buildContext(extra) {
    const ev = GA.evaluate(State.board);
    const last = State.history[State.history.length - 1];
    const toMove = State.over ? '—' : (State.current === BLACK ? '黑方' : '白方');
    return `【实时棋局数据】
轮到：${toMove}${State.over ? '（对局已结束）' : ''}
总手数：${State.history.length}
当前积分：黑 ${ev.black} / 白 ${ev.white}（${ev.net > 0 ? '黑方优势 +' + ev.net : ev.net < 0 ? '白方优势 +' + (-ev.net) : '均势'}）
黑方棋型：${patternText(ev.blackPatterns)}
白方棋型：${patternText(ev.whitePatterns)}
${extra || ''}
【棋盘 15×15】（行从上到下=15→1，列=A→O；X=黑 O=白 .=空）
${boardText()}`;
  }

  const SYS_COMMENTARY = `你是资深五子棋解说助手，根据实时棋局数据点评刚落下的一步棋。
严格要求：
1. 简短：通常 1-3 句话，最多 4 句。若该手平淡、无值得点评之处，一句话带过即可，不要硬凑。
2. 客观如实：好棋才肯定，问题手就指出并给出更优建议；绝不可把孤立无援、脱离战场或明显的问题手说成"妙手/好棋/精妙"。
3. 结合数据：可引用推荐点(Top5)、双方积分形势、棋型(活三/冲四/活四等)。
4. 当落子不在推荐 Top5 时，委婉指出并建议更优位置（给出坐标）。
5. 中文，口吻自然简洁，不堆砌套话，不滥用感叹号。`;

  const SYS_CHAT = `你是五子棋对话助手，基于提供的实时棋局数据回答用户问题。
要求：简明准确，结合实时棋型/积分/推荐点；不要无中生有；不要过度吹捧；用中文。若问题与棋局无关，可礼貌引导回棋局。`;

  async function callStream(messages, onToken, onReason, onDone, onError) {
    if (!AI.apiKey) { onError(new Error('NO_KEY')); return; }
    AI.ctrl = new AbortController();
    chatStatus.textContent = '生成中…'; chatStatus.classList.add('busy');
    stopBtn.disabled = false;
    try {
      const resp = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AI.apiKey },
        signal: AI.ctrl.signal,
        body: JSON.stringify({ model: AI.model, messages, stream: true }),
      });
      if (!resp.ok) {
        const t = await resp.text();
        throw new Error('HTTP ' + resp.status + ' ' + t.slice(0, 200));
      }
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const ln of lines) {
          const s = ln.trim();
          if (!s.startsWith('data:')) continue;
          const data = s.slice(5).trim();
          if (data === '[DONE]') { onDone(); return; }
          try {
            const j = JSON.parse(data);
            const delta = j.choices && j.choices[0] && j.choices[0].delta;
            if (!delta) continue;
            if (delta.reasoning_content) onReason(delta.reasoning_content);
            if (delta.content) onToken(delta.content);
          } catch (e) { /* ignore */ }
        }
      }
      onDone();
    } catch (e) {
      if (e.name === 'AbortError') onDone(true);
      else onError(e);
    } finally {
      AI.ctrl = null;
      chatStatus.textContent = '就绪'; chatStatus.classList.remove('busy');
      stopBtn.disabled = true;
    }
  }

  // 解说
  async function runCommentary(moveInfo, ev) {
    if (!AI.apiKey) {
      addMsg('ai', `<span class="move-tag normal">第${State.history.length}手</span> ${moveInfo.player === BLACK ? '黑' : '白'}${moveInfo.coord}（未配置 API Key，跳过 AI 解说。点击右上角「API 设置」配置 DeepSeek Key 后即可启用。）`);
      return;
    }
    const mover = moveInfo.player;
    const cls = GA.classifyMove(State.board, { x: moveInfo.x, y: moveInfo.y }, mover);
    const top5Str = moveInfo.preTop5.map((r, i) => `${i + 1}. ${coordOf(r.x, r.y)}(${r.score})`).join('  ');
    const inTopTxt = moveInfo.inTop >= 0 ? `是（推荐第${moveInfo.inTop + 1}位）` : '否';
    const ctxText = buildContext(`刚落子：${moveInfo.coord}（${mover === BLACK ? '黑' : '白'}）
本手类型：${cls.label}（进攻增益 ${cls.myGain}，削弱对方 ${cls.oppLoss}${cls.isolated ? '，孤立无援' : ''}）
是否在推荐Top5：${inTopTxt}
推荐落点Top5：${top5Str}`);

    const el = addMsg('ai', '', true);
    const tagCls = cls.type === 'win' ? 'win' : cls.type;
    el.querySelector('.msg-author').innerHTML = `AI 解说 <span class="move-tag ${tagCls}">${moveInfo.coord} · ${cls.label}</span>`;
    const txtEl = el.querySelector('.msg-text');
    let thinkEl = null;
    let acc = '';
    let reason = '';

    await callStream(
      [{ role: 'system', content: SYS_COMMENTARY }, { role: 'user', content: ctxText }],
      (t) => { acc += t; renderStream(txtEl, acc, true); },
      (r) => {
        if (!thinkEl) { thinkEl = makeThinking(el); }
        reason += r; thinkEl.querySelector('.think-body').textContent = reason;
        scrollChat();
      },
      (aborted) => {
        if (aborted) { acc += '\n\n（已停止）'; }
        renderStream(txtEl, acc, false);
        scrollChat();
      },
      (e) => {
        txtEl.innerHTML = `<span style="color:var(--bad)">解说失败：${e.message}</span>`;
      }
    );
  }

  // 对话
  async function runChat(text) {
    addMsg('user', escapeHtml(text));
    chatInput.value = ''; autoGrow();
    if (!AI.apiKey) {
      addMsg('ai', '未配置 API Key，无法对话。请点击右上角「API 设置」配置 DeepSeek API Key。');
      return;
    }
    const ctxText = buildContext('用户提问：' + text);
    const el = addMsg('ai', '', true);
    const txtEl = el.querySelector('.msg-text');
    let thinkEl = null; let acc = ''; let reason = '';
    await callStream(
      [{ role: 'system', content: SYS_CHAT }, { role: 'user', content: ctxText }],
      (t) => { acc += t; renderStream(txtEl, acc, true); },
      (r) => { if (!thinkEl) thinkEl = makeThinking(el); reason += r; thinkEl.querySelector('.think-body').textContent = reason; scrollChat(); },
      (aborted) => { if (aborted) acc += '\n\n（已停止）'; renderStream(txtEl, acc, false); scrollChat(); },
      (e) => { txtEl.innerHTML = `<span style="color:var(--bad)">对话失败：${e.message}</span>`; }
    );
  }

  function renderStream(el, text, streaming) {
    try { el.innerHTML = marked.parse(text) + (streaming ? '<span class="cursor"></span>' : ''); }
    catch { el.textContent = text; }
    scrollChat();
  }
  function makeThinking(msgEl) {
    const t = document.createElement('details');
    t.className = 'thinking'; t.open = isPro();
    t.innerHTML = `<summary>思考过程（${MODEL_NAME[AI.model]}）<span class="twirl">▸</span></summary><div class="think-body"></div>`;
    msgEl.querySelector('.msg-text').before(t);
    return t;
  }

  // ---------- 消息 DOM ----------
  function addMsg(role, html, withText) {
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    el.innerHTML = `<div class="msg-author">${role === 'ai' ? 'AI 解说' : '我'}</div><div class="msg-text">${withText ? '' : html}</div>`;
    chatBody.appendChild(el);
    scrollChat();
    return el;
  }
  function scrollChat() { chatBody.scrollTop = chatBody.scrollHeight; }
  function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---------- 控件 ----------
  $('undoBtn').onclick = () => {
    if (State.history.length === 0) { toast('没有可悔的棋'); return; }
    if (AI.ctrl) AI.ctrl.abort();
    const last = State.history.pop();
    State.board[last.x][last.y] = 0;
    State.over = false; State.winner = 0; State.winLine = null;
    State.current = last.player;
    State.marks = [];
    State.scoreHistory.pop();
    const ev = GA.evaluate(State.board);
    updateSituation(ev);
    // 图表回退
    chart.data.labels.pop(); chart.data.datasets[0].data.pop(); chart.data.datasets[1].data.pop();
    chart.update('none');
    draw();
    addMsg('ai', `已悔棋：撤回 ${last.player === BLACK ? '黑' : '白'}${coordOf(last.x, last.y)}。轮到 ${State.current === BLACK ? '黑方' : '白方'} 落子。`);
  };

  $('restartBtn').onclick = () => {
    if (AI.ctrl) AI.ctrl.abort();
    State.board = emptyBoard(); State.history = []; State.current = BLACK;
    State.over = false; State.winner = 0; State.winLine = null; State.marks = [];
    State.scoreHistory = [{ move: 0, black: 0, white: 0, net: 0 }];
    updateSituation(GA.evaluate(State.board));
    chart.data.labels = ['0']; chart.data.datasets[0].data = [0]; chart.data.datasets[1].data = [0]; chart.update('none');
    draw();
    addMsg('ai', '棋盘已重置，黑方先行。开始新对局。');
  };

  $('analyzeBtn').onclick = () => {
    if (State.over) { toast('对局已结束'); return; }
    const rec = GA.recommend(State.board, State.current);
    State.marks = rec.map((r, i) => ({ x: r.x, y: r.y, rank: i + 1, score: r.score }));
    draw();
    const lines = rec.map((r, i) => `<b>${i + 1}. ${coordOf(r.x, r.y)}</b>（评分 ${r.score}，进攻 ${r.myGain} / 防守 ${r.oppGain}）`).join('<br>');
    addMsg('ai', `当前轮到 <b>${State.current === BLACK ? '黑方' : '白方'}</b>，程序分析最优 5 个落点：<br>${lines}`);
  };

  $('clearMarksBtn').onclick = () => { State.marks = []; draw(); toast('已清除标记'); };

  // 模型切换
  modelSelect.onchange = () => {
    AI.model = modelSelect.value;
    localStorage.setItem('ds_model', AI.model);
    toast('已切换为 ' + MODEL_NAME[AI.model]);
  };

  // 停止
  stopBtn.onclick = () => { if (AI.ctrl) AI.ctrl.abort(); };

  // 发送
  sendBtn.onclick = () => {
    const t = chatInput.value.trim();
    if (!t) return;
    runChat(t);
  };
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
  });
  function autoGrow() { chatInput.style.height = 'auto'; chatInput.style.height = Math.min(120, chatInput.scrollHeight) + 'px'; }
  chatInput.addEventListener('input', autoGrow);

  // ---------- API 设置弹窗 ----------
  const modal = $('settingsModal');
  $('settingsBtn').onclick = () => { $('apiKeyInput').value = AI.apiKey; modal.classList.add('show'); };
  $('closeSettings').onclick = () => modal.classList.remove('show');
  modal.onclick = (e) => { if (e.target === modal) modal.classList.remove('show'); };
  $('saveKeyBtn').onclick = () => {
    AI.apiKey = $('apiKeyInput').value.trim();
    localStorage.setItem('ds_api_key', AI.apiKey);
    modal.classList.remove('show');
    toast(AI.apiKey ? 'API Key 已保存' : '已清除 API Key');
  };
  $('testBtn').onclick = async () => {
    const key = $('apiKeyInput').value.trim();
    const r = $('testResult');
    if (!key) { r.textContent = '请先输入 Key'; r.className = 'test-result err'; return; }
    r.textContent = '测试中…'; r.className = 'test-result';
    try {
      const resp = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5, stream: false }),
      });
      if (resp.ok) { r.textContent = '✓ 连接成功，Key 有效'; r.className = 'test-result ok'; }
      else { const t = await resp.text(); r.textContent = '✗ 失败 ' + resp.status; r.className = 'test-result err'; }
    } catch (e) { r.textContent = '✗ 网络错误'; r.className = 'test-result err'; }
  };

  // ---------- toast ----------
  let toastT;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1800);
  }

  // ---------- 启动 ----------
  window.addEventListener('resize', resizeCanvas);
  initChart();
  resizeCanvas();
  updateSituation(GA.evaluate(State.board));
})();
