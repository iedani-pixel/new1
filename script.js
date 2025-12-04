/* script.js — 将ギ効率CPU 用スクリプト（Worker再利用 + 自動反転 ON/OFF など） */

/* ---------- 定数 / グローバル ---------- */
const ROWS = 9, COLS = 9;
let board = [];
let currentPlayer = 0; // 0=P1,1=P2
let points = [10,10];
let captures = [0,0];
let logEl, rouletteResultEl, turnLabel, currentPointsEl;
let pointsEls = [], capEls = [];
let betsCur = []; let betsConfirmedFlag = false;
let twoStepCols = [new Set(), new Set()];
let turnHasMoved = false, pendingSpecial = null, selectedTarget = null, selectedFrom = null, turnIndex = 0;
let reserves = [[],[]];
let gameMode = 'pvp'; let cpuPlays = null; let cpuLevel = 'master';
let trails = []; // {r,c,owner,remainingTurns}
let spinCount = 0; const MAX_SPIN_PER_TURN = 2;
let autoFlipButtons = true; // 新: ゲーム開始前に設定可能
const CAPTURE_BASE = { pawn:3, gold:10, silver:8, knight:6, lance:6, bishop:11, rook:12, king:0 };
const PIECE_JP = { king:'王', gold:'金', silver:'銀', knight:'桂', lance:'香', bishop:'角', rook:'飛', pawn:'歩' };

/* Worker 管理（再利用用） */
let workerPool = [];
let workerBlobUrl = null;
let workerBusy = false;

/* ---------- 初期化 ---------- */
window.addEventListener('DOMContentLoaded', ()=>{
  logEl = document.getElementById('log');
  rouletteResultEl = document.getElementById('rouletteResult');
  turnLabel = document.getElementById('turnLabel');
  currentPointsEl = document.getElementById('currentPoints');
  pointsEls = [document.getElementById('points0'), document.getElementById('points1')];
  capEls = [document.getElementById('cap0'), document.getElementById('cap1')];

  bindUI();
  initBoard();
  renderBoard();
  showStartModal();
});

/* ---------- UI バインド ---------- */
function bindUI(){
  const sBtn = document.getElementById('startGameBtn'); if(sBtn) sBtn.onclick = onStartGame;
  const openBet = document.getElementById('openBet'); if(openBet) openBet.onclick = onOpenBet;
  const spinBtn = document.getElementById('spinBtn'); if(spinBtn) spinBtn.onclick = onSpin;
  const closeBets = document.getElementById('closeBets'); if(closeBets) closeBets.onclick = ()=> document.getElementById('betModal').classList.add('hidden');
  const confirmBets = document.getElementById('confirmBets'); if(confirmBets) confirmBets.onclick = onConfirmBets;
  const endTurnBtn = document.getElementById('endTurnBtn'); if(endTurnBtn) endTurnBtn.onclick = ()=> { log(`${currentPlayer===0?'P1':'P2'} はパス`); endTurn(); };
  const abortBtn = document.getElementById('abortMatchBtn'); if(abortBtn) abortBtn.onclick = onAbortMatch;

  const spProm = document.getElementById('startPromoteSelect'); if(spProm) spProm.onclick = startPromoteSelect;
  const spDestroy = document.getElementById('startDestroySelect'); if(spDestroy) spDestroy.onclick = ()=> startSpecial('destroy',30);
  const spSteal = document.getElementById('startStealSelect'); if(spSteal) spSteal.onclick = ()=> startSpecial('steal',16);
  const twoBtn = document.getElementById('twoStepBtn'); if(twoBtn) twoBtn.onclick = onTwoStep;
  const inst = document.getElementById('instantWinBtn'); if(inst) inst.onclick = onInstantWin;
  const selfD = document.getElementById('selfDestroyBtn'); if(selfD) selfD.onclick = onSelfDestroy;
  const drain = document.getElementById('drainBtn'); if(drain) drain.onclick = onDrainOpponentPoints;
  const drainUntil = document.getElementById('drainUntilZeroBtn'); if(drainUntil) drainUntil.onclick = ()=> onDrainUntilZero();
  const confirmT = document.getElementById('confirmTargetBtn'); if(confirmT) confirmT.onclick = onConfirmTarget;
  const cancelT = document.getElementById('cancelTargetBtn'); if(cancelT) cancelT.onclick = ()=> { pendingSpecial=null; selectedTarget=null; selectedFrom=null; renderBoard(); };

  const cpuSel = document.getElementById('cpuLevelSelect');
  if(cpuSel) cpuSel.onchange = ()=> { cpuLevel = cpuSel.value; };
}

/* ---------- ログ / ヘルパー ---------- */
function log(msg){ if(!logEl) return; const p=document.createElement('div'); p.textContent = `${new Date().toLocaleTimeString()} - ${msg}`; logEl.prepend(p); }
function showStartModal(){ const m=document.getElementById('startModal'); if(m) m.classList.remove('hidden'); }

/* ---------- 盤初期化 ---------- */
function initBoard(){
  board = Array.from({length:ROWS},()=>Array.from({length:COLS},()=>null));
  function place(r,c,type,owner){ board[r][c] = {type, owner, promoted:false, noKingCaptureTurnByPlayer:{}}; }
  const p2back = ['lance','knight','silver','gold','king','gold','silver','knight','lance'];
  for(let c=0;c<9;c++) place(0,c,p2back[c],1);
  place(1,1,'bishop',1); place(1,7,'rook',1);
  for(let c=0;c<9;c++) place(2,c,'pawn',1);
  const p1back = ['lance','knight','silver','gold','king','gold','silver','knight','lance'];
  for(let c=0;c<9;c++) place(8,c,p1back[c],0);
  place(7,7,'bishop',0); place(7,1,'rook',0);
  for(let c=0;c<9;c++) place(6,c,'pawn',0);
}

/* ---------- 表示（合法手ハイライト対応） ---------- */
function renderBoard(){
  const tbl = document.getElementById('board'); if(!tbl) return;
  tbl.innerHTML = '';
  for(let r=0;r<ROWS;r++){
    const tr = document.createElement('tr');
    for(let c=0;c<COLS;c++){
      const td = document.createElement('td');
      if((r+c)%2===1) td.classList.add('dark');
      td.dataset.r=r; td.dataset.c=c;
      const cell = board[r][c];
      td.innerHTML = '';
      if(cell){
        const span = document.createElement('div');
        span.className = 'piece ' + (cell.owner===0 ? 'p1' : 'p2');
        span.textContent = pieceLabel(cell);
        td.appendChild(span);
      }
      if(trails.some(t => t.r===r && t.c===c)) td.classList.add('trail'); else td.classList.remove('trail');

      if(selectedTarget && selectedTarget.r==r && selectedTarget.c==c) td.classList.add('selected'); else td.classList.remove('selected');

      if(selectedFrom){
        const moves = legalMoves(selectedFrom.r, selectedFrom.c);
        if(moves.some(m=>m.r===r && m.c===c)) td.classList.add('legalMove'); else td.classList.remove('legalMove');
      } else {
        td.classList.remove('legalMove');
      }

      td.onclick = ()=> handleCellClick(r,c);
      tr.appendChild(td);
    }
    tbl.appendChild(tr);
  }

  if(pointsEls[0]) pointsEls[0].textContent = points[0];
  if(pointsEls[1]) pointsEls[1].textContent = points[1];
  if(capEls[0]) capEls[0].textContent = captures[0];
  if(capEls[1]) capEls[1].textContent = captures[1];
  if(currentPointsEl) currentPointsEl.textContent = points[currentPlayer];
  if(turnLabel) turnLabel.textContent = currentPlayer===0 ? '先手 (P1)' : '後手 (P2)';

  const controlsCenter = document.getElementById('controlsCenter');
  if(controlsCenter){
    // 自動反転がONであれば currentPlayer に応じて反転を付与
    if(autoFlipButtons){
      if(currentPlayer===1) controlsCenter.classList.add('controlsFlip'); else controlsCenter.classList.remove('controlsFlip');
    } else {
      // 常に標準（反転しない）
      controlsCenter.classList.remove('controlsFlip');
    }
  }

  const status = document.getElementById('status');
  if(status){
    if(autoFlipButtons){
      if(currentPlayer===1) status.classList.add('statusFlip'); else status.classList.remove('statusFlip');
    } else {
      status.classList.remove('statusFlip');
    }
  }

  const roulette = document.getElementById('rouletteResult');
  if(roulette){
    if(autoFlipButtons){
      if(currentPlayer===1) roulette.classList.add('flip'); else roulette.classList.remove('flip');
    } else {
      roulette.classList.remove('flip');
    }
  }

  renderReserves();

  const sRemain = document.getElementById('spinRemain');
  if(sRemain) sRemain.textContent = Math.max(0, MAX_SPIN_PER_TURN - spinCount);

  const ob = document.getElementById('openBet'); if(ob) ob.disabled = (cpuPlays !== null && cpuPlays === currentPlayer);
  const sb = document.getElementById('spinBtn'); if(sb) sb.disabled = (!betsConfirmedFlag || (cpuPlays !== null && cpuPlays === currentPlayer) || spinCount >= MAX_SPIN_PER_TURN);
}

