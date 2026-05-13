# DeFi & Payments Problem Statement / DeFi & Payments 課題文

## Programmable Money, Payments & Financial Systems on Sui / Sui上のプログラマブルマネー、決済、金融システム

## Problem / 課題

Payments and DeFi today are disconnected.

今日の決済とDeFiは分断されています。

- Payments are static transfers  
  決済は静的な送金にとどまっている
- DeFi is complex and siloed  
  DeFiは複雑でサイロ化されている
- Users must manually orchestrate everything  
  ユーザーがすべてを手動で組み合わせる必要がある

On Sui, this changes: **Payments can become programmable financial actions.**

Suiではこれが変わります。**決済はプログラム可能な金融アクションになり得ます。**

Examples:

例:

- A payment that automatically invests  
  自動的に投資される決済
- A salary that streams and earns yield  
  ストリーミングされ、利回りも生む給与
- A wallet that intelligently routes funds  
  資金を賢くルーティングするウォレット

## Overview / 概要

Sui introduces a fundamentally different model for building financial systems.

Suiは、金融システムを構築するための根本的に異なるモデルを提供します。

- Assets are objects, not just balances  
  資産は単なる残高ではなく、オブジェクトとして扱われる
- Transactions can bundle complex logic atomically (Programmable Transaction Blocks)  
  トランザクションは複雑なロジックをアトミックにまとめられる（Programmable Transaction Blocks）
- Smart contracts (Move) enforce ownership and composability at the type level  
  スマートコントラクト（Move）は、所有権とコンポーザビリティを型レベルで強制する

This enables something beyond traditional DeFi:

これは従来のDeFiを超えるものを可能にします。

**Programmable money — where assets, logic, and flows are natively composable.**

**プログラマブルマネー: 資産、ロジック、フローがネイティブに組み合わせ可能な金融の形。**

This track challenges you to build:

このトラックでは、以下のようなものを構築することが求められます。

- Payment systems  
  決済システム
- Financial workflows  
  金融ワークフロー
- Capital management tools  
  資本管理ツール
- User-facing financial products  
  ユーザー向け金融プロダクト

All powered by Sui Move.

これらすべてをSui Moveによって実現します。

## What You're Building / 構築するもの

**Systems that move, manage, and transform money programmatically.**

**お金をプログラムによって移動、管理、変換するシステム。**

This includes:

対象には以下が含まれます。

- Payment flows  
  決済フロー
- Wallets and financial interfaces  
  ウォレットと金融インターフェース
- Vaults and capital allocators  
  Vaultと資本配分ツール
- Automation systems  
  自動化システム
- Financial abstractions for real users  
  実ユーザーのための金融抽象化

## Core Building Blocks on Sui / Sui上の主要構成要素

You are encouraged to use any combination of the following.

以下の要素を自由に組み合わせて使うことが推奨されます。

### Sui Move (Core Layer) / Sui Move（コアレイヤー）

- Object-based assets  
  オブジェクトベースの資産
- Strong ownership model  
  強力な所有権モデル
- Type-safe financial logic  
  型安全な金融ロジック

Enables:

可能にすること:

- Safe asset flows  
  安全な資産フロー
- Custom financial rules  
  カスタム金融ルール
- Composable modules  
  組み合わせ可能なモジュール

### Programmable Transaction Blocks (PTBs) / Programmable Transaction Blocks（PTB）

- Bundle multiple actions into one transaction  
  複数のアクションを1つのトランザクションにまとめる
- Atomic execution  
  アトミックな実行

Enables:

可能にすること:

- Multi-step payments  
  複数ステップの決済
- Complex financial flows, such as pay -> swap -> deposit  
  pay -> swap -> deposit のような複雑な金融フロー
- Seamless user experience  
  シームレスなユーザー体験

### Tokens & Assets / トークンと資産

- Fungible tokens, such as coins and stablecoins  
  Coinやステーブルコインなどの代替可能トークン
- NFTs / object-based assets  
  NFT / オブジェクトベースの資産

Enables:

可能にすること:

- Payments  
  決済
- Receipts  
  レシート
- Identity-linked finance  
  IDと紐づく金融
- Tokenized positions  
  トークン化されたポジション

### DeFi Protocols (Optional) / DeFiプロトコル（任意）

You may integrate with:

以下と連携してもよいです。

- Lending protocols  
  レンディングプロトコル
