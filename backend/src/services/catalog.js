import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const catalog = Object.freeze(require('../data/catalog.json'));
export const timeSlots = Object.freeze([...catalog.timeSlots]);
export const menuById = new Map(catalog.menuItems.map((item) => [item.id, item]));
