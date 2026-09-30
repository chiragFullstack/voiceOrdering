# Smash & Go — Voice Order-Taker

A voice agent that takes a complete food order for the **Smash & Go** cloud kitchen: understands
items and modifiers, keeps a running total and reads it back, handles changes mid-call, confirms the
whole order before ending, and declines off-menu requests gracefully.

Runs with **zero configuration and no API keys**. Speech in and out is the browser's own Web Speech
API; understanding is a deterministic engine built from the menu file.

---

## Quick start

```bash
npm ci
npm run dev          # http://localhost:3000
```

Click **Start call** and order the way you would on the phone. Chrome or Edge will listen; any
browser can type instead, through the identical pipeline.

### Verify everything

```bash
npm run verify       # typecheck + lint + 102 tests + production build
```

### Deploy as a single zip

```bash
npm run pack         # -> dist/smash-and-go-voice-order.zip
```

On the server:

```bash
unzip smash-and-go-voice-order.zip
npm ci
npm run build
npm start            # honours PORT, defaults to 3000
```

Requires **Node 20.9+**. Put it behind HTTPS: browsers only grant microphone access on a secure
origin (`localhost` excepted).

---

## The data model

The schema splits cleanly in two, and that split is the point.

### 1. Catalogue — `data/menu.json` (immutable reference data)

```
Menu
├── categories[]      Burgers · Sides · Drinks · Combo Meals
├── optionGroups[]    the variants and modifiers items may carry
│   ├── kind: "variant"   exactly one, required   (Size, Flavour)
│   ├── kind: "modifier"  zero or more, optional  (Extra Cheese, No Onions)
│   ├── defaultChoiceId   used when the caller does not say
│   ├── askWhenUnspecified  agent asks rather than assuming silently
│   └── choices[]  { id, name, priceDelta, aliases[] }
├── items[]
│   ├── basePrice
│   ├── optionGroupIds[]   ← references shared groups, never copies them
│   ├── aliases[]          ← drives the speech lexicon
│   ├── shortcuts[]        ← "coke" = Soft Drink + flavour:Coke
│   └── components[]       ← what a combo contains
└── offMenu[]         the curveball answers, as data
```

One `burger-addons` group is defined **once** and referenced by all five burgers. Adding a sixth
burger means adding an item; the add-ons come with it.

### 2. Order — transaction state

```
Order
├── id, status, createdAt, updatedAt
└── lines[]
    ├── itemId          ← a reference
    ├── quantity
    └── selections[]    ← { groupId, choiceId } — several per line
```

**A line stores no price.** "Two Zingers, extra cheese, fried egg, no onions" is *one* line with
`quantity: 2` and three selections.

### 3. Pricing — derived on every read, never stored

`src/domain/pricing.ts` is the only module that produces money:

```
unitPrice = item.basePrice + Σ(selected choice.priceDelta)
lineTotal = unitPrice × quantity
subtotal  = Σ(lineTotal)
vat       = round(subtotal × vatRatePercent)     // half-up, 0% by default
total     = subtotal + vat
```

Change a price in `menu.json` and every open order re-prices itself on the next read. There is no
cached subtotal, so a total can never drift from the menu. Press **Show maths** in the app to see
the arithmetic per line, or **Data model** to see the stored line beside its derived price.

All money is **integer minor units** (fils, 100 per dirham). Floating point is never used for money.

---

## How a turn works

```
microphone ──▶ utterance ──▶ POST /api/session/:id/turn
                                   │
                              parse (NLU)          src/nlu/
                                   │  intents
                              agent state machine  src/agent/
                                   │  pure order ops
                              order reducer        src/domain/order.ts
                                   │
                              price derivation     src/domain/pricing.ts
                                   │
        spoken reply ◀── compose ◀─┘
```

The **browser sends words, never prices**. The server owns the order, so nothing a client does can
change a total.

### Understanding, without a model

`src/nlu/` builds its entire vocabulary from `menu.json`:

