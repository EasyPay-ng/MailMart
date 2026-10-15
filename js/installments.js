// A fixed twelve-payment, zero-interest plan. All arithmetic uses integer
// kobo, and the final payment absorbs the rounding remainder.
import { roundMoney } from "./referral-policy.js";
export const INSTALLMENT_MONTHS = 12;
export function installmentAmount(total, number) {
  const value = roundMoney(total);
  if (!Number.isInteger(number) || number < 1 || number > 12) throw new Error("Choose an instalment from 1 to 12.");
  const kobo = Math.round(value * 100);
  if (!Number.isSafeInteger(kobo) || kobo < 12) throw new Error("The total is too small or too large for twelve payments.");
  const base = Math.floor(kobo / 12);
  return (number === 12 ? kobo - base * 11 : base) / 100;
}
export function isFullyPaid(order) {
  return order.paymentMode === "installment"
    ? order.installmentsPaid === 12 && Math.round(Number(order.totalPaid || 0) * 100) === Math.round(Number(order.total) * 100)
    : !!order.paidAt;
}
export function mayShip(order) {
  return order.status === "paid" && (order.paymentMode !== "installment" || order.installmentDelivery === "after_first" || isFullyPaid(order));
}
function dateOf(value) {
  return value?.toDate ? value.toDate() : new Date(value);
}
// UTC calendar months, clamped for February and 30-day months. Never add a
// fixed 30-day duration, which would move the due date throughout the year.
export function monthlyDueDate(start, offset) {
  const original = dateOf(start);
  if (Number.isNaN(original.getTime())) return null;
  const target = new Date(original);
  const day = original.getUTCDate();
  target.setUTCDate(1);
  target.setUTCMonth(original.getUTCMonth() + offset);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}
export function installmentSchedule(order) {
  const start = order.paidAt || order.createdAt;
  return Array.from({ length: 12 }, (_, i) => ({
    number: i + 1, amount: installmentAmount(order.total, i + 1),
    dueAt: start ? monthlyDueDate(start, i) : null, paid: i < Number(order.installmentsPaid || 0)
  }));
}
export function installmentQuote(total) {
  return { months: 12, first: installmentAmount(total, 1), final: installmentAmount(total, 12), interest: 0, total: roundMoney(total) };
}
