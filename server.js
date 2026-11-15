const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");

const app = express();
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "256kb" }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const activeGames = new Map();
let matchQueue = [];
let roomCounter = 0;
const ALLOWED_TIME_CONTROLS = new Set([60, 180, 600, 1800]);
const RESULT_RETRY_MS = 5000;
const DISCONNECT_GRACE_MS = 30000;
const REQUEST_TIMEOUT_MS = 12000;

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";

if (!TELEGRAM_BOT_TOKEN || !SESSION_SECRET || SESSION_SECRET.length < 32 || !SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.warn("[ChessGram] Missing TELEGRAM_BOT_TOKEN, SESSION_SECRET, SUPABASE_URL or SUPABASE_SECRET_KEY");
}

const probe = new Chess();
for (const method of ["turn", "move", "fen", "game_over", "in_checkmate", "in_draw", "pgn"]) {
  if (typeof probe[method] !== "function") throw new Error("Unsupported chess.js API: missing " + method + "()");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifyTelegramInitData(initData) {
  if (!TELEGRAM_BOT_TOKEN || typeof initData !== "string" || !initData || initData.length > 16384) return null;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) return null;
  params.delete("hash");
  const checkString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => key + "=" + value).join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(TELEGRAM_BOT_TOKEN).digest();
  const calculated = crypto.createHmac("sha256", secretKey).update(checkString).digest("hex");
  if (!safeEqual(calculated, receivedHash.toLowerCase())) return null;

  const authDate = Number(params.get("auth_date"));
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(authDate) || authDate > now + 30 || now - authDate > 300) return null;
  try {
    const user = JSON.parse(params.get("user") || "null");
    if (!user || !Number.isSafeInteger(Number(user.id)) || Number(user.id) <= 0) return null;
    return user;
  } catch (_) { return null; }
}

function signSession(user) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: String(user.id), username: user.username || "", firstName: user.first_name || "", lastName: user.last_name || "", photoUrl: user.photo_url || null, iat: now, exp: now + 3600 };
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const input = header + "." + body;
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(input).digest("base64url");
  return input + "." + signature;
}

function verifySession(token) {
  if (!SESSION_SECRET || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const input = parts[0] + "." + parts[1];
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(input).digest("base64url");
  if (!safeEqual(expected, parts[2])) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!payload.sub || !/^\d+$/.test(payload.sub) || !Number.isSafeInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (_) { return null; }
}

async function supabaseRequest(path, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error("Supabase server credentials are not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
      ...options,
      signal: controller.signal,
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    const body = await response.text();
    if (!response.ok) throw new Error("Supabase HTTP " + response.status + ": " + body.slice(0, 400));
    return body ? JSON.parse(body) : null;
  } finally { clearTimeout(timer); }
}

async function upsertPlayer(user) {
  const row = {
    id: String(user.id),
    first_name: String(user.first_name || "").slice(0, 80) || null,
    last_name: String(user.last_name || "").slice(0, 80) || null,
    username: String(user.username || "").slice(0, 80) || null,
    photo_url: typeof user.photo_url === "string" && /^https:\/\//i.test(user.photo_url) ? user.photo_url.slice(0, 2048) : null,
    updated_at: new Date().toISOString()
  };
  await supabaseRequest("players?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(row)
  });
}

function bearerUser(req) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? verifySession(match[1]) : null;
}

app.post("/auth/telegram", async (req, res) => {
  try {
    const user = verifyTelegramInitData(req.body && req.body.initData);
    if (!user) return res.status(401).json({ ok: false, error: "Invalid or expired Telegram authentication" });
    await upsertPlayer(user);
    return res.json({
      ok: true,
      sessionToken: signSession(user),
      expiresIn: 3600,
      telegramId: String(user.id),
      username: user.username || "",
      firstName: user.first_name || "",
      lastName: user.last_name || "",
      photoUrl: user.photo_url || null
    });
  } catch (error) {
    console.error("[auth] failed:", error.message);
    return res.status(503).json({ ok: false, error: "Authentication service temporarily unavailable" });
  }
});

