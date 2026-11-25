import { Bot, InlineKeyboard, InputFile } from 'grammy';
import type { InputMediaPhoto, InputMediaVideo } from 'grammy/types';
import { extractMedia } from './extractor.ts';
import { openZeroDiskStream, type OpenedZeroDiskStream } from './streamer.ts';
import { telemetry } from './telemetry.ts';
import type {
  BotConfig,
  BotMediaMode,
  BotStatusSnapshot,
  MediaAsset,
  ParsedMediaUrl,
  YouTubeQuality,
} from './types.ts';
import { extractSupportedUrlsFromText } from './urlRouter.ts';

const DEFAULT_API_ROOT = 'https://api.telegram.org';

interface ChatMediaOptions {
  video: boolean;
  music: boolean;
}

export function buildMediaOptionsKeyboard(options: ChatMediaOptions): InlineKeyboard {
  return new InlineKeyboard()
    .text(`${options.video ? '☑' : '☐'} Video`, 'mediaopt:video')
    .text(`${options.music ? '☑' : '☐'} Sound`, 'mediaopt:music');
}

class AsyncSemaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  private limit: number;
  private maxQueued: number;

  constructor(limit: number) {
    this.limit = Math.max(1, limit);
    this.maxQueued = Math.max(16, this.limit * 4);
  }

  setLimit(limit: number): void {
    this.limit = Math.max(1, limit);
    this.maxQueued = Math.max(16, this.limit * 4);
    this.drain();
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve, reject) => {
      if (this.active < this.limit) {
        this.active += 1;
        resolve();
      } else if (this.queue.length < this.maxQueued) {
        this.queue.push(resolve);
      } else {
        reject(new Error('Bot worker queue is full. Try again shortly.'));
      }
    });
    telemetry.incrementActiveWorkers();
    try {
      return await task();
    } finally {
      this.active = Math.max(0, this.active - 1);
      telemetry.decrementActiveWorkers();
      this.drain();
    }
  }

  private drain(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const next = this.queue.shift();
      this.active += 1;
      next?.();
    }
  }
}

class TelegramBotManager {
  private bot: Bot | null = null;
  private running = false;
  private botUsername: string | null = null;
  private botId: number | null = null;
  private startedAt: number | null = null;
  private lastError: string | null = null;
  private semaphore = new AsyncSemaphore(
    Number(process.env.BOT_CONCURRENCY || 8)
  );
  private chatQualityPrefs = new Map<number, YouTubeQuality>();
  private chatMediaPrefs = new Map<number, ChatMediaOptions>();

  private config: BotConfig = {
    token: process.env.TELEGRAM_BOT_TOKEN?.trim() || '',
    apiRoot: process.env.TELEGRAM_API_ROOT?.trim() || DEFAULT_API_ROOT,
    concurrency: Number(process.env.BOT_CONCURRENCY || 8),
    youtubeQuality: '720',
    mediaMode: 'both',
    autoCompressOverLimit: false,
    proxyUrl: '',
    cookiesHeader: '',
  };

  getLimitBytes(): number {
    const isLocalApi =
      this.config.apiRoot !== DEFAULT_API_ROOT &&
      this.config.apiRoot.startsWith('http');
    return isLocalApi ? 2000 * 1024 * 1024 : 50 * 1024 * 1024;
  }

  private getChatMediaOptions(chatId: number): ChatMediaOptions {
    const saved = this.chatMediaPrefs.get(chatId);
    if (saved) return saved;
    return {
      video: this.config.mediaMode !== 'music',
      music: this.config.mediaMode !== 'video',
    };
  }

  private saveChatMediaOptions(chatId: number, options: ChatMediaOptions): void {
    this.chatMediaPrefs.delete(chatId);
    this.chatMediaPrefs.set(chatId, options);
    while (this.chatMediaPrefs.size > 2000) {
      const oldestChatId = this.chatMediaPrefs.keys().next().value;
      if (oldestChatId === undefined) break;
      this.chatMediaPrefs.delete(oldestChatId);
    }
  }

  getStatus(): BotStatusSnapshot {
    const limitMb = Math.round(this.getLimitBytes() / (1024 * 1024));
    return {
      running: this.running,
      botUsername: this.botUsername,
      botId: this.botId,
      apiRoot: this.config.apiRoot,
      limitMb,
      concurrency: this.config.concurrency,
      youtubeQuality: this.config.youtubeQuality,
      mediaMode: this.config.mediaMode,
      autoCompressOverLimit: this.config.autoCompressOverLimit,
      hasToken: Boolean(this.config.token),
      hasProxy: Boolean(this.config.proxyUrl),
      hasCookies: Boolean(this.config.cookiesHeader),
      startedAt: this.startedAt,
      lastError: this.lastError,
    };
  }

