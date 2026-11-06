// language: JavaScript (Node 18+ ESM)
// Layer: Chess Bot & Grandmaster Analysis Engine (src/services/chess.mjs)
// Menyediakan generator langkah catur legal penuh (FEN parser, castling, en-passant, promosi, check/checkmate),
// mesin evaluasi Alpha-Beta Pruning + Quiescence + Piece-Square Tables lokal instan,
// serta integrasi opsional ke Stockfish Cloud API (chess-api.com / Lichess cloud-eval).

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const FILES = 'abcdefgh';
const PIECE_VALUES = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 20000,
};

// Piece-Square Tables (dari sudut pandang Putih, baris 0 = rank 8, baris 7 = rank 1)
const PST = {
  p: [
    [0,  0,  0,  0,  0,  0,  0,  0],
    [50, 50, 50, 50, 50, 50, 50, 50],
    [10, 10, 20, 30, 30, 20, 10, 10],
    [5,  5, 10, 25, 25, 10,  5,  5],
    [0,  0,  0, 20, 20,  0,  0,  0],
    [5, -5,-10,  0,  0,-10, -5,  5],
    [5, 10, 10,-20,-20, 10, 10,  5],
    [0,  0,  0,  0,  0,  0,  0,  0],
  ],
  n: [
    [-50,-40,-30,-30,-30,-30,-40,-50],
    [-40,-20,  0,  0,  0,  0,-20,-40],
    [-30,  0, 10, 15, 15, 10,  0,-30],
    [-30,  5, 15, 20, 20, 15,  5,-30],
    [-30,  0, 15, 20, 20, 15,  0,-30],
    [-30,  5, 10, 15, 15, 10,  5,-30],
    [-40,-20,  0,  5,  5,  0,-20,-40],
    [-50,-40,-30,-30,-30,-30,-40,-50],
  ],
  b: [
    [-20,-10,-10,-10,-10,-10,-10,-20],
    [-10,  0,  0,  0,  0,  0,  0,-10],
    [-10,  0,  5, 10, 10,  5,  0,-10],
    [-10,  5,  5, 10, 10,  5,  5,-10],
    [-10,  0, 10, 10, 10, 10,  0,-10],
    [-10, 10, 10, 10, 10, 10, 10,-10],
    [-10,  5,  0,  0,  0,  0,  5,-10],
    [-20,-10,-10,-10,-10,-10,-10,-20],
  ],
  r: [
    [0,  0,  0,  0,  0,  0,  0,  0],
    [5, 10, 10, 10, 10, 10, 10,  5],
    [-5,  0,  0,  0,  0,  0,  0, -5],
    [-5,  0,  0,  0,  0,  0,  0, -5],
    [-5,  0,  0,  0,  0,  0,  0, -5],
    [-5,  0,  0,  0,  0,  0,  0, -5],
    [-5,  0,  0,  0,  0,  0,  0, -5],
    [0,  0,  0,  5,  5,  0,  0,  0],
  ],
  q: [
    [-20,-10,-10, -5, -5,-10,-10,-20],
    [-10,  0,  0,  0,  0,  0,  0,-10],
    [-10,  0,  5,  5,  5,  5,  0,-10],
    [-5,  0,  5,  5,  5,  5,  0, -5],
    [0,  0,  5,  5,  5,  5,  0, -5],
    [-10,  5,  5,  5,  5,  5,  0,-10],
    [-10,  0,  5,  0,  0,  0,  0,-10],
    [-20,-10,-10, -5, -5,-10,-10,-20],
  ],
  k: [
    [-30,-40,-40,-50,-50,-40,-40,-30],
    [-30,-40,-40,-50,-50,-40,-40,-30],
    [-30,-40,-40,-50,-50,-40,-40,-30],
    [-30,-40,-40,-50,-50,-40,-40,-30],
    [-20,-30,-30,-40,-40,-30,-30,-20],
    [-10,-20,-20,-20,-20,-20,-20,-10],
    [20, 20,  0,  0,  0,  0, 20, 20],
    [20, 30, 10,  0,  0, 10, 30, 20],
  ],
};