/* ---------- 保留表示 ---------- */
function renderReserves(){
  const areaP1 = document.getElementById('reserveAreaP1');
  const areaP2 = document.getElementById('reserveAreaP2');
  if(!areaP1 || !areaP2) return;
  areaP1.innerHTML = '<h4>先手の保留駒</h4>';
  areaP2.innerHTML = '<h4>後手の保留駒</h4>';

  reserves[0].forEach((rp, idx)=>{ 
    const div=document.createElement('div'); div.className='reserveItem';
    const pieceSpan = document.createElement('div'); pieceSpan.className='piece p1'; pieceSpan.textContent = pieceNameJP(rp);
    div.appendChild(pieceSpan);
    const btn = document.createElement('button'); btn.textContent='置く'; btn.dataset.idx = idx;
    if(currentPlayer !== 0){
      btn.disabled = true; btn.classList.add('reserveDisabled'); btn.title = '自分の持ち駒のみ配置できます';
    } else {
      btn.onclick = ()=>{ if(points[0] < 6){ alert('配置には6点必要'); return; } pendingSpecial='placeReserve'; selectedTarget = { reserveIndex: idx, owner:0 }; alert('盤上の空きマスをクリックして配置（6点、配置でターン終了）'); renderBoard(); };
    }
    div.appendChild(btn);
    areaP1.appendChild(div);
  });

  reserves[1].forEach((rp, idx)=>{ 
    const div=document.createElement('div'); div.className='reserveItem';
    const pieceSpan = document.createElement('div'); pieceSpan.className='piece p2'; pieceSpan.textContent = pieceNameJP(rp);
    div.appendChild(pieceSpan);
    const btn = document.createElement('button'); btn.textContent='置く'; btn.dataset.idx = idx;
    if(currentPlayer !== 1){
      btn.disabled = true; btn.classList.add('reserveDisabled'); btn.title = '自分の持ち駒のみ配置できます';
    } else {
      btn.onclick = ()=>{ if(points[1] < 6){ alert('配置には6点必要'); return; } pendingSpecial='placeReserve'; selectedTarget = { reserveIndex: idx, owner:1 }; alert('盤上の空きマスをクリックして配置（6点、配置でターン終了）'); renderBoard(); };
    }
    div.appendChild(btn);
    areaP2.appendChild(div);
  });
}

function pieceNameJP(rp){ return (rp.promoted ? '成' : '') + (PIECE_JP[rp.type] || rp.type); }
function pieceLabel(cell){ if(!cell) return ''; let s = PIECE_JP[cell.type] || cell.type; if(cell.promoted) s = '成' + s; return s; }
function coordLabel(r,c){ return String.fromCharCode(65 + c) + (ROWS - r); }

/* ---------- クリック処理 ---------- */
function handleCellClick(r,c){
  // 保留配置モード
  if(pendingSpecial === 'placeReserve' && selectedTarget && selectedTarget.reserveIndex !== undefined){
    const ownerOfReserve = selectedTarget.owner;
    if(ownerOfReserve !== currentPlayer){ alert('自分の保留駒のみ配置できます'); pendingSpecial = null; selectedTarget = null; selectedFrom = null; renderBoard(); return; }
    if(board[r][c]){ alert('空きマスを選んでください'); return; }
    const idx = selectedTarget.reserveIndex;
    if(points[ownerOfReserve] < 6){ alert('配置には6点必要'); pendingSpecial=null; selectedTarget=null; selectedFrom=null; renderBoard(); return; }
    const rp = reserves[ownerOfReserve].splice(idx,1)[0];
    board[r][c] = { type: rp.type, owner: ownerOfReserve, promoted: rp.promoted, noKingCaptureTurnByPlayer:{} };
    points[ownerOfReserve] -= 6;
    addTrail(r,c,ownerOfReserve);
    log(`${ownerOfReserve===0?'P1':'P2'} が保留駒 ${pieceNameJP(rp)} を ${coordLabel(r,c)} に6点で配置（所持 ${points[ownerOfReserve]}点）`);
    if(rp.type === 'pawn') checkPawnColumnsForOwner(ownerOfReserve);
    pendingSpecial = null; selectedTarget = null; selectedFrom = null; renderBoard();
    endTurn();
    return;
  }

  // 特殊選択中
  if(pendingSpecial){
    const cell = board[r][c];
    if(!cell){ alert('盤上の駒を選んでください'); return; }
    if(pendingSpecial === 'destroy' && cell.type === 'king'){ alert('指定破壊では王を指定できません'); return; }
    if(pendingSpecial === 'steal'){ if(cell.owner === currentPlayer){ alert('奪取対象は相手の駒にしてください'); pendingSpecial=null; selectedTarget=null; selectedFrom=null; renderBoard(); return; } if(cell.type === 'king' || cell.promoted){ alert('奪取対象は王・成駒以外です'); pendingSpecial=null; selectedTarget=null; selectedFrom=null; renderBoard(); return; } }
    selectedTarget = {r,c}; renderBoard(); return;
  }

  // 移動処理（ハイライト）
  const cell = board[r][c];
  if(selectedFrom){
    if(selectedFrom.r === r && selectedFrom.c === c){ selectedFrom = null; renderBoard(); return; }
    const moves = legalMoves(selectedFrom.r,selectedFrom.c);
    if(moves.some(m=>m.r===r && m.c===c)){
      const fromCell = board[selectedFrom.r][selectedFrom.c];
      if(fromCell.owner !== currentPlayer){ selectedFrom=null; renderBoard(); return; }
      const moveCost = fromCell.promoted ? 5 : 3;
      if(points[currentPlayer] < moveCost){ alert(`所持点が${moveCost}未満のため移動できません`); selectedFrom=null; renderBoard(); endTurn(); return; }
      const targetCell = board[r][c];
      if(targetCell && targetCell.type==='king'){
        const block = fromCell.noKingCaptureTurnByPlayer && fromCell.noKingCaptureTurnByPlayer[currentPlayer];
        if(block === turnIndex){ alert('この駒は今ターン王を取れません（奪取制約）'); return; }
      }
      doMove(selectedFrom.r, selectedFrom.c, r, c);
      endTurn(); return;
    } else {
      if(cell && cell.owner === currentPlayer){ selectedFrom = {r,c}; renderBoard(); return; }
      return;
    }
  } else {
    if(cell && cell.owner === currentPlayer){
      selectedFrom = {r,c}; renderBoard(); return;
    }
    return;
  }
}

/* ---------- 合法手 / 移動ロジック（省略せず） ---------- */
function legalMoves(r,c){
  const cell = board[r][c]; if(!cell) return []; const owner=cell.owner, dir=owner===0?-1:1; const moves=[]; const inb=(rr,cc)=> rr>=0 && rr<ROWS && cc>=0 && cc<COLS;
  const tryAdd=(rr,cc)=>{ if(inb(rr,cc) && (!board[rr][cc] || board[rr][cc].owner!==owner)) moves.push({r:rr,c:cc}); };
  if(cell.promoted){
    if(cell.type==='rook'){
      const deltas=[[1,0],[-1,0],[0,1],[0,-1]];
      for(const d of deltas){ let rr=r+d[0], cc=c+d[1]; while(inb(rr,cc)){ if(!board[rr][cc]){ moves.push({r:rr,c:cc}); rr+=d[0]; cc+=d[1]; } else { if(board[rr][cc].owner!==owner) moves.push({r:rr,c:cc}); break; } } }
      [[1,1],[1,-1],[-1,1],[-1,-1]].forEach(d=>tryAdd(r+d[0],c+d[1]));
    } else if(cell.type==='bishop'){
      const diag=[[1,1],[1,-1],[-1,1],[-1,-1]];
      for(const d of diag){ let rr=r+d[0], cc=c+d[1]; while(inb(rr,cc)){ if(!board[rr][cc]){ moves.push({r:rr,c:cc}); rr+=d[0]; cc+=d[1]; } else { if(board[rr][cc].owner!==owner) moves.push({r:rr,c:cc}); break; } } }
      [[1,0],[-1,0],[0,1],[0,-1]].forEach(d=>tryAdd(r+d[0],c+d[1]));
    } else { const g=[[dir,0],[0,1],[0,-1],[-dir,0],[dir,1],[dir,-1]]; g.forEach(d=>tryAdd(r+d[0],c+d[1])); }
    return moves;
  }
  const type = cell.type;
  if(type==='king') [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]].forEach(d=>tryAdd(r+d[0],c+d[1]));
  else if(type==='gold') [[dir,0],[0,1],[0,-1],[-dir,0],[dir,1],[dir,-1]].forEach(d=>tryAdd(r+d[0],c+d[1]));
  else if(type==='silver') [[dir,0],[dir,1],[dir,-1],[-dir,1],[-dir,-1]].forEach(d=>tryAdd(r+d[0],c+d[1]));
  else if(type==='knight'){ tryAdd(r+2*dir,c-1); tryAdd(r+2*dir,c+1); }
  else if(type==='lance'){ let rr=r+dir; while(rr>=0&&rr<ROWS){ if(!board[rr][c]){ moves.push({r:rr,c:c}); rr+=dir; } else { if(board[rr][c].owner!==owner) moves.push({r:rr,c:c}); break; } } }
  else if(type==='bishop'){ const deltas=[[1,1],[1,-1],[-1,1],[-1,-1]]; for(const d of deltas){ let rr=r+d[0], cc=c+d[1]; while(inb(rr,cc)){ if(!board[rr][cc]){ moves.push({r:rr,c:cc}); rr+=d[0]; cc+=d[1]; } else { if(board[rr][cc].owner!==owner) moves.push({r:rr,c:cc}); break; } } } }
  else if(type==='rook'){ const deltas=[[1,0],[-1,0],[0,1],[0,-1]]; for(const d of deltas){ let rr=r+d[0], cc=c+d[1]; while(inb(rr,cc)){ if(!board[rr][cc]){ moves.push({r:rr,c:cc}); rr+=d[0]; cc+=d[1]; } else { if(board[rr][cc].owner!==owner) moves.push({r:rr,c:cc}); break; } } } }
  else if(type==='pawn'){ let one=r+dir; if(inb(one,c)) tryAdd(one,c); if(twoStepCols[owner].has(c)){ let two=r+2*dir; if(inb(two,c) && !board[one][c] && (!board[two][c]||board[two][c].owner!==owner)) moves.push({r:two,c:c}); } }
  return moves;
}

