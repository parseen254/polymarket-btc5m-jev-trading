import type { Side } from "../../domain.js";
import { fetchJson } from "./wire.js";

const GAMMA = "https://gamma-api.polymarket.com";

/** Official settlement of one window: winner plus Chainlink open/close from Gamma eventMetadata. */
export type OfficialOutcome = {
  slug: string;
  winner: Side;
  priceToBeat: number | null;
  finalPrice: number | null;
};

export type OutcomeResolver = (slug: string) => Promise<OfficialOutcome | null>;

function finite(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return v != null && Number.isFinite(n) ? n : null;
}

function parseList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Winner only once the market is closed and prices have snapped to 1/0.
 * Mid-window or freshly-ended books are never read as a result.
 */
export async function fetchOfficialOutcome(
  slug: string,
): Promise<OfficialOutcome | null> {
  const data = await fetchJson(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`);
  if (!Array.isArray(data) || data.length === 0) return null;
  const event = data[0] as {
    eventMetadata?: { priceToBeat?: unknown; finalPrice?: unknown } | null;
    markets?: Array<{ outcomes?: unknown; outcomePrices?: unknown; closed?: boolean }>;
  };
  const market = event.markets?.[0];
  if (!market?.closed) return null;

  const outcomes = parseList(market.outcomes).map((o) => o.trim().toLowerCase());
  const prices = parseList(market.outcomePrices).map(Number);
  const up = prices[outcomes.indexOf("up")];
  const down = prices[outcomes.indexOf("down")];
  let winner: Side | null = null;
  if (up != null && down != null) {
    if (up >= 0.99 && down <= 0.01) winner = "UP";
    else if (down >= 0.99 && up <= 0.01) winner = "DOWN";
  }
  if (!winner) return null;

  return {
    slug,
    winner,
    priceToBeat: finite(event.eventMetadata?.priceToBeat),
    finalPrice: finite(event.eventMetadata?.finalPrice),
  };
}
