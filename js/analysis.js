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

  // ===================================================================
  // Top5 推荐引擎（按用户优先级分层 + 同点多次累加规则 + 额外机制）
  //
  // 分档与分值（由高到低）：
  //   高分(h)：连五100000 / 阻挡连五99000 / 活四·阻挡活四10000 / 活三·阻挡活三5000
  //            活三→连五 潜力2000 / 阻止对方活三→连五 2000
  //   中分(m)：眠四·阻挡眠四1000 / 眠三·阻挡眠三500
  //            活二→活四 潜力800 / 阻止对方活二→活四 800
  //            活二→眠四 潜力400 / 阻止对方活二→眠四 400
  //            攻守兼备奖励 1500（同时进攻高分+防守高分）
  //   低分(l)：活二100 / 落在对方子的斜对角50 / 己方邻子支援 +5/个
  //   极低(vl)：落在对方子的左右(正交)15 / 落在正中间10
  //   无用：0
  //   扣分：被对方包围（2格内对方≥2且无己方支援）每个对方子 -4
  //
  // 同点累加（同一个点可多次加分，取其能形成的最大价值）：
  //   n 个高分  → 高分之和 × n
  //   m 个中分  → 中分之和 × (m/2)
  //   p 个低分  → 低分之和 + p
  //   q 个极低  → 极低之和 + (q/2)
  // ===================================================================
  const DIRS4 = [[1, 0], [0, 1], [1, 1], [1, -1]];

  // 棋型表（按优先级从高到低；匹配后用 '2' 覆盖，避免子模式重复计数）
  // [正则, 分值, 档位, 名称]
  const TIER_PTN = [
    [/11111/,                                           100000, 'h', '连五'],
    [/011110/,                                          10000,  'h', '活四'],
    [/01110|010110|011010/,                             5000,   'h', '活三'],
    [/011112|211110|10111|11011|11101/,                 1000,   'm', '眠四'],
    [/21110|01112|210110|011012|211010|010112/,         500,    'm', '眠三'],
    [/0110|01010|010010/,                               100,    'l', '活二'],
  ];
  // 进攻棋型 → (档位, 分值)
  const OFF_MAP = { '连五': ['h', 100000], '活四': ['h', 10000], '活三': ['h', 5000], '眠四': ['m', 1000], '眠三': ['m', 500], '活二': ['l', 100] };
  // 防守棋型（对方在此能形成的棋型 → 我方阻挡的价值）→ (档位, 分值)
  const DEF_MAP = { '连五': ['h', 99000], '活四': ['h', 10000], '活三': ['h', 5000], '眠四': ['m', 1000], '眠三': ['m', 500] };
  // 潜在威胁（续手升级路径）→ (档位, 分值)
  const THREAT_OFF = { '活二→活四': ['m', 800], '活二→眠四': ['m', 400], '活三→连五': ['h', 2000] };
  const THREAT_DEF = { '活二→活四': ['m', 800], '活二→眠四': ['m', 400], '活三→连五': ['h', 2000] };

  // 9 格窗口（中心为落子点），两端补 '2'；返回长度 11，落子点在索引 5
  function windowStr(board, x, y, player, dx, dy) {
    let s = '2';
    for (let i = -4; i <= 4; i++) {
      const nx = x + dx * i, ny = y + dy * i;
      let c = '2';
      if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE) {
        const v = board[nx][ny];
        c = v === player ? '1' : v === EMPTY ? '0' : '2';
      }
      s += c;
    }
    return s + '2';
  }
  const WC = 5; // 窗口中落子点的索引

  // 检测 (x,y) 落子后该子"参与形成"的所有棋型（4 个方向，仅统计包含中心点的匹配）
  function patternsThrough(board, x, y, player) {
    const counts = {};
    for (const [dx, dy] of DIRS4) {
      let s = windowStr(board, x, y, player, dx, dy);
      for (const [re, , , name] of TIER_PTN) {
        const g = new RegExp(re.source, 'g');
        let m;
        while ((m = g.exec(s)) !== null) {
          const hitCenter = m.index <= WC && m.index + m[0].length > WC;
          if (hitCenter) counts[name] = (counts[name] || 0) + 1;
          // 消费匹配区段（无论是否含中心），避免子模式重复计数
          s = s.slice(0, m.index) + '2'.repeat(m[0].length) + s.slice(m.index + m[0].length);
          g.lastIndex = 0;
        }
      }
    }
    return counts;
  }

  // 潜在威胁检测：落子后是否存在"续手"使棋型升级
  //   活二 → 续手能升级为活四/眠四
  //   活三 → 续手能升级为连五
  // 前提：board[x][y] 已是 player
  function potentialThreats(board, x, y, player) {
    const baseP = patternsThrough(board, x, y, player);
    const has2 = (baseP['活二'] || 0) > 0;
    const has3 = (baseP['活三'] || 0) > 0;
    const res = {};
    if (!has2 && !has3) return res;
    for (const [dx, dy] of DIRS4) {
      for (let i = -4; i <= 4; i++) {
        if (i === 0) continue;
        const sx = x + dx * i, sy = y + dy * i;
        if (sx < 0 || sx >= SIZE || sy < 0 || sy >= SIZE) continue;
        if (board[sx][sy] !== EMPTY) continue;
        board[sx][sy] = player;
        const p = patternsThrough(board, x, y, player); // 续手后原点参与的棋型
        board[sx][sy] = EMPTY;
        if (has2) {
          if ((p['活四'] || 0) > (baseP['活四'] || 0)) res['活二→活四'] = (res['活二→活四'] || 0) + 1;
          else if ((p['眠四'] || 0) > (baseP['眠四'] || 0)) res['活二→眠四'] = (res['活二→眠四'] || 0) + 1;
        }
        if (has3 && (p['连五'] || 0) > (baseP['连五'] || 0)) res['活三→连五'] = (res['活三→连五'] || 0) + 1;
      }
    }
    return res;
  }

  // 单点总价值：进攻 + 防守 + 潜在威胁 + 邻里 + 位置加成，按累加公式合成
  function pointValue(board, x, y, player) {
    const opp = player === BLACK ? WHITE : BLACK;
    // 进攻：自己落子形成的棋型
    board[x][y] = player;
    const off = patternsThrough(board, x, y, player);
    // 进攻潜在威胁：落子后是否存在续手升级路径
    const offThreat = potentialThreats(board, x, y, player);
    board[x][y] = EMPTY;
    // 防守：对方若落子于此形成的棋型（= 我方阻挡掉的价值）
    board[x][y] = opp;
    const def = patternsThrough(board, x, y, opp);
    // 防守潜在威胁：阻止对方续手升级路径
    const defThreat = potentialThreats(board, x, y, opp);
    board[x][y] = EMPTY;

    const tiers = { h: { sum: 0, n: 0 }, m: { sum: 0, n: 0 }, l: { sum: 0, n: 0 }, vl: { sum: 0, n: 0 } };
    const add = (tier, val) => { tiers[tier].sum += val; tiers[tier].n += 1; };

    let offRaw = 0, defRaw = 0; // 原始进攻/防守分（用于 UI 展示）
    for (const [name, cnt] of Object.entries(off)) { const info = OFF_MAP[name]; if (!info) continue; for (let i = 0; i < cnt; i++) { add(info[0], info[1]); offRaw += info[1]; } }
    for (const [name, cnt] of Object.entries(def)) { const info = DEF_MAP[name]; if (!info) continue; for (let i = 0; i < cnt; i++) { add(info[0], info[1]); defRaw += info[1]; } }
    // 潜在威胁计入累加
    for (const [name, cnt] of Object.entries(offThreat)) { const info = THREAT_OFF[name]; if (!info) continue; for (let i = 0; i < cnt; i++) { add(info[0], info[1]); offRaw += info[1]; } }
    for (const [name, cnt] of Object.entries(defThreat)) { const info = THREAT_DEF[name]; if (!info) continue; for (let i = 0; i < cnt; i++) { add(info[0], info[1]); defRaw += info[1]; } }

    // ① 邻里密度机制：落点周围2格内己方/对方棋子
    let myNeighbors = 0, oppNeighbors = 0;
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) continue;
      if (board[nx][ny] === player) myNeighbors++;
      else if (board[nx][ny] === opp) oppNeighbors++;
    }
    // 己方支援：每个邻格己方子 +5（低分档）
    for (let i = 0; i < myNeighbors; i++) add('l', 5);

    // ③ 攻守兼备奖励（我的想法）：同时具备进攻高分(≥活三5000)和防守高分(≥阻挡活三5000)
    if (offRaw >= 5000 && defRaw >= 5000) add('m', 1500);

    // 位置加成
    // 斜对角：4 个对角邻格有对方子 → 低分(50)
    for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && board[nx][ny] === opp) add('l', 50);
    }
    // 左右(正交邻格)：4 个正交邻格有对方子 → 极低(15)
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && board[nx][ny] === opp) add('vl', 15);
    }
    // 正中间：中心 3×3 区域 → 极低(正中10 / 一环5)
    const cdx = Math.abs(x - 7), cdy = Math.abs(y - 7);
    if (cdx <= 1 && cdy <= 1) add('vl', cdx === 0 && cdy === 0 ? 10 : 5);

    // 累加公式：高 ×n / 中 ×(n/2) / 低 +n / 极低 +(n/2)
    const h = tiers.h, m = tiers.m, l = tiers.l, vl = tiers.vl;
    let total = 0;
    if (h.n) total += h.sum * h.n;
    if (m.n) total += m.sum * (m.n / 2);
    if (l.n) total += l.sum + l.n;
    if (vl.n) total += vl.sum + (vl.n / 2);

    // ① 被对方包围扣分：2格内对方子≥2且无己方支援 → 每个对方子 -4
    if (myNeighbors === 0 && oppNeighbors >= 2) total -= oppNeighbors * 4;

    return { total: Math.round(total), off: offRaw, def: defRaw };
  }

  // ---- Top5 推荐落点（当前轮到 player）----
  function recommend(board, player, topN = 5) {
    const cands = candidates(board);
    const seen = new Set(cands.map(c => c[1] * SIZE + c[0]));
    const list = [];
    for (const [x, y] of cands) {
      const v = pointValue(board, x, y, player);
      list.push({ x, y, score: v.total, myGain: v.off, oppGain: v.def });
    }
    // 候选不足 topN（如空盘）时补充中心 3×3 空点
    if (list.length < topN) {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const x = 7 + dx, y = 7 + dy;
        if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) continue;
        const k = y * SIZE + x;
        if (seen.has(k) || board[x][y] !== EMPTY) continue;
        seen.add(k);
        const v = pointValue(board, x, y, player);
        list.push({ x, y, score: v.total, myGain: v.off, oppGain: v.def });
      }
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
