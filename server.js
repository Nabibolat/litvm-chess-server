// LitVM Chess — WebSocket Server
// Node.js + Socket.IO + chess.js

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Хранилище активных игр: matchId → { game, players, white, black }
const activeGames = new Map();

app.get("/", (req, res) => {
    res.send("LitVM Chess WebSocket Server is running");
});

io.on("connection", (socket) => {
    console.log("Player connected:", socket.id);

    // Игрок заходит в партию
    socket.on("joinGame", ({ matchId, playerColor, userAddress }) => {
        socket.join("match_" + matchId);
        console.log(`Player ${userAddress} joined match ${matchId} as ${playerColor}`);

        // Создаём игру, если её ещё нет
        if (!activeGames.has(matchId)) {
            activeGames.set(matchId, {
                game: new Chess(),
                white: null,
                black: null
            });
        }

        const room = activeGames.get(matchId);
        if (playerColor === "white") room.white = userAddress;
        if (playerColor === "black") room.black = userAddress;

        // Отправляем текущее состояние
        socket.emit("gameState", {
            fen: room.game.fen(),
            turn: room.game.turn(),
            matchId: matchId
        });

        // Сообщаем другому игроку, что соперник подключился
        socket.to("match_" + matchId).emit("opponentJoined", { userAddress });
    });

    // Игрок сделал ход
    socket.on("makeMove", ({ matchId, from, to, promotion }) => {
        const room = activeGames.get(matchId);
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

            // Рассылаем ход ВСЕМ в комнате (включая отправителя)
            io.to("match_" + matchId).emit("moveMade", {
                from: move.from,
                to: move.to,
                fen: room.game.fen(),
                turn: room.game.turn(),
                isGameOver: room.game.game_over(),
                isCheckmate: room.game.in_checkmate(),
                isDraw: room.game.in_draw()
            });

            console.log(`Move in match ${matchId}: ${move.from}-${move.to}`);
        } catch (e) {
            socket.emit("moveError", { message: e.message });
        }
    });

    // Игрок вышел
    socket.on("disconnect", () => {
        console.log("Player disconnected:", socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});