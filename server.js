// LitVM Chess — WebSocket Server v2 (Matchmaking + PvP)

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Хранилище активных игр: matchId → { game, white, black }
const activeGames = new Map();

// Очередь игроков, ожидающих соперника: [{ socketId, userAddress, timeControl }]
let matchQueue = [];

// Счётчик комнат
let roomCounter = 0;
// ===== АНТИЧИТ: ФОНОВЫЙ АНАЛИЗ ПАРТИИ =====

async function analyzeForFairPlay(room) {
    const roomId = room.id || "unknown";
    console.log(`[Anti-Cheat] Starting analysis for room ${roomId}...`);

    if (!room.moveHistory || room.moveHistory.length < 6) {
        console.log(`[Anti-Cheat] Room ${roomId} has too few moves to analyze.`);
        return;
    }

    let engine = null;
    try {
        const { Stockfish } = require("@se-oss/stockfish");
        engine = new Stockfish();
        await engine.waitReady();

                // Берём только первые 20 полуходов (10 ходов каждого) — дебют + миттельшпиль
        const movesToAnalyze = room.moveHistory.slice(0, 20);

        // Собираем FEN всех позиций (только первые 20)
        const tempGame = new Chess();
        const fens = [tempGame.fen()];
        for (const h of movesToAnalyze) {
            tempGame.move(h.san || h);
            fens.push(tempGame.fen());
        }

                       // Оцениваем каждую позицию 1 раз + собираем top-1 ходы
        const evals = [];
        const bestMoves = [];   // bestMove для каждой позиции (UCI)
        for (const fen of fens) {
            const analysis = await engine.analyze(fen, 12);
            const score = analysis.lines[0].score;
            let cp = 0;
            if (score.type === "cp") {
                cp = score.value;
            } else if (score.type === "mate") {
                cp = score.value > 0 ? 1000 : -1000;
            }
            cp = Math.max(-1000, Math.min(1000, cp));
            evals.push(cp);
            bestMoves.push(analysis.bestmove || "");   // ← UCI-ход
        }

                                // ACPL + Engine Match Rate (только первые 20 полуходов)
        const acpl = { white: [], black: [] };
        let whiteTop1 = 0, blackTop1 = 0;
        let whiteTotal = 0, blackTotal = 0;

        // Проигрываем партию заново, чтобы получить UCI каждого хода
        const replay = new Chess();
        for (let i = 0; i < movesToAnalyze.length; i++) {
            const isWhite = (i % 2 === 0);
            const evalBefore = evals[i];
            const evalAfter = evals[i + 1];

            let loss = 0;
            if (isWhite) loss = evalBefore - evalAfter;
            else loss = evalAfter - evalBefore;

            if (Math.abs(evalBefore) < 700) {
                const singleMoveLoss = Math.max(0, loss);
                acpl[isWhite ? "white" : "black"].push(Math.min(300, singleMoveLoss));
            }

                        // UCI сделанного хода — надёжное восстановление
            let playedUci = "";
            try {
                const rawMove = movesToAnalyze[i];
                const moveObj = typeof rawMove === "object" ? (rawMove.san || rawMove) : rawMove;
                const mv = replay.move(moveObj);
                if (mv) {
                    playedUci = mv.from + mv.to + (mv.promotion || "");
                }
            } catch (e) {
                console.error(`[Anti-Cheat] Move replay error at index ${i}:`, e);
            }

            if (isWhite) {
                whiteTotal++;
                if (playedUci && bestMoves[i] && playedUci === bestMoves[i]) whiteTop1++;
            } else {
                blackTotal++;
                if (playedUci && bestMoves[i] && playedUci === bestMoves[i]) blackTop1++;
            }
        }

        const whiteMatchRate = whiteTotal > 0 ? (whiteTop1 / whiteTotal) * 100 : 0;
        const blackMatchRate = blackTotal > 0 ? (blackTop1 / blackTotal) * 100 : 0;

        const avg = (arr) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
        const whiteACPL = avg(acpl.white);
        const blackACPL = avg(acpl.black);

        // Дисперсия времени
        const times = room.moveHistory.map(m => m.timeSpentMs).filter(t => typeof t === "number" && t < 60000);
        const avgTime = avg(times);
        const variance = times.length > 0
            ? times.reduce((a, b) => a + Math.pow(b - avgTime, 2), 0) / times.length
            : 0;
        const stdDev = Math.sqrt(variance);

                // Тайминг подозрителен, если сыграно ≥8 ходов и разброс времени очень маленький (бот)
                        const timingSuspicious = times.length >= 8 && stdDev < 500;

        // Калибровка (Gemini):
        // 1. Match Rate >= 65% — очевидный читер
        // 2. Match Rate >= 50% + ACPL < 40 — подозрительный (подсказки)
        // 3. ACPL < 10 — супер-бот
        // 4. ACPL < 20 + timing — стабильный бот
        const whiteFlagged = whiteTotal >= 6 && (
            whiteMatchRate >= 65 ||
            (whiteMatchRate >= 50 && whiteACPL < 40) ||
            whiteACPL < 10 ||
            (whiteACPL < 20 && timingSuspicious)
        );

        const blackFlagged = blackTotal >= 6 && (
            blackMatchRate >= 65 ||
            (blackMatchRate >= 50 && blackACPL < 40) ||
            blackACPL < 10 ||
            (blackACPL < 20 && timingSuspicious)
        );

        const result = {
            white: { acpl: whiteACPL.toFixed(1), matchRate: `${whiteMatchRate.toFixed(1)}%`, flagged: whiteFlagged },
            black: { acpl: blackACPL.toFixed(1), matchRate: `${blackMatchRate.toFixed(1)}%`, flagged: blackFlagged },
            avgTimeMs: avgTime.toFixed(0),
            stdDevMs: stdDev.toFixed(0)
        };

                if (whiteFlagged || blackFlagged) {
                        console.warn(`[Anti-Cheat] ⚠️ SUSPICIOUS GAME DETECTED: room ${roomId}`, {
                white: { acpl: whiteACPL.toFixed(1), matchRate: whiteMatchRate.toFixed(1) + "%", flagged: whiteFlagged },
                black: { acpl: blackACPL.toFixed(1), matchRate: blackMatchRate.toFixed(1) + "%", flagged: blackFlagged },
                avgTimeMs: avgTime.toFixed(0),
                stdDevMs: stdDev.toFixed(0)
            });

            // Telegram alert
            const alertText =
`⚠️ <b>SUSPICIOUS GAME</b>

<b>Room:</b> ${roomId}
<b>White:</b> ACPL ${whiteACPL.toFixed(1)} ${whiteFlagged ? "🚩" : ""}
<b>Black:</b> ACPL ${blackACPL.toFixed(1)} ${blackFlagged ? "🚩" : ""}
<b>Avg time:</b> ${avgTime.toFixed(0)} ms
<b>StdDev:</b> ${stdDev.toFixed(0)} ms`;
            sendTelegramAlert(alertText);   // без await — фон
        } else {
                        console.log(`[Anti-Cheat] ✅ Room ${roomId} passed fair play check`, {
                whiteACPL: whiteACPL.toFixed(1),
                blackACPL: blackACPL.toFixed(1),
                whiteMatchRate: whiteMatchRate.toFixed(1) + "%",
                blackMatchRate: blackMatchRate.toFixed(1) + "%",
                avgTimeMs: avgTime.toFixed(0),
                stdDevMs: stdDev.toFixed(0)
            });
        }
    } catch (err) {
        console.error(`[Anti-Cheat] Error analyzing room ${roomId}:`, err);
    } finally {
        try { if (engine && engine.quit) await engine.quit(); } catch (e) {}
    }
}
// ===== TELEGRAM ALERT =====
async function sendTelegramAlert(text) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
        console.log("[Telegram] Skipped — no token/chatId");
        return;
    }

    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: "HTML"
            })
        });
        const data = await res.json();
        if (!data.ok) {
            console.error("[Telegram] API error:", data);
        } else {
            console.log("[Telegram] Alert sent");
        }
    } catch (err) {
        console.error("[Telegram] Network error:", err);
    }
}

