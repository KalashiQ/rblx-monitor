import { Telegraf, Markup } from 'telegraf';
import { config } from './config';
import { parseNewGames } from './populate';
import { db, getAnomalySettings, updateAnomalySettings, updateCustomMessage, performDataCleanup } from './db';
import { getDatabaseStats, clearGames, clearSnapshots, clearAnomalies, selectiveCleanup } from './clear-and-restart';
import { startCircularParsingForDuration } from './roblox-parser';
import { sendTestNotification } from './anomaly-notifier';
import * as fs from 'fs';
import * as path from 'path';

export class TelegramBot {
  private bot: Telegraf;
  private isParsingActive: boolean = false;
  private isGameParsingActive: boolean = false;
  private parsingStartTime: number = 0;
  private waitingForNSigma: boolean = false;
  private waitingForMinDelta: boolean = false;
  private waitingForCustomMessage: boolean = false;
  private parsingStats: {
    totalProcessed: number;
    successfulParses: number;
    failedParses: number;
    lastGameTitle: string;
    completedCycles: number;
    lastGameIndex: number;
  } = {
    totalProcessed: 0,
    successfulParses: 0,
    failedParses: 0,
    lastGameTitle: '',
    completedCycles: 0,
    lastGameIndex: -1
  };

  constructor() {
    console.log('🤖 Creating TelegramBot instance...');
    if (!config.TELEGRAM_BOT_TOKEN) {
      throw new Error('TELEGRAM_BOT_TOKEN is required');
    }
    
    console.log('🔑 Bot token found:', config.TELEGRAM_BOT_TOKEN.substring(0, 10) + '...');
    this.bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);

    // Middleware: allow-list by user id from env ALLOWED_USER_IDS (comma-separated)
    const allowedSet = new Set<number>();
    if (config.ALLOWED_USER_IDS) {
      for (const raw of config.ALLOWED_USER_IDS.split(',')) {
        const id = Number(raw.trim());
        if (!Number.isNaN(id)) allowedSet.add(id);
      }
    }

    this.bot.use(async (ctx, next) => {
      const fromId = ctx.from?.id;
      if (allowedSet.size === 0) {
        // No allow-list configured -> allow everyone
        return next();
      }
      if (fromId && allowedSet.has(fromId)) {
        return next();
      }
      try {
        await ctx.reply('⛔️ Доступ к этому боту ограничен.');
      } catch {}
      return;
    });