| Stage | What it does |
| --- | --- |
| `normalize.ts` | contractions, filler words, number words, clause splitting |
| `lexicon.ts` | phrase → item / option / category / off-menu, built from the catalogue |
| `match.ts` | sliding-window matching; exact wins, fuzzy above 0.82, ties → clarify |
| `parse.ts` | cue words + matches → typed intents |

Ambiguity is surfaced, not guessed: "a chicken burger" matches two items equally, so the agent asks
*"Did you mean the Grilled Chicken Burger or the Crispy Chicken Burger?"* — and remembers the
quantity you asked for while it waits.

### Conversation states

```
greeting → ordering ⇄ clarifying → confirming → completed
              ↑                        │
              └────── "no" ────────────┘
```

Nothing reaches the kitchen until the whole order has been read back and confirmed.

### Asking instead of assuming

A variant group with `askWhenUnspecified: true` makes the agent ask when the caller
did not choose — drink size is the one flagged in the shipped catalogue:

```
YOU   : a soft drink
AGENT : Got it — a Coke. What size would you like — small, medium or large?
YOU   : large
AGENT : Updated — a Large Coke. You're at 10 dirhams so far. Anything else?
```

Three things make this a question rather than a phone tree:

- **It only asks what it has to.** Say "a large coke" and it never asks; the
  caller already answered.
- **The default is applied immediately**, so the line is priceable from the
  first instant and the caller may simply ignore the question — "a soft drink…
  and large fries" leaves the Medium standing and carries on.
- **It asks once per line**, not once per option, and never on a repeat of a
  drink already configured.

To ask about fries size too, add `"askWhenUnspecified": true` to the
`fries-size` group in `data/menu.json` — no code change. The catalogue is
validated to ensure a flagged group is a variant that has a `defaultChoiceId`,
so the agent can never ask a question it has no fallback for.

---

## What it handles

| Requirement | Example | Behaviour |
| --- | --- | --- |
| Items + modifiers | *"a spicy zinger with extra cheese and no onions"* | one line, two modifiers, AED 34 |
| Sizes / variants | *"two large fries"*, *"a large coke"* | variant applied and named aloud |
| Asks when unsaid | *"a soft drink"* | *"What size would you like — small, medium or large?"* (medium if unanswered) |
| Running total | after every change | *"You're at 64 dirhams so far."* |
| Change mid-order | *"actually make it two"* | quantity set on the last line touched |
| Cancel a line | *"cancel the fries"* | that line only; total re-derived |
| Remove a modifier | *"actually no cheese"* | modifier dropped, price falls |
| Start over | *"let's start over"* | order cleared, call continues |
| Off-menu curveball | *"do you have pizza?"* | *"Sorry — we don't do pizza. What I can do is the Double Chicken Smash or the Classic Combo."* |
| Confirm before ending | *"that's everything"* | full read-back + total, then waits for a yes |

Try these from the **Try saying** chips in the app.

---

## Project layout

```
data/menu.json              the catalogue — the single source of truth
src/domain/                 types · money · menu loading · order ops · pricing
src/nlu/                    normalise · lexicon · match · parse
src/agent/                  state machine · speech rendering · sessions · service
src/app/api/                menu · health · session · turn
src/components/             menu board · transcript · ticket · inspector
src/hooks/                  Web Speech recognition and synthesis
src/lib/                    config · logging · errors at the HTTP edge · rate limit
tests/                      102 tests across menu, pricing, parsing and conversation
```

### Changing the menu

Edit `data/menu.json` and restart. The catalogue is validated at boot — schema *and* referential
integrity (every `optionGroupId`, `choiceId`, `categoryId` and combo component must exist) — so a
broken menu fails loudly with a list of problems instead of mispricing an order. `GET /api/health`
reports the loaded catalogue, which makes a bad deploy visible immediately.

---

## Error handling

Every deliberate failure is an `AppError` with a stable code, an HTTP status and a message that is
safe to show a customer. `src/lib/api.ts` wraps every route: it assigns a request id, rate-limits,
validates the body with Zod before parsing anything large, maps `AppError` to its status, and turns
anything unexpected into a generic 500 — with the real cause in the logs and the request id in the
response, so a reported failure maps to one log line.

