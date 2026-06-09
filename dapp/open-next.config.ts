import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// OpenNext の Cloudflare 向け最小構成。incremental cache や queue などの override は
// 現時点で不要なため指定しない（ISR や `use cache` を使い始める段階で追加する）。
export default defineCloudflareConfig();
