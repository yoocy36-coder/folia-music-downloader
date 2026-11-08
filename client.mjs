// music-downloader / client.mjs
// Adds a "下载 / Downloads" page to Folia's home navigation. Everything is
// driven by Folia's own media cache; nothing here talks to an online source.
// The batch action can walk the current queue, let Folia cache each track
// (muted, quickly), then export it.

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
            /* toasts are optional */
        }
    };

    const rpc = (name, payload) => folium.rpc.call(name, payload);

    let activeToken = 0;

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
            h1.textContent = '缓存下载器';
            const note = document.createElement('p');
            note.textContent = '只读取 Folia 已经缓存的音频文件，不联网、不调用音源接口。音质取决于 Folia 当前播放音质，想下载高品质请在 Folia 里把音质调到最高。';
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
            const cachedBtn = document.createElement('button');
            cachedBtn.className = 'md-btn';
            cachedBtn.textContent = '导出已缓存';
            const allBtn = document.createElement('button');
            allBtn.className = 'md-btn primary';
            allBtn.textContent = '缓存并导出全部';
            const stopBtn = document.createElement('button');
            stopBtn.className = 'md-btn';
            stopBtn.textContent = '停止';
            stopBtn.disabled = true;
            const spacer = document.createElement('span');
            spacer.className = 'md-spacer';
            toolbar.append(refreshBtn, cachedBtn, allBtn, stopBtn, spacer);
            const status = document.createElement('div');
            status.className = 'md-status';
            status.textContent = '队列为空时先播放一个歌单或队列。';
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

            const songLabel = (song) => `${song.title || '未命名'}${song.artist ? ` - ${song.artist}` : ''}`;

            const updateCurrent = () => {
                let current = null;
                try {
                    current = folium.playback.getState().song;
                } catch {
                    current = null;
                }
                currentTitle.textContent = current ? songLabel(current) : '没有正在播放的歌曲';
                currentSub.textContent = current ? '点击右侧按钮，把它从 Folia 的本地缓存复制到系统音乐文件夹' : '';
                currentBtn.disabled = !current;
                return current;
            };

            const markRow = (index, text, kind = '') => {
                const row = rows[index];
                if (!row) return;
                row.badge.textContent = text;
                row.badge.className = `md-badge${kind ? ` ${kind}` : ''}`;
                row.downloadBtn.disabled = kind === 'wait';
            };

            const waitCached = async (song, timeoutMs) => {
                const deadline = Date.now() + timeoutMs;
                while (!disposed && Date.now() < deadline) {
                    try {
                        const info = (await rpc('status', [song]))[0];
                        if (info?.cached) return info;
                    } catch {
                        /* retry */
                    }
                    await new Promise((resolve) => setTimeout(resolve, 700));
                }
                return { cached: false };
            };

            const render = async () => {
                if (disposed) return;
                updateCurrent();
                try {
                    const snapshot = folium.playback.getQueue({ limit: 500 });
                    queueItems = Array.isArray(snapshot?.items) ? snapshot.items : [];
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
                setStatus(`队列共 ${queueItems.length} 首。`);
                const songs = queueItems.map((item) => describeSong(item.song));
                let statuses = [];
                try {
                    statuses = await rpc('status', songs);
                } catch {
                    statuses = [];
                }
                if (disposed) return;
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
                    title.textContent = songLabel(item.song);
                    const sub = document.createElement('div');
                    sub.className = 'md-sub';
                    sub.textContent = item.song?.album || '';
                    meta.append(title, sub);
                    const cached = Boolean(statuses[index]?.cached);
                    const badge = document.createElement('span');
                    badge.className = `md-badge${cached ? ' ok' : ''}`;
                    badge.textContent = cached ? (statuses[index]?.extension ?? '已缓存') : '未缓存';
                    const btn = document.createElement('button');
                    btn.className = 'md-btn';
                    btn.textContent = cached ? '导出' : '缓存后导出';
                    btn.addEventListener('click', async () => {
                        if (batch) return;
                        const song = describeSong(item.song);
                        btn.disabled = true;
                        badge.textContent = '检查中…';
                        try {
                            let info = (await rpc('status', [song]))[0];
                            if (!info?.cached) {
                                badge.textContent = '缓存中…';
                                try {
                                    await folium.playback.playQueueItem(item.index);
                                } catch {
                                    /* ignore */
                                }
                                info = await waitCached(song, 20000);
                            }
                            if (!info?.cached) {
                                badge.textContent = '未缓存';
                                toast('这首还没缓存，先播放一会儿', 'error');
                                return;
                            }
                            const result = await rpc('download', { song });
                            if (result?.ok) {
                                badge.textContent = '已导出';
                                badge.className = 'md-badge ok';
                                toast(`已保存：${result.filePath}`, 'success');
                            } else {
                                badge.textContent = '导出失败';
                                toast('导出失败，检查音乐文件夹权限', 'error');
                            }
                        } finally {
                            btn.disabled = false;
                        }
                    });
                    row.append(idx, meta, badge, btn);
                    list.append(row);
                    rows.push({ badge, downloadBtn: btn });
                });
            };

            const beginBatch = async (mode) => {
                if (batch) return;
                const token = ++activeToken;
                batch = { token };
                stopBtn.disabled = false;
                cachedBtn.disabled = true;
                allBtn.disabled = true;
                refreshBtn.disabled = true;
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
                let saved = 0;
                let mutedByUs = false;
                try {
                    if (mode === 'all') {
                        folium.playback.setMuted(true);
                        mutedByUs = true;
                        setStatus('批量缓存中：会静音并把队列快速过一遍，期间请勿关闭 Folia。');
                    } else {
                        setStatus('正在导出已缓存的歌曲…');
                    }
                    for (let index = 0; index < queueItems.length; index += 1) {
                        if (disposed || batch?.token !== token) break;
                        const item = queueItems[index];
                        const song = describeSong(item.song);
                        markRow(index, mode === 'all' ? '缓存中…' : '检查中…', 'wait');
                        let info = (await rpc('status', [song]))[0];
                        if (!info?.cached && mode === 'all') {
                            try {
                                await folium.playback.playQueueItem(item.index);
                            } catch {
                                /* try next */
                            }
                            info = await waitCached(song, 25000);
                        }
                        if (disposed || batch?.token !== token) break;
                        if (info?.cached) {
                            const result = await rpc('download', { song });
                            if (result?.ok) {
                                saved += 1;
                                markRow(index, '已导出', 'ok');
                            } else {
                                markRow(index, '导出失败');
                            }
                        } else {
                            markRow(index, '跳过（未缓存）');
                        }
                        setStatus(`${index + 1}/${queueItems.length} · 已导出 ${saved} 首`);
                    }
                } finally {
                    if (mutedByUs && volume) {
                        try {
                            folium.playback.setMuted(volume.muted);
                        } catch {
                            /* ignore */
                        }
                    }
                    if (original?.song?.ref) {
                        try {
                            folium.playback.playSong(original.song);
                            folium.playback.seek(original.position ?? 0);
                        } catch {
                            /* ignore */
                        }
                    }
                    batch = null;
                    stopBtn.disabled = true;
                    cachedBtn.disabled = false;
                    allBtn.disabled = false;
                    refreshBtn.disabled = false;
                    setStatus(`完成 · 本次导出 ${saved} 首到音乐文件夹`);
                    toast(`导出完成：${saved} 首`, 'success');
                }
            };

            currentBtn.addEventListener('click', async () => {
                if (batch) return;
                let current = null;
                try {
                    current = folium.playback.getState().song;
                } catch {
                    current = null;
                }
                if (!current) return;
                currentBtn.disabled = true;
                try {
                    const song = describeSong(current);
                    const info = (await rpc('status', [song]))[0];
                    if (!info?.cached) {
                        toast('这首还没缓存完，让它再播一会儿再点', 'error');
                        return;
                    }
                    let lyrics = '';
                    try {
                        lyrics = buildLrc(current, folium.lyrics.getLines());
                    } catch {
                        lyrics = '';
                    }
                    const result = await rpc('download', { song, lyrics });
                    if (result?.ok) toast(`已保存：${result.filePath}`, 'success');
                    else toast('导出失败，检查音乐文件夹权限', 'error');
                } finally {
                    currentBtn.disabled = false;
                }
            });

            refreshBtn.addEventListener('click', () => {
                if (!batch) void render();
            });
            cachedBtn.addEventListener('click', () => {
                if (!batch) void beginBatch('cached');
            });
            allBtn.addEventListener('click', () => {
                if (!batch) void beginBatch('all');
            });
            stopBtn.addEventListener('click', () => {
                if (!batch) return;
                activeToken += 1;
                batch.token = -1;
                batch = null;
                stopBtn.disabled = true;
                cachedBtn.disabled = false;
                allBtn.disabled = false;
                refreshBtn.disabled = false;
                setStatus('已停止（会恢复原来的播放歌曲）');
            });

            void render();

            const offSong = folium.events.on('playback.songChanged', () => {
                if (!batch) updateCurrent();
            });
            const offQueue = folium.events.on('playback.queueChanged', () => {
                if (!batch) void render();
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
            description: {
                'zh-CN': '打开缓存下载器页面：导出当前歌曲或当前队列已缓存的音频。',
                en: 'Open the cache downloader page.',
            },
            keywords: ['download', 'downloads', '下载', '缓存', '导出'],
            run() {
                folium.ui.openHomeTab('downloads');
                return '已打开下载页';
            },
        });
    } catch {
        /* commands registry is stable */
    }

    return () => {
        tabsHandle.unregister();
        commandHandle?.unregister();
    };
}
