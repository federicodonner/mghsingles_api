// The peso side of every price.
//
// The shop quotes in dollars; pesos are derived by multiplying by the exchange
// rate the owner maintains on the Precios page. Nothing here talks to a market
// feed — the rate is whatever the owner last typed, which is exactly what a
// counter that accepts both currencies wants.
//
// Peso amounts are whole pesos: at rates in the tens, centavos are noise
// nobody can pay anyway.

const RATE_KEY = "exchangerate";

// The current pesos-per-dollar rate, or null when none has been configured.
// Callers treat null as "the shop does not do pesos yet" and skip the peso
// side entirely rather than showing zeros.
export async function exchangeRate(prisma) {
  const row = await prisma.setting.findUnique({ where: { key: RATE_KEY } });
  const rate = row ? Number(row.value) : NaN;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

export async function setExchangeRate(prisma, rate) {
  await prisma.setting.upsert({
    where: { key: RATE_KEY },
    update: { value: String(rate) },
    create: { key: RATE_KEY, value: String(rate) },
  });
}

// A dollar amount in pesos, or null when either side is missing.
export function toPesos(usd, rate) {
  if (rate == null || usd == null) return null;
  return Math.round(Number(usd) * rate);
}
