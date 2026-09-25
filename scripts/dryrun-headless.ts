import { loadConfig } from "../src/config.js";
import { loadDotEnv } from "../src/loadEnv.js";
import { WindowSession } from "../src/session.js";

// Headless dry-run loop: one compact line per tick. Usage: tsx scripts/dryrun-headless.ts [seconds]
async function main(): Promise<void> {
  loadDotEnv();
  const cfg = loadConfig(process.env);
  if (cfg.liveTrading) throw new Error("dryrun-headless refuses LIVE_TRADING=1");
  const until = Date.now() + Number(process.argv[2] ?? 360) * 1000;
  const session = await WindowSession.open(cfg);
  while (Date.now() < until) {
    const s = await session.tick();
    const op = s.opinion
      ? `jev=${s.opinion.side}@${s.opinion.confidence.toFixed(2)} P(UP)=${s.opinion.probs?.UP.toFixed(2) ?? "?"}`
      : "jev=-";
    const btc = s.btc ? `btc=${s.btc.last} (${s.btc.source})` : "btc=-";
    const last = s.decisionLog.at(-1);
    console.log(
      [s.at.slice(11, 19), s.market?.slug ?? "-", `${s.secondsRemaining ?? "?"}s`, btc, op,
       `pos=${s.position.kind === "open" ? `${s.position.side}x${s.position.size}@${s.position.entryPrice}` : "flat"}`,
       last?.summary ?? "", `pnl=${s.cumulativePnLUsd}`].join(" | "),
    );
    await new Promise((r) => setTimeout(r, cfg.tickMs));
  }
  await session.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
