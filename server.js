const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static(UPLOAD_DIR));

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
  const allowed = /\.(jpg|jpeg|png|gif|webp|svg|bmp|tiff?)$/i;
  if (allowed.test(path.extname(file.originalname))) {
    cb(null, true);
  } else {
    cb(new Error('画像ファイルのみアップロード可能'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024, files: 50 }
});

// 画像一覧取得
app.get('/api/images', (req, res) => {
  const files = fs.readdirSync(UPLOAD_DIR)
    .filter(f => /\.(jpg|jpeg|png|gif|webp|svg|bmp|tiff?)$/i.test(f))
    .map(f => {
      const stat = fs.statSync(path.join(UPLOAD_DIR, f));
      return {
        filename: f,
        size: stat.size,
        uploadedAt: stat.mtime.toISOString(),
        url: `/uploads/${encodeURIComponent(f)}`
      };
    })
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  res.json(files);
});

// 複数アップロード
app.post('/api/upload', upload.array('images', 50), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'ファイルなし' });
  }
  const uploaded = req.files.map(f => ({
    filename: f.filename,
    originalname: f.originalname,
    size: f.size,
    url: `/uploads/${encodeURIComponent(f.filename)}`
  }));
  res.json({ count: uploaded.length, files: uploaded });
});

// 単一ダウンロード
app.get('/api/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'ファイル不存在' });
  }
  res.download(filepath, filename);
});

// 複数ZIP一括ダウンロード
app.post('/api/download-zip', (req, res) => {
  const { filenames } = req.body;
  if (!filenames || filenames.length === 0) {
    return res.status(400).json({ error: 'ファイル未指定' });
  }

  const valid = filenames.filter(f => {
    const fp = path.join(UPLOAD_DIR, f);
    return fs.existsSync(fp) && !f.includes('..');
  });

  if (valid.length === 0) {
    return res.status(404).json({ error: 'ファイル不存在' });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="images_${Date.now()}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => res.status(500).json({ error: err.message }));
  archive.pipe(res);

  valid.forEach(f => {
    archive.file(path.join(UPLOAD_DIR, f), { name: f });
  });

  archive.finalize();
});

// 削除
app.delete('/api/images/:filename', (req, res) => {
  const filename = req.params.filename;
  if (filename.includes('..')) {
    return res.status(400).json({ error: '不正なパス' });
  }
  const filepath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'ファイル不存在' });
  }
  fs.unlinkSync(filepath);
  res.json({ deleted: filename });
});

app.listen(PORT, () => {
  console.log(`サーバー起動: http://localhost:${PORT}`);
  console.log(`保存先: ${UPLOAD_DIR}`);
});