  updateConfig(partial: Partial<BotConfig>): BotStatusSnapshot {
    if (typeof partial.token === 'string') {
      this.config.token = partial.token.trim();
    }
    if (typeof partial.apiRoot === 'string') {
      this.config.apiRoot =
        partial.apiRoot.trim().replace(/\/+$/, '') || DEFAULT_API_ROOT;
    }
    if (
      typeof partial.concurrency === 'number' &&
      Number.isFinite(partial.concurrency)
    ) {
      this.config.concurrency = Math.min(32, Math.max(1, partial.concurrency));
      this.semaphore.setLimit(this.config.concurrency);
    }
    if (
      partial.youtubeQuality === '360' ||
      partial.youtubeQuality === '720' ||
      partial.youtubeQuality === '1080'
    ) {
      this.config.youtubeQuality = partial.youtubeQuality;
    }
    if (
      partial.mediaMode === 'video' ||
      partial.mediaMode === 'music' ||
      partial.mediaMode === 'both'
    ) {
      this.config.mediaMode = partial.mediaMode as BotMediaMode;
    }
    if (typeof partial.autoCompressOverLimit === 'boolean') {
      this.config.autoCompressOverLimit = partial.autoCompressOverLimit;
    }
    if (typeof partial.proxyUrl === 'string') {
      this.config.proxyUrl = partial.proxyUrl.trim();
    }
    if (typeof partial.cookiesHeader === 'string') {
      this.config.cookiesHeader = partial.cookiesHeader.trim();
    }
    return this.getStatus();
  }

  async start(overrideConfig?: Partial<BotConfig>): Promise<BotStatusSnapshot> {
    if (overrideConfig) {
      this.updateConfig(overrideConfig);
    }

    if (!this.config.token) {
      throw new Error('Telegram Bot Token is required to start the bot.');
    }

    if (this.running) {
      await this.stop();
    }

    this.lastError = null;
    const bot = new Bot(this.config.token, {
      client: {
        apiRoot: this.config.apiRoot,
      },
    });

    const me = await bot.api.getMe();
    this.botUsername = me.username ?? null;
    this.botId = me.id;

    this.registerHandlers(bot);

    bot.catch((err) => {
      const msg = err.error instanceof Error ? err.error.message : String(err.error);
      this.lastError = msg;
      telemetry.logEvent({
        source: 'telegram',
        level: 'error',
        message: `Bot handler error: ${msg}`,
      });
    });

    this.bot = bot;
    this.running = true;
    this.startedAt = Date.now();

    // Start async long polling without awaiting forever
    bot
      .start({
        drop_pending_updates: true,
        allowed_updates: ['message', 'callback_query'],
      })
      .catch((err) => {
        this.running = false;
        this.lastError = err instanceof Error ? err.message : String(err);
        telemetry.logEvent({
          source: 'telegram',
          level: 'error',
          message: `Telegram polling stopped: ${this.lastError}`,
        });
      });

    telemetry.logEvent({
      source: 'system',
      level: 'success',
      message: `Connected @${me.username} (async zero-disk mode, concurrency ${this.config.concurrency}, limit ${Math.round(this.getLimitBytes() / 1048576)} MB)`,
    });

    return this.getStatus();
  }

  async stop(): Promise<BotStatusSnapshot> {
    if (this.bot) {
      try {
        await this.bot.stop();
      } catch {
        // Ignore stop errors if polling had already aborted
      }
    }
    this.bot = null;
    this.running = false;
    this.startedAt = null;
    telemetry.logEvent({
      source: 'system',
      level: 'info',
      message: 'Telegram bot polling stopped.',
    });
    return this.getStatus();
  }