/* ---------- doMove / 捕獲ロジック ---------- */
function doMove(fromR,fromC,toR,toC){
  const piece = board[fromR][fromC]; if(!piece) return false;
  const moveCost = piece.promoted ? 5 : 3;
  if(points[currentPlayer] < moveCost){ alert(`所持点が${moveCost}未満のため移動できません`); return false; }

  const targetPiece = board[toR][toC];
  if(targetPiece && targetPiece.type==='king'){
    const block = piece.noKingCaptureTurnByPlayer && piece.noKingCaptureTurnByPlayer[currentPlayer];
    if(block === turnIndex){ alert('この駒は今ターン王を取れません（奪取制約）'); return false; }
  }

  points[currentPlayer] -= moveCost;
  log(`${currentPlayer===0?'P1':'P2'} が移動のため自動で${moveCost}点支払った（残 ${points[currentPlayer]}点）`);

  addTrail(fromR, fromC, currentPlayer);
  addTrail(toR, toC, currentPlayer);

  if(targetPiece){
    if(targetPiece.owner === piece.owner) return false;
    if(targetPiece.type==='king'){
      board[toR][toC] = piece; board[fromR][fromC] = null;
      log(`${currentPlayer===0?'P1':'P2'} が王を取った！勝利`);
      endGame(currentPlayer, `王を取ったため P${currentPlayer+1} の勝利`); return true;
    }
    const base = CAPTURE_BASE[targetPiece.type] || 0;
    const bonus = targetPiece.promoted ? 3 : 0;
    const gainIfPoints = base + bonus;
    let wantPoints = true;
    if(cpuPlays === currentPlayer){
      if(gainIfPoints >= 8) wantPoints = true; else wantPoints = Math.random() < 0.8;
    } else {
      wantPoints = confirm(`駒を捕獲しました（${pieceLabel(targetPiece)}）。\nOK = ${gainIfPoints}点を得る ／ Cancel = 駒を獲得して保留にする（後で6点で配置可能）`);
    }
    if(wantPoints){
      points[currentPlayer] += gainIfPoints;
      captures[currentPlayer] += 1;
      board[toR][toC] = piece; board[fromR][fromC] = null;
      log(`${currentPlayer===0?'P1':'P2'} が駒を捕獲して +${gainIfPoints}点（${pieceLabel(targetPiece)}）`);
    } else {
      reserves[currentPlayer].push({type: targetPiece.type, promoted: targetPiece.promoted});
      board[toR][toC] = piece; board[fromR][fromC] = null;
      log(`${currentPlayer===0?'P1':'P2'} が駒を捕獲して保留に追加: ${pieceLabel(targetPiece)}（保留数=${reserves[currentPlayer].length}）`);
    }
  } else {
    board[toR][toC] = piece; board[fromR][fromC] = null;
  }

  // 成り自動 / プロンプト
  if(!piece.promoted){
    const owner = piece.owner;
    const inPromotionZone = (owner===0 && toR<=2) || (owner===1 && toR>=6);
    if(inPromotionZone && ['pawn','lance','knight','silver','bishop','rook'].includes(piece.type)){
      if(cpuPlays === currentPlayer){
        if(cpuLevel === 'expert' || cpuLevel === 'master'){
          if(['pawn','lance','knight'].includes(piece.type) || Math.random() < 0.85){ piece.promoted = true; log(`CPU(P${currentPlayer+1}) が ${coordLabel(toR,toC)} を成りました`); }
        } else if(cpuLevel === 'hard'){
          if(Math.random() < 0.7){ piece.promoted = true; }
        } else {
          if(Math.random() < 0.4){ piece.promoted = true; }
        }
      } else {
        if(confirm(`${pieceLabel(piece)} を成りますか？（OK: 成る / Cancel: 成らない）`)){
          piece.promoted = true; log(`${piece.owner===0?'P1':'P2'} の ${pieceLabel(piece)} が成りました`);
        }
      }
    }
    if(piece.type==='pawn' || piece.type==='lance'){ if((piece.owner===0 && toR===0) || (piece.owner===1 && toR===8)){ piece.promoted=true; log('自動成り（行き場が無いため）'); } }
    if(piece.type==='knight'){ if((piece.owner===0 && toR<=1) || (piece.owner===1 && toR>=7)){ piece.promoted=true; log('自動成り（桂の行き場が無いため）'); } }
  }

  const movedPiece = board[toR][toC];
  if(movedPiece && movedPiece.type === 'pawn' && !movedPiece.promoted){
    checkPawnColumnsForOwner(movedPiece.owner);
  }

  pendingSpecial=null; selectedTarget=null; selectedFrom=null;
  turnHasMoved = true;
  renderBoard();

  // check 110 点勝利
  if(points[currentPlayer] >= 110 && points[1-currentPlayer] < 110){
    endGame(currentPlayer, `110点で P${currentPlayer+1} の勝利`);
    return true;
  }

  return true;
}

/* ---------- 特殊アクション（抜粋） ---------- */
function startPromoteSelect(){ if(turnHasMoved){ alert('既に移動済みのため特殊行動はできません'); return; } if(points[currentPlayer] < 13){ alert('13点必要です'); return; } pendingSpecial = 'promote'; selectedTarget = null; renderBoard(); alert('成らせたい（または解除したい）駒をクリックして選択 → 「選択を確定して実行」を押してください'); }
function startSpecial(type,cost){ if(turnHasMoved){ alert('既に移動済みで発動できません'); return; } if(points[currentPlayer] < cost){ alert(cost + '点必要です'); return; } pendingSpecial = type; selectedTarget=null; renderBoard(); alert('対象を選択→確定'); }

function onConfirmTarget(){
  if(!pendingSpecial || !selectedTarget){ alert('先に特殊行動と対象を選んでください'); return; }
  const r = selectedTarget.r, c = selectedTarget.c;
  const cell = (board && board[r]) ? board[r][c] : null;
  if(!cell){ alert('選択した駒が見つかりませんでした。もう一度選んでください。'); pendingSpecial=null; selectedTarget=null; renderBoard(); return; }

  if(pendingSpecial === 'promote'){
    if(points[currentPlayer] < 13){ alert('13点不足のため実行できません'); pendingSpecial=null; selectedTarget=null; renderBoard(); return; }
    points[currentPlayer] -= 13;
    cell.promoted = !cell.promoted;
    log(`${currentPlayer===0?'P1':'P2'} が13点で ${coordLabel(r,c)} の成りを ${cell.promoted ? '実行' : '解除'} しました （所持 ${points[currentPlayer]}点）`);
    if(cell.type === 'pawn' && !cell.promoted) checkPawnColumnsForOwner(cell.owner);
    pendingSpecial=null; selectedTarget=null; renderBoard(); return;
  }

  if(pendingSpecial === 'destroy'){
    if(points[currentPlayer] < 30){ alert('30点不足'); pendingSpecial=null; selectedTarget=null; renderBoard(); return; }
    if(cell.type === 'king'){ alert('王は指定破壊不可'); pendingSpecial=null; selectedTarget=null; renderBoard(); return; }
    points[currentPlayer] -= 30; board[r][c] = null;
    addTrail(r,c,currentPlayer);
    log(`${currentPlayer===0?'P1':'P2'} が30点で ${coordLabel(r,c)} の駒を破壊しました`);
    pendingSpecial=null; selectedTarget=null; renderBoard(); return;
  }

  if(pendingSpecial === 'steal'){
    if(points[currentPlayer] < 16){ alert('16点不足'); pendingSpecial=null; selectedTarget=null; renderBoard(); return; }
    if(cell.owner === currentPlayer){ alert('奪取対象は相手の駒にしてください'); pendingSpecial=null; selectedTarget=null; renderBoard(); return; }
    if(cell.type === 'king' || cell.promoted){ alert('奪取対象は王・成駒以外です'); pendingSpecial=null; selectedTarget=null; renderBoard(); return; }
    points[currentPlayer] -= 16;
    const rnum = Math.random();
    if(rnum < 1/3){
      cell.owner = currentPlayer;
      if(!cell.noKingCaptureTurnByPlayer) cell.noKingCaptureTurnByPlayer = {};
      cell.noKingCaptureTurnByPlayer[currentPlayer] = turnIndex;
      log(`${currentPlayer===0?'P1':'P2'} の奪取成功！ ${coordLabel(r,c)} を自分の駒にしました（当該ターンは王を取れない）`);
    } else {
      points[1-currentPlayer] += 16;
      log(`${currentPlayer===0?'P1':'P2'} の奪取失敗。相手に +16点を与えました`);
    }
    pendingSpecial=null; selectedTarget=null; renderBoard(); return;
  }

  pendingSpecial=null; selectedTarget=null; renderBoard();
}

