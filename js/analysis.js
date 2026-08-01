/* =====================================================================
 * GoImmortal — 围棋 + 五子不朽 游戏引擎
 *   19×19 围棋规则（气/提子/打劫/自杀禁手）+ 连五不朽块 + 领地 + 评估 + MCTS
 * 棋盘约定：board[x][y]，x=列(0..18)，y=行(0..18，0为顶部)
 * EMPTY=0, BLACK=1, WHITE=2；IMMORTAL 标记存于独立 immortalMap
 * ===================================================================== */
const GoImmortal = (function () {
  const SIZE = 19;
  const EMPTY = 0, BLACK = 1, WHITE = 2;
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  function emptyBoard() { return Array.from({ length: SIZE }, () => Array(SIZE).fill(EMPTY)); }
  function cloneBoard(b) { return b.map(c => c.slice()); }

  // ---------- 连通块与气 ----------
  // 找 (x,y) 所归属的同色连通块及气数；返回 {stones:[], liberties:Set}
  function getGroup(board, x, y) {
    const color = board[x][y];
    if (color === EMPTY) return { stones: [], liberties: new Set(), color };
    const stones = [];
    const libs = new Set();
    const seen = new Set([y * SIZE + x]);
    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop();
      stones.push([cx, cy]);
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) continue;
        const k = ny * SIZE + nx;
        const v = board[nx][ny];
        if (v === EMPTY) libs.add(k);
        else if (v === color && !seen.has(k)) { seen.add(k); stack.push([nx, ny]); }
      }
    }
    return { stones, liberties: libs, color };
  }

  // 落子模拟：返回 { ok, captured, board, koPoint, reason, immortalTriggered }
  // rules: { maxImmortalSize, noAdjImmortal, oneImmortalPerSide, stoneNoScore }
  // state: { immortalMap:Map(idx->color), sideImmortal:Set(color) }
  function tryMove(board, x, y, color, rules, state, prevKo) {
    if (board[x][y] !== EMPTY) return { ok: false, reason: '该点已有棋子' };
    const opp = color === BLACK ? WHITE : BLACK;
    const nb = cloneBoard(board);
    nb[x][y] = color;

    // 提子：检查相邻对方块的气
    const captured = [];
    const checked = new Set();
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) continue;
      if (nb[nx][ny] !== opp) continue;
      const k = ny * SIZE + nx;
      if (checked.has(k)) continue;
      const g = getGroup(nb, nx, ny);
      g.stones.forEach(s => checked.add(s[1] * SIZE + s[0]));
      if (g.liberties.size === 0) {
        // 不朽块不可提
        const imm = state && state.immortalMap;
        const removable = g.stones.filter(s => !imm || !imm.has(s[1] * SIZE + s[0]));
        if (removable.length < g.stones.length) {
          // 部分在不朽块：只提非不朽部分（实际不朽块永不无气，此处仅安全处理）
          removable.forEach(s => { nb[s[0]][s[1]] = EMPTY; captured.push(s); });
        } else {
          g.stones.forEach(s => { nb[s[0]][s[1]] = EMPTY; captured.push(s); });
        }
      }
    }

    // 自杀判定：本块无气且未提子
    const myG = getGroup(nb, x, y);
    if (myG.liberties.size === 0 && captured.length === 0) {
      return { ok: false, reason: '禁手：自杀' };
    }

    // 打劫：恰好提一子且本子单独一气
    let koPoint = null;
    if (captured.length === 1 && myG.stones.length === 1 && myG.liberties.size === 1) {
      koPoint = captured[0][1] * SIZE + captured[0][0];
      if (prevKo !== null && prevKo === (y * SIZE + x)) {
        return { ok: false, reason: '禁手：打劫同形再现' };
      }
    }

    // 邻接限制：不能紧邻对方不朽块落子（除非本手连五）
    if (rules && rules.noAdjImmortal && state && state.immortalMap) {
      const imm = state.immortalMap;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) continue;
        if (imm.has(ny * SIZE + nx) && imm.get(ny * SIZE + nx) === opp) {
          // 检查本手是否形成连五
          if (!hasFiveInRow(nb, x, y, color)) {
            return { ok: false, reason: '禁手：不可紧邻对方不朽块落子' };
          }
        }
      }
    }

    // 连五不朽触发
    let immortalTriggered = false;
    let immortalStones = [];
    if (hasFiveInRow(nb, x, y, color)) {
      // 单方仅1不朽块限制
      const allow = !(rules && rules.oneImmortalPerSide && state && state.sideImmortal && state.sideImmortal.has(color));
      if (allow) {
        const g = getGroup(nb, x, y);
        // 不朽块大小限制
        const sizeOk = !(rules && rules.maxImmortalSize) || g.stones.length <= rules.maxImmortalSize;
        if (sizeOk) {
          immortalTriggered = true;
          immortalStones = g.stones;
        }
      }
    }

    return { ok: true, board: nb, captured, koPoint, reason: '', immortalTriggered, immortalStones };
  }

  // 连五检测：从 (x,y) 出发 4 方向找 ≥5 连
  function hasFiveInRow(board, x, y, color) {
    if (board[x][y] !== color) return false;
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      let cnt = 1;
      for (let i = 1; i < 5; i++) { const nx = x + dx * i, ny = y + dy * i; if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && board[nx][ny] === color) cnt++; else break; }
      for (let i = 1; i < 5; i++) { const nx = x - dx * i, ny = y - dy * i; if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && board[nx][ny] === color) cnt++; else break; }
      if (cnt >= 5) return true;
    }
    return false;
  }
  function findFiveLine(board, x, y, color) {
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      const cells = [[x, y]];
      for (let i = 1; i < 5; i++) { const nx = x + dx * i, ny = y + dy * i; if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && board[nx][ny] === color) cells.push([nx, ny]); else break; }
      for (let i = 1; i < 5; i++) { const nx = x - dx * i, ny = y - dy * i; if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && board[nx][ny] === color) cells.unshift([nx, ny]); else break; }
      if (cells.length >= 5) return cells.slice(0, 5);
    }
    return null;
  }

  // ---------- 领地计算（终局） ----------
  // 简化：纯空区域若只被一方棋子包围 → 属该方；混合或边界 → 中性
  // 不朽块围住的空点 → 直接属该方
  function calcTerritory(board, immortalMap, rules) {
    const territory = { black: 0, white: 0, neutral: 0 };
    const owner = Array.from({ length: SIZE }, () => Array(SIZE).fill(0)); // 0空 1黑 2白 3混合
    const seen = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
    for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) {
      if (board[x][y] !== EMPTY || seen[x][y]) continue;
      // BFS 空区域
      const region = [];
      const borders = new Set();
      const stack = [[x, y]];
      seen[x][y] = true;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        region.push([cx, cy]);
        for (const [dx, dy] of DIRS) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) continue;
          if (board[nx][ny] === EMPTY) {
            if (!seen[nx][ny]) { seen[nx][ny] = true; stack.push([nx, ny]); }
          } else borders.add(board[nx][ny]);
        }
      }
      let own = 0;
      // 不朽块围住的空点优先归属不朽方
      if (immortalMap) {
        for (const [rx, ry] of region) {
          for (const [dx, dy] of DIRS) {
            const nx = rx + dx, ny = ry + dy;
            if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) continue;
            if (immortalMap.has(ny * SIZE + nx)) { own = immortalMap.get(ny * SIZE + nx); break; }
          }
          if (own) break;
        }
      }
      if (!own) {
        if (borders.size === 1) own = [...borders][0];
        else own = 0; // 混合/中性
      }
      for (const [rx, ry] of region) owner[rx][ry] = own || 3;
      if (own === BLACK) territory.black += region.length;
      else if (own === WHITE) territory.white += region.length;
      else territory.neutral += region.length;
    }
    // 不朽块棋子本身：若启用 stoneNoScore 则不计目（仅空点计目）
    return { territory, owner };
  }

  // ---------- 评估函数 ----------
  // 面板评分 = 领地评估 + 不朽潜力评估 + 安全度补偿
  // 返回 { black, white, net, blackTerr, whiteTerr, detail }
  function evaluate(board, immortalMap, rules) {
    const { territory } = calcTerritory(board, immortalMap, rules);
    // 已确定领地直接计
    let blackScore = territory.black;
    let whiteScore = territory.white;

    // 未定型区域：影响力扩散（简单版本，每方棋子向相邻空点扩散，距离衰减）
    const influence = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
    for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) {
      if (board[x][y] === EMPTY) continue;
      const sign = board[x][y] === BLACK ? 1 : -1;
      for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) continue;
        if (board[nx][ny] !== EMPTY) continue;
        const dist = Math.abs(dx) + Math.abs(dy);
        if (dist > 3) continue;
        influence[nx][ny] += sign * (1 / (1 + dist));
      }
    }
    let blackInfl = 0, whiteInfl = 0;
    for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) {
      if (board[x][y] !== EMPTY) continue;
      if (influence[x][y] > 0.3) blackInfl += 0.5;
      else if (influence[x][y] < -0.3) whiteInfl += 0.5;
    }
    blackScore += blackInfl;
    whiteScore += whiteInfl;

    // 不朽潜力评估：扫描活四/冲四威胁，估算兑现后能锁定的领地
    const threats = scanThreats(board);
    for (const t of threats.black) blackScore += estimateImmortalGain(board, t, BLACK, immortalMap) * 0.5;
    for (const t of threats.white) whiteScore += estimateImmortalGain(board, t, WHITE, immortalMap) * 0.5;

    // 安全度补偿：弱棋（少气连通块）扣分
    const safety = scanSafety(board, immortalMap);
    blackScore -= safety.blackWeak;
    whiteScore -= safety.whiteWeak;

    // 不朽块棋子计目规则
    if (rules && rules.stoneNoScore && immortalMap) {
      // 棋子不计目，已经只算空点了，无需调整
    }

    return {
      black: Math.round(blackScore), white: Math.round(whiteScore),
      net: Math.round(blackScore - whiteScore),
      blackTerr: territory.black, whiteTerr: territory.white,
      detail: { blackInfl, whiteInfl, threats, safety }
    };
  }

  // 扫描活四/冲四威胁（简化：检测 _XXXX_ 形态）
  function scanThreats(board) {
    const res = { black: [], white: [] };
    const pat4 = /011110/; // 活四
    for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) {
      if (board[x][y] === EMPTY) continue;
      const color = board[x][y];
      for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
        let s = '';
        for (let i = -3; i <= 3; i++) {
          const nx = x + dx * i, ny = y + dy * i;
          if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) s += '2';
          else { const v = board[nx][ny]; s += v === color ? '1' : v === EMPTY ? '0' : '2'; }
        }
        if (pat4.test(s)) {
          (color === BLACK ? res.black : res.white).push({ x, y, dx, dy });
        }
      }
    }
    return res;
  }

  // 估算威胁兑现为不朽块后能锁定的领地（简化：威胁点周围空点数）
  function estimateImmortalGain(board, threat, color, immortalMap) {
    let gain = 0;
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
      const nx = threat.x + dx, ny = threat.y + dy;
      if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) continue;
      if (board[nx][ny] === EMPTY) gain += 1;
    }
    return Math.min(gain, 15);
  }

  // 安全度扫描：统计少气连通块（气≤1 的弱棋扣分）
  function scanSafety(board, immortalMap) {
    const seen = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
    let blackWeak = 0, whiteWeak = 0;
    for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) {
      if (board[x][y] === EMPTY || seen[x][y]) continue;
      const g = getGroup(board, x, y);
      g.stones.forEach(s => seen[s[0]][s[1]] = true);
      if (immortalMap && g.stones.some(s => immortalMap.has(s[1] * SIZE + s[0]))) continue; // 不朽块安全
      if (g.liberties.size <= 1) {
        const penalty = g.stones.length * 1.5;
        if (g.color === BLACK) blackWeak += penalty;
        else whiteWeak += penalty;
      }
    }
    return { blackWeak: Math.round(blackWeak), whiteWeak: Math.round(whiteWeak) };
  }

  // ---------- 候选点 ----------
  function candidates(board, radius = 2) {
    const set = new Set();
    let any = false;
    for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) {
      if (board[x][y] === EMPTY) continue;
      any = true;
      for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && board[nx][ny] === EMPTY) set.add(ny * SIZE + nx);
      }
    }
    if (!any) return [[9, 9]];
    return [...set].map(i => [i % SIZE, Math.floor(i / SIZE)]);
  }

  // ---------- MCTS ----------
  // 轻量 MCTS：少量模拟，用评估函数引导走子
  // onProgress 回调用于报告"正在评估"进度
  function mcts(board, color, rules, state, prevKo, options, onProgress) {
    const opts = options || {};
    const simulations = opts.simulations || 40;   // 模拟次数
    const topK = opts.topK || 12;                  // 候选点上限
    const cands = candidates(board, 2).slice(0, 80);
    // 预筛：用评估函数给候选点打分，取 topK
    const scored = cands.map(([x, y]) => {
      const r = tryMove(board, x, y, color, rules, state, prevKo);
      if (!r.ok) return null;
      const st = mergeImmortal(state, r, color);
      const ev = evaluate(r.board, st.immortalMap, rules);
      const myScore = color === BLACK ? ev.black : ev.white;
      const oppScore = color === BLACK ? ev.white : ev.black;
      return { x, y, init: myScore - oppScore };
    }).filter(Boolean);
    scored.sort((a, b) => b.init - a.init);
    const top = scored.slice(0, topK);
    if (top.length === 0) return { x: -1, y: -1, pass: true, scores: [] };
    // 对每个 top 候选做随机模拟
    const opp = color === BLACK ? WHITE : BLACK;
    const results = top.map(c => ({ ...c, wins: 0, sims: 0 }));
    for (let s = 0; s < simulations; s++) {
      for (const c of results) {
        const r = tryMove(board, c.x, c.y, color, rules, state, prevKo);
        if (!r.ok) { c.sims++; continue; }
        const st = mergeImmortal(state, r, color);
        const winner = simulate(r.board, opp, rules, st, 12);
        if (winner === color) c.wins++;
        c.sims++;
      }
      if (onProgress && (s % 5 === 0 || s === simulations - 1)) {
        onProgress({ done: s + 1, total: simulations });
      }
    }
    // 综合：胜率 + 初始评分
    results.forEach(c => { c.score = (c.wins / Math.max(1, c.sims)) * 100 + c.init * 0.3; });
    results.sort((a, b) => b.score - a.score);
    return { x: results[0].x, y: results[0].y, scores: results.slice(0, 5) };
  }

  function mergeImmortal(state, moveResult, color) {
    if (!moveResult.immortalTriggered) return state;
    const immortalMap = new Map(state ? state.immortalMap : []);
    const sideImmortal = new Set(state ? state.sideImmortal : []);
    const c = color || (moveResult.immortalStones.length ? 1 : 0); // 兜底
    moveResult.immortalStones.forEach(([sx, sy]) => immortalMap.set(sy * SIZE + sx, c));
    sideImmortal.add(c);
    return { immortalMap, sideImmortal };
  }

  // 随机模拟 n 手，返回胜方（按评估函数净分符号）
  function simulate(board, color, rules, state, depth) {
    let b = board, cur = color, ko = null;
    for (let i = 0; i < depth; i++) {
      const cands = candidates(b, 1).slice(0, 20);
      let moved = false;
      for (let tries = 0; tries < 6 && cands.length; tries++) {
        const idx = Math.floor(Math.random() * cands.length);
        const [x, y] = cands.splice(idx, 1)[0];
        const r = tryMove(b, x, y, cur, rules, state, ko);
        if (r.ok) { b = r.board; ko = r.koPoint; cur = cur === BLACK ? WHITE : BLACK; moved = true; break; }
      }
      if (!moved) break;
    }
    const ev = evaluate(b, state && state.immortalMap, rules);
    return ev.net > 0 ? BLACK : ev.net < 0 ? WHITE : 0;
  }

  // 终局判定：双方连续弃权
  function isGameOver(board, passCount) { return passCount >= 2; }

  return {
    SIZE, EMPTY, BLACK, WHITE,
    emptyBoard, cloneBoard, getGroup, tryMove,
    hasFiveInRow, findFiveLine, calcTerritory, evaluate,
    candidates, mcts, isGameOver,
  };
})();
