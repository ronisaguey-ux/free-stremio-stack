import { Router } from 'express';
import { AIOStreams, config as appConfig, createLogger, StremioTransformer, } from '@aiostreams/core';
import { trackResource } from '../../middlewares/analytics.js';

// LOCAL PATCH (helpotron/rs-systems, 2026-11-21): a Fire TV cannot decode AV1,
// HEVC or VP9. AIOStreams happily ranked an AV1 1080p first and the panel sat on
// a black screen with sound, over and over. Nothing in this box can change the
// TV's decoder, and the owner should never have to pick a stream by hand, so the
// list this addon hands out is narrowed and ordered here: only codecs the panel
// plays survive, and among those the swarm decides.
const UNPLAYABLE = /\b(av1|hevc|h\.?265|x265|vp9|vp09)\b/i;
const PLAYABLE = /\b(x264|h\.?264|avc)\b/i;

function streamText(stream) {
    const hints = stream && stream.behaviorHints ? stream.behaviorHints : {};
    return [stream && stream.name, stream && stream.title, stream && stream.description, hints.filename, hints.bingeGroup]
        .filter(Boolean)
        .join(' ');
}

function seedersOf(stream) {
    const match = /(?:👥|👤|seeders?[:\s]+)\s*(\d+)/i.exec(streamText(stream));
    return match ? Number(match[1]) : 0;
}

function resolutionOf(stream) {
    const text = streamText(stream);
    if (/\b(2160p|4k)\b/i.test(text)) return 2160;
    if (/\b1080p\b/i.test(text)) return 1080;
    if (/\b720p\b/i.test(text)) return 720;
    if (/\b(480p|360p)\b/i.test(text)) return 480;
    return 0;
}

function playablePayload(payload) {
    if (!payload || !Array.isArray(payload.streams)) return payload;
    const kept = payload.streams.filter((stream) => {
        const text = streamText(stream);
        // A name that says H.264 wins even if it also mentions 10bit/HEVC remux
        // notes; only an unambiguously unplayable label is dropped.
        if (PLAYABLE.test(text)) return true;
        return !UNPLAYABLE.test(text);
    });
    kept.sort((left, right) => {
        const seeders = seedersOf(right) - seedersOf(left);
        if (seeders !== 0) return seeders;
        return resolutionOf(right) - resolutionOf(left);
    });
    return { ...payload, streams: kept };
}

const router = Router();
const logger = createLogger('server');
router.use(trackResource('stream'));
router.get('/:type/:id.json', async (req, res, next) => {
    // Check if we have user data (set by middleware in authenticated routes)
    if (!req.userData) {
        // Return a response indicating configuration is needed
        res.status(200).json(StremioTransformer.createDynamicError('stream', {
            errorDescription: 'Please configure the addon first',
        }));
        return;
    }
    const transformer = new StremioTransformer(req.userData);
    const provideSetting = appConfig.api.provideStreamData;
    const provideStreamData = provideSetting === null
        ? (req.headers['user-agent']?.startsWith('AIO') ?? false)
        : typeof provideSetting === 'boolean'
            ? provideSetting
            : provideSetting.includes(req.requestIp || '');
    try {
        const { type, id } = req.params;
        const aiostreams = await new AIOStreams(req.userData).initialise();
        const disableAutoplay = await aiostreams.shouldStopAutoPlay(type, id);
        const response = await aiostreams.getStreams(id, type);
        const streamContext = aiostreams.getStreamContext();
        if (!streamContext) {
            throw new Error('Stream context not available');
        }
        const transformed = await transformer.transformStreams(response, streamContext.toFormatterContext(response.data.streams), { provideStreamData, disableAutoplay });
        res
            .status(200)
            .json(playablePayload(transformed));
    }
    catch (error) {
        let errorMessage = error instanceof Error ? error.message : 'Unknown error';
        let errors = [
            {
                description: errorMessage,
            },
        ];
        if (transformer.showError('stream', errors)) {
            logger.error(`Unexpected error during stream retrieval: ${errorMessage}`, error);
            res.status(200).json(StremioTransformer.createDynamicError('stream', {
                errorDescription: errorMessage,
            }));
            return;
        }
        next(error);
    }
});
export default router;
//# sourceMappingURL=stream.js.map
