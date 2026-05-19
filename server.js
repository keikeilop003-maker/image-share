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

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static(UPLOAD_DIR));

// ── タグデータ永続化 ──
function loadTags() {
  if (!fs.existsSync(TAGS_FILE)) return { tags: [], fileTags: {} };
  try { return JSON.parse(fs.readFileSync(TAGS_FILE, 'utf8')); }
  catch { return { tags: [], fileTags: {} }; }
}
function saveTags(data) {
  fs.writeFileSync(TAGS_FILE, JSON.stringify(data, null, 2));
}

const ALLOWED_EXT = /\.(jpg|jpeg|png|gif|webp|svg|bmp|tiff?|pdf|docx?)$/i;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext);
    const safeName = base.replace(/[^a-zA-Z0-9　-鿿゠-ヿ぀-ゟ\-_]/g, '_');
    cb(null, `${timestamp}_${safeName}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  if (ALLOWED_EXT.test(path.extname(file.originalname))) cb(null, true);
  else cb(new Error('非対応ファイル形式'), false);
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 100 * 1024 * 1024, files: 50 } });

// ── ファイル一覧（タグ情報含む）──
app.get('/api/images', (req, res) => {
  const tagData = loadTags();
  const files = fs.readdirSync(UPLOAD_DIR)
    .filter(f => ALLOWED_EXT.test(f))
    .map(f => {
      const stat = fs.statSync(path.join(UPLOAD_DIR, f));
      return {
        filename: f,
        size: stat.size,
        uploadedAt: stat.mtime.toISOString(),
        url: `/uploads/${encodeURIComponent(f)}`,
        tags: tagData.fileTags[f] || []
      };
    })
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  res.json({ files, tags: tagData.tags });
});

// ── アップロード ──
app.post('/api/upload', upload.array('images', 50), (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'ファイルなし' });
  const uploaded = req.files.map(f => ({
    filename: f.filename,
    originalname: f.originalname,
    size: f.size,
    url: `/uploads/${encodeURIComponent(f.filename)}`
  }));
  res.json({ count: uploaded.length, files: uploaded });
});

// ── 単一ダウンロード ──
app.get('/api/download/:filename', (req, res) => {
  const filepath = path.join(UPLOAD_DIR, req.params.filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'ファイル不存在' });
  res.download(filepath, req.params.filename);
});

// ── ZIP一括ダウンロード ──
app.post('/api/download-zip', (req, res) => {
  const { filenames } = req.body;
  if (!filenames || filenames.length === 0) return res.status(400).json({ error: 'ファイル未指定' });
  const valid = filenames.filter(f => {
    const fp = path.join(UPLOAD_DIR, f);
    return fs.existsSync(fp) && !f.includes('..');
  });
  if (valid.length === 0) return res.status(404).json({ error: 'ファイル不存在' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="files_${Date.now()}.zip"`);
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => res.status(500).json({ error: err.message }));
  archive.pipe(res);
  valid.forEach(f => archive.file(path.join(UPLOAD_DIR, f), { name: f }));
  archive.finalize();
});

// ── 削除 ──
app.delete('/api/images/:filename', (req, res) => {
  const { filename } = req.params;
  if (filename.includes('..')) return res.status(400).json({ error: '不正なパス' });
  const filepath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'ファイル不存在' });
  fs.unlinkSync(filepath);
  // タグ情報からも削除
  const data = loadTags();
  delete data.fileTags[filename];
  saveTags(data);
  res.json({ deleted: filename });
});

// ── タグ一覧 ──
app.get('/api/tags', (req, res) => {
  res.json(loadTags().tags);
});

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
  const { filename } = req.params;
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
