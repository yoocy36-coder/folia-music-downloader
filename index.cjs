// music-downloader / index.cjs
// Node half: stream a resolved audio URL into the user's Music folder.
// Folia's own source adapters resolve the URL; this entry only writes bytes,
// so there is no per-platform API code here.

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

const REFERERS = {
    netease: 'https://music.163.com/',
    qq: 'https://y.qq.com/',
    kugou: 'https://www.kugou.com/',
    qishui: 'https://music.douyin.com/',
    ytm: 'https://music.youtube.com/',
    spotify: 'https://open.spotify.com/',
};

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

const attemptDownload = ({ url, referer, targetPath, tempPath, timeoutMs = 120000 }) =>
    new Promise((resolve) => {
        let settled = false;
        let writeStream = null;
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
        if (referer) request.setHeader('Referer', referer);
        const timer = setTimeout(() => {
            try {
                request.abort();
            } catch {
                /* ignore */
            }
            finish({ ok: false, code: 'timeout' });
        }, timeoutMs);
        const done = (result) => {
            clearTimeout(timer);
            finish(result);
        };
        request.on('response', (response) => {
            if (response.statusCode >= 400) {
                response.on('data', () => {});
                done({ ok: false, code: `http-${response.statusCode}` });
                return;
            }
            let extension = contentTypeToExtension(response.headers['content-type']?.[0]) ?? null;
            if (!extension) extension = 'm4a';
            const finalPath = targetPath(extension);
            writeStream = fs.createWriteStream(tempPath);
            writeStream.on('error', (error) => done({ ok: false, code: 'write-failed', detail: error?.message }));
            response.on('data', (chunk) => {
                total += chunk.length;
                if (total > 600 * 1024 * 1024) {
                    try {
                        request.abort();
                    } catch {
                        /* ignore */
                    }
                    done({ ok: false, code: 'too-large' });
                    return;
                }
                writeStream.write(chunk);
            });
            response.on('end', () => {
                writeStream.end(() => {
                    try {
                        fs.renameSync(tempPath, finalPath);
                    } catch (error) {
                        done({ ok: false, code: 'write-failed', detail: error?.message });
                        return;
                    }
                    done({ ok: true, filePath: finalPath, extension, size: total });
                });
            });
            response.on('error', (error) => done({ ok: false, code: 'network', detail: error?.message }));
        });
        request.on('error', (error) => done({ ok: false, code: 'network', detail: error?.message }));
        request.end();
    });

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
        const targetPath = (extension) => uniqueTarget(musicDirectory, displayName, extension);
        const referer = REFERERS[song.source] ?? null;

        // Some CDNs reject a foreign Referer and some require it; try with it
        // first, then without.
        let result = await attemptDownload({ url, referer, targetPath, tempPath });
        if (!result.ok && referer && /^http-(403|404|412)$/.test(result.code)) {
            result = await attemptDownload({ url, referer: null, targetPath, tempPath });
        }
        if (!result.ok) return result;

        const finalPath = result.filePath;
        let lyricsPath = null;
        const lyrics = typeof payload?.lyrics === 'string' ? payload.lyrics : '';
        if (lyrics.trim()) {
            try {
                lyricsPath = finalPath.replace(/\.[^.]+$/, '.lrc');
                fs.writeFileSync(lyricsPath, lyrics, 'utf8');
            } catch {
                lyricsPath = null;
            }
        }
        api.log.info(`downloaded ${song.title ?? ''} -> ${finalPath}`);
        return {
            ok: true,
            filePath: finalPath,
            lyricsPath,
            extension: result.extension,
            size: result.size,
            quality: typeof payload?.quality === 'string' ? payload.quality : null,
        };
    });
};
