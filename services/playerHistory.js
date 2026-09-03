// One account's activity, newest first: purchases (completed orders), sales
// (their consigned cards that sold), store-credit changes (grants, deductions),
// and cash payouts. All amounts are dollars; the UIs show pesos.
//
// Shared by the admin (any customer, via /admin/player/:id/history) and the
// customer's own account (their own, via /player/me/history), so both read the
// exact same ledger — change the shape here and both move together.
import { saleNet, ADJ_SPENT_NOTE } from "./credit.js";

// Returns { name, events } for the player, or null if no such player.
export async function buildPlayerHistory(prisma, playerId) {
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: { id: true, name: true, collection: { select: { id: true } } },
  });
  if (!player) return null;
  const collectionIds = player.collection.map((c) => c.id);

  const [orders, sales, adjustments, payments] = await Promise.all([
    prisma.order.findMany({
      where: { playerid: playerId, status: "completed" },
      include: {
        orderline: {
          include: {
            card: {
              include: { cardgeneral: { select: { name: true, cardsetcode: true } } },
            },
          },
        },
      },
    }),
    collectionIds.length
      ? prisma.sale.findMany({
          where: { collectionid: { in: collectionIds } },
          include: { cardgeneral: { select: { name: true, cardsetcode: true } } },
        })
      : [],
    collectionIds.length
      ? prisma.creditadjustment.findMany({
          where: { collectionid: { in: collectionIds } },
        })
      : [],
    collectionIds.length
      ? prisma.payment.findMany({
          where: { collectionid: { in: collectionIds } },
        })
      : [],
  ]);

  const events = [];

  // Purchases: the charged lines of each completed order (withdrawals are the
  // customer's own cards going home, not a purchase).
  for (const order of orders) {
    const bought = order.orderline.filter((l) => l.kind !== "withdrawal");
    if (!bought.length) continue;
    const total = bought.reduce((s, l) => s + Number(l.price) * l.quantity, 0);
    if (total <= 0) continue;
    const allPesos = bought.every((l) => l.pricepesos != null);
    const totalpesos = allPesos
      ? bought.reduce((s, l) => s + Number(l.pricepesos) * l.quantity, 0)
      : null;
    // How much of this purchase was paid with store credit; the rest is cash.
    // Clamped to the total so a rounding wobble can never show more credit than
    // the bill.
    const creditused = Math.min(Number(order.creditused) || 0, total);
    events.push({
      type: "purchase",
      date: order.closed ?? order.created,
      total: total.toFixed(2),
      totalpesos: totalpesos != null ? String(totalpesos) : null,
      creditused: creditused.toFixed(2),
      items: bought.map((l) => ({
        // The line's frozen snapshot (a sold-out card's stock row is gone),
        // falling back to the live card for lines that predate it.
        name: l.cardname ?? l.card?.cardgeneral?.name ?? null,
        cardsetcode: l.cardsetcode ?? l.card?.cardgeneral?.cardsetcode ?? null,
        quantity: l.quantity,
      })),
    });
  }

  // Sales: their consigned cards that sold, and what they earned (the net).
  for (const sale of sales) {
    events.push({
      type: "sale",
      date: sale.date,
      name: sale.cardgeneral?.name ?? null,
      cardsetcode: sale.cardgeneral?.cardsetcode ?? null,
      quantity: sale.quantity,
      net: saleNet(sale).toFixed(2),
    });
  }

  // Store-credit changes made by the shop: manual grants and deductions. The
  // automatic "spent on a purchase" rows are excluded — that spend shows up as
  // the credit half of its own Compra, so listing it here would say it twice.
  for (const adj of adjustments) {
    if (adj.note === ADJ_SPENT_NOTE) continue;
    events.push({
      type: "credit",
      date: adj.date,
      amount: adj.amount.toString(),
      note: adj.note ?? null,
    });
  }

  // Payments: cash the shop paid the consignor (payout). Credit the customer
  // spent on a purchase is NOT listed here — it is shown inside its own Compra
  // as the credit half of the split, so listing it again would double.
  for (const pay of payments) {
    if (pay.kind !== "payout") continue;
    events.push({
      type: "payment",
      kind: pay.kind, // "payout"
      date: pay.date,
      amount: pay.ammount.toString(),
    });
  }

  events.sort((a, b) => b.date - a.date);
  return { name: player.name, events };
}
