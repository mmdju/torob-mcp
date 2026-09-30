// The worker's own front page. Served at GET / - a plain static string so the
// worker has no template step and no second request.
export const LANDING = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>torob-mcp — مقایسه قیمت ترب برای عامل‌های هوش مصنوعی</title>
<meta name="description" content="MCP server for Torob (ترب): search products, see every seller offer, compare prices across shops. Read-only, no API key.">
<meta property="og:title" content="torob-mcp">
<meta property="og:description" content="MCP server for Torob (ترب) — price comparison for AI agents. Read-only, no API key.">
<meta property="og:image" content="/og.png">
<link rel="icon" href="/og.png">
<style>
  :root {
    --bg: #0b1020;
    --card: #141a30;
    --line: #243052;
    --fg: #e8ecf8;
    --dim: #9aa6c8;
    --accent: #4ade80;
    --accent2: #60a5fa;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: system-ui, -apple-system, "Segoe UI", Tahoma, sans-serif;
    line-height: 1.7;
  }
  .wrap { max-width: 860px; margin: 0 auto; padding: 48px 20px 72px; }
  h1 { font-size: 2.1rem; margin: 0 0 8px; letter-spacing: -0.02em; }
  h1 span { color: var(--accent); }
  .sub { color: var(--dim); margin: 0 0 32px; font-size: 1.05rem; }
  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 20px 22px;
    margin: 16px 0;
  }
  .card h2 { margin: 0 0 6px; font-size: 1.05rem; color: var(--accent2); }
  .card p { margin: 0; color: var(--dim); font-size: 0.95rem; }
  pre {
    background: #0a0f1e;
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 14px 16px;
    overflow-x: auto;
    color: var(--fg);
    font-size: 0.88rem;
    direction: ltr;
    text-align: left;
  }
  .pill {
    display: inline-block;
    background: #10203a;
    border: 1px solid var(--line);
    color: var(--accent);
    border-radius: 999px;
    padding: 3px 12px;
    font-size: 0.8rem;
    margin-inline-end: 8px;
  }
  ul { margin: 8px 0 0; padding-inline-start: 20px; }
  li { margin: 4px 0; }
  code { background: #0a0f1e; padding: 1px 6px; border-radius: 5px; font-size: 0.9em; }
  a { color: var(--accent2); }
  footer { margin-top: 40px; color: var(--dim); font-size: 0.85rem; border-top: 1px solid var(--line); padding-top: 16px; }
</style>
</head>
<body>
<div class="wrap">
  <h1><span>torob</span>-mcp</h1>
  <p class="sub">مقایسهٔ قیمت ترب، در دسترس عامل‌های هوش مصنوعی. فقط‌خواندنی، بدون کلید API.</p>

  <div>
    <span class="pill">۵ ابزار</span>
    <span class="pill">Cloudflare Workers</span>
    <span class="pill">بدون ورود</span>
    <span class="pill">قیمت‌ها به تومان</span>
  </div>

  <div class="card">
    <h2>این کار را می‌کند</h2>
    <p>ترب قیمت یک محصول را از ده‌ها فروشگاه جمع می‌کند. این سرویس همان داده را پشت چند ابزار ساده می‌گذارد تا یک عامل بتواند بپرسد «این کجا ارزان‌تر است و آن فروشگاه قابل‌اعتماد است؟» — بدون اینکه حتی یک صفحه را بخزاند.</p>
  </div>

  <div class="card">
    <h2>ابزارها</h2>
    <ul>
      <li><code>torob_suggest</code> — تبدیل حرف‌های خودکار به عبارت‌های واقعی جستجو</li>
      <li><code>search_products</code> — جستجو با کارت‌های فشرده (ارزان‌ترین پیشنهاد به تومان)</li>
      <li><code>product_details</code> — یک محصول به‌همراه <strong>همهٔ فروشنده‌ها</strong>، امتیاز و رأی هر فروشگاه</li>
      <li><code>compare_products</code> — مقایسهٔ ۲ تا ۵ محصول کنار هم</li>
      <li><code>find_best_value</code> — «بهترین زیر بودجهٔ X»</li>
    </ul>
  </div>

  <div class="card">
    <h2>اتصال</h2>
    <pre>{
  "mcpServers": {
    "torob": { "url": "https://torob-mcp.mmdju3.workers.dev/mcp" }
  }
}</pre>
  </div>

  <div class="card">
    <h2>صادقانه چه چیزهایی را نمی‌گوید</h2>
    <ul>
      <li>قیمت‌ها مدام عوض می‌شوند — هر محصول لینک ترب خودش را دارد تا کاربر خودش تأیید کند.</li>
      <li>کارت جستجو فقط <strong>ارزان‌ترین</strong> پیشنهاد را نشان می‌دهد؛ برای دیدن همهٔ فروشنده‌ها <code>product_details</code> لازم است.</li>
      <li>قیمت صفر یعنی ناموجود، نه رایگان.</li>
      <li>اگر پیام <code>price_unreliable</code> دیدید، خودِ ترب هشدار داده که آن قیمت قابل‌اعتماد نیست.</li>
      <li>این سرویس وابسته به ترب نیست و توسط آن تأیید نشده است.</li>
    </ul>
  </div>

  <footer>
    داده‌ها از API عمومی وب ترب می‌آید. <a href="https://github.com/mmdju/torob-mcp">مستندات کامل</a> در ریپوی عمومی.
  </footer>
</div>
</body>
</html>
`;

// Served at GET /mcp: browser MCP clients (WebMCP, web agents) land here
// instead of a JSON error when they GET the endpoint.
export const MCP_PAGE = `<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<title>torob-mcp</title>
<style>
  body { background:#0b1020; color:#e8ecf8; font-family:system-ui,sans-serif;
         display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
  div { text-align:center; max-width:420px; padding:20px; }
  code { background:#141a30; padding:2px 8px; border-radius:6px; }
  p { color:#9aa6c8; line-height:1.7; }
</style>
</head>
<body>
<div>
  <h1>torob-mcp</h1>
  <p>This endpoint speaks MCP over Streamable HTTP. Connect a client with
     <code>POST /mcp</code>, or see the <a style="color:#60a5fa" href="/">front page</a>.</p>
</div>
</body>
</html>
`;
