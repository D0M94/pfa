# App.map.md — index of `App.jsx`

Auto-generated. 4720 total lines. Read this file before reading `App.jsx`. When you need a slice, use `Read` with `offset` and `limit` on the line range.

## Sections (high-level layout)

| Line | Section |
|------|---------|
| 10-15 | Supabase |
| 17-52 | Constants + utilities |
| 54-64 | SheetJS loader (lazy, only when a spreadsheet is attached) |
| 66-93 | Adaptive categorization |
| 95-158 | Revolut CSV parser (client-side, no token limits) |
| 160-246 | Erste XLSX parser (client-side, no token limits) |
| 248-270 | fileToText (xlsx→clean CSV for Claude fallback) |
| 272-316 | Default Data |
| 317-353 | GDPR constants + UI Primitives |
| 354-522 | Auth |
| 523-614 | Privacy Policy Modal + GDPR Consent Gate |
| 615-688 | Account Settings Modal |
| 689-711 | Month Picker helper |
| 712-897 | EditableTxnRow + GettingStarted |
| 898-1194 | Costs Tab |
| 1195-1459 | File Upload Card |
| 1461-1708 | Cash Flow Tab |
| 1709-1934 | Savings Goals |
| 1935-2377 | Portfolio Card with manual entry |
| 2378-3049 | Wealth Tab |
| 3050-3117 | Budget Intelligence |
| 3118-3195 | BudgetBar |
| 3196-3421 | Budget Section (embedded in Costs tab) |
| 3422-3519 | AI System Prompt + parseImportBatch |
| 3520-3900 | MonthlySweep + QuickAdd |
| 3900-4407 | AIChat |
| 4408-4720 | Error Boundary + App Shell |

## React components

| Lines | Name |
|-------|------|
| 326-353 | `Card`, `Btn`, `Inp`, `Sel`, `Stat`, `Tag` |
| 355-522 | `Auth` |
| 524-566 | `PrivacyPolicyModal` |
| 569-614 | `GDPRConsentGate` |
| 616-688 | `AccountSettingsModal` |
| 690-711 | `MonthPicker` |
| 713-786 | `EditableTxnRow` |
| 788-897 | `GettingStarted` |
| 899-1194 | `Costs` |
| 1260-1459 | `FileUploadCard` |
| 1462-1708 | `CashFlow` |
| 1710-1911 | `SavingsGoals` |
| 1912-1934 | `QuickUpdateAmount` |
| 1959-2377 | `PortfolioCard` |
| 2419-3049 | `Wealth` |
| 3119-3195 | `BudgetBar` |
| 3270-3421 | `BudgetSection` |
| 3562-3734 | `MonthlySweep` |
| 3749-3899 | `QuickAdd` |
| 3901-4407 | `AIChat` |
| 4436-4720 | `AppInner` (App Shell) |

## Helper functions

| Lines | Name |
|-------|------|
| 46-50 | `toHUF` |
| 51 | `fmtHUF` |
| 56-64 | `loadXLSX` |
| 68-87 | `buildLearnedRules` |
| 89-93 | `inferCategory` |
| 96-158 | `tryParseRevolutCSV` |
| 163-246 | `tryParseErsteXLSX` |
| 248-270 | `fileToText` |
| 1944-1958 | `derivePosition` |
| 2399-2418 | `maybeSnapshotNW` |
| 3058-3064 | `offsetMonth` |
| 3065-3072 | `sumExpensesInMonth` |
| 3073-3085 | `detectFixedRecurring` |
| 3086-3095 | `variableRecurringAvg` |
| 3096-3117 | `computeCategorySpend` |
| 3423-3519 | `buildSystemPrompt` |
| 3520-3542 | `parseImportBatch` |
| 3543-3550 | `buildDupKey` |
| 3551-3556 | `markDuplicates` |

## Top-level constants

| Line | Name |
|------|------|
| 15 | `DEMO_ID` |
| 18 | `EUR_HUF` |
| 19 | `USD_HUF` |
| 43 | `CATEGORIES` |
| 44 | `PIE_COLORS` |
| 273 | `EMPTY_DATA` |
| 280 | `DEMO_DATA` |
| 1196 | `UPLOAD_GUIDES` |
| 1936 | `EMPTY_POSITION` |
| 3051 | `EXPENSE_CATEGORIES` |
| 3055 | `VARIABLE_RECURRING_CATEGORIES` |
| 3555 | `FILE_TYPE_LABELS` |

---
Regenerate this map by running `python scripts/generate_map.py` after any change that adds or removes more than ~10 lines.