/* 二歩・自己破壊・ドレイン等（省略せず実装） */
function onTwoStep(){ if(turnHasMoved){ alert('既に移動済みで発動不可'); return; } if(points[currentPlayer] < 25){ alert('25点必要'); return; } const col=document.getElementById('twoStepCol').value; if(col===''){ alert('列を選んでください'); return; } const ci=+col; twoStepCols[currentPlayer].add(ci); points[currentPlayer]-=25; log(`${currentPlayer===0?'P1':'P2'} が25点で列 ${String.fromCharCode(65+ci)} の2歩権を取得`); renderBoard(); }
function onInstantWin(){ if(turnHasMoved){ alert('既に移動済みで発動不可'); return; } if(points[currentPlayer] < 110){ alert('110点必要です'); return; } const opp = 1-currentPlayer; if(points[opp] < 110){ endGame(currentPlayer, `110点で P${currentPlayer+1} の勝利`); } else alert('相手の点が110点未満ではありません'); }
function onSelfDestroy(){ if(turnHasMoved){ alert('既に移動済みで発動不可'); return; } const myPieces=[]; for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const cell=board[r][c]; if(cell && cell.owner===currentPlayer) myPieces.push({r,c}); } if(myPieces.length===0){ alert('破壊できる駒がありません'); return; } for(let i=myPieces.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [myPieces[i],myPieces[j]]=[myPieces[j],myPieces[i]]; } const k=Math.min(3,myPieces.length); const sel=myPieces.slice(0,k); let kingDestroyed = false; sel.forEach(pos=>{ const wasKing = board[pos.r][pos.c].type==='king'; if(wasKing) kingDestroyed = true; board[pos.r][pos.c]=null; addTrail(pos.r,pos.c,currentPlayer); }); points[currentPlayer]+=13; log(`${currentPlayer===0?'P1':'P2'} が自己破壊で ${k} 体破壊し +13点（所持 ${points[currentPlayer]}点）`); renderBoard(); if(kingDestroyed){ endGame(currentPlayer, `自己破壊で王が消滅したため P${currentPlayer+1} の勝利`); } }

function onDrainOpponentPoints(){ if(points[currentPlayer] < 5){ alert('5点必要です'); return; } points[currentPlayer] -= 5; const opp = 1-currentPlayer; const reduce = 3; const before = points[opp]; points[opp] = Math.max(0, points[opp] - reduce); log(`${currentPlayer===0?'P1':'P2'} が5点を支払い、相手を-${reduce}点（${before} → ${points[opp]}）にしました`); renderBoard(); }

async function onDrainUntilZero(safetyLimit = 200){
  if(points[currentPlayer] < 5){ alert('5点必要です'); return; }
  const opp = 1-currentPlayer;
  if(points[opp] === 0){ alert('相手は既に0点です'); return; }
  let count = 0;
  while(points[currentPlayer] >= 5 && points[opp] > 0 && count < safetyLimit){
    points[currentPlayer] -= 5;
    const before = points[opp];
    points[opp] = Math.max(0, points[opp] - 3);
    log(`${currentPlayer===0?'P1':'P2'} が5点を支払い、相手を-3点（${before} → ${points[opp]}）にしました`);
    renderBoard();
    await new Promise(res => setTimeout(res, 120));
    count++;
  }
  if(count >= safetyLimit) log('自動ドレインは安全上の回数制限に達しました。');
  endTurn();
}

/* ---------- ルーレット掛け ---------- */
function onOpenBet(){
  if(cpuPlays !== null && cpuPlays === currentPlayer){ alert('この手番はCPUが操作します'); return; }
  const grid = document.getElementById('betsCur'); if(!grid) return; grid.innerHTML='';
  for(let i=1;i<=4;i++){ const div=document.createElement('div'); div.className='betCell'; div.innerHTML = `<div style="width:28px">${i}</div><input type="number" min="0" value="0" data-num="${i}">`; grid.appendChild(div); }
  const bpc = document.getElementById('betPointsCur'); if(bpc) bpc.textContent = points[currentPlayer];
  const modal = document.getElementById('betModal'); if(modal) modal.classList.remove('hidden');
  const sb = document.getElementById('spinBtn'); if(sb) sb.disabled = true;
}
function onConfirmBets(){
  const inputs = document.querySelectorAll('#betsCur input[type=number]');
  const newBets = [];
  for(const inp of inputs){ const num=+inp.dataset.num, val=Math.max(0, Math.floor(+inp.value||0)); if(val>0) newBets.push({num, amt: val}); }
  if(newBets.length > 10){ alert('最大10箇所まで'); return; }
  const total = newBets.reduce((s,b)=>s+b.amt,0);
  if(total > points[currentPlayer]){ alert('賭け合計が所持点を超えています'); return; }
  betsCur = newBets; betsConfirmedFlag = true; points[currentPlayer] -= total;
  log(`${currentPlayer===0?'P1':'P2'} がルーレットに賭けました: 合計 ${total}点`);
  const modal = document.getElementById('betModal'); if(modal) modal.classList.add('hidden');
  const sb = document.getElementById('spinBtn'); if(sb) sb.disabled = false;
}
function onSpin(){
  if(!betsConfirmedFlag){ alert('賭けを確定してください'); return; }
  if(spinCount >= MAX_SPIN_PER_TURN){ alert('このターンのルーレットはもう回せません'); return; }
  spinCount += 1;
  const val = Math.floor(Math.random()*4)+1;
  if(rouletteResultEl) rouletteResultEl.textContent = val;
  log(`ルーレット結果: ${val}`);
  betsCur.forEach(b=> { if(b.num === val){ const award = b.amt * 3; points[currentPlayer] += award; log(`${currentPlayer===0?'P1':'P2'} の賭け当たり! (+${award}点)`); }});
  betsCur=[]; betsConfirmedFlag=false;
  const sb = document.getElementById('spinBtn'); if(sb) sb.disabled = true;
  renderBoard();
}

/* ---------- トレイル / 同列歩チェック ---------- */
function decayTrails(){ trails = trails.map(t=> ({...t, remainingTurns: t.remainingTurns-1})).filter(t=> t.remainingTurns > 0); }
function addTrail(r,c,owner){ trails.push({r,c,owner,remainingTurns:1}); }
function checkPawnColumnsForOwner(owner){
  for(let col=0; col<COLS; col++){
    const pawns = [];
    for(let row=0; row<ROWS; row++){
      const cell = board[row][col];
      if(cell && cell.owner === owner && cell.type === 'pawn' && !cell.promoted){
        pawns.push({r: row, c: col});
      }
    }
    if(pawns.length > 1){
      const keepIndex = Math.floor(Math.random()*pawns.length);
      for(let i=0;i<pawns.length;i++){
        if(i===keepIndex) continue;
        const p = pawns[i];
        board[p.r][p.c] = null;
        addTrail(p.r, p.c, owner);
        log(`${owner===0?'P1':'P2'} の同列歩がランダムで消滅: ${coordLabel(p.r,p.c)}`);
      }
    }
  }
}

/* ---------- ターン制御 ---------- */
function startTurn(){
  turnIndex += 1; turnHasMoved=false; pendingSpecial=null; selectedTarget=null; selectedFrom=null;
  decayTrails();
  spinCount = 0;
  points[currentPlayer] += 4;
  log(`${currentPlayer===0?'P1':'P2'} のターン開始：+4点（所持 ${points[currentPlayer]}点）`);
  if(rouletteResultEl) rouletteResultEl.textContent = '—';
  betsCur = []; betsConfirmedFlag = false;
  const bc = document.getElementById('betsCur'); if(bc) bc.innerHTML='';
  const bpc = document.getElementById('betPointsCur'); if(bpc) bpc.textContent = points[currentPlayer];
  renderBoard();
  if(cpuPlays === currentPlayer){
    setTimeout(()=> cpuTakeTurn(currentPlayer), 220 + Math.random()*280);
  }
}

function endTurn(){ pendingSpecial=null; selectedTarget=null; selectedFrom=null; currentPlayer = 1 - currentPlayer; renderBoard(); startTurn(); }

/* ---------- 終了処理：モード選択に戻る ---------- */
function endGame(winner, reason){
  log(`ゲーム終了: ${reason}`);
  alert(reason);
  // terminate workers
  terminateWorkers();
  cpuPlays = null;
  const m = document.getElementById('startModal'); if(m) m.classList.remove('hidden');
}

