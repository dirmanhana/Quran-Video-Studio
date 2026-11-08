import React, { useState } from 'react';
import * as Mp4Muxer from 'mp4-muxer';
import { VideoConfig } from '../types';
import { VerseData } from '../../quran/types';
import { CANVAS_SIZES, RECITERS } from '../../../shared/constants';
import { SURAHS } from '../../quran/data/surahs';
import { saveVideoFile } from '../../../shared/utils/tauri-fs';

export function useVideoExporter(
  config: VideoConfig,
  verses: VerseData[],
  audioUrl: string | null,
  canvasRef: React.RefObject<HTMLCanvasElement>,
  audioRef: React.RefObject<HTMLAudioElement>
) {
  const [isVideoExporting, setIsVideoExporting] = useState(false);
  const [videoExportProgress, setVideoExportProgress] = useState(0);
  const [exportStatus, setExportStatus] = useState("");

  const startVideoExport = async () => {
    if (!canvasRef.current || !audioRef.current || !audioUrl || verses.length === 0) return;

    setIsVideoExporting(true);
    setVideoExportProgress(0);
    setExportStatus("Initializing...");

    try {
        // 1. Calculate Timing
        const firstVerse = verses[0];
        const lastVerse = verses[verses.length - 1];

        if (!firstVerse.timing || !lastVerse.timing) {
            alert("Timing data missing, cannot export.");
            setIsVideoExporting(false);
            return;
        }

        const startMs = firstVerse.timing.timestamp_from;
        const endMs = lastVerse.timing.timestamp_to;
        const startTime = startMs / 1000;
        const endTime = (endMs / 1000) + 0.1;
        const duration = endTime - startTime;

        const fps = 30;
        const totalFrames = Math.ceil(duration * fps);
        const width = CANVAS_SIZES[config.aspectRatio].width;
        const height = CANVAS_SIZES[config.aspectRatio].height;

        // 2. Setup MP4 Muxer
        // Chrome on Linux lacks a proprietary AAC encoder, but always
        // supports Opus. Pick the first codec the browser supports.
        let audioMuxerCodec: 'aac' | 'opus' = 'aac';
        let audioEncoderCodec = 'mp4a.40.2'; // AAC LC

        if (typeof AudioEncoder === "undefined") {
            throw new Error("AudioEncoder is not supported in this browser. Please use Chrome or Edge.");
        }

        const isConfigSupportedFn = (AudioEncoder as any).isConfigSupported;
        const aacConfig = {
            codec: 'mp4a.40.2',
            numberOfChannels: 2,
            sampleRate: 44100,
            bitrate: 128_000
        };
        const opusConfig = {
            codec: 'opus',
            numberOfChannels: 2,
            sampleRate: 48000,
            bitrate: 128_000
        };

        if (typeof isConfigSupportedFn === 'function') {
            const aacSupport = await isConfigSupportedFn.call(AudioEncoder, aacConfig);
            if (aacSupport?.supported) {
                audioMuxerCodec = 'aac';
                audioEncoderCodec = 'mp4a.40.2';
            } else {
                const opusSupport = await isConfigSupportedFn.call(AudioEncoder, opusConfig);
                if (opusSupport?.supported) {
                    audioMuxerCodec = 'opus';
                    audioEncoderCodec = 'opus';
                } else {
                    throw new Error(
                        "Neither AAC nor Opus audio encoding is supported in this browser. " +
                        "Please use a recent Chrome or Edge."
                    );
                }
            }
        }

        const audioSampleRate = audioMuxerCodec === 'opus' ? 48000 : 44100;

        const muxer = new Mp4Muxer.Muxer({
            target: new Mp4Muxer.ArrayBufferTarget(),
            video: {
                codec: 'avc', // H.264
                width,
                height
            },
            audio: {
                codec: audioMuxerCodec,
                numberOfChannels: 2,
                sampleRate: audioSampleRate
            },
            fastStart: 'in-memory'
        });

        // 3. Setup Video Encoder
        let videoEncoderError: any = null;
        const videoEncoder = new VideoEncoder({
            output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
            error: (e) => {
                console.error("Video Encoder Error", e);
                if (!videoEncoderError) videoEncoderError = e;
            }
        });

        videoEncoder.configure({
            codec: 'avc1.4d002a', // H.264 Main Profile Level 4.2
            width,
            height,
            bitrate: 8_000_000, // 8 Mbps
            framerate: fps
        });

        if ((videoEncoder as any).state !== 'configured') {
            throw new Error("VideoEncoder failed to configure (state=" + (videoEncoder as any).state + "). See console 'Video Encoder Error' for details.");
        }

        // 4. Setup Audio Encoder
        const audioEncoderConfig = audioMuxerCodec === 'opus'
            ? {
                codec: 'opus',
                numberOfChannels: 2,
                sampleRate: 48000,
                bitrate: 128_000
            }
            : {
                codec: audioEncoderCodec,
                numberOfChannels: 2,
                sampleRate: audioSampleRate,
                bitrate: 128_000
            };

        let audioEncoderError: any = null;
        const audioEncoder = new AudioEncoder({
            output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
            error: (e) => {
                console.error("Audio Encoder Error", e);
                if (!audioEncoderError) audioEncoderError = e;
            }
        });

        audioEncoder.configure(audioEncoderConfig);

        if ((audioEncoder as any).state !== 'configured') {
            throw new Error(
                "AudioEncoder failed to configure (state=" + (audioEncoder as any).state + "). " +
                "See console 'Audio Encoder Error' for the real cause."
            );
        }

        // 5. Fetch and Decode Audio
        setExportStatus("Processing Audio...");
        const audioResp = await fetch(audioUrl);
        if (!audioResp.ok) {
            throw new Error(
                `Failed to download recitation audio (HTTP ${audioResp.status} ${audioResp.statusText}). ` +
                `Try a different reciter or check your connection.`
            );
        }
        const audioArrayBuffer = await audioResp.arrayBuffer();
        if (audioArrayBuffer.byteLength < 1024) {
            throw new Error(
                `Downloaded audio is too small (${audioArrayBuffer.byteLength} bytes) — ` +
                `the audio file may be unavailable for this reciter/surah.`
            );
        }
        // Sanity-check magic bytes (MP3: ID3 or frame sync FF Ex / OggS / fLaC / RIFF)
        const magic = new Uint8Array(audioArrayBuffer.slice(0, 4));
        const isKnownAudio =
            (magic[0] === 0x49 && magic[1] === 0x44 && magic[2] === 0x33) || // ID3
            (magic[0] === 0xFF && (magic[1] & 0xE0) === 0xE0) ||              // MP3 frame sync
            (magic[0] === 0x4F && magic[1] === 0x67 && magic[2] === 0x67 && magic[3] === 0x53) || // OggS
            (magic[0] === 0x66 && magic[1] === 0x4C && magic[2] === 0x61 && magic[3] === 0x43) || // fLaC
            (magic[0] === 0x52 && magic[1] === 0x49 && magic[2] === 0x46 && magic[3] === 0x46);   // RIFF/WAV
        if (!isKnownAudio) {
            const preview = new TextDecoder().decode(audioArrayBuffer.slice(0, 120));
            throw new Error(
                `Downloaded file is not audio (starts with: ${JSON.stringify(preview.slice(0, 80))}). ` +
                `The CDN may have returned an error page. Try again or pick another reciter.`
            );
        }

        let audioBuffer: AudioBuffer;
        let audioCtx: AudioContext | null = null;
        try {
            // Forced sampleRate can break decoding of some MP3s; try the
            // target rate first, then fall back to the default context.
            try {
                audioCtx = new AudioContext({ sampleRate: audioSampleRate });
                audioBuffer = await audioCtx.decodeAudioData(audioArrayBuffer.slice(0));
            } catch (firstErr) {
                console.warn("decodeAudioData with forced sampleRate failed, retrying with default:", firstErr);
                try { await audioCtx?.close(); } catch { /* ignore */ }
                audioCtx = new AudioContext();
                audioBuffer = await audioCtx.decodeAudioData(audioArrayBuffer.slice(0));
            }
        } catch (decodeErr: any) {
            throw new Error(
                `Unable to decode audio data (${decodeErr?.message || decodeErr}). ` +
                `This browser may lack an MP3 decoder — please use official Google Chrome or Edge. ` +
                `Audio URL: ${audioUrl}`
            );
        }

        // Slice Audio Buffer
        const startSample = Math.floor(startTime * audioSampleRate);
        const endSample = Math.floor(endTime * audioSampleRate);
        const length = endSample - startSample;
        if (length <= 0) {
            throw new Error("Invalid audio duration (" + length + " samples).");
        }
        const slicedBuffer = audioCtx.createBuffer(2, length, audioSampleRate);

        for (let channel = 0; channel < 2; channel++) {
            const channelData = audioBuffer.getChannelData(Math.min(channel, audioBuffer.numberOfChannels - 1));
            const slicedData = slicedBuffer.getChannelData(channel);
            for (let i = 0; i < length; i++) {
                slicedData[i] = channelData[startSample + i] || 0;
            }
        }

        // Interleave audio data for AudioData
        const left = slicedBuffer.getChannelData(0);
        const right = slicedBuffer.getChannelData(1);
        const interleaved = new Float32Array(length * 2);
        for (let i = 0; i < length; i++) {
            interleaved[i * 2] = left[i];
            interleaved[i * 2 + 1] = right[i];
        }

        // Encode audio in chunks with correct timestamps (one giant
        // encode/flush combo breaks AAC framing on some browsers).
        const CHUNK_FRAMES = 4096;
        for (let offset = 0; offset < length; offset += CHUNK_FRAMES) {
            const frames = Math.min(CHUNK_FRAMES, length - offset);
            const chunkData = new AudioData({
                format: 'f32',
                numberOfChannels: 2,
                numberOfFrames: frames,
                sampleRate: audioSampleRate,
                timestamp: Math.round((offset / audioSampleRate) * 1_000_000),
                data: interleaved.subarray(offset * 2, (offset + frames) * 2)
            });

            audioEncoder.encode(chunkData);
            chunkData.close();
        }
        await audioEncoder.flush();
        await audioEncoder.close();

        if (audioEncoderError) {
            throw new Error("Audio encoding failed: " + (audioEncoderError?.message || audioEncoderError));
        }

        // 6. Render Video Frames
        setExportStatus("Rendering Video Frames...");
        const canvas = canvasRef.current;
        const audio = audioRef.current;

        const originalTime = audio.currentTime;
        const originalVolume = audio.volume;
        audio.volume = 0;
        audio.pause();

        for (let i = 0; i < totalFrames; i++) {
            const t = startTime + (i / fps);
            const timestampMicro = (i / fps) * 1_000_000;

            // Update Canvas State
            audio.currentTime = t;

            // Wait for Paint
            await new Promise<void>(resolve => {
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => resolve());
                });
            });

            // Create VideoFrame from Canvas
            const frame = new VideoFrame(canvas, { timestamp: timestampMicro });

            // Encode
            videoEncoder.encode(frame, { keyFrame: i % 30 === 0 });
            frame.close();

            // Progress
            setVideoExportProgress(Math.round(((i + 1) / totalFrames) * 100));
        }

        setExportStatus("Finalizing...");
        await videoEncoder.flush();
        muxer.finalize();

        // 7. Save Video
        const { buffer } = muxer.target;
        const blob = new Blob([buffer], { type: 'video/mp4' });

        // Construct dynamic filename
        const surahNum = config.surahId.toString().padStart(3, '0');
        const rawSurahName = SURAHS.find(s => s.number === config.surahId)?.englishName || 'Surah';
        const surahName = rawSurahName
            .replace(/-/g, '_')
            .replace(/\s+/g, '_')
            .replace(/['`]/g, '');

        const rawReciterName = RECITERS.find(r => r.id === config.reciterId)?.name || 'Reciter';
        const reciterName = rawReciterName.split(' ').pop()?.replace(/[^\w]/g, '') || 'Reciter';

        const filename = `${surahNum}_${surahName}_${config.verseStart}-${config.verseEnd}_${reciterName}.mp4`;

        // Get default export path from localStorage if available
        const defaultExportPath = localStorage.getItem('exportPath') || undefined;
        const skipDialog = localStorage.getItem('skipDialog') === 'true';

        await saveVideoFile(blob, filename, { defaultDir: defaultExportPath, skipDialog });

        // Restore
        audio.currentTime = originalTime;
        audio.volume = originalVolume;

    } catch (error) {
        console.error("Export failed:", error);
        alert("Export failed: " + error);
    } finally {
        setIsVideoExporting(false);
    }
  };

  return { isVideoExporting, videoExportProgress, exportStatus, startVideoExport };
}
