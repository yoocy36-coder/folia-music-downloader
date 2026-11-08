// music-downloader / client.mjs
// Renderer half: the download button next to the progress bar, plus a command.
// It only asks the main entry to copy the audio file that Folia already cached;
// nothing here talks to an online source.

const BUTTON_CSS = `
.dl-btn {
    all: unset;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--folium-secondary, rgba(255, 255, 255, 0.72));
    cursor: pointer;
}
.dl-btn:hover { background: var(--folium-hover, rgba(255, 255, 255, 0.12)); color: var(--folium-primary, #fff); }
.dl-btn:active { transform: scale(0.92); }
.dl-btn.busy { opacity: 0.5; pointer-events: none; }
.dl-btn svg { width: 16px; height: 16px; display: block; }
`;

const pad = (value, length = 2) => String(value).padStart(length, '0');

const lyricTime = (seconds) => {
    const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    const minutes = Math.floor(safe / 60);
    const rest = safe - minutes * 60;
    return `[${pad(minutes)}:${rest.toFixed(2).padStart(5, '0')}]`;
};

const buildLrc = (song, lines) => {
    if (!Array.isArray(lines) || lines.length === 0) return '';
    const header = [
        `[ti:${song?.title ?? ''}]`,
        `[ar:${song?.artist ?? ''}]`,
        `[al:${song?.album ?? ''}]`,
        '[by:Folia 缓存下载器]',
        '',
    ];
    const body = [];
    for (const line of lines) {
        if (!line || typeof line.fullText !== 'string' || !line.fullText.trim()) continue;
        const time = lyricTime(Number(line.startTime));
        body.push(`${time}${line.fullText}`);
        if (typeof line.translation === 'string' && line.translation.trim()) {
            body.push(`${time}${line.translation}`);
        }
    }
    return [...header, ...body].join('\n');
};

const errorText = (code) => {
    switch (code) {
        case 'not-cached':
            return '这首还没缓存完，让它再播一会儿再点一次';
        case 'unsupported-song':
            return '当前歌曲没有可导出的缓存（本地歌曲不需要下载）';
        case 'write-failed':
            return '写入音乐文件夹失败，检查权限或磁盘空间';
        default:
            return `下载失败：${code}`;
    }
};

export default function activate(folium) {
    if (folium.env.context !== 'main') return undefined;

    const downloadCurrent = async () => {
        let state = null;
        try {
            state = folium.playback.getState();
        } catch {
            state = null;
        }
        const song = state?.song ?? null;
        if (!song) {
            folium.ui.toast('没有正在播放的歌曲', { type: 'info' });
            return { ok: false, code: 'unsupported-song' };
        }
        let lyrics = '';
        try {
            lyrics = buildLrc(song, folium.lyrics.getLines());
        } catch {
            lyrics = '';
        }
        let result = null;
        try {
            result = await folium.rpc.call('download', {
                song: {
                    source: song.source,
                    id: song.id,
                    title: song.title,
                    artist: song.artist,
                    album: song.album,
                },
                lyrics,
            });
        } catch (error) {
            folium.ui.toast(`下载失败：${error?.message ?? '未知错误'}`, { type: 'error' });
            return { ok: false, code: 'rpc-failed' };
        }
        if (result?.ok) {
            folium.ui.toast(`已保存到：${result.filePath}`, { type: 'success', durationMs: 8000 });
        } else {
            folium.ui.toast(errorText(result?.code), { type: 'error' });
        }
        return result;
    };

    const buttonHandle = folium.registries.progressButtons.register({
        id: 'download-current',
        slot: 'progress.trailing',
        order: 600,
        hideWhenCollapsed: true,
        mount(container) {
            const style = document.createElement('style');
            style.textContent = BUTTON_CSS;
            const button = document.createElement('button');
            button.className = 'dl-btn';
            button.type = 'button';
            button.title = '下载当前歌曲到音乐文件夹（读取本地缓存）';
            button.setAttribute('aria-label', '下载当前歌曲');
            container.append(style, button);

            folium.ui.icon('download', { size: 16 }).then((svg) => {
                if (svg) button.append(svg);
                else button.textContent = '↓';
            });

            button.addEventListener('click', async () => {
                if (button.classList.contains('busy')) return;
                button.classList.add('busy');
                try {
                    await downloadCurrent();
                } finally {
                    button.classList.remove('busy');
                }
            });

            return () => {
                style.remove();
                button.remove();
            };
        },
    });

    let commandHandle = null;
    try {
        commandHandle = folium.registries.commands.register({
            id: 'download-current',
            label: { 'zh-CN': '下载当前歌曲到音乐文件夹', en: 'Save the current song to Music' },
            description: {
                'zh-CN': '把 Folia 已经缓存的当前歌曲复制到音乐文件夹，并写出歌词文件。',
                en: 'Copy the current song from Folia’s local cache into the Music folder, with its lyrics.',
            },
            keywords: ['download', 'save', '下载', '缓存', '导出'],
            run() {
                return downloadCurrent();
            },
        });
    } catch {
        /* commands registry is stable; ignore an old host without it */
    }

    return () => {
        buttonHandle.unregister();
        commandHandle?.unregister();
    };
}
