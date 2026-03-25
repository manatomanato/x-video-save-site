const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const Database = require("better-sqlite3");
const cookieParser = require("cookie-parser");
const dotenv = require("dotenv");
const { execFile } = require("child_process");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const ADMIN_COOKIE_SECRET =
  process.env.ADMIN_COOKIE_SECRET || "change-cookie-secret";
const YTDLP_COOKIES_FILE = process.env.YTDLP_COOKIES_FILE || "";

const SITE_NAME = "twingsSaveClip";
const PAGE_TITLE = "動画保存ランキング";

const TERMS_URL =
  "https://sites.google.com/view/puraibas/%E3%83%9B%E3%83%BC%E3%83%A0?authuser=1";
const DELETE_REQUEST_URL = "https://tally.so/r/gDA1yl";

const JUICYADS_SITE_VERIFICATION =
  '<meta name="juicyads-site-verification" content="0b4d908f6177832d4534d82aa7aa267d">';

const HILLTOPADS_SITE_VERIFICATION =
  '<meta name="88040831fdcd2721c66c823d674b49ff7487458f" content="88040831fdcd2721c66c823d674b49ff7487458f" />';

const ADSTERRA_BANNER_320x50_HTML = `
  <div class="ad-box ad-box-small">
    <div class="ad-label">広告</div>
    <script>
      atOptions = {
        key: "e8f854e6e42402f8799f86a8a2431403",
        format: "iframe",
        height: 50,
        width: 320,
        params: {}
      };
    </script>
    <script src="https://www.highperformanceformat.com/e8f854e6e42402f8799f86a8a2431403/invoke.js"></script>
  </div>
`;

const MID_RANKING_468x60_AD_HTML = `
  <div class="mid-ranking-ad-wrap">
    <div class="mid-ranking-ad-scale" id="mid-ranking-ad-scale">
      <script>
        atOptions = {
          key: "987cc07119919973c6701daf205f0b4e",
          format: "iframe",
          height: 60,
          width: 468,
          params: {}
        };
      </script>
      <script src="https://www.highperformanceformat.com/987cc07119919973c6701daf205f0b4e/invoke.js"></script>
    </div>
  </div>
`;

const DELAYED_300x250_AD_HTML = `
  <div id="delayed-ad-overlay" class="delayed-ad-overlay" aria-hidden="true">
    <div class="delayed-ad-backdrop"></div>

    <div class="delayed-ad-sheet" role="dialog" aria-modal="true" aria-label="広告">
      <div class="delayed-ad-inner">
        <button
          type="button"
          id="delayed-ad-close"
          class="delayed-ad-close"
          aria-label="広告を閉じる"
        >×</button>

        <div class="delayed-ad-adbox">
          <div class="delayed-ad-label">広告</div>

          <div
            class="delayed-ad-scale"
            id="delayed-ad-scale"
          >
            <script>
              atOptions = {
                key: "4be475e8caf50119f9384052ede10934",
                format: "iframe",
                height: 250,
                width: 300,
                params: {}
              };
            </script>
            <script src="https://www.highperformanceformat.com/4be475e8caf50119f9384052ede10934/invoke.js"></script>
          </div>
        </div>

        <div class="delayed-ad-pr">[PR]</div>
      </div>
    </div>
  </div>
`;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const CACHE_DIR = path.join(DATA_DIR, "cache");

const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB
const TARGET_CACHE_BYTES = Math.floor(MAX_CACHE_BYTES * 0.8); // 80%まで減らす

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

app.use(express.static(PUBLIC_DIR));
app.use("/public", express.static(PUBLIC_DIR));
app.use("/cache", express.static(CACHE_DIR));

