// music-downloader / client.mjs
// A "下载" page in Folia's home navigation. Folia's Omni providers already know
// how to resolve an audio URL for every source it supports; this mod calls that
// internal resolver (folium.internals.omni.getAudioSource) and streams the
// result to the Music folder from the main entry. No per-platform API code and
// no playback switching.

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
.md-badge.bad { background: rgba(255, 100, 100, .18); opacity: .95; }
.md-empty { padding: 28px 16px; text-align: center; font-size: 12.5px; opacity: .55; }
`;

const QUALITY_ORDER = ['hires', 'lossless', 'high', 'standard'];
const QUALITY_LABEL = { hires: '母带', lossless: '无损', high: '高品', standard: '标准' };

const fmtTime = (seconds) => {
    const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    const m = Math.floor(safe / 60);
    const s = safe - m * 60;
    return `[${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}]`;
};

const buildLrc = (song, lines) => {
    if (!Array.isArray(lines) || lines.length === 0) return '';
    const head = [`[ti:${song?.title ?? ''}]`, `[ar:${song?.artist ?? ''}]`, `[al:${song?.album ?? ''}]`, '[by:Folia 音乐下载]', ''];
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
            folium.ui.toast(message, { type, durationMs: type === 'success' ? 6000 : 5000 });
        } catch {
            /* optional */
        }
    };
    const rpc = (name, payload) => folium.rpc.call(name, payload);

    const providerSong = (song) => ({
        ...song,
        sourceRef: { kind: 'online', providerId: song.source, mediaId: song.id },
    });

    // Ask Folia's own backend for the audio URL. Try the best quality first and
    // fall back level by level; preview clips are rejected.
    const resolveAudio = async (song) => {
        const omni = folium.internals?.omni;
        if (!omni || typeof omni.getAudioSource !== 'function') throw new Error('internals-unavailable');
        let levels = [];
        try {
            levels = (await omni.getAudioQualityLevels(song.source)) ?? [];
        } catch {
            levels = [];
        }
        const order = QUALITY_ORDER.filter((quality) => levels.length === 0 || levels.includes(quality));
        if (order.length === 0) order.push(...QUALITY_ORDER);
        let lastError = null;
        for (const quality of order) {
            try {
                const result = await omni.getAudioSource(providerSong(song), quality);
                if (result?.url && /^https?:\/\//i.test(result.url) && !result.preview) {
                    return { url: result.url, quality: result.quality || quality, preview: false };
                }
                if (result?.preview) lastError = new Error('preview-only');
            } catch (error) {
                lastError = error;
            }
        }
        try {
            const result = await omni.getAudioSource(providerSong(song));
            if (result?.url && /^https?:\/\//i.test(result.url) && !result.preview) {
                return { url: result.url, quality: result.quality || 'standard', preview: false };
            }
            if (result?.preview) lastError = new Error('preview-only');
        } catch (error) {
            lastError = error;
        }
        throw lastError ?? new Error('no-url');
    };

    const downloadSong = async (song, options = {}) => {
        const audio = await resolveAudio(song);
        let lyrics = '';
        if (options.withLyrics) {
            try {
                lyrics = buildLrc(song, folium.lyrics.getLines());
            } catch {
                lyrics = '';
            }
        }
        return await rpc('download', {
            url: audio.url,
            quality: audio.quality,
            song: describeSong(song),
            lyrics,
        });
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
                '直接调用 Folia 已适配好的各平台音源解析音频地址并下载，不打断播放、不用等缓存。会自动从最高可用音质往下试；实际能拿到多高取决于你的账号权益和 Folia 的音质设置。';
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

            const describeQuality = (quality) => QUALITY_LABEL[quality] ?? quality;

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
                setStatus(`队列共 ${queueItems.length} 首。`);
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
                    sub.textContent = `${item.song?.source ?? ''}${item.song?.album ? ` · ${item.song.album}` : ''}`;
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
                            const result = await downloadSong(item.song);
                            if (result?.ok) {
                                badge.textContent = `已下载${result.quality ? ` · ${describeQuality(result.quality)}` : ''}`;
                                badge.className = 'md-badge ok';
                                toast(`已保存：${result.filePath}`, 'success');
                            } else {
                                badge.textContent = `失败：${result?.code ?? 'unknown'}`;
                                badge.className = 'md-badge bad';
                            }
                        } catch (error) {
                            badge.textContent = `失败：${String(error?.message ?? error).slice(0, 24)}`;
                            badge.className = 'md-badge bad';
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
                const items = [...queueItems];
                let cursor = 0;
                let ok = 0;
                let failed = 0;
                let done = 0;
                const total = items.length;
                const cancelled = () => disposed || batch?.token !== token;
                const worker = async () => {
                    while (!cancelled()) {
                        const index = cursor;
                        cursor += 1;
                        if (index >= total) return;
                        const item = items[index];
                        markRow(index, '解析中…', 'wait');
                        try {
                            const result = await downloadSong(item.song);
                            if (result?.ok) {
                                ok += 1;
                                markRow(index, `已下载${result.quality ? ` · ${describeQuality(result.quality)}` : ''}`, 'ok');
                            } else {
                                failed += 1;
                                markRow(index, `失败：${result?.code ?? 'unknown'}`, 'bad');
                            }
                        } catch (error) {
                            failed += 1;
                            const message = String(error?.message ?? error);
                            markRow(index, message.includes('preview') ? '仅试听' : '解析失败', 'bad');
                        }
                        done += 1;
                        setStatus(`${done}/${total} · 成功 ${ok} · 失败 ${failed}`);
                    }
                };
                await Promise.all([worker(), worker(), worker()]);
                batch = null;
                refreshBtn.disabled = false;
                allBtn.disabled = false;
                stopBtn.disabled = true;
                setStatus(`完成 · 成功 ${ok} 首，失败 ${failed} 首`);
                toast(`下载完成：成功 ${ok} 首`, 'success');
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
                    const result = await downloadSong(current, { withLyrics: true });
                    if (result?.ok) toast(`已保存：${result.filePath}`, 'success');
                    else toast(`下载失败：${result?.code ?? 'unknown'}`, 'error');
                } catch (error) {
                    toast(`下载失败：${String(error?.message ?? error)}`, 'error');
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
        /* stable registry */
    }

    return () => {
        tabsHandle.unregister();
        commandHandle?.unregister();
    };
}
