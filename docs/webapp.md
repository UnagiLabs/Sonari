# Sonari Web App 設計図

## 1. 目的

Sonari Web App は、寄付者・受取者・法人スポンサー・運営者・外部閲覧者に対して、透明な寄付体験、検証可能な受取判定、災害支援 Claim、寄付者ランキング、法人スポンサー露出、Impact Receipt を提供する。

Sonari は保険ではなく、寄付による支援インフラである。UI上でも「補償」「保険金」「掛け金」「支払い保証」のような表現は避け、Donation、Aid、Relief Cash、Support、Impact、Verified Eligibility、Transparent Receipt を中心に表現する。

---

## 2. 主要ユーザー

| ユーザー | 目的 |
|---|---|
| Individual Donor | 寄付する、寄付履歴を見る、ランキングを見る |
| Corporate Sponsor | 寄付する、法人ロゴ露出を得る、支援実績を見る |
| Recipient | MembershipPass を発行し、対象災害で Claim する |
| Public Viewer | Pool残高、災害イベント、Receipt、ランキングを確認する |
| Admin / Operator | Program、Campaign、Pool、Sponsor、Oracle、Pauseを管理する |

---

## 3. ページ構成

    dapp/app/
      page.tsx

      dashboard/
        page.tsx

      donate/
        page.tsx

      donor/
        page.tsx

      leaderboard/
        page.tsx

      sponsors/
        page.tsx

      register/
        page.tsx

      claim/
        page.tsx
        history/
          page.tsx

      programs/
        page.tsx
        [programId]/
          page.tsx

      events/
        page.tsx
        [eventId]/
          page.tsx

      pools/
        page.tsx
        [poolId]/
          page.tsx

      receipts/
        page.tsx
        [receiptId]/
          page.tsx

      admin/
        page.tsx
        sponsors/
          page.tsx
        oracle/
          page.tsx
        pause/
          page.tsx

---

## 4. MVP優先度

### Phase 1: MVP必須

- /
- /dashboard
- /donate
- /donor
- /leaderboard
- /register
- /claim
- /events
- /events/[eventId]
- /pools
- /receipts

### Phase 2: 体験強化

- /sponsors
- /claim/history
- /programs
- /programs/[programId]
- /pools/[poolId]
- /receipts/[receiptId]

### Phase 3: Admin / 運用強化

- /admin
- /admin/sponsors
- /admin/oracle
- /admin/pause

---

## 5. グローバルナビゲーション

### Public Navigation

- Home
- Donate
- Dashboard
- Leaderboard
- Sponsors
- Claim

### Recipient Navigation

- Register
- Claim
- Claim History
- My Pass

### Transparency Navigation

- Pools
- Programs
- Events
- Receipts

### Admin Navigation

- Admin
- Sponsors
- Oracle
- Pause

---

# 6. 各ページ設計

---

## 6.1 `/` Landing Page

### 目的

初回訪問者に Sonari の価値を伝え、寄付・Claim・Dashboard確認へ誘導する。

### 主要CTA

| CTA | 遷移先 |
|---|---|
| Donate | /donate |
| Claim Relief | /claim |
| View Dashboard | /dashboard |

### セクション構成

1. Hero
2. SponsorLogoMarquee
3. LiveImpactStats
4. TopSupportersPreview
5. HowSonariWorks
6. FeaturedPools
7. WhySonari
8. TrustAndPrivacy
9. Footer

### Hero 表示内容

- Sonari の一言説明
- Donate CTA
- Claim Relief CTA
- Dashboard CTA
- 現在の総寄付額
- 現在の総支援額
- Active Pool 数
- Verified Claim 数

### 推奨コピー

Transparent donation infrastructure that verifies who should receive aid.

### SponsorLogoMarquee

法人スポンサーのロゴを左右に流す。

仕様:

- Row 1 は left to right
- Row 2 は right to left
- verified sponsor のみ表示
- featured sponsor を優先表示
- logoUrl は offchain 管理
- クリック時は /sponsors または sponsor website へ遷移
- Landing の Hero 直下に配置する