app.get("/api/me", async (req, res) => {
  const user = bearerUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  try {
    const rows = await supabaseRequest("players?select=id,first_name,last_name,username,photo_url,games_played,wins,losses,draws&id=eq." + encodeURIComponent(user.sub) + "&limit=1");
    res.json({ player: rows && rows[0] || null });
  } catch (error) { res.status(503).json({ error: "Could not load player profile" }); }
});

app.get("/api/matches", async (req, res) => {
  const user = bearerUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  try {
    const id = encodeURIComponent(user.sub);
    const rows = await supabaseRequest("matches?select=id,room_id,white_player_id,black_player_id,result,pgn,time_control,created_at,finished_at,finish_reason,duration_seconds,opponent_type,opponent_name&or=(white_player_id.eq." + id + ",black_player_id.eq." + id + ")&order=created_at.desc&limit=50");
    res.json({ matches: rows || [] });
  } catch (error) { res.status(503).json({ error: "Could not load match history" }); }
});

app.post("/api/bot-matches", async (req, res) => {
  const user = bearerUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const body = req.body || {};
  const playerColor = body.playerColor;
  const result = body.result;
  const timeControl = Number(body.timeControl);
  const moves = Array.isArray(body.moves) ? body.moves.slice(0, 500) : [];
  const pgn = typeof body.pgn === "string" ? body.pgn.slice(0, 200000) : "";
  const opponentName = typeof body.opponentName === "string" ? body.opponentName.slice(0, 80) : "Stockfish";
  const durationSeconds = Number(body.durationSeconds);
  if (!["white", "black"].includes(playerColor) || !["white", "black", "draw"].includes(result) ||
      !ALLOWED_TIME_CONTROLS.has(timeControl) || !Number.isFinite(durationSeconds) ||
      durationSeconds < 0 || durationSeconds > 86400) {
    return res.status(400).json({ error: "Invalid bot match data" });
  }
  try {
    const roomId = "bot_" + crypto.randomUUID();
    const saved = await supabaseRequest("rpc/finalize_chess_bot_match", {
      method: "POST",
      body: JSON.stringify({
        p_room_id: roomId,
        p_player_id: user.sub,
        p_player_color: playerColor,
        p_result: result,
        p_pgn: pgn,
        p_time_control: timeControl,
        p_moves: moves,
        p_opponent_name: opponentName,
        p_duration_seconds: Math.floor(durationSeconds)
      })
    });
    return res.json({ ok: true, saved: saved !== false, roomId });
  } catch (error) {
    console.error("[ChessGram] Bot match persistence failed:", error.message);
    return res.status(503).json({ error: "Could not save bot match" });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "ChessGram PvP" }));

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const user = verifySession(token);
  if (!user) return next(new Error("Unauthorized"));
  socket.data.player = user;
  next();
});

function clearDisconnectTimer(room) {
  if (room.disconnectTimer) { clearTimeout(room.disconnectTimer); room.disconnectTimer = null; }
}
function sendRoom(room, event, payload) { io.to(room.id).emit(event, payload); }

function finishGame(room, result, reason) {
  if (room.finished || !["white", "black", "draw"].includes(result)) return;
  room.finished = true;
  room.pendingResult = result;
  room.finishReason = reason;
  room.finishedAt = Date.now();
  clearDisconnectTimer(room);
  sendRoom(room, "gameFinished", { roomId: room.id, result, reason });
  void persistFinishedGame(room);
}

function schedulePersistenceRetry(room) {
  if (room.retryTimer || room.resultSaved) return;
  room.retryTimer = setTimeout(() => { room.retryTimer = null; void persistFinishedGame(room); }, RESULT_RETRY_MS);
}