const db = new Database(path.join(DATA_DIR, "ranking.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_url TEXT NOT NULL UNIQUE,
    post_id TEXT,
    thumbnail_url TEXT,
    preview_path TEXT,
    category TEXT NOT NULL DEFAULT 'normal',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS save_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(post_id) REFERENCES posts(id)
  );

  CREATE INDEX IF NOT EXISTS idx_posts_post_url ON posts(post_url);
  CREATE INDEX IF NOT EXISTS idx_posts_category ON posts(category);
  CREATE INDEX IF NOT EXISTS idx_save_events_post_id ON save_events(post_id);
  CREATE INDEX IF NOT EXISTS idx_save_events_created_at ON save_events(created_at);
`);

try {
  const columns = db.prepare(`PRAGMA table_info(posts)`).all();
  const hasCategory = columns.some((col) => col.name === "category");
  if (!hasCategory) {
    db.exec(`ALTER TABLE posts ADD COLUMN category TEXT NOT NULL DEFAULT 'normal'`);
  }
} catch (e) {
  console.error("category migration error:", e);
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderHead(title) {
  return `
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${HILLTOPADS_SITE_VERIFICATION}
  ${JUICYADS_SITE_VERIFICATION}
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/public/style.css">
  `;
}

function extractPostId(url) {
  const match = String(url).match(/status\/(\d+)/);
  return match ? match[1] : null;
}

function getWritableCookiesFile() {
  if (!YTDLP_COOKIES_FILE) return "";

  const tempCookiesPath = path.join(os.tmpdir(), "twitter-cookies.txt");

  try {
    fs.copyFileSync(YTDLP_COOKIES_FILE, tempCookiesPath);
    return tempCookiesPath;
  } catch (e) {
    console.error("cookies copy error:", e);
    return "";
  }
}

function buildAdminToken() {
  return `${ADMIN_COOKIE_SECRET}::ok`;
}

function isAdmin(req) {
  return req.cookies.admin_auth === buildAdminToken();
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    return res.redirect("/admin/login");
  }
  next();
}

function normalizeCategory(category) {
  return category === "anime" ? "anime" : "normal";
}

function ensurePost(postUrl, category = "normal") {
  const postId = extractPostId(postUrl);
  const normalizedCategory = normalizeCategory(category);

  db.prepare(`
    INSERT OR IGNORE INTO posts (post_url, post_id, category)
    VALUES (?, ?, ?)
  `).run(postUrl, postId, normalizedCategory);

  db.prepare(`
    UPDATE posts
    SET category = COALESCE(category, ?)
    WHERE post_url = ?
  `).run(normalizedCategory, postUrl);

  return db.prepare(`
    SELECT id, post_url, post_id, thumbnail_url, preview_path, category
    FROM posts
    WHERE post_url = ?
  `).get(postUrl);
}

function updatePostMeta(
  postUrl,
  { thumbnailUrl = null, previewPath = null, category = null } = {}
) {
  const normalizedCategory = category == null ? null : normalizeCategory(category);

  db.prepare(`
    UPDATE posts
    SET
      thumbnail_url = COALESCE(?, thumbnail_url),
      preview_path = COALESCE(?, preview_path),
      category = COALESCE(?, category)
    WHERE post_url = ?
  `).run(thumbnailUrl, previewPath, normalizedCategory, postUrl);
}

function pruneOldCacheFiles(requiredFreeBytes = 0) {
  try {
    if (!fs.existsSync(CACHE_DIR)) return;

    const entries = fs.readdirSync(CACHE_DIR)
      .filter((name) => name.endsWith(".mp4"))
      .map((name) => {
        const fullPath = path.join(CACHE_DIR, name);
        const stat = fs.statSync(fullPath);
        return {
          name,
          fullPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs
        };
      });

    let totalSize = entries.reduce((sum, file) => sum + file.size, 0);
    const allowedSizeAfterSave = Math.max(TARGET_CACHE_BYTES - requiredFreeBytes, 0);

    if (totalSize <= allowedSizeAfterSave) {
      return;
    }

    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (const file of entries) {
      if (totalSize <= allowedSizeAfterSave) break;

      try {
        fs.unlinkSync(file.fullPath);
        totalSize -= file.size;

        db.prepare(`
          UPDATE posts
          SET preview_path = NULL
          WHERE preview_path = ?
        `).run(`/cache/${file.name}`);

        console.log(`cache pruned: ${file.name}`);
      } catch (e) {
        console.error("cache prune delete error:", e);
      }
    }
  } catch (e) {
    console.error("cache prune error:", e);
  }
}

function recordSave(postUrl, category = "normal") {
  const post = ensurePost(postUrl, category);
  if (!post) return;

  db.prepare(`
    INSERT INTO save_events (post_id)
    VALUES (?)
  `).run(post.id);
}

function getRanking(range, category = null) {
  let sinceExpr = "datetime('now', '-1 day')";
  if (range === "anime") sinceExpr = "datetime('now', '-1 day')";

  const params = [];
  let whereClause = "";

  if (category) {
    whereClause = "WHERE p.category = ?";
    params.push(normalizeCategory(category));
  }

  return db.prepare(`
    SELECT
      p.post_url,
      p.post_id,
      p.thumbnail_url,
      p.preview_path,
      p.category,
      COUNT(se.id) AS save_count
    FROM posts p
    LEFT JOIN save_events se
      ON se.post_id = p.id
      AND se.created_at >= ${sinceExpr}
    ${whereClause}
    GROUP BY p.id
    HAVING save_count > 0
    ORDER BY save_count DESC, p.id DESC
    LIMIT 30
  `).all(...params);
}

function getTweetInfo(postUrl) {
  return new Promise((resolve, reject) => {
    const args = [];
    const writableCookiesFile = getWritableCookiesFile();

    if (writableCookiesFile) {
      args.push("--cookies", writableCookiesFile);
    }

    args.push("-J", postUrl);

    execFile(
      "yt-dlp",
      args,
      { maxBuffer: 1024 * 1024 * 20 },
      (error, stdout, stderr) => {
        if (error) {
          reject(stderr || error.message);
          return;
        }

        try {
          const data = JSON.parse(stdout);
          resolve({
            thumbnailUrl: data.thumbnail || null
          });
        } catch (e) {
          reject(e.message);
        }
      }
    );
  });
}

function renderLoginPage(message = "") {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  ${renderHead(`${PAGE_TITLE} 管理者ログイン`)}
</head>
<body>
  <div class="container">
    <h1 class="title">管理者ログイン</h1>

    <div class="form-box">
      ${message ? `<div class="message">${escapeHtml(message)}</div>` : ""}

      <form method="POST" action="/admin/login" class="form-box-inner">
        <label class="label">パスワード</label>
        <input
          type="password"
          name="password"
          class="url-input"
          placeholder="パスワードを入力"
          required
        />

        <div class="button-row">
          <button type="submit" class="btn btn-blue">ログイン</button>
          <a href="/" class="btn btn-pink reset-link">戻る</a>
        </div>
      </form>
    </div>
  </div>
</body>
</html>`;
}