  private registerHandlers(bot: Bot): void {
    bot.command('start', async (ctx) => {
      await ctx.reply(
        [
          'Send any media link from Instagram, TikTok, Twitter/X, Reddit, Tumblr, YouTube, YouTube Shorts, or YouTube Music.',
          '',
          'All media is streamed directly to Telegram in memory with zero disk storage.',
          'Use /options to choose video, sound, both, or neither for links in this chat.',
          '',
          'Commands:',
          '/quality — Choose preferred YouTube stream resolution (360p / 720p / 1080p)',
          '/options — Choose video and sound with checkboxes',
          '/help — Supported platforms & limits',
        ].join('\n')
      );
    });

    bot.command('help', async (ctx) => {
      const limitMb = Math.round(this.getLimitBytes() / (1024 * 1024));
      await ctx.reply(
        [
          'Supported Platforms:',
          '• Instagram (Posts, Reels, Stories, Carousels + MP3 audio for videos)',
          '• TikTok (Videos, Slideshows + separate MP3 audio)',
          '• Twitter / X (Videos, GIFs, Multi-image Tweets)',
          '• Reddit (Videos with audio muxing, Images, GIFs, Galleries)',
          '• Tumblr (Videos, Images, GIFs)',
          '• YouTube & YouTube Shorts (Video + extracted MP3 audio)',
          '• YouTube Music (MP3 audio tracks & playlists)',
          'Use /options to choose video and sound independently for each chat.',
          '',
          `Active upload limit: ${limitMb} MB`,
        ].join('\n')
      );
    });

    bot.command('quality', async (ctx) => {
      const current =
        this.chatQualityPrefs.get(ctx.chat.id) ?? this.config.youtubeQuality;
      const kb = new InlineKeyboard()
        .text(current === '360' ? '✓ 360p' : '360p', 'ytq:360')
        .text(current === '720' ? '✓ 720p' : '720p', 'ytq:720')
        .text(current === '1080' ? '✓ 1080p' : '1080p', 'ytq:1080');
      await ctx.reply(`Current YouTube quality: ${current}p. Select target resolution:`, {
        reply_markup: kb,
      });
    });

    bot.command('options', async (ctx) => {
      const options = this.getChatMediaOptions(ctx.chat.id);
      await ctx.reply('Choose what to send for links in this chat:', {
        reply_markup: buildMediaOptionsKeyboard(options),
      });
    });

    bot.callbackQuery(/^mediaopt:(video|music)$/, async (ctx) => {
      if (!ctx.chat) {
        await ctx.answerCallbackQuery({ text: 'Open /options in a chat first.' });
        return;
      }
      const options = this.getChatMediaOptions(ctx.chat.id);
      const option = ctx.match[1] as keyof ChatMediaOptions;
      options[option] = !options[option];
      this.saveChatMediaOptions(ctx.chat.id, options);
      const selection = [
        options.video ? 'video' : undefined,
        options.music ? 'sound' : undefined,
      ].filter(Boolean).join(' + ') || 'nothing';
      await ctx.answerCallbackQuery({ text: `Selected: ${selection}` });
      await ctx.editMessageReplyMarkup({
        reply_markup: buildMediaOptionsKeyboard(options),
      });
    });

    bot.callbackQuery(/^ytq:(360|720|1080)$/, async (ctx) => {
      const q = ctx.match[1] as YouTubeQuality;
      if (ctx.chat) {
        this.chatQualityPrefs.set(ctx.chat.id, q);
      }
      await ctx.answerCallbackQuery({ text: `YouTube quality set to ${q}p` });
      await ctx.editMessageText(`YouTube target resolution set to ${q}p.`);
    });

    bot.on(['message:text', 'message:caption'], async (ctx) => {
      const text = ctx.message.text ?? ctx.message.caption ?? '';
      const urls = extractSupportedUrlsFromText(text);
      if (urls.length === 0) return;

      // Process each detected URL concurrently within the async worker pool
      for (const parsedUrl of urls) {
        void this.semaphore.run(() =>
          this.processTelegramUrl(bot, ctx.chat.id, ctx.message.message_id, parsedUrl, ctx.from?.username || String(ctx.from?.id || ctx.chat.id))
        );
      }
    });
  }