/* ---------- リセット / 中断 ---------- */
function resetGame(){ initBoard(); currentPlayer=0; points=[10,10]; captures=[0,0]; twoStepCols=[new Set(), new Set()]; pendingSpecial=null; selectedTarget=null; selectedFrom=null; turnHasMoved=false; turnIndex=0; reserves=[[],[]]; betsCur=[]; betsConfirmedFlag=false; trails=[]; spinCount=0; log('ゲーム初期化'); startTurn(); renderBoard(); }
function onAbortMatch(){ if(!confirm('対局を中断してモード選択に戻りますか？')) return; terminateWorkers(); const m=document.getElementById('startModal'); if(m) m.classList.remove('hidden'); initBoard(); renderBoard(); }

/* ---------- チェック判定ユーティリティ ---------- */
function findKingPosition(owner){
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const cell = board[r][c];
    if(cell && cell.owner===owner && cell.type==='king') return {r,c};
  }
  return null;
}

function isPlayerInCheck(player, boardState = null){
  const b = boardState || board;
  const kingPos = (function(){
    for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const cell=b[r][c]; if(cell && cell.owner===player && cell.type==='king') return {r,c}; } return null;
  })();
  if(!kingPos) return false;
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const cell = b[r][c];
    if(!cell || cell.owner===player) continue;
    const moves = legalMovesForBoard(b, r, c);
    if(moves.some(m => m.r === kingPos.r && m.c === kingPos.c)) return true;
  }
  return false;
}

function legalMovesForBoard(bd, r, c){
  const cell = bd[r][c]; if(!cell) return []; const owner=cell.owner, dir=owner===0?-1:1; const moves=[]; const inb=(rr,cc)=> rr>=0 && rr<ROWS && cc>=0 && cc<COLS;
  const tryAdd=(rr,cc)=>{ if(inb(rr,cc) && (!bd[rr][cc] || bd[rr][cc].owner!==owner)) moves.push({r:rr,c:cc}); };
  if(cell.promoted){
    if(cell.type==='rook'){
      const deltas=[[1,0],[-1,0],[0,1],[0,-1]];
      for(const d of deltas){ let rr=r+d[0], cc=c+d[1]; while(inb(rr,cc)){ if(!bd[rr][cc]){ moves.push({r:rr,c:cc}); rr+=d[0]; cc+=d[1]; } else { if(bd[rr][cc].owner!==owner) moves.push({r:rr,c:cc}); break; } } }
      [[1,1],[1,-1],[-1,1],[-1,-1]].forEach(d=>tryAdd(r+d[0],c+d[1]));
    } else if(cell.type==='bishop'){
      const diag=[[1,1],[1,-1],[-1,1],[-1,-1]];
      for(const d of diag){ let rr=r+d[0], cc=c+d[1]; while(inb(rr,cc)){ if(!bd[rr][cc]){ moves.push({r:rr,c:cc}); rr+=d[0]; cc+=d[1]; } else { if(bd[rr][cc].owner!==owner) moves.push({r:rr,c:cc}); break; } } }
      [[1,0],[-1,0],[0,1],[0,-1]].forEach(d=>tryAdd(r+d[0],c+d[1]));
    } else { const g=[[dir,0],[0,1],[0,-1],[-dir,0],[dir,1],[dir,-1]]; g.forEach(d=>tryAdd(r+d[0],c+d[1])); }
    return moves;
  }
  const type = cell.type;
  if(type==='king') [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]].forEach(d=>tryAdd(r+d[0],c+d[1]));
  else if(type==='gold') [[dir,0],[0,1],[0,-1],[-dir,0],[dir,1],[dir,-1]].forEach(d=>tryAdd(r+d[0],c+d[1]));
  else if(type==='silver') [[dir,0],[dir,1],[dir,-1],[-dir,1],[-dir,-1]].forEach(d=>tryAdd(r+d[0],c+d[1]));
  else if(type==='knight'){ tryAdd(r+2*dir,c-1); tryAdd(r+2*dir,c+1); }
  else if(type==='lance'){ let rr=r+dir; while(rr>=0&&rr<ROWS){ if(!bd[rr][c]){ moves.push({r:rr,c:c}); rr+=dir; } else { if(bd[rr][c].owner!==owner) moves.push({r:rr,c:c}); break; } } }
  else if(type==='bishop'){ const deltas=[[1,1],[1,-1],[-1,1],[-1,-1]]; for(const d of deltas){ let rr=r+d[0], cc=c+d[1]; while(inb(rr,cc)){ if(!bd[rr][cc]){ moves.push({r:rr,c:cc}); rr+=d[0]; cc+=d[1]; } else { if(bd[rr][cc].owner!==owner) moves.push({r:rr,c:cc}); break; } } } }
  else if(type==='rook'){ const deltas=[[1,0],[-1,0],[0,1],[0,-1]]; for(const d of deltas){ let rr=r+d[0], cc=c+d[1]; while(inb(rr,cc)){ if(!bd[rr][cc]){ moves.push({r:rr,c:cc}); rr+=d[0]; cc+=d[1]; } else { if(bd[rr][cc].owner!==owner) moves.push({r:rr,c:cc}); break; } } } }
  else if(type==='pawn'){ let one=r+dir; if(inb(one,c)) tryAdd(one,c); if(bd.twoStepCols && bd.twoStepCols[owner] && bd.twoStepCols[owner].has && bd.twoStepCols[owner].has(c)){ let two=r+2*dir; if(inb(two,c) && !bd[one][c] && (!bd[two][c]||bd[two][c].owner!==owner)) moves.push({r:two,c:c}); } }
  return moves;
}