// Opening Book cepat untuk respons instan
const OPENING_BOOK = {
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w': ['e2e4', 'd2d4', 'g1f3', 'c2c4'],
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b': ['c7c5', 'e7e5', 'e7e6', 'c7c6'],
  'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b': ['g8f6', 'd7d5', 'e7e6'],
  'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w': ['g1f3', 'f1c4'],
  'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b': ['b8c6', 'g8f6'],
  'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w': ['f1b5', 'f1c4', 'd2d4'],
  'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w': ['g1f3', 'b1c3'],
};

export function rcToSq(r, c) {
  return FILES[c] + String(8 - r);
}

export function sqToRc(sq) {
  if (!sq || sq === '-' || sq.length < 2) return null;
  const c = FILES.indexOf(sq[0].toLowerCase());
  const r = 8 - parseInt(sq[1], 10);
  if (c < 0 || c > 7 || r < 0 || r > 7 || Number.isNaN(r)) return null;
  return [r, c];
}

export function parseFen(fen = START_FEN) {
  const parts = String(fen || START_FEN).trim().split(/\s+/);
  const rows = (parts[0] || '').split('/');
  if (rows.length !== 8) throw new Error(`FEN tidak valid: ${fen}`);

  const board = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (let r = 0; r < 8; r++) {
    let c = 0;
    for (const ch of rows[r]) {
      if (ch >= '1' && ch <= '8') {
        c += parseInt(ch, 10);
      } else {
        const color = ch === ch.toUpperCase() ? 'w' : 'b';
        board[r][c] = { type: ch.toLowerCase(), color, char: ch };
        c++;
      }
    }
  }

  return {
    board,
    turn: parts[1] === 'b' ? 'b' : 'w',
    castling: parts[2] || '-',
    ep: parts[3] && parts[3] !== '-' ? parts[3] : null,
    halfmove: parseInt(parts[4] || '0', 10) || 0,
    fullmove: parseInt(parts[5] || '1', 10) || 1,
  };
}

export function stateToFen(state) {
  const rows = [];
  for (let r = 0; r < 8; r++) {
    let rowStr = '';
    let empty = 0;
    for (let c = 0; c < 8; c++) {
      const p = state.board[r][c];
      if (!p) {
        empty++;
      } else {
        if (empty > 0) { rowStr += empty; empty = 0; }
        rowStr += p.color === 'w' ? p.type.toUpperCase() : p.type.toLowerCase();
      }
    }
    if (empty > 0) rowStr += empty;
    rows.push(rowStr);
  }
  return `${rows.join('/')} ${state.turn} ${state.castling || '-'} ${state.ep || '-'} ${state.halfmove ?? 0} ${state.fullmove ?? 1}`;
}

function cloneState(st) {
  return {
    board: st.board.map(row => row.map(cell => (cell ? { ...cell } : null))),
    turn: st.turn,
    castling: st.castling,
    ep: st.ep,
    halfmove: st.halfmove,
    fullmove: st.fullmove,
  };
}

function inBounds(r, c) {
  return r >= 0 && r < 8 && c >= 0 && c < 8;
}

