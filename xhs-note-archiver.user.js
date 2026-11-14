// ==UserScript==
// @name         小红书笔记存档 XHS Note Archiver (含视频下载)
// @namespace    https://github.com/Andy8r0X/xhs-note-archiver
// @version      1.2.0
// @description  把当前笔记的图片、视频和正文存到指定文件夹，每篇一个子目录。不调用任何分页接口。
// @match        *://*.rednote.com/*
// @match        *://*.xiaohongshu.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @connect      xhscdn.com
// @connect      rednotecdn.com
// @connect      xhslink.com
// @run-at       document-idle
// @author       firmamento73, Andy8r0X (Modified)
// @license      MIT
// @homepageURL  https://github.com/Andy8r0X/xhs-note-archiver
// @supportURL   https://github.com/Andy8r0X/xhs-note-archiver/issues
// ==/UserScript==

/*
 * 设计前提：不主动发起任何 xiaohongshu.com / rednote.com 的 API 请求。
 *   - 正文/作者/标签/评论  → 读页面已有的 __INITIAL_STATE__ 与 meta，纯内存，零请求
 *   - 图片/视频          → 只打静态 CDN，不触发站内风控
 */

(function () {
  'use strict';

  const CONFIG = {
    saveText: true,
    saveJson: false,         // 额外存原始 note 数据
    saveVideoCover: false,   // 视频笔记是否同时保存封面图
    convertToPng: false,     // webp 转 png
    txtCRLF: true,           // \r\n 换行，记事本友好
    skipExisting: true,      // 同名文件已存在就跳过
    imageDelay: 400,         // 图片之间的间隔（毫秒）

    comments: {
      minLikes: 0,
      maxCount: 0,
      keepSubComments: true,
      subMinLikes: 0,
    },
  };

  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const FSA_OK = typeof W.showDirectoryPicker === 'function';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (ms) => Math.round(ms * (0.7 + Math.random() * 0.6));

  const LS_COMMENTS = 'xhs-dl-include-comments';
  let includeComments = localStorage.getItem(LS_COMMENTS) === '1';

  /* ==================== 目录句柄持久化 ==================== */
  const DB_NAME = 'xhs-dl', STORE = 'handles', KEY = 'root';
  function openDB() {
    return new Promise((res, rej) => {
      const r = W.indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idbGet(k) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const q = db.transaction(STORE, 'readonly').objectStore(STORE).get(k);
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
  }
  async function idbSet(k, v) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const t = db.transaction(STORE, 'readwrite');
      t.objectStore(STORE).put(v, k);
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    });
  }

  let rootHandle = null;
  const hasPerm = async (h) => (await h.queryPermission({ mode: 'readwrite' })) === 'granted';
  async function ensurePerm(h) {
    if (await hasPerm(h)) return true;
    return (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
  }
  async function pickFolder() {
    try {
      rootHandle = await W.showDirectoryPicker.call(W, { id: 'xhs-dl', mode: 'readwrite', startIn: 'downloads' });
      await idbSet(KEY, rootHandle);
      return true;
    } catch (e) {
      if (e.name !== 'AbortError') console.warn('[XHS] 选择文件夹失败', e);
      return false;
    }
  }

  /* ==================== 读状态树（零请求） ==================== */
  const noteIdFromUrl = () =>
    (location.pathname.match(/\/(?:explore|discovery\/item)\/([0-9a-f]{20,32})/) || [])[1];
  const strip = (u) => u.split('!')[0].split('?')[0];
  const toHttps = (u) => (typeof u === 'string' ? u.replace(/^http:\/\//i, 'https://') : '');

  function urlCandidates(img) {
    const info = img.infoList || [];
    const dft = info.find((i) => i.imageScene === 'WB_DFT');
    const raw = [dft && dft.url, img.urlDefault, ...info.map((i) => i.url), img.urlPre].filter(Boolean);
    const list = [];
    for (const u of raw) {
      const hu = toHttps(u);
      list.push(strip(hu), hu);
    }
    if (img.traceId) {
      list.push(`https://sns-img-qc.xhscdn.com/${img.traceId}`);
      list.push(`https://sns-img-qc.rednotecdn.com/${img.traceId}`);
    }
    return [...new Set(list)];
  }

  // 针对新版 EF4/h264/originVideoKey 与 og:video 的完整视频提取
  function videoCandidates(note) {
    const list = [];
    const videoObj = note.video || {};

    // 1. 优先尝试无水印源视频 Key (originVideoKey)
    const originKey = videoObj.consumer && videoObj.consumer.originVideoKey;
    if (originKey) {
      list.push(`https://sns-video-bd.xhscdn.com/${originKey}`);
      list.push(`https://sns-video-bd.rednotecdn.com/${originKey}`);
    }

    // 2. 动态遍历 media.stream 下的所有编码格式 (包含 EF4, EF5, EF6, EF7, h264, h265, av1 等)
    const mediaStreams = videoObj.media && videoObj.media.stream;
    if (mediaStreams && typeof mediaStreams === 'object') {
      Object.values(mediaStreams).forEach((arr) => {
        if (Array.isArray(arr)) {
          // 若有多条流，优先按码率(avgBitrate)或画质排序
          const sorted = arr.slice().sort((a, b) => (b.avgBitrate || 0) - (a.avgBitrate || 0));
          sorted.forEach((stream) => {
            if (stream && stream.masterUrl) list.push(toHttps(stream.masterUrl));
            if (stream && Array.isArray(stream.backupUrls)) {
              stream.backupUrls.forEach((bu) => list.push(toHttps(bu)));
            }
          });
        }
      });
    }

    // 3. 保底读取页面 <meta name="og:video"> 标签
    const ogVideo = document.querySelector('meta[name="og:video"], meta[property="og:video"]');
    if (ogVideo && ogVideo.content) {
      list.push(toHttps(ogVideo.content));
    }

    if (videoObj.url) list.push(toHttps(videoObj.url));

    return [...new Set(list.filter(Boolean))];
  }

  function readState() {
    const st = W.__INITIAL_STATE__;
    const map = st && st.note && st.note.noteDetailMap;
    if (!map) return null;
    const id = noteIdFromUrl() || st.note.currentNoteId || st.note.firstNoteId;
    const entry = (id && map[id]) ||
      Object.values(map).find((v) => v && v.note && (v.note.imageList || v.note.video));
    if (!entry || !entry.note) return null;
    return {
      note: entry.note,
      comments: (entry.comments && entry.comments.list) || [],
      id: entry.note.noteId || id || '',
    };
  }

  /* ==================== UI ==================== */
  const box = document.createElement('div');
  Object.assign(box.style, {
    position: 'fixed', right: '24px', bottom: '110px', zIndex: '99999',
    display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px',
  });

  const chip = (txt) => {
    const b = document.createElement('button');
    b.textContent = txt;
    Object.assign(b.style, {
      padding: '5px 12px', border: '1px solid #ddd', borderRadius: '999px',
      background: '#fff', color: '#666', fontSize: '12px', cursor: 'pointer',
      boxShadow: '0 2px 8px rgba(0,0,0,.12)', maxWidth: '230px',
      overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
    });
    return b;
  };

  const cmtBtn = chip('');
  const dirBtn = chip('');
  const btn = document.createElement('button');
  const IDLE = '⬇ 下载笔记';
  btn.textContent = IDLE;
  Object.assign(btn.style, {
    padding: '10px 16px', border: 'none', borderRadius: '999px',
    background: '#ff2442', color: '#fff', fontSize: '14px', cursor: 'pointer',
    boxShadow: '0 4px 14px rgba(0,0,0,.25)',
  });
  box.append(cmtBtn, dirBtn, btn);
  document.body.appendChild(box);
  const setText = (t) => (btn.textContent = t);

  function refreshChips() {
    const n = (readState() || { comments: [] }).comments.length;
    cmtBtn.textContent = includeComments ? `💬 含评论（当前 ${n} 条）` : '💬 不含评论';
    cmtBtn.style.color = includeComments ? '#ff2442' : '#999';
    cmtBtn.style.borderColor = includeComments ? '#ffccd5' : '#ddd';
    if (!FSA_OK) { dirBtn.textContent = '📁 浏览器下载目录'; dirBtn.disabled = true; return; }
    dirBtn.textContent = rootHandle ? `📁 ${rootHandle.name}` : '📁 点此选择保存位置';
  }
  cmtBtn.onclick = () => {
    includeComments = !includeComments;
    localStorage.setItem(LS_COMMENTS, includeComments ? '1' : '0');
    refreshChips();
  };
  dirBtn.onclick = async () => { if (await pickFolder()) refreshChips(); };

  (async () => {
    if (FSA_OK) { try { rootHandle = (await idbGet(KEY)) || null; } catch (e) {} }
    refreshChips();
    setInterval(refreshChips, 2000);
  })();

  /* ==================== 评论筛选（纯本地） ==================== */
  function num(v) {
    if (typeof v === 'number') return v;
    const m = String(v == null ? '0' : v).trim().match(/^([\d.]+)\s*(万|w|k)?$/i);
    if (!m) return 0;
    const n = parseFloat(m[1]) || 0;
    const u = (m[2] || '').toLowerCase();
    return u === '万' || u === 'w' ? n * 1e4 : u === 'k' ? n * 1e3 : n;
  }
  function filterComments(list) {
    const c = CONFIG.comments;
    let out = list.filter((x) => num(x.likeCount) >= c.minLikes);
    if (c.maxCount > 0 && out.length > c.maxCount) {
      const order = new Map(list.map((x, i) => [x.id, i]));
      out = out.slice()
        .sort((a, b) => num(b.likeCount) - num(a.likeCount))
        .slice(0, c.maxCount)
        .sort((a, b) => order.get(a.id) - order.get(b.id));
    }
    return out.map((x) => Object.assign({}, x, {
      subComments: c.keepSubComments ? (x.subComments || []).filter((s) => num(s.likeCount) >= c.subMinLikes) : [],
    }));
  }

  /* ==================== 文本 ==================== */
  const NL = CONFIG.txtCRLF ? '\r\n' : '\n';
  function fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(Number(ts));
    if (isNaN(d)) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  const cleanDesc = (s) => (s || '').replace(/#([^#\[\]]+)\[话题\]#/g, '#$1').replace(/\r?\n/g, NL);

  function fmtComment(c, depth) {
    const pad = '    '.repeat(depth);
    const u = c.userInfo || {};
    const author = (c.showTags || []).includes('is_author') ? '［作者］' : '';
    const like = num(c.likeCount) ? ` ♥${c.likeCount}` : '';
    const meta = [fmtDate(c.createTime), c.ipLocation].filter(Boolean).join(' · ');
    const at = c.targetComment && c.targetComment.userInfo ? `回复 @${c.targetComment.userInfo.nickname}：` : '';
    const pic = c.pictures && c.pictures.length ? ` ［附图 ${c.pictures.length} 张］` : '';
    const body = (c.content || '').replace(/\r?\n/g, NL + pad + '  ');
    let out = `${pad}${u.nickname || '匿名'}${author}${like}${meta ? '  ' + meta : ''}${NL}${pad}  ${at}${body}${pic}${NL}`;
    for (const s of c.subComments || []) out += fmtComment(s, depth + 1);
    return out;
  }

  function buildText(d, kept) {
    const n = d.note, u = n.user || {}, it = n.interactInfo || {};
    const tags = (n.tagList || []).map((t) => '#' + t.name).join(' ');
    const rule = (t) => `${NL}${'─'.repeat(12)} ${t} ${'─'.repeat(12)}${NL}`;
    const L = [];

    L.push(n.title || '(无标题)'); L.push('');
    L.push(`作者：${u.nickname || '?'}${u.userId ? '  (' + u.userId + ')' : ''}`);
    L.push(`发布：${fmtDate(n.time)}${n.ipLocation ? '  IP ' + n.ipLocation : ''}`);
    L.push(`互动：赞 ${it.likedCount || 0} · 藏 ${it.collectedCount || 0} · 评 ${it.commentCount || 0}`);
    if (n.type === 'video' || n.video) L.push(`类型：视频笔记`);
    else L.push(`图片：${(n.imageList || []).length} 张`);
    L.push(`链接：https://www.xiaohongshu.com/explore/${d.id}`);
    L.push(`存档：${fmtDate(Date.now())}`);

    L.push(rule('正文'));
    L.push(cleanDesc(n.desc) || '(无正文)');
    if (tags) { L.push(''); L.push(tags); }

    if (kept.length) {
      const total = it.commentCount || '?';
      L.push(rule(`评论（页面已加载 ${d.comments.length} 条，保留 ${kept.length}，全帖共 ${total} 条）`));
      for (const x of kept) L.push(fmtComment(x, 0));
    }
    return '\ufeff' + L.join(NL);
  }

  /* ==================== 抓取通用方法 ==================== */
  const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };

  const fetchBlob = (url, isVideo = false) =>
    new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'blob', timeout: isVideo ? 180000 : 30000,
        headers: { Referer: location.origin + '/' },
        onprogress: (e) => {
          if (isVideo && e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            setText(`下载视频 ${pct}%`);
          }
        },
        onload: (r) => {
          if (r.status !== 200) return reject(new Error('HTTP ' + r.status));
          const b = r.response;
          if (!b || b.size < 1024) return reject(new Error(`bad body size: ${b && b.size}B`));
          if (!isVideo && !b.type.startsWith('image/')) return reject(new Error(`bad body type: ${b.type}`));
          resolve(b);
        },
        onerror: () => reject(new Error('network')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });

  async function fetchAny(cands, idx, isVideo = false) {
    const log = [];
    for (const url of cands) {
      try { return { blob: await fetchBlob(url, isVideo), url }; }
      catch (e) { log.push(`  ${e.message}  ${url}`); }
    }
    console.warn(`[XHS] 第${idx}个资源 全部候选失败:${NL}` + log.join(NL));
    return null;
  }

  async function toPng(blob) {
    if (!CONFIG.convertToPng || blob.type === 'image/png') return blob;
    try {
      const bmp = await createImageBitmap(blob);
      const cv = new OffscreenCanvas(bmp.width, bmp.height);
      cv.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close();
      return await cv.convertToBlob({ type: 'image/png' });
    } catch (e) { console.warn('[XHS] 转 png 失败', e); return blob; }
  }

  /* ==================== 落盘 ==================== */
  function safeName(s, max) {
    return (s || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ')
      .trim().slice(0, max || 60).replace(/[. ]+$/, '') || 'note';
  }
  const folderName = (d) => safeName(d.note.title || d.note.desc, 50) + (d.id ? '_' + d.id.slice(-6) : '');

  async function writeToDir(dir, name, blob) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(blob); await w.close();
  }
  async function anyExists(dir, stem) {
    const extensions = ['mp4', 'mkv', 'webm', 'mov', 'jpg', 'png', 'webp', 'gif', 'avif'];
    for (const e of extensions) {
      try { await dir.getFileHandle(`${stem}.${e}`); return true; } catch (err) {}
    }
    return false;
  }
  function gmDownload(url, path) {
    return new Promise((resolve) => {
      GM_download({
        url, name: path, saveAs: false,
        headers: { Referer: location.origin + '/' },
        onload: () => resolve(true),
        onerror: (e) => { console.warn('[XHS] GM_download 失败', path, e); resolve(false); },
        ontimeout: () => resolve(false),
      });
    });
  }
  function anchorSave(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /* ==================== 主流程 ==================== */
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const d = readState();
      if (!d) { setText('没读到笔记数据'); return; }

      let dir = null;
      if (FSA_OK) {
        if (!rootHandle) {
          setText('请选择保存位置…');
          if (!(await pickFolder())) { setText('已取消'); return; }
          refreshChips();
        }
        if (!(await ensurePerm(rootHandle))) { setText('没有写入权限'); return; }
        dir = await rootHandle.getDirectoryHandle(folderName(d), { create: true });
      }

      const kept = includeComments ? filterComments(d.comments) : [];
      const folder = folderName(d);

      if (CONFIG.saveText) {
        setText('写入正文…');
        const txt = new Blob([buildText(d, kept)], { type: 'text/plain;charset=utf-8' });
        const tname = safeName(d.note.title || d.id, 50) + '.txt';
        if (dir) await writeToDir(dir, tname, txt); else anchorSave(txt, tname);
      }
      if (CONFIG.saveJson) {
        const js = new Blob([JSON.stringify({ note: d.note, comments: d.comments }, null, 2)], { type: 'application/json' });
        if (dir) await writeToDir(dir, 'note.json', js); else anchorSave(js, 'note.json');
      }

      let ok = 0, skip = 0;
      const isVideoNote = d.note.type === 'video' || Boolean(d.note.video);

      if (isVideoNote) {
        const vCands = videoCandidates(d.note);
        const stem = 'video_01';
        if (dir && CONFIG.skipExisting && await anyExists(dir, stem)) {
          skip++; ok++;
        } else {
          setText('准备下载视频…');
          const got = await fetchAny(vCands, 1, true);
          if (got) {
            try {
              const file = `${stem}.mp4`;
              if (dir) { await writeToDir(dir, file, got.blob); ok++; }
              else if (await gmDownload(got.url, `xiaohongshu/${folder}/${file}`)) ok++;
            } catch (e) { console.warn('[XHS] 视频保存失败', e); }
          }
        }

        // 若开启保存视频封面
        if (CONFIG.saveVideoCover && d.note.imageList && d.note.imageList.length) {
          const coverGot = await fetchAny(urlCandidates(d.note.imageList[0]), 0, false);
          if (coverGot && dir) {
            const cBlob = await toPng(coverGot.blob);
            await writeToDir(dir, `cover.${EXT[cBlob.type] || 'jpg'}`, cBlob);
          }
        }

        const where = dir ? `${rootHandle.name}/${folder}` : `下载目录/xiaohongshu/${folder}`;
        console.log(`[XHS] 视频 ${ok}/1，评论 ${kept.length} → ${where}`);
        setText(ok ? `完成 1视频${kept.length ? ' ' + kept.length + '评' : ''}${skip ? '（跳过）' : ''}` : '视频下载失败');
      } else {
        const imgs = (d.note.imageList || []).map(urlCandidates);
        for (let i = 0; i < imgs.length; i++) {
          const stem = String(i + 1).padStart(2, '0');
          if (dir && CONFIG.skipExisting && await anyExists(dir, stem)) { skip++; ok++; continue; }

          setText(`下载图片 ${i + 1}/${imgs.length}`);
          const got = await fetchAny(imgs[i], i + 1, false);
          if (got) {
            try {
              const blob = await toPng(got.blob);
              const file = `${stem}.${EXT[blob.type] || 'jpg'}`;
              if (dir) { await writeToDir(dir, file, blob); ok++; }
              else if (await gmDownload(got.url, `xiaohongshu/${folder}/${file}`)) ok++;
            } catch (e) { console.warn('[XHS] 保存失败', i + 1, e); }
          }
          await sleep(jitter(CONFIG.imageDelay));
        }

        const where = dir ? `${rootHandle.name}/${folder}` : `下载目录/xiaohongshu/${folder}`;
        console.log(`[XHS] 图片 ${ok}/${imgs.length}${skip ? `（跳过已有 ${skip}）` : ''}，评论 ${kept.length} → ${where}`);
        setText(`完成 ${ok}图${kept.length ? ' ' + kept.length + '评' : ''}${skip ? `（跳${skip}）` : ''}`);
      }
    } catch (e) {
      console.error('[XHS] 出错', e);
      setText('出错，见控制台');
    } finally {
      setTimeout(() => { setText(IDLE); btn.disabled = false; }, 3000);
    }
  };
})();
