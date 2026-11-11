import catalog from '../../backend/src/data/catalog.json';
import type { CafeTable, MenuItem } from '../types';

export const INITIAL_TABLES: CafeTable[] = catalog.tables.map(({ layout, ...table }) => ({
  ...table,
  ...layout,
})) as CafeTable[];

export const TIME_SLOTS = catalog.timeSlots as string[];
export const MENU_ITEMS = catalog.menuItems as MenuItem[];
