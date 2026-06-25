# Hot 100 Creator Discovery Tool

Automated weekly ranking of the fastest-rising YouTube creators (100k–1M subscribers) by view velocity, engagement rate, and audience quality.

## Stack

- **Frontend**: React + Tailwind CSS + shadcn/ui
- **Backend**: Express.js (Node)
- **Database**: SQLite (local, no setup needed)
- **APIs**: Tubular Labs Intelligence API + Modash Discovery API

## Running Locally (Cursor / VS Code)

### Prerequisites
- Node.js 18+
- npm

### Setup

```bash
# 1. Install dependencies
npm install

# 2. Start the dev server (frontend + backend on port 5000)
npm run dev
```

Open **http://localhost:5000** in your browser.

### First-Time Setup

1. Go to **Settings** in the sidebar
2. Paste your **Tubular Labs API Key** (Bearer token from the Intelligence API)
3. Paste your **Modash API Key**
4. Adjust the discovery filters if needed (defaults: 100k–1M subs, 3%+ ER, 20%+ velocity)
5. Click **Save Settings**
6. Return to **Dashboard** → click **Run This Week**

The sync takes a few minutes. Modash enrichment is rate-limited to 300ms per creator.

## How the Score Works

| Signal | Weight | Source |
|--------|--------|--------|
| View Velocity (30d %) | 40% | Tubular — 7d daily avg vs prior 23d |
| Engagement Rate | 30% | Modash audience data |
| Upload Consistency | 15% | Tubular — videos/week |
| Audience Quality | 15% | Modash — inverted fake follower rate |

All signals are normalized (0–100) within the week's batch before combining.

## Features

- Weekly ranked list of top 100 creators
- Filter by genre, sort by any metric
- Bookmark creators for follow-up
- Edit contact/agency/manager info per creator
- Export full list to CSV
- Report history — all past weeks saved

## Project Structure

```
hot100/
├── client/src/
│   ├── pages/
│   │   ├── Dashboard.tsx     # Report list + run button
│   │   ├── ReportDetail.tsx  # Creator table with filters
│   │   └── Settings.tsx      # API keys + filter config
│   └── components/
│       └── Layout.tsx        # Sidebar navigation
├── server/
│   ├── routes.ts             # API endpoints
│   ├── storage.ts            # SQLite CRUD layer
│   ├── tubular.ts            # Tubular Labs API client
│   ├── modash.ts             # Modash API client
│   └── scoring.ts            # Hot Score engine
└── shared/
    └── schema.ts             # Database schema + types
```
