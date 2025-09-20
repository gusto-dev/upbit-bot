import "dotenv/config";
import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";

// ===== 설정 =====
const CODE_UPBIT = process.env.CODE_UPBIT || "KRW-BTC"; // 업비트 심볼코드 (웹소켓용)
const WS_URL = "wss://api.upbit.com/websocket/v1";
const HEARTBEAT_SEC = 5; // 상태 로그 주기
const PING_SEC = 25; // 핑 주기(네트워크 유지)
const MAX_BACKOFF_SEC = 30; // 재연결 최대 대기

// 상태
let lastPrice = 0;
let lastChangeRate = 0;
let lastTs = 0;
let socket: WebSocket | null = null;
let closedByUser = false;
let reconnectAttempt = 0;

// 유틸
const nowKST = () =>
  new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

// 구독 메시지(업비트 규격: 배열 형태 전송)
function subscriptionPayload() {
  return JSON.stringify([
    { ticket: uuidv4() },
    { type: "ticker", codes: [CODE_UPBIT], isOnlyRealtime: true },
    { format: "DEFAULT" }, // 기본 JSON 포맷
  ]);
}

// 연결/구독
async function connect() {
  if (socket && socket.readyState === WebSocket.OPEN) return;

  const backoff = Math.min(2 ** reconnectAttempt, MAX_BACKOFF_SEC);
  if (reconnectAttempt > 0) {
    console.log(`[WS] reconnect in ${backoff}s...`);
    await sleep(backoff * 1000);
  }

  socket = new WebSocket(WS_URL);

  socket.on("open", () => {
    reconnectAttempt = 0;
    console.log(`[WS] OPEN @ ${nowKST()}`);
    socket!.send(subscriptionPayload());
  });

  socket.on("message", (data) => {
    // 업비트는 JSON 텍스트 프레임을 보냄(환경에 따라 Buffer일 수도 있어 문자열 변환)
    let msg: any;
    try {
      // data가 Buffer면 UTF-8로 변환
      const raw = typeof data === "string" ? data : data.toString("utf-8");
      msg = JSON.parse(raw);
    } catch {
      return; // 포맷 안 맞으면 스킵
    }

    if (msg.type === "ticker") {
      // 주요 필드: trade_price, signed_change_rate, timestamp, acc_trade_price_24h 등
      lastPrice = msg.trade_price;
      lastChangeRate = msg.signed_change_rate; // ex) 0.0123 => +1.23%
      lastTs = msg.timestamp; // epoch ms
    }
  });

  socket.on("close", (code, reason) => {
    console.warn(
      `[WS] CLOSE code=${code} reason=${reason.toString()} @ ${nowKST()}`
    );
    socket = null;
    if (!closedByUser) {
      reconnectAttempt++;
      connect().catch(console.error);
    }
  });

  socket.on("error", (err) => {
    console.error("[WS] ERROR", err.message);
  });
}

// 하트비트 로그(보이는 손맛)
function startHeartbeat() {
  setInterval(() => {
    const stamp = lastTs
      ? new Date(lastTs).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })
      : "-";
    const cr = (lastChangeRate * 100).toFixed(2);
    console.log(
      `[HB ${nowKST()}] ${CODE_UPBIT} price=${Math.round(
        lastPrice
      )} KRW | 24hChange=${cr}% | priceTs=${stamp}`
    );
  }, HEARTBEAT_SEC * 1000);
}

// Ping(네트워크 유지)
function startPing() {
  setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.ping(); // 업비트는 PING/PONG 가능
      } catch {}
    }
  }, PING_SEC * 1000);
}

// 안전 종료
function setupGracefulShutdown() {
  const shutdown = async () => {
    closedByUser = true;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.close(1000, "bye");
      } catch {}
    }
    console.log("[WS] Bye");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// 실행
(async () => {
  console.log(`[BOOT] Upbit public WS monitor start. code=${CODE_UPBIT}`);
  setupGracefulShutdown();
  startHeartbeat();
  startPing();
  await connect();
})();