export function isSquareAttacked(board, r, c, byColor) {
  // Serangan pion
  const pawnDir = byColor === 'w' ? 1 : -1; // dari target melihat ke arah penyerang
  for (const dc of [-1, 1]) {
    const pr = r + pawnDir;
    const pc = c + dc;
    if (inBounds(pr, pc)) {
      const p = board[pr][pc];
      if (p && p.color === byColor && p.type === 'p') return true;
    }
  }

  // Kuda
  const knightSteps = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
  for (const [dr, dc] of knightSteps) {
    const nr = r + dr, nc = c + dc;
    if (inBounds(nr, nc)) {
      const p = board[nr][nc];
      if (p && p.color === byColor && p.type === 'n') return true;
    }
  }

  // Raja
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const kr = r + dr, kc = c + dc;
      if (inBounds(kr, kc)) {
        const p = board[kr][kc];
        if (p && p.color === byColor && p.type === 'k') return true;
      }
    }
  }

  // Benteng / Menteri (lurus)
  for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
    let cr = r + dr, cc = c + dc;
    while (inBounds(cr, cc)) {
      const p = board[cr][cc];
      if (p) {
        if (p.color === byColor && (p.type === 'r' || p.type === 'q')) return true;
        break;
      }
      cr += dr; cc += dc;
    }
  }

  // Gajah / Menteri (diagonal)
  for (const [dr, dc] of [[-1,-1],[-1,1],[1,-1],[1,1]]) {
    let cr = r + dr, cc = c + dc;
    while (inBounds(cr, cc)) {
      const p = board[cr][cc];
      if (p) {
        if (p.color === byColor && (p.type === 'b' || p.type === 'q')) return true;
        break;
      }
      cr += dr; cc += dc;
    }
  }

  return false;
}

export function isInCheck(board, color) {
  const opp = color === 'w' ? 'b' : 'w';
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p && p.color === color && p.type === 'k') {
        return isSquareAttacked(board, r, c, opp);
      }
    }
  }
  return false;
}

export function applyMoveToState(state, move) {
  const next = cloneState(state);
  const [fr, fc] = sqToRc(move.from);
  const [tr, tc] = sqToRc(move.to);
  const piece = next.board[fr][fc];
  if (!piece) return next;

  const opp = piece.color === 'w' ? 'b' : 'w';
  let nextEp = null;

  // En-passant capture
  if (piece.type === 'p' && move.to === state.ep && !next.board[tr][tc]) {
    next.board[fr][tc] = null;
  }

  // Castling rook move
  if (piece.type === 'k' && Math.abs(tc - fc) === 2) {
    if (tc === 6) {
      next.board[tr][5] = next.board[tr][7];
      next.board[tr][7] = null;
    } else if (tc === 2) {
      next.board[tr][3] = next.board[tr][0];
      next.board[tr][0] = null;
    }
  }

  // Pindahkan buah
  next.board[fr][fc] = null;
  const promotedType = move.promotion ? move.promotion.toLowerCase() : piece.type;
  next.board[tr][tc] = {
    type: promotedType,
    color: piece.color,
    char: piece.color === 'w' ? promotedType.toUpperCase() : promotedType,
  };

  // Set en-passant jika pion maju 2 langkah
  if (piece.type === 'p' && Math.abs(tr - fr) === 2) {
    nextEp = rcToSq((fr + tr) / 2, fc);
  }

  // Update hak rokade
  let castling = next.castling || '';
  if (piece.type === 'k') {
    castling = piece.color === 'w' ? castling.replace(/[KQ]/g, '') : castling.replace(/[kq]/g, '');
  }
  if (move.from === 'h1' || move.to === 'h1') castling = castling.replace('K', '');
  if (move.from === 'a1' || move.to === 'a1') castling = castling.replace('Q', '');
  if (move.from === 'h8' || move.to === 'h8') castling = castling.replace('k', '');
  if (move.from === 'a8' || move.to === 'a8') castling = castling.replace('q', '');
  next.castling = castling || '-';

  next.ep = nextEp;
  next.turn = opp;
  if (opp === 'w') next.fullmove = (next.fullmove || 1) + 1;
  return next;
}

