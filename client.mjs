// music-downloader / client.mjs
// A "下载" page in Folia's home navigation. Folia's own Omni providers resolve
// the audio URL for every supported source (netease / QQ / kugou / qishui /
// bodian / YouTube Music / …); this mod captures that resolved URL through the
// official omni.audioSourceResolved hook and hands it to the main entry, which
// streams it to the Music folder. No per-platform API code lives here.

const CSS = `
.md-root { display: flex; flex-direction: column; gap: 14px; height: 100%; min-height: 0; padding: 20px 22px; box-sizing: border-box; color: var(--folium-primary, #fff); font-family: var(--folium-font, inherit); }
.md-head h1 { margin: 0; font-size: 22px; font-weight: 650; }
.md-head p { margin: 6px 0 0; font-size: 12.5px; line-height: 1.6; color: var(--folium-secondary, rgba(255,255,255,.6)); }
.md-card { border: 1px solid rgba(128,128,128,.22); border-radius: 12px; padding: 12px 14px; background: rgba(128,128,128,.08); }
.md-current { display: flex; align-items: center; gap: 12px; }
.md-current .md-meta { flex: 1; min-width: 0; }
.md-title { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.md-sub { font-size: 11.5px; opacity: .6; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.md-btn { border: 1px solid rgba(128,128,128,.34); background: transparent; color: inherit; border-radius: 999px; font-size: 12px; font-family: inherit; padding: 6px 14px; cursor: pointer; white-space: nowrap; }
.md-btn:hover { background: rgba(128,128,128,.14); }
.md-btn.primary { background: var(--folium-accent, #6d7cff); border-color: transparent; color: #fff; }
.md-btn.primary:hover { filter: brightness(1.08); }
.md-btn:disabled { opacity: .45; cursor: default; }
.md-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.md-toolbar .md-spacer { flex: 1; }
.md-status { font-size: 11.5px; opacity: .62; min-height: 16px; }
.md-list { flex: 1; min-height: 0; overflow-y: auto; border: 1px solid rgba(128,128,128,.18); border-radius: 12px; }
.md-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid rgba(128,128,128,.12); font-size: 12.5px; }
.md-row:last-child { border-bottom: 0; }
.md-idx { width: 26px; flex: none; opacity: .45; font-variant-numeric: tabular-nums; }
.md-row .md-meta { flex: 1; min-width: 0; }
.md-badge { flex: none; font-size: 11px; padding: 2px 9px; border-radius: 999px; background: rgba(128,128,128,.18); opacity: .8; }
.md-badge.ok { background: rgba(80, 200, 120, .18); opacity: .9; }
.md-badge.wait { background: rgba(255, 190, 80, .18); }
.md-empty { padding: 28px 16px; text-align: center; font-size: 12.5px; opacity: .55; }
`;

const fmtTime = (seconds) => {
    const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    const m = Math.floor(safe / 60);
    const s = safe - m * 60;
    return `[${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}]`;
};

const buildLrc = (song, lines) => {
    if (!Array.isArray(lines) || lines.length === 0) return '';
    const head = [`[ti:${song?.title ?? ''}]`, `[ar:${song?.artist ?? ''}]`, `[al:${song?.album ?? ''}]`, '[by:Folia 缓存下载器]', ''];
    const body = [];
    for (const line of lines) {
        if (!line || typeof line.fullText !== 'string' || !line.fullText.trim()) continue;
        const t = fmtTime(Number(line.startTime));
        body.push(`${t}${line.fullText}`);
        if (typeof line.translation === 'string' && line.translation.trim()) body.push(`${t}${line.translation}`);
    }
    return [...head, ...body].join('\n');
};

const songKey = (song) => `${song?.source ?? ''}:${song?.id ?? ''}`;

const describeSong = (song) => ({
    source: typeof song?.source === 'string' ? song.source : null,
    id: typeof song?.id === 'string' ? song.id : null,
    title: typeof song?.title === 'string' ? song.title : '',
    artist: typeof song?.artist === 'string' ? song.artist : '',
    album: typeof song?.album === 'string' ? song.album : '',
});

