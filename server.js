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
const ADMIN_COOKIE_SECRET = process.env.ADMIN_COOKIE_SECRET || "change-cookie-secret";
const YTDLP_COOKIES_FILE = process.env.YTDLP_COOKIES_FILE || "";

const SITE_NAME = "twingsSaveClip";
const PAGE_TITLE = "動画保存ランキング";

const TERMS_URL = "https://sites.google.com/view/puraibas/%E3%83%9B%E3%83%BC%E3%83%A0?authuser=1";
const DELETE_REQUEST_URL = "https://tally.so/r/gDA1yl";
const JUICYADS_SITE_VERIFICATION =
  '<meta name="juicyads-site-verification" content="0b4d908f6177832d4534d82aa7ac267d">';

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const CACHE_DIR = path.join(DATA_DIR, "cache");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });

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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS save_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(post_id) REFERENCES posts(id)
);

CREATE INDEX IF NOT EXISTS idx_posts_post_url ON posts(post_url);
CREATE INDEX IF NOT EXISTS idx_save_events_post_id ON save_events(post_id);
CREATE INDEX IF NOT EXISTS idx_save_events_created_at ON save_events(created_at);
`);

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

function ensurePost(postUrl) {
  const postId = extractPostId(postUrl);

  db.prepare(`
    INSERT OR IGNORE INTO posts (post_url, post_id)
    VALUES (?, ?)
  `).run(postUrl, postId);

  return db.prepare(`
    SELECT id, post_url, post_id, thumbnail_url, preview_path
    FROM posts
    WHERE post_url = ?
  `).get(postUrl);
}

function updatePostMeta(postUrl, { thumbnailUrl = null, previewPath = null } = {}) {
  db.prepare(`
    UPDATE posts
    SET
      thumbnail_url = COALESCE(?, thumbnail_url),
      preview_path = COALESCE(?, preview_path)
    WHERE post_url = ?
  `).run(thumbnailUrl, previewPath, postUrl);
}

function recordSave(postUrl) {
  const post = ensurePost(postUrl);
  if (!post) return;

  db.prepare(`
    INSERT INTO save_events (post_id)
    VALUES (?)
  `).run(post.id);
}

function getRanking(range) {
  let sinceExpr = `datetime('now', '-1 day')`;
  if (range === "7d") sinceExpr = `datetime('now', '-7 day')`;
  if (range === "30d") sinceExpr = `datetime('now', '-30 day')`;

  return db.prepare(`
    SELECT
      p.post_url,
      p.post_id,
      p.thumbnail_url,
      p.preview_path,
      COUNT(se.id) AS save_count
    FROM posts p
    LEFT JOIN save_events se
      ON se.post_id = p.id
      AND se.created_at >= ${sinceExpr}
    GROUP BY p.id
    HAVING save_count > 0
    ORDER BY save_count DESC, p.id DESC
    LIMIT 10
  `).all();
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
  return `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(PAGE_TITLE)} 管理者ログイン</title>
  ${JUICYADS_SITE_VERIFICATION}
  <link rel="stylesheet" href="/public/style.css">
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
</html>
  `;
}

function renderRankingItems(items, adminMode = false) {
  if (!items.length) {
    return `<div class="empty">まだランキングデータがありません</div>`;
  }

  return items.map((item, index) => {
    const hasVideo = !!item.preview_path;
    const posterAttr = item.thumbnail_url
      ? `poster="${escapeHtml(item.thumbnail_url)}"`
      : "";

    return `
      <div class="ranking-card">
        <div class="ranking-top">
          <div class="ranking-rank">#${index + 1}</div>
          <div class="ranking-meta">
            <a class="tweet-link" href="${escapeHtml(item.post_url)}" target="_blank" rel="noopener noreferrer">Xツイート</a>
            <div class="ranking-count">${item.save_count}回保存</div>
          </div>
        </div>

        ${
          hasVideo
            ? `
              <video
                class="ranking-video"
                controls
                preload="metadata"
                playsinline
                ${posterAttr}
              >
                <source src="${escapeHtml(item.preview_path)}" type="video/mp4">
              </video>
            `
            : `
              <div class="no-video">まだ動画プレビューがありません</div>
            `
        }

        ${
          adminMode
            ? `
              <form method="POST" action="/admin/delete" class="admin-delete-form">
                <input type="hidden" name="postUrl" value="${escapeHtml(item.post_url)}">
                <button type="submit" class="delete-btn">このランキングを削除</button>
              </form>
            `
            : ""
        }
      </div>
    `;
  }).join("");
}

function renderPage({
  inputUrl = "",
  postId = "",
  message = "",
  canDownload = false,
  adminMode = false
}) {
  const ranking24h = getRanking("24h");
  const ranking7d = getRanking("7d");
  const ranking30d = getRanking("30d");

  return `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(PAGE_TITLE)}</title>
  ${JUICYADS_SITE_VERIFICATION}
  <link rel="stylesheet" href="/public/style.css">