表示例:

    Supported by transparent partners

    [Logo A] [Logo B] [Logo C] [Logo D] [Logo E] →
    ← [Logo F] [Logo G] [Logo H] [Logo I] [Logo J]

### TopSupportersPreview

Landing上ではランキングの一部だけ表示する。

表示内容:

- Top 3 Individual Donors
- Top 3 Corporate Sponsors
- View Full Leaderboard CTA

---

## 6.2 `/dashboard`

### 目的

Sonari全体の状態を1画面で見せる。

### 表示項目

- Total Donated
- Total Paid Out
- Total Claims
- Active Pools
- Active Programs
- Latest DisasterEvent
- Main Pool balance
- Earthquake Pool balance
- Operations Pool balance
- Recent Donations
- Recent Claims
- Recent Impact Receipts
- Top Donors
- Top Corporate Sponsors

### コンポーネント

- ImpactStatsGrid
- PoolBalanceCards
- LatestDisasterEventCard
- RecentDonationList
- RecentClaimList
- TopDonorsCard
- TopSponsorsCard
- ReceiptFeed

---

## 6.3 `/donate`

### 目的

個人・法人が USDC で寄付できるページ。

### 寄付タイプ

| 寄付タイプ | 入金先 |
|---|---|
| General Donation | 100% Main Pool |
| Earthquake Donation | Designated Relief Pool + Main Pool split |
| Operations Donation | 100% Operations Pool |

### 表示項目

- Wallet Connect
- Donation type selector
- Pool selector
- Amount input
- Estimated split preview
- DonorPass mint/update preview
- Anonymous / Public display setting
- Corporate sponsor mode
- Donate button
- Transaction result

### 寄付後表示

- DonationRecord created
- DonorPass issued or updated
- New donor tier
- Current leaderboard rank
- View Donor Profile CTA
- View Receipt CTA

### 注意文言

DonorPass records contribution history only. It does not provide claim rights, payout priority, or guaranteed aid.

---

## 6.4 `/donor`

### 目的

接続中 wallet の寄付者プロフィールを表示する。

### 表示項目

- Wallet address
- Display name
- Donor type: individual / corporate
- DonorPass id
- Total donated
- Donation count
- Donor tier
- Overall rank
- Monthly rank
- Supported pools
- Donation history
- Badges

### ランキング表示

- Overall rank
- Monthly rank
- Pool-specific rank
- Campaign-specific rank

### 個人情報設定

- Public display name
- Anonymous mode
- Hide amount option

---

## 6.5 `/leaderboard`

### 目的

寄付者ランキングを公開表示し、寄付のモチベーションと透明性を高める。

### タブ構成

- Overall
- Monthly
- Individuals
- Corporate Sponsors
- Pool Ranking
- Campaign Ranking
- First Responders
- Consistent Supporters

### ランキング軸

| ランキング | 内容 |
|---|---|
| Total Donated Ranking | 累計寄付額順 |
| Monthly Ranking | 月間寄付額順 |
| Donation Count Ranking | 寄付回数順 |
| First Responders Ranking | 災害発生後、早く寄付した順 |
| Corporate Sponsors Ranking | 法人寄付額順 |
| Pool-specific Ranking | Pool別寄付額順 |
| Campaign-specific Ranking | Campaign別寄付額順 |

### 表示項目

- Rank
- Display name
- Avatar or Logo
- Donor type
- Tier
- Total donated
- Donation count
- Supported pools
- Latest donation date

### UIルール

- 個人は displayName または short address を表示する
- 匿名設定の個人は Anonymous Donor と表示する
- 法人は verified sponsor のみロゴ表示する
- 金額非公開設定の場合は順位とtierのみ表示する
- ランキング上位でも Claim 権利や Payout 優先権はない

---

## 6.6 `/sponsors`

### 目的

法人スポンサー一覧と支援実績を見せる。

### 表示項目

- Featured Sponsors
- Verified Corporate Sponsors
- Sponsor logo
- Sponsor name
- Total donated
- Supported programs
- Supported campaigns
- Impact receipts count
- Website link