async function persistFinishedGame(room) {
  if (!room.finished || room.resultSaved || room.savingResult) return;
  room.savingResult = true;
  try {
    const whiteId = room.whitePlayerId;
    const blackId = room.blackPlayerId;
    if (!whiteId || !blackId) throw new Error("Both player identities are required to persist a PvP match");
    const durationSeconds = Math.max(0, Math.floor(((room.finishedAt || Date.now()) - room.startedAt) / 1000));
    const rpcBody = {
      p_room_id: room.id,
      p_white_player_id: String(whiteId),
      p_black_player_id: String(blackId),
      p_result: room.pendingResult,
      p_pgn: room.game.pgn(),
      p_time_control: room.timeControl,
      p_moves: room.moveHistory,
      p_finish_reason: room.finishReason || "completed",
      p_started_at: new Date(room.startedAt).toISOString(),
      p_duration_seconds: durationSeconds
    };
    const result = await supabaseRequest("rpc/finalize_chess_match", { method: "POST", body: JSON.stringify(rpcBody) });
    room.resultSaved = true;
    if (room.retryTimer) clearTimeout(room.retryTimer);
    sendRoom(room, "matchSaved", { roomId: room.id, alreadySaved: result === false });
    activeGames.delete(room.id);
  } catch (error) {
    console.error("[ChessGram] Match persistence failed:", room.id, error.message);
    sendRoom(room, "matchSavePending", { roomId: room.id });
    schedulePersistenceRetry(room);
  } finally { room.savingResult = false; }
}

function createRoom(white, black, timeControl, isPrivate = false) {
  const roomId = "cg_" + crypto.randomBytes(9).toString("hex");
  const initialTimeMs = timeControl * 1000;
  const room = {
    id: roomId, game: new Chess(),
    whitePlayerId: white.telegramId, blackPlayerId: black.telegramId || null,
    white: white.telegramId, black: black.telegramId || null,
    whiteName: white.tgName || "Player", blackName: black.tgName || "Player",
    whitePhoto: white.tgPhoto || null, blackPhoto: black.tgPhoto || null,
    whiteSocket: white.socketId, blackSocket: black.socketId,
    whiteResumeToken: crypto.randomBytes(32).toString("hex"),
    blackResumeToken: crypto.randomBytes(32).toString("hex"),
    timeControl, isPrivate, startedAt: Date.now(),
    clocks: { white: initialTimeMs, black: initialTimeMs, lastMoveTimestamp: Date.now() },
    moveHistory: [], finished: false, resultSaved: false, savingResult: false,
    pendingResult: null, finishReason: null, disconnectTimer: null, retryTimer: null
  };
  activeGames.set(roomId, room);
  return room;
}

function publicProfile(_payload, auth) {
  const name = [auth.firstName, auth.lastName].filter(Boolean).join(" ").trim();
  return {
    telegramId: auth.sub,
    socketId: null,
    tgName: name || (auth.username ? "@" + auth.username : "Player"),
    tgPhoto: typeof auth.photoUrl === "string" && /^https:\/\//i.test(auth.photoUrl) ? auth.photoUrl : null
  };
}