function renderRankingItems(items, adminMode = false, startRank = 1) {
  if (!items.length) {
    return `<div class="empty">まだランキングデータがありません</div>`;
  }

  return items
    .map((item, index) => {
      const rank = startRank + index;
      const hasVideo = !!item.preview_path;
      const posterAttr = item.thumbnail_url
        ? `poster="${escapeHtml(item.thumbnail_url)}"`
        : "";

      const cardHtml = `<div class="ranking-card">
        <div class="ranking-top">
          <div class="ranking-rank">#${rank}</div>
          <div class="ranking-meta">
            <a
              class="tweet-link"
              href="${escapeHtml(item.post_url)}"
              target="_blank"
              rel="noopener noreferrer"
            >Xツイート</a>
            <div class="ranking-count">${item.save_count}回保存</div>
          </div>
        </div>

        ${
          hasVideo
            ? `<video class="ranking-video" controls preload="metadata" playsinline ${posterAttr}>
                <source src="${escapeHtml(item.preview_path)}" type="video/mp4">
              </video>`
            : `<div class="no-video">まだ動画プレビューがありません</div>`
        }

        ${
          adminMode
            ? `<form method="POST" action="/admin/delete" class="admin-delete-form">
                <input type="hidden" name="postUrl" value="${escapeHtml(item.post_url)}">
                <button type="submit" class="delete-btn">このランキングを削除</button>
              </form>`
            : ""
        }
      </div>`;

      if (rank === 6) {
        return cardHtml + MID_RANKING_468x60_AD_HTML;
      }

      return cardHtml;
    })
    .join("");
}

