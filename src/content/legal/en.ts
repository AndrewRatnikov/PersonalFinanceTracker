// Draft for the owner to review; not legal advice.
//
// English Terms of Use and Privacy Policy. src/content/legal/uk.ts is the
// Ukrainian translation with the same sections (same ids, same bullet counts).

import type { LegalContent } from '@/lib/legal'
import {
  LEGAL_CONTACT_EMAIL,
  LEGAL_LAST_UPDATED,
  LEGAL_OPERATOR_NAME,
} from '@/lib/legal'

export const legalEn: LegalContent = {
  terms: {
    title: 'Terms of Use',
    lastUpdated: LEGAL_LAST_UPDATED,
    intro: [
      `These terms apply when you use MinimaSpend, a personal budgeting app run by ${LEGAL_OPERATOR_NAME}. By using the app you agree to them. If you don't agree, please don't use the app.`,
    ],
    sections: [
      {
        id: 'service',
        heading: 'The service',
        paragraphs: [
          'MinimaSpend lets you track expenses, income and budgets in your browser. Your data is encrypted on your device with a key that only you can unlock.',
          'You can use the app without an account. An account is optional and is needed only for sync across devices. Sync across devices is optional and in beta.',
        ],
      },
      {
        id: 'beta',
        heading: 'A beta service without warranty',
        paragraphs: [
          'MinimaSpend is in beta. Features may change, break or be removed, and the service may be unavailable at times.',
          'The app is provided "as is" and "as available", without any warranty, express or implied, including fitness for a particular purpose. It is a budgeting tool, not financial, tax or legal advice.',
        ],
      },
      {
        id: 'sync-pricing',
        heading: 'Sync and pricing',
        paragraphs: [
          'Sync across devices is free for every signed-in user during the beta.',
          'Sync may become a paid feature later. We will tell you at least 30 days before any charge applies. You can then choose to:',
        ],
        bullets: [
          'keep using MinimaSpend in local mode on your devices, for free;',
          'export your data or download a backup;',
          'delete your cloud data or your account.',
        ],
      },
      {
        id: 'your-keys',
        heading: 'Your password and recovery key',
        paragraphs: [
          "You are responsible for your encryption password and your recovery key. Keep them safe and don't share them.",
          "MinimaSpend never sees them and can't reset them. If you lose both, your data can't be recovered by anyone, including us.",
        ],
      },
      {
        id: 'acceptable-use',
        heading: 'Acceptable use',
        paragraphs: ['When you use MinimaSpend, you agree not to:'],
        bullets: [
          'break the law or help anyone else break it;',
          "try to access other people's accounts or data;",
          'attack, overload or probe the service, or get around its limits;',
          'use the service to store or spread malware or content you have no right to store.',
        ],
      },
      {
        id: 'liability',
        heading: 'Limitation of liability',
        paragraphs: [
          `To the extent the law allows, ${LEGAL_OPERATOR_NAME} is not liable for any indirect or consequential loss, or for lost data, profits or savings, arising from your use of the app.`,
          "Keep your own backups: the app can export your data and download encrypted backups at any time. Nothing in these terms limits rights you have under laws that can't be changed by contract.",
        ],
      },
      {
        id: 'ending',
        heading: 'Ending your use',
        paragraphs: [
          'You can stop using MinimaSpend at any time, remove the data from your device and delete your account.',
          'We may suspend an account that breaks these terms, or end the service. If we end the service, we will give you reasonable notice so you can export your data.',
        ],
      },
      {
        id: 'changes',
        heading: 'Changes to these terms',
        paragraphs: [
          'We may update these terms. The date at the top shows the latest version. For important changes we will tell you in the app before they apply.',
        ],
      },
      {
        id: 'contact',
        heading: 'Contact',
        paragraphs: [
          `MinimaSpend is run by ${LEGAL_OPERATOR_NAME}. Questions about these terms: ${LEGAL_CONTACT_EMAIL}.`,
        ],
      },
    ],
  },
  privacy: {
    title: 'Privacy Policy',
    lastUpdated: LEGAL_LAST_UPDATED,
    intro: [
      "MinimaSpend is built so that we know as little about you as possible. Your financial data is encrypted on your device before it is stored, and we can't read it.",
      'This policy explains, in plain language, what leaves your device, who handles it and how to delete it.',
    ],
    sections: [
      {
        id: 'local',
        heading: 'Using MinimaSpend without an account',
        paragraphs: [
          "Without an account, your expenses, income, categories and budgets stay in your browser's storage on your device, encrypted with your password. Nothing is sent to our servers.",
          'The only request the app makes is for exchange rates: it sends a date to the National Bank of Ukraine (NBU), without cookies or any information about you or your data.',
        ],
      },
      {
        id: 'account',
        heading: 'If you create an account',
        paragraphs: [
          'You sign in with Google. We then receive your email address, and the name and profile picture that Google shares. They are used only to identify your account.',
        ],
      },
      {
        id: 'sync',
        heading: 'If you use sync',
        paragraphs: [
          'Sync across devices is optional and in beta. When you turn it on, the server stores:',
        ],
        bullets: [
          "each record as encrypted data that we can't read: amounts, categories, descriptions and even the kind of record stay encrypted;",
          'for each record an opaque record key (a keyed hash that reveals neither the kind of record nor its id), the time it was last edited, the size of the encrypted record and which of your devices wrote it;',
          'a copy of your vault header: the encrypted (wrapped) keys and the salts needed to unlock your data on another device;',
          'the names of your devices, for example "Chrome on Android", and when each device was last seen.',
        ],
      },
      {
        id: 'password-strength',
        heading: 'Why a strong password matters',
        paragraphs: [
          'The vault header copy is protected by your password. Someone who got hold of it could try to guess your password offline, without any limit on attempts. A long, unique password makes this impractical.',
        ],
      },
      {
        id: 'logs',
        heading: 'Server logs',
        paragraphs: [
          'Like any website, the services we use keep technical logs, such as IP addresses, browser type and request times, to run the service and keep it secure. These logs are kept by the processors below, under their own policies.',
        ],
      },
      {
        id: 'processors',
        heading: 'Who processes data for us',
        paragraphs: ['We use these services:'],
        bullets: [
          'Supabase: accounts, sign-in and the database for sync;',
          'Vercel: hosting of the website;',
          'Google: sign-in with your Google account;',
          'National Bank of Ukraine (NBU): exchange rates, which receives only dates.',
        ],
      },
      {
        id: 'no-tracking',
        heading: 'No ads, no selling, no tracking',
        paragraphs: [
          "MinimaSpend shows no ads. We don't sell, rent or share your data with anyone. The app has no analytics, no trackers and no advertising cookies.",
        ],
      },
      {
        id: 'retention',
        heading: 'How long data is kept and how to delete it',
        paragraphs: [
          'Your account and cloud data are kept until you delete them.',
          'To delete your account and your encrypted cloud data, open Settings → Account → Delete account. To delete only your cloud data and keep the account, open Settings → Sync → Delete cloud data; the data on your devices is kept.',
          'To remove data from your device, open Settings → Data → Remove data from this device.',
        ],
      },
      {
        id: 'recovery',
        heading: 'Your password and recovery key',
        paragraphs: [
          "We never receive your password or your recovery key. If you lose both, nobody can decrypt your data, including us, and it can't be recovered.",
        ],
      },
      {
        id: 'changes',
        heading: 'Changes to this policy',
        paragraphs: [
          'We may update this policy. The date at the top shows the latest version. For important changes we will tell you in the app before they apply.',
        ],
      },
      {
        id: 'contact',
        heading: 'Contact',
        paragraphs: [
          `MinimaSpend is run by ${LEGAL_OPERATOR_NAME}, who is responsible for your data. Questions or requests about your data: ${LEGAL_CONTACT_EMAIL}.`,
        ],
      },
    ],
  },
}
