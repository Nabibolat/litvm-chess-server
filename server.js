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

app.get("/", (req, res) => {
    res.send("LitVM Chess WebSocket Server v2 is running");
});

io.on("connection", (socket) => {
    console.log("Player connected:", socket.id);

    // ===== МАТЧМЕЙКИНГ =====
    socket.on("findMatch", ({ userAddress, timeControl }) => {
        console.log(`Find match: ${userAddress}, time: ${timeControl}`);

        // Ищем соперника в очереди с тем же контролем времени
        const opponentIndex = matchQueue.findIndex(
            (p) => p.timeControl === timeControl && p.userAddress !== userAddress
        );

        if (opponentIndex === -1) {
            // Соперника нет — ставим в очередь
            matchQueue.push({ socketId: socket.id, userAddress, timeControl });
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
            activeGames.set(roomId, {
                game: new Chess(),
                white: white.userAddress,
                black: black.userAddress,
                whiteSocket: white.socketId,
                blackSocket: black.socketId
            });

            // Подключаем обоих в комнату
            io.sockets.sockets.get(opponent.socketId)?.join(roomId);
            io.sockets.sockets.get(socket.id)?.join(roomId);

            // Сообщаем обоим
            io.to(opponent.socketId).emit("matchFound", {
                roomId: roomId,
                color: isFirstWhite ? "white" : "black",
                opponentAddress: userAddress,
                timeControl: timeControl
            });

            io.to(socket.id).emit("matchFound", {
                roomId: roomId,
                color: isFirstWhite ? "black" : "white",
                opponentAddress: opponent.userAddress,
                timeControl: timeControl
            });

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
            const move = room.game.move({ from, to, promotion: promotion || "q" });
            if (!move) {
                socket.emit("moveError", { message: "Illegal move" });
                return;
            }

            // Рассылаем всем в комнате
            io.to(roomId).emit("moveMade", {
                from: move.from,
                to: move.to,
                fen: room.game.fen(),
                turn: room.game.turn(),
                isGameOver: room.game.game_over(),
                isCheckmate: room.game.in_checkmate(),
                isDraw: room.game.in_draw(),
                winner: room.game.in_checkmate() 
                    ? (room.game.turn() === "w" ? "black" : "white") 
                    : null
            });
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