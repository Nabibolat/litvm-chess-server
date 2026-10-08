// LitVM Chess — WebSocket Server v2 (Matchmaking + PvP)

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");
const stockfish = require("stockfish");

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

function evaluatePosition(engine, fen, depth = 12) {
    return new Promise((resolve) => {
        let bestCp = 0;

        // Создаем локальный обработчик
        const handler = (event) => {
            const line = typeof event === "string" ? event : (event && event.data ? event.data : "");
            if (typeof line !== "string") return;

            const match = line.match(/score cp (-?\d+)/);
            if (match) bestCp = parseInt(match[1], 10);

            const mateMatch = line.match(/score mate (-?\d+)/);
            if (mateMatch) {
                const m = parseInt(mateMatch[1], 10);
                bestCp = m > 0 ? 10000 : -10000;
            }

            if (line.startsWith("bestmove")) {
                // Снимаем обработчик после получения bestmove
                engine.onmessage = null;
                resolve(bestCp);
            }
        };

        engine.onmessage = handler;
        engine.postMessage(`position fen ${fen}`);
        engine.postMessage(`go depth ${depth}`);
    });
}

async function analyzeForFairPlay(room) {
    const roomId = room.id || "unknown";
    console.log(`[Anti-Cheat] Starting analysis for room ${roomId}...`);

    if (!room.moveHistory || room.moveHistory.length < 6) {
        console.log(`[Anti-Cheat] Room ${roomId} has too few moves to analyze.`);
        return;
    }

    try {
        const engine = stockfish();
        
        // Настройка параметров движка
        engine.postMessage("uci");
        engine.postMessage("setoption name Threads value 1");
        engine.postMessage("setoption name Hash value 16");

        // Собираем FEN всех позиций в партии (от начала до конца)
        const tempGame = new Chess();
        const fens = [tempGame.fen()]; // fens[0] - начальная позиция
        
        for (const h of room.moveHistory) {
            tempGame.move(m.san || m);
            fens.push(tempGame.fen());
        }

        // Оцениваем каждую позицию ровно 1 раз (всего N+1 оценок вместо 2N)
        const evals = [];
        for (const fen of fens) {
            const cp = await evaluatePosition(engine, fen, 12);
            evals.push(cp);
        }

        const acpl = { white: [], black: [] };

        // Считаем потерю центипешек на каждом ходе
        for (let i = 0; i < room.moveHistory.length; i++) {
            const isWhite = (i % 2 === 0);
            const evalBefore = evals[i];
            const evalAfter = evals[i + 1];

            // Приводим оценку к взгляду игрока, который делает ход
            let loss = 0;
            if (isWhite) {
                // Для белых: чем выше eval, тем лучше. Потеря = evalBefore - evalAfter
                loss = evalBefore - evalAfter;
            } else {
                // Для черных: чем ниже eval, тем лучше (в терминах белых). Потеря = evalAfter - evalBefore
                loss = evalAfter - evalBefore;
            }

            // Исключаем случаи, когда позиция уже выиграна/проиграна вхлам (>1000 cp)
            if (Math.abs(evalBefore) < 1000) {
                acpl[isWhite ? "white" : "black"].push(Math.max(0, loss));
            }
        }

        // Средние значения ACPL
        const avg = (arr) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
        const whiteACPL = avg(acpl.white);
        const blackACPL = avg(acpl.black);

        // Дисперсия и стандартное отклонение времени
        const times = room.moveHistory.map(m => m.timeSpentMs).filter(t => typeof t === "number" && t < 60000);
        const avgTime = avg(times);
        const variance = times.length > 0
            ? times.reduce((a, b) => a + Math.pow(b - avgTime, 2), 0) / times.length
            : 0;
        const stdDev = Math.sqrt(variance);

        // Подозрения:
        // 1. Очень низкий ACPL (< 15) при более чем 10 ходах
        // 2. ИЛИ комбинация ACPL < 25 + подозрительно роботоподобный тайминг (stdDev < 400мс)
        const timingSuspicious = times.length > 10 && stdDev < 400;
        
        const whiteFlagged = acpl.white.length >= 8 && (whiteACPL < 15 || (whiteACPL < 25 && timingSuspicious));
        const blackFlagged = acpl.black.length >= 8 && (blackACPL < 15 || (blackACPL < 25 && timingSuspicious));

        if (whiteFlagged || blackFlagged) {
            console.warn(`[Anti-Cheat] ⚠️ SUSPICIOUS GAME DETECTED: room ${roomId}`, {
                white: { acpl: whiteACPL.toFixed(1), flagged: whiteFlagged },
                black: { acpl: blackACPL.toFixed(1), flagged: blackFlagged },
                avgTimeMs: avgTime.toFixed(0),
                stdDevMs: stdDev.toFixed(0)
            });
        } else {
            console.log(`[Anti-Cheat] ✅ Room ${roomId} passed fair play check`, {
                whiteACPL: whiteACPL.toFixed(1),
                blackACPL: blackACPL.toFixed(1),
                avgTimeMs: avgTime.toFixed(0),
                stdDevMs: stdDev.toFixed(0)
            });
        }

        // Завершаем работу движка
        try { engine.postMessage("quit"); } catch (e) {}
    } catch (err) {
        console.error(`[Anti-Cheat] Error analyzing room ${roomId}:`, err);
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