/* ---------- MCTS Worker Blob 作成（キャッシュ） ---------- */
function createWorkerBlobURL(){
  if(workerBlobUrl) return workerBlobUrl;
  const src = `
    const ROWS = ${ROWS}, COLS = ${COLS};
    const CAPTURE_BASE = ${JSON.stringify(CAPTURE_BASE)};
    function inb(rr,cc){ return rr>=0 && rr<ROWS && cc>=0 && cc<COLS; }
    function cloneState(s){
      return {
        board: s.board.map(row => row.map(cell => cell ? ({...cell, noKingCaptureTurnByPlayer: {...(cell.noKingCaptureTurnByPlayer||{})}}) : null)),
        points: [...s.points],
        reserves: s.reserves.map(arr => arr.map(x=> ({...x}))),
        twoStepCols: s.twoStepCols.map(arr => new Set(arr)),
        currentPlayer: s.currentPlayer,
        turnIndex: s.turnIndex
      };
    }
    function legalMovesForState(state, r, c){
      const cell = state.board[r][c]; if(!cell) return []; const owner=cell.owner, dir=owner===0?-1:1; const moves=[]; const inb=(rr,cc)=> rr>=0 && rr<ROWS && cc>=0 && cc<COLS;
      const tryAdd=(rr,cc)=>{ if(inb(rr,cc) && (!state.board[rr][cc] || state.board[rr][cc].owner!==owner)) moves.push({r:rr,c:cc}); };
      if(cell.promoted){
        if(cell.type==='rook'){
          const deltas=[[1,0],[-1,0],[0,1],[0,-1]];
          for(const d of deltas){ let rr=r+d[0], cc=c+d[1]; while(inb(rr,cc)){ if(!state.board[rr][cc]){ moves.push({r:rr,c:cc}); rr+=d[0]; cc+=d[1]; } else { if(state.board[rr][cc].owner!==owner) moves.push({r:rr,c:cc}); break; } } }
          [[1,1],[1,-1],[-1,1],[-1,-1]].forEach(d=>tryAdd(r+d[0],c+d[1]));
        } else if(cell.type==='bishop'){
          const diag=[[1,1],[1,-1],[-1,1],[-1,-1]];
          for(const d of diag){ let rr=r+d[0], cc=c+d[1]; while(inb(rr,cc)){ if(!state.board[rr][cc]){ moves.push({r:rr,c:cc}); rr+=d[0]; cc+=d[1]; } else { if(state.board[rr][cc].owner!==owner) moves.push({r:rr,c:cc}); break; } } }
          [[1,0],[-1,0],[0,1],[0,-1]].forEach(d=>tryAdd(r+d[0],c+d[1]));
        } else { const g=[[dir,0],[0,1],[0,-1],[-dir,0],[dir,1],[dir,-1]]; g.forEach(d=>tryAdd(r+d[0],c+d[1])); }
        return moves;
      }
      const type = cell.type;
      if(type==='king') [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]].forEach(d=>tryAdd(r+d[0],c+d[1]));
      else if(type==='gold') [[dir,0],[0,1],[0,-1],[-dir,0],[dir,1],[dir,-1]].forEach(d=>tryAdd(r+d[0],c+d[1]));
      else if(type==='silver') [[dir,0],[dir,1],[dir,-1],[-dir,1],[-dir,-1]].forEach(d=>tryAdd(r+d[0],c+d[1]));
      else if(type==='knight'){ tryAdd(r+2*dir,c-1); tryAdd(r+2*dir,c+1); }
      else if(type==='lance'){ let rr=r+dir; while(rr>=0&&rr<ROWS){ if(!state.board[rr][c]){ moves.push({r:rr,c:c}); rr+=dir; } else { if(state.board[rr][c].owner!==owner) moves.push({r:rr,c:c}); break; } } }
      else if(type==='bishop'){ const deltas=[[1,1],[1,-1],[-1,1],[-1,-1]]; for(const d of deltas){ let rr=r+d[0], cc=c+d[1]; while(inb(rr,cc)){ if(!state.board[rr][cc]){ moves.push({r:rr,c:cc}); rr+=d[0]; cc+=d[1]; } else { if(state.board[rr][cc].owner!==owner) moves.push({r:rr,c:cc}); break; } } } }
      else if(type==='rook'){ const deltas=[[1,0],[-1,0],[0,1],[0,-1]]; for(const d of deltas){ let rr=r+d[0], cc=c+d[1]; while(inb(rr,cc)){ if(!state.board[rr][cc]){ moves.push({r:rr,c:cc}); rr+=d[0]; cc+=d[1]; } else { if(state.board[rr][cc].owner!==owner) moves.push({r:rr,c:cc}); break; } } } }
      else if(type==='pawn'){ let one=r+dir; if(inb(one,c)) tryAdd(one,c); if(state.twoStepCols[owner] && state.twoStepCols[owner].has && state.twoStepCols[owner].has(c)){ let two=r+2*dir; if(inb(two,c) && !state.board[one][c] && (!state.board[two][c]||state.board[two][c].owner!==owner)) moves.push({r:two,c:c}); } }
      return moves;
    }

    function generateAllActionsForState(state){
      const acts = [];
      const pl = state.currentPlayer;
      // moves
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
        const cell = state.board[r][c];
        if(!cell || cell.owner !== pl) continue;
        const moves = legalMovesForState(state, r, c);
        for(const m of moves) acts.push({ type: 'move', from: {r,c}, to: {r:m.r, c:m.c} });
      }
      // promote toggle
      if(state.points[pl] >= 13){
        for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
          const cell = state.board[r][c];
          if(!cell || cell.owner !== pl) continue;
          // quick heuristic: simulate toggle and see if new captures appear
          const wasProm = cell.promoted;
          cell.promoted = !wasProm;
          const movesAfter = legalMovesForState(state, r, c);
          const newCapture = movesAfter.some(m => state.board[m.r][m.c] && state.board[m.r][m.c].owner !== pl);
          cell.promoted = wasProm;
          acts.push({ type: 'promote', target:{r,c}, heuristicNewCapture: newCapture });
        }
      }
      // destroy (any non-king)
      if(state.points[pl] >= 30){
        for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const cell=state.board[r][c]; if(cell && cell.type !== 'king') acts.push({ type: 'destroy', target:{r,c} }); }
      }
      // steal
      if(state.points[pl] >= 16){
        for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ const cell=state.board[r][c]; if(cell && cell.owner !== pl && cell.type !== 'king' && !cell.promoted) acts.push({ type: 'steal', target:{r,c} }); }
      }
      // two-step
      if(state.points[pl] >= 25){
        for(let col=0; col<COLS; col++) acts.push({ type: 'twowalk', col });
      }
      // place reserve
      if(state.points[pl] >= 6 && state.reserves[pl].length > 0){
        for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){ if(!state.board[r][c]) acts.push({ type: 'placeReserve', reserveIndex: 0, to:{r,c} }); }
      }
      // drain (point attack)
      if(state.points[pl] >= 5){
        acts.push({ type: 'drain' });
      }
      acts.push({ type: 'pass' });
      return acts;
    }

    function applyActionToState(state, action){
      const pl = state.currentPlayer;
      if(action.type === 'move'){
        const f = action.from, t = action.to;
        const piece = state.board[f.r][f.c];
        const captured = state.board[t.r][t.c];
        state.board[t.r][t.c] = piece;
        state.board[f.r][f.c] = null;
        if(!piece) return;
        const cost = piece.promoted ? 5 : 3;
        state.points[pl] = Math.max(0, state.points[pl] - cost);
        if(captured){
          if(captured.type === 'king'){ state.terminal = { winner: pl }; return; }
          const base = CAPTURE_BASE[captured.type] || 0;
          const bonus = captured.promoted ? 3 : 0;
          state.points[pl] += base + bonus;
        }
        if(!piece.promoted){
          const owner = piece.owner;
          const inPromotionZone = (owner===0 && t.r<=2) || (owner===1 && t.r>=6);
          if(inPromotionZone && ['pawn','lance','knight','silver','bishop','rook'].includes(piece.type)){
            if(Math.random() < 0.4) piece.promoted = true;
          }
        }
        if(state.board[t.r][t.c] && state.board[t.r][t.c].type === 'pawn' && !state.board[t.r][t.c].promoted){
          const col = t.c;
          const pawns = [];
          for(let r=0;r<ROWS;r++){ const cell = state.board[r][col]; if(cell && cell.owner === pl && cell.type === 'pawn' && !cell.promoted) pawns.push({r,c:col}); }
          if(pawns.length > 1){
            const keepIndex = Math.floor(Math.random() * pawns.length);
            for(let i=0;i<pawns.length;i++){ if(i === keepIndex) continue; state.board[pawns[i].r][pawns[i].c] = null; }
          }
        }
      } else if(action.type === 'promote'){
        const t = action.target;
        if(state.points[pl] >= 13){
          const cell = state.board[t.r][t.c];
          if(cell){ state.points[pl] -= 13; cell.promoted = !cell.promoted; }
        }
      } else if(action.type === 'destroy'){
        const t = action.target;
        if(state.points[pl] >= 30){
          const cell = state.board[t.r][t.c];
          if(cell && cell.type !== 'king'){ state.points[pl] -= 30; state.board[t.r][t.c] = null; }
        }
      } else if(action.type === 'steal'){
        const t = action.target;
        if(state.points[pl] >= 16){
          state.points[pl] -= 16;
          const cell = state.board[t.r][t.c];
          if(cell && cell.owner !== pl && cell.type !== 'king' && !cell.promoted){
            if(Math.random() < (1/3)){ cell.owner = pl; if(!cell.noKingCaptureTurnByPlayer) cell.noKingCaptureTurnByPlayer = {}; cell.noKingCaptureTurnByPlayer[pl] = state.turnIndex; }
            else { state.points[1-pl] += 16; }
          }
        }
      } else if(action.type === 'twowalk'){
        if(state.points[pl] >= 25){ state.points[pl] -= 25; state.twoStepCols[pl].add(action.col); }
      } else if(action.type === 'placeReserve'){
        if(state.reserves[pl].length > 0 && state.points[pl] >= 6){
          const rp = state.reserves[pl].shift();
          state.board[action.to.r][action.to.c] = {type: rp.type, owner: pl, promoted: rp.promoted, noKingCaptureTurnByPlayer:{}};
          state.points[pl] -= 6;
        }
      } else if(action.type === 'drain'){
        if(state.points[pl] >= 5){
          state.points[pl] -= 5;
          const opp = 1-pl;
          state.points[opp] = Math.max(0, state.points[opp] - 3);
        }
      } else if(action.type === 'pass'){
        // nothing
      }
      state.currentPlayer = 1 - state.currentPlayer;
      state.turnIndex = (state.turnIndex || 0) + 1;
    }

    function checkTerminalForState(state){
      let kings = [false,false];
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
        const cell = state.board[r][c];
        if(cell && cell.type === 'king') kings[cell.owner] = true;
      }
      if(!kings[0]) return { terminal: true, winner: 1 };
      if(!kings[1]) return { terminal: true, winner: 0 };
      if(state.points[0] >= 110 && state.points[1] < 110) return { terminal:true, winner:0 };
      if(state.points[1] >= 110 && state.points[0] < 110) return { terminal:true, winner:1 };
      return { terminal:false };
    }

    function evaluateStateForPlayer(state, player){
      let material = 0;
      let mobility = 0;
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
        const cell = state.board[r][c];
        if(!cell) continue;
        const base = CAPTURE_BASE[cell.type] || 0;
        const val = base + (cell.promoted ? 3 : 0);
        material += (cell.owner === player) ? val : -val;
        const movesCount = legalMovesForState(state,r,c).length;
        mobility += (cell.owner === player) ? Math.sqrt(1+movesCount) : -Math.sqrt(1+movesCount);
      }
      const pointDiff = state.points[player] - state.points[1-player];

      let oppPromoted = 0;
      for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
        const cell = state.board[r][c];
        if(cell && cell.owner !== player && cell.promoted) oppPromoted++;
      }
      const opponentCanUsePromoted = state.points[1-player] >= 5 ? 1.0 : 0.3;
      const promotedThreat = - (oppPromoted * 6.0 * opponentCanUsePromoted);

      return material * 1.0 + mobility * 0.1 + pointDiff * 0.25 + promotedThreat;
    }

    function rolloutState(state, maxDepth){
      let depth = 0;
      while(depth < maxDepth){
        const term = checkTerminalForState(state);
        if(term.terminal) return term.winner;
        const acts = generateAllActionsForState(state);
        if(acts.length === 0) return null;
        const weighted = acts.map(a => {
          let w = 1;
          if(a.type==='move'){ const dest = a.to; const target = state.board[dest.r][dest.c]; if(target) w += (CAPTURE_BASE[target.type]||0)+3; }
          if(a.type==='promote') w += (a.heuristicNewCapture ? 6 : 2);
          if(a.type==='steal') w += 4;
          if(a.type==='drain') w += 1.5;
          return {a,w};
        });
        const sum = weighted.reduce((s,x)=>s+x.w,0);
        let rnd = Math.random()*sum; let pick = weighted[0].a;
        for(const w of weighted){ if(rnd < w.w){ pick = w.a; break;} rnd -= w.w; }
        applyActionToState(state, pick);
        depth++;
      }
      const s0 = evaluateStateForPlayer(state, 0);
      const s1 = evaluateStateForPlayer(state, 1);
      return s0 >= s1 ? 0 : 1;
    }

    class Node {
      constructor(state, parent=null, action=null, rootPlayer=null){
        this.state = cloneState(state);
        this.parent = parent;
        this.action = action;
        this.children = [];
        this.visits = 0;
        this.value = 0;
        this.untried = generateAllActionsForState(this.state);
        this.rootPlayer = rootPlayer;
      }
    }

    function uctSelect(node){
      let best = null; let bestScore = -Infinity;
      for(const ch of node.children){
        const exploit = ch.value / (ch.visits || 1);
        const explore = Math.sqrt(Math.log(node.visits + 1) / (ch.visits + 1));
        let heur = 0;
        if(ch.action && ch.action.heuristicNewCapture) heur += 0.8;
        const score = exploit + 1.2 * explore + heur;
        if(score > bestScore){ bestScore = score; best = ch; }
      }
      return best;
    }

    function expand(node){
      if(node.untried.length === 0) return null;
      const idx = Math.floor(Math.random()*node.untried.length);
      const act = node.untried.splice(idx,1)[0];
      const nextState = cloneState(node.state);
      applyActionToState(nextState, act);
      const child = new Node(nextState, node, act, node.rootPlayer);
      node.children.push(child);
      return child;
    }

    function backprop(node, result){
      let n = node;
      while(n){
        n.visits += 1;
        n.value += result;
        n = n.parent;
      }
    }

    function runMCTSSync(rootState, rootPlayer, iters, maxPlayoutDepth, allowedActions){
      const root = new Node(rootState, null, null, rootPlayer);
      if(Array.isArray(allowedActions) && allowedActions.length>0){
        const keyFn = (a)=> JSON.stringify(a);
        const allowedSet = new Set(allowedActions.map(keyFn));
        root.untried = root.untried.filter(a=> allowedSet.has(keyFn(a)));
        if(root.untried.length === 0){
          root.untried = generateAllActionsForState(root.state);
        }
      }
      for(let i=0;i<iters;i++){
        let node = root;
        while(node.untried.length === 0 && node.children.length > 0){
          node = uctSelect(node);
        }
        if(node.untried.length > 0){
          node = expand(node);
        }
        const sim = cloneState(node.state);
        const winner = rolloutState(sim, maxPlayoutDepth);
        const res = (winner === null) ? (evaluateStateForPlayer(sim, rootPlayer) >= evaluateStateForPlayer(sim, 1-rootPlayer) ? 1 : 0) : (winner === rootPlayer ? 1 : 0);
        backprop(node, res);
      }
      let best = null, bestVisits = -1;
      for(const ch of root.children){
        if(ch.visits > bestVisits){ bestVisits = ch.visits; best = ch; }
      }
      return best ? { action: best.action, visits: bestVisits } : null;
    }

    self.onmessage = function(e){
      const p = e.data;
      if(p.cmd === 'run'){
        try{
          const st = p.state;
          const result = runMCTSSync(st, st.currentPlayer, p.iters || 1000, p.maxDepth || 20, p.allowedActions || null);
          self.postMessage({ status:'ok', result });
        }catch(err){
          self.postMessage({ status:'error', error: String(err) });
        }
      }
    };
  `;
  const blob = new Blob([src], {type:'application/javascript'});
  workerBlobUrl = URL.createObjectURL(blob);
  return workerBlobUrl;
}

