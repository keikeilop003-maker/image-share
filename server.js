const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const TAGS_FILE = path.join(UPLOAD_DIR, '_tags.json');
const ARCHIVE_DIR = path.join(UPLOAD_DIR, '_archives');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ── タグ/メタデータ永続化 ──
function loadTags() {
  if (!fs.existsSync(TAGS_FILE)) return { tags: [], fileTags: {}, fileMeta: {} };
  try {
    const d = JSON.parse(fs.readFileSync(TAGS_FILE, 'utf8'));
    if (!d.fileMeta) d.fileMeta = {};
    return d;
  }
  catch { return { tags: [], fileTags: {}, fileMeta: {} }; }
}
function saveTags(data) {
  fs.writeFileSync(TAGS_FILE, JSON.stringify(data, null, 2));
}

const ALLOWED_EXT = /\.(jpg|jpeg|png|gif|webp|svg|bmp|tiff?|pdf|docx?|txt|rtf)$/i;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${timestamp}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  if (ALLOWED_EXT.test(path.extname(file.originalname))) cb(null, true);
  else cb(new Error('非対応ファイル形式'), false);
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 100 * 1024 * 1024, files: 50 } });

// ── ファイル直接配信（日本語ファイル名対応）──
app.get('/file/:filename', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).send('Bad request');
  }
  const filepath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).send('Not found');
  res.sendFile(filepath);
});

// ── ファイル一覧（タグ情報・表示名含む）──
app.get('/api/images', (req, res) => {
  const tagData = loadTags();
  const files = fs.readdirSync(UPLOAD_DIR)
    .filter(f => ALLOWED_EXT.test(f))
    .map(f => {
      const stat = fs.statSync(path.join(UPLOAD_DIR, f));
      const meta = tagData.fileMeta[f] || {};
      return {
        filename: f,
        displayName: meta.originalname || f,
        size: stat.size,
        uploadedAt: meta.uploadedAt || stat.mtime.toISOString(),
        url: `/file/${encodeURIComponent(f)}`,
        tags: tagData.fileTags[f] || []
      };
    })
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  res.json({ files, tags: tagData.tags });
});

// ── アップロード ──
app.post('/api/upload', upload.array('images', 50), (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'ファイルなし' });
  const tagData = loadTags();
  const uploadedAt = new Date().toISOString();
  req.files.forEach(f => {
    let originalname = f.originalname;
    try { originalname = decodeURIComponent(escape(f.originalname)); } catch {}
    tagData.fileMeta[f.filename] = { originalname, uploadedAt };
  });
  saveTags(tagData);
  res.json({ count: req.files.length, files: req.files.map(f => ({ filename: f.filename })) });
});

// ── アーカイブ（複数）──
app.post('/api/archive', (req, res) => {
  const { filenames } = req.body;
  if (!filenames || filenames.length === 0) return res.status(400).json({ error: 'ファイル未指定' });
  const tagData = loadTags();
  const archived = [];
  for (const f of filenames) {
    if (f.includes('..') || f.includes('/') || f.includes('\\')) continue;
    const src = path.join(UPLOAD_DIR, f);
    const dst = path.join(ARCHIVE_DIR, f);
    if (!fs.existsSync(src)) continue;
    fs.renameSync(src, dst);
    archived.push(f);
    delete tagData.fileTags[f];
  }
  saveTags(tagData);
  res.json({ archived });
});

// ── ファイル削除 ──
app.post('/api/delete', (req, res) => {
  const { filenames } = req.body;
  if (!filenames || filenames.length === 0) return res.status(400).json({ error: 'ファイル未指定' });
  const tagData = loadTags();
  const deleted = [];
  for (const f of filenames) {
    if (f.includes('..') || f.includes('/') || f.includes('\\')) continue;
    const fp = path.join(UPLOAD_DIR, f);
    if (!fs.existsSync(fp)) continue;
    fs.unlinkSync(fp);
    deleted.push(f);
    delete tagData.fileTags[f];
    delete tagData.fileMeta[f];
  }
  saveTags(tagData);
  res.json({ deleted });
});

// ── アーカイブファイル配信 ──
app.get('/archive-file/:filename', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).send('Bad request');
  }
  const filepath = path.join(ARCHIVE_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).send('Not found');
  res.sendFile(filepath);
});

// ── アーカイブ一覧 ──
app.get('/api/archives', (req, res) => {
  const tagData = loadTags();
  const files = fs.readdirSync(ARCHIVE_DIR)
    .filter(f => ALLOWED_EXT.test(f))
    .map(f => {
      const stat = fs.statSync(path.join(ARCHIVE_DIR, f));
      const meta = tagData.fileMeta[f] || {};
      return {
        filename: f,
        displayName: meta.originalname || f,
        size: stat.size,
        uploadedAt: meta.uploadedAt || stat.mtime.toISOString()
      };
    })
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  res.json({ files });
});

// ── アーカイブ単一ダウンロード ──
app.get('/api/download-archive/:filename', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  const tagData = loadTags();
  const displayName = tagData.fileMeta[filename]?.originalname || filename;
  const filepath = path.join(ARCHIVE_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'ファイル不存在' });
  res.download(filepath, displayName);
});

// ── 単一ダウンロード ──
app.get('/api/download/:filename', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  const tagData = loadTags();
  const displayName = tagData.fileMeta[filename]?.originalname || filename;
  const filepath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'ファイル不存在' });
  res.download(filepath, displayName);
});

// ── ZIP一括ダウンロード ──
app.post('/api/download-zip', (req, res) => {
  const { filenames } = req.body;
  if (!filenames || filenames.length === 0) return res.status(400).json({ error: 'ファイル未指定' });
  const tagData = loadTags();
  const valid = filenames.filter(f => {
    const fp = path.join(UPLOAD_DIR, f);
    return fs.existsSync(fp) && !f.includes('..');
  });
  if (valid.length === 0) return res.status(404).json({ error: 'ファイル不存在' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="files_${Date.now()}.zip"`);
  const arc = archiver('zip', { zlib: { level: 6 } });
  arc.on('error', err => res.status(500).json({ error: err.message }));
  arc.pipe(res);
  valid.forEach(f => {
    const displayName = tagData.fileMeta[f]?.originalname || f;
    arc.file(path.join(UPLOAD_DIR, f), { name: displayName });
  });
  arc.finalize();
});

// ── タグ一覧 ──
app.get('/api/tags', (req, res) => res.json(loadTags().tags));

// ── タグ作成 ──
app.post('/api/tags', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '名前必須' });
  const data = loadTags();
  if (data.tags.some(t => t.name === name.trim())) return res.status(400).json({ error: '同名タグ存在' });
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const tag = { id, name: name.trim() };
  data.tags.push(tag);
  saveTags(data);
  res.json(tag);
});

// ── タグ削除 ──
app.delete('/api/tags/:id', (req, res) => {
  const data = loadTags();
  data.tags = data.tags.filter(t => t.id !== req.params.id);
  for (const f in data.fileTags) {
    data.fileTags[f] = data.fileTags[f].filter(id => id !== req.params.id);
  }
  saveTags(data);
  res.json({ ok: true });
});

// ── ファイルのタグ更新 ──
app.put('/api/files/:filename/tags', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  if (filename.includes('..')) return res.status(400).json({ error: '不正なパス' });
  const { tagIds } = req.body;
  const data = loadTags();
  data.fileTags[filename] = tagIds || [];
  saveTags(data);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`サーバー起動: http://localhost:${PORT}`);
  console.log(`保存先: ${UPLOAD_DIR}`);
});
