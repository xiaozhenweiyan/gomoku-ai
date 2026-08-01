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
  //            新增中分机制：破除对方活二400 / 阻止对方双活三威胁2000
  //   低分(l)：活二100 / 落在对方子的斜对角50 / 己方邻子支援 +5/个
  //            新增低分机制：连接两处己方棋200 / 双向活二扩展100
  //   极低(vl)：落在对方子的左右(正交)15 / 落在正中间10
  //             新增极低：贴近主战场距离衰减
  //   无用：0
  //   扣分：被对方包围 -4/子 / 孤立废棋-30 / 放任对方活四-5000 / 放任对方活三-800
  //
  // 新增10机制：
  //  ④孤立废棋惩罚：远离主战场3格外且无关联 → -30（解决"下在毫无意义的地方"）
  //  ⑤主战场引力：落点距最近棋子越近越好，>3格扣分（配合④）
  //  ⑥威胁优先级权重：对方已活三/活四时，防守点大幅加权（解决"看不到即将活四"）
  //  ⑦关键威胁放大：对方有活三必应点 ×2 / 有活四必应点 ×3
  //  ⑧双活三/活四检测：本手形成双威胁额外 ×n 加成
  //  ⑨破除对方棋型：落子切断对方活二/活三连线 → +400/800
  //  ⑩连接己方棋群：落点连接两处以上己方棋子 → +200
  //  ⑪续手双威胁：续手能形成两个活三/活四 → +1500
  //  ⑫前瞻对方反扑：落子后对方最强续手若≥活四 → 扣分警告
  //  ⑬势均力敌调控：双方分差小时微调，避免一边倒（让对弈更均衡）
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

  // ===================================================================
  // 全局威胁扫描：统计某方当前已形成的棋型（用于新机制⑥⑦⑨）
  // ===================================================================
  function globalPatterns(board, player) {
    const counts = {};
    for (const [dx, dy] of DIRS4) {
      for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) {
        // 以 (x,y) 为起点，沿 (dx,dy) 取长度6窗口：内部5格+1边界
        let s = '2';
        for (let k = 0; k < 5; k++) {
          const nx = x + dx * k, ny = y + dy * k;
          let c = '2';
          if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE) {
            const v = board[nx][ny];
            c = v === player ? '1' : v === EMPTY ? '0' : '2';
          }
          s += c;
        }
        s += '2';
        for (const [re, , , name] of TIER_PTN) {
          const g = new RegExp(re.source, 'g');
          let m;
          while ((m = g.exec(s)) !== null) {
            counts[name] = (counts[name] || 0) + 1;
            s = s.slice(0, m.index) + '2'.repeat(m[0].length) + s.slice(m.index + m[0].length);
            g.lastIndex = 0;
          }
        }
      }
    }
    return counts;
  }

  // 一手前瞻：player 落子 (x,y) 后，opp 最佳续手能否形成 ≥活三的高威胁
  // 返回 {oppMaxThreat}：对方最强续手形成的最高棋型价值
  function oppBestCounter(board, x, y, player) {
    const opp = player === BLACK ? WHITE : BLACK;
    board[x][y] = player;
    let maxVal = 0;
    const cands = candidates(board);
    for (const [cx, cy] of cands) {
      board[cx][cy] = opp;
      const p = patternsThrough(board, cx, cy, opp);
      board[cx][cy] = EMPTY;
      let v = 0;
      for (const [name, cnt] of Object.entries(p)) {
        const info = OFF_MAP[name];
        if (info) v = Math.max(v, info[1] * cnt);
      }
      if (v > maxVal) maxVal = v;
    }
    board[x][y] = EMPTY;
    return maxVal;
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

    // ===== 新增 10 机制 =====
    // 计算到最近棋子的距离（用于④⑤）
    let minDist = 99, totalStones = 0;
    for (let i = 0; i < SIZE; i++) for (let j = 0; j < SIZE; j++) {
      if (board[i][j] === EMPTY) continue;
      totalStones++;
      const d = Math.max(Math.abs(i - x), Math.abs(j - y)); // 切比雪夫距离
      if (d < minDist) minDist = d;
    }
    // ⑤ 主战场引力：距离1加分、距离2正常、>2 衰减、>3 显著扣分
    if (totalStones > 0) {
      if (minDist === 1) add('l', 30);
      else if (minDist === 2) add('l', 10);
      else if (minDist >= 4) add('vl', -8 * (minDist - 3)); // 距离越远扣越多（负极低）
    }

    // ⑥⑦ 威胁优先级权重 + 关键威胁放大：扫描对方全局已有威胁
    const oppGlobal = globalPatterns(board, opp);
    const oppLive3 = oppGlobal['活三'] || 0;
    const oppLive4 = oppGlobal['活四'] || 0;
    // 若本点是对方威胁的必应点（即 def 中含阻挡活三/活四），大幅放大
    if ((def['活四'] || 0) > 0) {
      // 阻挡活四 → 额外 ×3 放大（覆盖在累加后的 total）
    }
    if ((def['活三'] || 0) > 0 && oppLive3 > 0) {
      add('m', 2000); // 阻止对方活三升级威胁
    }

    // ⑧ 双活三/活四检测：本手形成多个同类高威胁
    const myLive3 = off['活三'] || 0;
    const myLive4 = off['活四'] || 0;
    if (myLive3 >= 2) add('h', 3000); // 双活三额外加成
    if (myLive4 >= 1 && myLive3 >= 1) add('h', 4000); // 活四+活三
    if (myLive4 >= 2) add('h', 10000); // 双活四接近必胜

    // ⑨ 破除对方棋型：本手切断对方活二/活三连线
    // 检测：落子前对方在该方向有活二/活三，落子后（己方占位）对方该棋型被切断
    board[x][y] = player;
    const oppAfter = globalPatterns(board, opp);
    board[x][y] = EMPTY;
    const oppBefore = globalPatterns(board, opp);
    const breakLive2 = (oppBefore['活二'] || 0) - (oppAfter['活二'] || 0);
    const breakLive3 = (oppBefore['活三'] || 0) - (oppAfter['活三'] || 0);
    if (breakLive2 > 0) for (let i = 0; i < breakLive2; i++) add('m', 400);
    if (breakLive3 > 0) for (let i = 0; i < breakLive3; i++) add('h', 800);

    // ⑩ 连接己方棋群：落点同时在2个以上方向连接己方棋子
    let connectDirs = 0;
    for (const [dx, dy] of DIRS4) {
      const a = (x + dx >= 0 && x + dx < SIZE && y + dy >= 0 && y + dy < SIZE && board[x + dx][y + dy] === player);
      const b = (x - dx >= 0 && x - dx < SIZE && y - dy >= 0 && y - dy < SIZE && board[x - dx][y - dy] === player);
      if (a || b) connectDirs++;
    }
    if (connectDirs >= 2) add('l', 200);
    else if (connectDirs === 1) add('l', 60);

    // ⑪ 续手双威胁：续手能同时形成两个活三或两个活四
    let dualThreat = 0;
    if (myLive3 >= 1) {
      // 已有活三，检查续手能否再加一个活三/活四
      board[x][y] = player;
      for (const [dx, dy] of DIRS4) {
        for (let i = -4; i <= 4; i++) {
          if (i === 0) continue;
          const sx = x + dx * i, sy = y + dy * i;
          if (sx < 0 || sx >= SIZE || sy < 0 || sy >= SIZE || board[sx][sy] !== EMPTY) continue;
          board[sx][sy] = player;
          const p2 = patternsThrough(board, x, y, player);
          board[sx][sy] = EMPTY;
          if ((p2['活三'] || 0) >= 2 || (p2['活四'] || 0) >= 2) { dualThreat = 1; break; }
        }
        if (dualThreat) break;
      }
      board[x][y] = EMPTY;
    }
    if (dualThreat) add('m', 1500);

    // 累加公式：高 ×n / 中 ×(n/2) / 低 +n / 极低 +(n/2)
    const h = tiers.h, m = tiers.m, l = tiers.l, vl = tiers.vl;
    let total = 0;
    if (h.n) total += h.sum * h.n;
    if (m.n) total += m.sum * (m.n / 2);
    if (l.n) total += l.sum + l.n;
    if (vl.n) total += vl.sum + (vl.n / 2);

    // ① 被对方包围扣分：2格内对方子≥2且无己方支援 → 每个对方子 -4
    if (myNeighbors === 0 && oppNeighbors >= 2) total -= oppNeighbors * 4;

    // ④ 孤立废棋惩罚：距最近棋子≥4格且无任何棋型价值 → -30
    if (totalStones > 0 && minDist >= 4 && offRaw === 0 && defRaw === 0) {
      total -= 30;
    }

    // ⑫ 前瞻对方反扑：落子后对方最强续手若≥活四(10000) → 警告扣分
    if (offRaw > 0 || defRaw > 0) {
      const oppCounter = oppBestCounter(board, x, y, player);
      if (oppCounter >= 10000) total -= 3000; // 对方可反扑活四
      else if (oppCounter >= 5000) total -= 500; // 对方可反扑活三
    }

    // ⑬ 势均力敌调控：双方全局分差小时，略微提升防守点权重，避免一边倒
    const myGlobal = globalPatterns(board, player);
    const myGScore = Object.entries(myGlobal).reduce((s, [n, c]) => { const info = OFF_MAP[n]; return s + (info ? info[1] * c : 0); }, 0);
    const oppGScore = Object.entries(oppGlobal).reduce((s, [n, c]) => { const info = OFF_MAP[n]; return s + (info ? info[1] * c : 0); }, 0);
    const gDiff = Math.abs(myGScore - oppGScore);
    if (gDiff < 1000 && defRaw > offRaw && defRaw > 0) {
      total += Math.round(defRaw * 0.1); // 均势时防守点额外 +10%
    }

    // ⑦ 关键威胁放大（累加后乘）：对方有活四且本点能阻挡 → ×3
    if (oppLive4 > 0 && (def['活四'] || 0) > 0) total *= 3;
    else if (oppLive3 > 0 && (def['活三'] || 0) > 0) total *= 2;

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
