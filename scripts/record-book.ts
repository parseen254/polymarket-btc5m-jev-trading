import { createWriteStream, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createGzip } from "node:zlib";
import { fetchJson } from "../src/adapters/polymarket/wire.js";
import { loadDotEnv } from "../src/loadEnv.js";

/**
 * Record what a paper market maker needs to simulate queue position honestly:
 * the Polymarket L2 book for the current BTC 5m window (snapshots + every level
 * change + every trade), Binance top of book and Chainlink BTC/USD.
 *
 * Output: data/book/<startIso>.jsonl.gz, one compact event per line, `t` = local
 * receive time in ms (the clock a live bot would act on):
 *   {k:"w", t, slug, ts, up, down}                        window + token ids
 *   {k:"b", t, a, bids:[[p,s]], asks:[[p,s]]}             book snapshot
 *   {k:"p", t, a, p, s, side}                             level now has size s (0 = gone)
 *   {k:"x", t, a, p, s, side, st}                         trade; side = taker side, st = server ms
 *   {k:"n", t, bid, ask}                                  Binance BTCUSDT top of book (on change, ≤10/s)
 *   {k:"c", t, v, st}                                     Chainlink BTC/USD
 *
 * Usage: tsx scripts/record-book.ts [minutes=60]
 */

loadDotEnv();

const MARKET_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const RTDS_WS = "wss://ws-live-data.polymarket.com";
const BINANCE_WS = (process.env.BINANCE_WS_URL || "wss://data-stream.binance.vision/ws").replace(/\/+$/, "");
const GAMMA = "https://gamma-api.polymarket.com";