  private async processTelegramUrl(
    bot: Bot,
    chatId: number,
    replyToMessageId: number,
    parsedUrl: ParsedMediaUrl,
    chatLabel: string
  ): Promise<void> {
    const startedAt = Date.now();
    let statusMsgId: number | null = null;
    const isLongFormYt = parsedUrl.platform === 'youtube';
    const mediaOptions = this.getChatMediaOptions(chatId);

    try {
      await bot.api
        .sendChatAction(
          chatId,
          parsedUrl.platform === 'youtube_music' ? 'record_voice' : 'upload_video'
        )
        .catch(() => {});
      if (isLongFormYt) {
        const statusMsg = await bot.api.sendMessage(
          chatId,
          '⏳ Resolving stream metadata...',
          { reply_parameters: { message_id: replyToMessageId } }
        );
        statusMsgId = statusMsg.message_id;
      }

      const maxLimitBytes = this.getLimitBytes();
      const quality =
        this.chatQualityPrefs.get(chatId) ?? this.config.youtubeQuality;

      const extraction = await extractMedia(parsedUrl, {
        youtubeQuality: quality,
        maxLimitBytes,
        proxyUrl: this.config.proxyUrl,
        cookiesHeader: this.config.cookiesHeader,
      });

      const selectedAssets = extraction.assets.filter(
        (asset) =>
          (mediaOptions.music && asset.kind === 'audio') ||
          (mediaOptions.video && asset.kind !== 'audio')
      );

      if (selectedAssets.length === 0) {
        if (statusMsgId) {
          await bot.api.deleteMessage(chatId, statusMsgId).catch(() => {});
        }
        await bot.api.sendMessage(
          chatId,
          mediaOptions.video || mediaOptions.music
            ? `No ${mediaOptions.music && !mediaOptions.video ? 'sound' : 'video'} media was found for this link.`
            : 'Both video and sound are turned off. Use /options to select at least one.',
          { reply_parameters: { message_id: replyToMessageId } }
        );
        telemetry.logEvent({
          source: 'telegram',
          level: 'info',
          platform: parsedUrl.platform,
          chatLabel,
          message: `No selected media assets available for this link`,
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      if (statusMsgId) {
        await bot.api
          .editMessageText(
            chatId,
            statusMsgId,
            '📡 Streaming media directly to Telegram (zero disk)...'
          )
          .catch(() => {});
      }

      const visualAssets = selectedAssets.filter((a) => a.kind !== 'audio');
      const audioAssets = selectedAssets.filter((a) => a.kind === 'audio');

      const sendVisuals = async (): Promise<number> => {
        if (visualAssets.length > 1) {
          return this.sendVisualMediaGroup(
            bot,
            chatId,
            replyToMessageId,
            visualAssets
          );
        }
        if (visualAssets.length === 1) {
          return this.sendSingleAsset(
            bot,
            chatId,
            replyToMessageId,
            visualAssets[0]
          );
        }
        return 0;
      };

      const sendAudios = async (): Promise<number> => {
        if (audioAssets.length === 0) return 0;
        await bot.api.sendChatAction(chatId, 'record_voice').catch(() => {});
        const audioTotals = await Promise.all(
          audioAssets.map((audioAsset) =>
            this.sendSingleAsset(bot, chatId, replyToMessageId, audioAsset)
          )
        );
        return audioTotals.reduce((acc, n) => acc + n, 0);
      };

      // Stream visuals and extracted MP3 audio concurrently for faster TikTok/YouTube/Instagram delivery
      const [visualBytes, audioBytes] = await Promise.all([
        sendVisuals(),
        sendAudios(),
      ]);
      const totalBytes = visualBytes + audioBytes;

      if (statusMsgId) {
        await bot.api.deleteMessage(chatId, statusMsgId).catch(() => {});
      }

      telemetry.logEvent({
        source: 'telegram',
        level: 'success',
        platform: parsedUrl.platform,
        chatLabel,
        message: `Streamed ${selectedAssets.length} asset(s) via ${extraction.extractorUsed}`,
        bytesStreamed: totalBytes,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      if (statusMsgId) {
        await bot.api.deleteMessage(chatId, statusMsgId).catch(() => {});
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      telemetry.logEvent({
        source: 'telegram',
        level: 'error',
        platform: parsedUrl.platform,
        chatLabel,
        message: errMsg,
        durationMs: Date.now() - startedAt,
      });
      await bot.api
        .sendMessage(
          chatId,
          "❌ Sorry, I couldn't extract media from this link. It might be private or deleted.",
          { reply_parameters: { message_id: replyToMessageId } }
        )
        .catch(() => {});
    }
  }

  private async sendVisualMediaGroup(
    bot: Bot,
    chatId: number,
    replyToMessageId: number,
    assets: MediaAsset[]
  ): Promise<number> {
    let bytesDelivered = 0;
    const chunkSize = 10;

    for (let offset = 0; offset < assets.length; offset += chunkSize) {
      const slice = assets.slice(offset, offset + chunkSize);
      const openedStreams: OpenedZeroDiskStream[] = [];
      try {
        const mediaGroup: Array<InputMediaPhoto | InputMediaVideo> = [];
        for (const item of slice) {
          if (item.kind === 'animation') {
            // Telegram sendMediaGroup does not support animation GIFs; send sequentially
            bytesDelivered += await this.sendSingleAsset(
              bot,
              chatId,
              replyToMessageId,
              item
            );
            continue;
          }
          if (item.exceedsLimit && !this.config.autoCompressOverLimit) {
            await bot.api.sendMessage(
              chatId,
              `⚠️ A carousel item exceeds the ${Math.round(item.limitBytes / 1048576)} MB Bot API limit. Direct link:\n${item.streamUrl}`,
              { reply_parameters: { message_id: replyToMessageId } }
            );
            continue;
          }
          const opened = await openZeroDiskStream(item, {
            compressOverLimit: this.config.autoCompressOverLimit,
            onComplete: (b) => {
              bytesDelivered += b;
            },
          });
          openedStreams.push(opened);

          if (item.kind === 'photo') {
            mediaGroup.push({
              type: 'photo',
              media: new InputFile(opened.stream, opened.filename),
            });
          } else {
            mediaGroup.push({
              type: 'video',
              media: new InputFile(opened.stream, opened.filename),
              supports_streaming: true,
              width: item.width,
              height: item.height,
            });
          }
        }

        if (mediaGroup.length >= 2) {
          await bot.api.sendMediaGroup(chatId, mediaGroup, {
            reply_parameters: { message_id: replyToMessageId },
          });
        } else if (mediaGroup.length === 1) {
          // Single remaining item after filtering animations/oversized
          const single = slice.find((s) => s.kind !== 'animation');
          if (single) {
            openedStreams.forEach((o) => o.cleanup());
            bytesDelivered += await this.sendSingleAsset(
              bot,
              chatId,
              replyToMessageId,
              single
            );
          }
        }
      } catch {
        // Fallback to sequential delivery if Telegram rejects mixed media group
        openedStreams.forEach((o) => o.cleanup());
        for (const item of slice) {
          bytesDelivered += await this.sendSingleAsset(
            bot,
            chatId,
            replyToMessageId,
            item
          );
        }
      } finally {
        openedStreams.forEach((o) => o.cleanup());
      }
    }

    return bytesDelivered;
  }

  private async sendSingleAsset(
    bot: Bot,
    chatId: number,
    replyToMessageId: number,
    asset: MediaAsset
  ): Promise<number> {
    if (asset.exceedsLimit && !this.config.autoCompressOverLimit) {
      const sizeMb = asset.estimatedBytes
        ? (asset.estimatedBytes / (1024 * 1024)).toFixed(1)
        : 'unknown';
      const limitMb = Math.round(asset.limitBytes / (1024 * 1024));
      await bot.api.sendMessage(
        chatId,
        `⚠️ Media size (${sizeMb} MB) exceeds the Telegram Bot API limit (${limitMb} MB).\nDirect stream URL:\n${asset.streamUrl}`,
        { reply_parameters: { message_id: replyToMessageId } }
      );
      return 0;
    }

    let bytesDelivered = 0;
    const opened = await openZeroDiskStream(asset, {
      compressOverLimit: this.config.autoCompressOverLimit,
      onComplete: (b) => {
        bytesDelivered += b;
      },
    });

    try {
      const inputFile = new InputFile(opened.stream, opened.filename);
      if (asset.kind === 'photo') {
        await bot.api.sendPhoto(chatId, inputFile, {
          reply_parameters: { message_id: replyToMessageId },
        });
      } else if (asset.kind === 'animation') {
        await bot.api.sendAnimation(chatId, inputFile, {
          reply_parameters: { message_id: replyToMessageId },
        });
      } else if (asset.kind === 'audio') {
        if (asset.ext === 'mp3' || asset.ext === 'm4a') {
          await bot.api.sendAudio(chatId, inputFile, {
            title: asset.title,
            performer: asset.author,
            duration: asset.durationSeconds
              ? Math.round(asset.durationSeconds)
              : undefined,
            reply_parameters: { message_id: replyToMessageId },
          });
        } else {
          await bot.api.sendDocument(chatId, inputFile, {
            reply_parameters: { message_id: replyToMessageId },
          });
        }
      } else {
        await bot.api.sendVideo(chatId, inputFile, {
          supports_streaming: true,
          width: asset.width,
          height: asset.height,
          duration: asset.durationSeconds
            ? Math.round(asset.durationSeconds)
            : undefined,
          reply_parameters: { message_id: replyToMessageId },
        });
      }
    } finally {
      opened.cleanup();
    }

    return bytesDelivered;
  }
}

export const telegramBotManager = new TelegramBotManager();