io.on("connection", (socket) => {
  const auth = socket.data.player;
  socket.on("findMatch", (payload = {}) => {
    const timeControl = Number(payload.timeControl);
    if (!ALLOWED_TIME_CONTROLS.has(timeControl)) return socket.emit("moveError", { message: "Invalid time control" });
    const current = publicProfile(payload, auth);
    current.socketId = socket.id;
    matchQueue = matchQueue.filter(p => p.socketId !== socket.id && p.telegramId !== auth.sub);
    const index = matchQueue.findIndex(p => p.timeControl === timeControl && p.telegramId !== auth.sub);
    if (index === -1) {
      matchQueue.push({ ...current, timeControl });
      socket.emit("waitingForOpponent");
      return;
    }
    const opponent = matchQueue.splice(index, 1)[0];
    const firstWhite = Math.random() < 0.5;
    const white = firstWhite ? opponent : current;
    const black = firstWhite ? current : opponent;
    const room = createRoom(white, black, timeControl);
    const whiteSocket = io.sockets.sockets.get(white.socketId);
    const blackSocket = io.sockets.sockets.get(black.socketId);
    if (!whiteSocket || !blackSocket) { activeGames.delete(room.id); return socket.emit("moveError", { message: "Opponent disconnected" }); }
    whiteSocket.join(room.id); blackSocket.join(room.id);
    whiteSocket.emit("matchFound", { roomId: room.id, color: "white", opponentTelegramId: black.telegramId, opponentName: black.tgName, opponentPhoto: black.tgPhoto, timeControl, resumeToken: room.whiteResumeToken });
    blackSocket.emit("matchFound", { roomId: room.id, color: "black", opponentTelegramId: white.telegramId, opponentName: white.tgName, opponentPhoto: white.tgPhoto, timeControl, resumeToken: room.blackResumeToken });
    sendRoom(room, "gameState", { fen: room.game.fen(), clocks: room.clocks });
  });

  socket.on("cancelFindMatch", () => {
    matchQueue = matchQueue.filter(p => p.socketId !== socket.id);
    socket.emit("matchSearchCancelled");
  });

  socket.on("createPrivateRoom", (payload = {}) => {
    const timeControl = Number(payload.timeControl);
    if (!ALLOWED_TIME_CONTROLS.has(timeControl)) return socket.emit("privateRoomError", { message: "Invalid time control" });
    matchQueue = matchQueue.filter(p => p.socketId !== socket.id);
    const creator = publicProfile(payload, auth);
    creator.socketId = socket.id;
    const room = createRoom(creator, { telegramId: null, socketId: null }, timeControl, true);
    socket.join(room.id);
    socket.emit("privateRoomCreated", { roomId: room.id, timeControl });
  });

  socket.on("joinPrivateRoom", (payload = {}) => {
    const room = typeof payload.roomId === "string" ? activeGames.get(payload.roomId) : null;
    if (!room || !room.isPrivate) return socket.emit("privateRoomError", { message: "Invite not found or expired" });
    if (room.blackSocket !== null) return socket.emit("privateRoomError", { message: "Room is full" });
    if (room.whitePlayerId === auth.sub) return socket.emit("privateRoomError", { message: "You cannot join your own invite" });
    const whiteSocket = io.sockets.sockets.get(room.whiteSocket);
    if (!whiteSocket) { activeGames.delete(room.id); return socket.emit("privateRoomError", { message: "Room creator disconnected" }); }
    const guest = publicProfile(payload, auth);
    room.blackSocket = socket.id;
    room.blackPlayerId = auth.sub;
    room.black = auth.sub;
    room.blackName = guest.tgName;
    room.blackPhoto = guest.tgPhoto;
    socket.join(room.id);
    whiteSocket.emit("matchFound", { roomId: room.id, color: "white", opponentTelegramId: auth.sub, opponentName: room.blackName, opponentPhoto: room.blackPhoto, timeControl: room.timeControl, resumeToken: room.whiteResumeToken });
    socket.emit("matchFound", { roomId: room.id, color: "black", opponentTelegramId: room.whitePlayerId, opponentName: room.whiteName, opponentPhoto: room.whitePhoto, timeControl: room.timeControl, resumeToken: room.blackResumeToken });
    sendRoom(room, "gameState", { fen: room.game.fen(), clocks: room.clocks });
  });

  socket.on("resumeGame", (payload = {}) => {
    const room = activeGames.get(payload.roomId);
    if (!room || typeof payload.resumeToken !== "string") return socket.emit("resumeFailed", { message: "Game cannot be resumed" });
    let color = null;
    if (payload.resumeToken === room.whiteResumeToken && room.whitePlayerId === auth.sub) color = "white";
    if (payload.resumeToken === room.blackResumeToken && room.blackPlayerId === auth.sub) color = "black";
    if (!color || room.finished) return socket.emit("resumeFailed", { message: "Invalid or expired resume token" });
    clearDisconnectTimer(room);
    if (color === "white") room.whiteSocket = socket.id; else room.blackSocket = socket.id;
    socket.join(room.id);
    const opponentSocket = color === "white" ? room.blackSocket : room.whiteSocket;
    if (opponentSocket) io.to(opponentSocket).emit("opponentReconnected", { roomId: room.id });
    socket.emit("gameResumed", { roomId: room.id, color, fen: room.game.fen(), clocks: room.clocks, moveHistory: room.moveHistory });
  });

  socket.on("makeMove", (payload = {}) => {
    const room = activeGames.get(payload.roomId);
    if (!room || room.finished || room.game.game_over()) return socket.emit("moveError", { message: "Game has finished or not found" });
    const currentTurn = room.game.turn();
    const expectedSocket = currentTurn === "w" ? room.whiteSocket : room.blackSocket;
    if (socket.id !== expectedSocket) return socket.emit("moveError", { message: "Not your turn" });
    try {
      const now = Date.now();
      const spent = now - room.clocks.lastMoveTimestamp;
      const color = currentTurn === "w" ? "white" : "black";
      if (room.clocks[color] - spent <= 0) {
        room.clocks[color] = 0;
        const winner = color === "white" ? "black" : "white";
        sendRoom(room, "moveMade", { isGameOver: true, isCheckmate: false, isDraw: false, winner, reason: "timeout", clocks: room.clocks });
        finishGame(room, winner, "timeout");
        return;
      }
      const move = room.game.move({ from: payload.from, to: payload.to, promotion: payload.promotion || "q" });
      if (!move) return socket.emit("moveError", { message: "Illegal move" });
      room.clocks[color] -= spent;
      room.clocks.lastMoveTimestamp = now;
      room.moveHistory.push({ san: move.san, from: move.from, to: move.to, timeSpentMs: spent, timestamp: now, turn: currentTurn });
      const over = room.game.game_over();
      const mate = room.game.in_checkmate();
      const draw = room.game.in_draw();
      const winner = mate ? (room.game.turn() === "w" ? "black" : "white") : null;
      sendRoom(room, "moveMade", { from: move.from, to: move.to, san: move.san, fen: room.game.fen(), turn: room.game.turn(), clocks: room.clocks, isGameOver: over, isCheckmate: mate, isDraw: draw, winner });
      if (over) finishGame(room, mate ? winner : "draw", mate ? "checkmate" : "draw");
    } catch (error) { socket.emit("moveError", { message: error.message }); }
  });

  socket.on("disconnect", () => {
    matchQueue = matchQueue.filter(p => p.socketId !== socket.id);
    for (const room of activeGames.values()) {
      if (room.finished) continue;
      if (room.isPrivate && room.blackPlayerId === null && room.whiteSocket === socket.id) {
        activeGames.delete(room.id);
        continue;
      }
      const color = room.whiteSocket === socket.id ? "white" : room.blackSocket === socket.id ? "black" : null;
      if (!color) continue;
      clearDisconnectTimer(room);
      const opponentSocket = color === "white" ? room.blackSocket : room.whiteSocket;
      if (opponentSocket) io.to(opponentSocket).emit("opponentDisconnected", { roomId: room.id, message: "Opponent disconnected" });
      room.disconnectTimer = setTimeout(() => {
        room.disconnectTimer = null;
        const currentSocket = color === "white" ? room.whiteSocket : room.blackSocket;
        if (activeGames.get(room.id) !== room || room.finished || currentSocket !== socket.id) return;
        const winner = color === "white" ? "black" : "white";
        sendRoom(room, "opponentForfeit", { winner, reason: "disconnect_timeout" });
        finishGame(room, winner, "disconnect_timeout");
      }, DISCONNECT_GRACE_MS);
    }
  });
});

const PORT = Number(process.env.PORT || 7860);
server.listen(PORT, () => console.log("[ChessGram PvP] Listening on port " + PORT));
