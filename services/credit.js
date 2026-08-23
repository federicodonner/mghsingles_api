// What the store owes each consignor, sale by sale.
//
// A sold card's NET is its line total minus the store's commission — the
// commission is rounded to cents first and the net is the remainder, the same
// arithmetic the customer's Ventas page shows, so the two can never disagree
// by a cent. `sale.paidamount` tracks how much of that net has been settled:
// by the store paying cash (the Pagar page) or by the consignor spending it
// as store credit on a purchase. paidamount == net means the card is paid.
//
// All money here is Prisma Decimal, never a JS number — floating point turns
// a 3002.40 into 3002.3999999999996.
import { Prisma } from "@prisma/client";

const { Decimal } = Prisma;
export const ZERO = new Decimal(0);

const round2 = (value) =>
  new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

// The consignor's share of one sale.
//
// Computed from `baseprice` — the card's REAL price — when the customer was
// charged more than that (the $1 floor on cheap rares). The consignor's cut
// follows the market value of their card; the uplift is the store's.
export function saleNet(sale) {
  const lineTotal = new Decimal(sale.baseprice ?? sale.price).mul(
    sale.quantity
  );
  return lineTotal.sub(round2(lineTotal.mul(sale.percent)));
}

// What is still owed on one sale.
export function saleRemaining(sale) {
  const remaining = saleNet(sale).sub(sale.paidamount ?? 0);
  return remaining.isNegative() ? ZERO : remaining;
}

// The store's debt to one collection — also the credit its owner can spend.
export async function creditFor(db, collectionid) {
  const sales = await db.sale.findMany({
    where: { collectionid },
    select: {
      price: true,
      baseprice: true,
      percent: true,
      quantity: true,
      paidamount: true,
    },
  });
  return sales.reduce((sum, sale) => sum.add(saleRemaining(sale)), ZERO);
}

// Spend up to `amount` of a collection's credit, oldest debts first.
//
// Whole sales are settled front to back and the boundary sale is settled
// partially, so "sell one expensive card, buy several cheap ones over a
// month" works without ever splitting a sale row. Returns the Decimal
// actually consumed (less than `amount` when the credit ran out) and writes
// the `credit` ledger row; the caller decides what to do about a remainder.
export async function consumeCredit(tx, collectionid, amount, date) {
  let left = round2(amount);
  let consumed = ZERO;

  const sales = await tx.sale.findMany({
    where: { collectionid },
    orderBy: [{ date: "asc" }, { id: "asc" }],
  });

  for (const sale of sales) {
    if (left.lte(ZERO)) break;
    const remaining = saleRemaining(sale);
    if (remaining.lte(ZERO)) continue;

    const take = remaining.lte(left) ? remaining : left;
    const nextPaid = new Decimal(sale.paidamount ?? 0).add(take);
    await tx.sale.update({
      where: { id: sale.id },
      data: {
        paidamount: nextPaid,
        // Full settlement stamps the date; a partial fill leaves it null so
        // "when was I paid for this card" never points at a half-payment.
        paiddate: nextPaid.gte(saleNet(sale)) ? date : null,
      },
    });
    left = left.sub(take);
    consumed = consumed.add(take);
  }

  if (consumed.gt(ZERO)) {
    await tx.payment.create({
      data: { collectionid, ammount: consumed, kind: "credit", date },
    });
  }
  return consumed;
}