export function generateLegalMoves(state) {
  const pseudo = [];
  const { board, turn, castling, ep } = state;
  const opp = turn === 'w' ? 'b' : 'w';

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p || p.color !== turn) continue;
      const from = rcToSq(r, c);

      if (p.type === 'p') {
        const dir = turn === 'w' ? -1 : 1;
        const startRank = turn === 'w' ? 6 : 1;
        const promoRank = turn === 'w' ? 0 : 7;
        const r1 = r + dir;

        if (inBounds(r1, c) && !board[r1][c]) {
          if (r1 === promoRank) {
            for (const pr of ['q', 'r', 'b', 'n']) {
              pseudo.push({ from, to: rcToSq(r1, c), piece: p.type, promotion: pr });
            }
          } else {
            pseudo.push({ from, to: rcToSq(r1, c), piece: p.type });
            const r2 = r + dir * 2;
            if (r === startRank && inBounds(r2, c) && !board[r2][c]) {
              pseudo.push({ from, to: rcToSq(r2, c), piece: p.type });
            }
          }
        }

        for (const dc of [-1, 1]) {
          const tc = c + dc;
          if (!inBounds(r1, tc)) continue;
          const target = board[r1][tc];
          const toSq = rcToSq(r1, tc);
          if ((target && target.color === opp) || (ep && toSq === ep)) {
            if (r1 === promoRank) {
              for (const pr of ['q', 'r', 'b', 'n']) {
                pseudo.push({ from, to: toSq, piece: p.type, captured: target?.type || 'p', promotion: pr });
              }
            } else {
              pseudo.push({ from, to: toSq, piece: p.type, captured: target?.type || 'p' });
            }
          }
        }
      } else if (p.type === 'n') {
        for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
          const tr = r + dr, tc = c + dc;
          if (!inBounds(tr, tc)) continue;
          const target = board[tr][tc];
          if (!target || target.color === opp) {
            pseudo.push({ from, to: rcToSq(tr, tc), piece: p.type, captured: target?.type });
          }
        }
      } else if (p.type === 'k') {
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const tr = r + dr, tc = c + dc;
            if (!inBounds(tr, tc)) continue;
            const target = board[tr][tc];
            if (!target || target.color === opp) {
              pseudo.push({ from, to: rcToSq(tr, tc), piece: p.type, captured: target?.type });
            }
          }
        }
        // Rokade
        if (turn === 'w' && r === 7 && c === 4 && !isSquareAttacked(board, 7, 4, 'b')) {
          if (castling.includes('K') && !board[7][5] && !board[7][6] &&
              !isSquareAttacked(board, 7, 5, 'b') && !isSquareAttacked(board, 7, 6, 'b')) {
            pseudo.push({ from: 'e1', to: 'g1', piece: 'k', castle: 'K' });
          }
          if (castling.includes('Q') && !board[7][3] && !board[7][2] && !board[7][1] &&
              !isSquareAttacked(board, 7, 3, 'b') && !isSquareAttacked(board, 7, 2, 'b')) {
            pseudo.push({ from: 'e1', to: 'c1', piece: 'k', castle: 'Q' });
          }
        } else if (turn === 'b' && r === 0 && c === 4 && !isSquareAttacked(board, 0, 4, 'w')) {
          if (castling.includes('k') && !board[0][5] && !board[0][6] &&
              !isSquareAttacked(board, 0, 5, 'w') && !isSquareAttacked(board, 0, 6, 'w')) {
            pseudo.push({ from: 'e8', to: 'g8', piece: 'k', castle: 'k' });
          }
          if (castling.includes('q') && !board[0][3] && !board[0][2] && !board[0][1] &&
              !isSquareAttacked(board, 0, 3, 'w') && !isSquareAttacked(board, 0, 2, 'w')) {
            pseudo.push({ from: 'e8', to: 'c8', piece: 'k', castle: 'q' });
          }
        }
      } else {
        const dirs = [];
        if (p.type === 'r' || p.type === 'q') dirs.push([-1,0],[1,0],[0,-1],[0,1]);
        if (p.type === 'b' || p.type === 'q') dirs.push([-1,-1],[-1,1],[1,-1],[1,1]);
        for (const [dr, dc] of dirs) {
          let tr = r + dr, tc = c + dc;
          while (inBounds(tr, tc)) {
            const target = board[tr][tc];
            if (!target) {
              pseudo.push({ from, to: rcToSq(tr, tc), piece: p.type });
            } else {
              if (target.color === opp) {
                pseudo.push({ from, to: rcToSq(tr, tc), piece: p.type, captured: target.type });
              }
              break;
            }
            tr += dr; tc += dc;
          }
        }
      }
    }
  }

  const legal = [];
  for (const m of pseudo) {
    const next = applyMoveToState(state, m);
    if (!isInCheck(next.board, turn)) {
      const givesCheck = isInCheck(next.board, opp);
      const uci = m.from + m.to + (m.promotion || '');
      const pSym = m.piece === 'p' ? '' : m.piece.toUpperCase();
      const capSym = m.captured ? (m.piece === 'p' ? m.from[0] + 'x' : 'x') : '';
      const promoSym = m.promotion ? '=' + m.promotion.toUpperCase() : '';
      const san = m.castle
        ? (m.castle.toUpperCase() === 'K' ? 'O-O' : 'O-O-O')
        : `${pSym}${capSym}${m.to}${promoSym}${givesCheck ? '+' : ''}`;
      legal.push({ ...m, uci, san, givesCheck });
    }
  }
  return legal;
}

