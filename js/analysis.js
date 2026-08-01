/* =====================================================================
 * GomokuAnalysis — 程序化棋局分析引擎
 *  - 模式识别（活/眠：二、三、四、五）积分算法
 *  - 形势评分（黑白双方积分 → 净优势）
 *  - Top5 推荐落点（攻防综合）
 *  - 落子类型判定（进攻/防守/孤立/接近胜利/普通）
 *  - 胜负与获胜连线检测
 * 棋盘约定：board[x][y]，x=列(0..14 => A..O)，y=行(0..14，0为顶部=15，14为底部=1)
 * ===================================================================== */
const GomokuAnalysis = (function () {
  const SIZE = 15;
  const EMPTY = 0, BLACK = 1, WHITE = 2;

  // ---- 构造所有线（行/列/两条对角），每条线是 [x,y] 数组 ----
  function buildLines() {
    const lines = [];
    for (let y = 0; y < SIZE; y++) { const l = []; for (let x = 0; x < SIZE; x++) l.push([x, y]); lines.push(l); }
    for (let x = 0; x < SIZE; x++) { const l = []; for (let y = 0; y < SIZE; y++) l.push([x, y]); lines.push(l); }
    for (let d = -(SIZE - 1); d <= SIZE - 1; d++) {
      const l = [];
      for (let x = 0; x < SIZE; x++) { const y = x - d; if (y >= 0 && y < SIZE) l.push([x, y]); }
      if (l.length >= 5) lines.push(l);
    }
    for (let d = 0; d <= 2 * (SIZE - 1); d++) {
      const l = [];
      for (let x = 0; x < SIZE; x++) { const y = d - x; if (y >= 0 && y < SIZE) l.push([x, y]); }
      if (l.length >= 5) lines.push(l);
    }
    return lines;
  }
  const LINES = buildLines();

  // ---- 棋型表：own=1, empty=0, opp/boundary=2 ----
  // 顺序很重要：先匹配高分/更具体的，匹配后用 '2' 覆盖避免重复计数
  const PATTERNS = [
    [/11111/,                                100000, '五连'],
    [/011110/,                               10000,  '活四'],
    [/011112|211110|10111|11011|11101/,      1000,   '冲四'],
    [/01110|010110|011010/,                  500,    '活三'],
    [/21110|01112|210110|011012|211010|010112/, 50,  '眠三'],
    [/0110|01010|010010/,                    20,     '活二'],
    [/2110|0112|21010|01012/,                5,      '眠二'],
  ];

  function scoreLineString(str) {
    let score = 0;
    const found = {};
    for (const [re, val, name] of PATTERNS) {
      const g = new RegExp(re.source, 'g');
      let m;
      while ((m = g.exec(str)) !== null) {
        score += val;
        found[name] = (found[name] || 0) + 1;
        str = str.slice(0, m.index) + '2'.repeat(m[0].length) + str.slice(m.index + m[0].length);
        g.lastIndex = 0;
      }
    }
    return { score, found };
  }

  // 评估某一方在整盘的积分 + 棋型统计（含孤立子惩罚）
  function evaluateBoard(board, player) {
    let total = 0;
    const allFound = {};
    for (const line of LINES) {
      let str = '2';
      for (const [x, y] of line) {
        const v = board[x][y];
        str += v === player ? '1' : v === EMPTY ? '0' : '2';
      }
      str += '2';
      const r = scoreLineString(str);
      total += r.score;
      for (const k in r.found) allFound[k] = (allFound[k] || 0) + r.found[k];
    }
    // 孤立子惩罚：棋盘上有其它子，但本子周围2格内无任何子 → 每子 -2
    let otherStones = 0;
    for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) if (board[x][y] !== EMPTY) otherStones++;
    let isolated = 0;
    if (otherStones > 1) {
      for (let x = 0; x < SIZE; x++) {
        for (let y = 0; y < SIZE; y++) {
          if (board[x][y] !== player) continue;
          let near = false;
          for (let dx = -2; dx <= 2 && !near; dx++) for (let dy = -2; dy <= 2 && !near; dy++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && board[nx][ny] !== EMPTY) near = true;
          }
          if (!near) isolated++;
        }
      }
    }
    total -= isolated * 2;
    return { score: total, patterns: allFound, isolated };
  }

  // 双方形势
  function evaluate(board) {
    const b = evaluateBoard(board, BLACK);
    const w = evaluateBoard(board, WHITE);
    return {
      black: b.score, white: w.score,
      blackPatterns: b.patterns, whitePatterns: w.patterns,
      blackIsolated: b.isolated, whiteIsolated: w.isolated,
      net: b.score - w.score,
    };
  }

  // ---- 候选点：任意已有子周围2格内的空点（空盘返回天元）----
  function candidates(board) {
    const set = new Set();
    let any = false;
    for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) {
      if (board[x][y] === EMPTY) continue;
      any = true;
      for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && board[nx][ny] === EMPTY) set.add(ny * SIZE + nx);
      }
    }
    if (!any) return [[7, 7]];
    return [...set].map(i => [i % SIZE, Math.floor(i / SIZE)]);
  }

  // ---- Top5 推荐落点（当前轮到 player）----
  // 落点价值 = 我方进攻增益 + 对方若占此点的进攻价值（防守价值）
  function recommend(board, player, topN = 5) {
    const opp = player === BLACK ? WHITE : BLACK;
    const base = evaluate(board);
    const baseMine = player === BLACK ? base.black : base.white;
    const baseOpp = player === BLACK ? base.white : base.black;
    const cands = candidates(board);
    const list = [];
    for (const [x, y] of cands) {
      // 我方落子
      board[x][y] = player;
      const afterMine = evaluateBoard(board, player).score;
      board[x][y] = EMPTY;
      const myGain = afterMine - baseMine;
      // 对方若落子于此（我方防守掉的价值）
      board[x][y] = opp;
      const afterOpp = evaluateBoard(board, opp).score;
      board[x][y] = EMPTY;
      const oppGain = afterOpp - baseOpp;
      const value = myGain + oppGain;
      list.push({ x, y, score: Math.round(value), myGain: Math.round(myGain), oppGain: Math.round(oppGain) });
    }
    list.sort((a, b) => b.score - a.score);
    return list.slice(0, topN);
  }

  // ---- 落子类型判定 ----
  function classifyMove(board, move, player) {
    const opp = player === BLACK ? WHITE : BLACK;
    const { x, y } = move;
    // 去掉本手 → before
    board[x][y] = EMPTY;
    const beforeMine = evaluateBoard(board, player).score;
    const beforeOpp = evaluateBoard(board, opp).score;
    board[x][y] = player;
    const afterMine = evaluateBoard(board, player).score;
    const afterOpp = evaluateBoard(board, opp).score;
    const myGain = afterMine - beforeMine;
    const oppLoss = beforeOpp - afterOpp; // 正=削弱对方
    // 孤立判定
    let near = false;
    for (let dx = -2; dx <= 2 && !near; dx++) for (let dy = -2; dy <= 2 && !near; dy++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && board[nx][ny] !== EMPTY) near = true;
    }
    const isolated = !near;
    // 是否形成五连/活四/冲四
    const mineAfter = evaluateBoard(board, player);
    const nearWin = (mineAfter.patterns['五连'] || 0) > 0 || (mineAfter.patterns['活四'] || 0) > 0 || (mineAfter.patterns['冲四'] || 0) > 0;
    let type, label;
    if ((mineAfter.patterns['五连'] || 0) > 0) { type = 'win'; label = '制胜'; }
    else if (nearWin) { type = 'nearwin'; label = '接近胜利'; }
    else if (oppLoss >= 200) { type = 'defense'; label = '防守'; }
    else if (myGain >= 200) { type = 'attack'; label = '进攻'; }
    else if (isolated) { type = 'isolated'; label = '孤立'; }
    else { type = 'normal'; label = '普通'; }
    return { type, label, myGain: Math.round(myGain), oppLoss: Math.round(oppLoss), isolated, nearWin };
  }

  // ---- 胜负检测：从 (x,y) 出发 4 个方向找 ≥5 连 ----
  function checkWin(board, x, y) {
    const color = board[x][y];
    if (color === EMPTY) return null;
    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (const [dx, dy] of dirs) {
      const cells = [[x, y]];
      for (let i = 1; i < 5; i++) { const nx = x + dx * i, ny = y + dy * i; if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && board[nx][ny] === color) cells.push([nx, ny]); else break; }
      for (let i = 1; i < 5; i++) { const nx = x - dx * i, ny = y - dy * i; if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && board[nx][ny] === color) cells.unshift([nx, ny]); else break; }
      if (cells.length >= 5) return cells.slice(0, 5);
    }
    return null;
  }

  function isBoardFull(board) {
    for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) if (board[x][y] === EMPTY) return false;
    return true;
  }

  return {
    SIZE, EMPTY, BLACK, WHITE,
    evaluate, evaluateBoard, recommend, candidates,
    classifyMove, checkWin, isBoardFull,
  };
})();