    this.setupHandlers();
    console.log('✅ TelegramBot instance created');
  }

  private setupHandlers() {
    console.log('🔧 Setting up handlers...');
    
    // Команда /start
    this.bot.start((ctx) => {
      console.log('👋 /start command received');
      ctx.reply(
        '🤖 Добро пожаловать в Roblox Monitor Bot!\n\n' +
        'Этот бот поможет вам отслеживать аномалии в играх Roblox.\n\n' +
        '📱 Используйте кнопки ниже для навигации:',
        this.getPersistentKeyboard()
      );
    });

    // Команда /help
    this.bot.help((ctx) => {
      ctx.reply(
        '📋 Доступные команды:\n\n' +
        '🔍 Парсинг новых игр - запустить парсинг новых игр с Roblox\n' +
        '🚨 Запустить поиск аномалий - круглосуточный парсинг с анализом аномалий\n' +
        '⚙️ Настройки - настройки бота\n' +
        '🗄️ База данных - управление базой данных\n\n' +
        '📊 /status - показать статус парсинга\n' +
        '🛑 /stop_parsing - остановить парсинг аномалий\n' +
        '🧪 /test_notification - тестовое уведомление\n' +
        '⌨️ /keyboard - показать постоянную клавиатуру\n\n' +
        '📱 Используйте постоянные кнопки ниже для быстрого доступа к функциям.',
        this.getPersistentKeyboard()
      );
    });

    // Команда /stop_parsing
    this.bot.command('stop_parsing', (ctx) => {
      console.log('🛑 stop_parsing command received');
      this.handleStopParsing(ctx);
    });

    // Команда /status
    this.bot.command('status', (ctx) => {
      console.log('📊 status command received');
      this.handleStatus(ctx);
    });


    // Команда /test_notification
    this.bot.command('test_notification', (ctx) => {
      console.log('🧪 test_notification command received');
      this.handleTestNotification(ctx);
    });

    // Команда /keyboard
    this.bot.command('keyboard', (ctx) => {
      console.log('⌨️ keyboard command received');
      ctx.reply(
        '⌨️ Показана постоянная клавиатура\n\n' +
        '📱 Используйте кнопки ниже для навигации:',
        this.getPersistentKeyboard()
      );
    });

    // Команды для настроек
    this.bot.command('settings_n_sigma', (ctx) => {
      console.log('📊 settings_n_sigma command received');
      this.handleSettingsNSigma(ctx);
    });

    this.bot.command('settings_min_delta', (ctx) => {
      console.log('👥 settings_min_delta command received');
      this.handleSettingsMinDelta(ctx);
    });

    this.bot.command('settings_custom_message', (ctx) => {
      console.log('💬 settings_custom_message command received');
      this.handleSettingsCustomMessage(ctx);
    });

    // Команды для базы данных
    this.bot.command('export_db', (ctx) => {
      console.log('📤 export_db command received');
      this.handleExportDb(ctx);
    });

    this.bot.command('cleanup_data', (ctx) => {
      console.log('🧹 cleanup_data command received');
      this.handleCleanupData(ctx);
    });

    this.bot.command('db_stats', (ctx) => {
      console.log('📊 db_stats command received');
      this.handleDatabaseStats(ctx);
    });

    // Обработчики кнопок
    this.bot.action('parse_games', (ctx) => {
      console.log('🔍 parse_games action triggered');
      this.handleParseGames(ctx);
    });
    this.bot.action('find_anomalies', (ctx) => {
      console.log('🚨 find_anomalies action triggered');
      this.handleFindAnomalies(ctx);
    });
    this.bot.action('settings', (ctx) => {
      console.log('⚙️ settings action triggered');
      this.handleSettings(ctx);
    });
    this.bot.action('export_db', (ctx) => {
      console.log('📤 export_db action triggered');
      this.handleExportDb(ctx);
    });
    this.bot.action('back_to_main', (ctx) => {
      console.log('🏠 back_to_main action triggered');
      this.handleBackToMain(ctx);
    });
    this.bot.action('cancel_parsing', (ctx) => {
      console.log('🛑 cancel_parsing action triggered');
      this.handleStopParsing(ctx);
    });
    this.bot.action('settings_n_sigma', (ctx) => {
      console.log('📊 settings_n_sigma action triggered');
      this.handleSettingsNSigma(ctx);
    });
    this.bot.action('settings_min_delta', (ctx) => {
      console.log('👥 settings_min_delta action triggered');
      this.handleSettingsMinDelta(ctx);
    });
    this.bot.action('settings_custom_message', (ctx) => {
      console.log('💬 settings_custom_message action triggered');
      this.handleSettingsCustomMessage(ctx);
    });
    this.bot.action('cleanup_data', (ctx) => {
      console.log('🧹 cleanup_data action triggered');
      this.handleCleanupData(ctx);
    });
    this.bot.action('database_menu', (ctx) => {
      console.log('🗄️ database_menu action triggered');
      this.handleDatabaseMenu(ctx);
    });
    this.bot.action('db_stats', (ctx) => {
      console.log('📊 db_stats action triggered');
      this.handleDatabaseStats(ctx);
    });
    this.bot.action('cancel_game_parsing', (ctx) => {
      console.log('🛑 cancel_game_parsing action triggered');
      this.handleCancelGameParsing(ctx);
    });
    this.bot.action('db_cleanup_menu', (ctx) => {
      console.log('🗑️ db_cleanup_menu action triggered');
      this.handleDatabaseCleanupMenu(ctx);
    });
    this.bot.action('clear_games', (ctx) => {
      console.log('🎮 clear_games action triggered');
      this.handleClearGames(ctx);
    });
    this.bot.action('clear_snapshots', (ctx) => {
      console.log('📸 clear_snapshots action triggered');
      this.handleClearSnapshots(ctx);
    });
    this.bot.action('clear_anomalies', (ctx) => {
      console.log('🚨 clear_anomalies action triggered');
      this.handleClearAnomalies(ctx);
    });
    this.bot.action('clear_all_data', (ctx) => {
      console.log('🗑️ clear_all_data action triggered');
      this.handleClearAllData(ctx);
    });
    this.bot.action('confirm_clear_games', (ctx) => {
      console.log('✅ confirm_clear_games action triggered');
      this.handleConfirmClearGames(ctx);
    });
    this.bot.action('confirm_clear_snapshots', (ctx) => {
      console.log('✅ confirm_clear_snapshots action triggered');
      this.handleConfirmClearSnapshots(ctx);
    });
    this.bot.action('confirm_clear_anomalies', (ctx) => {
      console.log('✅ confirm_clear_anomalies action triggered');
      this.handleConfirmClearAnomalies(ctx);
    });
    this.bot.action('confirm_clear_all', (ctx) => {
      console.log('✅ confirm_clear_all action triggered');
      this.handleConfirmClearAll(ctx);
    });

    // Обработка текстовых сообщений для настроек и постоянной клавиатуры
    this.bot.on('text', async (ctx) => {
      const text = ctx.message.text;
      
      // Обработка команд постоянной клавиатуры
      if (text === '🔍 Парсинг игр') {
        console.log('🔍 Parse games from persistent keyboard');
        this.handleParseGames(ctx);
        return;
      }
      
      if (text === '🚨 Поиск аномалий') {
        console.log('🚨 Find anomalies from persistent keyboard');
        this.handleFindAnomalies(ctx);
        return;
      }
      
      if (text === '⚙️ Настройки') {
        console.log('⚙️ Settings from persistent keyboard');
        this.handleSettings(ctx);
        return;
      }
      
      if (text === '🗄️ База данных') {
        console.log('🗄️ Database menu from persistent keyboard');
        this.handleDatabaseMenu(ctx);
        return;
      }
      
      if (text === '📊 Статус') {
        console.log('📊 Status from persistent keyboard');
        this.handleStatus(ctx);
        return;
      }
      
      if (text === '❌ Скрыть клавиатуру') {
        console.log('❌ Hide keyboard from persistent keyboard');
        ctx.reply('⌨️ Клавиатура скрыта. Для показа используйте /start или /keyboard', 
          Markup.removeKeyboard());
        return;
      }
      
      if (this.waitingForNSigma) {
        const text = ctx.message.text;
        const nSigma = parseFloat(text);
        
        if (isNaN(nSigma) || nSigma < 1.0 || nSigma > 10.0) {
          await ctx.reply('❌ Неверное значение. Введите число от 1.0 до 10.0');
          return;
        }
        
        const settings = getAnomalySettings();
        updateAnomalySettings(nSigma, settings.min_delta_threshold);
        
        await ctx.reply(
          `✅ Nσ обновлен на ${nSigma}\n\n` +
          `Новые настройки:\n` +
          `• Nσ: ${nSigma}\n` +
          `• Мин. изменение: ${settings.min_delta_threshold}`,
          Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Назад к настройкам', 'settings')]
          ])
        );
        
        this.waitingForNSigma = false;
        return;
      }
      
      if (this.waitingForMinDelta) {
        const text = ctx.message.text;
        const minDelta = parseInt(text);
        
        if (isNaN(minDelta) || minDelta < 1 || minDelta > 100) {
          await ctx.reply('❌ Неверное значение. Введите число от 1 до 100');
          return;
        }
        
        const settings = getAnomalySettings();
        updateAnomalySettings(settings.n_sigma, minDelta);
        
        await ctx.reply(
          `✅ Минимальное изменение обновлено на ${minDelta}\n\n` +
          `Новые настройки:\n` +
          `• Nσ: ${settings.n_sigma}\n` +
          `• Мин. изменение: ${minDelta}`,
          Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Назад к настройкам', 'settings')]
          ])
        );
        
        this.waitingForMinDelta = false;
        return;
      }
      
      if (this.waitingForCustomMessage) {
        const text = ctx.message.text;
        
        // Проверяем, не является ли это командой отмены
        if (text.toLowerCase() === 'отмена' || text.toLowerCase() === 'cancel') {
          await ctx.reply(
            '❌ Настройка кастомного сообщения отменена',
            Markup.inlineKeyboard([
              [Markup.button.callback('🔙 Назад к настройкам', 'settings')]
            ])
          );
          this.waitingForCustomMessage = false;
          return;
        }
        
        // Проверяем, не является ли это командой сброса
        if (text.toLowerCase() === 'сброс' || text.toLowerCase() === 'reset') {
          updateCustomMessage(null);
          await ctx.reply(
            '✅ Кастомное сообщение сброшено!\n\n' +
            '🔄 Теперь будут использоваться стандартные уведомления.',
            Markup.inlineKeyboard([
              [Markup.button.callback('🔙 Назад к настройкам', 'settings')]
            ])
          );
          this.waitingForCustomMessage = false;
          return;
        }
        
        // Сохраняем кастомное сообщение
        updateCustomMessage(text);
        
        await ctx.reply(
          `✅ Кастомное сообщение обновлено!\n\n` +
          `📝 Новое сообщение:\n${text}\n\n` +
          `💡 Доступные переменные:\n` +
          `• {game_title} - название игры\n` +
          `• {direction} - направление (📈 РОСТ/📉 ПАДЕНИЕ)\n` +
          `• {delta} - изменение онлайна\n` +
          `• {n_sigma} - значение Nσ\n` +
          `• {threshold} - пороговое значение\n` +
          `• {current_online} - текущий онлайн\n` +
          `• {mean} - среднее значение\n` +
          `• {stddev} - стандартное отклонение\n` +
          `• {game_url} - ссылка на игру\n` +
          `• {timestamp} - время обнаружения\n\n` +
          `🔄 Для сброса к стандартному сообщению отправьте "сброс"`,
          Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Назад к настройкам', 'settings')]
          ])
        );
        
        this.waitingForCustomMessage = false;
        return;
      }
    });

    // Обработка ошибок
    this.bot.catch((err, ctx) => {
      console.error('Telegram bot error:', err);
      ctx.reply('❌ Произошла ошибка. Попробуйте позже.');
    });
  }

  private getMainKeyboard() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🔍 Парсинг новых игр', 'parse_games')],
      [Markup.button.callback('🚨 Запустить поиск аномалий', 'find_anomalies')],
      [Markup.button.callback('⚙️ Настройки', 'settings')],
      [Markup.button.callback('🗄️ База данных', 'database_menu')]
    ]);
  }

  private getPersistentKeyboard() {
    return Markup.keyboard([
      ['🔍 Парсинг игр', '🚨 Поиск аномалий'],
      ['⚙️ Настройки', '🗄️ База данных'],
      ['📊 Статус', '❌ Скрыть клавиатуру']
    ]).resize().persistent();
  }

  private async handleParseGames(ctx: any) {
    console.log('🔍 Parse games button clicked');
    
    // Проверяем, не запущен ли уже парсинг игр
    if (this.isGameParsingActive) {
      // Проверяем, это callback query или текстовое сообщение
      if (ctx.callbackQuery) {
        await ctx.editMessageText(
          '⚠️ Парсинг игр уже запущен!\n\n' +
          '🔄 Парсинг новых игр уже работает.\n' +
          '🛑 Для остановки используйте кнопку "Отменить парсинг"',
          { reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🛑 Отменить парсинг', 'cancel_game_parsing')],
            [Markup.button.callback('🔙 Назад', 'back_to_main')]
          ]).reply_markup }
        );
      } else {
        await ctx.reply(
          '⚠️ Парсинг игр уже запущен!\n\n' +
          '🔄 Парсинг новых игр уже работает.\n' +
          '🛑 Для остановки используйте кнопку ниже.',
          Markup.inlineKeyboard([
            [Markup.button.callback('🛑 Отменить парсинг', 'cancel_game_parsing')]
          ])
        );
      }
      return;
    }
    
    try {
      // Отвечаем на callback query только если это возможно
      if (ctx.callbackQuery) {
        try {
          console.log('📤 Answering callback query...');
          await ctx.answerCbQuery('🔄 Начинаем парсинг...', { show_alert: false });
        } catch (cbError) {
          console.log('⚠️ Callback query already answered or expired, continuing...');
        }
      }
      
      // Устанавливаем флаг активного парсинга игр
      this.isGameParsingActive = true;
      
      // Отправляем сообщение в зависимости от типа
      if (ctx.callbackQuery) {
        console.log('📝 Editing message...');
        await ctx.editMessageText(
          '🔄 Парсинг новых игр...\n\n⏳ Это может занять несколько минут.\n\n🛑 Для отмены используйте кнопку ниже.',
          { reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🛑 Отменить парсинг', 'cancel_game_parsing')]
          ]).reply_markup }
        );
      } else {
        console.log('📝 Sending message...');
        await ctx.reply(
          '🔄 Парсинг новых игр...\n\n⏳ Это может занять несколько минут.\n\n🛑 Для отмены используйте кнопку ниже.',
          Markup.inlineKeyboard([
            [Markup.button.callback('🛑 Отменить парсинг', 'cancel_game_parsing')]
          ])
        );
      }

      // Запускаем парсинг в фоне
      console.log('🚀 Starting parseNewGames...');
      
      try {
        const result = await parseNewGames();
        console.log('✅ Parse completed:', result);
        
        // Проверяем, не был ли парсинг остановлен пользователем
        if (!this.isGameParsingActive) {
          console.log('🛑 Parsing was stopped by user, not sending completion message');
          return;
        }
        
        // Сбрасываем флаг активного парсинга
        this.isGameParsingActive = false;
        
        // Отправляем результаты в зависимости от типа
        if (ctx.callbackQuery) {
          console.log('📨 Editing results...');
          await ctx.editMessageText(
            `✅ Парсинг завершен!\n\n` +
            `🆕 Новых игр: ${result.newGames}\n` +
            `📊 Всего в базе: ${result.realGameCount}\n` +
            `❌ Ошибок: ${result.errors}`,
            { reply_markup: this.getMainKeyboard().reply_markup }
          );
        } else {
          console.log('📨 Sending results...');
          await ctx.reply(
            `✅ Парсинг завершен!\n\n` +
            `🆕 Новых игр: ${result.newGames}\n` +
            `📊 Всего в базе: ${result.realGameCount}\n` +
            `❌ Ошибок: ${result.errors}`,
            this.getPersistentKeyboard()
          );
        }
        console.log('✅ Results sent successfully');
      } catch (parseError) {
        // Сбрасываем флаг активного парсинга при ошибке
        this.isGameParsingActive = false;
        console.error('❌ Parse error:', parseError);
        
        // Проверяем, не был ли парсинг остановлен пользователем
        if (!this.isGameParsingActive) {
          console.log('🛑 Parsing was stopped by user, not sending error message');
          return;
        }
        
        throw parseError; // Перебрасываем ошибку для обработки в catch блоке
      }
    } catch (error) {
      // Сбрасываем флаг активного парсинга при ошибке
      this.isGameParsingActive = false;
      console.error('❌ Parse games error:', error);
      try {
        if (ctx.callbackQuery) {
          await ctx.editMessageText(
            '❌ Ошибка при парсинге игр. Проверьте логи для подробностей.',
            { reply_markup: this.getMainKeyboard().reply_markup }
          );
        } else {
          await ctx.reply(
            '❌ Ошибка при парсинге игр. Проверьте логи для подробностей.',
            this.getPersistentKeyboard()
          );
        }
      } catch (replyError) {
        console.error('❌ Failed to send error message:', replyError);
      }
    }
  }

  private async handleFindAnomalies(ctx: any) {
    try {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('🚨 Запуск поиска аномалий...', { show_alert: false });
      }
    } catch (cbError) {
      console.log('⚠️ Callback query already answered or expired, continuing...');
    }
    
    // Проверяем, не запущен ли уже парсинг
    if (this.isParsingActive) {
      if (ctx.callbackQuery) {
        await ctx.reply(
          '⚠️ Парсинг уже запущен!\n\n' +
          '🔄 Круговой парсинг онлайна игр уже работает.\n' +
          '🛑 Для остановки используйте команду /stop_parsing',
          this.getMainKeyboard()
        );
      } else {
        await ctx.reply(
          '⚠️ Парсинг уже запущен!\n\n' +
          '🔄 Круговой парсинг онлайна игр уже работает.\n' +
          '🛑 Для остановки используйте кнопку "Остановить парсинг"',
          this.getPersistentKeyboard()
        );
      }
      return;
    }
    
    try {
      // Устанавливаем флаг активного парсинга и сбрасываем статистику
      this.isParsingActive = true;
      this.parsingStartTime = Date.now();
      this.parsingStats = {
        totalProcessed: 0,
        successfulParses: 0,
        failedParses: 0,
        lastGameTitle: '',
        completedCycles: 0,
        lastGameIndex: -1
      };
      
      // Получаем текущие настройки аномалий
      const settings = getAnomalySettings();
      
      // Отправляем сообщение о начале процесса
      await ctx.reply(
        '🚨 Запуск поиска аномалий...\n\n' +
        '🔄 Начинаем круговой парсинг онлайна игр с официального сайта Roblox.\n' +
        '📊 Система автоматически анализирует каждую игру на предмет аномалий.\n' +
        '🚨 При обнаружении аномалии сразу отправляется уведомление в чат.\n' +
        '⏳ Парсинг будет работать круглосуточно до остановки.\n\n' +
        `⚙️ Текущие настройки аномалий:\n` +
        `• Nσ (статистический порог): ${settings.n_sigma}\n` +
        `• Минимальное изменение: ${settings.min_delta_threshold} игроков`
      );

      // Запускаем круговой парсинг на 24 часа (86400000 мс) - практически бесконечно
      const durationMs = 24 * 60 * 60 * 1000; // 24 часа
      let progressMessage: any = null;
      let lastUpdateTime = 0;
      
      const result = await startCircularParsingForDuration(
        durationMs,
        (current, total, gameTitle, successfulParses, failedParses) => {
          // Проверяем, не остановлен ли парсинг
          if (!this.isParsingActive) {
            return;
          }
          
          // Обновляем статистику
          this.parsingStats.totalProcessed = current;
          this.parsingStats.lastGameTitle = gameTitle;
          this.parsingStats.successfulParses = successfulParses;
          this.parsingStats.failedParses = failedParses;
          
          // Если вернулись к первой игре (current === 1) и предыдущая игра была последней в списке
          if (current === 1 && this.parsingStats.lastGameIndex === total) {
            this.parsingStats.completedCycles++;
          }
          
          // Сохраняем текущий индекс игры
          this.parsingStats.lastGameIndex = current;
          
          const now = Date.now();
          const elapsedTime = now - this.parsingStartTime;
          const elapsedMinutes = Math.floor(elapsedTime / 60000);
          
          // Обновляем прогресс каждые 5 игр или каждые 10 секунд
          if (current % 5 === 0 || current === 1 || now - lastUpdateTime > 10000) {
            lastUpdateTime = now;
            
            const progressText = `🚨 Поиск аномалий (КРУГЛОСУТОЧНО)...\n\n` +
              `🔄 Обработано игр: ${current}/${total}\n` +
              `🎮 Текущая игра: ${gameTitle}\n` +
              `⏱️ Время работы: ${elapsedMinutes} мин\n` +
              `🔄 Завершено кругов: ${this.parsingStats.completedCycles}\n` +
              `📊 Успешно: ${this.parsingStats.successfulParses} | Ошибок: ${this.parsingStats.failedParses}\n` +
              `⏳ Парсинг продолжается...`;
            
            const progressKeyboard = Markup.inlineKeyboard([
              [Markup.button.callback('🛑 Остановить парсинг', 'cancel_parsing')]
            ]);
            
            if (progressMessage) {
              try {
                ctx.telegram.editMessageText(
                  ctx.chat!.id,
                  progressMessage.message_id,
                  undefined,
                  progressText,
                  { reply_markup: progressKeyboard.reply_markup }
                );
              } catch (editError) {
                console.log('⚠️ Could not update progress message:', editError);
              }
            } else {
              // Создаем первое сообщение о прогрессе
              ctx.telegram.sendMessage(
                ctx.chat!.id,
                progressText,
                { reply_markup: progressKeyboard.reply_markup }
              ).then((msg: any) => {
                progressMessage = msg;
              }).catch((err: any) => {
                console.log('⚠️ Could not send progress message:', err);
              });
            }
          }
        },
        () => !this.isParsingActive  // Callback для проверки остановки
      );

      // Сбрасываем флаг активного парсинга
      this.isParsingActive = false;

      // Отправляем объединенные результаты
       await ctx.reply(
         `🛑 Парсинг остановлен!\n\n` +
         `✅ Круговой парсинг онлайна игр был остановлен.\n` +
         `🔄 Завершено кругов: ${result.totalCycles}\n` +
         `📊 Все собранные данные сохранены в базу данных.\n\n` +
         `📊 Статистика:\n` +
         `🎮 Всего игр: ${result.totalGames}\n` +
         `✅ Успешно обработано: ${result.successfulParses}\n` +
         `❌ Ошибок: ${result.failedParses}\n` +
         `⏱️ Среднее время на игру: ${result.averageTimePerGame}мс\n\n` +
         `🚨 Для повторного запуска используйте кнопку "Поиск аномалий"`,
         this.getPersistentKeyboard()
       );

      console.log('✅ Anomaly search completed:', result);
      
    } catch (error) {
      // Сбрасываем флаг активного парсинга при ошибке
      this.isParsingActive = false;
      console.error('❌ Anomaly search error:', error);
      try {
        await ctx.reply(
          '❌ Ошибка при поиске аномалий. Проверьте логи для подробностей.',
          this.getPersistentKeyboard()
        );
      } catch (replyError) {
        console.error('❌ Failed to send error message:', replyError);
      }
    }
  }

  private async handleSettings(ctx: any) {
    try {
      await ctx.answerCbQuery('⚙️ Настройки');
    } catch (cbError) {
      console.log('⚠️ Callback query already answered or expired, continuing...');
    }
    
    // Получаем текущие настройки
    const settings = getAnomalySettings();
    
    const customMessagePreview = settings.custom_message 
      ? `\n• Кастомное сообщение: ${settings.custom_message.length > 50 ? settings.custom_message.substring(0, 50) + '...' : settings.custom_message}`
      : '\n• Кастомное сообщение: не настроено';
    
    if (ctx.callbackQuery) {
      await ctx.reply(
        '⚙️ Настройки аномалий\n\n' +
        `📊 Текущие настройки:\n` +
        `• Nσ (статистический порог): ${settings.n_sigma}\n` +
        `• Минимальное изменение: ${settings.min_delta_threshold} игроков${customMessagePreview}\n\n` +
        'Выберите параметр для изменения:',
        Markup.inlineKeyboard([
          [Markup.button.callback(`📊 Nσ (${settings.n_sigma})`, 'settings_n_sigma')],
          [Markup.button.callback(`👥 Мин. изменение (${settings.min_delta_threshold})`, 'settings_min_delta')],
          [Markup.button.callback('💬 Кастомное сообщение', 'settings_custom_message')],
          [Markup.button.callback('🔙 Назад', 'back_to_main')]
        ])
      );
    } else {
      await ctx.reply(
        '⚙️ Настройки аномалий\n\n' +
        `📊 Текущие настройки:\n` +
        `• Nσ (статистический порог): ${settings.n_sigma}\n` +
        `• Минимальное изменение: ${settings.min_delta_threshold} игроков${customMessagePreview}\n\n` +
        'Для изменения настроек используйте команды:\n' +
        '• /settings_n_sigma - изменить Nσ\n' +
        '• /settings_min_delta - изменить минимальное изменение\n' +
        '• /settings_custom_message - изменить кастомное сообщение',
        this.getPersistentKeyboard()
      );
    }
  }

  private async handleExportDb(ctx: any) {
    try {
      try {
        await ctx.answerCbQuery('📤 Подготовка файла...', { show_alert: false });
      } catch (cbError) {
        console.log('⚠️ Callback query already answered or expired, continuing...');
      }
      await ctx.reply('📤 Подготовка файла базы данных...\n\n⏳ Пожалуйста, подождите.');

      console.log('🔄 Syncing database before export...');
      
      try {
        // Принудительно синхронизируем базу данных
        db.pragma('synchronous = FULL');
        db.pragma('journal_mode = DELETE');
        db.pragma('wal_checkpoint(FULL)');
        
        // Ждем немного, чтобы изменения записались
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (syncError) {
        console.log('⚠️ Database sync failed, continuing with export...', syncError);
        // Продолжаем экспорт даже если синхронизация не удалась
      }
      
      // Создаем временный файл с базой данных
      const dbPath = config.DB_PATH;
      const tempPath = path.join(__dirname, '..', 'temp_export.db');
      
      console.log('📁 Creating clean database export...');
      
      // Создаем новую базу данных с помощью VACUUM INTO
      // Это гарантирует, что все данные будут в одном файле
      let exportSuccess = false;
      
      try {
        db.prepare(`VACUUM INTO '${tempPath}'`).run();
        console.log('✅ VACUUM INTO completed successfully');
        exportSuccess = true;
      } catch (vacuumError) {
        console.log('⚠️ VACUUM INTO failed, trying alternative method...', vacuumError);
        
        try {
          // Альтернативный способ: создаем новую базу и копируем данные
          const tempDb = require('better-sqlite3')(tempPath);
          
          // Копируем схему
          const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table'").all() as Array<{ sql: string }>;
          for (const table of schema) {
            if (table.sql) {
              tempDb.exec(table.sql);
            }
          }
          
          // Копируем данные из основных таблиц
          const tables = ['games', 'snapshots', 'anomalies', 'anomaly_settings'];
          for (const tableName of tables) {
            try {
              const data = db.prepare(`SELECT * FROM ${tableName}`).all();
              if (data.length > 0) {
                const insertStmt = tempDb.prepare(`INSERT INTO ${tableName} SELECT * FROM main.${tableName}`);
                // Создаем временную таблицу и копируем данные
                for (const row of data as Array<Record<string, any>>) {
                  const columns = Object.keys(row);
                  const values = Object.values(row);
                  const placeholders = columns.map(() => '?').join(', ');
                  const insertQuery = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
                  tempDb.prepare(insertQuery).run(...values);
                }
              }
            } catch (tableError) {
              console.log(`⚠️ Could not copy table ${tableName}:`, tableError);
            }
          }
          
          tempDb.close();
          console.log('✅ Alternative export method completed');
          exportSuccess = true;
        } catch (altError) {
          console.log('⚠️ Alternative export failed, using simple file copy');
          // Последний способ - простое копирование файла
          fs.copyFileSync(dbPath, tempPath);
          exportSuccess = true;
        }
      }
      
      // Проверяем размер файла и количество игр
      const stats = fs.statSync(tempPath);
      console.log(`📊 Exported database size: ${stats.size} bytes`);
      
      // Проверяем количество игр в экспортированной базе
      let gameCount = 0;
      try {
        const tempDb = require('better-sqlite3')(tempPath);
        const countResult = tempDb.prepare('SELECT COUNT(*) as count FROM games').get() as { count: number };
        gameCount = countResult.count;
        tempDb.close();
        console.log(`🎮 Games in exported database: ${gameCount}`);
      } catch (countError) {
        console.log('⚠️ Could not count games in exported database:', countError);
      }

      // Отправляем файл
      await ctx.replyWithDocument(
        { source: tempPath, filename: 'roblox_monitor.db' },
        {
          caption: '📤 Экспорт базы данных завершен!\n\n' +
                   `📊 Размер файла: ${Math.round(stats.size / 1024)} KB\n` +
                   `🎮 Игр в базе: ${gameCount}\n` +
                   'Файл содержит все данные о играх и их статистике.'
        }
      );

      // Удаляем временный файл
      fs.unlinkSync(tempPath);
      console.log('🗑️ Temporary file deleted');

      // Отправляем подтверждение
      await ctx.reply(
        '✅ Файл базы данных успешно экспортирован!',
        this.getMainKeyboard()
      );
    } catch (error) {
      console.error('❌ Export DB error:', error);
      try {
        await ctx.reply(
          '❌ Ошибка при экспорте базы данных. Проверьте логи для подробностей.',
          this.getMainKeyboard()
        );
      } catch (replyError) {
        console.error('❌ Failed to send error message:', replyError);
      }
    }
  }

  private async handleStatus(ctx: any) {
    try {
      const now = Date.now();
      const elapsedTime = this.parsingStartTime > 0 ? now - this.parsingStartTime : 0;
      const elapsedMinutes = Math.floor(elapsedTime / 60000);
      const elapsedHours = Math.floor(elapsedMinutes / 60);
      
      if (!this.isParsingActive) {
        if (ctx.callbackQuery) {
          await ctx.reply(
            '📊 Статус парсинга\n\n' +
            '🔴 Парсинг не активен\n\n' +
            '🚨 Для запуска используйте кнопку "Запустить поиск аномалий"',
            this.getMainKeyboard()
          );
        } else {
          await ctx.reply(
            '📊 Статус парсинга\n\n' +
            '🔴 Парсинг не активен\n\n' +
            '🚨 Для запуска используйте кнопку "Поиск аномалий"',
            this.getPersistentKeyboard()
          );
        }
        return;
      }

      const statusText = `📊 Статус парсинга\n\n` +
        `🟢 Парсинг активен\n` +
        `⏱️ Время работы: ${elapsedHours}ч ${elapsedMinutes % 60}м\n` +
        `🔄 Обработано игр: ${this.parsingStats.totalProcessed}\n` +
        `🔄 Завершено кругов: ${this.parsingStats.completedCycles}\n` +
        `📊 Успешно: ${this.parsingStats.successfulParses} | Ошибок: ${this.parsingStats.failedParses}\n` +
        `🎮 Последняя игра: ${this.parsingStats.lastGameTitle}`;
      
      if (ctx.callbackQuery) {
        await ctx.reply(statusText, this.getMainKeyboard());
      } else {
        await ctx.reply(statusText, this.getPersistentKeyboard());
      }
      
    } catch (error) {
      console.error('❌ Status error:', error);
      try {
        if (ctx.callbackQuery) {
          await ctx.reply(
            '❌ Ошибка при получении статуса. Проверьте логи для подробностей.',
            this.getMainKeyboard()
          );
        } else {
          await ctx.reply(
            '❌ Ошибка при получении статуса. Проверьте логи для подробностей.',
            this.getPersistentKeyboard()
          );
        }
      } catch (replyError) {
        console.error('❌ Failed to send error message:', replyError);
      }
    }
  }

  private async handleStopParsing(ctx: any) {
    try {
      if (!this.isParsingActive) {
        if (ctx.callbackQuery) {
          await ctx.reply(
            '⚠️ Парсинг не запущен!\n\n' +
            '🔄 В данный момент круговой парсинг не активен.\n' +
            '🚨 Для запуска используйте кнопку "Запустить поиск аномалий"',
            this.getMainKeyboard()
          );
        } else {
          await ctx.reply(
            '⚠️ Парсинг не запущен!\n\n' +
            '🔄 В данный момент круговой парсинг не активен.\n' +
            '🚨 Для запуска используйте кнопку "Поиск аномалий"',
            this.getPersistentKeyboard()
          );
        }
        return;
      }

      // Останавливаем парсинг
      this.isParsingActive = false;
      
      console.log('🛑 Parsing stopped by user command');
    } catch (error) {
      console.error('❌ Stop parsing error:', error);
      try {
        await ctx.reply(
          '❌ Ошибка при остановке парсинга. Проверьте логи для подробностей.',
          this.getMainKeyboard()
        );
      } catch (replyError) {
        console.error('❌ Failed to send error message:', replyError);
      }
    }
  }

  private async handleBackToMain(ctx: any) {
    try {
      await ctx.answerCbQuery('🏠 Главное меню');
    } catch (cbError) {
      console.log('⚠️ Callback query already answered or expired, continuing...');
    }
    await ctx.editMessageText(
      '🤖 Roblox Monitor Bot\n\n' +
      'Выберите действие:',
      { reply_markup: this.getMainKeyboard().reply_markup }
    );
  }

  private async handleBackToMainWithPersistentKeyboard(ctx: any) {
    await ctx.reply(
      '🤖 Roblox Monitor Bot\n\n' +
      '📱 Выберите действие с помощью кнопок ниже:',
      this.getPersistentKeyboard()
    );
  }


  private async handleTestNotification(ctx: any) {
    try {
      await ctx.answerCbQuery('🧪 Тестовое уведомление...', { show_alert: false });
    } catch (cbError) {
      console.log('⚠️ Callback query already answered or expired, continuing...');
    }
    
    try {
      await ctx.reply('🧪 Отправка тестового уведомления...');

      const success = await sendTestNotification();
      
      if (success) {
        if (ctx.callbackQuery) {
          await ctx.reply(
            '✅ Тестовое уведомление отправлено!\n\n' +
            '📱 Проверьте чат на наличие тестового сообщения.',
            this.getMainKeyboard()
          );
        } else {
          await ctx.reply(
            '✅ Тестовое уведомление отправлено!\n\n' +
            '📱 Проверьте чат на наличие тестового сообщения.',
            this.getPersistentKeyboard()
          );
        }
      } else {
        if (ctx.callbackQuery) {
          await ctx.reply(
            '❌ Не удалось отправить тестовое уведомление.\n\n' +
            '🔧 Проверьте настройки TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID.',
            this.getMainKeyboard()
          );
        } else {
          await ctx.reply(
            '❌ Не удалось отправить тестовое уведомление.\n\n' +
            '🔧 Проверьте настройки TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID.',
            this.getPersistentKeyboard()
          );
        }
      }
      
    } catch (error) {
      console.error('❌ Test notification error:', error);
      try {
        await ctx.reply(
          '❌ Ошибка при отправке тестового уведомления. Проверьте логи для подробностей.',
          this.getMainKeyboard()
        );
      } catch (replyError) {
        console.error('❌ Failed to send error message:', replyError);
      }
    }
  }

  private async handleSettingsNSigma(ctx: any) {
    try {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('📊 Настройка Nσ');
      }
    } catch (cbError) {
      console.log('⚠️ Callback query already answered or expired, continuing...');
    }
    
    const settings = getAnomalySettings();
    
    if (ctx.callbackQuery) {
      await ctx.reply(
        `📊 Настройка статистического порога (Nσ)\n\n` +
        `Текущее значение: ${settings.n_sigma}\n\n` +
        `Nσ определяет чувствительность обнаружения аномалий:\n` +
        `• 2σ - более чувствительно (больше уведомлений)\n` +
        `• 3σ - стандартно (рекомендуется)\n` +
        `• 4σ - менее чувствительно (только значительные изменения)\n` +
        `• 5σ - очень строго (только экстремальные изменения)\n\n` +
        `Введите новое значение Nσ (от 1.0 до 10.0):`,
        Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Назад к настройкам', 'settings')]
        ])
      );
    } else {
      await ctx.reply(
        `📊 Настройка статистического порога (Nσ)\n\n` +
        `Текущее значение: ${settings.n_sigma}\n\n` +
        `Nσ определяет чувствительность обнаружения аномалий:\n` +
        `• 2σ - более чувствительно (больше уведомлений)\n` +
        `• 3σ - стандартно (рекомендуется)\n` +
        `• 4σ - менее чувствительно (только значительные изменения)\n` +
        `• 5σ - очень строго (только экстремальные изменения)\n\n` +
        `Введите новое значение Nσ (от 1.0 до 10.0):`,
        this.getPersistentKeyboard()
      );
    }
    
    // Устанавливаем флаг ожидания ввода Nσ
    this.waitingForNSigma = true;
    this.waitingForMinDelta = false;
  }

  private async handleSettingsMinDelta(ctx: any) {
    try {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('👥 Настройка минимального изменения');
      }
    } catch (cbError) {
      console.log('⚠️ Callback query already answered or expired, continuing...');
    }
    
    const settings = getAnomalySettings();
    
    if (ctx.callbackQuery) {
      await ctx.reply(
        `👥 Настройка минимального изменения\n\n` +
        `Текущее значение: ${settings.min_delta_threshold} игроков\n\n` +
        `Минимальное изменение определяет, насколько большим должно быть изменение для срабатывания аномалии:\n` +
        `• 5 - очень чувствительно\n` +
        `• 10 - стандартно (рекомендуется)\n` +
        `• 20 - менее чувствительно\n` +
        `• 50 - только очень большие изменения\n\n` +
        `Введите новое значение (от 1 до 100):`,
        Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Назад к настройкам', 'settings')]
        ])
      );
    } else {
      await ctx.reply(
        `👥 Настройка минимального изменения\n\n` +
        `Текущее значение: ${settings.min_delta_threshold} игроков\n\n` +
        `Минимальное изменение определяет, насколько большим должно быть изменение для срабатывания аномалии:\n` +
        `• 5 - очень чувствительно\n` +
        `• 10 - стандартно (рекомендуется)\n` +
        `• 20 - менее чувствительно\n` +
        `• 50 - только очень большие изменения\n\n` +
        `Введите новое значение (от 1 до 100):`,
        this.getPersistentKeyboard()
      );
    }
    
    // Устанавливаем флаг ожидания ввода минимального изменения
    this.waitingForMinDelta = true;
    this.waitingForNSigma = false;
  }

  private async handleSettingsCustomMessage(ctx: any) {
    try {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('💬 Настройка кастомного сообщения');
      }
    } catch (cbError) {
      console.log('⚠️ Callback query already answered or expired, continuing...');
    }
    
    const settings = getAnomalySettings();
    
    if (ctx.callbackQuery) {
      await ctx.reply(
        `💬 Настройка кастомного сообщения\n\n` +
        `📝 Текущее сообщение:\n${settings.custom_message || 'Стандартное сообщение'}\n\n` +
        `💡 Доступные переменные для подстановки:\n` +
        `• {game_title} - название игры\n` +
        `• {direction} - направление (📈 РОСТ/📉 ПАДЕНИЕ)\n` +
        `• {delta} - изменение онлайна\n` +
        `• {n_sigma} - значение Nσ\n` +
        `• {threshold} - пороговое значение\n` +
        `• {current_online} - текущий онлайн\n` +
        `• {mean} - среднее значение\n` +
        `• {stddev} - стандартное отклонение\n` +
        `• {game_url} - ссылка на игру\n` +
        `• {timestamp} - время обнаружения\n\n` +
        `📝 Введите новое сообщение (или "сброс" для возврата к стандартному):`,
        Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Назад к настройкам', 'settings')]
        ])
      );
    } else {
      await ctx.reply(
        `💬 Настройка кастомного сообщения\n\n` +
        `📝 Текущее сообщение:\n${settings.custom_message || 'Стандартное сообщение'}\n\n` +
        `💡 Доступные переменные для подстановки:\n` +
        `• {game_title} - название игры\n` +
        `• {direction} - направление (📈 РОСТ/📉 ПАДЕНИЕ)\n` +
        `• {delta} - изменение онлайна\n` +
        `• {n_sigma} - значение Nσ\n` +
        `• {threshold} - пороговое значение\n` +
        `• {current_online} - текущий онлайн\n` +
        `• {mean} - среднее значение\n` +
        `• {stddev} - стандартное отклонение\n` +
        `• {game_url} - ссылка на игру\n` +
        `• {timestamp} - время обнаружения\n\n` +
        `📝 Введите новое сообщение (или "сброс" для возврата к стандартному):`,
        this.getPersistentKeyboard()
      );
    }
    
    // Устанавливаем флаг ожидания ввода кастомного сообщения
    this.waitingForCustomMessage = true;
    this.waitingForNSigma = false;
    this.waitingForMinDelta = false;
  }

  private async handleCleanupData(ctx: any) {
    try {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('🧹 Очистка данных...', { show_alert: false });
      }
    } catch (cbError) {
      console.log('⚠️ Callback query already answered or expired, continuing...');
    }
    
    try {
      await ctx.reply('🧹 Выполняем очистку старых данных...\n\n⏳ Это может занять несколько секунд.');

      // Выполняем очистку данных
      const cleanupResult = performDataCleanup();
      
      if (ctx.callbackQuery) {
        await ctx.reply(
          `✅ Очистка данных завершена!\n\n` +
          `📊 Результаты очистки:\n` +
          `• Удалено снапшотов: ${cleanupResult.snapshotsDeleted}\n` +
          `• Удалено аномалий: ${cleanupResult.anomaliesDeleted}\n` +
          `• Всего удалено записей: ${cleanupResult.totalDeleted}\n\n` +
          `🔄 Автоматическая очистка выполняется каждые 6 часов во время парсинга.`,
          this.getMainKeyboard()
        );
      } else {
        await ctx.reply(
          `✅ Очистка данных завершена!\n\n` +
          `📊 Результаты очистки:\n` +
          `• Удалено снапшотов: ${cleanupResult.snapshotsDeleted}\n` +
          `• Удалено аномалий: ${cleanupResult.anomaliesDeleted}\n` +
          `• Всего удалено записей: ${cleanupResult.totalDeleted}\n\n` +
          `🔄 Автоматическая очистка выполняется каждые 6 часов во время парсинга.`,
          this.getPersistentKeyboard()
        );
      }
      
    } catch (error) {
      console.error('❌ Cleanup data error:', error);
      try {
        if (ctx.callbackQuery) {
          await ctx.reply(
            '❌ Ошибка при очистке данных. Проверьте логи для подробностей.',
            this.getMainKeyboard()
          );
        } else {
          await ctx.reply(
            '❌ Ошибка при очистке данных. Проверьте логи для подробностей.',
            this.getPersistentKeyboard()
          );
        }
      } catch (replyError) {
        console.error('❌ Failed to send error message:', replyError);
      }
    }
  }

  private async handleDatabaseMenu(ctx: any) {
    try {
      await ctx.answerCbQuery('🗄️ Меню базы данных');
    } catch (cbError) {
      console.log('⚠️ Callback query already answered or expired, continuing...');
    }
    
    // Получаем статистику базы данных
    const gamesCount = db.prepare('SELECT COUNT(*) as count FROM games').get() as { count: number };
    const snapshotsCount = db.prepare('SELECT COUNT(*) as count FROM snapshots').get() as { count: number };
    const anomaliesCount = db.prepare('SELECT COUNT(*) as count FROM anomalies').get() as { count: number };
    
    // Получаем размер базы данных
    const dbPath = config.DB_PATH;
    const fs = require('fs');
    let dbSize = 0;
    try {
      const stats = fs.statSync(dbPath);
      dbSize = stats.size;
    } catch (error) {
      console.log('Could not get database size:', error);
    }
    
    const dbSizeKB = Math.round(dbSize / 1024);
    
    if (ctx.callbackQuery) {
      await ctx.editMessageText(
        '🗄️ База данных\n\n' +
        `📊 Статистика:\n` +
        `• Игр: ${gamesCount.count}\n` +
        `• Снапшотов: ${snapshotsCount.count}\n` +
        `• Аномалий: ${anomaliesCount.count}\n` +
        `• Размер: ${dbSizeKB} KB\n\n` +
        'Выберите действие:',
        { reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('📤 Экспорт базы данных', 'export_db')],
          [Markup.button.callback('📊 Детальная статистика', 'db_stats')],
          [Markup.button.callback('🗑️ Очистка', 'db_cleanup_menu')],
          [Markup.button.callback('🔙 Назад', 'back_to_main')]
        ]).reply_markup }
      );
    } else {
      await ctx.reply(
        '🗄️ База данных\n\n' +
        `📊 Статистика:\n` +
        `• Игр: ${gamesCount.count}\n` +
        `• Снапшотов: ${snapshotsCount.count}\n` +
        `• Аномалий: ${anomaliesCount.count}\n` +
        `• Размер: ${dbSizeKB} KB\n\n` +
        'Выберите действие:',
        Markup.inlineKeyboard([
          [Markup.button.callback('📤 Экспорт базы данных', 'export_db')],
          [Markup.button.callback('📊 Детальная статистика', 'db_stats')],
          [Markup.button.callback('🗑️ Очистка', 'db_cleanup_menu')],
          [Markup.button.callback('🔙 Назад', 'back_to_main')]
        ])
      );
    }
  }

  private async handleDatabaseStats(ctx: any) {
    try {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('📊 Статистика базы данных...', { show_alert: false });
      }
    } catch (cbError) {
      console.log('⚠️ Callback query already answered or expired, continuing...');
    }
    
    try {
      // Получаем детальную статистику
      const gamesCount = db.prepare('SELECT COUNT(*) as count FROM games').get() as { count: number };
      const snapshotsCount = db.prepare('SELECT COUNT(*) as count FROM snapshots').get() as { count: number };
      const anomaliesCount = db.prepare('SELECT COUNT(*) as count FROM anomalies').get() as { count: number };
      const notifiedAnomalies = db.prepare('SELECT COUNT(*) as count FROM anomalies WHERE notified = 1').get() as { count: number };
      const unnotifiedAnomalies = db.prepare('SELECT COUNT(*) as count FROM anomalies WHERE notified = 0').get() as { count: number };
      
      // Получаем временные рамки данных
      const oldestSnapshot = db.prepare('SELECT MIN(timestamp) as oldest FROM snapshots').get() as { oldest: number };
      const newestSnapshot = db.prepare('SELECT MAX(timestamp) as newest FROM snapshots').get() as { newest: number };
      const oldestAnomaly = db.prepare('SELECT MIN(timestamp) as oldest FROM anomalies').get() as { oldest: number };
      const newestAnomaly = db.prepare('SELECT MAX(timestamp) as newest FROM anomalies').get() as { newest: number };
      
      // Получаем размер базы данных
      const dbPath = config.DB_PATH;
      const fs = require('fs');
      let dbSize = 0;
      try {
        const stats = fs.statSync(dbPath);
        dbSize = stats.size;
      } catch (error) {
        console.log('Could not get database size:', error);
      }
      
      const dbSizeKB = Math.round(dbSize / 1024);
      const dbSizeMB = Math.round(dbSize / (1024 * 1024) * 100) / 100;
      
      // Форматируем даты
      const formatDate = (timestamp: number) => {
        if (!timestamp) return 'Нет данных';
        return new Date(timestamp).toLocaleString('ru-RU');
      };
      
      const statsText = `📊 Детальная статистика базы данных\n\n` +
        `📈 Основные данные:\n` +
        `• Игр: ${gamesCount.count}\n` +
        `• Снапшотов: ${snapshotsCount.count}\n` +
        `• Аномалий: ${anomaliesCount.count}\n\n` +
        `🚨 Аномалии:\n` +
        `• Отправленных: ${notifiedAnomalies.count}\n` +
        `• Неотправленных: ${unnotifiedAnomalies.count}\n\n` +
        `📅 Временные рамки:\n` +
        `• Снапшоты: ${formatDate(oldestSnapshot.oldest)} - ${formatDate(newestSnapshot.newest)}\n` +
        `• Аномалии: ${formatDate(oldestAnomaly.oldest)} - ${formatDate(newestAnomaly.newest)}\n\n` +
        `💾 Размер базы данных: ${dbSizeKB} KB (${dbSizeMB} MB)`;
      
      if (ctx.callbackQuery) {
        await ctx.editMessageText(
          statsText,
          { reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Обновить статистику', 'db_stats')],
            [Markup.button.callback('🔙 Назад к базе данных', 'database_menu')]
          ]).reply_markup }
        );
      } else {
        await ctx.reply(
          statsText,
          this.getPersistentKeyboard()
        );
      }
      
    } catch (error) {
      console.error('❌ Database stats error:', error);
      try {
        if (ctx.callbackQuery) {
          await ctx.reply(
            '❌ Ошибка при получении статистики базы данных. Проверьте логи для подробностей.',
            Markup.inlineKeyboard([
              [Markup.button.callback('🔙 Назад к базе данных', 'database_menu')]
            ])
          );
        } else {
          await ctx.reply(
            '❌ Ошибка при получении статистики базы данных. Проверьте логи для подробностей.',
            this.getPersistentKeyboard()
          );
        }
      } catch (replyError) {
        console.error('❌ Failed to send error message:', replyError);
      }
    }
  }

  private async handleCancelGameParsing(ctx: any) {
    try {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('🛑 Отмена парсинга игр...', { show_alert: false });
      }
    } catch (cbError) {
      console.log('⚠️ Callback query already answered or expired, continuing...');
    }
    
    if (!this.isGameParsingActive) {
      if (ctx.callbackQuery) {
        await ctx.editMessageText(
          '⚠️ Парсинг игр не запущен!\n\n' +
          '🔄 В данный момент парсинг игр не активен.'
        );
      } else {
        await ctx.reply(
          '⚠️ Парсинг игр не запущен!\n\n' +
          '🔄 В данный момент парсинг игр не активен.',
          this.getPersistentKeyboard()
        );
      }
      return;
    }

    // Останавливаем парсинг игр
    this.isGameParsingActive = false;
    
    console.log('🛑 Game parsing stopped by user command');
    
    if (ctx.callbackQuery) {
      await ctx.editMessageText(
        '🛑 Парсинг игр остановлен!\n\n' +
        '✅ Парсинг новых игр был прерван пользователем.'
      );
    } else {
      await ctx.reply(
        '🛑 Парсинг игр остановлен!\n\n' +
        '✅ Парсинг новых игр был прерван пользователем.',
        this.getPersistentKeyboard()
      );
    }
  }

  public async start() {
    try {
      console.log('🚀 Launching Telegram bot...');
      await this.bot.launch();
      console.log('🤖 Telegram bot started successfully');
    } catch (error) {
      console.error('❌ Failed to start Telegram bot:', error);
      throw error;
    }
  }

  public async stop() {
    try {
      await this.bot.stop();
      console.log('🤖 Telegram bot stopped');
    } catch (error) {
      console.error('Error stopping Telegram bot:', error);
    }
  }

  private async handleDatabaseCleanupMenu(ctx: any) {
    try {
      await ctx.answerCbQuery('🗑️ Меню очистки базы данных');
    } catch (cbError) {
      console.log('⚠️ Callback query already answered or expired, continuing...');
    }
    
    // Получаем текущую статистику
    const stats = getDatabaseStats();
    
    if (ctx.callbackQuery) {
      await ctx.editMessageText(
        '🗑️ Очистка базы данных\n\n' +
        `📊 Текущее состояние:\n` +
        `• Игр: ${stats.games}\n` +
        `• Снапшотов: ${stats.snapshots}\n` +
        `• Аномалий: ${stats.anomalies}\n` +
        `• Всего записей: ${stats.total}\n\n` +
        '⚠️ ВНИМАНИЕ: Очистка необратима!\n' +
        'Выберите что очистить:',
        { reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🎮 Очистить игры', 'clear_games')],
          [Markup.button.callback('📸 Очистить снапшоты', 'clear_snapshots')],
          [Markup.button.callback('🚨 Очистить аномалии', 'clear_anomalies')],
          [Markup.button.callback('🗑️ Очистить ВСЁ', 'clear_all_data')],
          [Markup.button.callback('🧹 Очистить старые данные', 'cleanup_data')],
          [Markup.button.callback('🔙 Назад к базе данных', 'database_menu')]
        ]).reply_markup }
      );
    } else {
      await ctx.reply(
        '🗑️ Очистка базы данных\n\n' +
        `📊 Текущее состояние:\n` +
        `• Игр: ${stats.games}\n` +
        `• Снапшотов: ${stats.snapshots}\n` +
        `• Аномалий: ${stats.anomalies}\n` +
        `• Всего записей: ${stats.total}\n\n` +
        '⚠️ ВНИМАНИЕ: Очистка необратима!',
        this.getPersistentKeyboard()
      );
    }
  }

  private async handleClearGames(ctx: any) {
    try {
      await ctx.answerCbQuery('🎮 Подтверждение очистки игр');
    } catch (cbError) {
      console.log('⚠️ Callback query already answered or expired, continuing...');
    }
    
    const stats = getDatabaseStats();
    
    if (ctx.callbackQuery) {
      await ctx.editMessageText(
        '🎮 Очистка игр\n\n' +
        `⚠️ ВНИМАНИЕ: Это действие удалит ВСЕ игры (${stats.games} записей)!\n\n` +
        `📊 Будет удалено:\n` +
        `• Игр: ${stats.games}\n` +
        `• Снапшотов: ${stats.snapshots} (из-за каскадного удаления)\n` +
        `• Аномалий: ${stats.anomalies} (из-за каскадного удаления)\n\n` +
        `❌ Это действие НЕОБРАТИМО!\n\n` +
        `Подтвердите удаление:`,
        { reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('✅ ДА, удалить игры', 'confirm_clear_games')],
          [Markup.button.callback('❌ Отмена', 'db_cleanup_menu')]
        ]).reply_markup }
      );
    }
  }

  private async handleClearSnapshots(ctx: any) {
    try {
      await ctx.answerCbQuery('📸 Подтверждение очистки снапшотов');
    } catch (cbError) {
      console.log('⚠️ Callback query already answered or expired, continuing...');
    }
    
    const stats = getDatabaseStats();
    
    if (ctx.callbackQuery) {
      await ctx.editMessageText(
        '📸 Очистка снапшотов\n\n' +
        `⚠️ ВНИМАНИЕ: Это действие удалит ВСЕ снапшоты (${stats.snapshots} записей)!\n\n` +
        `📊 Будет удалено:\n` +
        `• Снапшотов: ${stats.snapshots}\n\n` +
        `❌ Это действие НЕОБРАТИМО!\n\n` +
        `Подтвердите удаление:`,
        { reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('✅ ДА, удалить снапшоты', 'confirm_clear_snapshots')],
          [Markup.button.callback('❌ Отмена', 'db_cleanup_menu')]
        ]).reply_markup }
      );
    }
  }

  private async handleClearAnomalies(ctx: any) {
    try {
      await ctx.answerCbQuery('🚨 Подтверждение очистки аномалий');
    } catch (cbError) {
      console.log('⚠️ Callback query already answered or expired, continuing...');
    }
    
    const stats = getDatabaseStats();
    
    if (ctx.callbackQuery) {
      await ctx.editMessageText(
        '🚨 Очистка аномалий\n\n' +
        `⚠️ ВНИМАНИЕ: Это действие удалит ВСЕ аномалии (${stats.anomalies} записей)!\n\n` +
        `📊 Будет удалено:\n` +
        `• Аномалий: ${stats.anomalies}\n\n` +
        `❌ Это действие НЕОБРАТИМО!\n\n` +
        `Подтвердите удаление:`,
        { reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('✅ ДА, удалить аномалии', 'confirm_clear_anomalies')],
          [Markup.button.callback('❌ Отмена', 'db_cleanup_menu')]
        ]).reply_markup }
      );
    }
  }

  private async handleClearAllData(ctx: any) {
    try {
      await ctx.answerCbQuery('🗑️ Подтверждение полной очистки');
    } catch (cbError) {
      console.log('⚠️ Callback query already answered or expired, continuing...');
    }
    
    const stats = getDatabaseStats();
    
    if (ctx.callbackQuery) {
      await ctx.editMessageText(
        '🗑️ ПОЛНАЯ ОЧИСТКА БАЗЫ ДАННЫХ\n\n' +
        `⚠️ КРИТИЧЕСКОЕ ВНИМАНИЕ: Это действие удалит ВСЕ данные!\n\n` +
        `📊 Будет удалено:\n` +
        `• Игр: ${stats.games}\n` +
        `• Снапшотов: ${stats.snapshots}\n` +
        `• Аномалий: ${stats.anomalies}\n` +
        `• Всего записей: ${stats.total}\n\n` +
        `❌ Это действие НЕОБРАТИМО!\n` +
        `🔥 База данных будет полностью очищена!\n\n` +
        `Подтвердите удаление:`,
        { reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🔥 ДА, удалить ВСЁ', 'confirm_clear_all')],
          [Markup.button.callback('❌ Отмена', 'db_cleanup_menu')]
        ]).reply_markup }
      );
    }
  }

  private async handleConfirmClearGames(ctx: any) {
    try {
      await ctx.answerCbQuery('🎮 Очистка игр...', { show_alert: false });
    } catch (cbError) {
      console.log('⚠️ Callback query already answered or expired, continuing...');
    }
    
    try {
      const result = clearGames();
      
      await ctx.editMessageText(
        `✅ Очистка игр завершена!\n\n` +
        `📊 Результаты:\n` +
        `• Удалено игр: ${result.deletedCount}\n` +
        `• Снапшоты и аномалии также удалены (каскадное удаление)\n\n` +
        `🔄 Для восстановления данных используйте "Парсинг игр"`,
        { reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Назад к очистке', 'db_cleanup_menu')],
          [Markup.button.callback('🏠 Главное меню', 'back_to_main')]
        ]).reply_markup }
      );
    } catch (error) {
      console.error('❌ Clear games error:', error);
      await ctx.editMessageText(
        '❌ Ошибка при очистке игр. Проверьте логи для подробностей.',
        { reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Назад к очистке', 'db_cleanup_menu')]
        ]).reply_markup }
      );
    }
  }

  private async handleConfirmClearSnapshots(ctx: any) {
    try {
      await ctx.answerCbQuery('📸 Очистка снапшотов...', { show_alert: false });
    } catch (cbError) {
      console.log('⚠️ Callback query already answered or expired, continuing...');
    }
    
    try {
      const result = clearSnapshots();
      
      await ctx.editMessageText(
        `✅ Очистка снапшотов завершена!\n\n` +
        `📊 Результаты:\n` +
        `• Удалено снапшотов: ${result.deletedCount}\n\n` +
        `🔄 Для восстановления данных запустите "Поиск аномалий"`,
        { reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Назад к очистке', 'db_cleanup_menu')],
          [Markup.button.callback('🏠 Главное меню', 'back_to_main')]
        ]).reply_markup }
      );
    } catch (error) {
      console.error('❌ Clear snapshots error:', error);
      await ctx.editMessageText(
        '❌ Ошибка при очистке снапшотов. Проверьте логи для подробностей.',
        { reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Назад к очистке', 'db_cleanup_menu')]
        ]).reply_markup }
      );
    }
  }

  private async handleConfirmClearAnomalies(ctx: any) {
    try {
      await ctx.answerCbQuery('🚨 Очистка аномалий...', { show_alert: false });
    } catch (cbError) {
      console.log('⚠️ Callback query already answered or expired, continuing...');
    }
    
    try {
      const result = clearAnomalies();
      
      await ctx.editMessageText(
        `✅ Очистка аномалий завершена!\n\n` +
        `📊 Результаты:\n` +
        `• Удалено аномалий: ${result.deletedCount}\n\n` +
        `🔄 Новые аномалии будут обнаружены при следующем запуске "Поиск аномалий"`,
        { reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Назад к очистке', 'db_cleanup_menu')],
          [Markup.button.callback('🏠 Главное меню', 'back_to_main')]
        ]).reply_markup }
      );
    } catch (error) {
      console.error('❌ Clear anomalies error:', error);
      await ctx.editMessageText(
        '❌ Ошибка при очистке аномалий. Проверьте логи для подробностей.',
        { reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Назад к очистке', 'db_cleanup_menu')]
        ]).reply_markup }
      );
    }
  }

  private async handleConfirmClearAll(ctx: any) {
    try {
      await ctx.answerCbQuery('🗑️ Полная очистка...', { show_alert: false });
    } catch (cbError) {
      console.log('⚠️ Callback query already answered or expired, continuing...');
    }
    
    try {
      const beforeStats = getDatabaseStats();
      
      // Очищаем все таблицы
      const gamesResult = clearGames();
      const snapshotsResult = clearSnapshots();
      const anomaliesResult = clearAnomalies();
      
      const afterStats = getDatabaseStats();
      
      await ctx.editMessageText(
        `✅ Полная очистка базы данных завершена!\n\n` +
        `📊 Результаты:\n` +
        `• Удалено игр: ${gamesResult.deletedCount}\n` +
        `• Удалено снапшотов: ${snapshotsResult.deletedCount}\n` +
        `• Удалено аномалий: ${anomaliesResult.deletedCount}\n` +
        `• Всего удалено: ${beforeStats.total - afterStats.total} записей\n\n` +
        `🔄 Для восстановления данных:\n` +
        `1. Используйте "Парсинг игр" для загрузки игр\n` +
        `2. Запустите "Поиск аномалий" для сбора данных`,
        { reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Назад к очистке', 'db_cleanup_menu')],
          [Markup.button.callback('🏠 Главное меню', 'back_to_main')]
        ]).reply_markup }
      );
    } catch (error) {
      console.error('❌ Clear all data error:', error);
      await ctx.editMessageText(
        '❌ Ошибка при полной очистке базы данных. Проверьте логи для подробностей.',
        { reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Назад к очистке', 'db_cleanup_menu')]
        ]).reply_markup }
      );
    }
  }
}
