import AppShell from "@/components/shell/AppShell";

// Rendered per request, never prerendered. A prerendered shell is served with
// `Cache-Control: s-maxage=31536000`, so every browser kept the HTML it first
// saw for a year and went on running a pre-fix bundle after a deploy. force-dynamic
// answers with `private, no-cache, no-store, max-age=0, must-revalidate`, so the
// shell is always the build currently deployed. Hashed `/_next/static` chunks
// keep their year-long immutable caching and are still reused.
export const dynamic = "force-dynamic";

export default AppShell;