export default function activate(folium) {
    if (folium.env.context !== 'main') return undefined;

    const toast = (message, type = 'info') => {
        try {
            folium.ui.toast(message, { type, durationMs: type === 'success' ? 6000 : 4000 });
        } catch {
            /* optional */
        }
    };
    const rpc = (name, payload) => folium.rpc.call(name, payload);

    // Resolved audio URLs, keyed by source + id. Folia resolves one every time
    // it starts a track; the URL is what it would stream right now (so it uses
    // the quality the user picked in Folia).
    const resolvedUrls = new Map();
    const urlWaiters = new Map();
    let activeToken = 0;

    const hooks = folium.experimental?.['omni.hooks'];
    let offHook = null;
    if (hooks && typeof hooks.on === 'function') {
        offHook = hooks.on('audioSourceResolved', (event) => {
            const url = typeof event?.url === 'string' ? event.url : null;
            const song = event?.song;
            if (!url || !song) return;
            const key = songKey(song);
            resolvedUrls.set(key, url);
            if (resolvedUrls.size > 500) resolvedUrls.clear();
            const waiter = urlWaiters.get(key);
            if (waiter) {
                urlWaiters.delete(key);
                waiter(url);
            }
        });
    }

    const waitForUrl = (song, timeoutMs = 12000) => {
        const key = songKey(song);
        const cached = resolvedUrls.get(key);
        if (cached) return Promise.resolve(cached);
        return new Promise((resolve) => {
            let done = false;
            const finish = (value) => {
                if (done) return;
                done = true;
                urlWaiters.delete(key);
                clearTimeout(timer);
                resolve(value);
            };
            const timer = setTimeout(() => finish(null), timeoutMs);
            urlWaiters.set(key, finish);
            try {
                folium.playback.playSong(song);
            } catch {
                finish(null);
            }
        });
    };

    const downloadOne = async (song, options = {}) => {
        if (!song || !song.ref) return { ok: false, code: 'unsupported-song' };
        const url = options.url ?? (await waitForUrl(song));
        if (!url) return { ok: false, code: 'resolve-timeout' };
        if (!/^https?:\/\//i.test(url)) return { ok: false, code: 'unsupported-url' };
        let lyrics = '';
        if (options.withLyrics) {
            try {
                lyrics = buildLrc(song, folium.lyrics.getLines());
            } catch {
                lyrics = '';
            }
        }
        return await rpc('download', { url, song: describeSong(song), lyrics });
    };

    const tabsHandle = folium.registries.homeTabs.register({
        id: 'downloads',
        label: { 'zh-CN': '下载', en: 'Downloads' },
        order: 600,
        mount(container) {
            const style = document.createElement('style');
            style.textContent = CSS;
            const root = document.createElement('div');
            root.className = 'md-root';
            container.append(style, root);

            const head = document.createElement('div');
            head.className = 'md-head';
            const h1 = document.createElement('h1');
            h1.textContent = '音乐下载';
            const note = document.createElement('p');
            note.textContent =
                '直接用 Folia 已经适配好的各平台音源解析音频地址再下载，不需要等缓存：音质就是 Folia 当前播放音质，想要高品质先在 Folia 里把音质调到最高。';
            head.append(h1, note);
            root.append(head);

            const currentCard = document.createElement('div');
            currentCard.className = 'md-card md-current';
            const currentMeta = document.createElement('div');
            currentMeta.className = 'md-meta';
            const currentTitle = document.createElement('div');
            currentTitle.className = 'md-title';
            const currentSub = document.createElement('div');
            currentSub.className = 'md-sub';
            currentMeta.append(currentTitle, currentSub);
            const currentBtn = document.createElement('button');
            currentBtn.className = 'md-btn primary';
            currentBtn.textContent = '下载当前歌曲';
            currentCard.append(currentMeta, currentBtn);
            root.append(currentCard);

            const toolbar = document.createElement('div');
            toolbar.className = 'md-toolbar';
            const refreshBtn = document.createElement('button');
            refreshBtn.className = 'md-btn';
            refreshBtn.textContent = '刷新队列';
            const allBtn = document.createElement('button');
            allBtn.className = 'md-btn primary';
            allBtn.textContent = '下载整个队列';
            const stopBtn = document.createElement('button');
            stopBtn.className = 'md-btn';
            stopBtn.textContent = '停止';
            stopBtn.disabled = true;
            const spacer = document.createElement('span');
            spacer.className = 'md-spacer';
            toolbar.append(refreshBtn, allBtn, stopBtn, spacer);
            const status = document.createElement('div');
            status.className = 'md-status';
            status.textContent = '队列为空时先播放一个歌单或专辑。';
            root.append(toolbar, status);

            const list = document.createElement('div');
            list.className = 'md-list';
            root.append(list);

            let queueItems = [];
            let rows = [];
            let batch = null;
            let disposed = false;
            const setStatus = (text) => {
                status.textContent = text;
            };

            const updateCurrent = () => {
                let current = null;
                try {
                    current = folium.playback.getState().song;
                } catch {
                    current = null;
                }
                currentTitle.textContent = current ? `${current.title || '未命名'}${current.artist ? ` - ${current.artist}` : ''}` : '没有正在播放的歌曲';
                currentSub.textContent = current ? '解析当前音源地址并保存到系统音乐文件夹，同时写出歌词' : '';
                currentBtn.disabled = !current || Boolean(batch);
                return current;
            };

            const markRow = (index, text, kind = '') => {
                const row = rows[index];
                if (!row) return;
                row.badge.textContent = text;
                row.badge.className = `md-badge${kind ? ` ${kind}` : ''}`;
            };

            const render = () => {
                if (disposed) return;
                updateCurrent();
                try {
                    queueItems = folium.playback.getQueue({ limit: 500 })?.items ?? [];
                } catch {
                    queueItems = [];
                }
                list.replaceChildren();
                rows = [];
                if (queueItems.length === 0) {
                    const empty = document.createElement('div');
                    empty.className = 'md-empty';
                    empty.textContent = '当前播放队列是空的。去首页播放一个歌单或专辑，队列里的歌就会出现在这里。';
                    list.append(empty);
                    setStatus('队列为空。');
                    return;
                }
                setStatus(`队列共 ${queueItems.length} 首。批量下载会静音快速解析每首的地址。`);
                queueItems.forEach((item, index) => {
                    const row = document.createElement('div');
                    row.className = 'md-row';
                    const idx = document.createElement('div');
                    idx.className = 'md-idx';
                    idx.textContent = String(index + 1);
                    const meta = document.createElement('div');
                    meta.className = 'md-meta';
                    const title = document.createElement('div');
                    title.className = 'md-title';
                    title.textContent = `${item.song?.title || '未命名'}${item.song?.artist ? ` - ${item.song.artist}` : ''}`;
                    const sub = document.createElement('div');
                    sub.className = 'md-sub';
                    sub.textContent = item.song?.album || '';
                    meta.append(title, sub);
                    const badge = document.createElement('span');
                    badge.className = 'md-badge';
                    badge.textContent = '待下载';
                    const btn = document.createElement('button');
                    btn.className = 'md-btn';
                    btn.textContent = '下载';
                    btn.addEventListener('click', async () => {
                        if (batch) return;
                        btn.disabled = true;
                        badge.textContent = '解析中…';
                        badge.className = 'md-badge wait';
                        try {
                            const result = await downloadOne(item.song);
                            if (result?.ok) {
                                badge.textContent = '已下载';
                                badge.className = 'md-badge ok';
                                toast(`已保存：${result.filePath}`, 'success');
                            } else {
                                badge.textContent = result?.code === 'resolve-timeout' ? '解析超时' : '失败';
                                toast(`下载失败：${result?.code ?? 'unknown'}`, 'error');
                            }
                        } finally {
                            btn.disabled = false;
                        }
                    });
                    row.append(idx, meta, badge, btn);
                    list.append(row);
                    rows.push({ badge, button: btn });
                });
            };

            const downloadQueue = async () => {
                if (batch) return;
                const token = ++activeToken;
                batch = { token };
                refreshBtn.disabled = true;
                allBtn.disabled = true;
                stopBtn.disabled = false;
                const original = (() => {
                    try {
                        return folium.playback.getState();
                    } catch {
                        return null;
                    }
                })();
                const volume = (() => {
                    try {
                        return folium.playback.getVolume();
                    } catch {
                        return null;
                    }
                })();
                let started = 0;
                let failed = 0;
                const downloads = [];
                try {
                    try {
                        folium.playback.setMuted(true);
                    } catch {
                        /* ignore */
                    }
                    setStatus('批量解析中：会静音快速切歌，解析完再统一下载。');
                    for (let index = 0; index < queueItems.length; index += 1) {
                        if (disposed || batch?.token !== token) break;
                        const item = queueItems[index];
                        markRow(index, '解析中…', 'wait');
                        const url = await waitForUrl(item.song);
                        if (disposed || batch?.token !== token) break;
                        if (!url || !/^https?:\/\//i.test(url)) {
                            failed += 1;
                            markRow(index, '解析失败');
                            continue;
                        }
                        markRow(index, '下载中…', 'wait');
                        started += 1;
                        downloads.push(
                            rpc('download', { url, song: describeSong(item.song) }).then((result) => {
                                if (result?.ok) {
                                    markRow(index, '已下载', 'ok');
                                } else {
                                    failed += 1;
                                    markRow(index, '下载失败');
                                }
                                return result;
                            }),
                        );
                        setStatus(`已提交 ${started}/${queueItems.length} 首，失败 ${failed} 首`);
                    }
                } finally {
                    if (original?.song?.ref) {
                        try {
                            folium.playback.playSong(original.song);
                            folium.playback.seek(original.position ?? 0);
                        } catch {
                            /* ignore */
                        }
                    }
                    if (volume) {
                        try {
                            folium.playback.setMuted(volume.muted);
                        } catch {
                            /* ignore */
                        }
                    }
                }
                const results = await Promise.allSettled(downloads);
                const ok = results.filter((entry) => entry.status === 'fulfilled' && entry.value?.ok).length;
                failed = results.length - ok + (started - results.length);
                batch = null;
                refreshBtn.disabled = false;
                allBtn.disabled = false;
                stopBtn.disabled = true;
                setStatus(`完成 · 成功 ${ok} 首，失败 ${Math.max(0, failed)} 首`);
                toast(`下载完成：成功 ${ok} 首`, 'success');
            };

            currentBtn.addEventListener('click', async () => {
                if (batch) return;
                let current = null;
                let position = 0;
                try {
                    const state = folium.playback.getState();
                    current = state.song;
                    position = state.position;
                } catch {
                    current = null;
                }
                if (!current) return;
                currentBtn.disabled = true;
                try {
                    const url = await waitForUrl(current);
                    if (!url) {
                        toast('解析音频地址超时', 'error');
                        return;
                    }
                    const result = await downloadOne(current, { url, withLyrics: true });
                    if (result?.ok) toast(`已保存：${result.filePath}`, 'success');
                    else toast(`下载失败：${result?.code ?? 'unknown'}`, 'error');
                    try {
                        folium.playback.seek(position);
                    } catch {
                        /* ignore */
                    }
                } finally {
                    currentBtn.disabled = Boolean(batch);
                }
            });

            refreshBtn.addEventListener('click', () => {
                if (!batch) render();
            });
            allBtn.addEventListener('click', () => {
                void downloadQueue();
            });
            stopBtn.addEventListener('click', () => {
                if (!batch) return;
                activeToken += 1;
                batch.token = -1;
                batch = null;
                stopBtn.disabled = true;
                refreshBtn.disabled = false;
                allBtn.disabled = false;
                setStatus('已停止');
            });

            render();
            const offSong = folium.events.on('playback.songChanged', () => {
                if (!batch) updateCurrent();
            });
            const offQueue = folium.events.on('playback.queueChanged', () => {
                if (!batch) render();
            });
            return () => {
                disposed = true;
                activeToken += 1;
                batch = null;
                offSong();
                offQueue();
                style.remove();
                root.remove();
            };
        },
    });

    let commandHandle = null;
    try {
        commandHandle = folium.registries.commands.register({
            id: 'open-downloads',
            label: { 'zh-CN': '打开下载页', en: 'Open Downloads' },
            description: { 'zh-CN': '打开下载页：解析当前音源并下载当前歌曲或整个队列。', en: 'Open the download page.' },
            keywords: ['download', '下载', '导出'],
            run() {
                folium.ui.openHomeTab('downloads');
                return '已打开下载页';
            },
        });
    } catch {
        /* commands registry is stable */
    }

    return () => {
        offHook?.();
        tabsHandle.unregister();
        commandHandle?.unregister();
    };
}