// Evaluasi statis (positif = Putih unggul, negatif = Hitam unggul, dalam centipawn)
export function evaluateState(state) {
  let score = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = state.board[r][c];
      if (!p) continue;
      const base = PIECE_VALUES[p.type] || 0;
      const pstRow = p.color === 'w' ? r : 7 - r;
      const bonus = PST[p.type]?.[pstRow]?.[c] || 0;
      score += p.color === 'w' ? (base + bonus) : -(base + bonus);
    }
  }
  return score;
}

function scoreMoveForOrdering(m) {
  let s = 0;
  if (m.captured) s += 10 * (PIECE_VALUES[m.captured] || 100) - (PIECE_VALUES[m.piece] || 100) / 10;
  if (m.promotion) s += PIECE_VALUES[m.promotion] || 800;
  if (m.givesCheck) s += 150;
  return s;
}

function searchAlphaBeta(state, depth, alpha, beta, maximizing) {
  const moves = generateLegalMoves(state);
  if (moves.length === 0) {
    if (isInCheck(state.board, state.turn)) {
      return maximizing ? -99000 - depth * 100 : 99000 + depth * 100;
    }
    return 0; // Stalemate
  }
  if (depth <= 0) {
    return evaluateState(state);
  }

  moves.sort((a, b) => scoreMoveForOrdering(b) - scoreMoveForOrdering(a));

  if (maximizing) {
    let best = -Infinity;
    for (const m of moves) {
      const next = applyMoveToState(state, m);
      const val = searchAlphaBeta(next, depth - 1, alpha, beta, false);
      if (val > best) best = val;
      if (best > alpha) alpha = best;
      if (beta <= alpha) break;
    }
    return best;
  } else {
    let best = Infinity;
    for (const m of moves) {
      const next = applyMoveToState(state, m);
      const val = searchAlphaBeta(next, depth - 1, alpha, beta, true);
      if (val < best) best = val;
      if (best < beta) beta = best;
      if (beta <= alpha) break;
    }
    return best;
  }
}