Inside a turn, each intent is applied in its own try/catch: a misheard modifier is reported
conversationally and the rest of the sentence still runs.

| Code | Status | When |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | bad body, empty or oversized utterance |
| `SESSION_NOT_FOUND` / `SESSION_EXPIRED` | 404 / 410 | unknown or idle-timed-out call |
| `SESSION_CLOSED` | 409 | the order was already confirmed |
| `OPTION_NOT_ALLOWED` | 422 | an option the item does not offer |
| `RATE_LIMITED` | 429 | per-IP budget exceeded (`retry-after` set) |
| `MENU_INVALID` | 500 | `menu.json` failed validation at boot |

In the browser, failures surface as a dismissible notice carrying the request id, and a lost session
drops the call cleanly rather than leaving a dead microphone.

---

## Security

- **The server owns the order.** Clients send an utterance string; prices and line ids are never
  trusted from the browser.
- **Everything is validated.** Zod schemas on request bodies, route params and the menu file;
  utterances are length-capped and bodies are size-capped before parsing.
- **Errors never leak.** Stack traces and internal messages stay in the logs; responses carry a code,
  a safe message and a request id.
- **Session ids** are 128-bit CSPRNG UUIDs, opaque, and expire on idle (30 min default).
- **Rate limiting** per client, with back-pressure and LRU eviction on the session store.
- **Strict CSP** and `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, and a
  `Permissions-Policy` that grants the microphone only to this origin. No third-party scripts, fonts
  or analytics — the app talks only to itself.
- **Speech is not logged** at `info`; utterances appear only at `debug`, which is off by default.
- `ORDER_LOG_DIR` is confined to the project directory, so a stray value cannot write elsewhere.
- No payments, accounts or POS integration — deliberately out of scope.

---

## Configuration

Every variable is optional; the app runs with an empty environment. See `.env.example`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SESSION_TTL_MINUTES` | `30` | idle lifetime of a call |
| `MAX_SESSIONS` | `500` | concurrent calls held in memory |
| `RATE_LIMIT_MAX_REQUESTS` | `90` | per-IP budget |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | budget window |
| `ORDER_LOG_DIR` | unset | append confirmed orders as JSON Lines |
| `LOG_LEVEL` | `info` | `debug` also logs utterances |

---

## Known limits

- **Browser support.** Web Speech recognition is Chrome/Edge (and partially Safari). Elsewhere the
  app detects this, says so, and offers the text box — which runs the same agent end to end.
- **One process holds the sessions.** See below — this decides where to host it.
- **English only.** The lexicon and cue words are English; the recogniser language is `en-US`.

### Hosting: use a long-running server, not serverless

Call sessions live in memory (`src/agent/sessionStore.ts`), so **every turn of a call must reach the
same process**. That is true on any single Node server and is why the app needs no database.

It is *not* true on serverless platforms. On Vercel, Netlify Functions, Lambda and friends, each
request may land on a fresh instance, so a call can break mid-order with *"That call session no
longer exists"* — intermittently, and more often the longer the order.

| Host | Works? |
| --- | --- |
| Render, Railway, Fly.io, a VPS, Docker, `npm start` | Yes — one process, nothing to configure |
| Vercel / Netlify / Lambda | Not reliably — sessions are per-instance |

Two ways to run it on serverless if you must:

1. Swap the store. `sessionStore.ts` is four functions (`createSession`, `requireSession`,
   `saveSession`, `deleteSession`) behind which Redis or Vercel KV drops in without touching the
   agent.
2. Make the session stateless — carry the order in a signed token instead of server memory. Prices
   stay server-derived either way, so this does not weaken the "server owns the total" rule.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | liveness, catalogue summary, session stats |
| `GET` | `/api/menu` | the catalogue (cached, static) |
| `POST` | `/api/session` | start a call → session id + greeting |
| `GET` | `/api/session/:id` | current state (survives a page reload) |
| `DELETE` | `/api/session/:id` | hang up |
| `POST` | `/api/session/:id/turn` | `{ "utterance": "..." }` → reply + priced order |