function renderPage({
  inputUrl = "",
  postId = "",
  message = "",
  canDownload = false,
  adminMode = false,
  activePage = "ranking",
  selectedCategory = "normal"
}) {
  const ranking24h = getRanking("24h");
  const rankingAnime = getRanking("anime", "anime");

  const ranking24hTop10 = ranking24h.slice(0, 10);
  const ranking24h11to30 = ranking24h.slice(10, 30);

  const rankingAnimeTop10 = rankingAnime.slice(0, 10);
  const rankingAnime11to30 = rankingAnime.slice(10, 30);

  const isSavePage = activePage === "save";
  const isRankingPage = activePage === "ranking";
  const isAnimeSelected = selectedCategory === "anime";

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  ${renderHead(PAGE_TITLE)}
</head>
<body>
  <script
    type="text/javascript"
    src="https://js.juicyads.com/jp.php?c=446423z2t294u4r2p294139434&u=https%3A%2F%2Fwww.juicyads.rocks"
  ></script>

  ${DELAYED_300x250_AD_HTML}

  <div class="container">
    ${ADSTERRA_BANNER_320x50_HTML}

    <div class="top-mini-nav">
      <button class="mini-nav-btn ${isSavePage ? "active" : ""}" data-page="save-page" type="button">保存</button>
      <button class="mini-nav-btn ${isRankingPage ? "active" : ""}" data-page="ranking-page" type="button">ランキング</button>
    </div>

    <h1 class="title">${escapeHtml(SITE_NAME)}</h1>

    ${
      adminMode
        ? `<div class="admin-topbar">
            <div class="admin-badge">管理者モード</div>
            <form method="POST" action="/admin/logout">
              <button type="submit" class="logout-btn">ログアウト</button>
            </form>
          </div>`
        : `<div class="admin-login-link-wrap">
            <a href="/admin/login" class="admin-login-link">管理者ログイン</a>
          </div>`
    }

    <div id="save-page" class="page-section ${isSavePage ? "active" : ""}">
      <form method="POST" action="/extract" class="form-box">
        <input
          type="url"
          name="postUrl"
          class="url-input"
          placeholder="ここにURLをペースト"
          value="${escapeHtml(inputUrl)}"
          required
        />

        <div class="save-category-row">
          <label class="category-option">
            <input type="radio" name="category" value="normal" ${!isAnimeSelected ? "checked" : ""}>
            <span>通常</span>
          </label>
          <label class="category-option">
            <input type="radio" name="category" value="anime" ${isAnimeSelected ? "checked" : ""}>
            <span>アニメ</span>
          </label>
        </div>

        <div class="button-row">
          <button type="submit" class="btn btn-blue">抜き出し</button>
          <a href="/" class="btn btn-pink reset-link">リセット</a>
        </div>
      </form>

      ${message ? `<div class="message">${escapeHtml(message)}</div>` : ""}

      ${
        inputUrl
          ? `<div class="result-card">
              <div class="result-item">
                <span class="label">元URL</span>
                <div class="value break">${escapeHtml(inputUrl)}</div>
              </div>

              <div class="result-item">
                <span class="label">post_id</span>
                <div class="value">${escapeHtml(postId || "取得できませんでした")}</div>
              </div>

              <div class="result-item">
                <span class="label">カテゴリ</span>
                <div class="value">${isAnimeSelected ? "アニメ" : "通常"}</div>
              </div>

              ${
                canDownload
                  ? `<div class="result-item">
                      <span class="label">保存</span>
                      <div style="margin-top:12px;">
                        <a href="/download?postUrl=${encodeURIComponent(inputUrl)}&category=${encodeURIComponent(selectedCategory)}" class="download-btn">
                          ダウンロード
                        </a>
                      </div>
                    </div>
                    <div class="iphone-note">
                      <strong>iPhoneの方へ</strong><br>
                      ダウンロード後に自動保存されない場合は、開いた動画画面で<br>
                      <strong>共有 → ファイルに保存</strong><br>
                      を使って保存してください。
                    </div>`
                  : ""
              }
            </div>`
          : ""
      }
    </div>

    <div id="ranking-page" class="page-section ${isRankingPage ? "active" : ""}">
      <div class="ranking-section">
        <h2>保存ランキング</h2>

        <div class="ranking-tabs">
          <button class="ranking-tab active" data-tab="tab-24h" type="button">24時間</button>
          <button class="ranking-tab" data-tab="tab-anime" type="button">アニメ</button>
        </div>

        <div id="tab-24h" class="ranking-panel active">
          <div class="rank-range-tabs">
            <button class="rank-range-tab active" data-range="range-24h-top10" type="button">第1位〜第10位</button>
            <button class="rank-range-tab" data-range="range-24h-11to30" type="button">第11位〜第30位</button>
          </div>

          <div id="range-24h-top10" class="rank-range-panel active">
            ${renderRankingItems(ranking24hTop10, adminMode, 1)}
          </div>

          <div id="range-24h-11to30" class="rank-range-panel">
            ${renderRankingItems(ranking24h11to30, adminMode, 11)}
          </div>
        </div>

        <div id="tab-anime" class="ranking-panel">
          <div class="rank-range-tabs">
            <button class="rank-range-tab active" data-range="range-anime-top10" type="button">第1位〜第10位</button>
            <button class="rank-range-tab" data-range="range-anime-11to30" type="button">第11位〜第30位</button>
          </div>

          <div id="range-anime-top10" class="rank-range-panel active">
            ${renderRankingItems(rankingAnimeTop10, adminMode, 1)}
          </div>

          <div id="range-anime-11to30" class="rank-range-panel">
            ${renderRankingItems(rankingAnime11to30, adminMode, 11)}
          </div>
        </div>
      </div>
    </div>

    <footer class="site-footer footer-box">
      <div class="footer-text"></div>
      <div class="footer-links">
        <a href="${TERMS_URL}" target="_blank" rel="noopener noreferrer">利用規約</a>
        <a href="${DELETE_REQUEST_URL}" target="_blank" rel="noopener noreferrer">削除依頼</a>
      </div>
    </footer>
  </div>

  <script>
    const miniNavBtns = document.querySelectorAll(".mini-nav-btn");
    const pageSections = document.querySelectorAll(".page-section");

    miniNavBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const targetId = btn.dataset.page;
        miniNavBtns.forEach((b) => b.classList.remove("active"));
        pageSections.forEach((section) => section.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById(targetId).classList.add("active");
      });
    });

    const tabs = document.querySelectorAll(".ranking-tab");
    const panels = document.querySelectorAll(".ranking-panel");

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const targetId = tab.dataset.tab;
        tabs.forEach((t) => t.classList.remove("active"));
        panels.forEach((p) => p.classList.remove("active"));
        tab.classList.add("active");
        document.getElementById(targetId).classList.add("active");
      });
    });

    document.addEventListener("click", (e) => {
      const btn = e.target.closest(".rank-range-tab");
      if (!btn) return;

      const parentPanel = btn.closest(".ranking-panel");
      if (!parentPanel) return;

      parentPanel.querySelectorAll(".rank-range-tab").forEach((tab) => {
        tab.classList.remove("active");
      });

      parentPanel.querySelectorAll(".rank-range-panel").forEach((panel) => {
        panel.classList.remove("active");
      });

      btn.classList.add("active");

      const targetId = btn.dataset.range;
      const target = document.getElementById(targetId);
      if (target) target.classList.add("active");
    });

    const delayedAdOverlay = document.getElementById("delayed-ad-overlay");
    const delayedAdClose = document.getElementById("delayed-ad-close");

    function openDelayedAd() {
      if (!delayedAdOverlay) return;
      delayedAdOverlay.classList.add("show");
      delayedAdOverlay.setAttribute("aria-hidden", "false");
      document.body.classList.add("ad-open");
    }

    function closeDelayedAd() {
      if (!delayedAdOverlay) return;
      delayedAdOverlay.classList.remove("show");
      delayedAdOverlay.setAttribute("aria-hidden", "true");
      document.body.classList.remove("ad-open");
    }

    function fitDelayedAdToScreen() {
      const adScale = document.getElementById("delayed-ad-scale");
      if (!adScale) return;

      const screenW = Math.min(window.innerWidth, document.documentElement.clientWidth);
      const baseW = 300;
      const baseH = 250;

      const scale = screenW / baseW;
      adScale.style.transform = \`scale(\${scale})\`;

      const scaledHeight = baseH * scale;
      adScale.style.marginBottom = \`\${scaledHeight - baseH}px\`;
    }

    function fitMidRankingAdToScreen() {
      const ad = document.getElementById("mid-ranking-ad-scale");
      if (!ad) return;

      const screenW = Math.min(window.innerWidth, document.documentElement.clientWidth);
      const baseW = 468;
      const baseH = 60;

      const scale = screenW / baseW;
      ad.style.transform = \`scale(\${scale})\`;

      const scaledHeight = baseH * scale;
      ad.style.marginBottom = \`\${scaledHeight - baseH}px\`;
    }

    if (delayedAdClose) {
      delayedAdClose.addEventListener("click", closeDelayedAd);
    }

    if (delayedAdOverlay) {
      delayedAdOverlay.addEventListener("click", (e) => {
        if (e.target.classList.contains("delayed-ad-backdrop")) {
          closeDelayedAd();
        }
      });
    }

    window.addEventListener("load", () => {
      fitDelayedAdToScreen();
      fitMidRankingAdToScreen();

      setTimeout(() => {
        openDelayedAd();
        fitDelayedAdToScreen();
      }, 10000);
    });

    window.addEventListener("resize", () => {
      fitDelayedAdToScreen();
      fitMidRankingAdToScreen();
    });
  </script>

  <script async src="https://pufted.com/p/waWQiOjEyMjIxOTMsInNpZCI6MTcxMDM1OSwid2lkIjo3MzU5OTgsInNyYyI6Mn0=eyJ.js"></script>
</body>
</html>`;
}

