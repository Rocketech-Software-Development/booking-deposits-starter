import { loadDotEnv } from './config.js';
import { Store } from './db.js';
import { seedDemoData } from './seed-data.js';

// Seeding only touches the local database, so it doesn't need Stripe keys.
loadDotEnv();
const path = process.env.DATABASE_PATH ?? './data/dev.sqlite';
const store = new Store(path);
const result = seedDemoData(store);
store.close();
console.log(`Seeded ${result.providers} providers and ${result.slots} slots into ${path}.`);
console.log('Bookings and slots were reset. Connect onboarding was kept.');