const minutes = Number(process.argv[2] ?? 60);
const dir = resolve("data/book");
mkdirSync(dir, { recursive: true });
const file = resolve(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl.gz`);
const gz = createGzip();
const out = createWriteStream(file);
gz.pipe(out);
let lines = 0;
const write = (o: Record<string, unknown>) => {
  gz.write(`${JSON.stringify(o)}\n`);
  lines++;
};

type Tokens = { slug: string; ts: number; up: string; down: string };
async function tokensFor(ts: number): Promise<Tokens | null> {
  const ev = (await fetchJson(`${GAMMA}/events?slug=btc-updown-5m-${ts}`).catch(() => null)) as
    | Array<{ markets?: Array<{ outcomes: string; clobTokenIds: string }> }>
    | null;
  const m = ev?.[0]?.markets?.[0];
  if (!m) return null;
  const outcomes = (JSON.parse(m.outcomes) as string[]).map((o) => o.toLowerCase());
  const ids = JSON.parse(m.clobTokenIds) as string[];
  return { slug: `btc-updown-5m-${ts}`, ts, up: ids[outcomes.indexOf("up")]!, down: ids[outcomes.indexOf("down")]! };
}

const levels = (xs: Array<{ price: string; size: string }>) =>
  xs.map((l) => [Number(l.price), Number(l.size)] as [number, number]);

function connect(url: string, onOpen: (ws: WebSocket) => void, onMsg: (d: unknown) => void, ping?: string) {
  let ws: WebSocket;
  let timer: ReturnType<typeof setInterval> | undefined;
  const open = () => {
    ws = new WebSocket(url);
    ws.onopen = () => {
      onOpen(ws);
      if (ping) timer = setInterval(() => ws.readyState === 1 && ws.send(ping), 5_000);
    };
    ws.onmessage = (m) => {
      const d = String(m.data);
      if (d === "PONG" || d === "pong") return;
      try {
        onMsg(JSON.parse(d));
      } catch {
        // ignore non-JSON keepalives
      }
    };
    ws.onclose = () => {
      clearInterval(timer);
      if (url === MARKET_WS) marketReady = false;
      if (!stopping) setTimeout(open, 1_000); // reconnect; the book resnapshots on subscribe
    };
    ws.onerror = () => ws.close();
  };
  open();
  return { send: (o: unknown) => ws?.readyState === 1 && ws.send(JSON.stringify(o)) };
}

let stopping = false;
const subscribed = new Set<string>();
/** The first message on a market connection must be a full `type: "market"` subscribe. */
let marketReady = false;
const known = new Map<number, Tokens>();

const market = connect(
  MARKET_WS,
  (ws) => {
    const ids = [...subscribed];
    marketReady = ids.length > 0;
    if (marketReady) ws.send(JSON.stringify({ type: "market", assets_ids: ids }));
  },
  (d) => {
    const t = Date.now();
    for (const e of (Array.isArray(d) ? d : [d]) as Array<Record<string, any>>) {
      if (e.event_type === "book") {
        write({ k: "b", t, a: e.asset_id, bids: levels(e.bids ?? []), asks: levels(e.asks ?? []) });
      } else if (e.event_type === "price_change") {
        for (const c of e.price_changes ?? []) {
          write({ k: "p", t, a: c.asset_id, p: Number(c.price), s: Number(c.size), side: c.side });
        }
      } else if (e.event_type === "last_trade_price") {
        write({ k: "x", t, a: e.asset_id, p: Number(e.price), s: Number(e.size), side: e.side, st: Number(e.timestamp) });
      }
    }
  },
  "PING",
);

let lastBn = "";
let lastBnT = 0;
connect(
  `${BINANCE_WS}/btcusdt@bookTicker`,
  () => {},
  (d) => {
    const e = d as { b?: string; a?: string };
    if (!e.b || !e.a) return;
    const t = Date.now();
    const key = `${e.b}|${e.a}`;
    if (key === lastBn || t - lastBnT < 100) return;
    lastBn = key;
    lastBnT = t;
    write({ k: "n", t, bid: Number(e.b), ask: Number(e.a) });
  },
);

connect(
  RTDS_WS,
  (ws) =>
    ws.send(
      JSON.stringify({
        action: "subscribe",
        subscriptions: [{ topic: "crypto_prices_chainlink", type: "*", filters: '{"symbol":"btc/usd"}' }],
      }),
    ),
  (d) => {
    const e = d as { topic?: string; payload?: { value?: number; timestamp?: number } };
    if (e.topic !== "crypto_prices_chainlink" || e.payload?.value == null) return;
    write({ k: "c", t: Date.now(), v: e.payload.value, st: e.payload.timestamp });
  },
  "PING",
);

/** Keep the current and next window subscribed; drop windows that ended over a minute ago. */
async function rotate(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const cur = Math.floor(now / 300) * 300;
  for (const ts of [cur, cur + 300]) {
    if (known.has(ts)) continue;
    const tok = await tokensFor(ts);
    if (!tok) continue;
    known.set(ts, tok);
    write({ k: "w", t: Date.now(), ...tok });
    subscribed.add(tok.up).add(tok.down);
    if (marketReady) {
      market.send({ assets_ids: [tok.up, tok.down], operation: "subscribe" });
    } else if (market.send({ type: "market", assets_ids: [...subscribed] })) {
      marketReady = true;
    }
  }
  for (const [ts, tok] of known) {
    if (ts + 300 + 60 < now) {
      market.send({ assets_ids: [tok.up, tok.down], operation: "unsubscribe" });
      subscribed.delete(tok.up);
      subscribed.delete(tok.down);
      known.delete(ts);
    }
  }
}

await rotate();
const rotor = setInterval(() => void rotate(), 10_000);
const status = setInterval(() => console.error(`${new Date().toISOString()} lines=${lines} windows=${[...known.keys()].join(",")}`), 60_000);
setTimeout(() => {
  stopping = true;
  clearInterval(rotor);
  clearInterval(status);
  out.on("close", () => {
    console.error(`wrote ${lines} events to ${file}`);
    process.exit(0);
  });
  gz.end();
}, minutes * 60_000);
