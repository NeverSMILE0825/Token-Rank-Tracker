const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { CHAINS } = require("./lib/chains");
const { createSession, run } = require("./lib/tracker");

const publicDir = path.join(__dirname, "docs");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function send(res, status, body, type) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function startServer(port = Number(process.env.PORT) || 4173, host = process.env.HOST || "127.0.0.1") {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/api/chains") {
      send(res, 200, JSON.stringify({ chains: CHAINS }), "application/json; charset=utf-8");
      return;
    }

    const requested = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = path.normalize(path.join(publicDir, requested));
    const relative = path.relative(publicDir, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      send(res, 404, "Not found", "text/plain; charset=utf-8");
      return;
    }
    fs.readFile(file, (error, data) => {
      if (error) {
        send(res, 404, "Not found", "text/plain; charset=utf-8");
        return;
      }
      send(res, 200, data, TYPES[path.extname(file)] || "application/octet-stream");
    });
  });

  const sockets = new WebSocketServer({ server, path: "/ws" });

  sockets.on("connection", (ws) => {
    let session = null;
    ws.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message.type === "stop") {
        session?.stop();
        session = null;
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: "idle" }));
        return;
      }
      if (message.type !== "track") return;
      session?.stop();
      try {
        session = createSession(ws, message);
      } catch (error) {
        ws.send(JSON.stringify({ type: "error", error: error.message }));
        session = null;
        return;
      }
      run(session).catch((error) => {
        if (error?.message === "aborted") return;
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "error", error: "The tracker stopped unexpectedly." }));
        }
      });
    });
    ws.on("close", () => {
      session?.stop();
      session = null;
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      resolve({
        url: `http://${host}:${actualPort}`,
        port: actualPort,
        close() {
          return new Promise((done) => {
            sockets.close();
            server.close(() => done());
          });
        },
      });
    });
  });
}

if (require.main === module) {
  startServer()
    .then(({ url }) => {
      console.log(`Find Rank running at ${url}`);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = { startServer };
