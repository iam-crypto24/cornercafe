import type { Booking } from '../types';
import { INITIAL_TABLES, MENU_ITEMS } from './catalog';

export const INITIAL_BOOKINGS: Booking[] = [
  {
    id: 'b1', referenceNumber: 'KB-8821', date: '2026-11-15', timeSlot: '10:30 AM', partySize: 2,
    table: INITIAL_TABLES[3], preOrders: [{ item: MENU_ITEMS[0], quantity: 2 }, { item: MENU_ITEMS[5], quantity: 1 }],
    customerName: 'Kenji Sato', customerPhone: '+1 (555) 392-1094', customerEmail: 'kenji.sato@example.com',
    specialRequests: 'Quiet corner if possible, celebrating an anniversary.', status: 'confirmed', createdAt: '2026-11-10T14:30:00Z',
  },
  {
    id: 'b2', referenceNumber: 'KB-8822', date: '2026-11-15', timeSlot: '01:30 PM', partySize: 2,
    table: INITIAL_TABLES[8], preOrders: [{ item: MENU_ITEMS[3], quantity: 1 }, { item: MENU_ITEMS[7], quantity: 2 }],
    customerName: 'Maya Lin', customerPhone: '+1 (555) 749-8812', customerEmail: 'maya.lin@example.com',
    specialRequests: 'Oat milk preference for matcha.', status: 'pending', createdAt: '2026-11-10T15:10:00Z',
  },
  {
    id: 'b3', referenceNumber: 'KB-8823', date: '2026-11-16', timeSlot: '04:30 PM', partySize: 4,
    table: INITIAL_TABLES[12], preOrders: [
      { item: MENU_ITEMS[1], quantity: 2 }, { item: MENU_ITEMS[4], quantity: 2 }, { item: MENU_ITEMS[6], quantity: 2 },
    ],
    customerName: 'David Zhang', customerPhone: '+1 (555) 234-9811', customerEmail: 'david.z@example.com',
    specialRequests: 'Need high chair if available.', status: 'confirmed', createdAt: '2026-11-10T16:00:00Z',
  },
];
