// music-downloader / index.cjs
// Node half: download a resolved audio URL into the user's Music folder.
// Folia resolves the URL for each platform (its Omni providers); this entry
// only streams the bytes to disk, so no per-platform API code lives here.

'use strict';

const fs = require('fs');
const path = require('path');
const { app, net } = require('electron');

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

const BROWSER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const sanitizeFileName = (value) => {
    const cleaned = String(value ?? '')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[. ]+$/g, '');
    return cleaned.slice(0, 120) || '未命名';
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

const contentTypeToExtension = (contentType) => {
    const mime = String(contentType ?? '').split(';')[0].trim().toLowerCase();
    return MIME_EXTENSIONS[mime] ?? null;
};

module.exports = function activate(api) {
    api.rpc.handle('download', async (payload) => {
        const url = payload?.url;
        const song = payload?.song ?? {};
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
            return { ok: false, code: 'invalid-url' };
        }
        const musicDirectory = app.getPath('music');
        const displayName = sanitizeFileName(`${song.title ?? '未命名'} - ${song.artist ?? '未知歌手'}`);
        const tempPath = path.join(app.getPath('temp'), `folia-dl-${Date.now()}-${Math.random().toString(36).slice(2)}.part`);

        return await new Promise((resolve) => {
            let settled = false;
            let writeStream = null;
            let finalPath = null;
            let total = 0;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                try {
                    writeStream?.destroy();
                } catch {
                    /* ignore */
                }
                try {
                    fs.rmSync(tempPath, { force: true });
                } catch {
                    /* ignore */
                }
                resolve(result);
            };

            const request = net.request({ url, method: 'GET', redirect: 'follow' });
            request.setHeader('User-Agent', BROWSER_UA);
            request.setHeader('Accept', '*/*');

            request.on('response', (response) => {
                if (response.statusCode >= 400) {
                    finish({ ok: false, code: `http-${response.statusCode}` });
                    response.on('data', () => {});
                    return;
                }
                let extension = contentTypeToExtension(response.headers['content-type']?.[0]) ?? null;
                if (!extension) extension = 'm4a';
                finalPath = uniqueTarget(musicDirectory, displayName, extension);
                writeStream = fs.createWriteStream(tempPath);
                writeStream.on('error', (error) => finish({ ok: false, code: 'write-failed', detail: error?.message }));
                response.on('data', (chunk) => {
                    total += chunk.length;
                    if (total > 500 * 1024 * 1024) {
                        finish({ ok: false, code: 'too-large' });
                        request.abort();
                        return;
                    }
                    writeStream.write(chunk);
                });
                response.on('end', () => {
                    writeStream.end(() => {
                        try {
                            fs.renameSync(tempPath, finalPath);
                        } catch (error) {
                            finish({ ok: false, code: 'write-failed', detail: error?.message });
                            return;
                        }
                        let lyricsPath = null;
                        const lyrics = typeof payload?.lyrics === 'string' ? payload.lyrics : '';
                        if (lyrics.trim() && finalPath) {
                            try {
                                lyricsPath = finalPath.replace(/\.[^.]+$/, '.lrc');
                                fs.writeFileSync(lyricsPath, lyrics, 'utf8');
                            } catch {
                                lyricsPath = null;
                            }
                        }
                        api.log.info(`downloaded ${song.title ?? ''} -> ${finalPath}`);
                        finish({ ok: true, filePath: finalPath, lyricsPath, extension, size: total });
                    });
                });
                response.on('error', (error) => finish({ ok: false, code: 'network', detail: error?.message }));
            });
            request.on('error', (error) => finish({ ok: false, code: 'network', detail: error?.message }));
            request.end();
        });
    });
};
