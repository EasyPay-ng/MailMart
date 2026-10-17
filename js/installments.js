// Installment arithmetic shared by marketplace checkout, order history and the
// administrator settlement desk. Every plan is zero-interest; the final
// payment absorbs the rounding remainder so the plan totals exactly.
import { roundMoney } from "./referral-policy.js";

export const INSTALLMENT_MONTHS = 12; // legacy name retained for older records/tests
export const DEFAULT_INSTALLMENT_COUNT = 12;
export const MAX_WEEKLY_INSTALLMENTS = 35;
export const MAX_MONTHLY_INSTALLMENTS = 12;

function countFor(order) {
  const count = Number(order?.installmentCount || order?.installmentMonths || DEFAULT_INSTALLMENT_COUNT);
  return Number.isInteger(count) && count > 0 ? count : DEFAULT_INSTALLMENT_COUNT;
}
function unitFor(order) { return order?.installmentUnit === "week" ? "week" : "month"; }

export function installmentAmount(total, number, count = DEFAULT_INSTALLMENT_COUNT) {
  const value = roundMoney(total);
  if (!Number.isInteger(count) || count < 1 || count > MAX_WEEKLY_INSTALLMENTS) {
    throw new Error("Choose a valid installment period.");
  }
  if (!Number.isInteger(number) || number < 1 || number > count) {
    throw new Error(`Choose an installment from 1 to ${count}.`);
  }
  const kobo = Math.round(value * 100);
  if (!Number.isSafeInteger(kobo) || kobo < count) {
    throw new Error(`The total is too small or too large for ${count} payments.`);
  }
  const base = Math.floor(kobo / count);
  return (number === count ? kobo - base * (count - 1) : base) / 100;
}

export function isFullyPaid(order) {
  if (order.paymentMode !== "installment") return !!order.paidAt;
  const count = countFor(order);
  return Number(order.installmentsPaid || 0) === count
    && Math.round(Number(order.totalPaid || 0) * 100) === Math.round(Number(order.total) * 100);
}

export function mayShip(order) {
  return order.status === "paid" && (order.paymentMode !== "installment" || isFullyPaid(order));
}
function dateOf(value) { return value?.toDate ? value.toDate() : new Date(value); }

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

export function weeklyDueDate(start, offset) {
  const original = dateOf(start);
  if (Number.isNaN(original.getTime())) return null;
  const target = new Date(original);
  target.setUTCDate(target.getUTCDate() + 7 * offset);
  return target;
}

export function installmentDueDate(order, offset) {
  const start = order.paidAt || order.createdAt;
  if (!start) return null;
  return unitFor(order) === "week" ? weeklyDueDate(start, offset) : monthlyDueDate(start, offset);
}

export function installmentSchedule(order) {
  const count = countFor(order);
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    amount: installmentAmount(order.total, index + 1, count),
    dueAt: installmentDueDate(order, index),
    paid: index < Number(order.installmentsPaid || 0)
  }));
}

export function installmentQuote(total, count = DEFAULT_INSTALLMENT_COUNT, unit = "month") {
  const normalizedUnit = unit === "week" ? "week" : "month";
  const maximum = normalizedUnit === "week" ? MAX_WEEKLY_INSTALLMENTS : MAX_MONTHLY_INSTALLMENTS;
  if (!Number.isInteger(count) || count < 1 || count > maximum) throw new Error(`Choose between 1 and ${maximum} ${normalizedUnit}${maximum === 1 ? "" : "s"}.`);
  const first = installmentAmount(total, 1, count);
  const final = installmentAmount(total, count, count);
  return {
    count,
    months: normalizedUnit === "month" ? count : 0,
    weeks: normalizedUnit === "week" ? count : 0,
    unit: normalizedUnit,
    first,
    final,
    interest: 0,
    total: roundMoney(total)
  };
}
