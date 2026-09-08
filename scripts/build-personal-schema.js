// Builds the published JSON Schema artifact for personal queue events.
// Deterministic and offline by construction: the only input is the checked-in schema
// object, so the same commit always produces byte-identical output. Nothing private is
// read or written here. No queue records, no timestamps, no account data.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventSchema } from '../src/personal/event-schema.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'build');
const target = path.join(directory, 'personal-event.schema.json');

fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(target, JSON.stringify(eventSchema, null, 2) + '\n');

console.log(`Wrote ${path.relative(root, target)}`);
