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

// The consignor's share of one sale: the line total minus the store's cut
// (`percent`), the cut rounded first and the share the remainder.
//
// Paid on the ACTUAL selling price. `baseprice` is a LEGACY commission base:
// until 2026-09-02 a floored rare paid its consignor on the card's real sub-$1
// price instead, and sales made before then still carry it — so it is honoured
// when present; new sales leave it null and fall through to `price`.
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

// A spend at the counter records the amount drawn from manual credit as a
// negative adjustment row, so this note marks those apart from a shop grant.
export const ADJ_SPENT_NOTE = "Usado en una compra";

// The store's debt to one collection — also the credit its owner can spend.
//
// Derived from sales (Σ unpaid net) PLUS the manual adjustments the shop made
// from the Usuarios page (signed): a grant adds credit, a deduction or a spend
// removes it. Clamped at zero — deductions can zero a balance but never make
// the store "owed" a negative amount.
export async function creditFor(db, collectionid) {
  const [sales, adjustments] = await Promise.all([
    db.sale.findMany({
      where: { collectionid },
      select: {
        price: true,
        baseprice: true,
        percent: true,
        quantity: true,
        paidamount: true,
      },
    }),
    db.creditadjustment.findMany({
      where: { collectionid },
      select: { amount: true },
    }),
  ]);
  const fromSales = sales.reduce((sum, sale) => sum.add(saleRemaining(sale)), ZERO);
  const total = adjustments.reduce((sum, a) => sum.add(a.amount), fromSales);
  return total.isNegative() ? ZERO : total;
}

// The balance split into its two halves, which behave differently at the till:
//   saleMoney   — earned from selling the customer's cards ("dinero en la
//                 tienda"). Payable in cash (the Pagar page) OR spendable on a
//                 purchase.
//   storeCredit — loaded by hand by the shop, e.g. a tournament prize ("store
//                 credit"). Spendable on a purchase only; never paid out.
// Both clamped at zero. Kept apart everywhere the balance is shown.
export async function creditBalances(db, collectionid) {
  const [sales, adjustments] = await Promise.all([
    db.sale.findMany({
      where: { collectionid },
      select: {
        price: true,
        baseprice: true,
        percent: true,
        quantity: true,
        paidamount: true,
      },
    }),
    db.creditadjustment.aggregate({
      where: { collectionid },
      _sum: { amount: true },
    }),
  ]);
  const saleMoney = sales.reduce((sum, s) => sum.add(saleRemaining(s)), ZERO);
  const storeCredit = new Decimal(adjustments._sum.amount ?? 0);
  return {
    saleMoney: saleMoney.isNegative() ? ZERO : saleMoney,
    storeCredit: storeCredit.isNegative() ? ZERO : storeCredit,
  };
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

  // STORE CREDIT FIRST. It can only ever be spent on a purchase — it is never
  // paid out in cash — so drawing it down before the sale money preserves the
  // most of what the customer could still take home as cash. The draw is a
  // NEGATIVE adjustment, so the derived store credit drops by exactly what was
  // spent, the same way filling a sale's paidamount drops its remainder.
  const agg = await tx.creditadjustment.aggregate({
    where: { collectionid },
    _sum: { amount: true },
  });
  const adjBalance = new Decimal(agg._sum.amount ?? 0);
  if (adjBalance.gt(ZERO) && left.gt(ZERO)) {
    const take = left.lte(adjBalance) ? left : adjBalance;
    await tx.creditadjustment.create({
      data: { collectionid, amount: take.neg(), date, note: ADJ_SPENT_NOTE },
    });
    left = left.sub(take);
    consumed = consumed.add(take);
  }

  // THEN the sale money, oldest sales settled front to back and the boundary
  // sale partially, so "sell one expensive card, buy several cheap ones over a
  // month" works without ever splitting a sale row.
  if (left.gt(ZERO)) {
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
  }

  if (consumed.gt(ZERO)) {
    await tx.payment.create({
      data: { collectionid, ammount: consumed, kind: "credit", date },
    });
  }
  return consumed;
}
