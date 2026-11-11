import { timeSlots } from '../services/catalog.js';
import { hasControlCharacters } from '../utils/validation.js';

export class ValidationError extends Error {
  constructor(message, code = 'VALIDATION_ERROR', status = 400) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.status = status;
    this.expose = true;
  }
}

export function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function slotToTime(value) {
  if (!timeSlots.includes(value)) return null;
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(value);
  if (!match) return null;
  let hour = Number(match[1]) % 12;
  if (match[3].toUpperCase() === 'PM') hour += 12;
  return `${String(hour).padStart(2, '0')}:${match[2]}:00`;
}

export function todayInTimeZone(timezone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function minutesNowInTimeZone(timezone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(value.hour) * 60 + Number(value.minute);
}

export function slotMinutes(value) {
  const sql = slotToTime(value);
  if (!sql) return null;
  const [hour, minute] = sql.split(':').map(Number);
  return hour * 60 + minute;
}

function normalizeEmail(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ValidationError('Guest contact details are invalid.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ValidationError('Guest contact details are invalid.');
  }
  return email;
}

function normalizePhone(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 40) throw new ValidationError('Guest contact details are invalid.');
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15 || !/^\+?[\d().\-\s]+$/.test(trimmed)) {
    throw new ValidationError('Guest contact details are invalid.');
  }
  return `${trimmed.startsWith('+') ? '+' : ''}${digits}`;
}

export function normalizeReservation(body, now, timezone) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('Reservation details are invalid.');
  const date = body.date;
  const timeSlot = body.timeSlot;
  const partySize = Number(body.partySize);
  const tableId = typeof body.tableId === 'string' ? body.tableId : body.table?.id;
  if (!isCalendarDate(date)) throw new ValidationError('Choose a valid visit date.');
  const today = todayInTimeZone(timezone, now);
  if (date < today) throw new ValidationError('Choose a future visit date.');
  if (!timeSlots.includes(timeSlot)) throw new ValidationError('Choose a valid time.');
  if (date === today && slotMinutes(timeSlot) <= minutesNowInTimeZone(timezone, now)) {
    throw new ValidationError('Choose a time that has not passed.');
  }
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 8) throw new ValidationError('Choose a party size from 1 to 8.');
  if (typeof tableId !== 'string' || !/^T(?:[1-9]|1[0-9]|2[0-7])$/.test(tableId)) throw new ValidationError('Choose a valid table.');

  const customerName = typeof body.customerName === 'string' ? body.customerName.trim() : '';
  if (customerName.length < 2 || customerName.length > 100 || hasControlCharacters(customerName)) {
    throw new ValidationError('Enter a valid guest name.');
  }
  const customerEmail = normalizeEmail(body.customerEmail);
  const customerPhone = normalizePhone(body.customerPhone);
  if (!customerEmail && !customerPhone) throw new ValidationError('Provide a phone number or email address.');

  const specialRequests = body.specialRequests === undefined || body.specialRequests === null
    ? ''
    : typeof body.specialRequests === 'string' ? body.specialRequests.trim() : null;
  if (specialRequests === null || specialRequests.length > 1000 || hasControlCharacters(specialRequests, { allowFormattingWhitespace: true })) {
    throw new ValidationError('Special requests must be 1,000 characters or fewer.');
  }

  const rawItems = body.preOrders === undefined ? [] : body.preOrders;
  if (!Array.isArray(rawItems) || rawItems.length > 20) throw new ValidationError('Pre-order items are invalid.');
  const seenItems = new Set();
  const preOrders = rawItems.map((entry) => {
    const menuItemId = entry?.menuItemId || entry?.item?.id || entry?.id;
    const quantity = Number(entry?.quantity);
    if (typeof menuItemId !== 'string' || !/^[a-z0-9-]{1,40}$/i.test(menuItemId)
      || !Number.isInteger(quantity) || quantity < 1 || quantity > 20 || seenItems.has(menuItemId)) {
      throw new ValidationError('Pre-order items are invalid.');
    }
    seenItems.add(menuItemId);
    return { menuItemId, quantity };
  });

  const website = typeof body.website === 'string' ? body.website.slice(0, 200) : '';
  const formToken = typeof body.formToken === 'string' ? body.formToken : '';
  const captchaToken = typeof body.captchaToken === 'string' ? body.captchaToken.slice(0, 4096) : '';
  return {
    date, timeSlot, startTime: slotToTime(timeSlot), partySize, tableId,
    customerName, customerEmail, customerPhone, specialRequests, preOrders,
    website, formToken, captchaToken,
  };
}