### Sponsor Card

表示項目:

- logo
- name
- verified badge
- total donated
- supported pools
- latest impact
- website link

### 掲載条件

- verified = true
- logo approved by admin
- sponsor profile exists
- no scam / impersonation risk
- wallet と sponsor profile が紐づいている

---

## 6.7 `/register`

### 目的

受取者が MembershipPass を発行し、居住セルを登録する。

### 表示項目

- Wallet Connect
- Nickname
- MembershipPass status
- Registration status
- Residence verification status
- Residence area search
- Map-based residence cell selector
- Selected H3 cell read-only display
- Metadata refresh
- Register button

### 注意点

- H3 cell を直接入力させず、住所・地域検索、現在地、地図選択から選べるUIにする
- H3 cell 手入力は開発者・テスター向けの Advanced option に限定する
- nickname は表示用であり、Claim eligibility には使わない
- raw address はオンチェーンに出さない
- phone はオンチェーンに出さない
- email はオンチェーンに出さない
- GPS history はオンチェーンに出さない
- device info はオンチェーンに出さない
- 表示は H3 cell / verification status / pass status に限定する

---

## 6.8 `/claim`

### 目的

受取者が対象災害に対して Relief Cash を Claim する。

### 表示項目

- Wallet Connect
- MembershipPass status
- Residence verification status
- Claimable DisasterEvents
- Selected DisasterEvent
- Eligibility check result
- Estimated payout
- Claim button
- Transaction result

### Claim条件

- DisasterEvent is finalized
- MembershipPass is active
- MembershipRegistry current pass matches
- Valid signed residence metadata exists
- User residence cell is included in affected_cells
- Claim not already used
- Pool and Campaign budget are sufficient
- Not paused

---

## 6.9 `/claim/history`

### 目的

接続中 wallet の Claim 履歴を表示する。

### 表示項目

- Claim date
- DisasterEvent
- Program
- Campaign
- Status
- Payout amount
- Claim receipt
- Transaction link

---

## 6.10 `/events`

### 目的

災害イベント一覧を表示する。

### 表示項目

- Event id
- Source: USGS
- Status: candidate / finalized / expired
- Magnitude
- MMI
- Epicenter
- Occurred at
- Affected cells count
- Claim window
- Related campaign

### フィルタ

- finalized only
- claimable
- source
- country / region
- date

---

## 6.11 `/events/[eventId]`

### 目的

災害イベントの詳細と検証結果を表示する。

### 表示項目

- Earthquake summary
- Map
- Epicenter
- Magnitude
- MMI
- Source data
- Nautilus proof summary
- affected_cells_root
- affected_cells count
- claim status
- related Program
- related Campaign
- related Pool
- recent claims

### 審査員向けに見せたい情報

- Workerだけを信頼していない
- TEEが外部sourceを再取得して検証している
- finalized payloadだけが Move に投稿される
- Move が署名済み payload を検証している

---

## 6.12 `/programs`

### 目的

Support Program 一覧を表示する。

### 表示項目

- Program name
- Program type
- Active campaigns
- Verification requirement
- Pool policy
- Total donated
- Total paid out
- Status

---

## 6.13 `/programs/[programId]`

### 目的

Program詳細を表示する。

### 表示項目

- Program overview
- Eligibility rules
- Claim policy
- Pool priority
- Campaign list
- Related receipts
- Related sponsors

---

## 6.14 `/pools`

### 目的

Poolの透明性を表示する。

### 表示項目

- Main Pool
- Earthquake Relief Pool
- Operations Pool
- Campaign Pools
- Total received
- Total paid out
- Reserved amount
- Available amount
- Recent donations
- Recent payouts

---

## 6.15 `/pools/[poolId]`

### 目的

Pool別の詳細、寄付、ランキング、支援履歴を表示する。

### 表示項目

- Pool name
- Pool type
- Balance
- Total received
- Total paid out
- Related Program / Campaign
- Donation history
- Payout history
- Pool-specific leaderboard
- Top corporate sponsors