</head>
<body>
  <div class="container">
    <div class="top-mini-nav">
      <button class="mini-nav-btn" data-page="save-page" type="button">保存</button>
      <button class="mini-nav-btn active" data-page="ranking-page" type="button">ランキング</button>
    </div>

    <h1 class="title">${escapeHtml(SITE_NAME)}</h1>

    ${
      adminMode
        ? `
          <div class="admin-topbar">
            <div class="admin-badge">管理者モード</div>
            <form method="POST" action="/admin/logout">
              <button type="submit" class="logout-btn">ログアウト</button>
            </form>
          </div>
        `
        : `
          <div class="admin-login-link-wrap">
            <a href="/admin/login" class="admin-login-link">管理者ログイン</a>
          </div>
        `
    }

    <div id="save-page" class="page-section">
      <form method="POST" action="/extract" class="form-box">
        <input
          type="url"
          name="postUrl"
          class="url-input"
          placeholder="ここにURLをペースト"
          value="${escapeHtml(inputUrl)}"
          required
        />

        <div class="button-row">
          <button type="submit" class="btn btn-blue">抜き出し</button>
          <a href="/" class="btn btn-pink reset-link">リセット</a>
        </div>
      </form>

      ${message ? `<div class="message">${escapeHtml(message)}</div>` : ""}

      ${
        inputUrl
          ? `
          <div class="result-card">
            <div class="result-item">
              <span class="label">元URL</span>
              <div class="value break">${escapeHtml(inputUrl)}</div>
            </div>

            <div class="result-item">
              <span class="label">post_id</span>
              <div class="value">${escapeHtml(postId || "取得できませんでした")}</div>
            </div>

            ${
              canDownload
                ? `
                <div class="result-item">
                  <span class="label">保存</span>
                  <div style="margin-top:12px;">
                    <a href="/download?postUrl=${encodeURIComponent(inputUrl)}" class="download-btn">
                      ダウンロード
                    </a>
                  </div>
                </div>

                <div class="iphone-note">
                  <strong>iPhoneの方へ</strong><br>
                  ダウンロード後に自動保存されない場合は、開いた動画画面で<br>
                  <strong>共有 → ファイルに保存</strong><br>
                  を使って保存してください。
                </div>
                `
                : ""
            }
          </div>
          `
          : ""
      }
    </div>

    <div id="ranking-page" class="page-section active">
      <div class="ranking-section">
        <h2>保存ランキング</h2>

        <div class="ranking-tabs">
          <button class="ranking-tab active" data-tab="tab-24h" type="button">24時間</button>
          <button class="ranking-tab" data-tab="tab-7d" type="button">1週間</button>
          <button class="ranking-tab" data-tab="tab-30d" type="button">1か月</button>
        </div>

        <div id="tab-24h" class="ranking-panel active">
          ${renderRankingItems(ranking24h, adminMode)}
        </div>

        <div id="tab-7d" class="ranking-panel">
          ${renderRankingItems(ranking7d, adminMode)}
        </div>

        <div id="tab-30d" class="ranking-panel">
          ${renderRankingItems(ranking30d, adminMode)}
        </div>
      </div>
    </div>

    <footer class="site-footer footer-box">
      <div class="footer-text">
        権利者様から削除依頼をいただいた場合は、匿名でも確認後に削除対応します。
      </div>
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
  </script>
</body>
</html>
  `;
}

app.get("/", (req, res) => {
  res.send(renderPage({
    adminMode: isAdmin(req)
  }));
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

  if (!postUrl) {
    return res.send(renderPage({
      message: "URLを入力してください",
      adminMode: isAdmin(req)
    }));
  }

  const postId = extractPostId(postUrl);

  if (!postId) {
    return res.send(
      renderPage({
        inputUrl: postUrl,
        message: "status/数字 を含むXのURLを入れてください",
        adminMode: isAdmin(req)
      })
    );
  }

  ensurePost(postUrl);

  try {
    const info = await getTweetInfo(postUrl);
    updatePostMeta(postUrl, { thumbnailUrl: info.thumbnailUrl });
  } catch (e) {
    console.error("extract info error:", e);
  }

  return res.send(
    renderPage({
      inputUrl: postUrl,
      postId,
      canDownload: true,
      message: "抜き出し完了。ダウンロードボタンを押してください。",
      adminMode: isAdmin(req)
    })
  );
});

app.get("/download", (req, res) => {
  const postUrl = String(req.query.postUrl || "").trim();

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

  execFile("yt-dlp", args, { maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
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

    const cachePath = path.join(CACHE_DIR, `${postId}.mp4`);
    fs.copyFileSync(filePath, cachePath);
    updatePostMeta(postUrl, { previewPath: `/cache/${postId}.mp4` });

    recordSave(postUrl);

    res.download(filePath, `${postId}.mp4`, (downloadErr) => {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (cleanupErr) {
        console.error("cleanup error:", cleanupErr);
      }

      if (downloadErr) {
        console.error("res.download error:", downloadErr);
      }
    });
  });
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
