/** 极简 bencode 解码：只取 .torrent 里的 info.name / files / length，零依赖 */
const MAX_DEPTH = 24;

function parseBuffer(buf) {
  let i = 0;

  function read(depth) {
    if (depth > MAX_DEPTH) throw new Error('种子层级过深');
    if (i >= buf.length) throw new Error('种子文件不完整');
    const c = buf[i];

    // 整数：i<num>e
    if (c === 0x69) {
      const end = buf.indexOf(0x65, i + 1);
      if (end < 0) throw new Error('种子整数格式错误');
      const n = Number(buf.toString('utf8', i + 1, end));
      i = end + 1;
      return n;
    }
    // 列表：l...e
    if (c === 0x6c) {
      i += 1;
      const arr = [];
      while (buf[i] !== 0x65) {
        if (i >= buf.length) throw new Error('种子列表未闭合');
        arr.push(read(depth + 1));
      }
      i += 1;
      return arr;
    }
    // 字典：d...e
    if (c === 0x64) {
      i += 1;
      const obj = {};
      while (buf[i] !== 0x65) {
        if (i >= buf.length) throw new Error('种子字典未闭合');
        const key = read(depth + 1);
        obj[String(key)] = read(depth + 1);
      }
      i += 1;
      return obj;
    }
    // 字符串：<len>:<bytes>
    if (c >= 0x30 && c <= 0x39) {
      const colon = buf.indexOf(0x3a, i);
      if (colon < 0) throw new Error('种子字符串格式错误');
      const len = Number(buf.toString('utf8', i, colon));
      if (!Number.isFinite(len) || len < 0 || len > buf.length) throw new Error('种子字符串长度异常');
      const start = colon + 1;
      const end = start + len;
      if (end > buf.length) throw new Error('种子文件被截断');
      i = end;
      return buf.subarray(start, end);
    }
    throw new Error('无法识别的种子格式');
  }

  return read(0);
}

function text(v) {
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  return String(v ?? '');
}

/**
 * @param {Buffer|string} input .torrent 原始字节
 * @returns {{name:string, files:{index:number,path:string,length:number}[], total:number}}
 */
export function decodeTorrent(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (!buf.length || buf.length > 8 * 1024 * 1024) throw new Error('种子文件大小异常');
  const root = parseBuffer(buf);
  const info = root?.info;
  if (!info || typeof info !== 'object') throw new Error('种子缺少 info 段');

  const name = text(info.name) || '未命名种子';
  let files = [];
  if (Array.isArray(info.files)) {
    files = info.files.map((f, n) => {
      const parts = Array.isArray(f?.path) ? f.path.map(text) : [];
      return {
        index: n + 1,
        path: parts.length ? parts.join('/') : name,
        length: Number(f?.length) || 0,
      };
    });
  } else {
    files = [{ index: 1, path: name, length: Number(info.length) || 0 }];
  }
  return {
    name,
    files,
    total: files.reduce((sum, f) => sum + f.length, 0),
  };
}