app.get("/", (req, res) => {
  res.send(
    renderPage({
      adminMode: isAdmin(req),
      activePage: "ranking",
      selectedCategory: "normal"
    })
  );
});

app.get("/admin/login", (req, res) => {
  if (isAdmin(req)) {
    return res.redirect("/");
  }
  res.send(renderLoginPage());
});

app.post("/admin/login", (req, res) => {
  const password = String(req.body.password || "");

  if (password !== ADMIN_PASSWORD) {
    return res.send(renderLoginPage("パスワードが違います"));
  }

  res.cookie("admin_auth", buildAdminToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 1000 * 60 * 60 * 24 * 7
  });

  res.redirect("/");
});

app.post("/admin/logout", (req, res) => {
  res.clearCookie("admin_auth");
  res.redirect("/");
});

app.post("/extract", async (req, res) => {
  const postUrl = String(req.body.postUrl || "").trim();
  const category = normalizeCategory(String(req.body.category || "normal"));

  if (!postUrl) {
    return res.send(
      renderPage({
        message: "URLを入力してください",
        adminMode: isAdmin(req),
        activePage: "save",
        selectedCategory: category
      })
    );
  }

  const postId = extractPostId(postUrl);

  if (!postId) {
    return res.send(
      renderPage({
        inputUrl: postUrl,
        message: "status/数字 を含むXのURLを入れてください",
        adminMode: isAdmin(req),
        canDownload: false,
        activePage: "save",
        selectedCategory: category
      })
    );
  }

  ensurePost(postUrl, category);

  try {
    const info = await getTweetInfo(postUrl);
    updatePostMeta(postUrl, {
      thumbnailUrl: info.thumbnailUrl,
      category
    });
  } catch (e) {
    console.error("extract info error:", e);
  }

  return res.send(
    renderPage({
      inputUrl: postUrl,
      postId,
      canDownload: true,
      message: "抜き出し完了。ダウンロードボタンを押してください。",
      adminMode: isAdmin(req),
      activePage: "save",
      selectedCategory: category
    })
  );
});