app.get("/", (req, res) => {
    res.send("LitVM Chess WebSocket Server v2 is running");
});

io.on("connection", (socket) => {
    console.log("Player connected:", socket.id);

    // ===== МАТЧМЕЙКИНГ =====
        socket.on("findMatch", ({ userAddress, timeControl, lichessUsername, lichessElo }) => {
        console.log(`Find match: ${userAddress}, time: ${timeControl}`);

        // ← НОВОЕ: убираем прошлые записи этого же адреса (защита от двух вкладок)
        matchQueue = matchQueue.filter(
            (p) => p.userAddress.toLowerCase() !== userAddress.toLowerCase()
        );

        // Ищем соперника в очереди с тем же контролем времени
        // Сравнение адресов регистронезависимое — MetaMask может вернуть разный регистр
        const opponentIndex = matchQueue.findIndex(
            (p) => p.timeControl === timeControl &&
                   p.userAddress.toLowerCase() !== userAddress.toLowerCase()
        );

        if (opponentIndex === -1) {
            // Соперника нет — ставим в очередь
            matchQueue.push({ socketId: socket.id, userAddress, timeControl, lichessUsername, lichessElo });
            socket.emit("waitingForOpponent");
            console.log(`Queued: ${userAddress}`);
        } else {
            // Соперник найден!
            const opponent = matchQueue.splice(opponentIndex, 1)[0];
            const roomId = "room_" + (++roomCounter);

            // Рандомно назначаем цвета
            const isFirstWhite = Math.random() < 0.5;
            const white = isFirstWhite ? opponent : { socketId: socket.id, userAddress };
            const black = isFirstWhite ? { socketId: socket.id, userAddress } : opponent;

            // Создаём игру
                        const initialTimeMs = timeControl * 1000;
            activeGames.set(roomId, {
                game: new Chess(),
                white: white.userAddress,
                black: black.userAddress,
                whiteSocket: white.socketId,
                blackSocket: black.socketId,
                timeControl: timeControl,
                clocks: {
                    white: initialTimeMs,
                    black: initialTimeMs,
                    lastMoveTimestamp: Date.now()
                },
                moveHistory: []
            });

            // Подключаем обоих в комнату
            io.sockets.sockets.get(opponent.socketId)?.join(roomId);
            io.sockets.sockets.get(socket.id)?.join(roomId);

            // Сообщаем обоим
                        io.to(opponent.socketId).emit("matchFound", {
                roomId: roomId,
                color: isFirstWhite ? "white" : "black",
                opponentAddress: userAddress,
                opponentLichess: lichessUsername || null,
                opponentElo: lichessElo || null,
                timeControl: timeControl
            });

            io.to(socket.id).emit("matchFound", {
                roomId: roomId,
                color: isFirstWhite ? "black" : "white",
                opponentAddress: opponent.userAddress,
                opponentLichess: opponent.lichessUsername || null,
                opponentElo: opponent.lichessElo || null,
                timeControl: timeControl
            });

            // ← НОВОЕ: стартовый FEN обоим — клиент синхронизируется до первого хода
            const startFen = activeGames.get(roomId).game.fen();
            io.to(opponent.socketId).emit("gameState", { fen: startFen });
            io.to(socket.id).emit("gameState", { fen: startFen });

            console.log(`Match created: ${roomId} (${white.userAddress} vs ${black.userAddress})`);
        }
    });

    // Отмена поиска
    socket.on("cancelFindMatch", () => {
        matchQueue = matchQueue.filter((p) => p.socketId !== socket.id);
        socket.emit("searchCancelled");
    });

    // ===== ИГРА =====
    socket.on("makeMove", ({ roomId, from, to, promotion }) => {
        const room = activeGames.get(roomId);
        if (!room) {
            socket.emit("moveError", { message: "Game not found" });
            return;
        }

        try {
            const now = Date.now();
            const timeSpent = now - room.clocks.lastMoveTimestamp;
            const currentTurn = room.game.turn();            // 'w' или 'b'
            const playerColor = currentTurn === 'w' ? 'white' : 'black';

            // 1. Проверяем таймаут: если игрок просрочил — победа соперника
            if (room.clocks[playerColor] - timeSpent <= 0) {
                const winner = playerColor === 'white' ? 'black' : 'white';
                io.to(roomId).emit("moveMade", {
                    from: null, to: null, san: null,
                    fen: room.game.fen(),
                    turn: room.game.turn(),
                    isGameOver: true,
                    isCheckmate: false,
                    isDraw: false,
                    winner: winner,
                    reason: "timeout"
                });
                activeGames.delete(roomId);
                console.log(`Room ${roomId} closed — ${winner} wins on time`);
                return;
            }

            // 2. Валидация хода через chess.js
            const move = room.game.move({ from, to, promotion: promotion || "q" });
            if (!move) {
                socket.emit("moveError", { message: "Illegal move" });
                return;
            }

            // 3. Списываем время с часов игрока
            room.clocks[playerColor] -= timeSpent;
            room.clocks.lastMoveTimestamp = now;

            // 4. Логируем для античита
            room.moveHistory.push({
                san: move.san,
                timeSpentMs: timeSpent,
                timestamp: now,
                turn: currentTurn
            });

            // 5. Рассылаем ход + актуальные часы
            io.to(roomId).emit("moveMade", {
                from: move.from,
                to: move.to,
                san: move.san,
                fen: room.game.fen(),
                turn: room.game.turn(),
                clocks: room.clocks,
                isGameOver: room.game.game_over(),
                isCheckmate: room.game.in_checkmate(),
                isDraw: room.game.in_draw(),
                winner: room.game.in_checkmate() 
                    ? (room.game.turn() === "w" ? "black" : "white") 
                    : null
            });

                        // 6. Освобождаем комнату после матча
            if (room.game.game_over()) {
                // Запускаем фоновый античит-анализ ДО удаления комнаты
                const roomToAnalyze = {
                    id: roomId,
                    moveHistory: [...room.moveHistory]
                };
                analyzeForFairPlay(roomToAnalyze);   // без await — фон

                activeGames.delete(roomId);
                console.log(`Room ${roomId} closed — game over`);
            }
        } catch (e) {
            socket.emit("moveError", { message: e.message });
        }
    });

    // ===== ОТКЛЮЧЕНИЕ =====
    socket.on("disconnect", () => {
        console.log("Player disconnected:", socket.id);
        
        // Убираем из очереди
        matchQueue = matchQueue.filter((p) => p.socketId !== socket.id);

        // Ищем комнату, где был этот сокет
        for (const [roomId, room] of activeGames.entries()) {
            if (room.whiteSocket === socket.id || room.blackSocket === socket.id) {
                const opponentSocket = room.whiteSocket === socket.id 
                    ? room.blackSocket 
                    : room.whiteSocket;
                
                // Сообщаем сопернику об отключении
                io.to(opponentSocket).emit("opponentDisconnected", {
                    message: "Opponent disconnected. 30 seconds to reconnect or you win."
                });

                // Таймер на 30 секунд
                setTimeout(() => {
                    const stillActive = activeGames.get(roomId);
                    if (stillActive) {
                                                const winner = room.whiteSocket === socket.id ? "black" : "white";

                        // Запускаем фоновый античит ДО удаления комнаты
                        const roomToAnalyze = {
                            id: roomId,
                            moveHistory: [...room.moveHistory]
                        };
                        analyzeForFairPlay(roomToAnalyze);   // без await — фон

                        io.to(opponentSocket).emit("opponentForfeit", {
                            winner: winner,
                            reason: "Opponent disconnected for 30+ seconds"
                        });
                        activeGames.delete(roomId);
                        console.log(`Room ${roomId} closed — ${winner} wins by disconnect`);
                    }
                }, 30000);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