/* Worker を必要数まで確保（既存プールを再利用・増減） */
function ensureWorkers(count){
  if(!workerBlobUrl) createWorkerBlobURL();
  if(workerPool.length === count) return;
  // 増やす
  while(workerPool.length < count){
    const w = new Worker(workerBlobUrl);
    workerPool.push(w);
  }
  // 減らす（余分を terminate）
  while(workerPool.length > count){
    const w = workerPool.pop();
    try{ w.terminate(); }catch(e){}
  }
}

/* Worker の完全破棄 */
function terminateWorkers(){
  if(workerPool && workerPool.length>0){
    for(const w of workerPool){ try{ w.terminate(); }catch(e){} }
    workerPool = [];
  }
  if(workerBlobUrl){
    try{ URL.revokeObjectURL(workerBlobUrl); }catch(e){}
    workerBlobUrl = null;
  }
  workerBusy = false;
  const ind = document.getElementById('thinkingIndicator'); if(ind) ind.style.display = 'none';
}

/* ---------- CPU（Master並列／チェック対応／promote-toggle短絡） ---------- */
async function cpuTakeTurn(pl){
  if(pl !== currentPlayer) return;
  if(cpuLevel === 'master'){
    await cpuMasterParallel(pl);
    return;
  }
  cpuTakeTurnLegacy(pl);
}

/* 既存の簡易 CPU */
function cpuTakeTurnLegacy(pl){
  if(pl !== currentPlayer) return;
  const allMoves = getAllLegalMoves(pl);
  if(allMoves.length === 0){ endTurn(); return; }
  const captureMoves = allMoves.filter(m=> m.capture);
  if(captureMoves.length > 0){
    const chosen = captureMoves[Math.floor(Math.random()*captureMoves.length)];
    doMove(chosen.from.r, chosen.from.c, chosen.to.r, chosen.to.c);
    log(`CPU(P${pl+1}) が捕獲手を実行`);
    endTurn(); return;
  }
  const pick = allMoves[Math.floor(Math.random()*allMoves.length)];
  doMove(pick.from.r, pick.from.c, pick.to.r, pick.to.c);
  log(`CPU(P${pl+1}) がランダム手を実行`);
  endTurn();
}

/* Helper: getAllLegalMoves */
function getAllLegalMoves(pl){
  const res=[];
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const cell=board[r][c];
    if(cell && cell.owner===pl){
      const moves = legalMoves(r,c);
      moves.forEach(m=> res.push({ from:{r,c}, to:m, capture: !!board[m.r][m.c] }));
    }
  }
  return res;
}

/* Helper: clone board for simulation */
function cloneBoardForTest(){
  return board.map(row => row.map(cell => cell ? {...cell, noKingCaptureTurnByPlayer: {...(cell.noKingCaptureTurnByPlayer||{})}} : null));
}

/* Find promote-toggle-capture candidates (short-circuit heuristic) */
function findPromoteToggleCaptureCandidatesForPlayer(player) {
  const candidates = [];
  for(let r=0;r<ROWS;r++){
    for(let c=0;c<COLS;c++){
      const cell = board[r][c];
      if(!cell || cell.owner !== player) continue;
      const cloned = cloneBoardForTest();
      const clonedCell = cloned[r][c];
      if(!clonedCell) continue;
      clonedCell.promoted = !clonedCell.promoted;
      const moves = legalMovesForBoard(cloned, r, c);
      const captureTargets = [];
      for(const m of moves){
        const tcell = cloned[m.r][m.c];
        if(tcell && tcell.owner !== player){
          const base = CAPTURE_BASE[tcell.type] || 0;
          const bonus = tcell.promoted ? 3 : 0;
          const benefit = base + bonus;
          const originalMoves = legalMoves(r,c);
          const couldBefore = originalMoves.some(om=>om.r===m.r && om.c===m.c);
          if(!couldBefore){
            captureTargets.push({ r:m.r, c:m.c, targetType: tcell.type, benefit });
          }
        }
      }
      if(captureTargets.length > 0){
        candidates.push({
          from: { r, c },
          toggleToPromoted: !cell.promoted,
          captureTargets
        });
      }
    }
  }
  return candidates;
}

