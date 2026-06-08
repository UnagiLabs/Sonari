<p align="center">
  <img src="dapp/public/assets/sonari_logo.png" alt="Sonari logo" width="260" />
</p>

# Sonari

**Transparent donation infrastructure that verifies who should receive aid.**

Sonari is building a donation platform where sponsors, donors, and communities can create transparent funding pools, define support programs, and verify who should receive aid through Nautilus-backed decisioning.

## Why Sonari

Donation is one of the most important ways society moves money toward people and communities in need. But trust often breaks after funds are collected: donors may not know whether aid reached the right people, recipients may not know why they were selected or excluded, and communities may not be able to explain how money was reserved, routed, or spent.

The problem becomes sharper in urgent support programs such as disaster relief. Funds can move through multiple organizations, manual approvals, and reporting workflows before reaching recipients. Each intermediary step can add delay, administrative cost, and opacity at the exact moment when direct support matters most.

Sonari is built for donation programs where both funding and recipient selection need to be transparent. It treats aid as programmable infrastructure: donated funds sit in visible pools, support programs define explicit eligibility rules, Nautilus verifies real-world facts, and Sui Move enforces how funds can be paid.

## Market Opportunity

Charitable giving is a large real-world capital flow, not a niche behavior. In the United States alone, [Giving USA 2025](https://givingusa.org/giving-usa-2025-u-s-charitable-giving-grew-to-592-50-billion-in-2024-lifted-by-stock-market-gains/) estimates that charitable giving reached **$592.50 billion in 2024**. Globally, the [CAF World Giving Index / World Giving Report](https://www.cafonline.org/insights/research/world-giving-index) tracks giving as a broad international behavior across countries, cultures, and income levels.

For Sui, this creates an opportunity beyond crypto-native DeFi liquidity: real-world donation capital can become transparent, programmable, and auditable on-chain TVL. Sonari is designed to make that capital useful for sponsors, donors, communities, and recipients without weakening the trust boundaries that aid programs require.

## Sonari's Edge

Most donation platforms show where money was collected. Sonari goes further: it makes the eligibility decision itself verifiable. The first MVP is **parametric disaster support**, where Nautilus checks real-world earthquake impact and produces transparent proof that a recipient is in an affected area before aid is paid.

Sonari combines transparent donation pools, explicit support policies, Nautilus-backed eligibility verification, direct aid payments, and impact receipts. The result is a donation platform where sponsors and donors can inspect how funds are used, communities can explain why support was distributed, and recipients can claim aid under rules enforced by Sui Move.

> Sonari is donation-backed support infrastructure, not insurance. Donations do not create guaranteed payouts. Aid depends on pool balances, eligibility rules, program policy, fraud controls, and any verification requirements for the support program.

## What Sonari Solves

Donation programs often struggle to earn trust after funds are collected:

| Problem | What it means in practice |
| --- | --- |
| Fund opacity | Donors cannot easily see where money is reserved, routed, or spent. |
| Opaque recipient selection | It is often unclear why one person, household, or region receives support while another does not. |
| Manual operations | Aid teams must coordinate eligibility, approvals, treasury movement, and reporting by hand. |
| Weak impact visibility | Sponsors and communities lack clear receipts that connect donations to outcomes. |
| Hard-to-scale programs | Each new campaign or support category often needs a new operational process. |
| Slow emergency response | In time-sensitive cases, support may arrive after the most urgent window has passed. |

Sonari reframes donation programs as programmable aid flows: transparent pools, explicit policies, Nautilus-backed eligibility verification, and receipt trails that make both funding and recipient selection easier to inspect.

## Platform Concept

Sonari is built around five platform primitives:

| Primitive | Purpose |
| --- | --- |
| **Donation Pools** | Visible funding pools for general aid, campaigns, regions, disaster categories, or sponsor programs. |
| **Support Programs** | Programmable rules that define who can receive aid, when funds can be used, and which pool pays first. |
| **Nautilus Verification** | Transparent decisioning that checks external facts and produces auditable proof of who qualifies. |
| **Aid Payments** | Direct support sent to eligible recipients. In the first MVP, this appears as Relief Cash. |
| **Impact Receipts** | Transparent records that connect donations, eligibility decisions, recipients, and sponsor impact reporting. |

Parametric disaster relief is one support program type. Over time, the same platform can support other donation-backed aid flows where eligibility needs to be explained and audited, such as regional assistance, community grants, emergency campaigns, nonprofit distributions, or sponsor-funded programs.

## Platform Flow

```mermaid
flowchart LR
  donor[Sponsor, donor, or community] --> donation[Donation]
  donation --> pool[Donation Pool]
  pool --> program{Support Program}
  program --> earthquake[First MVP: parametric earthquake relief]
  program --> future[Future aid programs]
  future --> regional[Regional assistance]
  future --> grants[Community grants]
  future --> emergency[Emergency campaigns]
  earthquake --> nautilus[Nautilus eligibility verification]
  regional --> nautilus
  grants --> nautilus
  emergency --> nautilus
  nautilus --> decision[Auditable recipient decision]
  decision --> policy[Program policy checks]
  policy --> payment[Aid payment]
  payment --> recipient[Recipient]
  payment --> receipt[Impact Receipt]
  receipt --> dashboard[Donor and sponsor dashboard]
```

The long-term product loop is simple: collect donations into transparent pools, attach them to support programs, use Nautilus to verify who qualifies, move funds under clear rules, and make outcomes visible through receipts and dashboards.

## Core Participants

| Participant | Role |
| --- | --- |
| Donors and sponsors | Fund general pools, campaign pools, or program-specific pools. |
| Communities and operators | Create support programs and define how donated funds should be used. |
| Recipients | Receive aid when Nautilus verification and program rules show they qualify. |
| Nautilus verification layer | Checks external facts and produces auditable eligibility decisions for support programs. |
| Sui Move contracts | Enforce pool policy, eligibility, payout rules, and receipt creation. |
| Dashboard | Shows donation flow, pool balances, program status, claims, and impact reporting. |

## First MVP: Parametric Disaster Support

The initial MVP proves Sonari through an earthquake relief program:

```mermaid
sequenceDiagram
  participant Donor as Donor or Sponsor
  participant Pool as Donation Pool
  participant Watcher as Earthquake Watcher
  participant Nautilus as Nautilus / TEE
  participant Move as Sui Move
  participant User as Affected User
  participant Dashboard as Impact Dashboard

  Donor->>Pool: Fund Main Pool or Earthquake Pool
  Watcher->>Watcher: Detect candidate earthquake
  Watcher->>Nautilus: Request eligibility verification
  Nautilus->>Nautilus: Re-fetch source data and compute affected cells
  Nautilus-->>Move: Signed affected-area proof
  User->>Move: Claim Relief Cash
  Move->>Move: Verify proof, eligibility, policy, and balances
  Move-->>User: Aid payment and Impact Receipt
  Move-->>Dashboard: Decision, program, and receipt data
```

MVP payout priority:

1. Use the **Earthquake Pool** first for earthquake-specific support.
2. Use the **Main Pool** as a policy-controlled backstop when the Earthquake Pool is insufficient.
3. Produce an **Impact Receipt** so each payout can be connected back to the support program, Nautilus decision, verified event, and funding source.

This MVP is intentionally narrow. Earthquakes provide a concrete way to test Sonari's core difference from ordinary donation tools: transparent donations plus verifiable recipient selection. Nautilus determines whether a claimant is connected to an affected area, and Sui Move enforces the program rules before funds move.

## Why Sui

Sui is a strong fit for Sonari because donations, pools, program policies, eligibility proofs, receipts, and recipient-facing assets can be represented as composable on-chain objects. Programmable Transaction Blocks can combine multi-step aid flows into a single user action, while Move contracts enforce transparent rules around how donated funds are used.

## What to Remember

Sonari is a donation platform first. Its key difference is that Nautilus helps verify and decide who should receive support in a transparent, auditable way. Parametric earthquake relief is the first MVP because it clearly proves that model: transparent donations, explicit support rules, trusted external signals, verifiable recipient selection, aid payments, and impact receipts.
