# Marketing Plan (no / low budget) — 2026-11-16

A 90-day plan for one person spending about 3–5 hours a week and under $50 in total. It builds on the positioning and competitor analysis in `docs/project-review-2026-11-13.md`.

The channel suggestions come from general knowledge of these communities, not fresh research. Check each community's current self-promotion rules before posting. The targets are assumptions to measure against, not forecasts.

---

## 1. What we are selling

**One sentence:** the private expense tracker: encrypted on your device, no account, no bank password; add an expense in seconds, even offline.

**Proof points to repeat everywhere** (all true today):

- Works with no sign-up. Open the page and start.
- Data is encrypted on the device; a recovery key, not a server, rescues a forgotten password.
- Works offline and installs to the home screen.
- Ukrainian and English, UAH with NBU rates.
- Leave any time: CSV export and an encrypted backup file.

**Do not claim** until it is true: "syncs nothing" (once sync is on), "free forever, no premium" (once a paid tier is planned), bank import.

## 2. Who it is for

| Audience | Why they care | Lead message |
| --- | --- | --- |
| Ukrainians with several banks plus cash | monobank's own statistics cover one bank only | "All your spending in one place, without giving any app your bank login" |
| Privacy-minded people (UA and international) | Do not want finances on someone's server | "Encrypted on your device. No account. We cannot see your data." |
| Couples and families (after the Family beta) | Shared budget apps are not end-to-end encrypted | "A shared family budget only your family can read" |
| Developers and local-first enthusiasts | Interested in how it is built | "A local-first PWA with an end-to-end encrypted sync engine: how it works" |

Start with the first two. They need nothing that is still behind a flag.

## 3. Before any promotion (weeks 1–2)

Promotion sends people to the landing page once; make that visit count.

- [ ] **Fix the landing copy** so it matches the roadmap (see review, item 6).
- [ ] **Buy a domain** (about $10–15 a year). `minima-spend.vercel.app` looks like a demo and weakens a trust-based pitch. This is the one expense worth making.
- [ ] **Fill in the legal operator name and contact email** (`src/lib/legal.ts`).
- [ ] **Add a "How your data is protected" page**: plain-language summary of the vault design, in both languages. It is the main sales asset for a privacy product.
- [ ] **Add a feedback route**: an email address or a public issue tracker linked from Settings and the landing page.
- [ ] **Prepare assets once**: 5 screenshots (phone, both languages), a 30-second screen recording of "open → add expense → see chart", a 1-paragraph and a 1-line description in Ukrainian and English.
- [ ] **Decide how to count results** (see §7).

**Decision for the owner: open-source the code or not.** For an app whose pitch is "trust us, it is encrypted", public code is the strongest free marketing available. It unlocks open-source directories and makes the developer-audience posts far more credible. The cost is that the code can be copied. If the full repo stays private, consider publishing at least the crypto and vault modules.

## 4. Channels

### Ukraine (primary)

| Channel | Action | Cost |
| --- | --- | --- |
| **DOU.ua** | A first-person article: why and how you built a local-first encrypted tracker, with honest numbers. Developers are early adopters and DOU readers respond to build stories. | Free |
| **dev.ua, mezha.ua, kosht.media** | Short pitch email with the assets. All three have recently covered independent Ukrainian finance apps (see the sources in the review). kosht.media publishes app round-ups; ask to be considered for the next one. | Free |
| **Telegram and Facebook** | Personal-finance and IT channels and groups. Ask the admin first; offer a short useful post ("how to track cash and several banks privately"), not an advert. | Free |
| **Threads / X / LinkedIn (Ukrainian tech)** | Build in public: one short post a week with a screenshot (a feature shipped, a number, a lesson). | Free |
| **Friends and colleagues** | Ask 10–20 people directly to use it for two weeks and tell you what annoyed them. Worth more than any post at this stage. | Free |

### International (secondary, English)

| Channel | Action | Cost |
| --- | --- | --- |
| **Hacker News (Show HN)** | One launch post focused on the engineering: local-first, key hierarchy, encrypted sync. Be present in the comments all day. One shot; do it after the trust page exists. | Free |
| **Reddit** | Privacy, PWA, local-first and web-dev communities, where a "here is how I built it" post is welcome. Avoid general personal-finance subreddits, which usually ban self-promotion. | Free |
| **Product Hunt** | A launch once sync and Family are live, so there is a complete story. | Free |
| **Directories** | AlternativeTo (list as an alternative to Cashew, Spendee, Actual), PWA directories, privacy-tool lists. Slow but permanent traffic. | Free |
| **Local-first community** | Share the sync-engine write-up where local-first developers gather (newsletters, Discord groups). | Free |