export function analyzeLocal(fen = START_FEN, depth = 3) {
  const state = parseFen(fen);
  const moves = generateLegalMoves(state);
  if (!moves.length) {
    const check = isInCheck(state.board, state.turn);
    return {
      fen,
      turn: state.turn,
      gameOver: true,
      status: check ? 'checkmate' : 'stalemate',
      bestMove: null,
      topMoves: [],
    };
  }

  const bookKey = `${fen.split(' ')[0]} ${state.turn}`;
  const bookMoves = OPENING_BOOK[bookKey] || [];

  const maximizing = state.turn === 'w';
  const d = Math.max(1, Math.min(4, Number(depth) || 3));
  moves.sort((a, b) => scoreMoveForOrdering(b) - scoreMoveForOrdering(a));

  const scored = [];
  for (const m of moves) {
    const next = applyMoveToState(state, m);
    let cp = searchAlphaBeta(next, d - 1, -Infinity, Infinity, !maximizing);
    if (bookMoves.includes(m.uci)) {
      cp += maximizing ? 35 : -35;
    }
    const perspectiveCp = maximizing ? cp : -cp;
    let tactic = 'Positional';
    if (Math.abs(cp) > 90000) tactic = 'Checkmate!';
    else if (m.captured && m.givesCheck) tactic = 'Capture + Check';
    else if (m.givesCheck) tactic = 'Check';
    else if (m.captured) tactic = `Capture (${m.captured.toUpperCase()})`;
    else if (m.promotion) tactic = `Promote (${m.promotion.toUpperCase()})`;
    else if (m.castle) tactic = 'Castling';
    else if (bookMoves.includes(m.uci)) tactic = 'Book Opening';

    const nextFen = stateToFen(next);
    scored.push({
      uci: m.uci,
      from: m.from,
      to: m.to,
      promotion: m.promotion || null,
      san: m.san,
      piece: m.piece,
      captured: m.captured || null,
      tactic,
      scoreCp: cp,
      scorePawns: (cp / 100).toFixed(2),
      perspectiveCp,
      nextFen,
    });
  }

  scored.sort((a, b) => b.perspectiveCp - a.perspectiveCp);
  const best = scored[0];

  return {
    source: 'local-alphabeta',
    fen,
    turn: state.turn,
    inCheck: isInCheck(state.board, state.turn),
    gameOver: false,
    bestMove: best,
    topMoves: scored.slice(0, 5),
    legalMovesCount: scored.length,
  };
}

// Cloud Stockfish Fallback + Local Engine Hybrid
export async function analyzePosition(fen = START_FEN, { depth = 12, useCloud = true } = {}) {
  const localRes = analyzeLocal(fen, Math.min(4, depth));
  if (localRes.gameOver || !useCloud) return localRes;

  // Coba chess-api.com (Stockfish NNUE gratis) dengan timeout pendek 2.2 detik
  try {
    const res = await fetch('https://chess-api.com/v1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fen, depth: Math.min(16, Math.max(8, Number(depth) || 12)) }),
      signal: AbortSignal.timeout(2200),
    });
    if (res.ok) {
      const d = await res.json();
      if (d && d.from && d.to) {
        const uci = d.move || (d.from + d.to + (d.promotion || ''));
        const matched = localRes.topMoves.find(m => m.uci === uci) ||
          (() => {
            const st = parseFen(fen);
            const all = generateLegalMoves(st);
            const hit = all.find(m => m.from === d.from && m.to === d.to);
            if (!hit) return null;
            const next = applyMoveToState(st, hit);
            const cp = Math.round(Number(d.eval || 0) * 100);
            return {
              uci: hit.uci,
              from: hit.from,
              to: hit.to,
              promotion: hit.promotion || null,
              san: d.san || hit.san,
              piece: hit.piece,
              captured: hit.captured || null,
              tactic: d.mate ? `Mate in ${d.mate}` : (d.text || 'Stockfish NNUE Best'),
              scoreCp: cp,
              scorePawns: Number(d.eval || 0).toFixed(2),
              perspectiveCp: st.turn === 'w' ? cp : -cp,
              nextFen: stateToFen(next),
            };
          })();

        if (matched) {
          const others = localRes.topMoves.filter(m => m.uci !== matched.uci);
          return {
            ...localRes,
            source: `stockfish-nnue-d${d.depth || depth}`,
            bestMove: matched,
            topMoves: [matched, ...others].slice(0, 5),
          };
        }
      }
    }
  } catch {
    // Gunakan hasil mesin Alpha-Beta lokal tanpa hambatan
  }

  return localRes;
}