---

## 6.16 `/receipts`

### 目的

Impact Receiptを公開表示する。

### 表示項目

- Receipt id
- Program
- Campaign
- DisasterEvent
- Payout amount
- Pool source
- Created at
- Anonymized recipient reference
- Transaction link

### 注意点

- recipient の住所・電話番号・本人情報は表示しない
- 匿名化された受取者参照のみ表示する

---

## 6.17 `/receipts/[receiptId]`

### 目的

個別Receiptの詳細を表示する。

### 表示項目

- Receipt id
- Claim id
- Program
- Campaign
- DisasterEvent
- Pool source
- Payout amount
- Timestamp
- Transaction digest
- Proof summary

---

# 7. Admin Pages

---

## 7.1 `/admin`

### 目的

運営者向けの管理トップ。

### 表示項目

- Program status
- Campaign status
- Pool status
- Oracle status
- Pause status
- Recent errors

---

## 7.2 `/admin/sponsors`

### 目的

法人スポンサーの掲載管理。

### 機能

- Sponsor profile create/update
- Logo URL setting
- verified flag
- featured flag
- display order
- website URL
- description

### 注意点

- 法人ロゴは運営承認制
- verified sponsor のみ Landing marquee に表示
- なりすまし防止のため wallet と法人情報を確認する

---

## 7.3 `/admin/oracle`

### 目的

Oracle / Watcher / TEE / Relayer の状態確認。

### 表示項目

- Watcher status
- TEE status
- Relayer status
- Latest candidate events
- Latest finalized payload
- Signature verification status
- Error logs

---

## 7.4 `/admin/pause`

### 目的

緊急停止の管理。

### 機能

- Global pause
- Target pause
- Pool pause
- Campaign pause
- Unpause

---

# 8. 共通コンポーネント

## Core

- WalletConnectButton
- NetworkBadge
- TransactionStatus
- ObjectLink
- ExplorerLink
- AmountInput
- USDCAmount
- StatusBadge

## Donation

- DonationForm
- DonationTypeSelector
- PoolSelector
- DonationSplitPreview
- DonationResult
- DonorPassCard
- DonationHistoryTable

## Leaderboard

- LeaderboardTable
- LeaderboardTabs
- DonorRankBadge
- TopDonorsCard
- TopSponsorsCard
- PoolLeaderboard
- CampaignLeaderboard
- FirstRespondersList

## Sponsor

- SponsorLogoMarquee
- SponsorCard
- SponsorGrid
- FeaturedSponsorSection
- SponsorProfileForm

## Recipient / Claim

- MembershipPassCard
- RegistrationStatusCard
- ResidenceVerificationCard
- ClaimableEventList
- ClaimEligibilityCard
- ClaimButton
- ClaimResult
- ClaimHistoryTable

## Transparency

- ImpactStatsGrid
- PoolBalanceCard
- PoolFlowChart
- ReceiptCard
- ReceiptTable
- DisasterEventCard
- DisasterEventMap
- ProofSummaryCard

## Admin

- AdminLayout
- AdminStatusCard
- OracleStatusPanel
- PauseControlPanel
- SponsorAdminTable

---

# 9. データモデル案

## DonorProfile

    type DonorProfile = {
      walletAddress: string;
      displayName?: string;
      donorType: "individual" | "corporate";
      avatarUrl?: string;
      logoUrl?: string;
      totalDonated: bigint;
      donationCount: number;
      tier: "none" | "bronze" | "silver" | "gold";
      overallRank?: number;
      monthlyRank?: number;
      anonymous: boolean;
      hideAmount: boolean;
    };

## SponsorProfile

    type SponsorProfile = {
      sponsorId: string;
      walletAddress: string;
      displayName: string;
      logoUrl: string;
      websiteUrl?: string;
      description?: string;
      sponsorType: "corporate" | "foundation" | "community";
      totalDonated: bigint;
      donationCount: number;
      supportedProgramIds: string[];
      supportedCampaignIds: string[];
      featured: boolean;
      verified: boolean;
      displayOrder: number;
    };