app.get("/download", (req, res) => {
  const postUrl = String(req.query.postUrl || "").trim();
  const category = normalizeCategory(String(req.query.category || "normal"));

  if (!postUrl) {
    return res.status(400).send("URLがありません");
  }

  const postId = extractPostId(postUrl) || "video";
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xdl-"));
  const outputTemplate = path.join(tempDir, `${postId}.%(ext)s`);
  const args = [];

  const writableCookiesFile = getWritableCookiesFile();
  if (writableCookiesFile) {
    args.push("--cookies", writableCookiesFile);
  }

  args.push(
    "-f",
    "bv*+ba/b",
    "--merge-output-format",
    "mp4",
    "-o",
    outputTemplate,
    postUrl
  );

  execFile(
    "yt-dlp",
    args,
    { maxBuffer: 1024 * 1024 * 20 },
    (error, stdout, stderr) => {
      if (error) {
        console.error("yt-dlp download error:", error);
        console.error(stderr);
        return res.status(500).send("ダウンロード処理に失敗しました");
      }

      let filePath = path.join(tempDir, `${postId}.mp4`);

      if (!fs.existsSync(filePath)) {
        const files = fs.readdirSync(tempDir);
        const found = files.find((name) => name.endsWith(".mp4")) || files[0];

        if (!found) {
          return res.status(500).send("保存ファイルが見つかりませんでした");
        }

        filePath = path.join(tempDir, found);
      }

      try {
        const newFileSize = fs.statSync(filePath).size;
        pruneOldCacheFiles(newFileSize);

        const cachePath = path.join(CACHE_DIR, `${postId}.mp4`);
        fs.copyFileSync(filePath, cachePath);
        updatePostMeta(postUrl, {
          previewPath: `/cache/${postId}.mp4`,
          category
        });
      } catch (cacheErr) {
        console.error("cache save error:", cacheErr);

        if (cacheErr.code === "ENOSPC") {
          console.error("cache disk full: preview cache skipped");
        }
      }

      recordSave(postUrl, category);

      res.download(filePath, `${postId}.mp4`, (downloadErr) => {
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
          }
        } catch (cleanupErr) {
          console.error("cleanup error:", cleanupErr);
        }

        if (downloadErr) {
          console.error("res.download error:", downloadErr);
        }
      });
    }
  );
});

app.post("/admin/delete", requireAdmin, (req, res) => {
  const postUrl = String(req.body.postUrl || "").trim();

  const post = db.prepare(`
    SELECT id, post_id, preview_path
    FROM posts
    WHERE post_url = ?
  `).get(postUrl);

  if (!post) {
    return res.redirect("/");
  }

  db.prepare(`
    DELETE FROM save_events
    WHERE post_id = ?
  `).run(post.id);

  db.prepare(`
    DELETE FROM posts
    WHERE id = ?
  `).run(post.id);

  if (post.preview_path) {
    const relativePath = post.preview_path.replace("/cache/", "");
    const filePath = path.join(CACHE_DIR, relativePath);

    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (e) {
      console.error("cache delete error:", e);
    }
  }

  res.redirect("/");
});

app.listen(PORT, () => {
  console.log(`Server started: http://localhost:${PORT}`);
});
