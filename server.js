const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const activeGames = new Map();
let matchQueue = [];
let roomCounter = 0;

const RELAY_URL = (process.env.RELAY_URL || "").replace(/\/+$/, "");
const RELAY_API_SECRET = process.env.RELAY_API_SECRET;

const ALLOWED_TIME_CONTROLS = new Set([60, 300, 900, 1800]);
const RESULT_RETRY_MS = 5000;
const DISCONNECT_GRACE_MS = 30000;
const REQUEST_TIMEOUT_MS = 15000;

// Проверяем API chess.js
const probeGame = new Chess();
for (const method of ["turn", "move", "fen", "game_over", "in_checkmate", "in_draw"]) {
  if (typeof probeGame[method] !== "function") {
    throw new Error(`Unsupported chess.js API: missing ${method}()`);
  }
}

async function relayRequest(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${RELAY_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-relay-secret": RELAY_API_SECRET },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `Relay HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function createOnChainMatch(white, black, timeControl) {
  return relayRequest("/pvp/create-match", { whitePlayer: white, blackPlayer: black, timeControl });
}

async function submitOnChainResult(matchId, result) {
  return relayRequest("/pvp/submit-result", { matchId, result });
}

function clearDisconnectTimer(room) {
  if (room.disconnectTimer) { clearTimeout(room.disconnectTimer); room.disconnectTimer = null; }
}

function sendRoom(room, event, payload) { io.to(room.id).emit(event, payload); }

function finishGame(room, result, reason) {
  if (room.finished) return;
  if (!["white", "black", "draw"].includes(result)) return;

  room.finished = true;
  room.pendingResult = result;
  room.finishReason = reason;
  clearDisconnectTimer(room);

  sendRoom(room, "gameFinished", { result, reason, onChainStatus: room.onChainReady ? "pending" : "waiting_for_match" });
  void trySubmitResult(room);
}

function scheduleResultRetry(room) {
  if (room.retryTimer || room.resultSubmitted) return;
  room.retryTimer = setTimeout(() => { room.retryTimer = null; void trySubmitResult(room); }, RESULT_RETRY_MS);
}

async function trySubmitResult(room) {
  if (!room.finished || room.resultSubmitted) return;
  if (!room.onChainReady || room.onChainMatchId == null) return;
  if (room.submittingResult) return;

  room.submittingResult = true;
  try {
    const receipt = await submitOnChainResult(room.onChainMatchId, room.pendingResult);
    room.resultSubmitted = true;
    console.log(`[Chain] ${room.id}: result ${room.pendingResult} confirmed`, receipt.txHash || "");
    sendRoom(room, "onChainResultSaved", { roomId: room.id, matchId: room.onChainMatchId, result: room.pendingResult, txHash: receipt.txHash || null });
    
    clearDisconnectTimer(room);
    if (room.retryTimer) clearTimeout(room.retryTimer);
    activeGames.delete(room.id);
  } catch (error) {
    console.error(`[Chain] Result submission failed for ${room.id}:`, error.message);
    sendRoom(room, "onChainResultPending", { roomId: room.id, matchId: room.onChainMatchId, result: room.pendingResult });
    scheduleResultRetry(room);
  } finally {
    room.submittingResult = false;
  }
}

function startOnChainCreation(room) {
  void (async () => {
    try {
      const data = await createOnChainMatch(room.white, room.black, room.timeControl);
      room.onChainMatchId = String(data.matchId);
      room.onChainReady = true;
      console.log(`[Chain] ${room.id} -> match ${room.onChainMatchId}`);

      // Отправляем matchId клиентам
      sendRoom(room, "onChainMatchCreated", { matchId: room.onChainMatchId });

      if (room.finished) {
        await trySubmitResult(room);
      }
    } catch (error) {
      room.onChainCreationFailed = true;
      console.error(`[Chain] Could not create match for ${room.id}:`, error.message);
      sendRoom(room, "onChainCreationFailed", { roomId: room.id, message: "Could not confirm on-chain match creation" });
    }
  })();
}
function createRoom(white, black, timeControl) {
  const roomId = `room_${++roomCounter}`;
  const initialTimeMs = timeControl * 1000;
  const room = {
    id: roomId, game: new Chess(),
    white: white.userAddress, black: black.userAddress,
    whiteSocket: white.socketId, blackSocket: black.socketId,
    whiteResumeToken: crypto.randomBytes(32).toString("hex"),
    blackResumeToken: crypto.randomBytes(32).toString("hex"),
    timeControl,
    clocks: { white: initialTimeMs, black: initialTimeMs, lastMoveTimestamp: Date.now() },
    moveHistory: [],
    onChainMatchId: null, onChainReady: false, onChainCreationFailed: false,
    pendingResult: null, resultSubmitted: false, submittingResult: false,
    finished: false, finishReason: null, disconnectTimer: null, retryTimer: null
  };
  activeGames.set(roomId, room);
  return room;
}

io.on("connection", (socket) => {
  socket.on("findMatch", (payload = {}) => {
    const { userAddress } = payload;
    const timeControl = Number(payload.timeControl);
    if (!/^0x[a-fA-F0-9]{40}$/.test(userAddress)) return socket.emit("moveError", { message: "Invalid address" });
    if (!ALLOWED_TIME_CONTROLS.has(timeControl)) return socket.emit("moveError", { message: "Invalid timeControl" });

    const normalized = userAddress.toLowerCase();
    matchQueue = matchQueue.filter(p => p.socketId !== socket.id && p.userAddress.toLowerCase() !== normalized);

    const opponentIndex = matchQueue.findIndex(p => p.timeControl === timeControl && p.userAddress.toLowerCase() !== normalized);
    if (opponentIndex === -1) {
      matchQueue.push({ socketId: socket.id, userAddress, timeControl });
      socket.emit("waitingForOpponent");
      return;
    }

    const opponent = matchQueue.splice(opponentIndex, 1)[0];
    const current = { socketId: socket.id, userAddress };
    const firstIsWhite = Math.random() < 0.5;
    const white = firstIsWhite ? opponent : current;
    const black = firstIsWhite ? current : opponent;
    const room = createRoom(white, black, timeControl);
    
    const whiteSocket = io.sockets.sockets.get(white.socketId);
    const blackSocket = io.sockets.sockets.get(black.socketId);
    if (!whiteSocket || !blackSocket) { activeGames.delete(room.id); return socket.emit("moveError", { message: "Disconnected" }); }
    
    whiteSocket.join(room.id); blackSocket.join(room.id);
    
    whiteSocket.emit("matchFound", { roomId: room.id, color: "white", opponentAddress: room.black, timeControl, resumeToken: room.whiteResumeToken });
    blackSocket.emit("matchFound", { roomId: room.id, color: "black", opponentAddress: room.white, timeControl, resumeToken: room.blackResumeToken });
    
    sendRoom(room, "gameState", { fen: room.game.fen(), clocks: room.clocks });
    startOnChainCreation(room);
  });

  socket.on("resumeGame", (payload = {}) => {
    const { roomId, resumeToken } = payload;
    const room = activeGames.get(roomId);
    if (!room || typeof resumeToken !== "string") return socket.emit("resumeFailed", { message: "Game cannot be resumed" });

    let color = null;
    if (resumeToken === room.whiteResumeToken) color = "white";
    if (resumeToken === room.blackResumeToken) color = "black";
    if (!color) return socket.emit("resumeFailed", { message: "Invalid token" });
    if (room.finished) return socket.emit("resumeFailed", { message: "Game finished" });

    clearDisconnectTimer(room);
    if (color === "white") room.whiteSocket = socket.id; else room.blackSocket = socket.id;
    socket.join(room.id);
    io.to(color === "white" ? room.blackSocket : room.whiteSocket).emit("opponentReconnected", { roomId: room.id });
    socket.emit("gameResumed", { roomId: room.id, color, fen: room.game.fen(), clocks: room.clocks, moveHistory: room.moveHistory, onChainMatchId: room.onChainMatchId });
  });

  socket.on("makeMove", (payload = {}) => {
    const { roomId, from, to, promotion } = payload;
    const room = activeGames.get(roomId);
    if (!room || room.finished || room.game.game_over()) return socket.emit("moveError", { message: "Game has finished or not found" });

    const currentTurn = room.game.turn();
    const expectedSocket = currentTurn === "w" ? room.whiteSocket : room.blackSocket;
    if (socket.id !== expectedSocket) return socket.emit("moveError", { message: "Not your turn" });

    try {
      const now = Date.now();
      const timeSpent = now - room.clocks.lastMoveTimestamp;
      const playerColor = currentTurn === "w" ? "white" : "black";

      if (room.clocks[playerColor] - timeSpent <= 0) {
        const winner = playerColor === "white" ? "black" : "white";
        room.clocks[playerColor] = 0;
        sendRoom(room, "moveMade", { isGameOver: true, isCheckmate: false, isDraw: false, winner, reason: "timeout", clocks: room.clocks });
        finishGame(room, winner, "timeout");
        return;
      }

      const move = room.game.move({ from, to, promotion: promotion || "q" });
      if (!move) return socket.emit("moveError", { message: "Illegal move" });
      
      room.clocks[playerColor] -= timeSpent;
      room.clocks.lastMoveTimestamp = now;
      room.moveHistory.push({ san: move.san, from: move.from, to: move.to, timeSpentMs: timeSpent, timestamp: now, turn: currentTurn });

      const isGameOver = room.game.game_over();
      const isCheckmate = room.game.in_checkmate();
      const isDraw = room.game.in_draw();
      const winner = isCheckmate ? (room.game.turn() === "w" ? "black" : "white") : null;

      sendRoom(room, "moveMade", { from: move.from, to: move.to, san: move.san, fen: room.game.fen(), turn: room.game.turn(), clocks: room.clocks, isGameOver, isCheckmate, isDraw, winner });

      if (isGameOver) finishGame(room, isCheckmate ? winner : "draw", isCheckmate ? "checkmate" : "draw");
    } catch (error) {
      socket.emit("moveError", { message: error.message });
    }
  });

  socket.on("disconnect", () => {
    matchQueue = matchQueue.filter(p => p.socketId !== socket.id);
    for (const room of activeGames.values()) {
      if (room.finished) continue;
      const color = room.whiteSocket === socket.id ? "white" : (room.blackSocket === socket.id ? "black" : null);
      if (!color) continue;

      clearDisconnectTimer(room);
      const opponentSocket = color === "white" ? room.blackSocket : room.whiteSocket;
      io.to(opponentSocket).emit("opponentDisconnected", { roomId: room.id, message: "Opponent disconnected." });

      const disconnectedSocketId = socket.id;
      room.disconnectTimer = setTimeout(() => {
        room.disconnectTimer = null;
        const currentSocket = color === "white" ? room.whiteSocket : room.blackSocket;
        if (activeGames.get(room.id) !== room || room.finished || currentSocket !== disconnectedSocketId) return;
        const winner = color === "white" ? "black" : "white";
        sendRoom(room, "opponentForfeit", { winner, reason: "disconnect_timeout" });
        finishGame(room, winner, "disconnect_timeout");
      }, DISCONNECT_GRACE_MS);
    }
  });
});

const PORT = Number(process.env.PORT || 7860);
server.listen(PORT, () => {
  console.log(`[Chess server] Listening on port ${PORT}`);
});