## LeaderboardEntry

    type LeaderboardEntry = {
      rank: number;
      walletAddress: string;
      displayName: string;
      donorType: "individual" | "corporate";
      logoUrl?: string;
      avatarUrl?: string;
      tier: "none" | "bronze" | "silver" | "gold";
      totalDonated: bigint;
      donationCount: number;
      supportedPools: string[];
      latestDonationAt?: number;
      anonymous: boolean;
      hideAmount: boolean;
    };

## PoolSummary

    type PoolSummary = {
      poolId: string;
      name: string;
      type: "main" | "earthquake" | "operations" | "campaign";
      balance: bigint;
      totalReceived: bigint;
      totalPaidOut: bigint;
      reservedAmount: bigint;
      availableAmount: bigint;
      status: "active" | "paused";
    };

## DisasterEventSummary

    type DisasterEventSummary = {
      eventId: string;
      source: "USGS";
      status: "candidate" | "finalized" | "expired";
      magnitude?: number;
      mmi?: number;
      occurredAtMs: number;
      affectedCellsCount: number;
      affectedCellsRoot: string;
      claimWindowStartMs: number;
      claimWindowEndMs: number;
    };

## ImpactReceipt

    type ImpactReceipt = {
      receiptId: string;
      claimId: string;
      programId: string;
      campaignId?: string;
      disasterEventId?: string;
      poolId: string;
      payoutAmount: bigint;
      recipientRef: string;
      createdAtMs: number;
      transactionDigest: string;
    };

---

# 10. 表示ポリシー

## 寄付者ランキング

- 金額順だけでなく、寄付回数・月間・First Responderも用意する
- 個人は匿名表示を許可する
- 法人は verified sponsor のみロゴ表示する
- ランキングは Claim 権利や Payout 優先権を与えない
- 過度に射幸心を煽る表現は避ける

## 法人ロゴ

- Landingの上部に SponsorLogoMarquee を配置する
- verified = true かつ featured = true のスポンサーだけ表示する
- logoUrl / websiteUrl / description は offchain 管理する
- 寄付実績はオンチェーンデータを参照する

## プライバシー

- raw email はオンチェーンに出さない
- phone はオンチェーンに出さない
- raw address はオンチェーンに出さない
- GPS history はオンチェーンに出さない
- device info はオンチェーンに出さない
- 学籍番号や本人確認詳細はオンチェーンに出さない
- 公開画面では recipient を匿名化する

## 禁止表現

NG:

- Insurance
- Premium
- Guaranteed payout
- Compensation
- Coverage
- Claim right from donation
- Priority payout for top donors

OK:

- Donation
- Aid
- Relief Cash
- Support
- Impact
- Verified eligibility
- Transparent receipt

---

# 11. 推奨実装順

## Step 1: Static UI

- Landing
- SponsorLogoMarquee
- Dashboard mock
- Donate mock
- Leaderboard mock
- Claim mock

## Step 2: Wallet / Sui接続

- WalletConnectButton
- network config
- object id config
- explorer links

## Step 3: Read-only Integration

- Pool balances
- Program status
- DisasterEvent list
- DonorPass read
- DonationRecord read
- Receipts read
- Leaderboard aggregation

## Step 4: Write Integration

- donate_general_usdc
- donate_designated_usdc
- donate_operations_usdc
- MembershipPass registration
- Claim relief

## Step 5: Admin

- Sponsor profile management
- Oracle monitor
- Pause controls

---

# 12. MVP完成条件

- ユーザーが寄付できる
- 初回寄付で DonorPass が表示される
- 2回目以降の寄付履歴が表示される
- donor tier が表示される
- leaderboard が表示される
- 法人ロゴスライダーが表示される
- 受取者が MembershipPass を確認できる
- finalized DisasterEvent が表示される
- 対象者が Claim できる
- Pool残高が表示される
- Impact Receipt が表示される
- 支払い保証ではないことがUI上で明確
- 個人情報を公開しない