- DEXs / liquidity venues  
  DEX / 流動性提供の場
- Yield platforms  
  利回りプラットフォーム

These are tools, not requirements.

これらはツールであり、必須要件ではありません。

## Idea Bank / アイデア集

Pick one, twist it, or ignore it entirely. These are starting points, not a checklist. Grouped loosely by flavor.

1つ選んでも、アレンジしても、完全に無視しても構いません。これはチェックリストではなく、出発点です。大まかな方向性ごとに分類されています。

### Trust-Minimized Finance / 信頼の最小化を目指す金融

Build systems that reduce or eliminate the need for trust between parties by enforcing financial logic programmatically.

金融ロジックをプログラムで強制することで、当事者間の信頼への依存を減らす、または不要にするシステムを構築します。

Focus on conditional execution, automated enforcement, transparent rules, and reduced reliance on overcollateralization.

条件付き実行、自動執行、透明なルール、過剰担保への依存低減に注目します。

Examples:

例:

- Programmable loans  
  プログラム可能なローン
- Milestone-based escrow  
  マイルストーンベースのエスクロー
- Payment-linked credit systems  
  決済連動型クレジットシステム
- Controlled treasury systems  
  制御されたトレジャリーシステム
- Novel prediction markets  
  新しい予測市場

### Payments & Consumer Finance / 決済と消費者向け金融

Focus on usability and real-world flows.

使いやすさと現実世界のフローに注目します。

Examples:

例:

- Smart wallets with built-in automation  
  自動化機能を内蔵したスマートウォレット
- Merchant payment systems  
  店舗・事業者向け決済システム
- Subscription or streaming payments  
  サブスクリプションまたはストリーミング決済
- Payroll systems  
  給与支払いシステム
- Privacy focused consumer payment rails  
  プライバシー重視の消費者向け決済レール

### Vaults & Capital Management / Vaultと資本管理

Focus on managing funds programmatically.

資金をプログラムによって管理することに注目します。

Examples:

例:

- Yield vaults  
  イールドVault
- Automated savings strategies  
  自動貯蓄戦略
- Treasury management systems  
  トレジャリー管理システム
- Portfolio allocators  
  ポートフォリオ配分ツール

### Financial Automation / 金融自動化

Focus on logic-driven execution.

ロジック駆動の実行に注目します。

Examples:

例:

- Auto-investment bots  
  自動投資ボット
- Rebalancing systems  
  リバランスシステム
- Conditional payments  
  条件付き決済
- Rule based financial agents  
  ルールベースの金融エージェント

### Infrastructure & Tooling / インフラとツール

Focus on enabling other builders.

他の開発者を支援することに注目します。

Examples:

例:

- SDKs for payments  
  決済向けSDK
- Tools for building or visualizing transaction flows  
  トランザクションフローを構築・可視化するツール
- Financial dashboards  
  金融ダッシュボード
- Debugging tools for Move contracts  
  Moveコントラクト向けデバッグツール

## What a Strong Project Looks Like / 強いプロジェクトの条件

A strong project demonstrates:

強いプロジェクトは以下を示します。

- A clear financial use case  
  明確な金融ユースケース
- Correct handling of assets and ownership  
  資産と所有権の正しい取り扱い
- Working end-to-end integrations/flows  
  エンドツーエンドで動作する連携・フロー
- Thoughtful abstraction for users  
  ユーザーのために考えられた抽象化

## What a Top-Tier Project Looks Like / トップ評価のプロジェクトの条件

Top projects go further by demonstrating:

トップ評価のプロジェクトは、さらに以下を示します。

- Novel use of programmable transactions  
  プログラマブルトランザクションの新規性ある活用
- Strong composability across components  
  コンポーネント間の強いコンポーザビリティ
- Excellent user experience for complex financial actions  
  複雑な金融アクションに対する優れたユーザー体験
- Real-world applicability  
  現実世界での適用可能性

## Submission Types / 提出形式

You can submit:

提出できるもの:

- Full-stack applications  
  フルスタックアプリケーション
- Smart contract systems (Move modules)  
  スマートコントラクトシステム（Moveモジュール）
- Bots or automation services  
  ボットまたは自動化サービス
- Developer tools  
  開発者向けツール

> Build something that makes money move smarter.
>
> お金をより賢く動かすものを作ろう。

> Godspeed.
>
> 健闘を祈ります。
