// `npm run i18n:review`: writes docs/i18n/uk-review.md, the key | English |
// Ukrainian table for a native speaker's review. Runs with Node's type
// stripping, so imports carry explicit .ts extensions.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { en } from '../src/i18n/messages/en.ts'
import { uk } from '../src/i18n/messages/uk.ts'
import { REVIEW_FILE, buildReviewMarkdown } from '../src/i18n/review.ts'

const target = resolve(process.cwd(), REVIEW_FILE)
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, buildReviewMarkdown(en, uk))
console.log(`Wrote ${REVIEW_FILE}`)