/* CPU Master 並列版（promote-toggle short-circuit を含む、worker再利用） */
async function cpuMasterParallel(pl){
  if(workerBusy) { log('ワーカーが既に思考中です'); return; }
  const workerCount = Math.max(1, Math.min(12, parseInt(document.getElementById('workerCountInput')?.value || '4',10)));
  ensureWorkers(workerCount);
  const itersTotal = Math.max(100, parseInt(document.getElementById('masterItersInput')?.value || '8000',10));
  const perWorker = Math.max(50, Math.floor(itersTotal / workerPool.length));

  // 1) 王手対応（既存）
  if(isPlayerInCheck(pl)){
    const evasions = generateCheckEvasions(pl);
    if(evasions.length > 0){
      log(`CPU(P${pl+1}) は王手を検出。回避手に限定して探索します`);
    }
  }

  // 2) promote-toggle-capture の短絡判定（MCTS 前）
  const toggleCandidates = findPromoteToggleCaptureCandidatesForPlayer(pl);
  if(toggleCandidates && toggleCandidates.length > 0){
    toggleCandidates.sort((a,b)=>{
      const aBest = Math.max(...a.captureTargets.map(t=>t.benefit));
      const bBest = Math.max(...b.captureTargets.map(t=>t.benefit));
      return bBest - aBest;
    });
    const best = toggleCandidates[0];
    const maxBenefit = Math.max(...best.captureTargets.map(t=>t.benefit));
    if(points[pl] >= 13 && maxBenefit >= 6){
      const fr = best.from;
      const piece = board[fr.r][fr.c];
      if(piece){
        const cloned = cloneBoardForTest();
        cloned[fr.r][fr.c].promoted = !cloned[fr.r][fr.c].promoted;
        const movesAfterToggle = legalMovesForBoard(cloned, fr.r, fr.c);
        let chosen = null; let bestB = -Infinity;
        for(const t of best.captureTargets){
          if(movesAfterToggle.some(m=>m.r===t.r && m.c===t.c)){
            if(t.benefit > bestB){ bestB = t.benefit; chosen = t; }
          }
        }
        if(chosen){
          points[pl] -= 13;
          piece.promoted = !piece.promoted;
          log(`CPU(P${pl+1}) が戦術的に成り/解除を実行（${coordLabel(fr.r,fr.c)} を ${piece.promoted ? '成り' : '解除'}、-13点）`);
          doMove(fr.r, fr.c, chosen.r, chosen.c);
          log(`CPU(P${pl+1}) が成り/解除後に ${coordLabel(chosen.r,chosen.c)} の駒を捕獲`);
          endTurn();
          return;
        }
      }
    }
  }

  // 3) MCTS dispatch using workerPool (reused)
  let allowedActions = null;
  if(isPlayerInCheck(pl)){
    const evasions = generateCheckEvasions(pl);
    if(evasions.length > 0){
      allowedActions = evasions;
    } else {
      allowedActions = null;
    }
  }

  const stateSnapshot = getCurrentGameStateSnapshot();
  const indicator = document.getElementById('thinkingIndicator'); if(indicator) indicator.style.display = 'block';
  workerBusy = true;

  const promises = workerPool.map((w, idx) => new Promise((resolve) => {
    const handler = (ev) => {
      const d = ev.data;
      if(d && d.status === 'ok'){ resolve({ workerIdx: idx, result: d.result }); }
      else { resolve({ workerIdx: idx, result: null, error: d && d.error }); }
      try{ w.removeEventListener('message', handler); }catch(e){}
    };
    w.addEventListener('message', handler);
    try{
      w.postMessage({ cmd: 'run', state: stateSnapshot, iters: perWorker, maxDepth: 24, allowedActions: allowedActions || null });
    }catch(err){
      resolve({ workerIdx: idx, result: null, error: String(err) });
    }
    // safety timeout per worker
    setTimeout(()=>{ resolve({ workerIdx: idx, result: null, timeout:true }); try{ w.removeEventListener('message', handler); }catch(e){} }, 20000);
  }));

  const results = await Promise.all(promises);
  indicator.style.display = 'none';
  workerBusy = false;

  const voteMap = new Map();
  for(const r of results){
    if(!r.result || !r.result.action) continue;
    const key = JSON.stringify(r.result.action);
    const item = voteMap.get(key) || { count:0, visits:0, action: r.result.action };
    item.count += 1;
    item.visits += (r.result.visits || 0);
    voteMap.set(key, item);
  }

  let best = null;
  for(const [k,v] of voteMap.entries()){
    if(!best || v.count > best.count || (v.count === best.count && v.visits > best.visits)){
      best = { key:k, ...v };
    }
  }

  if(!best){
    log('並列 MCTS で有効な手が得られなかったためフォールバック');
    const moves = getAllLegalMoves(pl);
    if(moves.length === 0){ endTurn(); return; }
    const fallback = moves[Math.floor(Math.random()*moves.length)];
    doMove(fallback.from.r, fallback.from.c, fallback.to.r, fallback.to.c);
    endTurn(); return;
  }

  const action = best.action;
  if(action.type === 'move'){
    doMove(action.from.r, action.from.c, action.to.r, action.to.c);
    log(`CPU(Master parallel) が移動: ${coordLabel(action.from.r,action.from.c)} -> ${coordLabel(action.to.r,action.to.c)} （票 ${best.count}）`);
    endTurn(); return;
  } else if(action.type === 'promote'){
    pendingSpecial = null;
    selectedTarget = { r: action.target.r, c: action.target.c };
    if(points[pl] >= 13){
      points[pl] -= 13;
      const cell = board[selectedTarget.r][selectedTarget.c];
      if(cell){ cell.promoted = !cell.promoted; log(`CPU(P${pl+1}) が MCTS で成り/解除を実行: ${coordLabel(selectedTarget.r,selectedTarget.c)}`); }
      renderBoard();
    }
    endTurn(); return;
  } else if(action.type === 'destroy'){
    if(points[pl] >= 30){
      points[pl] -= 30;
      const t = action.target;
      if(board[t.r][t.c] && board[t.r][t.c].type !== 'king'){
        board[t.r][t.c] = null;
        addTrail(t.r,t.c,pl);
        log(`CPU(Master) が指定破壊を実行: ${coordLabel(t.r,t.c)} （票 ${best.count}）`);
      }
      renderBoard();
    }
    endTurn(); return;
  } else if(action.type === 'steal'){
    if(points[pl] >= 16){
      points[pl] -= 16;
      const t = action.target;
      const cell = board[t.r][t.c];
      if(cell && cell.owner !== pl && cell.type !== 'king' && !cell.promoted){
        if(Math.random() < 1/3){
          cell.owner = pl;
          if(!cell.noKingCaptureTurnByPlayer) cell.noKingCaptureTurnByPlayer = {};
          cell.noKingCaptureTurnByPlayer[pl] = turnIndex;
          log(`CPU(Master) の奪取成功: ${coordLabel(t.r,t.c)} （票 ${best.count}）`);
        } else {
          points[1-pl] += 16;
          log(`CPU(Master) の奪取失敗：相手に +16点を与えた`);
        }
      }
      renderBoard();
    }
    endTurn(); return;
  } else if(action.type === 'twowalk'){
    if(points[pl] >= 25){ points[pl] -= 25; twoStepCols[pl].add(action.col); log(`CPU(Master) が二歩列: 列 ${String.fromCharCode(65+action.col)} （票 ${best.count}）`); renderBoard(); }
    endTurn(); return;
  } else if(action.type === 'placeReserve'){
    if(points[pl] >= 6 && reserves[pl].length > 0){
      const found = action.to;
      if(!board[found.r][found.c]){ const rp = reserves[pl].shift(); board[found.r][found.c] = {type: rp.type, owner:pl, promoted: rp.promoted, noKingCaptureTurnByPlayer:{}}; points[pl]-=6; addTrail(found.r,found.c,pl); log(`CPU(Master) が保留駒を配置 （票 ${best.count}）`); renderBoard(); }
    }
    endTurn(); return;
  } else if(action.type === 'drain'){
    if(points[pl] >= 5){
      points[pl] -= 5;
      const opp = 1-pl;
      const before = points[opp];
      points[opp] = Math.max(0, points[opp] - 3);
      log(`CPU(Master) がドレインを実行: ${before} → ${points[opp]} （票 ${best.count}）`);
      renderBoard();
    }
    endTurn(); return;
  } else {
    endTurn(); return;
  }
}

/* ---------- getCurrentGameStateSnapshot ---------- */
function getCurrentGameStateSnapshot(){
  return {
    board: board.map(row => row.map(cell => cell ? {...cell, noKingCaptureTurnByPlayer: {...(cell.noKingCaptureTurnByPlayer||{})}} : null)),
    points: [...points],
    reserves: reserves.map(arr => arr.map(x=> ({...x}))),
    twoStepCols: twoStepCols.map(s=> [...s]),
    currentPlayer,
    turnIndex
  };
}

/* ---------- 使えるユーティリティ ---------- */
function generateCheckEvasions(player){
  const evasions = [];
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
    const cell = board[r][c];
    if(!cell || cell.owner !== player) continue;
    const moves = legalMoves(r,c);
    for(const m of moves){
      const clone = board.map(row => row.map(cell => cell ? {...cell, noKingCaptureTurnByPlayer:{...cell.noKingCaptureTurnByPlayer}} : null));
      const moved = clone[r][c];
      clone[m.r][m.c] = moved;
      clone[r][c] = null;
      if(!isPlayerInCheck(player, clone)){
        evasions.push({ type:'move', from:{r,c}, to:{r:m.r, c:m.c} });
      }
    }
  }
  return evasions;
}

/* ---------- ユーザー操作・開始 ---------- */
function onStartGame(){
  const radios = document.getElementsByName('mode');
  for(const r of radios) if(r.checked){ gameMode = r.value; break; }
  cpuPlays = (gameMode === 'cpu_p1' ? 0 : gameMode === 'cpu_p2' ? 1 : null);
  const sel = document.getElementById('cpuLevelSelect'); cpuLevel = sel ? sel.value || 'master' : 'master';
  const workerCnt = parseInt(document.getElementById('workerCountInput')?.value || '4',10);
  ensureWorkers(Math.max(1, Math.min(12, workerCnt)));
  const autoCb = document.getElementById('autoFlipCheckbox'); autoFlipButtons = !!(autoCb && autoCb.checked);
  const mod = document.getElementById('startModal'); if(mod) mod.classList.add('hidden');
  resetGame();
}

/* ---------- Export / 開発用 ---------- */
window.resetGame = resetGame;

/* ---------- 最後に簡単な注意 ---------- */
// このファイルは Worker 再利用（ensureWorkers）と
// 自動反転 ON/OFF（startModal のチェックボックス）を実装しています。
// Worker の数や探索回数は環境に合わせて調整してください。
