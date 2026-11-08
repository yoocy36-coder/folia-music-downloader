// music-downloader / index.cjs
// Node half: copy the audio Folia already cached for a song into the user's
// Music folder. It never touches the network; everything comes from the local
// media cache.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MIME_EXTENSIONS = {
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/m4a': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/flac': 'flac',
    'audio/x-flac': 'flac',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/webm': 'webm',
    'audio/aac': 'aac',
};

const SNIFF_EXTENSIONS = [
    ['ftypM4A', 'm4a'],
    ['ftypisom', 'm4a'],
    ['ftypmp42', 'm4a'],
    ['fLaC', 'flac'],
    ['OggS', 'ogg'],
    ['RIFF', 'wav'],
    ['ID3', 'mp3'],
];

const sanitizeFileName = (value) => {
    const cleaned = String(value ?? '')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[. ]+$/g, '');
    return cleaned.slice(0, 120) || '未命名';
};

const cacheDirectory = () => {
    try {
        const configPath = path.join(app.getPath('userData'), 'config.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const configured = config?.CACHE_DIRECTORY;
        if (typeof configured === 'string' && configured.trim()) return configured.trim();
    } catch {
        /* default below */
    }
    return path.join(app.getPath('userData'), 'media-cache');
};

const cachePaths = (song) => {
    const cacheKey = `audio_online:${song.source}:${song.id}`;
    const baseName = crypto.createHash('sha256').update(cacheKey).digest('hex');
    const audioDirectory = path.join(cacheDirectory(), 'audio');
    return {
        cacheKey,
        dataPath: path.join(audioDirectory, `${baseName}.bin`),
        metaPath: path.join(audioDirectory, `${baseName}.json`),
    };
};

const sniffExtension = (filePath) => {
    try {
        const header = fs.readFileSync(filePath).subarray(0, 16);
        const text = header.toString('latin1');
        for (const [signature, extension] of SNIFF_EXTENSIONS) {
            if (text.includes(signature)) return extension;
        }
    } catch {
        /* unreadable */
    }
    return 'bin';
};

const describeCache = (song) => {
    if (!song || typeof song.source !== 'string' || typeof song.id !== 'string' || !song.source || !song.id) {
        return { cached: false, reason: 'unsupported', size: 0, mimeType: null, extension: null };
    }
    const { dataPath, metaPath } = cachePaths(song);
    let size = 0;
    try {
        size = fs.statSync(dataPath).size;
    } catch {
        return { cached: false, reason: 'missing', size: 0, mimeType: null, extension: null };
    }
    let mimeType = null;
    try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        mimeType = typeof meta?.mimeType === 'string' ? meta.mimeType : null;
    } catch {
        /* meta optional */
    }
    let extension = MIME_EXTENSIONS[String(mimeType ?? '').toLowerCase()] ?? null;
    if (!extension) extension = sniffExtension(dataPath);
    return { cached: true, reason: 'cached', size, mimeType, extension };
};

const uniqueTarget = (directory, baseName, extension) => {
    let candidate = path.join(directory, `${baseName}.${extension}`);
    let index = 2;
    while (fs.existsSync(candidate)) {
        candidate = path.join(directory, `${baseName} (${index}).${extension}`);
        index += 1;
    }
    return candidate;
};

module.exports = function activate(api) {
    api.rpc.handle('status', (songs) => {
        const list = Array.isArray(songs) ? songs.slice(0, 500) : [];
        return list.map((song) => ({
            ...describeCache(song),
            source: typeof song?.source === 'string' ? song.source : null,
            id: typeof song?.id === 'string' ? song.id : null,
        }));
    });

    api.rpc.handle('download', async (payload) => {
        const song = payload?.song ?? null;
        const info = describeCache(song);
        if (!info.cached) {
            return { ok: false, code: info.reason === 'unsupported' ? 'unsupported-song' : 'not-cached' };
        }
        const { dataPath } = cachePaths(song);
        const extension = info.extension ?? 'bin';
        const musicDirectory = app.getPath('music');
        const displayName = sanitizeFileName(`${song.title ?? '未命名'} - ${song.artist ?? '未知歌手'}`);
        const targetPath = uniqueTarget(musicDirectory, displayName, extension);
        try {
            fs.copyFileSync(dataPath, targetPath);
        } catch (error) {
            return { ok: false, code: 'write-failed', detail: error?.message ?? null };
        }

        let lyricsPath = null;
        const lyrics = typeof payload?.lyrics === 'string' ? payload.lyrics : '';
        if (lyrics.trim()) {
            try {
                lyricsPath = path.join(path.dirname(targetPath), `${path.basename(targetPath, `.${extension}`)}.lrc`);
                fs.writeFileSync(lyricsPath, lyrics, 'utf8');
            } catch {
                lyricsPath = null;
            }
        }
        let size = info.size;
        try {
            size = fs.statSync(targetPath).size;
        } catch {
            /* keep the cached size */
        }
        api.log.info(`saved ${song.title ?? ''} to ${targetPath}`);
        return { ok: true, filePath: targetPath, lyricsPath, extension, size };
    });
};