### Search (slow, compounding)

- Ukrainian landing sections or pages for what people actually search: "облік витрат", "додаток для обліку витрат без реєстрації", "сімейний бюджет додаток".
- Comparison pages written fairly: MinimaSpend next to monobank statistics, Cashew, Spendee. Say where the other is better.
- Two or three evergreen articles: how to start tracking expenses, how to track cash, how encryption protects a budget app.
- The legal and trust pages are already server-rendered; keep every new marketing page server-rendered too.

### Inside the product (free growth loops)

- **Family invites.** Every Family space brings at least one new user. This is the only built-in viral loop; make the invite flow and the joiner's first minute excellent.
- **Import as a migration path.** A short guide per competitor: "moving from X: export CSV, import here". The importer already exists.
- **Install prompt.** An installed PWA is opened far more often than a bookmark. The iOS hint exists; check the Android prompt too.
- **A quiet "Share MinimaSpend" link** in Settings, using the system share sheet. No pop-ups, no referral rewards.

### App stores (optional, low cost)

- **Google Play** through a Trusted Web Activity wrapper of the PWA: a one-time developer fee of about $25. Many users only look for apps in the store, so this is the second expense worth considering.
- **Apple App Store:** skip for now. It costs about $99 a year and thin web wrappers are often rejected.

## 5. Content to write once and reuse

1. **"Why I built an expense tracker that cannot see your expenses"**: the story (Ukrainian for DOU, English for the blog and HN).
2. **"How MinimaSpend protects your data"**: the trust page.
3. **"Building encrypted sync for a local-first app"**: the technical deep dive, drawn from the ADRs.
4. **Short demo video**: the 30-second recording, reused in every post.

Each piece becomes: one long post, three or four short social posts, and one directory description.

## 6. Timeline

| Weeks | Focus | Output |
| --- | --- | --- |
| 1–2 | Preparation (§3) | Domain, corrected landing, trust page, assets, feedback route |
| 3–4 | Private test | 10–20 people you know; fix the top three complaints |
| 5–6 | Ukrainian soft launch | DOU article, media pitches, first Telegram/Facebook posts |
| 7–8 | Listen and fix | Reply to every comment; ship the most-requested small fix and post about it |
| 9–10 | International launch | Show HN, Reddit, directories; technical write-up |
| 11–12 | Sync / Family beta story | Announce the beta to existing users first, then Product Hunt |
| Ongoing | Rhythm | One build-in-public post a week, one article a month |

If the sync and Family beta is not ready by week 11, do not delay the rest; move that launch later.

## 7. Measuring without breaking the privacy promise

The spec rules out telemetry on user data, and the app has no accounts by default, so normal product analytics are not available. Use only:

- **Landing-page visits and referrers** from a cookieless, aggregate counter on the public pages only (never inside the app). *Decision for the owner:* even this should be stated in the privacy policy.
- **"Start tracking" clicks** on the landing page, counted the same way.
- **Accounts created and Family spaces created** (server-side counts in Supabase, once those flags are on).
- **Feedback volume**: emails, issues, comments.
- **Search impressions** from Google Search Console.

**90-day targets (assumptions):** 2,000 landing visits, 300 "Start tracking" clicks, 30 pieces of direct feedback, 2 media or community mentions, 50 accounts after the sync beta opens.

## 8. Budget

| Item | Cost | Needed? |
| --- | --- | --- |
| Domain | about $10–15 / year | Yes |
| Google Play developer account | about $25 once | Optional |
| Everything else | $0 | |
| **Total** | **under $50** | |

## 9. What not to do

- **No paid ads or paid influencers.** Without analytics you cannot tell whether they work.
- **No cross-posting the same advert into many groups.** It gets accounts banned and damages a trust-based brand.
- **No growth tricks inside the app**: no sign-up walls, nag pop-ups, or review prompts. They contradict "minimal".
- **No promises ahead of the code.** Announce a feature when it ships.
